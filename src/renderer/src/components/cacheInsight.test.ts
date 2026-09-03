import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@shared/types'
import { CACHE_TTL_MS, explainCache } from './cacheInsight'
import type { TurnUsage } from './usageStats'

const turn = (over: Partial<TurnUsage>): TurnUsage => ({
  runId: 'r',
  ts: 1_000_000,
  model: 'm',
  freshInputTokens: 0,
  cachedInputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  outputTokens: 0,
  reasoningTokens: 0,
  toolCalls: 0,
  costUsd: 0,
  costEstimated: false,
  costLocal: false,
  hasUsage: true,
  rounds: 0,
  ttftMs: 0,
  modelMs: 0,
  toolMs: 0,
  ...over
})
const ev = (runId: string, type: string, seq: number): RunEvent =>
  ({ id: `e${seq}`, runId, threadId: 't', seq, ts: seq, body: { type } }) as unknown as RunEvent

describe('explainCache', () => {
  it('is null without turns and "unknown" without usage', () => {
    expect(explainCache([], [])).toBeNull()
    expect(explainCache([turn({ hasUsage: false })], [])?.verdict).toBe('unknown')
  })

  it('reports caching switched off for the provider', () => {
    const i = explainCache([turn({ promptCaching: false, freshInputTokens: 500 })], [])!
    expect(i.verdict).toBe('off')
    expect(i.reasons[0]).toMatch(/switched off/)
  })

  it('reports no cache activity when the route returned none', () => {
    const i = explainCache([turn({ freshInputTokens: 900 })], [])!
    expect(i.verdict).toBe('none')
    expect(i.hitRatePct).toBe(0)
  })

  it('explains a cold prefix by what changed since the previous turn', () => {
    const prev = turn({ runId: 'r1', ts: 0, model: 'a', effort: 'high', cacheReadTokens: 800 })
    const cur = turn({ runId: 'r2', ts: CACHE_TTL_MS + 1, model: 'b', effort: 'off', cacheWriteTokens: 1000 })
    const events = [ev('r1', 'run.started', 1), ev('r1', 'compaction', 2), ev('r2', 'run.started', 3)]
    const i = explainCache([cur, prev], events)!
    expect(i.verdict).toBe('cold')
    expect(i.reasons.join(' ')).toMatch(/model changed/)
    expect(i.reasons.join(' ')).toMatch(/effort changed/)
    expect(i.reasons.join(' ')).toMatch(/compacted/)
    expect(i.reasons.join(' ')).toMatch(/five minutes/)
  })

  it('calls the first turn a first-turn write and an unexplained cold prefix a prefix change', () => {
    expect(explainCache([turn({ cacheWriteTokens: 100 })], [])!.reasons.join(' ')).toMatch(/first turn/)
    const prev = turn({ runId: 'r1', ts: 0, cacheReadTokens: 100 })
    const cur = turn({ runId: 'r2', ts: 1000, cacheWriteTokens: 100 })
    expect(explainCache([cur, prev], [])!.reasons.join(' ')).toMatch(/prefix changed/)
  })

  it('distinguishes partial hits from full hits', () => {
    expect(explainCache([turn({ cacheReadTokens: 500, freshInputTokens: 500 })], [])!.verdict).toBe('partial')
    expect(explainCache([turn({ cacheReadTokens: 950, freshInputTokens: 50 })], [])!.verdict).toBe('hit')
  })
})
