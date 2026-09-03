import { describe, it, expect } from 'vitest'
import type { ModelInfo, TurnTelemetry, UsageRow } from '@shared/types'
import { buildUsagePageData, filterByRange } from './usageRollup'

const CAPS = { vision: false, tools: true, reasoning: false, effortTiers: [] }

const MODELS: ModelInfo[] = [
  {
    id: 'cc/priced',
    name: 'Priced Model',
    provider: 'cc',
    contextLength: 200_000,
    maxOutputTokens: 8_000,
    capabilities: CAPS,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 }
  },
  { id: 'cc/free', name: 'Free Model', provider: 'cc', contextLength: 200_000, maxOutputTokens: 8_000, capabilities: CAPS },
  {
    id: 'or/other',
    name: 'Other Model',
    provider: 'openrouter',
    contextLength: 128_000,
    maxOutputTokens: 8_000,
    capabilities: CAPS
  }
]

let seq = 0
function row(opts: {
  threadId?: string
  threadTitle?: string
  model?: string
  ts?: number
  telemetry: TurnTelemetry
}): UsageRow {
  seq += 1
  return {
    id: `m${seq}`,
    threadId: opts.threadId ?? 't1',
    threadTitle: opts.threadTitle ?? 'Thread One',
    model: opts.model,
    createdAt: opts.ts ?? Date.parse('2026-09-01T12:00:00'),
    telemetry: opts.telemetry
  }
}

describe('filterByRange', () => {
  const now = Date.parse('2026-09-10T12:00:00Z')
  const rows: UsageRow[] = [
    row({ ts: now, telemetry: {} }),
    row({ ts: now - 2 * 24 * 60 * 60 * 1000, telemetry: {} }), // 2 days ago
    row({ ts: now - 10 * 24 * 60 * 60 * 1000, telemetry: {} }), // 10 days ago
    row({ ts: now - 40 * 24 * 60 * 60 * 1000, telemetry: {} }) // 40 days ago
  ]

  it('"1d" keeps only rows within the last day', () => {
    expect(filterByRange(rows, '1d', now)).toHaveLength(1)
  })
  it('"7d" keeps the last two rows', () => {
    expect(filterByRange(rows, '7d', now)).toHaveLength(2)
  })
  it('"30d" excludes the 40-day-old row', () => {
    expect(filterByRange(rows, '30d', now)).toHaveLength(3)
  })
  it('"all" keeps everything', () => {
    expect(filterByRange(rows, 'all', now)).toHaveLength(4)
  })
})

