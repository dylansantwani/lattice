# Lattice implementation status

**Snapshot:** 2026-08-31  
**Audience:** Dylan and future contributors working in this repository  
**Product shape:** macOS-first Electron desktop control room for model runs

This document is the implementation ledger. It describes what the current source tree does, what is only partially implemented, and what remains from the product plan. `docs/product-plan.md` remains the desired product direction; this file is the source of truth for the current working tree.

## Status vocabulary

- **Implemented:** present in the source tree and covered by the current typecheck/build path.
- **Partial:** a useful vertical slice exists, but an important production or UX piece is missing.
- **Planned:** represented in the product direction or data model but not implemented end-to-end.
- **Known issue:** implemented behavior has a documented limitation or needs follow-up hardening.

## What works today

### Desktop shell

Implemented in `src/main/index.ts` and `src/renderer/src/App.tsx`:

- Electron `BrowserWindow` with hidden inset title bar, traffic-light positioning, minimum window size, and macOS lifecycle handling.
- Renderer isolation: context isolation on, Node integration off, typed preload bridge, and a renderer content-security policy.
- External HTTP(S) links open through the host shell; navigation away from the app origin is blocked.
- Development builds expose Chromium remote debugging on port `9223` for UI inspection.
- Three-pane shell: thread sidebar, transcript/composer center, and inspector rail.

### Persistence and event model

Implemented in `src/main/store/db.ts` and `src/main/store/eventStore.ts`:

- SQLite database in the Electron user-data directory, using WAL mode and normal synchronous settings.
- Tables for workspaces, threads, messages, append-only run events, settings, todos, memory, permission-rule storage, MCP configurations, and model cache.
- Default workspace creation with the user's home directory as its initial approved root.
- Thread creation, listing, selection metadata, updates, archive/delete support, pin state, model, effort, mode, and permission preset.
- Messages persist role, text, attachments, model/effort, terminal status, and telemetry.
- Run events persist sequence numbers, timestamps, agent IDs, and typed event bodies.
- Memory and todo CRUD exists; model cache is keyed by provider and has a ten-minute freshness window with stale-cache fallback.

### Provider and model registry

Implemented in `src/main/providers/openaiCompat.ts`, `src/main/providers/registry.ts`, and `src/main/ipc.ts`:

- OmniRoute is the default/current route, and one enabled OpenAI-compatible provider is selected for a run.
- First launch seeds an OmniRoute provider at `http://localhost:20128` and discovers a key from `OMNI_KEY` or `~/.local/bin/omni-cc`.
- `/v1/models` responses are normalized into model ID, friendly name, route/provider, context length, max output, and capability flags.
- Capability normalization reads common provider metadata for tools, vision, reasoning, and effort tiers.
- Model requests use SSE streaming with defensive parsing for text, reasoning, tool-call deltas, usage, cache fields, reasoning tokens, cost, and finish reasons.
- Provider failures classify into auth, rate-limit, context, unavailable, and generic error categories.
- Optional prompt caching (per-provider, on by default for the seeded OmniRoute and backfilled on existing installs) injects Anthropic-style `cache_control` breakpoints on the stable system + last-user prefix so the gateway serves a warm cache. Usage parsing (`mapUsage`) reconciles the two backend conventions — Anthropic reports `prompt_tokens` excluding freshly-written cache tokens, OpenAI-style folds cache reads into `prompt_tokens` and reports no write count — by adding the write count back so `tokensIn` is the true total input on every turn. The telemetry chip shows a real hit rate only when there are cache reads, a brass "primed" indicator on a cold cache-write turn, and nothing when the backend reports no cache activity (never a misleading constant "0% cached"). Caching only engages once the stable prefix crosses the model's minimum cacheable size (~1024 tokens), so short early turns legitimately show no cache chip.

### Run lifecycle

Implemented in `src/main/runtime/runManager.ts`:

