# Computer Use — canonical contract explanation

This document is the prose companion to the JSON Schemas in
`packages/computer-use-protocol/schema/` and the TypeScript mirror in
`packages/computer-use-protocol/src/index.ts` and `src/core.ts`. It is the
specification an implementer should be able to build against without reading
the plan or amendment documents. Every claim here is grounded in the frozen
protocol; nothing is invented.

The protocol is `1.0`. It is cross-language (TypeScript and Swift both generate
or validate against the same JSON Schemas) and contains **no policy decisions
and no OS calls** — those live in `computer-use-core` and the signed macOS
helper respectively.

## Goals in one paragraph

Computer Use exposes a target application (and optionally a single window) to
an LLM through a small, MCP-shaped tool surface while keeping the human user
in charge of the computer. The default mode, `background_assist`, captures
only the approved target, never moves the physical pointer, never injects
global keyboard input, and prefers Accessibility ("AX") semantic actions
that do not require foreground focus. Any action that would require focus or
physical input is rejected with `needs_focus` rather than silently escalating.
Screenshots always travel as MCP image content blocks — never as base64 in
tool text.

## Tool surface

There are exactly nine MCP tools. Both the standalone MCP server and the
in-process Lattice adapter publish the same names and shapes; the standalone
server is the wire-format truth, the in-process adapter uses the same
`Controller` façade so there is no second policy implementation.

| Tool | Purpose | Key inputs | Key outputs |
|---|---|---|---|
| `computer_list_apps` | Enumerate apps the native helper can target by canonical bundle id. Read-only. | (none) | `AppTarget[]` (`app`, `windows`) |
| `computer_start_session` | Begin a cooperative session scoped to one app and optional window. | `targetAppId`, `targetWindowId?`, `mode` (default `background_assist`) | session id, fresh observation, mode/target/generation |
| `computer_get_app_state` | Re-observe: screenshot + accessibility tree + flattened text + generation. | `sessionId` | `AppState` (and an MCP image block for the screenshot) |
| `computer_execute_action` | Execute one action under an action lease at the observed generation. | `sessionId`, `generation`, `action`, optional `expectedTarget`, lease context | success: fresh observation + lease + provenance; failure: structured `ActionFailureStatus` |
| `computer_pause` | Revoke the current lease and clear queued work. | `sessionId` | new `state` (`paused`) |
| `computer_resume` | Resume after pause; the next action re-observes automatically if no generation is supplied. Never replays. | `sessionId` | new `state` and a fresh observation |
| `computer_focus` | The **only** path that may bring the target window to the foreground. | `sessionId` | new `state` and a fresh observation |
| `computer_stop` | Tear down the lease, stop capture, release the target. Safe any time. | `sessionId` | new `state` (`ended`) |
| `computer_health` | Server and native-backend status (backend kind, protocol version, session counts, permission state). | (none) | health record |

`computer_list_apps` and `computer_health` are stateless. Every other tool
takes `sessionId`. `computer_execute_action` additionally takes `generation`
(the generation the caller based its decision on) and an optional
`expectedTarget` re-assertion. The caller **must** pass the generation it
just observed; mismatches are rejected with no side effect.

## Session object and lifecycle

A `ComputerUseSession` is the durable record of one cooperative interaction
with one target. Its `sessionId` is the only stable handle; every other
field is mutable in well-defined ways.

```
sessionId      string              // stable handle
protocol       '1.0'               // ProtocolVersion
state          SessionState        // see lifecycle below
mode           Mode                // background_assist | shared_control | takeover
target         TargetRef           // { appId, windowId? }
generation     number              // monotonic; ++ per observation
createdAt      string (ISO)
updatedAt?     string (ISO)
lease?         ActionLease | null  // present while a lease is live
lastProvenance? ProvenanceRecord    // user | agent | system | policy
```

### Lifecycle states

The state machine has twelve named states. The cooperative amendment defines
the happy path and the interruption/recovery transitions; the protocol
types are the typed surface of that machine.

```
idle → observing → proposing
                    ├─ needs permission → observing
                    ├─ needs focus      → user decision
                    └─ executing → verifying → observing

Any active state ── user event ──→ user_has_control → paused
Any active state ── stale/source unavailable ──→ recoverable stop
Any active state ── Stop ──→ ended
```

