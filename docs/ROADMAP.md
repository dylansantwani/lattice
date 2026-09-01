# Lattice build roadmap

Vertical slices mapped to `product-plan.md` phases. Each slice leaves the app working.

## ✅ Slice 1 — durable single-agent core (plan Phase 1)

Electron shell · SQLite event store · OmniRoute streaming adapter · dynamic model registry · run manager with cancel/steer/queue behavior + telemetry · Markdown transcript · Context Orbit + inspector · ordered model picker palette · themes · settings. Verified through the current typecheck/build/UI smoke path; a real-provider tool-loop test remains pending.

## ✅ Slice 1.5 — Stitch UI baseline adoption

Restyled the shell to the Stitch "omniagent desktop harness" mockup (`docs/design/stitch-baseline/`, analysis in `docs/design/UI-BASELINE.md`): three panes with per-pane headers, brand block + thread search + System Environment sidebar, assistant cards with hover actions + telemetry chips, thinking cards, Manual/Auto/Full permission segmented control, composer dock with model chip + context ring tooltip + Execute, subagent-card Agents tab, self-hosted Material Symbols. Verified in Graphite + Paper themes.

## Provider and subscription expansion — planned

- [ ] **Automatic Claude Code and Codex subscription connections**: detect the user's authenticated Claude Code and Codex subscription access, add eligible subscription-backed routes automatically, and show clear connection, entitlement, and health state without requiring manual API-key entry.
- [ ] **Explicit provider selection**: let the user choose OpenRouter—or any configured provider—from Settings and the model picker, pin that provider/route per thread, and avoid silently falling back to the first enabled provider when an explicit choice exists.
- [ ] **OpenRouter routing tools**: add transparent `cheapest`, `fastest`, and `best` selection modes/tools that use current pricing, latency/availability, model capability, and quality criteria; show the selected route and the reasoning behind the recommendation.
- [ ] **Native provider integrations**: add first-class OpenRouter support plus native adapters for a broad set of major providers (including Anthropic, OpenAI, Google, xAI, DeepSeek, Mistral, Cohere, Groq, Together, and Fireworks), preserving provider-specific authentication, model discovery, streaming, tool calling, reasoning/vision metadata, usage, cost, and health behavior. Keep generic OpenAI-compatible endpoints as a fallback.

## Run telemetry and cost controls — planned

- [ ] **Run-sidebar usage breakdown**: in the right-sidebar Run menu, show input tokens excluding cache, output tokens excluding cache, cached input tokens, reasoning tokens, tool-call count, and estimated cost, with clear labels and per-turn/total views.
- [ ] **Editable cost model**: let users edit input, cached-input, output, and reasoning price values—preferably with provider/model overrides—so estimated cost reflects their actual billing rates while preserving the underlying token counts.

## Interaction, prompting, and model-picker polish — planned

