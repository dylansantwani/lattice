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

- Multiple OpenAI-compatible providers are supported: Settings → Providers manages a list (add/edit/remove, per-provider enable and prompt-caching toggles). The model picker aggregates models from every enabled provider (`fetchAllModels`, first provider wins on a duplicate id) and each request resolves to the provider whose cached model listing serves the thread's model (`providerForModel`), falling back to the first enabled one.
- First launch seeds an OmniRoute provider at `http://localhost:20128` and discovers a key from `OMNI_KEY` or `~/.local/bin/omni-cc`.
- `/v1/models` responses are normalized into model ID, friendly name, route/provider, context length, max output, and capability flags.
- Capability normalization reads common provider metadata for tools, vision, reasoning, and effort tiers.
- Model requests use SSE streaming with defensive parsing for text, reasoning, tool-call deltas, usage, cache fields, reasoning tokens, cost, and finish reasons.
- Provider failures classify into auth, rate-limit, context, unavailable, and generic error categories.
- Prompt caching (per-provider, on by default — `?? true` at the request sites, so configs saved before the toggle existed still cache) injects Anthropic-style `cache_control` breakpoints: one on the system block and up to two on the tail of the transcript — the last stampable message *whatever its role, tool results included* plus the one before it. Stamping the tail (rather than only the last user turn) is what keeps the hit rate high through agentic tool loops: each round's request caches the accumulated transcript so the next round reads it back instead of re-processing every tool result.
- **Byte-stable serialization** (the other half of the hit rate): when caching is on, EVERY message is normalized to parts form (`[{type:'text',text}]`), stamped or not. Without this, a message flaps between string and parts form as the moving tail markers pass over it, gateways hash the changed bytes, and the prefix match dies — measured live as 0% turn-over-turn on the Claude routes before the fix, 98–99% after. Verified against the real OmniRoute gateway by the opt-in live suite (`LATTICE_LIVE=1 npx vitest run src/main/providers/liveGateway.test.ts`): cc/claude-fable-5 hits 99% turn-over-turn and 85% on a tool-round tail; openrouter/meta/muse-spark-1.2-contributor reaches 96–97% once Meta's load-balanced replicas warm (per-turn variance there is upstream-side, not client-side). The same suite live-verifies on-demand memory recall (model calls `memory_search` for a memory-dependent question, skips it for arithmetic) and self-learning distillation (valid JSON learnings with sane types/scopes/confidence). Usage parsing (`mapUsage`) reconciles the two backend conventions — Anthropic reports `prompt_tokens` excluding freshly-written cache tokens, OpenAI-style folds cache reads into `prompt_tokens` and reports no write count — by adding the write count back so `tokensIn` is the true total input on every turn. The telemetry chip shows a real hit rate only when there are cache reads, a brass "primed" indicator on a cold cache-write turn, and nothing when the backend reports no cache activity (never a misleading constant "0% cached"). Caching only engages once the stable prefix crosses the model's minimum cacheable size (~1024 tokens), so short early turns legitimately show no cache chip.

### Run lifecycle

Implemented in `src/main/runtime/runManager.ts`:

- A thread has at most one active run in memory.
- User messages can start a run, steer at the next safe boundary, or queue a subsequent turn.
- Runs emit `run.started`, text/reasoning deltas, usage, errors, and `run.completed` events.
- Assistant text is flushed to the database in short batches while streaming.
- Runs support cancellation through `AbortController` and preserve interrupted output.
- New threads are auto-titled with a short model-written summary of the first exchange (`generateTitle`/`cleanTitle` in `runManager.ts`), falling back to the trimmed first user message if the summary call fails or no provider is configured. It runs once, after the first response, and never overwrites a title the user has since changed.
- Telemetry includes TTFT, wall time, model time approximation, tool time, output/input counts, reasoning/cache counts, cost, TPS, and an estimated flag when the provider lacks authoritative values.
- The base and subagent system prompts include an explicit execution contract: define outcomes and acceptance checks, inspect/discover capabilities, recover from failed or incomplete tool results with a changed strategy, independently verify deliverables, and audit every outcome before claiming completion. This improves model discipline; a normal text response is still terminal at the runtime layer, so automatic completion judging/retry remains a future controller feature.

### Tool runtime

The first execution slice and the interactive approval broker are now implemented.