- A thread has at most one active run in memory.
- User messages can start a run, steer at the next safe boundary, or queue a subsequent turn.
- Runs emit `run.started`, text/reasoning deltas, usage, errors, and `run.completed` events.
- Assistant text is flushed to the database in short batches while streaming.
- Runs support cancellation through `AbortController` and preserve interrupted output.
- New threads are auto-titled with a short model-written summary of the first exchange (`generateTitle`/`cleanTitle` in `runManager.ts`), falling back to the trimmed first user message if the summary call fails or no provider is configured. It runs once, after the first response, and never overwrites a title the user has since changed.
- Telemetry includes TTFT, wall time, model time approximation, tool time, output/input counts, reasoning/cache counts, cost, TPS, and an estimated flag when the provider lacks authoritative values.

### Tool runtime

The first execution slice and the interactive approval broker are now implemented.

Implemented in `src/main/tools/types.ts`, `src/main/tools/builtin.ts`, and `runManager.ts`:

- Typed tool definitions include JSON schema, resource, action, risk tier, plan-mode allowance, summaries, and an async runner.
- Built-ins: `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_mkdir`, `fs_move`, `fs_delete`, `shell`, `grep_search`, `todo_write`, `memory_save`, and `memory_search`.
- Tool-capable models receive the active tool schemas on each provider request.
- Streamed tool-call deltas are assembled by call index, parsed, emitted as typed events, executed, returned as `tool` messages, and followed by another model request.
- The loop has a twelve-round guard and supports multiple calls in a single response.
- Tool events include approval-shaped proposed/approved, started, denied, and result states and are visible in the run inspector and transcript activity rows. Interactive approval is implemented (see the approval broker below).
- Tool schema tokens are included in context-budget accounting.
- Per-tool policy is decided by `toolEffect(tool, meta)` → `allow` | `ask` | `deny` (`src/main/runtime/runManager.ts`). Review and Manual expose only read-only R0 tools (`allow`), everything else `deny`. **Auto (workspace)** allows R0 reads/searches and approved-root R1 filesystem writes (`fs_write`, `fs_edit`, `fs_mkdir`, `fs_move`), and **`ask`s** for the shell and destructive file ops (R2 — `shell`, `fs_delete`) and for every MCP tool: they are offered to the model but each call is gated behind a user approval prompt. **Full** `allow`s the complete built-in set with no prompt.
- Filesystem paths are validated as strings, canonicalized through existing parents, checked against approved roots, and opened with no-follow flags where file handles are used. Multi-path tools (`fs_move`) declare every path argument via `pathArgs` so each endpoint is containment-checked. `fs_move`/`fs_delete` refuse to act on a workspace root itself, and `fs_delete` removes symlinks without following them. Reads and edits are bounded to 256 KB.
- `grep_search` uses shell-free `execFile` arguments, avoiding interpolation of model-controlled patterns and paths into a shell command.
- `shell` runs against a **persistent PTY-backed login shell per thread** (`src/main/tools/ptyShell.ts`, using `node-pty`). Because it is an interactive login shell (`$SHELL -il`), it sources the user's profile, so the model gets the same PATH as Terminal — fixing the packaged-app failure where launchd's minimal PATH left `git`/`node`/Homebrew tools "not found". Working directory, exported variables, and shell state persist across calls. Each command is framed with a random sentinel (echo/prompt/bracketed-paste suppressed at init) to capture exactly one command's combined output, exit code, and resulting `$PWD`; timeouts and cancellation send Ctrl-C and keep the session reusable. Sessions idle-expire after 15 minutes and are killed on process exit. If `node-pty` can't load, it falls back to a one-shot `$SHELL -lc` (login) invocation so PATH is still correct, without cross-call state.

### Renderer experience

Implemented in `src/renderer/src/components/` and `src/renderer/src/theme/global.css`:

- Graphite, Midnight, Paper, and High-contrast themes with comfortable/compact/presentation density tokens.
- Sidebar thread search, pinned/running indicators, new-session action, and system-environment shortcuts.
- Streaming-safe Markdown with GFM tables/task lists, fenced-code copy actions, sanitized links, and disabled raw HTML.
- Reasoning cards with visibility controls and fidelity badges.
- Tool activity rows for running, completed, blocked, and failed calls.
- Composer controls: permission preset and Plan/Act/Review both as integrated segmented controls, a model chip, an always-available Thinking (effort) selector, attachments placeholder, context orbit, execute/stop, a live "Working · Xm Ys" run timer, and a keyboard hint row (`↵` send/steer, `⌘↵` queue, `⇧↵` newline).
- Slash-command palette: typing `/` opens a keyboard-driven, grouped, filter-as-you-type command menu above the composer (arrows navigate, `↵` runs, `tab` completes, `esc` dismisses). Commands cover session (`/new`, `/clear`, `/compact`), orchestration (`/goal`, `/side`, `/btw`), mode (`/plan`, `/act`, `/review`), permissions (`/manual`, `/auto`, `/full`), model/effort (`/model`, `/think`), panels (`/context`, `/run`, `/tasks`, `/memory`, `/agents`, `/mcp`, `/settings`), thread ops (`/rename`, `/pin`, `/unpin`, `/archive`), and appearance (`/theme`). Argument commands (`/goal`, `/rename`, `/think`, `/theme`, …) complete to `/name ` and run on the typed argument; a transient toast confirms each action. Every command drives a real capability — none are placeholders.
- Persistent thread goal (`/goal`): a north-star is stored on the thread, injected into the system prompt every turn, and shown as a dismissible banner above the composer.
- Streaming assistant text is revealed a few characters per animation frame for a smooth flow (respecting `prefers-reduced-motion`), decoupled from the persistence flush cadence.
- Reasoning is kept out of the transcript entirely; the user selects thinking effort in the composer and inspects raw reasoning in the Run inspector tab.
- Context Orbit shows segmented occupancy and opens Context inspector details. The UI no longer renders approximation tildes beside context counts; the inspector states when counts are estimated.
- Model picker lists real (named) models grouped by family (Claude Opus/Sonnet/Haiku/Fable, OpenAI GPT/o-series, Luna, Gemini, Grok, DeepSeek, Qwen, Llama, Mistral, then provider-derived groups), with automatic routes collapsed into one trailing group; filters for All/Tool-capable/Vision and full search by name, id, provider, or family.
- Picker rows show friendly names first, route IDs second, current selection, context/output sizes, and tool/reasoning/vision badges.
- Inspector tabs exist for Context, Run, Tasks, Memory, and Agents. The Run tab surfaces the latest run's raw reasoning; the Agents tab shows real subagent runs (grouped by agent id) with an honest empty state and no manual "deploy" affordance (subagents are spawned by models, not by hand).
- Keyboard shortcuts: `⌘N`, `⌘M`, `⌘B`, `⌘I`, `⌘,`; Enter sends, Enter while running steers, and `⌘Enter` queues; `/` at the start of the composer opens the command palette.

### IPC surface

The contract in `src/shared/ipc.ts` and types in `src/shared/types.ts` are the single source of truth for the preload bridge. The current API covers workspaces, threads, messages/runs, model listing, settings, approvals, context budget, todos, memory, and MCP configuration CRUD/status placeholders.

## What is partial or not done

### Permission broker and approvals — implemented (interactive)

The approval broker is live (`src/main/runtime/approvals.ts`). When `toolEffect` returns `ask`, the run manager builds an `ApprovalRequest`, pushes `approval.request`, and parks the tool call on a promise until the user answers.

- `respondApproval()` / `pendingApprovals()` in `src/main/ipc.ts` are wired to the broker; the renderer surfaces prompts via `ApprovalBar.tsx` above the composer, with Approve/Deny and an once / this-run / this-chat scope selector.
- Grants for `run`/`thread` scope are remembered in-memory so a given tool is not re-asked within that scope; `once` is not remembered. Cancelling the run auto-denies any pending request.
- **Still to do:** durable `profile`-scope rules (saved `permission_rules` are stored in the schema but not yet evaluated — `profile` is currently treated as thread-wide and in-memory); broker precedence over saved rules; and a way to see/act on approvals for a non-active thread (they surface when that thread is selected).