- [x] **Steer-on-typing action**: while a run is active the composer's action stays STOP (cancel) when empty and becomes a brass STEER as soon as a draft is typed — clicking it (or ↵) injects the draft through the steer path at the next safe boundary instead of killing the run; ⌘↵ still queues. Labels are accessible (`aria-label` on each state) and the keyboard path already mapped running→steer (`Composer.tsx`, `.execute-btn.steer` in `global.css`).
- [x] **Context-hover cleanup**: dropped the bottom explanatory paragraph from the Context hover card; the reserved-for-reply space is now a compact labeled row in the breakdown (`ContextOrbit.tsx`).
- [x] **Slash-command repair**: added `/system` (aliases `/instructions`, `/sys`) — sets `settings.customInstructions`, the standing instructions `buildWireMessages` appends to the system prompt every turn; blank clears. Added `/goals` as an alias of `/goal`. Argument parsing/persistence/execution already run through the shared `expectsArg`/`runSlash` path, so all three behave consistently; covered by `commands.test.ts` (`commands.ts`).
- [x] **More autonomous system prompt**: the base/subagent prompts already carry the `AGENTIC_EXECUTION_PROTOCOL` (define outcomes/acceptance checks, inspect before acting, recover with a changed strategy after every tool result, verify each deliverable, run a completion audit) plus completeness ethos, live-plan `todo_write` discipline, and `ask_user` guidance. Added the missing piece — an explicit **interjection/steering** contract: a new user message mid-task is a course correction to fold in (newer message wins, keep verified work), not a signal to restart or ignore (`SYSTEM_PROMPT` in `runManager.ts`).
- [x] **Reliable steering**: a mid-run steer now splits the assistant turn — the current bubble is finalized at its pre-steer text and a fresh bubble opens for the continuation (`splitAssistantSegment` in `runManager.ts`), so the injected instruction sits chronologically between reply and continuation instead of being answered by a bubble timestamped before it (the "silently converted into the wrong turn" bug). Steers still inject only at safe response boundaries (end of a model response, never between tool_calls and their results); a steer during post-run cleanup queues as the next turn; and pending steers are requeued as turns (never dropped) on cancellation/error. Empty pre-steer segments are removed rather than left as blank bubbles. Covered by a stream-gated unit test in `runManager.test.ts` that asserts the prompt→reply→steer→continuation ordering.
- [x] **Recent/most-used models at the top**: the model chooser's top strip now leads with recently-used models and falls back to most-used to fill the row (recency primary, usage fallback), with the label reflecting which signals are in play (`ModelPicker.tsx`).
- [x] **Model-picker layout cleanup**: aligned the filters row to the shared 16px left edge, added keyboard scroll-into-view so arrow navigation keeps the selected row visible, and relaxed the fixed badge/meta columns on narrow windows to stop row overflow (`ModelPicker.tsx`, `global.css`).
- [ ] **Run-state notifications**: notify in-app and through the desktop OS when a model pauses for user input or approval and when a task finishes, with click-through to the thread, deduplication, and user controls.
- [x] **Adaptive Thinking control**: the composer's Thinking selector now sizes to the selected label — a visible label span drives the width while the native `<select>` is overlaid transparently for interaction/accessibility — so "Extra high" gets room and "High" leaves no dead space (`Composer.tsx`, `global.css`).
- [x] **Model-switch context warning**: changing models mid-chat now parks the switch (`store.pendingModelSwitch`) and opens a confirmation dialog (`ModelSwitchWarning.tsx`) showing the from→to models, the context tokens that will be re-inserted, the new model's context window (with an over-window warning), and the estimated cost to re-read the context once on a priced route. Confirm applies it (fresh recents/usage + `updateThread`); cancel/Escape/leaving the thread discards it. Empty threads and same-model re-selection skip the dialog. Decision logic is pure and unit-tested (`state/modelSwitch.ts`).
- [x] **Compact model quick picker**: clicking the composer model chip opens a small dropdown (`ModelQuickPicker.tsx`) — the current model pinned first, then a few recent/most-used routes (shared `modelOrder` blend), plus a **More models…** row opening the full picker. Selecting routes through `store.setModel` so a mid-chat pick still raises the context warning; click-outside/Escape close it; ⌘M still opens the full picker directly.

## 🔨 Slice 2 — tool runtime + permission broker (plan Phase 2, partial)

- [x] Typed tool definitions with resource/action/risk-tier metadata (`src/main/tools/types.ts`)
- [x] Built-in tools: fs_read, fs_write, fs_edit, fs_list, fs_mkdir, fs_move, fs_delete, shell, grep_search, todo_write, memory_save, memory_search, run_agent, ask_user (`src/main/tools/builtin.ts`)
- [x] `ask_user` tool: model parks the run on an ask broker (`src/main/runtime/asks.ts`) to put a text/choice/confirm question to the user; renderer answers via the AskBar dock; answer returns as the tool result and the Q&A is recorded in the transcript. Always available (ungated) across every mode/preset; stripped from headless subagents.
- [x] Tool loop in runManager: accumulate tool_call deltas → policy-check → execute → tool.result event → continue loop; in-run wire history kept in memory
- [x] Runtime policy ceiling: Review/Manual read-only R0, Workspace approved-root R1 filesystem, Full all built-ins; path strings and canonical roots validated
- [x] Approval flow: `approval.request` push → renderer ApprovalBar sheet (allow once / this run / this chat, deny) → `respondApproval` resolves the broker promise (`src/main/runtime/approvals.ts`, `src/renderer/src/components/ApprovalBar.tsx`); run canceled while waiting resolves as a deny
- [~] Permission broker: mode ceiling + preset defaults (manual/workspace/full) enforced, and grants are remembered per run/thread so the same tool isn't re-asked. Still pending: durable, cross-session saved rules (a real `permission_rules` layer + `saveRule`); `profile` scope is currently treated as thread-wide
- [x] Spine UI for tool events (compact activity rows with tool name/status/duration; full args/results remain pending)
- [x] Tasks inspector reads run checklist from `todo_write`; in-run tools push `todos.updated` so a mounted Tasks tab refreshes live
- [x] Memory inspector shows proposed items with a "proposed" tag and provides explicit approve/reject actions; approved memories sync outward

