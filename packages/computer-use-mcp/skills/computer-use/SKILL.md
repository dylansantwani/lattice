# computer-use — model skill

This skill teaches a model how to drive the `computer-use` MCP server
(`@lattice/computer-use-mcp`) safely and effectively on macOS. The server is a
stdio MCP façade over `@lattice/computer-use-core`; it owns the external
contract (tool names, argument schemas, structured results, image blocks) and
contains **no policy of its own**. All cooperative arbitration lives in the
core controller.

## Overview & the golden rule

**The user is always in control.** Computer-use is a cooperative feature, not an
autopilot. The model is a guest inside another app.

- `background_assist` is the **default** mode. It:
  - never moves the physical pointer,
  - never injects global keyboard input,
  - never steals focus,
  - prefers AX (accessibility) actions and value-setting that don't activate
    the target.
  - focus-requiring actions return `status: "needs_focus"` and are **never**
    auto-escalated to `shared_control` or `takeover`.
- `shared_control` is for when the user and agent may touch the same target
  app. User input always wins: any user event revokes the lease and pauses at
  the next safe boundary; **Resume** always re-observes and never replays.
- `takeover` is explicit opt-in only (e.g. workflows that genuinely require
  foreground CGEvent input). It is **never** an automatic fallback from
  background_assist. If a model thinks it needs takeover, it should tell the
  user, not promote itself.

If you're not sure which mode you're in: assume background_assist.

## The observe → decide → act → re-observe loop

Computer-use is a tight feedback loop. Every action must be grounded in a fresh
observation.

1. **Observe.** Call `computer_get_app_state` (or use the observation returned
   by `computer_start_session` / `computer_resume`). Read the
   accessibility tree, the flattened text, and the screenshot image block.
   Note the `generation` integer in the observation.
2. **Decide.** Pick one semantic action that fits the observation. Do not
   batch. Do not guess — if the tree doesn't show what you need, stop.
3. **Act.** Call `computer_execute_action` with:
   - `sessionId`
   - `generation` — the **exact** generation from the observation you just took
   - `action` — one of the 11 action types
   - `expectedTarget` (optional) — re-assert the target app/window to detect
     drift
4. **Re-observe.** The successful result carries a **fresh** observation with a
   new `generation`. Use it. Do not reuse the old one.

**Stale generations are rejected.** If your `generation` no longer matches the
current observation, the server returns `status: "stale"` with **no side
effect** and a fresh observation you can use. Never blind-retry. Never retry
in a tight loop. Re-observe, then act deliberately.

## Semantic vs focus-requiring actions

The 11 action types split cleanly into two groups. The mode you started in
determines which group works.

**Semantic (work in background_assist without focus):**
- `click_element(elementIndex[, button, clickCount])` — AX-press an element
- `set_value(elementIndex, value)` — write a value into an AX field
- `paste(text, format: "text"|"md"|"html")` — paste via the AX value path
- `select_text(elementIndex[, text|prefix|suffix, selectionType])` — AX text
  selection
- `secondary_action(elementIndex, action)` — named AX action (e.g. `AXRaise`,
  `AXConfirm`, `AXShowMenu`)
- `wait(ms)` — settle policy; no native side effect

**Focus-requiring (return `status: "needs_focus"` in background_assist):**
- `click(x, y[, button, clickCount])` — physical pointer click
- `drag(fromX, fromY, toX, toY)` — physical pointer drag
- `type_text(text)` — inject typed text into the focused field
- `press_key(key)` — inject a key press
- `scroll(direction[, pages, x, y])` — scroll the target window

In background_assist, **prefer the semantic group**. If you genuinely need a
focus-requiring action, surface `needs_focus` to the user and stop. Do not
loop. Do not escalate to `takeover` on your own.

## Structured failure statuses (read `status`, recover)

Per-action policy failures are returned as **structured JSON with
`isError: false`**. They are not tool errors. Read `status` and respond.