| State | Meaning |
|---|---|
| `idle` | Session exists but has no current observation. |
| `observing` | Capturing or holding a fresh `AppState`; ready to propose an action. |
| `proposing` | Model has proposed an action; lease and policy checks are running. |
| `needs_permission` | High-impact action requires user approval before it can run. |
| `needs_focus` | Action requires foreground focus; the controller does **not** escalate. The user must explicitly invoke `computer_focus` or accept a mode change. |
| `executing` | A leased action is currently executing in the native helper. |
| `verifying` | Post-action re-observation to confirm effect and produce the fresh observation returned with the result. |
| `user_has_control` | A user-plane event (input, focus change, geometry change, capture change, permission revocation) has taken priority. The controller pauses at the next safe boundary. |
| `paused` | Lease is revoked and queued work is cleared. Resume will re-observe; nothing replays. |
| `stale` | The action's generation did not match the session, or the lease was revoked, or the target moved. No side effect occurred. Recoverable by re-observing. |
| `source_unavailable` | Screen capture, AX, or the native helper itself is unavailable. Recoverable; never silently retried. |
| `ended` | Terminal. `computer_stop` was called or the session was torn down. |

`ACTIONABLE_STATES` is the set of states in which a new action may be
considered before lease granting: `observing`, `proposing`, `verifying`.
`ACTIVE_STATES` (the set that counts as "active" for user-intervention
purposes) also includes `needs_permission`, `needs_focus`, and `paused`.
Only `ended` is terminal.

## Generation and lease model

Two related mechanisms prevent races between the model and the user.

### Generations

- Every successful observation (the contents of `AppState` returned by
  `computer_get_app_state` and by every successful action result) increments
  the session's `generation`.
- The caller passes that generation back on `computer_execute_action`.
- If the supplied generation does not equal the session's current
  generation, the action is rejected with `stale` and **no side effect
  occurs**. The caller is expected to re-observe and decide again.

This makes every action decision explicitly tied to one observation. Stale
rejection is the same mechanism that catches the post-user-input case: any
user-plane event that lands before the action finishes invalidates the
generation in flight, so the action cannot race the user.

### Leases

- A live `ActionLease` carries `leaseId`, `actionId`, `generation`,
  `target` (`TargetRef`), `mode`, `grantedAt`, and `expiresAt`.
- Only one lease may be live per session at a time.
- Leases are revoked on **any** user-plane event reported by the native
  helper: physical user input, target focus change, target geometry change,
  target ended, capture lost, permission changed, or helper crash. The
  native helper reports these as `NativeUserEvent`s; the core translates
  them into lease revocations and `user_has_control` / `stale` /
  `source_unavailable` transitions.
- After a revocation, the next action is always issued against a fresh
  observation. Resume never replays the interrupted action.

The amendment makes the same point in user-facing language: "Resume always
performs a fresh observation; it never replays an old action."

## AppState

`AppState` is the single shape returned for every observation. Both
`computer_get_app_state` and the success branch of `computer_execute_action`
return it, so every code path that decides on an action is reading from the
same shape.

```
AppState {
  app         AppInfo         // canonical bundle id + display name
  window      WindowInfo|null // window id, title, bounds (Frame { x,y,w,h })
  focus       'foreground' | 'background'
  screenshot  Screenshot|null // { mimeType:'image/png', w, h, dataBase64 }
  axTree      AxTree|null     // { generation, root: AxNode }
  text        string           // flattened accessible text from the AX tree
  generation  number           // the generation this observation belongs to
  capturedAt  string (ISO)
}
```

### AX tree, indexed

`AxTree.root` is the root `AxNode`. Every `AxNode` carries a numeric
`index` field that is its **pre-order position** in the tree. The
`children` array is recursive. Indices are stable for the lifetime of one
`AppState`; they are not reused across observations. Element-index actions
(`click_element`, `set_value`, `select_text`, `secondary_action`) reference
nodes by this index, which lets the native helper resolve them without
re-traversing the tree and lets the model name what it sees.

Each `AxNode` also carries `role`, optional `title`, `value`, `actions`
(array of named AX actions available on the node), and an optional `frame`
in window-relative coordinates.

### Screenshots and the no-base64-in-text rule

`Screenshot` is the **internal** observation shape and does contain
`dataBase64`. But the wire rules are different and they are normative:

- MCP tool results return the screenshot as an MCP **image content block**.
- The compact JSON text that travels alongside the image block carries
  `{ omitted: 'see image block' }` in place of the bytes — never the base64
  string itself.
- This applies to every tool that returns an observation, including
  `computer_get_app_state` and the success branch of
  `computer_execute_action`.

The freeze handoff records this rule explicitly: "Screenshots are MCP image
content blocks only — JSON payloads carry `{omitted:'see image block'}`."
This keeps tool-result text small, prevents accidental log/terminal leaks
of screen contents, and keeps image attachments on the path Lattice already
uses for vision-input reattachment.

