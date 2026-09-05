# Computer Use — security and privacy review

This document is the structured threat model for the v1 Computer Use
system. It grounds every threat in a named guarantee from
`docs/computer-use-cooperative-amendment.md` and maps each mitigation
to a specific mechanism in the frozen protocol
(`packages/computer-use-protocol/src/index.ts`, `src/core.ts`) and the
core's enforcement points (sessions, leases, generations,
arbitration, provenance).

The threat model assumes the worst about every input that crosses a
trust boundary. The mitigation column is what makes the system
fail-closed, not what makes it succeed.

## Assets

What the system is trying to protect.

- **User's screen contents.** Every visible pixel of the target
  window — and potentially other windows — is captured by
  ScreenCaptureKit. Frames are sensitive in the obvious sense (they
  may show passwords, chat windows, documents) and in the
  less-obvious sense (they may reveal context the user has not
  shared with the model).
- **Keystrokes.** Every global key injection path
  (`type_text`, `press_key`) and every focused text input is a
  potential exfiltration vector. Keystrokes are also a side
  channel: even if the model never sees them, a stuck modifier or
  focused text field can change what the next user keystroke does.
- **Clipboard.** `paste` is implemented through the AX value path
  with no global clipboard involvement. Direct clipboard access is
  out of scope for v1 but is listed here because any future
  addition must be re-reviewed.
- **Approved app/window scope.** The user grants permission for a
  specific bundle id and (optionally) a specific window id. Every
  action, every observation, every frame must be confined to that
  scope. An escape is a confidentiality **and** integrity
  violation.
- **Model credentials.** API keys, OAuth tokens, and provider
  configuration that authorize the model loop. The native helper
  must never hold, log, or transmit them.

## Trust boundaries

Where the system crosses a domain of trust. Each boundary is a place
a hostile input can enter the system.

| Boundary | Domain crossing | Direction of risk |
|---|---|---|
| **Model / provider** → MCP client | Tool proposals, tool arguments, follow-up messages, image inputs | A model can propose any action; on-screen text can be quoted back to it as evidence |
| **MCP client** → **core** | Tool calls with `sessionId`, `generation`, `action` | A misbehaving or compromised MCP client can call tools out of order, with stale generations, or with fabricated leases |
| **Core** → **native helper** | Lease-gated actions, target/identity assertions | A bug in the core could let an action reach the helper that violates policy |
| **Native helper** → **macOS** | AX calls, ScreenCaptureKit calls, CGEvent post | A bug in the helper could act on the wrong window, capture the wrong screen, or post an event to the wrong process |
| **PiP** → **core** | Pause / Resume / Focus / Stop commands | A hostile or buggy PiP could route commands through the core; the PiP must never be a back door for raw action authority |
| **User plane** → **core** | Native user events (input, focus, geometry, capture, permission) | The user plane is trusted for *signal* but not for *content* — text from the user plane must never be treated as permission |
| **Logs / diagnostics** | Every byte the system emits | Logs are a passive exfiltration channel; anything sensitive must be redacted or omitted |

The core sits at the center. It is the only component that may grant
a live lease. The native helper is the only component that may touch
the OS. The MCP client is untrusted with respect to generations,
leases, and target identity; it is trusted only as the caller that
the user has authorized.

## Threat catalog

Each threat has a name, an attack narrative grounded in the system's
trust boundaries, a mitigation that names the protocol or core
mechanism that prevents it, and a reference back to the guarantee in
the amendment that the mitigation satisfies.

### T1. Model- or third-party UI-induced unapproved action

