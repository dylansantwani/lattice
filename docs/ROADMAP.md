# Lattice build roadmap

Vertical slices mapped to `product-plan.md` phases. Each slice leaves the app working.

## ✅ Slice 1 — durable single-agent core (plan Phase 1)

Electron shell · SQLite event store · OmniRoute streaming adapter · dynamic model registry · run manager with cancel/steer/queue behavior + telemetry · Markdown transcript · Context Orbit + inspector · ordered model picker palette · themes · settings. Verified through the current typecheck/build/UI smoke path; a real-provider tool-loop test remains pending.

## ✅ Slice 1.5 — Stitch UI baseline adoption

Restyled the shell to the Stitch "omniagent desktop harness" mockup (`docs/design/stitch-baseline/`, analysis in `docs/design/UI-BASELINE.md`): three panes with per-pane headers, brand block + thread search + System Environment sidebar, assistant cards with hover actions + telemetry chips, thinking cards, Manual/Auto/Full permission segmented control, composer dock with model chip + context ring tooltip + Execute, subagent-card Agents tab, self-hosted Material Symbols. Verified in Graphite + Paper themes.

## 🔨 Slice 2 — tool runtime + permission broker (plan Phase 2, partial)

- [x] Typed tool definitions with resource/action/risk-tier metadata (`src/main/tools/types.ts`)
- [x] Built-in tools: fs_read, fs_write, fs_edit, fs_list, fs_mkdir, fs_move, fs_delete, shell, grep_search, todo_write, memory_save, memory_search, run_agent, ask_user (`src/main/tools/builtin.ts`)
- [x] `ask_user` tool: model parks the run on an ask broker (`src/main/runtime/asks.ts`) to put a text/choice/confirm question to the user; renderer answers via the AskBar dock; answer returns as the tool result and the Q&A is recorded in the transcript. Always available (ungated) across every mode/preset; stripped from headless subagents.
- [x] Tool loop in runManager: accumulate tool_call deltas → policy-check → execute → tool.result event → continue loop; in-run wire history kept in memory
- [x] Runtime policy ceiling: Review/Manual read-only R0, Workspace approved-root R1 filesystem, Full all built-ins; path strings and canonical roots validated
- [ ] Permission broker: mode ceiling → saved rules → preset defaults (manual/workspace/full); precedence per plan §"Mode and permission controls"
- [ ] Approval flow: `approval.request` push → renderer approval sheet (allow once / allow for run / deny, narrowest saveable rule) → `respondApproval` resolves broker promise
- [x] Spine UI for tool events (compact activity rows with tool name/status/duration; full args/results remain pending)
- [~] Tasks inspector reads run checklist from `todo_write`; live `todos.updated` push from in-run tools is pending
- [ ] Memory proposals review UI (approve/reject proposed items)

## Slice 3 — MCP manager

Local stdio + Streamable HTTP transports via `@modelcontextprotocol/sdk`; per-server enable/tool policy; discovered tools merged into the active tool set behind the broker; Tools inspector tab (health, schemas, recent calls). Settings CRUD already stubbed (`mcp_servers` table + IPC).

## Slice 4 — context & cache engine

Real per-model token estimation, compaction (threshold trigger, checkpoint summary event, locked turns, rollback), stale tool-result pruning; cache metrics surfaces (read/write tokens, hit rate, miss reason) in telemetry + Context inspector.

## Slice 5 — orchestration (plan Phase 3)

Subagent templates + `delegate` tool with parent-ceiling enforcement; Agents inspector tree; `/side` and `/btw` forks (thread parentThreadId/parentEventId already modeled); checkpoints/rewind (branch from event); promotion with provenance.

## Slice 6 — files/browser/artifacts inspectors

File tree over approved roots, diff review, artifact previews; WebContentsView isolated browser tab; PTY terminal (node-pty already installed/rebuilt).

## Slice 7 — Claude Code & Hermes compatibility

1. Config import/export: `CLAUDE.md`, `.claude/{rules,skills,commands,agents}`, `.mcp.json`, settings → Lattice equivalents with preview report, lossy-mapping flags, backups. Hermes `~/.hermes` memory/skills/config; secret refs without plaintext.
2. Runtime lanes: Claude Code via Agent SDK/CLI; Hermes via `hermes acp` (stdio) with capability handshake, event normalization, fail-closed unknown permission events. Single-writer rule: never co-mutate another agent's live databases.

## Slice 8 — hardening (plan Phase 4)

Transcript virtualization for 100k-event threads, crash/reconnect recovery, keychain-backed secrets, migrations, packaged .app build, accessibility pass.

## Slice 9 — inter-session messaging + shared memory

- [ ] Session-to-session messaging: sessions (local threads/agents) can address and send messages to each other; directory of live sessions, addressing by id/name, inbox delivery + notification, and reply routing back to the sender's context.
- [ ] Shared memory backbone: hook the messaging + memory layer into Hermes (`~/.hermes` memory) and Claude Code memory (`.claude/`), so cross-session context and recalled facts flow through the same store rather than being siloed per session. Builds on the Slice 7 config/memory import; single-writer rule still applies — never co-mutate another agent's live databases.

## Known issues

- `externalizeDepsPlugin` does not externalize under pnpm 11 — explicit `NATIVE_EXTERNALS` list in `electron.vite.config.ts`; add new native/server deps there.
- Left rail occasionally starts collapsed on dev launch (state defaults to expanded; toggle is ⌘B) — root cause not yet found, low priority.
- Renderer settings modal edits only the first provider; multi-provider UI pending.
- Steering currently re-sends after stream completion (safe boundary = end of response); provider-level mid-stream injection not implemented.
- The approval IPC methods are still stubs. Manual and Workspace currently restrict higher-risk tools instead of presenting an interactive approval sheet.
- Real-provider tool-loop integration tests are still pending; the current UI smoke test uses a mocked bridge.
- Tool schemas are selected from the model registry's `capabilities.tools` flag; missing or incorrect provider metadata can prevent tool schemas from being sent.
- Filesystem reads/edits are bounded to 256 KB and use no-follow handles, but a fully atomic `openat`-style containment boundary is still a hardening task.
