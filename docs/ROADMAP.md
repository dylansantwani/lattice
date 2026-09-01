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
- [x] Approval flow: `approval.request` push → renderer ApprovalBar sheet (allow once / this run / this chat, deny) → `respondApproval` resolves the broker promise (`src/main/runtime/approvals.ts`, `src/renderer/src/components/ApprovalBar.tsx`); run canceled while waiting resolves as a deny
- [~] Permission broker: mode ceiling + preset defaults (manual/workspace/full) enforced, and grants are remembered per run/thread so the same tool isn't re-asked. Still pending: durable, cross-session saved rules (a real `permission_rules` layer + `saveRule`); `profile` scope is currently treated as thread-wide
- [x] Spine UI for tool events (compact activity rows with tool name/status/duration; full args/results remain pending)
- [~] Tasks inspector reads run checklist from `todo_write`; live `todos.updated` push from in-run tools is pending
- [~] Memory inspector shows proposed items with a "proposed" tag; explicit approve/reject actions in the UI are still pending

## Slice 3 — MCP manager

Local stdio + Streamable HTTP transports via `@modelcontextprotocol/sdk`; per-server enable/tool policy; discovered tools merged into the active tool set behind the broker; Tools inspector tab (health, schemas, recent calls). Settings CRUD already stubbed (`mcp_servers` table + IPC).

## Slice 4 — context & cache engine (partial)

- [x] Manual compaction (`/compact` → `compactThread`): summarizes live history into one persisted summary message, marks folded messages `compacted` (kept for the reader, dropped from the wire), emits a `compaction` event. Occupancy is computed per model and drives the Context ring.
- [ ] Automatic threshold trigger, checkpoint/rollback of a compaction, locked turns.
- [ ] Real per-model token estimation (currently chars/4) and stale tool-result pruning.
- [ ] Cache-metrics surfaces beyond the telemetry chip (miss reason in the Context inspector).

## Slice 5 — orchestration (plan Phase 3, partial)

- [x] `run_agent` delegation: spawns an isolated subagent that shares the run's tool access, streams its own tagged events, and returns its final answer; accepts an optional per-call `tools` allowlist (validated against the real set before spawning) and cannot spawn further subagents.
- [x] `/side` and `/btw` forks: `forkThread` seeds a child thread from the parent's history with `parentThreadId`/`parentEventId` recorded.
- [ ] Subagent templates; explicit parent-ceiling enforcement on delegated tool policy.
- [ ] Agents inspector tree; checkpoints/rewind (branch from event); promotion with provenance.

**Also landed (thread/run management, not previously tracked):** `/clear` (`clearThreadContent` + `cancelRunForThread`), and queue editing while a run is active — `dequeueMessage` / `editQueuedMessage`.

## Slice 6 — files/browser/artifacts inspectors

File tree over approved roots, diff review, artifact previews; WebContentsView isolated browser tab; PTY terminal (node-pty already installed/rebuilt).

## Slice 7 — Claude Code & Hermes compatibility

1. Config import/export: `CLAUDE.md`, `.claude/{rules,skills,commands,agents}`, `.mcp.json`, settings → Lattice equivalents with preview report, lossy-mapping flags, backups. Hermes `~/.hermes` memory/skills/config; secret refs without plaintext.
2. Runtime lanes: Claude Code via Agent SDK/CLI; Hermes via `hermes acp` (stdio) with capability handshake, event normalization, fail-closed unknown permission events. Single-writer rule: never co-mutate another agent's live databases.

## Slice 8 — hardening (plan Phase 4)

Transcript virtualization for 100k-event threads, crash/reconnect recovery, keychain-backed secrets, migrations, packaged .app build, accessibility pass.

## Slice 9 — inter-session messaging + shared memory

- [ ] Session-to-session messaging: sessions (local threads/agents) can address and send messages to each other; directory of live sessions, addressing by id/name, inbox delivery + notification, and reply routing back to the sender's context.
- [~] Shared memory backbone: hook the messaging + memory layer into Hermes (`~/.hermes` memory) and Claude Code memory (`.claude/`), so cross-session context and recalled facts flow through the same store rather than being siloed per session.
  - [x] **Read/import lane** (`src/main/memory/bridge.ts`): imports Claude Code memory (`~/.claude/CLAUDE.md`, project `CLAUDE.md`, `~/.claude/projects/<slug>/memory/*.md` frontmatter files) and Hermes memory (`~/.hermes/memories/{MEMORY.md,USER.md}`, `§`-delimited) into Lattice's store as `author:'import'` items with stable `mem:<store>:…` ids (idempotent upsert + prune of vanished items). Runs on launch and via the Memory inspector's **Sync** button; imported items carry a source badge and are reachable through on-demand memory recall (pinned items ride in the prompt; the rest via `memory_search`). `syncMemory` IPC returns a per-source report.
  - [ ] **Write-back lane**: export Lattice-authored (approved) memories into a Lattice-owned section of the external stores, respecting their lock files. Read-only for now — single-writer rule: never co-mutate another agent's live databases.

## Backlog — captured ideas

- [ ] **Usage/stats page**: a dedicated view of your own usage — tokens, cache hit-rate, cost, tok/s, requests over time, broken down by model/provider/thread. Rolls up the per-message telemetry already captured into session/lifetime aggregates.
- [ ] **Expose subagents in use**: when the model delegates via `run_agent`, surface which subagents are running/were used to the user (live in the transcript/Agents inspector, not just the final answer) — names, tool allowlist, and status per delegated agent.
- [ ] **Model health pings before selection**: when the user opens the model picker, ping each candidate model/provider (latency + reachability check) so the picker shows which models are live and responsive before one is selected.
- [ ] **Background tasks**: let a run keep executing when its thread isn't focused (and while other threads run), so long agentic work proceeds unattended — the core "long-running agentic work" thesis. Surface running-in-background state in the sidebar (the `running` thread flag already exists), a global "active runs" indicator, and an OS notification on completion/when a run parks on an approval or `ask_user`. Builds on the event-sourced run manager (runs are already independent per thread); needs run lifecycle decoupled from the focused-thread subscription, background push delivery to unfocused threads, and a place to review/cancel all active runs at once.

## Known issues

- `externalizeDepsPlugin` does not externalize under pnpm 11 — explicit `NATIVE_EXTERNALS` list in `electron.vite.config.ts`; add new native/server deps there.
- Left rail occasionally starts collapsed on dev launch (state defaults to expanded; toggle is ⌘B) — root cause not yet found, low priority.
- Renderer settings modal edits only the first provider; multi-provider UI pending.
- Steering currently re-sends after stream completion (safe boundary = end of response); provider-level mid-stream injection not implemented.
- The approval flow is live (ApprovalBar sheet + `respondApproval`), but grants are only remembered in-memory per run/thread — there is no durable, cross-session saved-rule layer yet, and `profile` scope is treated as thread-wide.
- Real-provider tool-loop integration tests are still pending; the current UI smoke test uses a mocked bridge.
- Tool schemas are selected from the model registry's `capabilities.tools` flag; missing or incorrect provider metadata can prevent tool schemas from being sent.
- Filesystem reads/edits are bounded to 256 KB and use no-follow handles, but a fully atomic `openat`-style containment boundary is still a hardening task.