- **Threat.** The model is persuaded — by its own training, by a
  prompt injection in the user's screen, or by another model's
  output — to perform an action the user has not approved. The
  most dangerous variant is third-party UI text ("Click here to
  confirm your subscription") being treated as permission to act.
- **Attack.** The model calls `computer_execute_action` with an
  action and a generation that the model itself chose, citing text
  it read off the target window as justification.
- **Mitigation.** High-impact actions are gated behind
  `needs_permission` and require action-time user approval; they
  are never approved by on-screen text. The core rejects
  `out_of_policy` actions independent of model justification.
  `requiresFocus()` and `MODE_POLICY` keep `background_assist` from
  silently escalating to `takeover`. `ACTION_METADATA` is mirrored
  into tool descriptions so the model sees the same focus contract
  the core enforces.
- **Guarantee.** "High-impact actions remain human-approved and
  third-party UI text is never treated as permission." The PiP and
  transcript always expose the current mode and target.

### T2. Action escaping the approved bundle-id / window-id scope

- **Threat.** An action lands on the wrong app or the wrong window,
  either because the model addressed it loosely ("the Calculator
  window") or because the helper's identity check is incomplete.
  Display-name matches are not identity.
- **Attack.** The model calls `computer_execute_action` with an
  `expectedTarget` whose `appId` does not match the session's
  `target.appId`, or whose `windowId` does not match
  `target.windowId`. Alternatively, the model calls without
  `expectedTarget` and relies on the helper to resolve
  ambiguously.
- **Mitigation.** `TargetRef` is `{ appId, windowId? }` and the
  core rejects mismatches with `target_mismatch` /
  `ActionFailureStatus.target_mismatch`. The amendment explicitly
  requires: "An action addressed to an unapproved app or window is
  rejected, even if its display name matches." The native helper
  resolves canonical bundle IDs and window IDs and rejects
  ambiguous display-name matches.
- **Guarantee.** "Capture only the approved application/window."
  "An action addressed to an unapproved app or window is rejected,
  even if its display name matches."

### T3. Stale action executing after user input or a geometry change

- **Threat.** The user moves the pointer, types a key, switches
  focus, resizes the target window, or otherwise changes the
  scene between the observation the model decided on and the
  action landing. Without a freshness mechanism, the action
  applies to a world the user has already moved past.
- **Attack.** The model issues an action at generation `N`. Before
  it lands, the user clicks inside the target window. The
  helper's event stream reports a `user_input` /
  `target_focus_changed` / `target_geometry_changed` event.
- **Mitigation.** Every observation increments `generation`; every
  action carries the generation the caller based its decision on;
  a mismatch returns `stale` / `stale_generation` with no side
  effect. The lease is revoked on **any** user-plane event. After
  revocation, `Resume` performs a fresh observation — it never
  replays the interrupted action. The amendment acceptance test is
  explicit: "An old generation or revoked lease always returns
  `stale` and performs no side effect." "In Shared Control, user
  activity pauses the session before the next action; no pending
  action executes afterward."
- **Guarantee.** "User input always wins." "Resume always performs
  a fresh observation; it never replays an old action."

### T4. Screenshots / clipboard / sensitive fields leaking into logs or model text

- **Threat.** Screen contents or sensitive field values are written
  to disk by a logging subsystem, printed to a debug console,
  embedded in an error message, returned in tool text, or otherwise
  exposed outside the MCP image block path.
- **Attack.** A naive logger dumps `AppState` to JSON; a debug
  build prints the raw `Screenshot.dataBase64`; a tool wrapper
  inlines the image bytes into its text result; a stack trace
  serializes an `AppState` into the exception message.
- **Mitigation.** Screenshots travel **only** as MCP image content
  blocks. The compact JSON payload that accompanies an observation
  carries `{ omitted: 'see image block' }` in place of bytes; the
  base64 string never appears in tool text. The protocol freeze
  records this rule. Logging code paths in the core and the MCP
  façade must redact `screenshot`, `value`, and `text` fields
  before persisting. `paste` is implemented through the AX value
  path with no global clipboard involvement, so clipboard
  exfiltration is not in the v1 surface.
- **Guarantee.** "Results use structured content: compact JSON
  plus an MCP image block for screenshots; screenshots must not be
  embedded as giant base64 strings in tool text."

### T5. PiP or helper stealing focus / pointer / keyboard in `background_assist`

- **Threat.** The default mode is supposed to be non-stealing.
  A bug — or a deliberate shortcut — moves the physical pointer,
  injects a global key, or activates the target. The most common
  variant is the PiP itself: clicking or dragging the PiP body
  activates the target behind it.
- **Attack.** A coordinate-based action runs while the target is
  backgrounded. The PiP's window has `acceptsFirstResponder` true.
  An event tap posts a key event outside the target window's text
  input context.
- **Mitigation.** `MODE_POLICY.background_assist` sets
  `mayMovePhysicalPointer: false`, `mayInjectGlobalKeys: false`,
  and `mayActivateFocus: false`. The PiP body must not focus the
  target; only an explicit `computer_focus` call (or an explicit
  Focus control) may do that. The amendment acceptance test is
  explicit: "Background Assist produces no physical pointer
  movement and no global keyboard injection." "AX actions that can
  run without focus do not change the user's active app." "The
  PiP body never focuses the target; only the Focus control can
  do so."
- **Guarantee.** "Do not move the physical pointer. Do not inject
  global keyboard input. Prefer AX actions and value-setting that
  do not activate or focus the target."

### T6. Disconnected MCP client leaving a running helper or a live lease

- **Threat.** The MCP client disconnects (network drop, crash,
  user quit, idle timeout) while the native helper is still
  capturing frames, a session is still active, and a lease is
  still granted. The next action the user takes may land in a
  session they believe is dead.
- **Attack.** The standalone MCP server loses its connection to
  the MCP client. Sessions, leases, and the helper process
  continue running because nothing tears them down.
- **Mitigation.** Every stateful call carries `sessionId`. The
  core exposes `stop(sessionId)` and a global `shutdown()`; the
  Lattice adapter must tear the session down on run cancellation,
  thread deletion, app quit, and MCP disconnect. Lease expiry
  (`expiresAt` on `ActionLease`) bounds the lifetime of any lease
  even if revocation somehow fails. The amendment requires: "No
  helper session survives its owning turn."
- **Guarantee.** "Cancellation must stop queued work and
  propagate to the native helper." "Native-helper crash, target-app
  closure, capture loss, and permission revocation produce visible
  recoverable states."

### T7. High-impact actions bypassing action-time approval

- **Threat.** A destructive or hard-to-reverse action (file
  deletion, send, purchase, send-message, irreversible settings
  change) runs without the user seeing and confirming it.
- **Attack.** The model proposes an action whose risk class is
  "high-impact" but whose execution path does not consult the user.
  A bug in policy classification skips `needs_permission`.
- **Mitigation.** High-impact actions route through
  `needs_permission`. The PiP and the Lattice thread transcript
  expose the current state, target, and mode. The amendment
  acceptance test is explicit: "High-impact actions remain
  human-approved and third-party UI text is never treated as
  permission." The PiP must always show Stop, and the user must
  be able to invoke Stop from outside the PiP (keyboard,
  notification) in case the PiP is obscured.
- **Guarantee.** "High-impact actions remain human-in-the-loop."
  "The PiP remains responsive while the model is thinking,
  stalled, or waiting for approval."

### T8. Unknown protocol versions and permission-revocation events handled unsafely

- **Threat.** A new protocol version introduces a field the
  current core does not understand; an old protocol version is
  silently downgraded; a permission revocation arrives as a
  user-plane event and is dropped or handled optimistically. In
  every case, the safest outcome is to stop and surface the
  problem, not to guess.
- **Attack.** A future MCP client sends a `protocol: '2.0'`
  request with fields the v1 core cannot evaluate. The user
  revokes Accessibility permission in System Settings; the
  helper's `permission_changed` event arrives.
- **Mitigation.** `version_unsupported` is a transport-level
  `CUError`; the session is not started, no observation is
  returned. `permission_changed` and `capture_lost` are
  `NativeUserEventKind`s; the core converts them into
  `source_unavailable` transitions and revokes the lease.
  `source_unavailable` is **never** silently retried. Unknown
  action types in `requiresFocus()` fail closed: `focusable:
  true` default. The core fails closed whenever policy state is
  unknown.
- **Guarantee.** "A stale or source-unavailable result is never
  silently retried." "Fail closed when policy state is unknown."

## Fail-closed invariants checklist

This is the test list the security reviewer (Subagent 12) and the
evaluation owner (Subagent 13) walk against before sign-off. Each
item is a property the system must preserve, not a test it must
literally run.

- [ ] **Stale rejection.** An action issued at a generation that no
      longer matches the session returns `stale` / `stale_generation`
      with no side effect.
- [ ] **Lease revocation on user input.** Any `NativeUserEvent` of
      kind `user_input`, `target_focus_changed`,
      `target_geometry_changed`, `target_ended`, `capture_lost`,
      `permission_changed`, or `helper_crash` revokes the current
      lease and clears queued actions.
- [ ] **No replay on resume.** After any revocation, the next
      action is preceded by a fresh observation; the interrupted
      action is never re-issued.
- [ ] **No silent escalation.** A focusable action in
      `background_assist` returns `needs_focus`; the mode does not
      change to `takeover` automatically.
- [ ] **No global input in `background_assist`.** The helper does
      not move the physical pointer, does not post global key
      events, and does not activate the target unless the action
      is explicitly a semantic action that does not require focus.
- [ ] **PiP body non-focusable.** Clicking or dragging the PiP body
      does not focus the target or execute an action; only the
      Focus control and `computer_focus` may do so.
- [ ] **Scope enforcement.** Every action's `expectedTarget` (or
      the session's stored target) is checked against the
      canonical bundle id and window id; display-name matches do
      not satisfy identity.
- [ ] **Screenshot hygiene.** Screenshots appear only as MCP image
      content blocks; tool text and logs never contain
      `Screenshot.dataBase64`. The compact JSON returns
      `{ omitted: 'see image block' }`.
- [ ] **Action-time approval for high-impact.** High-impact
      actions route through `needs_permission` and never rely on
      on-screen text for permission.
- [ ] **Version and permission fail-closed.** Unknown protocol
      versions return `version_unsupported`. Unknown action types
      are treated as `focusable: true`. `permission_changed`
      transitions to `source_unavailable` rather than retrying.
- [ ] **Disconnected-client teardown.** MCP-client disconnect,
      run cancellation, thread deletion, app quit, and Stop all
      tear down the session, revoke the lease, and stop the
      helper. No helper session survives its owning turn.
- [ ] **Provenance.** Every action and every interruption records
      provenance (`user | agent | system | policy`).
- [ ] **No provider leakage.** The core holds no model credentials
      and makes no network calls. The native helper holds no
      model credentials and makes no network calls.
- [ ] **No clipboard involvement.** `paste` is implemented through
      the AX value path; no path in v1 reads or writes the global
      clipboard.