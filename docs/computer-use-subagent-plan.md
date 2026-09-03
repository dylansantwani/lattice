# Computer Use MCP recreation: subagent execution plan

This is the implementation work breakdown for [the cooperative-operation amendment](</Users/dylan/lattice/docs/computer-use-cooperative-amendment.md>). It is written so the work can be delegated to multiple agents without letting them overwrite one another or weaken the “works alongside the user” requirement.

## Objective

Build a Mac-first Computer Use MCP/plugin that can inspect and operate an approved desktop app while the user keeps control of the computer. The default mode must be non-stealing Background Assist. The system needs a standalone MCP server, a signed native macOS helper, a provider-neutral Lattice adapter, and a live PiP presentation path.

## System structure

The system has one canonical control core and two host adapters. The standalone MCP server and Lattice must not grow separate session, policy, or arbitration implementations.

```text
Model/provider
    │
    ▼
Lattice run manager + tool broker
    │
    ├── external lane: Lattice MCP manager → computer-use-mcp
    │
    └── in-process lane: Lattice Computer Use adapter
                         │
                         ▼
                 computer-use-core
                 session + policy + leases
                 arbitration + provenance
                         │
                         ▼
                 native bridge protocol
                         │
                         ▼
                 Swift macOS helper
                 ├── app/window resolver
                 ├── AX tree + AX actions
                 ├── ScreenCaptureKit frames
                 ├── restricted CGEvent fallback
                 ├── permission/interruption monitor
                 └── crash/reconnect lifecycle
                         │
                         ├── control results → core → run events/transcript
                         └── continuous frames → PiP host

 User input/focus/geometry events ───────────────→ core arbitration
 PiP controls (Pause/Resume/Focus/Stop) ─────────→ typed IPC → core
 PiP image/body ─────────────────────────────────→ presentation only
```

Only one control lane is active for a session: either Lattice calls the core in-process or it calls the standalone MCP façade. Both use the same native session and policy contract. The PiP never receives raw authority to execute an action; its controls are commands routed through the core.

### Control, presentation, and user planes

| Plane | Responsibility | Source of truth |
|---|---|---|
| Control plane | Model proposals, approvals, leases, action execution, state refresh | `computer-use-core` + native helper |
| Presentation plane | Continuous target-window frames, virtual agent cursor, status, layout | PiP host; never the model screenshot loop |
| User plane | Physical pointer/keyboard activity, focus changes, Stop, Pause, Resume | macOS events + explicit UI controls |

The user plane has priority over the control plane. A model response or MCP client can request an action, but only the core can issue a live lease to the native helper after target, generation, mode, and policy checks pass.

## Repository and package structure

This is the proposed target tree. Create it incrementally; do not reorganize unrelated Lattice code just to match the diagram.

