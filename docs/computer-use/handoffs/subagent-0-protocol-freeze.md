# Handoff — Subagent 0: protocol freeze + integration baseline

**Status:** complete
**Scope:** Freeze the cross-language contract for the Computer Use MCP work; record the repo baseline; wire workspace packages.
**Actor:** integration lead (orchestrator, not a spawned subagent)

## Files changed (Wave 1)
- `packages/computer-use-protocol/` (new package, FROZEN):
  - `schema/` — 5 JSON Schemas (2020-12): session, app-state, action, event, error
  - `src/index.ts` — TS mirror of the schemas + `ACTION_METADATA` (honest focus flags), `requiresFocus()`, `MODE_POLICY` (background_assist is the only default; takeover never implicit), `TOOL_NAMES`/`TOOL_DESCRIPTIONS` (the 9-tool surface), state-set helpers
  - `src/core.ts` — `Controller` interface (single façade for both lanes) + `NativeBackend` interface (the process boundary to the future Swift helper) + `NativeUserEvent` kinds
  - `examples/` — 8 canonical wire examples (session, app-state, click_element/type_text requests, ok/stale results, event, error)
  - `test/index.test.ts` — 9 tests, all passing
  - Built `dist/` with tsc NodeNext; `pnpm-workspace.yaml` now includes `packages/*`; root `pnpm install` completed (lockfile updated — workspace link only, no new external deps)
- `packages/computer-use-core/{package.json,tsconfig.json,vitest.config.ts}` (scaffold only)
- `packages/computer-use-mcp/{package.json,tsconfig.json,vitest.config.ts,vitest.e2e.config.ts}` (scaffold only)
- `docs/computer-use/handoffs/` (this dir)

## Contract decisions (normative for all subagents)
1. **Element-index actions are the background-assist path**: `click_element`, `set_value`, `paste`, `select_text`, `secondary_action` are `semantic: true, focusable: false`; coordinate/focus actions (`click`, `drag`, `type_text`, `press_key`, `scroll`) are `focusable: true` → background_assist answers `needs_focus`, never escalates.
2. **Unknown action types fail closed** (`focusable: true` default).
3. **Per-action failures are structured tool results (isError:false)**: `stale|busy|lease_conflict|target_mismatch|out_of_policy|needs_focus|permission_required|user_intervened|source_unavailable|cancelled` + reason (+detail). **Transport-level / unknown-session errors are isError:true** with `CUError` JSON (`code`, `recoverable`).
4. **Screenshots are MCP image content blocks only** — JSON payloads carry `{omitted:'see image block'}`.
5. **Observation generation**: every successful observation increments the session generation; actions must be issued at the generation they were decided on; mismatch → `stale` (recoverable, no side effect).
6. **Test hooks**: `LATTICE_CU_TEST_HOOKS=1` adds `computer_test_inject` (user-plane event simulation on the fake backend); absent otherwise. `LATTICE_CU_BACKEND` (default `fake`) is the future swap point for the socket backend.
7. **One controller per server**; the in-process Lattice adapter (later subagent) uses the same `Controller` interface — no second policy implementation.

## Baseline (for the "Lattice untouched" verification)
- Repo HEAD before work: `c1abe95` (main), clean tree.
- Lattice Electron PIDs at start: 93042 (gpu, started 19:32:15), 93043 (network, 19:32:15), 93046 (renderer, 19:32:15), 93665 (renderer, 19:35:08). If any of these PIDs is gone/restarted at the end, something touched Lattice — investigate before reporting.
- No `pnpm install` beyond the single workspace-link run; no Electron process started/stopped by this work.

## Next handoff
- Subagent A (core): implement `packages/computer-use-core` per the frozen `Controller` interface.
- Subagent B (mcp): implement `packages/computer-use-mcp` stdio server + packaging per the 9-tool surface.
- Subagent C (e2e): black-box Gate-1 suite (already complete — see its handoff).
- Integration: build all three, run all suites, then Gate-1 green run.