describe('buildUsagePageData', () => {
  it('sums tokens, cost, and requests across all rows', () => {
    const rows = [
      row({ model: 'cc/priced', telemetry: { tokensIn: 100, tokensOut: 50, costUsd: 0.01, wallMs: 1000 } }),
      row({ model: 'cc/priced', telemetry: { tokensIn: 20, tokensOut: 10, costUsd: 0.002, wallMs: 500 } })
    ]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.totals.requests).toBe(2)
    expect(data.totals.freshInputTokens).toBe(120)
    expect(data.totals.outputTokens).toBe(60)
    expect(data.totals.costUsd).toBeCloseTo(0.012)
    expect(data.totals.costEstimated).toBe(false)
  })

  it('separates cached input and reasoning tokens out of fresh input / output', () => {
    const rows = [
      row({
        model: 'cc/free',
        telemetry: { tokensIn: 1000, cacheReadTokens: 300, cacheWriteTokens: 200, tokensOut: 800, tokensReasoning: 500 }
      })
    ]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.totals.cachedInputTokens).toBe(500)
    expect(data.totals.freshInputTokens).toBe(500)
    expect(data.totals.reasoningTokens).toBe(500)
    expect(data.totals.outputTokens).toBe(300)
  })

  it('computes cache hit rate as cached / total input', () => {
    const rows = [row({ model: 'cc/free', telemetry: { tokensIn: 1000, cacheReadTokens: 250 } })]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.cacheHitRate).toBeCloseTo(0.25)
  })

  it('reports a null cache hit rate when there is no input at all', () => {
    const data = buildUsagePageData([], MODELS)
    expect(data.cacheHitRate).toBeNull()
  })

  it('falls back to list price and flags the estimate when cost is unreported', () => {
    const rows = [row({ model: 'cc/priced', telemetry: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.totals.costEstimated).toBe(true)
    expect(data.totals.costLocal).toBe(true)
    expect(data.totals.costUsd).toBeCloseTo(18)
  })

  it('applies a user cost override — exact (no estimate), with cached/reasoning priced separately', () => {
    const rows = [
      row({
        model: 'cc/priced',
        telemetry: {
          tokensIn: 1_000_000,
          cacheReadTokens: 400_000,
          cacheWriteTokens: 200_000,
          tokensOut: 1_000_000,
          tokensReasoning: 300_000
        }
      })
    ]
    const overrides = {
      'cc/priced': { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, reasoningPerMTok: 6 }
    }
    const data = buildUsagePageData(rows, MODELS, overrides)
    // 0.4*3 + 0.6*0.3 + 0.7*15 + 0.3*6 = 1.2 + 0.18 + 10.5 + 1.8
    expect(data.totals.costUsd).toBeCloseTo(13.68)
    expect(data.totals.costEstimated).toBe(false)
    expect(data.totals.costLocal).toBe(true)
    expect(data.byModel.find((g) => g.key === 'cc/priced')!.costUsd).toBeCloseTo(13.68)
  })

  it('an override on one route leaves another route still estimated in mixed totals', () => {
    const rows = [
      row({ model: 'cc/priced', telemetry: { tokensIn: 1_000_000, tokensOut: 1_000_000 } }),
      row({ model: 'cc/free', telemetry: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })
    ]
    // Override the free route only; the priced route still estimates from list price.
    const data = buildUsagePageData(rows, MODELS, { 'cc/free': { inputPerMTok: 1, outputPerMTok: 1 } })
    expect(data.totals.costEstimated).toBe(true) // priced route still estimated
    expect(data.byModel.find((g) => g.key === 'cc/free')!.costEstimated).toBe(false)
    expect(data.byModel.find((g) => g.key === 'cc/priced')!.costEstimated).toBe(true)
  })

  it('computes tok/s weighted by wall time, not averaged per turn', () => {
    // 100 tokens in 1s (100 tok/s) and 100 tokens in 4s (25 tok/s): a naive average of the two
    // rates would read 62.5 tok/s; the weighted rate (200 tokens / 5s) should read 40 tok/s.
    const rows = [
      row({ model: 'cc/free', telemetry: { tokensOut: 100, wallMs: 1000 } }),
      row({ model: 'cc/free', telemetry: { tokensOut: 100, wallMs: 4000 } })
    ]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.totals.tps).toBe(40)
  })

  it('groups by model, provider, and thread with independent totals', () => {
    const rows = [
      row({ model: 'cc/priced', threadId: 'a', threadTitle: 'Thread A', telemetry: { tokensIn: 10, tokensOut: 5, costUsd: 1 } }),
      row({ model: 'or/other', threadId: 'b', threadTitle: 'Thread B', telemetry: { tokensIn: 10, tokensOut: 5, costUsd: 2 } })
    ]
    const data = buildUsagePageData(rows, MODELS)

    expect(data.byModel.map((g) => g.label)).toEqual(['Other Model', 'Priced Model']) // cost desc
    expect(data.byProvider.map((g) => g.key)).toEqual(['openrouter', 'cc'])
    expect(data.byThread.map((g) => g.label)).toEqual(['Thread B', 'Thread A'])
    expect(data.byThread.find((g) => g.key === 'a')!.costUsd).toBe(1)
  })

  it('buckets an unknown model id under a labeled "unknown" group instead of dropping it', () => {
    const rows = [row({ model: undefined, telemetry: { tokensIn: 10, tokensOut: 5 } })]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.byModel).toHaveLength(1)
    expect(data.byModel[0]!.key).toBe('unknown')
    expect(data.byModel[0]!.label).toBe('unknown model')
    expect(data.byProvider[0]!.label).toBe('Unknown provider')
  })

  it('buckets rows into local calendar days for the time series', () => {
    const rows = [
      row({ ts: Date.parse('2026-09-01T09:00:00'), telemetry: { tokensOut: 1 } }),
      row({ ts: Date.parse('2026-09-01T22:00:00'), telemetry: { tokensOut: 1 } }),
      row({ ts: Date.parse('2026-09-02T09:00:00'), telemetry: { tokensOut: 1 } })
    ]
    const data = buildUsagePageData(rows, MODELS)
    expect(data.byDay.map((d) => d.date)).toEqual(['2026-09-01', '2026-09-02'])
    expect(data.byDay[0]!.requests).toBe(2)
    expect(data.byDay[1]!.requests).toBe(1)
  })

  it('returns empty aggregates for no rows without throwing', () => {
    const data = buildUsagePageData([], MODELS)
    expect(data.totals.requests).toBe(0)
    expect(data.byModel).toEqual([])
    expect(data.byDay).toEqual([])
  })
})
