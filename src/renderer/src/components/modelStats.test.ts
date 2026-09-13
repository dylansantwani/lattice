import { describe, expect, it } from 'vitest'
import type { StatsGroup } from '@shared/statsSnapshot'
import { fmtUsd, fmtWhen, foldModelStats, statsFor } from './modelStats'

function group(key: string, over: Partial<StatsGroup> = {}): StatsGroup {
  return {
    key,
    label: key,
    lastAt: 0,
    requests: 0,
    failed: 0,
    freshInputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    freshTotalTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    costUsd: 0,
    costEstimated: false,
    costLocal: false,
    wallMs: 0,
    ttftMs: 0,
    tps: 0,
    cacheHitPct: null,
    ...over
  } as StatsGroup
}

describe('foldModelStats', () => {
  it('merges effort variants onto the base stem and recomputes weighted rates', () => {
    const stats = foldModelStats([
      group('cx/gpt-5.6-sol-high', { requests: 2, outputTokens: 1000, wallMs: 10_000, ttftMs: 3000, lastAt: 5, costUsd: 0.5, totalTokens: 5000, freshInputTokens: 3000, cachedInputTokens: 1000 }),
      group('cx/gpt-5.6-sol', { requests: 1, failed: 1, outputTokens: 500, wallMs: 5_000, ttftMs: 1500, lastAt: 9, costUsd: 0.25, costEstimated: true, totalTokens: 2000, freshInputTokens: 1000, cachedInputTokens: 500 })
    ])
    const s = statsFor(stats, 'cx/gpt-5.6-sol-low')!
    expect(s.requests).toBe(3)
    expect(s.failed).toBe(1)
    expect(s.tps).toBe(100) // 1500 tokens over 15s
    expect(s.avgTtftMs).toBe(1500) // 4500ms over 3 turns
    expect(s.cacheHitPct).toBe(27) // 1500 cached of 5500 input
    expect(s.costUsd).toBeCloseTo(0.75)
    expect(s.costEstimated).toBe(true)
    expect(s.lastAt).toBe(9)
  })

  it('skips the unknown-model bucket and reports never-used models as undefined', () => {
    const stats = foldModelStats([group('unknown', { requests: 4 }), group('mac/qwen3:8b', { requests: 1 })])
    expect(stats.has('unknown')).toBe(false)
    expect(statsFor(stats, 'mac/qwen3:8b')?.requests).toBe(1)
    expect(statsFor(stats, 'mac/other')).toBeUndefined()
  })

  it('leaves rates null/zero when nothing was timed', () => {
    const s = statsFor(foldModelStats([group('m', { requests: 2 })]), 'm')!
    expect(s.tps).toBe(0)
    expect(s.avgTtftMs).toBeNull()
    expect(s.cacheHitPct).toBeNull()
  })
})

describe('formatters', () => {
  it('formats dollars compactly at every magnitude', () => {
    expect(fmtUsd(0)).toBe('$0')
    expect(fmtUsd(0.004)).toBe('$0.004')
    expect(fmtUsd(0.42)).toBe('$0.42')
    expect(fmtUsd(3.456)).toBe('$3.46')
    expect(fmtUsd(42.4)).toBe('$42.4')
    expect(fmtUsd(1234)).toBe('$1234')
    expect(fmtUsd(12345)).toBe('$12.3k')
  })

  it('describes recency coarsely', () => {
    const now = 1_000_000_000_000
    expect(fmtWhen(0, now)).toBe('never')
    expect(fmtWhen(now - 10_000, now)).toBe('just now')
    expect(fmtWhen(now - 5 * 60_000, now)).toBe('5m ago')
    expect(fmtWhen(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(fmtWhen(now - 26 * 3_600_000, now)).toBe('yesterday')
    expect(fmtWhen(now - 12 * 86_400_000, now)).toBe('12 days ago')
  })
})