```text
lattice/
├── docs/
│   ├── computer-use-cooperative-amendment.md
│   ├── computer-use-subagent-plan.md
│   └── computer-use/
│       ├── protocol.md                 # canonical contract explanation
│       ├── decisions.md                 # architecture decisions and reversals
│       ├── threat-model.md              # security/privacy review
│       ├── interoperability.md          # Lattice/Claude Code/Hermes matrix
│       └── handoffs/
│           └── subagent-XX-<scope>.md   # one report per subagent, unique file
│
├── packages/
│   ├── computer-use-protocol/
│   │   ├── schema/
│   │   │   ├── session.schema.json
│   │   │   ├── app-state.schema.json
│   │   │   ├── action.schema.json
│   │   │   ├── event.schema.json
│   │   │   └── error.schema.json
│   │   ├── src/index.ts                 # validated/generated TypeScript types
│   │   ├── examples/                    # wire examples for MCP and Swift
│   │   └── test/
│   │
│   ├── computer-use-core/
│   │   ├── src/
│   │   │   ├── session.ts               # session identity and lifecycle
│   │   │   ├── stateMachine.ts          # cooperative phases
│   │   │   ├── arbitration.ts           # user priority and action leases
│   │   │   ├── policy.ts                 # mode/risk/target decisions
│   │   │   ├── provenance.ts             # user/agent/system/policy sources
│   │   │   ├── controller.ts             # one public core façade
│   │   │   └── fakeNative.ts             # deterministic test backend
│   │   └── test/
│   │
│   └── computer-use-mcp/
│       ├── .codex-plugin/plugin.json
│       ├── .mcp.json
│       ├── skills/computer-use/SKILL.md
│       ├── bin/computer-use-mcp.mjs
│       ├── server/src/
│       │   ├── index.ts                  # stdio MCP entry point
│       │   ├── tools.ts                  # public tool façade
│       │   ├── nativeBridge.ts           # helper transport client
│       │   └── health.ts                 # status and capability reporting
│       ├── test/
│       └── README.md
│
├── native/
│   └── mac/
│       ├── ComputerUseService/
│       │   ├── Package.swift
│       │   ├── Sources/
│       │   │   ├── ServiceMain.swift
│       │   │   ├── Protocol/
│       │   │   ├── Transport/
│       │   │   ├── Accessibility/
│       │   │   ├── Capture/
│       │   │   ├── Actions/
│       │   │   ├── Permissions/
│       │   │   └── Recovery/
│       │   └── Tests/
│       ├── PiPHost/
│       │   ├── Sources/                  # NSPanel/native frame presentation
│       │   └── Tests/
│       └── Packaging/                    # signing, entitlements, install checks
│
├── src/
│   ├── main/
│   │   ├── computerUse/
│   │   │   ├── adapter.ts                # Lattice-facing core adapter
│   │   │   ├── nativeBridge.ts           # launches/connects to helper
│   │   │   ├── eventMapper.ts            # core → RunEvent/PushEvent
│   │   │   └── sessionRegistry.ts        # thread/turn ownership
│   │   ├── tools/computerUse.ts          # broker tool definitions
│   │   └── mcp/manager.ts                # existing MCP client manager
│   ├── renderer/src/components/computerUse/
│   │   ├── ComputerUsePip.tsx
│   │   ├── ComputerUseStatus.tsx
│   │   ├── ComputerUseApproval.tsx
│   │   └── ComputerUseControls.tsx
│   └── shared/computerUse.ts              # IPC and renderer-safe types
│
└── tests/computer-use/
    ├── protocol/
    ├── fake-e2e/
    ├── macos/
    ├── pip/
    └── interop/
```

The JSON Schemas in `computer-use-protocol` are the cross-language source of truth. TypeScript and Swift may generate or validate local types from them, but neither side may silently invent incompatible field names. `computer-use-core` contains no Electron, AppKit, model-provider, or network code. The MCP façade contains no direct macOS UI logic. The Swift helper contains no model credentials and no network client.

### Ownership boundaries

| Component | Owns | Must not own |
|---|---|---|
| Protocol package | Schemas, version negotiation, wire examples | Policy decisions or OS calls |
| Core package | Sessions, modes, leases, arbitration, provenance, policy | Screen capture, model calls, renderer state |
| MCP façade | MCP lifecycle, tool arguments/results, direct-client fail-closed behavior | A second policy/state machine |
| Swift helper | AX, ScreenCaptureKit, CGEvent capability, permissions, recovery | Model/provider logic or remote networking |
| Lattice adapter | Thread/run ownership, broker ceilings, event persistence, typed IPC | Bypassing the core or issuing raw OS actions |
| PiP host | Frames, virtual cursor, status, layout, explicit controls | Raw action authority or implicit focus |
| Evaluation suite | Fixtures, tests, measurements, acceptance evidence | Production policy changes without approval |

## Subagent workspace and handoff structure

Use isolated worktrees for write-capable agents whenever the host supports them. The repository is already dirty, so no agent may use a cleanup command to create a baseline.

Recommended branch names are:

```text
codex/computer-use/protocol
codex/computer-use/core
codex/computer-use/mcp
codex/computer-use/native-service
codex/computer-use/accessibility
codex/computer-use/lattice-adapter
codex/computer-use/pip-mvp
codex/computer-use/pip-native
codex/computer-use/providers
codex/computer-use/interop
codex/computer-use/packaging
codex/computer-use/evaluation
```

Subagent 0 owns the integration branch and is the only agent allowed to merge shared-contract or cross-scope changes. If isolated worktrees are unavailable, run read-only discovery in parallel, then run write phases serially in dependency order.

Every completed subagent writes one unique report to `docs/computer-use/handoffs/` or returns the same structure in its task response:

```text
Status: complete | blocked | needs-review
Scope: [one sentence]
Contract changes: [none, or exact schema/API fields]
Files changed: [absolute or repository-relative paths]
Tests/commands: [exact commands and pass/fail]
Manual verification: [what was exercised]
Evidence: [logs, fixtures, screenshots, measurements]
Known limitations: [be explicit]
Next handoff: [agent number and requested action]
```

An agent that discovers a cross-scope problem stops at the boundary and reports it. It does not “fix” another agent’s files opportunistically.

## Rules for every subagent

- Read the parent plan and this file before acting.
- Treat the existing working tree as user-owned and dirty. Never reset, checkout, or clean unrelated changes.
- Stay inside the assigned write scope. If a shared contract must change, report the proposed change to Subagent 0 instead of editing another agent’s files.
- Do not copy proprietary Codex binaries, private symbols, or private source. Use public MCP and Apple APIs; local binary observations remain hypotheses.
- Never make Takeover the implicit fallback for an action that fails in Background Assist.
- Every implementation must have a fake-backend or unit-test path before it depends on live macOS permissions.
- Finish with: summary, exact files changed, tests run, known limitations, and the next handoff.

## Subagent 0 — technical lead and integration owner

**Purpose:** Own the contracts, decisions, sequencing, and final integration. This agent does not start by implementing features.

**Tasks:**

1. Read `docs/product-plan.md`, `docs/ROADMAP.md`, `docs/STATUS.md`, `src/main/mcp/manager.ts`, `src/main/tools/types.ts`, `src/shared/ipc.ts`, and the two Computer Use planning documents.
2. Record the current repository baseline and the exact pre-existing dirty files.
3. Freeze the v1 decisions: macOS only, Background Assist default, Shared Control supported, Takeover explicit only, locked use excluded, one active PiP first.
4. Own the versioned shared protocol and resolve proposed changes from other agents.
5. Maintain a decision log for unresolved choices: AX background behavior, event-tap permissions, frame transport, and provider adapter shape.
6. Run the integration gates after each phase and reject changes that violate user-priority arbitration.

**Write scope:** `docs/` planning files, `docs/computer-use/decisions.md`, and the protocol package’s schemas/types/examples under `packages/computer-use-protocol/`; final integration may touch shared wiring after reviewing all agent reports.

**Deliverables:** frozen contracts, dependency graph, decision log, integration checklist, and final go/no-go report.

## Subagent 1 — repository and installed-product scout

**Purpose:** Produce read-only implementation intelligence. Do not modify files.

**Tasks:**

1. Map the Lattice seams for MCP, tool policy, run events, image results, IPC, Electron windows, and notifications.
2. Inspect the installed Computer Use plugin manifest, `.mcp.json`, skill, launcher, and public documentation.
3. Separate facts into `documented`, `observed locally`, and `proposed design`.
4. Identify macOS permission requirements and app/window identifiers needed by the native helper.
5. List compatibility risks with current `src/main/mcp/manager.ts`, especially duplicate registration and MCP image content.

**Write scope:** none. Store findings in the handoff report, not the repository.

**Deliverables:** `repo-map.md`-style report in the task response, exact file references, facts/uncertainties, and recommendations for Subagents 0, 2, 3, and 6.

## Subagent 2 — MCP/plugin contract and scaffold