Implemented in `src/main/tools/types.ts`, `src/main/tools/builtin.ts`, and `runManager.ts`:

- Typed tool definitions include JSON schema, resource, action, risk tier, plan-mode allowance, summaries, and an async runner.
- Built-ins: `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_mkdir`, `fs_move`, `fs_delete`, `shell`, `grep_search`, `todo_write`, `memory_save`, `memory_search`, `show_image`, `show_image_data`, and `fetch_image`.
- **Deferred tool discovery** (`src/main/runtime/toolCatalog.ts`). Only the builtin core (~2.5k tokens of schema) is always sent. MCP tools are deferred: their schemas do NOT ride in every request — with a few servers connected they otherwise add tens of thousands of tokens of standing context. Instead the model gets one `find_tools` tool (offered only when the mode/preset would let some deferred tool run) and discovers capabilities by keyword; matches are loaded per-thread, append-only, and join the tool array from the next round of the same run (the loop recomputes its tool list each round). The system-prompt inventory lists only the stable core plus a static "more tools are discoverable" note, so loading a tool costs one cache write in the tools section instead of invalidating the prompt every turn after. The loaded set is in-memory; after a restart the model simply re-discovers. Live-verified: asked for a browser screenshot with only the core exposed, the model calls `find_tools("browser screenshot page")`.
- Tool-capable models receive the active tool schemas on each provider request.
- Streamed tool-call deltas are assembled by call index, parsed, emitted as typed events, executed, returned as `tool` messages, and followed by another model request. As soon as a call's name streams in, a `tool.drafting` event surfaces it live (a "preparing" row) under the id the executed call will reuse, so the drafted and executed rows are one.
- The loop has a twelve-round guard and supports multiple calls in a single response.
- Tool events include approval-shaped proposed/approved, started, denied, and result states and are visible in the run inspector and transcript activity rows. Interactive approval is implemented (see the approval broker below).
- Tool schema tokens are included in context-budget accounting.
- Per-tool policy is decided by `toolEffect(tool, meta)` → `allow` | `ask` | `deny` (`src/main/runtime/runManager.ts`). Review and Manual expose only read-only R0 tools (`allow`), everything else `deny`. **Auto (workspace)** allows R0 reads/searches and approved-root R1 filesystem writes (`fs_write`, `fs_edit`, `fs_mkdir`, `fs_move`), and **`ask`s** for the shell and destructive file ops (R2 — `shell`, `fs_delete`) and for every MCP tool: they are offered to the model but each call is gated behind a user approval prompt. **Full** `allow`s the complete built-in set with no prompt.
- Filesystem paths are validated as strings, canonicalized through existing parents, checked against approved roots, and opened with no-follow flags where file handles are used. The path arguments to containment-check are resolved by `pathArgsFor`: an explicit `pathArgs` wins (multi-path tools such as `fs_move` declare `['from','to']` so each endpoint is checked), otherwise a filesystem tool is checked on `path` only when it actually declares a `path` parameter. This means store-backed tools that are tagged `filesystem` but take no path (`memory_save`, `memory_search`, `todo_write`) are no longer falsely rejected with "Invalid path … expected a string" (a bug that had blocked every memory/todo call). `fs_move`/`fs_delete` refuse to act on a workspace root itself, and `fs_delete` removes symlinks without following them. Reads and edits are bounded to 256 KB.
- `grep_search` uses shell-free `execFile` arguments, avoiding interpolation of model-controlled patterns and paths into a shell command.
- `shell` runs against a **persistent PTY-backed login shell per thread** (`src/main/tools/ptyShell.ts`, using `node-pty`). Because it is an interactive login shell (`$SHELL -il`), it sources the user's profile, so the model gets the same PATH as Terminal — fixing the packaged-app failure where launchd's minimal PATH left `git`/`node`/Homebrew tools "not found". Working directory, exported variables, and shell state persist across calls. Each command is framed with a random sentinel (echo/prompt/bracketed-paste suppressed at init) to capture exactly one command's combined output, exit code, and resulting `$PWD`; timeouts and cancellation send Ctrl-C and keep the session reusable. Sessions idle-expire after 15 minutes and are killed on process exit. If `node-pty` can't load, it falls back to a one-shot `$SHELL -lc` (login) invocation so PATH is still correct, without cross-call state.

