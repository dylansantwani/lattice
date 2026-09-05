# Computer Use — architecture decisions and reversals

This is the numbered decision log for the v1 Computer Use system. Each
entry records a normative choice, the rationale at the time of freezing,
the consequences downstream agents must live with, and a status field. The
"Open questions" section at the end captures choices deferred for the
implementation phase; closing any of them is a Subagent 0 decision and may
require a contract change.

The decisions here are consistent with — and where they conflict, take
precedence over — prose in the amendment and the subagent plan, because
they are the frozen wire contract that downstream packages build against.

## Decision log

### 1. macOS-first

- **Decision.** v1 ships for macOS only. Windows Computer Use runs on the
  active desktop and cannot provide same-session alongside-user operation,
  so it is excluded from v1. Locked-screen use is excluded from v1.
- **Rationale.** The product contract requires "works alongside the user"
  with a scoped, non-stealing background mode. Only macOS exposes the
  accessibility, ScreenCaptureKit, and CGEvent primitives needed to
  implement that contract without inheriting the security model of "the
  agent owns the desktop." Shipping the harder platform first is the only
  path that proves the cooperative behavior end to end.
- **Consequences.** All native code lives under `native/mac/`. Windows is
  out of scope for v1; "computer-use" skill text and `.mcp.json` assume
  macOS. Authorization plugins and automatic unlock are explicitly out of
  v1. A future Windows port would need its own amendment.
- **Status.** Frozen.

### 2. `background_assist` is the only default; `takeover` is never an implicit fallback

- **Decision.** Three modes exist: `background_assist`, `shared_control`,
  `takeover`. `MODE_POLICY.background_assist.default` is `true`; the
  other two default to `false`. `takeover` requires an explicit user
  decision; it must never be entered automatically because an action
  failed in `background_assist`.
- **Rationale.** The amendment's "user remains in control" rule only holds
  if the default mode is the one that does not move the physical pointer
  and does not inject global keyboard input. If `takeover` were an
  implicit fallback, every failure would silently escalate the agent's
  authority — exactly the race the cooperative contract is meant to
  prevent.
- **Consequences.** `requiresFocus()` returns `true` for any focusable
  action in `background_assist`, and the controller answers
  `needs_focus`. The PiP always shows the current mode. The
  `MODE_POLICY` constants in the protocol are normative, not advisory.
- **Status.** Frozen.

### 3. AX semantic actions before coordinate / CGEvent fallback

- **Decision.** Actions that can be expressed as AX operations
  (`click_element`, `set_value`, `paste`, `select_text`,
  `secondary_action`, `wait`) are flagged `semantic: true,
  focusable: false` in `ACTION_METADATA`. Coordinate and CGEvent
  actions (`click`, `drag`, `type_text`, `press_key`, `scroll`) are
  `focusable: true`. The native helper executes semantic actions
  first and treats CGEvent as a capability flagged `requiresFocus`.
- **Rationale.** AX actions address elements by role and value, not by
  pixel, which is more robust against layout and scale changes and —
  critically — does not require the target to be foreground. This makes
  the entire background_assist surface possible without violating the
  "no global input" rule.
- **Consequences.** `ACTION_METADATA` is mirrored into MCP tool
  descriptions so capability discovery is honest. The native helper
  must reject coordinate actions addressed to unapproved app/window
  scopes regardless of mode. Unknown action types fail closed: they are
  treated as `focusable: true`.
- **Status.** Frozen.

### 4. One canonical control core shared by both lanes

- **Decision.** A single `computer-use-core` package owns sessions,
  modes, leases, arbitration, provenance, and policy. The standalone
  MCP server (`computer-use-mcp`) and the future in-process Lattice
  adapter both consume the same `Controller` interface. There is **no**
  second policy or state machine in either lane.
- **Rationale.** The subagent plan's "ownership boundaries" table
  forbids the MCP façade from owning a second policy or state machine,
  and forbids the Lattice adapter from bypassing the core. The reason is
  fail-closed integrity: if two implementations diverge on policy,
  one of them will eventually let an action through that the other
  would have rejected. One canonical core is the only way to keep the
  guarantees in the amendment.
- **Consequences.** The MCP server is a thin façade over `Controller`
  and `NativeBackend`. The Lattice adapter is the same `Controller`
  reached in-process. Test fixtures and event-injection tests cover the
  core once and are reused by both lanes. Cross-cutting changes to
  arbitration or policy go through Subagent 0.
- **Status.** Frozen.

### 5. Separate model-observation path vs. continuously-rendered PiP path

- **Decision.** There are two distinct frame transports: a
  model-observation path (a screenshot delivered as an MCP image block
  inside an `AppState` returned by `computer_get_app_state` or
  `computer_execute_action`) and a continuously rendered PiP path
  (frames pushed to the PiP host independently of model-response
  latency). The PiP never receives raw action authority; its controls
  are commands routed through the core.
- **Rationale.** The model needs a fresh, single image at decision time
  with a generation number. The PiP needs a low-latency, continuous
  stream so the user can see what the agent sees while the model is
  thinking, stalled, or waiting on approval. Coupling the two would
  either starve the model of fresh observations or starve the PiP of
  fluidity; both failure modes are visible to users.
- **Consequences.** The PiP host and the model loop are independent
  consumers of the native capture. The PiP image and PiP body must
  never focus the target. Continuous frames are presentation-only and
  carry no authority. Frame transport details are an open question
  (see below).
- **Status.** Frozen.

### 6. Session-scoped generations with stale-state rejection

- **Decision.** Every successful observation increments the session's
  `generation`. Every action carries the generation the caller based its
  decision on. A mismatch — including the implicit mismatch created by
  any user-plane event landing in flight — returns `stale` (or
  `stale_generation` at the transport layer) and produces **no side
  effect**.