## Slice 3 — MCP manager (partial)

- [x] Local stdio + Streamable HTTP transports via `@modelcontextprotocol/sdk`; configured servers connect, reconnect, discover tools, and report status
- [x] Discovered tools merge into the active tool set behind the runtime policy ceiling and interactive approval broker; Settings CRUD and enable/disable controls are present
- [ ] **Automatic MCP discovery/import**: scan the computer for common MCP configuration locations and import server definitions from other harnesses, with preview, deduplication, secret-reference preservation, and explicit enable/approval before a discovered server runs
- [ ] Richer per-tool allow/ask/deny policy in the UI
- [ ] OAuth and other authenticated HTTP-server flows
- [ ] Tools inspector tab with health, schemas, and recent calls

## Slice 4 — context & cache engine (partial)

- [x] Manual compaction (`/compact` → `compactThread`): summarizes live history into one persisted summary message, marks folded messages `compacted` (kept for the reader, dropped from the wire), emits a `compaction` event. Occupancy is computed per model and drives the Context ring.
- [ ] Automatic threshold trigger, checkpoint/rollback of a compaction, locked turns.
- [ ] Real per-model token estimation (currently chars/4) and stale tool-result pruning.
- [ ] Cache-metrics surfaces beyond the telemetry chip (miss reason in the Context inspector).

## Slice 5 — orchestration (plan Phase 3, partial)

- [x] `run_agent` delegation: spawns an isolated subagent that shares the run's tool access, streams its own tagged events, and returns its final answer; accepts an optional per-call `tools` allowlist (validated against the real set before spawning) and cannot spawn further subagents.
- [x] **Background / async subagents**: `run_agent` gains `background: true` — it starts the subagent concurrently and returns a handle (`agentId` + `name`) immediately instead of blocking, so the main agent can keep working, or park on `ask_user` to hand control back to the person, while it runs. A new `agent_result` tool waits for (or, with `wait:false`, polls) the background agents and returns their results; spawn several to run independent work in parallel and collect them together. Each background agent is tracked on `ActiveRun.bgAgents` and awaited before the run finalizes, so none ever outlives its run; they share the parent abort, so cancel winds them down. `agent_result` mirrors `run_agent`'s policy profile (both withheld outside workspace/full), and both plus `set_thread_title` are stripped from subagents. Covered by `builtin.test.ts` + `toolDelivery.test.ts` (`builtin.ts`, `runManager.ts`, `tools/types.ts`).
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

- [ ] Transcript virtualization for 100k-event threads.
- [ ] Crash/reconnect recovery, keychain-backed secrets, schema migrations, packaged signed `.app` build, and accessibility pass.
- [ ] **Windows support**: Windows-compatible filesystem/path handling, shell and process behavior, secrets/keychain integration, notifications, installer/package, CI, and end-to-end platform QA.

## Slice 9 — inter-session messaging + shared memory