## Action set and the semantic vs. focusable split

The protocol defines eleven `Action` shapes. Every action has a `type`
discriminator; `ACTION_TYPES` enumerates them and `ACTION_METADATA` is the
canonical capability map mirrored into the MCP tool descriptions so model
capability discovery is honest.

The split is the heart of the cooperative contract:

- **Semantic** actions talk to the AX tree directly. They have an effect
  without requiring the target window to be in the foreground.
- **Focusable** actions either move the physical pointer or inject input
  that only takes effect when the target is focused.

In `background_assist` (the default), `requiresFocus()` returns `true` for
any focusable action and the controller answers `needs_focus` rather than
ever escalating to `takeover`. `takeover` allows everything because the
user has explicitly opted in. Unknown action types fail closed: they are
treated as focusable.

### Action metadata table

This is the canonical mapping. Implementers should treat `ACTION_METADATA`
as the source of truth, not this table.

| Action type | semantic | focusable | Notes |
|---|---|---|---|
| `click` | false | true | Physical pointer click at window-relative `(x, y)`. |
| `click_element` | true | false | AX press of a target node by pre-order index. Background-assist safe. |
| `drag` | false | true | Physical pointer drag between two window-relative points. |
| `type_text` | false | true | Injects typed text into the focused text field. |
| `press_key` | false | true | Injects a single key press. |
| `scroll` | false | true | Scrolls the target window. |
| `set_value` | true | false | Sets an AX value directly (fields, sliders). Background-assist safe. |
| `paste` | true | false | Pastes text through the AX value path — no global clipboard, no key injection. |
| `select_text` | true | false | Selects text via the AX tree. Background-assist safe. |
| `secondary_action` | true | false | Runs a named AX action (`AXRaise`, `AXConfirm`, `AXShowMenu`, …) on a target node. |
| `wait` | true | false | Pauses the action loop for `ms` milliseconds. No native side effect. |

The semantic set — `click_element`, `set_value`, `paste`, `select_text`,
`secondary_action`, `wait` — is the **default surface for `background_assist`**.
The focusable set — `click`, `drag`, `type_text`, `press_key`, `scroll` —
is what makes `needs_focus` and `takeover` meaningful.

## Structured action failures vs. transport-level errors

There are two distinct error surfaces, and confusing them is a common
implementer pitfall.

### Per-action failure — structured tool result, `isError: false`

`ActionFailureStatus` is the set of machine-readable failure values returned
inside a successful tool response (the response itself is not an error). It
is the contract by which the model loop understands "the action did not
run, and here's why."

```
stale | busy | lease_conflict | target_mismatch | out_of_policy
needs_focus | permission_required | user_intervened
source_unavailable | cancelled
```

A failed action returns `ActionFailResult { status, reason, detail? }`.
These are not exceptions; they are typed values. The success branch returns
`ActionOkResult { status:'ok', observation, lease?, provenance? }` —
always with a fresh observation, so the next decision is grounded.

The amendment names the same set, in user-facing language:
"ready, permission-required, stale, user-intervened, and source-unavailable."

### Transport-level failure — MCP error, `isError: true`

`CUError` is the envelope for transport-level problems: the call could not
even be routed to the action layer. These are returned as MCP errors with a
JSON body that conforms to `CUError`.

```
code:
  unknown_session | unknown_target | stale_generation | lease_conflict
  target_mismatch | out_of_policy | permission_required | focus_required
  source_unavailable | session_busy | cancelled
  version_unsupported | internal

recoverable: boolean   // true = re-observe, the same call can succeed
```

`unknown_session` and `version_unsupported` are unrecoverable transport
problems — there is no session, or the protocol version is not supported.
`stale_generation` and `lease_conflict` are recoverable: re-observe and try
again. The split exists because a stale rejection is a normal control-plane
signal ("you raced the user"), while an unknown session is a wiring problem.

## What an implementer must not do

- Do not invent fields. The JSON Schemas and `ACTION_METADATA` are the
  source of truth; the TS mirror follows them.
- Do not put screenshot base64 into tool text. Use the MCP image block.
- Do not silently escalate to `takeover` when an action fails in
  `background_assist`. The answer is `needs_focus`.
- Do not trust third-party UI text (titles, prompts, button labels) as
  permission. High-impact actions still require action-time approval.
- Do not replay an interrupted action on Resume. Re-observe.
- Do not let the PiP image or PiP body focus the target. Only
  `computer_focus` may do that.
- Do not bypass `generation`. Every action carries the generation it was
  decided on.