### Memory: shared store, Claude Code / Hermes bridge, and self-learning

Implemented in `src/main/memory/bridge.ts`, `src/main/runtime/selfLearn.ts`, and the memory paths of `src/main/runtime/runManager.ts`, `src/main/ipc.ts`, and `src/renderer/src/components/Inspector.tsx`:

- **One shared memory across three agents.** The bridge imports the user's Claude Code memory (global `~/.claude/CLAUDE.md`, this project's `CLAUDE.md`, and the per-project files under `~/.claude/projects/<slug>/memory`) and Hermes memory (`~/.hermes/memories/{USER,MEMORY}.md`) into Lattice's store, and exports Lattice-authored approved memories back into both. Imports carry a stable `mem:<store>:…` id so re-syncing updates in place and prunes items that vanished upstream; a missing or malformed store degrades to "found 0" rather than throwing. Lattice's own write-back is sentinel/prefix-tagged in each external store so it is never re-imported (no loop). Sync runs on launch, on every memory approve/edit/delete, at each turn boundary (import only, so a run never mutates an external store mid-stream), and on demand from the Memory tab's Sync button, which reports per-source found/added/updated/removed/exported counts.
- **On-demand recall, pinned-only injection.** `buildWireMessages` no longer dumps the memory store into every prompt. The `# Memory` section (built by `memoryPromptSection`, gated by `includeMemory`) is a byte-stable recall instruction telling the model to call `memory_search` before answering anything that could depend on stored context, plus only the *pinned* approved, unexpired, in-scope memories inlined in stable id order (capped at 40 items / ~6000 chars via `selectMemoriesForPrompt`). This keeps the first message small and — because the section contains no counts, no recency ordering, and no unpinned content — the system prefix stays byte-identical across turns, so memory activity no longer busts the prompt cache. Everything unpinned is reachable through `memory_search` exactly when relevant.
- **Model-proposed memory.** The `memory_save` tool lets the model propose a durable item (`proposed`, reviewed in the Memory tab); `memory_search` is a full-text read over approved items.
- **Self-learning.** After a run completes (gated by the `selfLearning` setting, on by default), a reflection pass reads the finished exchange and distills 0–N durable, reusable memories (preferences, stable facts, decisions, environment notes, warnings) as strict JSON. Parsing tolerates a stray code fence or a line of preamble; each item is validated (type/scope enums, confidence clamped to 0..1, content capped) and de-duplicated against existing memory (normalized containment) so the same fact is not re-learned every turn. High-confidence (≥ 0.75), non-sensitive learnings are stored `approved` when `selfLearningAutoApprove` is on — so they inject and export to Claude Code + Hermes immediately; low-confidence or credential-shaped items are always held as `proposed` for review. The whole pass is best-effort and runs after `run.completed`, so it never delays the turn or surfaces as a run failure. When anything is stored it pushes `memory.updated` and reconciles the bridge, closing the loop: Lattice learns → the shared store grows → Claude Code and Hermes see it too.

### Renderer experience

Implemented in `src/renderer/src/components/` and `src/renderer/src/theme/global.css`:

- Graphite, Midnight, Paper, and High-contrast themes with comfortable/compact/presentation density tokens.
- Sidebar thread search, pinned/running indicators, new-session action, and system-environment shortcuts.
- Streaming-safe Markdown with GFM tables/task lists, fenced-code copy actions, sanitized links, and disabled raw HTML.
- Reasoning cards with visibility controls and fidelity badges.
- Tool activity rows for running, completed, blocked, and failed calls.
- Composer controls: permission preset and Plan/Act/Review both as integrated segmented controls, a model chip, an always-available Thinking (effort) selector, attachments placeholder, context orbit, execute/stop, a live "Working · Xm Ys" run timer, and a keyboard hint row (`↵` send/steer, `⌘↵` queue, `⇧↵` newline).
- Streaming assistant text is revealed a few characters per animation frame for a smooth flow (respecting `prefers-reduced-motion`), decoupled from the persistence flush cadence.
- Reasoning is kept out of the transcript entirely; the user selects thinking effort in the composer and inspects raw reasoning in the Run inspector tab.
- Context Orbit shows segmented occupancy and opens Context inspector details. The UI no longer renders approximation tildes beside context counts; the inspector states when counts are estimated.
- Model picker lists real (named) models grouped by family (Claude Opus/Sonnet/Haiku/Fable, OpenAI GPT/o-series, Luna, Gemini, Grok, DeepSeek, Qwen, Llama, Mistral, then provider-derived groups), with automatic routes collapsed into one trailing group; filters for All/Tool-capable/Vision and full search by name, id, provider, or family.
- Picker rows show friendly names first, route IDs second, current selection, context/output sizes, and tool/reasoning/vision badges.
- Inspector tabs exist for Context, Run, Tasks, Memory, and Agents. The Run tab surfaces the latest run's raw reasoning; the Agents tab shows real subagent runs (grouped by agent id) with an honest empty state and no manual "deploy" affordance (subagents are spawned by models, not by hand).
- Keyboard shortcuts: `⌘N`, `⌘M`, `⌘B`, `⌘I`, `⌘,`; Enter sends, Enter while running steers, and `⌘Enter` queues.

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
- Todo updates made inside a run push a `todos.updated` event and refresh an already-mounted Tasks tab.
- Filesystem checks reduce symlink risk but are not a native `openat`-style atomic capability boundary; adversarial local filesystem races still need a dedicated hardening pass.
- `fs_read` is bounded for safety; large-file offset/line paging needs a streaming implementation rather than reading only the first bounded window.

### MCP manager — partial

`src/main/mcp/manager.ts` connects configured servers over stdio and Streamable HTTP using the MCP SDK, discovers their tools, and normalizes each into a `ToolDefinition` (`mcp__<server>__<tool>`). Servers connect on launch and reconnect when their config changes; status (connected/latency/tool count/error) is reported to the renderer, and Settings exposes add/enable-disable/remove selectors. MCP tools merge into the run's active set and are approval-gated in the Workspace preset. Still to come: automatic discovery/import from local and other-harness configs, richer per-tool allow/ask policy in the UI, OAuth for HTTP servers, and a dedicated Tools inspector tab.

### Context and cache engine — partial

Context accounting now runs on a **real BPE tokenizer** (`src/main/runtime/tokenizer.ts`, backed by `gpt-tokenizer`), not the old chars/4 heuristic: `countTokens`/`estTokens` pick o200k_base for modern models and cl100k_base for legacy GPT-4/3.5, memoize by content, and hard-bound the worst case (oversized or degenerate repeated-char strings fall back to the ratio so budgeting can never hang). The budget, per-message `tokensOut` fallback, tool-schema sizing, and compaction sizing all count for real. **Stale tool-result pruning** also ships: `buildWireMessages` shrinks the result bodies (and images) of tool turns older than the recent keep-window to a byte-stable placeholder — reclaiming the largest, least-useful bulk in a long thread while keeping the recent working set and the assistant↔tool pairing intact — gated by the `pruneToolResults` setting and surfaced as `ContextBudget.prunedTokens` in the Context inspector. **Automatic threshold-triggered compaction** ships too: on send, once the context crosses `compactionThreshold`, `maybeAutoCompact` folds the history behind the just-sent turn into a summary (the current message is persisted first and preserved live), gated by the `autoCompact` setting; at `blockThreshold` the composer hard-stops a fresh turn with a banner and keeps the draft. Still planned: exact provider-usage replacement (`exact` stays false — tokenizer counts are estimates for non-OpenAI models), compaction checkpoint/rollback and locked turns, cache hit/miss diagnostics, and separate queue/model/tool timing.

### Orchestration — partial

`run_agent` delegation, isolated tagged subagent runs, `/side` and `/btw` forks, queue editing, and parent metadata are implemented. Still missing: subagent templates, explicit parent-ceiling enforcement, a richer Agents tree, checkpoints/rewind, branch promotion, and provenance UI.

### Inter-session messaging — implemented

Implemented in `src/main/runtime/sessionMessaging.ts`, `src/main/tools/sessionTools.ts`, and `src/renderer/src/components/Inbox.tsx`. A "session" is a thread; one session can address and message another.