- [x] **Session-to-session messaging** (`src/main/runtime/sessionMessaging.ts`, `src/main/tools/sessionTools.ts`): a session (thread) can address and message another. Directory + addressing by id or (exact/prefix) title via `list_sessions`; `send_message` delivers **live** (steer-injected into the recipient's active run at its next safe boundary) when the target is running, else to its **inbox** (persisted, no surprise transcript bubbles); `check_inbox` drains queued messages oldest-first. Reply routing rides the ordinary `send_message` — inbound text names the sender id, and `reply_to` links the thread. The broker is a leaf module wired via callbacks (like the ask/approval brokers), so it needs no run-manager edits and adds no import cycle. Tools are policy-gated (`external_action`: `list_sessions`/`check_inbox` R0 reads, `send_message` R1 submit — ask under Auto, allow under Full) and auto-listed in the model's tool inventory with a capability note. Renderer: an `Inbox` panel (directory + compose + per-session inbox) behind a header button with an unread badge (`session.message` push → `sessionUnread`); the recipient thread also gets the finished-run green dot. Covered by `sessionMessaging.test.ts` + `sessionTools.test.ts` (25 tests).
- [~] Shared memory backbone: hook the messaging + memory layer into Hermes (`~/.hermes` memory) and Claude Code memory (`.claude/`), so cross-session context and recalled facts flow through the same store rather than being siloed per session.
  - [x] **Read/import lane** (`src/main/memory/bridge.ts`): imports Claude Code memory (`~/.claude/CLAUDE.md`, project `CLAUDE.md`, `~/.claude/projects/<slug>/memory/*.md` frontmatter files) and Hermes memory (`~/.hermes/memories/{MEMORY.md,USER.md}`, `§`-delimited) into Lattice's store as `author:'import'` items with stable `mem:<store>:…` ids (idempotent upsert + prune of vanished items). Runs on launch and via the Memory inspector's **Sync** button; imported items carry a source badge and are reachable through on-demand memory recall (pinned items ride in the prompt; the rest via `memory_search`). `syncMemory` IPC returns a per-source report.
  - [x] **Write-back lane**: export Lattice-authored (approved) memories into Lattice-owned sections of the external stores, respecting their lock files. The bridge preserves external content and never co-mutates another agent's live database.

## Backlog — captured ideas

- [ ] **Usage/stats page**: a dedicated view of your own usage — tokens, cache hit-rate, cost, tok/s, requests over time, broken down by model/provider/thread. Rolls up the per-message telemetry already captured into session/lifetime aggregates.
- [ ] **Expose subagents in use**: when the model delegates via `run_agent`, surface which subagents are running/were used to the user (live in the transcript/Agents inspector, not just the final answer) — names, tool allowlist, and status per delegated agent.
- [ ] **Model health pings before selection**: when the user opens the model picker, ping each candidate model/provider (latency + reachability check) so the picker shows which models are live and responsive before one is selected.
- [~] **Background tasks**: two halves — (a) freeing the model from a long task, and (b) freeing a run from the focused thread.
  - [x] **Background jobs — free the model from a long task (a download, a build, a big test run)** (`src/main/tools/bgJobs.ts`): `shell` gains `background: true`, which starts the command as its OWN detached child process (login `$SHELL -lc` for the real PATH — not the thread's serialized interactive PTY, not tied to the run's abort) and returns a `jobId` immediately instead of blocking. The job keeps running after the turn ends, so the model is freed to do other work or hand control back to the user with `ask_user`. A new `job_status` tool (R0 read — always available) waits for or polls the jobs and returns status/exit code/output (with an optional `tail`); `stop_job` (R0 execute, gated like run_agent) SIGTERMs them. Output is captured to a 200 KB cap; per-thread job count is capped (oldest finished pruned). Jobs are killed on thread delete (`ipc.deleteThread → killThreadJobs`) and app quit (`index before-quit → killAllBgJobs`); a run-cancel signal ends a `job_status` *wait* early without killing the job. `job_status`/`stop_job` are stripped from subagents and never delegatable. The pattern is documented to the model in the tool-inventory prompt. Covered by `bgJobs.test.ts` (real-process integration) + `builtin.test.ts`.
  - [ ] **Unfocused-thread runs** (the other half): let a run keep executing when its thread isn't focused, with running-in-background state in the sidebar, a global "active runs" indicator, an OS notification on completion / approval / `ask_user` pause, and a place to review/cancel all active runs. Needs run lifecycle decoupled from the focused-thread subscription and background push delivery to unfocused threads.
- [x] **Show the model drafting a tool call**: the tool row now appears *while the call is still streaming in*, not only after the whole stream lands. The moment the model names the tool, the runtime freezes that call's id and emits a `tool.drafting` event (`runManager.ts`, main + subagent loops); the timeline folds it into a `requested` row, and the eventual `tool.proposed`/`tool.started`/`tool.result` reuse the same id so all phases stay a single row. That row renders the brass "preparing…" state — a pulsing `more_horiz` glyph and a shimmering ellipsis (`Transcript.tsx` `ToolRow`, `.tool-activity-row.drafting` + `soft-pulse` keyframe in `global.css`), respecting `prefers-reduced-motion` — so the pre-submit phase reads as active thought during real streaming rather than flashing by post-stream. Also dropped the redundant grey inline args preview from each tool row (the args live in the expandable detail; the collapsed row stays clean). Covered by `runTimeline.test.ts` (drafting → proposal folds into one row) and `toolReplayE2E.test.ts` (a streamed call emits `tool.drafting` sharing the executed call's id).
- [ ] **Model image display**: allow models to show images in the conversation.
- [x] **Fix image input**: images returned by tool calls now reach vision models. `role:'tool'` messages carry text only, so a screenshot returned by a browser/computer-use/simulator MCP server was JSON-stringified into a base64 blob the model read as gibberish. `extractToolResultImages` pulls image content out of a tool result (MCP `{type:'image'}` blocks, image-bearing `{type:'resource'}` blobs, and raw `data:image/*` URLs), replacing it with a lightweight placeholder for the tool message; `appendToolResults` then re-attaches the images as a following `user` message — the one form every vision-capable OpenAI-compatible backend renders. Applied to both the main run and subagent loops (`runManager.ts`, `runManager.test.ts`, `toolResultImages.test.ts`).
- [ ] **Fix search UI**: improve the search interface and resolve its current usability issues.
- [ ] **Condense multiple tool calls**: group sequential tool calls into a compact view with a transition animation as the active call changes, plus a dropdown to inspect each individual call.
- [ ] **Investigate queue and chat termination**: diagnose suspected queue breakage and fix cases where some models do not end chats correctly.
- [x] **Improve chat naming and pinning**: added a `set_thread_title` builtin tool so the model can rename the chat mid-conversation when the topic clarifies or shifts — always allowed (special-cased in `toolEffect`, like `ask_user`), and its result pushes `thread.updated` so the sidebar/header update live (`builtin.ts`, `runManager.ts`). The capability is documented in the system prompt via the tool's own description, which `describeTools` inlines into the `# Your tools` block. Added an inline pin toggle to each sidebar row (`.thread-pin`) — always visible once pinned, revealed on hover otherwise — so pinning no longer needs the ⋮ menu (`Sidebar.tsx`, `global.css`). Covered by `builtin.test.ts` + `toolEffect.test.ts`.
- [ ] **Computer-use picture-in-picture**: add a picture-in-picture mode for computer-use sessions.
- [x] **Increase interface spacing**: roomier reading column and docks — transcript padding 24→30/32px, turn gap 14→20px, user-bubble padding/margin bumped, composer dock padding 10/24→12/32px and inner gap 8→10px, sidebar list gap 2→4px and thread-item padding 7→8px. Column width held at 860px so the composer and transcript stay aligned (`global.css`).

## Known issues

- `externalizeDepsPlugin` does not externalize under pnpm 11 — explicit `NATIVE_EXTERNALS` list in `electron.vite.config.ts`; add new native/server deps there.
- Left rail occasionally starts collapsed on dev launch (state defaults to expanded; toggle is ⌘B) — root cause not yet found, low priority.
- Renderer settings modal edits only the first provider; multi-provider UI pending.
- Steering currently re-sends after stream completion (safe boundary = end of response); provider-level mid-stream injection not implemented.
- The approval flow is live (ApprovalBar sheet + `respondApproval`), but grants are only remembered in-memory per run/thread — there is no durable, cross-session saved-rule layer yet, and `profile` scope is treated as thread-wide.
- Real-provider tool-loop integration tests are still pending; the current UI smoke test uses a mocked bridge.
- Tool schemas are selected from the model registry's `capabilities.tools` flag; missing or incorrect provider metadata can prevent tool schemas from being sent.
- Filesystem reads/edits are bounded to 256 KB and use no-follow handles, but a fully atomic `openat`-style containment boundary is still a hardening task.
