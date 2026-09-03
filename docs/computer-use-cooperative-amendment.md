# Computer Use recreation plan: cooperative-operation amendment

This is an amendment to the plan in Codex task `01a063da-9701-7903-85b0-dd15913a509f`, “Research Codex computer use.” It preserves the original native-service, accessibility-first, two-plane PiP architecture. The rules below are normative wherever they clarify or narrow the original plan.

## Verdict

Keep the original plan’s main decisions:

- a native macOS helper for Accessibility, ScreenCaptureKit, and input;
- a model-observation path separate from a continuously rendered PiP path;
- AX semantics before coordinate fallback;
- session-scoped generations and stale-state rejection;
- a Mac-first release with locked use excluded from v1;
- a separate OpenAI Responses adapter instead of leaking `computer_call` into OmniRoute.

The material gap was that “user intervention” was a safety check, not the product contract. Co-use is now the default behavior.

## Product contract: the user remains in control

### Background Assist — default

- Capture only the approved application/window.
- Do not move the physical pointer.
- Do not inject global keyboard input.
- Prefer AX actions and value-setting that do not activate or focus the target.
- If an action requires foreground focus or CGEvent input, stop and show **Needs focus**; do not silently escalate.
- Show a virtual agent cursor in PiP; it is never the user’s real pointer.

This mode is intended for working in another app while the agent operates a scoped target in the background.

### Shared Control

Use this when the user and agent may touch the same target app.

- User input always wins.
- A user keyboard/mouse event, target focus change, target-window change, or geometry change revokes the current action lease and invalidates pending actions.
- The controller pauses at the next safe boundary, preserves the user’s input, and requires **Resume** before another action can run.
- Resume always performs a fresh observation; it never replays an old action.
- Every action and interruption records provenance: `user`, `agent`, `system`, or `policy`.

### Explicit Takeover — opt-in only

This is reserved for workflows that genuinely require foreground CGEvent input. The UI must show a persistent takeover state and provide an always-visible Stop control. Takeover is never an automatic fallback from Background Assist.

The PiP image is not a focus target. Only an explicit **Focus** control may activate the target app. Clicking or dragging the PiP body must not focus the target or execute an action.

## MCP/plugin boundary

Package Computer Use as an independent local plugin, matching the installed product shape:

```text
computer-use/
  .codex-plugin/plugin.json
  .mcp.json
  bin/computer-use-mcp
  server/                 # MCP façade and policy boundary
  native/mac/             # signed Swift/AppKit helper
  skills/computer-use/SKILL.md
```

The MCP server owns the external contract and translates calls to the persistent native helper over a versioned local protocol. Lattice may use an in-process adapter to the same controller/core so it does not register a server-to-itself loop or duplicate policy. Direct MCP clients still receive the same fail-closed policy.

The initial tool surface is:

```text
computer_list_apps
computer_start_session(targetAppId, targetWindowId?, mode)
computer_get_app_state(sessionId)
computer_execute_action(sessionId, generation, action)
computer_pause(sessionId)
computer_resume(sessionId)
computer_focus(sessionId)       # explicit focus request only
computer_stop(sessionId)
```

Every stateful call carries `sessionId`, `targetAppId`, `targetWindowId`, and `generation`. Action execution also carries an action lease and expected target/window identity. The server rejects mismatched generations, revoked leases, changed targets, and actions outside policy. Results use structured content: compact JSON plus an MCP image block for screenshots; screenshots must not be embedded as giant base64 strings in tool text. Cancellation must stop queued work and propagate to the native helper.

## Cooperative state machine and UX

```text
idle → observing → proposing
                    ├─ needs permission → observing
                    ├─ needs focus      → user decision
                    └─ executing → verifying → observing

Any active state ── user event ──→ user has control → paused
Any active state ── stale/source unavailable ──→ recoverable stop
Any active state ── Stop ──→ ended
```

The PiP and thread transcript must expose these states, with the target app, mode, and reason:

- Observing
- Proposing
- Needs permission
- Needs focus
- Executing
- User has control
- Paused
- Stale
- Source unavailable
- Ended

Pause revokes the lease and clears queued actions. Resume creates a new lease only after a fresh AX/screenshot state. A stale or source-unavailable result is never silently retried.

## Revised build order

1. Define the MCP schema, session/generation/lease types, policy result envelope, and fake native backend.
2. Build arbitration first: user-event injection tests, focus/geometry invalidation, pause/resume/Stop, and provenance logging.
3. Add the Swift AX/ScreenCaptureKit helper and macOS permission checks.
4. Connect the provider-neutral tool loop and image reattachment path.
5. Add the Electron PiP MVP with virtual cursor, status states, Focus, Pause/Resume, Stop, and target scoping.
6. Replace the MVP frame path with native sample-buffer/Core Animation rendering only after co-use behavior passes.
7. Harden packaging, crash/reconnect recovery, Retina/multi-display mapping, accessibility, and interoperability.

Private Codex binary symbols may guide hypotheses during research, but they are not dependencies. Implement against public Apple APIs, the MCP protocol, and independently defined contracts.

## Co-use acceptance tests

- Background Assist produces no physical pointer movement and no global keyboard injection.
- An action addressed to an unapproved app or window is rejected, even if its display name matches.
- AX actions that can run without focus do not change the user’s active app.
- In Shared Control, user activity pauses the session before the next action; no pending action executes afterward.
- User input is preserved; Resume re-observes instead of replaying the interrupted action.
- An old generation or revoked lease always returns `stale` and performs no side effect.
- The PiP body never focuses the target; only the Focus control can do so.
- The PiP remains responsive while the model is thinking, stalled, or waiting for approval.
- High-impact actions remain human-approved and third-party UI text is never treated as permission.
- Lattice, Claude Code, and Hermes can start a session and invoke the same standalone MCP server.
- Native-helper crash, target-app closure, capture loss, and permission revocation produce visible recoverable states.

Current official product facts to keep in the main plan: macOS supports scoped background use; Windows Computer Use runs on the active desktop and cannot provide same-session alongside-user operation; high-impact actions remain human-in-the-loop. See the [OpenAI Computer Use guide](https://developers.openai.com/api/docs/guides/tools-computer-use) and [Codex Computer Use documentation](https://learn.chatgpt.com/docs/computer-use).

The detailed delegation breakdown is in [the subagent execution plan](</Users/dylan/lattice/docs/computer-use-subagent-plan.md>).

No Lattice product source code was changed for this amendment.
