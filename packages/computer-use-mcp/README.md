# @lattice/computer-use-mcp

Standalone Computer Use MCP server. A stdio MCP (JSON-RPC 2.0) façade over
[`@lattice/computer-use-core`](../computer-use-core/README.md). It owns the
external contract — tool names, argument schemas, structured results, image
blocks — and translates every call into the canonical controller. It contains
**no policy of its own** and **no direct macOS logic**; all cooperative
arbitration lives in the core.

## Build & run

```bash
pnpm build          # tsc -p tsconfig.json
pnpm start          # node bin/computer-use-mcp.mjs
# or directly:
node bin/computer-use-mcp.mjs
```

The server speaks MCP over stdio; launch it from an MCP client (Claude Code,
Codex, Hermes) or any process that wants to drive it. See `.mcp.json` for the
canonical client registration shape.

## Environment

| Variable                 | Default | Purpose                                                                                                                                                |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LATTICE_CU_BACKEND`     | `fake`  | Backend selector. Today only `fake` is wired; the future native macOS socket backend will be selectable as `socket` (a signed Swift/AppKit helper).    |
| `LATTICE_CU_TEST_HOOKS`  | unset   | When set to `1`, registers the test-only `computer_test_inject` tool (Gate-1 e2e). **Omit in production.**                                          |

## Tools (9, production)

| Tool                       | One-liner                                                                                                          |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `computer_list_apps`       | List apps the native helper can target (canonical bundle ids). Read-only.                                          |
| `computer_start_session`   | Start a cooperative session scoped to one app (optionally one window); default mode is `background_assist`.        |
| `computer_get_app_state`   | Capture target app/window: screenshot + AX tree + flattened text + `generation`. Always re-observe before acting. |
| `computer_execute_action`  | Execute one semantic action under an action lease at the observed `generation`. Returns fresh observation on OK.   |
| `computer_pause`           | Revoke the lease and clear queued work. Session enters `paused`.                                                  |
| `computer_resume`          | Re-observe and re-arm a paused session. Never replays an interrupted action.                                      |
| `computer_focus`           | Explicitly foreground the target window. The only path that may focus the target.                                 |
| `computer_stop`            | End the session: tear down lease, stop capture, release target. Safe any time.                                    |
| `computer_health`          | Report server + native backend status, protocol version, backend kind, session counts.                              |

For how to drive these well — the observe→act→re-observe loop, semantic vs
focus-requiring actions, structured `status` recovery, and the cooperative
contract — read [`skills/computer-use/SKILL.md`](skills/computer-use/SKILL.md).

## Backends

The default backend is a **deterministic fake** (`@lattice/computer-use-core`'s
`createFakeBackend()`) — used for development, unit tests, and the Gate-1 e2e.
The native macOS socket backend (Accessibility + ScreenCaptureKit + CGEvent
input, signed Swift/AppKit helper) arrives in a later subagent; set
`LATTICE_CU_BACKEND=socket` when it lands. Today, only `fake` is accepted;
any other value makes the server refuse to start.