- **Directory + addressing**: `list_sessions` returns the other non-archived threads (id, title, model, running, unread), most-recent first. A target is resolved by exact id, then exact title, then a unique title prefix; ambiguous/unknown/self targets return a self-correcting error.
- **Two delivery lanes**: when the recipient has an active run, `send_message` steer-injects the message at its next safe boundary (folding it into work in progress, and persisting a user turn in the recipient transcript); when the recipient is idle, the message lands in its inbox only — no bubbles are written into a thread the user isn't watching. `check_inbox` drains the unread queue oldest-first and marks it read.
- **Reply routing** rides the ordinary tool: inbound text names the sender's id and `reply_to` links the original, so a reply is just another `send_message` back to that id.
- **Architecture**: the broker is a leaf module wired through callbacks (`configureSessionMessaging({ push, isRunning, steer })`) exactly like the ask/approval brokers, so it never imports the run manager and adds no import cycle. Persistence is a `session_messages` table (`db.ts`).
- **Policy**: the tools are `external_action` — `list_sessions`/`check_inbox` are R0 reads (available in every mode/preset), `send_message` is an R1 `submit` (allowed under Full, approval-gated under Auto, denied under Manual/Review and Plan). All three are auto-listed in the model's `describeTools` inventory with a capability note.
- **Renderer**: an `Inbox` panel (per-session inbox + directory + compose, reachable from a header button) shows an unread badge driven by a `session.message` push into `store.sessionUnread`; a message to a non-active thread also raises that thread's finished-run indicator. Covered by `sessionMessaging.test.ts` + `sessionTools.test.ts`.

### Files, browser, and artifacts — implemented

Three inspector tabs ship (`src/renderer/src/components/{FilesTab,TerminalTab,BrowserTab}.tsx`):

- **Files**: a session-diff view (every file the agent created/edited/deleted this thread, folding before→after line diffs with +/− stats) plus a Browse view — a lazy file tree over the workspace's approved roots and a viewer that renders code, Markdown, and images. Changes are captured in the run loop (`captureFileDiff` in `runManager.ts`, before/after snapshots ≤256 KB, binary skipped) into a `file_changes` table that keeps the whole-session baseline; reads go through `fsTree`/`fsReadFile`/`fileChanges` (`src/main/files.ts`), all path-validated against the approved roots via `isPathInsideRoots`, with a `files.changed` push for live refresh.
- **Terminal**: a live interactive PTY (`src/main/ptyTerminal.ts`, node-pty — now wired, separate from the tool shell) streaming a real login shell to xterm.js, with fit-to-container sizing, restart-on-exit, and teardown on unmount/quit.
- **Browser**: an isolated embedded browser — a native `WebContentsView` in its own sandboxed session partition (`src/main/browserView.ts`) overlaid on the tab, with URL bar, back/forward/reload/stop, and zoom-scaled bounds re-synced on resize/scroll/zoom.