### Tool runtime follow-up

- End-to-end real-provider tool-call testing is still needed; current automated UI smoke testing uses a mocked `window.lattice` bridge.
- Tool results are summarized in the UI, not yet expandable with full arguments/results.
- Todo updates made inside a run do not currently push a `todos.updated` event to refresh an already-mounted Tasks tab.
- Filesystem checks reduce symlink risk but are not a native `openat`-style atomic capability boundary; adversarial local filesystem races still need a dedicated hardening pass.
- `fs_read` is bounded for safety; large-file offset/line paging needs a streaming implementation rather than reading only the first bounded window.

### MCP manager — implemented (first slice)

`src/main/mcp/manager.ts` connects configured servers over stdio and Streamable HTTP using the MCP SDK, discovers their tools, and normalizes each into a `ToolDefinition` (`mcp__<server>__<tool>`). Servers connect on launch and reconnect when their config changes; status (connected/latency/tool count/error) is reported to the renderer, and Settings exposes add/enable-disable/remove selectors. MCP tools merge into the run's active set for the Auto and Full presets, honoring per-tool `deny` policy. Still to come: richer per-tool allow/ask policy in the UI, OAuth for HTTP servers, and folding MCP calls through the approval broker once it exists.

### Context and cache engine — planned

Current context accounting is a conservative character-based estimate. Manual `/compact` compaction is implemented (see Orchestration); the remaining pieces are provider/tokenizer-aware counts, exact usage replacement, *automatic* threshold-triggered compaction, locked-turn/checkpoint handling, stale tool-result pruning, cache hit/miss diagnostics, and separate queue/model/tool timing.

### Orchestration — partial

- **Side forks (`/side`, `/btw`) — implemented.** `forkThread` in `runManager.ts` creates a child thread that copies the parent's live (uncompacted) history as its starting context, links back to the exact parent thread/event it forked from (`parentThreadId`/`parentEventId`), inherits model/effort/mode/goal, and opens read-only (Manual preset) by default so a side exploration can't mutate anything. `/side <prompt>` and `/btw <prompt>` optionally seed the fork with a first message. Forked threads show a branch mark in the sidebar.
- **Context compaction (`/compact`) — implemented.** `compactThread` summarizes the thread's live history with the model, marks those messages `compacted` (kept in the transcript but dimmed and no longer sent in full), and inserts a single `system`-role summary that stands in for them. `buildWireMessages` sends the summary in place of the folded history, and the context-budget accounting drops accordingly, so occupancy visibly falls after compaction. A `compaction` event is written to the durable log; the run is refused if one is in progress.
- Still planned: subagent templates, a delegation tool with parent-ceiling enforcement, the agent tree, checkpoints, rewind, branch promotion, and provenance UI.

### Files, browser, and artifacts — planned

There is no approved-root file tree, diff/review surface, artifact preview, isolated browser tab, or PTY terminal inspector yet. `node-pty` is installed but not wired.

### Claude Code and Hermes compatibility — planned

No config import/export, lossy-mapping report, secret-reference migration, Claude Code Agent SDK/CLI lane, or Hermes ACP lane exists yet. Unknown permission events must fail closed when those bridges are built.

### Settings and provider management — partial

- Settings currently edits only the first provider even though the data model supports a provider list.
- API keys remain plaintext in SQLite for this prototype; OS keychain storage is planned.
- Provider selection is currently the first enabled provider rather than an explicit per-thread/provider route.
- No provider health/test button or model-registry refresh status is exposed.

### Distribution, scale, and quality — planned

- No committed automated unit/integration test suite exists yet.
- Transcript virtualization for very large event histories is not implemented.
- Crash/reconnect recovery, schema migrations, packaged signed `.app` distribution, and accessibility review remain.
- Native dependency externalization/rebuild rules need maintenance when new native/server dependencies are added.

## Known issues carried forward

