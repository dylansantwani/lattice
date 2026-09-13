# Lattice contributor guide

Lattice is a macOS-first Electron + TypeScript agent control room. Keep the main process, renderer, preload bridge, shared types, and persisted event schema in sync.

## Source map

- `src/main/runtime/runManager.ts`: run lifecycle, tool loops, subagents, compaction, context budgeting.
- `src/main/tools/`: built-in tool definitions, argument validation, background jobs, persistent shells.
- `src/main/providers/`: OpenAI-compatible streaming and model registry.
- `src/main/store/`: SQLite schema, event store, messages, memories, todos, tool evidence.
- `src/shared/`: IPC and persisted domain types shared by main and renderer.
- `src/renderer/src/`: React UI and pure timeline/state reducers.
- `src/cli/`: terminal argument parsing, transports, print mode, commands, and ANSI renderer.
- `src/main/net/local.ts` and `src/main/runtimeLock.ts`: local control socket and single-writer lifecycle.
- `packages/computer-use-*`: separate computer-use protocol/core/MCP workspaces.

`docs/STATUS.md` describes the current implementation. `docs/ROADMAP.md` describes intended work. Treat source and focused tests as authoritative when they disagree with older prose.

## Required checks

```bash
pnpm typecheck
pnpm test
pnpm test:packages
pnpm test:e2e:cli   # provider-free embedded/attached CLI lifecycle smoke test
```

The root tests use mocked providers and temporary databases. Live-provider checks are opt-in and must never be required for a normal change. Native Electron modules may need `npx electron-rebuild -f -o better-sqlite3,node-pty` after an Electron or Node change.

Do not reset or overwrite unrelated working-tree changes. Add focused tests for runtime behavior, especially tool dispatch, cancellation, retries, compaction, subagent boundaries, and event replay.

## Agent implementation rules

Batch independent reads, but serialize calls that mutate the same file, shell, session, or external integration. Preserve stable tool-call IDs and evidence references when pruning context. A subagent allowlist is a runtime capability boundary: enforce it when dispatching a call, not only when constructing provider schemas. Every automatic handoff needs a durable result or a retryable failure state.