**Depends on:** Subagents 0 and 1.

**Purpose:** Build the standalone MCP/plugin boundary independently of the native implementation.

**Tasks:**

1. Create the plugin manifest, `.mcp.json`, launcher entry point, and Computer Use skill.
2. Implement MCP initialization, tool discovery, structured errors, cancellation propagation, and health/status reporting.
3. Define tools with `sessionId`, `targetAppId`, `targetWindowId`, `mode`, `generation`, and action lease fields.
4. Implement the initial tools: `computer_list_apps`, `computer_start_session`, `computer_get_app_state`, `computer_execute_action`, `computer_pause`, `computer_resume`, `computer_focus`, and `computer_stop`.
5. Return compact JSON plus MCP image blocks; never put screenshot bytes in the text field.
6. Add a fake-controller transport so every tool can be tested without Accessibility or Screen Recording permissions.

**Write scope:** `packages/computer-use-mcp/`, including its tests. Consume the protocol/core packages; do not edit their source, Lattice runtime files, or the Swift helper.

**Deliverables:** runnable stdio MCP server, plugin metadata, skill, protocol examples, fake-controller tests, and a client compatibility smoke script.

## Subagent 3 — native macOS service skeleton

**Depends on:** Subagent 0’s protocol decision.

**Purpose:** Build the signed-helper foundation and process boundary, without implementing all UI semantics.

**Tasks:**

1. Create a Swift/AppKit helper with a stable launch/stop lifecycle.
2. Implement the versioned local transport between the MCP server/Lattice bridge and the helper.
3. Add request IDs, serialized action execution, deadlines, cancellation, frame-size limits, and crash detection.
4. Report Screen Recording and Accessibility permission status without attempting to click privacy dialogs.
5. Implement session creation/teardown and target app/window identity checks.
6. Add a fake service mode and deterministic fixtures for CI.

**Write scope:** `native/mac/ComputerUseService/Sources/ServiceMain.swift`, `Protocol/`, `Transport/`, `Permissions/`, and `Recovery/`, plus helper-specific packaging files. Do not edit AX/Actions/Capture or PiP UI files owned by Subagents 4 and 7.

**Deliverables:** helper binary target, local protocol implementation, permission status API, lifecycle tests, and a documented launch contract.

## Subagent 4 — perception and accessibility action engine

**Depends on:** Subagent 3’s service boundary.

**Purpose:** Implement target-scoped state capture and safe semantic actions.

**Tasks:**

1. Resolve canonical bundle IDs, process IDs, and window IDs; reject ambiguous display-name matches.
2. Build normalized AX trees with stable IDs, roles, titles, values, actions, frames, and generation numbers.
3. Add AX notifications for focus, window creation, resize, and value changes.
4. Add ScreenCaptureKit selected-window capture and coordinate/scale metadata.
5. Execute AX press/value actions first; expose CGEvent fallback only as a capability marked `requiresFocus`.
6. Reject stale generations, changed target windows, revoked leases, and actions outside the approved app/window.
7. Return structured `ready`, `permission-required`, `stale`, `user-intervened`, and `source-unavailable` results.

**Write scope:** `native/mac/ComputerUseService/Sources/Accessibility/`, `Capture/`, `Actions/`, and their fixtures/tests. Do not change the MCP façade, core package, or Lattice run manager.

**Deliverables:** `AppState`/`AxNode` implementation, action executor, permission-aware errors, Calculator/TextEdit fixtures, and coordinate-mapping tests.

## Subagent 5 — cooperative arbitration and policy

**Depends on:** Subagent 0’s contracts; can use Subagent 3’s fake service.

**Purpose:** Make alongside-user behavior enforceable rather than prompt-dependent.

**Tasks:**