- The left rail can occasionally start collapsed in development even though the default state is expanded; root cause is unknown and low priority.
- Steering resumes only at the end of a provider response; provider-level mid-stream injection is not implemented.
- The active run snapshots the tool schema set at start. Policy is rechecked before each tool call, but changing permissions mid-run can leave a stale schema visible to the model until the next provider request.
- Tool schemas are now sent whenever the current mode/preset permits them, independent of provider-reported capability metadata (which gateways frequently omit or misreport — the previous cause of tool calls silently not working). A model that genuinely cannot use tools simply never emits a call. The registry now also defaults the display `tools` capability to true when the gateway omits it.

## Slice status against the roadmap

| Slice | Status | Current reality |
|---|---|---|
| 1. Durable single-agent core | Implemented | Electron, SQLite, provider streaming, runs, Markdown, context, themes, settings, model registry. |
| 1.5. Stitch UI baseline | Implemented | Three-pane shell and baseline visual system are present. |
| 2. Tools and inspection | Partial | Built-in tools, execution loop, policy ceilings, interactive approval broker, tool activity UI, and context schema accounting are present; durable permission rules remain. |
| 3. MCP manager | Partial | stdio + Streamable HTTP clients connect, discover tools, report status, and feed the run's tool set; policy UI and broker integration remain. |
| 4. Context and cache engine | Planned | Conservative estimate only. |
| 5. Orchestration | Partial | Slash-command palette, `/side`·`/btw` history-copying forks, `/goal` persisted north-star, and `/compact` summarize-and-checkpoint are implemented; subagent templates, checkpoints, rewind, and promotion remain. |
| 6. Files/browser/artifacts inspectors | Planned | No inspectors wired. |
| 7. Claude Code/Hermes compatibility | Planned | No import or runtime lanes. |
| 8. Hardening | Planned | No packaging/recovery/virtualization/accessibility pass. |

## Verification evidence

The current working tree has been checked with:

```bash
pnpm typecheck
pnpm build
git diff --check
```

The renderer was also smoke-tested in a headless Chromium page with a mocked bridge during this implementation pass. That check verified the removed labels/markers, curated picker view, Tool-capable and All tabs, global model search, current-model presentation, and absence of renderer console errors other than an expected missing favicon request. The ad-hoc smoke script was session-local rather than committed; a real Electron + OmniRoute tool-call run and a committed integration harness remain explicit follow-ups.

## Where to start next

1. Add durable `profile`-scope permission rules and broker precedence over them (the interactive approval broker and renderer prompt now ship).
2. Add run-level integration tests with a deterministic fake OpenAI-compatible SSE provider, including multi-round tool calls, denied calls, cancellation, and policy changes.
3. Add `todos.updated`/memory update pushes and expandable tool-result details.
4. Replace character estimates with a tokenizer/usage adapter and build compaction/checkpoint behavior.
5. Start the MCP manager only after the broker contract is stable.

## Source map

| Area | Primary files |
|---|---|
| Electron lifecycle | `src/main/index.ts` |
| IPC implementation | `src/main/ipc.ts`, `src/shared/ipc.ts` |
| Preload bridge | `src/preload/index.ts`, `src/preload/index.d.ts` |
| Persistence | `src/main/store/db.ts`, `src/main/store/eventStore.ts` |
| Provider adapter/registry | `src/main/providers/openaiCompat.ts`, `src/main/providers/registry.ts` |
| Run/tool execution | `src/main/runtime/runManager.ts`, `src/main/tools/types.ts`, `src/main/tools/builtin.ts` |
| Shared domain model | `src/shared/types.ts` |
| Renderer state | `src/renderer/src/state/store.ts` |
| Renderer shell and controls | `src/renderer/src/App.tsx`, `src/renderer/src/components/` |
| Visual system | `src/renderer/src/theme/global.css`, `docs/design/UI-BASELINE.md` |
| Product direction | `docs/product-plan.md` |
| Slice tracking | `docs/ROADMAP.md` |
