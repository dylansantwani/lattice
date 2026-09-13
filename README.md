# Lattice

A local-first desktop control room for long-running agentic work. Ordinary use feels like a chat app; reasoning, tool calls, context composition, caching, and diagnostics are one click away.

Built per the product plan in `docs/product-plan.md` (imported from the original brief). macOS-first, Electron + TypeScript + React, with the current provider route going through the local OmniRoute gateway.

For a complete implementation ledger—including what is partial, known risks, verification evidence, and the next build order—see [`docs/STATUS.md`](docs/STATUS.md).

## Status

**Working today** (v0.1 working tree; typechecked, production-built, and UI-smoke-tested):

- Electron shell (hiddenInset titlebar, CSP'd renderer, context-isolated CJS preload, typed IPC)
- SQLite (WAL) event store: workspaces, threads, messages, append-only run events, todos, memory, settings, model cache
- OpenAI-compatible streaming provider adapter (SSE via `eventsource-parser`) pointed at OmniRoute `:20128`; reads reasoning deltas, tool-call deltas, and usage (cache/reasoning token fields read defensively)
- Dynamic model registry from `/v1/models` — provider models normalized with capabilities (vision/tools/reasoning/effort tiers), context length, and max output; 10-min cache with stale fallback
- Run manager: streaming runs, cancel, steer/queue behavior, multi-round tool-call continuation, per-turn telemetry (TPS, TTFT, wall, model/tool time, tokens, cache %, cost when reported), typed error taxonomy with inline error cards
- Renderer: Graphite/Midnight/Paper/High-contrast theme tokens, thread sidebar with pin/running states, streaming-safe block-memoized Markdown renderer (GFM tables, task lists, fenced code with copy, sanitized links, raw HTML disabled), reasoning receipts with fidelity badges, telemetry footers
- Composer: model chip → quick picker (current, favorites, recents with source and health) and the full model browser (⌘M: source navigator, virtualized two-line list, detail pane with price/health/your usage/other routes/per-model defaults, one action per intent), effort tiers driven by model capabilities, Plan/Act/Review mode switch, Manual/Auto/Full permission segmented control, Context Orbit (segmented occupancy ring with hover breakdown tooltip → Context inspector)
- Inspector: Context / Run event log / Tasks / Memory / Agents tabs, plus compact tool-activity rows and live subagent cards in the transcript
- Shell design adapted from the Stitch "omniagent desktop harness" mockup — see `docs/design/UI-BASELINE.md` for the full inventory, token mapping, deliberate deviations, and gap list
- Keyboard: ⌘N new thread, ⌘M model picker, ⌘B rail, ⌘I inspector, ⌘, settings; Enter sends, Enter-while-running steers, ⌘Enter queues

**Implemented but still bounded by the pending approval broker** (`src/main/tools/`):

- Typed tool definitions (`types.ts`) and built-in tool set (`builtin.ts`): `fs_read`, `fs_write`, `fs_edit`, `fs_list`, `fs_mkdir`, `fs_move`, `fs_delete`, `shell`, `start_job`, `job_status`, `stop_job`, `grep_search`, `web_search`, `web_fetch`, `read_tool_result`, `search_tool_results`, `todo_write`, `memory_save`, `memory_search` — with per-tool resource/action/risk-tier metadata, policy ceilings, streamed call assembly, execution, results, and continuation

The runtime now includes the core MCP manager, subagents, context compaction, durable tool-result lookup, and background execution paths. Remaining work is tracked in [the agent improvement review](docs/agent-improvements-review.md) and includes the permission UI, saved permission-rule evaluation, exact tokenizer accounting, cache diagnostics, external runtime bridges, inspectors, work boards, packaging/recovery/accessibility, and broader integration coverage.

See `docs/ROADMAP.md` for the slice-by-slice plan mapped to the product plan's phases.

## Development

```bash
pnpm install
pnpm dev          # electron-vite dev (HMR renderer, auto-restart main)
pnpm typecheck    # tsc over node + web projects
pnpm build        # production build to out/
pnpm package      # installable Lattice.app + DMG in release/
```

`pnpm package` builds a real, Spotlight-launchable macOS app — see
[`docs/desktop-app.md`](docs/desktop-app.md) for install steps and why the bundle is ad-hoc signed.
Note that the packaged app and `pnpm dev` share a data directory and the bridge port, so run one at
a time.

### Terminal client

The same runtime is available from the terminal. Build the Node-ABI bundle with `pnpm build:cli`,
then run `node bin/lattice --help` or `pnpm cli --help`. `lattice` attaches to an open desktop or
`lattice serve` through the local control socket, and otherwise starts an embedded runtime; it uses
the same threads, events, tools, workspaces, and approval state as the GUI. See
[`docs/cli.md`](docs/cli.md) for session flags, print/JSON contracts, permissions, remote profiles,
and troubleshooting. The provider-free lifecycle smoke test is `pnpm test:e2e:cli`.

Native modules (`better-sqlite3`, `node-pty`) must match Electron's ABI:

```bash
npx electron-rebuild -f -o better-sqlite3,node-pty
```

### Provider setup

On first launch Lattice seeds an **OmniRoute** provider at `http://localhost:20128`, discovering the API key from `$OMNI_KEY` or `~/.local/bin/omni-cc`. Edit in **Settings (⌘,)**. Any OpenAI-compatible endpoint works — base URL + key.

### UI verification

Dev builds open Chromium remote debugging on port **9223** for real-app inspection. The current renderer smoke check serves `out/renderer` with a mocked `window.lattice` bridge and verifies the picker and shell without modifying the user's app database. See [`docs/STATUS.md`](docs/STATUS.md) for the exact coverage and remaining real-provider test work.

The real Electron window can be driven through the development CDP endpoint when a session-specific harness is available.

## Architecture

```text
React renderer (no Node, CSP, context isolation)
       │  typed IPC: invoke lattice:<method> / push lattice:push
Electron main
  ├── src/main/ipc.ts          LatticeApi implementation + push fan-out
  ├── src/main/store/          better-sqlite3 WAL; schema in db.ts
  ├── src/main/providers/      openaiCompat streaming adapter + model registry
  ├── src/main/runtime/        runManager: run lifecycle, telemetry, context budget
  └── src/main/tools/          typed tool defs + builtins + runtime policy boundary
src/shared/                    domain types + IPC contract (single source of truth)
src/preload/                   contextBridge: window.lattice
```

Everything crossing IPC or persisted lives in `src/shared/types.ts`. Runs are event-sourced: the transcript is a projection of the `events` table; text deltas are coalesced (~750 ms / 4 KB) so the log stays compact while remaining replayable.

## Key decisions

| Decision | Choice |
|---|---|
| Platform | macOS-first; Electron + TS + React |
| Audience | Personal daily driver, product-shaped code |
| Provider | OmniRoute is the default/current route; any configured OpenAI-compatible endpoint uses the same dynamic registry |
| Tool execution | Direct host (no container profile); built-in tool loop is wired |
| Permission model | Mode/preset ceilings; Review and Manual are read-only, Workspace allows approved-root R1 filesystem tools, Full enables all built-ins; approval broker pending |
| Compat | Claude Code + Hermes: config import/export **and** runtime lanes (Agent SDK / ACP) — planned |
| IDs | Local ULID impl (`src/shared/id.ts`) — the npm `ulid` package drags in electron's launcher when bundled |

## License

[MIT](LICENSE) © Dylan Santwani