1. Implement `Background Assist`, `Shared Control`, and explicit `Takeover` policies.
2. Add action leases and generation invalidation.
3. Track user, agent, system, and policy event provenance.
4. Detect user input, active-app changes, target focus changes, target geometry changes, and capture changes.
5. On user activity, revoke the lease, clear pending actions, pause at a safe boundary, preserve the user’s input, and require Resume.
6. Make Resume perform a fresh observation; never replay the interrupted action.
7. Keep high-impact actions behind action-time approval and fail closed when policy state is unknown.

**Write scope:** `packages/computer-use-core/src/stateMachine.ts`, `arbitration.ts`, `policy.ts`, `provenance.ts`, `session.ts`, and focused tests. Do not edit native capture code, the MCP façade, or renderer components.

**Deliverables:** policy engine, arbitration state machine, provenance records, fake event-injection tests, and a short threat model.

## Subagent 6 — Lattice runtime/tool-broker adapter

**Depends on:** Subagents 2, 4, and 5.

**Purpose:** Connect Computer Use to Lattice without bypassing its existing tool policy, event store, or image pipeline.

**Tasks:**

1. Add the provider-neutral Computer Use tool definitions to the existing tool catalog.
2. Use the existing MCP manager as a client for the standalone server, or use an in-process adapter to the same controller; never register both for one session.
3. Preserve Lattice’s approval ceilings and add target-app/window/action policy checks before every call.
4. Attach screenshots using the existing MCP image extraction and vision-input reattachment path.
5. Emit canonical run events for proposed, approved, executing, paused, user-controlled, stale, source-unavailable, canceled, and completed states.
6. Wire Pause, Resume, Focus, and Stop through typed IPC and notifications.
7. Add run cancellation and crash cleanup so no helper session survives its owning turn.

**Write scope:** `src/main/computerUse/`, `src/main/tools/computerUse.ts`, relevant `src/main/ipc.ts`, `src/shared/computerUse.ts`, and focused runtime tests. Shared protocol/core edits require Subagent 0 approval.

**Deliverables:** working Lattice adapter, event mapping, typed IPC, policy integration, image-path tests, and a deterministic fake-provider run.

## Subagent 7 — PiP MVP and cooperative UX

**Depends on:** Subagents 0 and 5; fake frames may precede Subagent 4.

**Purpose:** Prove that the user can see and control the agent without the PiP taking over.

**Tasks:**

1. Build the separate frameless Electron PiP window.
2. Render a continuous frame stream independently of model-response latency.
3. Add a virtual agent cursor; never move the physical pointer in Background Assist.
4. Add explicit target app, mode, and status display.
5. Add Pause/Resume, Stop, Hide, and explicit Focus controls.
6. Ensure the PiP body is non-focusable/click-through where appropriate; clicking the image must not focus the target or execute actions.
7. Implement four-corner placement, obstacle avoidance, aspect-ratio preservation, stale/source-unavailable states, and teardown.
8. Add keyboard/notification access to Stop so the user can recover even if the PiP is obscured.

**Write scope:** `src/main/pip/`, `src/renderer/src/components/computerUse/`, and PiP styling/tests. Do not edit the native frame producer, core package, or provider adapter.

**Deliverables:** PiP MVP, mocked-frame demo, UX state reducer, window-behavior tests, and a manual co-use checklist.

## Subagent 8 — native PiP frame path and performance

**Depends on:** Subagent 7’s behavior and Subagent 4’s capture output.

**Purpose:** Improve frame quality and latency after the cooperative behavior is already proven.

**Tasks:**

1. Prototype native `NSPanel`/AppKit presentation with ScreenCaptureKit sample buffers.
2. Evaluate CoreVideo/IOSurface and `AVSampleBufferDisplayLayer` or an equivalent public Core Animation path.
3. Preserve virtual cursor, status overlays, geometry revisions, and source-unavailable recovery.
4. Measure first-frame latency, frame cadence, dropped frames, CPU, memory, and model-independent responsiveness.
5. Keep the Electron MVP as a fallback if native rendering is unavailable.

**Write scope:** `native/mac/PiPHost/`, performance fixtures, and benchmark reports. Do not change arbitration or MCP contracts.

