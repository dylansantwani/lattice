# Handoff — Subagent C: Gate-1 black-box e2e suite

**Status:** complete (suite written + harness verified) / integration blocked on server build
**Scope:** black-box Gate-1 suite driving the COMPILED MCP server over stdio with a real MCP SDK client.
**Model:** qwen27b

## Files changed
- `packages/computer-use-mcp/test/e2e/gate1.e2e.ts` (new, only file written)

## Tests / commands
- Command: `cd packages/computer-use-mcp && ../../node_modules/.bin/vitest run -c vitest.e2e.config.ts`
- Result at handoff: `9 tests | 9 skipped` — `beforeAll` fails at `client.connect` because
  `bin/computer-use-mcp.mjs` does not exist yet (concurrent agents still building).
  Harness itself verified working: SDK loads (3-tier pnpm-safe loader), child spawns,
  clean SIGTERM→SIGKILL teardown, **no zombie processes** (checked `ps`).
- Re-run the same command after the server lands; no test edits expected from this side.

## Acceptance mapping (amendment "Co-use acceptance tests" → tests)
| # | Test | Criterion covered |
|---|---|---|
| 0 | beforeAll listTools | Gate-1 surface: 9 tools + `computer_test_inject` under hooks env |
| 1 | lists apps | canonical bundle id, not display name |
| 2 | full happy loop | start (observing, background_assist default, gen ≥1) + MCP image block with base64 OUT of text + screenshot `{omitted:'see image block'}` + per-generation action loop; fake calc `7 + 8 = 15` |
| 3 | needs_focus is not escalation | background_assist coordinate click → structured `needs_focus` (isError:false), no observation, no image, mode unchanged |
| 4 | user intervention pauses & invalidates | user_input → paused/user_has_control, gen invalidated, old-gen action → `stale` + recoverable + **no side effect** (Display unchanged) |
| 5 | resume re-observes, never replays | resume → observing, fresh gen > stale gen, Display unchanged (no replay), post-resume action at new gen ok |
| 6 | stop tears down | ended → `unknown_session` (isError) on subsequent calls; health still ready, sessions=0 |
| 7 | health + protocol | backend:'fake', protocol:'1.0', ready, sessions number |
| 8 | stale rejected before side effects | supersession-without-user-event variant of stale |
| 9 | target_mismatch | expectedTarget naming another app rejected, no side effect |

## Known limitations / recorded-actual values (fill in at green run)
- `observed.userPlaneState` — actual post-intervention state name (paused vs user_has_control).
- `observed.targetMismatchRecoverable` — actual recoverable value.
- PiP-body-never-focuses and PiP-responsiveness criteria are Gate-3/4 (no MCP surface in Gate 1) — deliberately not covered.
- Two documented extraction helpers (`extractObservation`, `sessionFields`) accept the one-shape
  flexibility allowed by the brief; every other assertion is strict against the frozen contract.
- SDK import note: `@modelcontextprotocol/sdk/client/stdio` is NOT bare-importable (wildcard export
  doesn't add the extension); the suite resolves via bare import → createRequire-anchored absolute
  ESM path → CJS require fallback. All three tiers verified against SDK 1.30.0.

## Next handoff
Integration lead: once `packages/computer-use-mcp` builds (tsc) and `bin/computer-use-mcp.mjs`
exists, re-run the e2e command. Any failing assertion is a contract bug report — the suite was
deliberately NOT bent toward server convenience.