- **Rationale.** A generation is a one-shot binding between an
  observation and the decision it produced. Without it, the only way
  to detect "the user moved the goalposts" is to inspect every action
  against the latest screen, which is racy and slow. With it, the user
  plane can revoke the generation with a single monotonic counter
  increment and every action decision automatically invalidates.
- **Consequences.** `computer_execute_action` requires `generation`.
  `Resume` performs a fresh observation; it never replays. The
  `stale` failure is a recoverable signal — the caller is expected to
  re-observe and decide again. The acceptance test for this decision
  is explicit: "An old generation or revoked lease always returns
  `stale` and performs no side effect."
- **Status.** Frozen.

### 7. Separate OpenAI Responses adapter instead of leaking `computer_call` into OmniRoute

- **Decision.** Computer Use is implemented as an isolated provider
  adapter for OpenAI Responses (with its native `computer_call`
  semantics) and a separate, provider-neutral loop for
  OmniRoute/Chat-Completions-style providers. OmniRoute is not taught
  to understand `computer_call`.
- **Rationale.** OmniRoute is a multi-provider router; not every
  provider supports Computer Use, and pretending otherwise would
  silently degrade. Adding a Computer-Use-aware path to OmniRoute
  would force the entire router to grow capability awareness it
  shouldn't carry, and would couple the cooperative policy to the
  router. An isolated adapter keeps the contract explicit and lets
  capability discovery be honest: unsupported models simply do not
  receive native-only assumptions.
- **Consequences.** Two adapter paths exist; the core remains
  provider-neutral. Raw provider envelopes are preserved for
  diagnostics but normalized tool proposals and reasoning receipts are
  what the rest of the system consumes. The provider adapter shape is
  an open question (see below).
- **Status.** Frozen.

### 8. Fake backend precedes any live macOS permission dependency

- **Decision.** `computer-use-core` ships a deterministic in-memory
  `fakeNative` backend. Every implementation path — tool surface,
  arbitration, leases, generations, provenance, fail-closed behavior —
  is exercised against the fake before any code depends on live Screen
  Recording, Accessibility, or helper lifecycle. `LATTICE_CU_BACKEND`
  is the swap point for the future socket-backed helper;
  `LATTICE_CU_TEST_HOOKS=1` adds `computer_test_inject` for event
  injection on the fake.
- **Rationale.** macOS permissions are a CI nightmare and a developer
  nightmare in equal measure. Without a deterministic fake, no one
  can write a regression test for "user input pauses before next
  action" or "stale generation performs no side effect." Shipping the
  fake first is the only way to make the cooperative guarantees
  testable in continuous integration.
- **Consequences.** Gate 1 in the subagent plan is a fake end-to-end
  loop and is a prerequisite for live macOS work. Live macOS work
  adds tests, but does not replace them. The fake is the canonical
  reference for what the protocol means.
- **Status.** Frozen.

## Open questions

These are choices that are intentionally deferred. Each has a designated
owning subagent; closing any of them is a Subagent 0 decision and may
require a contract change.

### A. AX background behavior specifics

The amendment and protocol are normative about what `background_assist`
must not do (no physical pointer movement, no global keyboard input, no
silent focus activation). They are not yet normative about exactly which
AX notifications the helper subscribes to, the polling cadence for AX
tree refresh, or how background-only AX operations behave under macOS
session/workspace changes. Subagent 4 owns the resolution; Subagent 5
owns the policy implications; Subagent 0 arbitrates.

### B. Event-tap permission model

`shared_control` and `takeover` both rely on observing user-plane
events: physical input on/around the target, focus changes, geometry
changes, capture changes, permission changes. The protocol defines the
event kinds (`NativeUserEventKind`) and the core's response (lease
revocation). The macOS-specific mechanism — whether the helper uses an
event tap, an `AXObserver` notification, an `NSApplication`-level
monitor, or a combination — is not frozen. Subagent 3 owns the
transport, Subagent 4 owns the AX observation, Subagent 5 owns the
arbitration semantics, and Subagent 12 owns the security review of
the chosen mechanism. Each macOS permission has its own privacy
consequences (Accessibility authorization in particular) and the
amendment requires that we "report Screen Recording and Accessibility
permission status without attempting to click privacy dialogs" — so
any tap-based mechanism needs a documented failure mode for "user
revoked permission."

### C. PiP frame transport

The model-observation path is fixed: an MCP image block inside an
`AppState`. The PiP frame transport is not. The Electron PiP MVP uses a
mocked frame path and is the prerequisite for proving cooperative
behavior; the native `NSPanel`/`AVSampleBufferDisplayLayer`/CoreVideo
path is Subagent 8's deliverable and replaces the MVP **only after**
cooperative behavior passes. The open question is the boundary
contract between the native capture and the PiP host: what does the
helper push (sample buffers? CVPixelBuffers? encoded H264? what
sizes, what color spaces, what cadence caps?), and what guarantees
does the PiP host offer back (frame-drop behavior, latency SLO,
multi-display routing, Retina scale changes)? Subagent 8 closes the
question after measuring first-frame latency, frame cadence, dropped
frames, CPU, memory, and model-independent responsiveness, with the
Electron MVP retained as a fallback.

### D. Provider adapter shape

The provider-neutral screenshot → action → result loop and the
isolated OpenAI Responses adapter are owned by Subagent 9. The open
question is the normalized envelope: how tool proposals, reasoning
receipts, usage, cancellation, and errors are normalized without
discarding the raw provider envelope for diagnostics, and how
capability discovery is surfaced honestly to the rest of Lattice.
The core must remain provider-neutral; the adapter must not leak
provider-specific assumptions into the core. Subagent 0 closes the
shape before Subagent 6 wires the Lattice run manager against it.