Artifact preview (rendering a produced HTML/asset artifact as a first-class object, beyond the file viewer's image/markdown rendering) remains the one unbuilt piece of this slice. The WebContentsView lifecycle is exercised only by a live app; everything else is unit/integration-tested.

### Claude Code and Hermes compatibility — partial

The **shared-memory bridge is implemented** (bidirectional import/export against Claude Code and Hermes memory, plus self-learning that feeds it — see "Memory" under "What works today"). Still planned for full compatibility: config import/export, a lossy-mapping report, secret-reference migration, a Claude Code Agent SDK/CLI runtime lane, and a Hermes ACP runtime lane. Unknown permission events must fail closed when those runtime bridges are built. Automatic Claude Code and Codex subscription connections are also planned so authenticated subscription access can be added without manual API-key setup.

### Settings and provider management — partial

The Settings modal (⌘,) is a tabbed control room over the full `AppSettings` model:

- **General** — new-thread defaults (model, effort, mode, permission preset) and the composer send-key (Enter vs ⌘/Ctrl+Enter). The default model opens the model picker, whose star sets it.
- **Model** — sampling temperature (off = model default), max output tokens (0 = provider default), standing "user instructions" appended to the system prompt every turn, the memory-recall toggle (pinned inline + memory_search for the rest), and the self-learning toggles (distill durable memories after each turn, and auto-approve confident learnings). Temperature/max-tokens are wired through `samplingParams()` into both the main and subagent stream requests; instructions/memory are wired through `buildWireMessages()`; self-learning is wired through `distillMemories()` in `selfLearn.ts`.
- **Conversation** — context-orbit compaction/block thresholds and the per-turn / per-subagent runaway-loop guards.
- **Appearance** — theme, density, reasoning visibility (expanded/auto/hidden, honored by the transcript's thinking cards), and the telemetry footer toggle.
- **Providers** — a multi-provider manager: list of configured endpoints with per-provider enable toggles, add/edit/remove forms (label, base URL, API key, prompt caching). Models from every enabled provider merge into one picker; requests route to the provider that serves the chosen model.
- **MCP servers** — add / enable-disable / remove, with live connection status.
- A **Reset defaults** action restores every preference to `DEFAULT_SETTINGS` while preserving configured providers and their keys.

Still partial:

- Settings currently edits only the first provider even though the data model supports a provider list.
- API keys remain plaintext in SQLite for this prototype; OS keychain storage is planned.
- Provider selection is currently the first enabled provider rather than an explicit per-thread/provider route; choosing OpenRouter explicitly is planned.
- No provider health/test button or model-registry refresh status is exposed.
- OpenRouter `cheapest`/`fastest`/`best` routing tools are still planned, along with transparent route explanations.
- Native provider integrations are still planned: OpenRouter first-class support plus provider-specific adapters for additional major model vendors; generic OpenAI-compatible endpoints remain the current path.

### Run telemetry and cost controls — partial

Per-message telemetry already records token, cache, reasoning, tool-time, and cost fields where the provider supplies them. **User-editable pricing now ships**: per-route cost overrides (`AppSettings.costOverrides`) let the user set their own input/cached-input/output/reasoning rates, priced through a shared cost engine (`src/shared/cost.ts`) whose priority is provider-reported cost → override (exact, no "~") → list price (estimated). Any estimated cost is click-to-edit (Run inspector tile, Usage page *By model* row, transcript cost chip → a `CostEditor` modal pre-filled from list price), with a Settings → Pricing tab to manage overrides; the mid-chat model-switch dialog honors overrides too. Still planned: a right-sidebar Run menu that visually separates uncached input, uncached output, cached input, reasoning tokens, and tool calls into a dedicated breakdown.

### Interaction, prompting, and model picker — partial

- The composer's live-run action switches between **Stop** (empty composer → cancel) and a brass **Steer** (draft typed → inject via the steer path at the next safe boundary); ⌘↵ still queues. Each state carries an `aria-label`.
- The Context Orbit hover card still includes the bottom reserved-space explanation; remove that paragraph while retaining the useful figures.
- The slash menu currently has `/goal` plus related commands, but `/system`, `/goals`, and their argument/persistence/execution behavior need a coherent repair.
- The base and subagent prompts now include an execution contract, but a more autonomous prompt/controller loop—continuing through verification and recovery instead of treating ordinary text as terminal—remains planned.
- Steering is persisted and queued at safe boundaries, but provider-boundary behavior, duplicate/lost drafts, cancellation, and post-run cleanup still need hardening.
- The model picker already has Recent chips and a Most used sort; the remaining polish is making recent/most-used models the consistently prioritized section at the top with a clear preference between the two.
- The model picker still needs a layout pass for centering, nested containers/divs, spacing, sizing, overflow, and responsive/keyboard behavior.
- There are no dedicated in-app/desktop notifications yet for an `ask_user`/approval pause or a completed task; notifications should link back to the relevant thread and avoid duplicates.
- The bottom Thinking selector should size dynamically to its current effort label, giving longer labels such as Extra high room without leaving excess width for shorter labels such as High.
- Switching models mid-chat now warns before applying: `store.setModel` parks a real mid-thread change and `ModelSwitchWarning.tsx` confirms it, showing the from→to models, the context tokens to be re-inserted, the target's context window (with an over-window flag), and the estimated one-time re-read cost on priced routes. Empty threads / same-model picks apply immediately; the pure decision + implication logic lives in `state/modelSwitch.ts` and is unit-tested.
- The composer model chip opens a compact quick-picker (`ModelQuickPicker.tsx`) — current model pinned, then recent/most-used (shared `modelOrder` blend) — with a **More models…** row leading to the full picker; ⌘M still opens the full picker directly.

### Distribution, scale, and quality — planned

- Unit and component tests are committed; a real-provider end-to-end integration harness is still missing.
- Transcript virtualization for very large event histories is not implemented.
- Crash/reconnect recovery, schema migrations, packaged signed `.app` distribution, and accessibility review remain.
- Windows support is not implemented yet; platform-specific filesystem, shell/process, secrets, notifications, packaging, CI, and QA work remain.
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
| 3. MCP manager | Partial | stdio + Streamable HTTP clients connect, discover tools, report status, and feed the run's tool set; richer policy UI, OAuth, and a Tools inspector remain. |
| 4. Context and cache engine | Partial | Manual + automatic threshold-triggered compaction, real tokenizer-based counting, stale tool-result pruning, and block-threshold enforcement ship; exact provider-usage replacement, checkpoints/rollback, and cache diagnostics remain. |
| 5. Orchestration | Partial | Delegation, forks, queue editing, and parent metadata ship; templates, ceiling enforcement, checkpoints, and provenance remain. |
| 6. Files/browser/artifacts inspectors | Partial | Files (tree + session diff + viewer), PTY terminal (xterm + node-pty), and an isolated WebContentsView browser all ship; first-class artifact preview remains. |
| 7. Claude Code/Hermes compatibility | Partial | Bidirectional shared-memory bridge + self-learning ship; config import and Agent-SDK/ACP runtime lanes remain. |
| 8. Hardening | Planned | No packaging/recovery/virtualization/accessibility pass. |
| 9. Inter-session messaging + shared memory | Partial | Session-to-session messaging (directory, live + inbox delivery, reply routing, tools, Inbox UI) and shared-memory import/export ship; cross-session memory unification via the messaging layer remains. |

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
3. Add expandable tool-result details and non-active-thread approval handling.
4. Tokenizer-based counting and stale tool-result pruning now ship; next in this slice is exact provider-usage replacement (calibrating the budget against authoritative `tokensIn`) plus threshold-triggered compaction and checkpoint/rollback behavior.
5. Complete MCP policy UI, OAuth, and the Tools inspector now that the broker contract is stable.
6. Add automatic Claude Code and Codex subscription connections.
7. Add explicit OpenRouter/provider selection plus `cheapest`/`fastest`/`best` routing tools.
8. Add native OpenRouter and broader provider adapters with provider-specific auth, capabilities, usage, and health checks.
9. Add Windows packaging and platform support.
10. Add the right-sidebar Run telemetry breakdown and editable cost model.
11. Add automatic MCP discovery/import from the computer and other agent harnesses.
12. Make the live-run Stop button become a yellow/brass Steer button when the composer has text.
13. Remove the bottom paragraph from the Context hover and repair `/system`, `/goal`/`/goals`, and related commands.
14. Strengthen the autonomous system prompt/controller and harden steering end to end.
15. Prioritize Recent/Most used models at the top of the model chooser.
16. Fix model-picker centering, div/container layout, spacing, sizing, and overflow.
17. Add in-app and desktop notifications for user-input pauses and completed tasks.
18. Make the Thinking selector width adapt to the selected effort label.
19. Warn and confirm before inserting the current chat context into a newly selected model.
20. Add a compact recent/most-used model dropdown with a **More models…** entry.

## Source map

| Area | Primary files |
|---|---|
| Electron lifecycle | `src/main/index.ts` |
| IPC implementation | `src/main/ipc.ts`, `src/shared/ipc.ts` |
| Preload bridge | `src/preload/index.ts`, `src/preload/index.d.ts` |
| Persistence | `src/main/store/db.ts`, `src/main/store/eventStore.ts` |
| Provider adapter/registry | `src/main/providers/openaiCompat.ts`, `src/main/providers/registry.ts` |
| Run/tool execution | `src/main/runtime/runManager.ts`, `src/main/tools/types.ts`, `src/main/tools/builtin.ts` |
| Memory bridge + self-learning | `src/main/memory/bridge.ts`, `src/main/runtime/selfLearn.ts` |
| Shared domain model | `src/shared/types.ts` |
| Renderer state | `src/renderer/src/state/store.ts` |
| Renderer shell and controls | `src/renderer/src/App.tsx`, `src/renderer/src/components/` |
| Visual system | `src/renderer/src/theme/global.css`, `docs/design/UI-BASELINE.md` |
| Product direction | `docs/product-plan.md` |
| Slice tracking | `docs/ROADMAP.md` |