**Deliverables:** native renderer prototype, benchmark results, fallback decision, and integration notes for Subagents 6, 7, and 11.

## Subagent 9 — provider and model-loop adapter

**Depends on:** Subagents 2, 4, 5, and 6.

**Purpose:** Make the action loop work across OmniRoute/OpenAI-compatible providers without pretending all providers support the same computer-use contract.

**Tasks:**

1. Implement the provider-neutral screenshot → action → result loop for OmniRoute/Chat Completions.
2. Preserve actual image inputs and compact structured action results.
3. Add an isolated OpenAI Responses adapter for native `computer_call` semantics.
4. Normalize tool proposals, reasoning receipts, usage, cancellation, and errors without discarding raw envelopes.
5. Add settle policy and stale-state recovery that re-observes instead of blindly retrying.
6. Make tool capability discovery honest; unsupported models must not receive unusable native-only assumptions.

**Write scope:** provider adapter files and loop-specific tests; do not edit the native helper, MCP server, or PiP UI.

**Deliverables:** two adapter paths, fake SSE/Responses fixtures, multi-round loop tests, and a capability matrix.

## Subagent 10 — Claude Code/Hermes interoperability

**Depends on:** Subagent 2’s standalone MCP contract.

**Purpose:** Verify that the same MCP server can be consumed outside Lattice.

**Tasks:**

1. Test stdio initialization and tool discovery from Claude Code-compatible MCP configuration.
2. Test Hermes MCP configuration and its ACP-facing launch path where available.
3. Document environment variables, launcher paths, permission prerequisites, and supported tool versions.
4. Verify structured image results, cancellation, errors, and session teardown in each client.
5. Never share mutable private state databases or memory files with another harness.

**Write scope:** `docs/computer-use/interoperability.md`, standalone MCP compatibility fixtures, and client smoke scripts. Do not edit client configuration files outside the repository.

**Deliverables:** compatibility report, example configs, version matrix, and list of lossy/unsupported behaviors.

## Subagent 11 — packaging, permissions, and recovery

**Depends on:** Subagents 3, 4, 7, and 8.

**Purpose:** Make the Mac-first build installable and recoverable without expanding scope into locked use.

**Tasks:**

1. Add signed helper packaging and Electron distribution wiring.
2. Add first-run Screen Recording and Accessibility permission guidance.
3. Handle helper crash, app closure, permission revocation, capture loss, sleep/wake, multiple displays, and Retina scale changes.
4. Ensure teardown on Stop, cancellation, thread deletion, app quit, and MCP disconnect.
5. Verify PiP never captures itself and does not intercept target-app input unexpectedly.
6. Explicitly keep authorization plugins, locked use, and automatic unlock out of v1.

**Write scope:** packaging/signing scripts, `native/mac/Packaging/`, recovery tests, and setup documentation under `docs/computer-use/`. Do not change the action policy or provider loop.

**Deliverables:** installable Mac build, recovery matrix, permission checklist, and release blockers.

## Subagent 12 — security and privacy reviewer

**Depends on:** Subagents 2, 4, 5, 6, and 11. Read-only unless Subagent 0 approves a narrow fix.

**Purpose:** Try to break the user-priority and data-boundary guarantees.

**Review:**

- Can a model or third-party UI text cause an unapproved action?
- Can an action escape the approved bundle ID/window ID?
- Can a stale action execute after user input or geometry change?
- Can screenshots, clipboard content, or sensitive fields leak into logs or model text?
- Can the PiP or helper steal focus, pointer, or keyboard input in Background Assist?
- Can a disconnected MCP client leave a running helper or an active lease?
- Are high-impact actions approved at action time?
- Are unknown protocol versions and permission events denied safely?

**Write scope:** review report only; fixes go to the owning subagent.

**Deliverables:** severity-ranked findings, reproduction steps, and explicit sign-off conditions.

## Subagent 13 — test and evaluation owner