| `status`              | what it means                                                | how to recover                                                              |
| --------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `stale`               | Your `generation` no longer matches the current observation. | Re-observe, then act against the new generation.                            |
| `busy`                | Another action is in flight under the lease.                  | Wait, re-observe, retry.                                                    |
| `lease_conflict`      | The action lease was revoked (e.g. user event, focus change). | Re-observe, then `computer_resume` if the session paused, then act.         |
| `target_mismatch`     | `expectedTarget` (or observed target) doesn't match.         | Stop. Re-confirm the target app/window with the user before continuing.    |
| `out_of_policy`       | The action is disallowed by mode/policy.                      | Stop. Re-plan with a permitted semantic action.                             |
| `needs_focus`         | Focus-requiring action in background_assist.                  | Surface to user. Do **not** retry. Do **not** escalate to takeover.         |
| `permission_required` | macOS permission (Accessibility / Screen Recording) missing.  | Tell the user; suggest `computer_health` to diagnose.                      |
| `user_intervened`     | The user moved the pointer, changed focus, or resized the target. | Stop. `computer_resume` re-observes; never replay the interrupted action. |
| `source_unavailable`  | Capture / native helper is down or the window is gone.        | Stop the session (`computer_stop`) or pause and ask the user to recover.    |
| `cancelled`           | The action was cancelled (e.g. on pause/stop).                | Re-observe if the session is still alive; otherwise start a new session.    |

**Transport errors** are different — they arrive as real MCP errors
(`isError: true`) and include `code` values like `unknown_session`, `backend
down`, or `internal`. Treat those as actual failures: re-list sessions,
re-start, or stop.

## Pause / Resume / Focus / Stop

- **`computer_pause(sessionId)`** — revokes the lease and clears queued
  actions. The session enters a paused state. Use this when the user should
  take over or when work must be held safely.
- **`computer_resume(sessionId)`** — grants nothing until a fresh observation
  is taken. The returned observation is **fresh**: act against its generation.
  **Resume never replays** a previously interrupted action.
- **`computer_focus(sessionId)`** — the **only** way to bring the target
  window to the foreground. Use it only when the user (or an explicit
  workflow) wants the target brought to the front — e.g. before
  focus-requiring actions in `shared_control` / `takeover`. Clicking or
  dragging the PiP image must never focus the target; only this tool may.
- **`computer_stop(sessionId)`** — tears down the lease, stops capture,
  releases the target. Always call when the task finishes, when errors become
  unrecoverable, or when the user asks.

State names you will see in results include: `idle`, `observing`, `proposing`,
`needs_permission`, `needs_focus`, `executing`, `verifying`,
`user_has_control`, `paused`, `stale`, `source_unavailable`, `ended`.

## Screenshots arrive as a separate image block

Screenshots are **never** inlined as base64 in the tool text. In every JSON
payload the `screenshot` field is replaced by a small placeholder
(`{ mimeType, width, height, omitted: "see image block" }`); the actual PNG
travels as a separate MCP image content block. Render it in the user's UI;
don't try to read it back as text.

## Worked example: drive Calculator

Goal: open Calculator in background_assist, enter `12 * 34`, read the
display.

```
1. computer_list_apps
   → { apps: [{ id: "com.apple.calculator", displayName: "Calculator", isRunning: true }, ...] }

2. computer_start_session({ appId: "com.apple.calculator", mode: "background_assist" })
   → { sessionId: "cu_…", state: "observing", mode: "background_assist",
       generation: 1, observation: { …, axTree: {…}, text: "0" } }
   (screenshot arrives as a separate image block)

3. From the AX tree, find the element index for "1". Then:

   computer_execute_action({
     sessionId: "cu_…",
     generation: 1,
     action: { type: "click_element", elementIndex: <"1"> }
   })
   → { status: "ok", observation: { …, generation: 2, text: "1" } }

4. Click "2", "×", "3", "4", "=" — each one a separate
   `computer_execute_action` carrying the generation from the previous
   observation. After "=" the display text should read "408".

5. If any step returns { status: "stale", … }, do not retry — call
   `computer_get_app_state`, read the new generation, then continue.

6. computer_stop({ sessionId: "cu_…" })
   → { state: "ended" }
```

If you instead needed to type `42` into a text field that doesn't expose an AX
value, you'd use `set_value(elementIndex, "42")` (semantic, no focus
required), not `type_text("42")` (focus-requiring — would return
`needs_focus` in background_assist).