**Depends on:** Subagents 2, 4, 5, 6, and 7; continues through the project.

**Purpose:** Build the evidence that the system works alongside the user.

**Tasks:**

1. Create deterministic fake-service tests for every MCP tool and state transition.
2. Add Calculator, TextEdit, Notes, Finder, and Chrome safe workflows.
3. Add event-injection tests for physical pointer movement, global key input, app focus, window resize, and user takeover.
4. Add stale-generation, revoked-lease, target mismatch, crash, capture loss, and permission tests.
5. Add PiP latency and responsiveness tests while the model is slow or blocked.
6. Add Lattice, Claude Code, and Hermes MCP smoke tests.
7. Produce a final acceptance matrix with pass/fail evidence, not just “works locally.”

**Write scope:** `tests/computer-use/`, fixtures, and evaluation reports. Do not edit production code except for narrowly scoped test hooks approved by Subagent 0.

**Deliverables:** automated test suite, manual test script, performance report, and release acceptance matrix.

## Phase gates

### Gate 0 — contracts and safety

Required before native work: Subagents 0, 1, 2, and 5 have delivered. The MCP schema, modes, leases, generations, provenance, and fail-closed behavior are frozen.

### Gate 1 — fake end-to-end loop

Required before live macOS capture: a fake MCP server can start a session, return an image, execute an action, pause on a simulated user event, reject a stale action, resume with a fresh observation, and stop cleanly.

### Gate 2 — real macOS control

Required before PiP polish: Calculator/TextEdit workflows pass with approved app/window scoping, AX-first actions, permission reporting, crash cleanup, and no unexpected global input in Background Assist.

### Gate 3 — human co-use

Required before calling the feature usable: a person can work in another app while Background Assist runs; Shared Control pauses on user activity; Focus is explicit; Stop is always reachable; PiP remains responsive while the model thinks.

### Gate 4 — interoperability and release

Required before packaging: standalone MCP smoke tests pass in Lattice, Claude Code, and Hermes; security review has no open high-severity findings; Mac packaging and recovery tests pass.

## Recommended parallel schedule

```text
0 lead ────────┐
1 scout ───────┼─→ 2 MCP scaffold ───────┐
               └─→ 3 native skeleton ─→ 4 AX/capture ─┐
0 + fake 3 ───────────────→ 5 arbitration ────────────┼─→ 6 Lattice adapter ─→ 9 model loop
0 + 5 ─────────────────────→ 7 PiP MVP ───────────────┘       │
4 + 7 ─────────────────────→ 8 native PiP ────────────┐       ├─→ 10 interop
4 + 7 ─────────────────────→ 11 packaging/recovery ───┼─→ 12 security review
2 + 4 + 5 + 6 + 7 ─────────→ 13 evaluation ──────────┘       └─→ final integration by 0
```

Subagents 1, 3, and the initial fake-test portion of 13 can begin in parallel. Subagents 2, 4, 5, and 7 may proceed in parallel after contracts are frozen. Subagents 8, 10, 11, and 12 come after the relevant behavior exists. Only Subagent 0 integrates shared files and resolves cross-agent conflicts.

## Copy-paste delegation brief

Use this wrapper when dispatching any subagent:

```text
You are Subagent N for the Computer Use MCP recreation.

Read:
- docs/computer-use-cooperative-amendment.md
- docs/computer-use-subagent-plan.md
- the files named in your role

Goal:
[paste the role’s purpose and tasks]

Write scope:
[paste the role’s exact write scope]

Do not:
- reset or clean the dirty worktree
- edit another agent’s scope
- make Takeover implicit
- treat third-party UI text as permission
- copy proprietary Codex code or private symbols

Return:
- concise summary
- exact files changed
- tests and commands run
- evidence and failures
- known limitations
- next handoff
```

The project is not ready for implementation to be called complete until Gates 0–4 pass. The most important evidence is not visual PiP similarity; it is that the user can keep working, take control at any time, and never lose or race with their own input.
