import { describe, it, expect } from 'vitest'
import type { ModelInfo, RunEvent, RunEventBody } from '@shared/types'
import { buildTurnUsage, cacheRatePct, fmtCost, modelLabel, relativeTime, sumTurns, totalInputTokens } from './usageStats'

let seq = 0
function ev(body: RunEventBody, opts: { runId?: string; ts?: number; agent?: string } = {}): RunEvent {
  return {
    id: `e${seq}`,
    runId: opts.runId ?? 'r1',
    threadId: 't1',
    seq: seq++,
    ts: opts.ts ?? 1000,
    agent: opts.agent,
    body
  }
}

function reset(): void {
  seq = 0
}

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
  {
    id: 'cc/free',
    name: 'Free Model',
    provider: 'cc',
    contextLength: 200_000,
    maxOutputTokens: 8_000,
    capabilities: CAPS
  }
]

describe('buildTurnUsage', () => {
  it('folds multiple usage events within one run into a single turn', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }, { ts: 1000 }),
      ev({ type: 'usage', usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.01 } }, { ts: 1100 }),
      ev({ type: 'usage', usage: { tokensIn: 20, tokensOut: 10, costUsd: 0.002 } }, { ts: 1200 }),
      ev({ type: 'run.completed', reason: 'done' }, { ts: 1300 })
    ]
    const turns = buildTurnUsage(events, MODELS)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.freshInputTokens).toBe(120)
    expect(turns[0]!.outputTokens).toBe(60)
    expect(turns[0]!.costUsd).toBeCloseTo(0.012)
    expect(turns[0]!.costEstimated).toBe(false)
  })

  it('separates fresh input from cached input (read + write)', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({
        type: 'usage',
        usage: { tokensIn: 1000, cacheReadTokens: 300, cacheWriteTokens: 200 }
      })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.cachedInputTokens).toBe(500)
    expect(turn!.freshInputTokens).toBe(500)
  })

  it('separates reasoning tokens out of the output count', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensOut: 800, tokensReasoning: 500 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.reasoningTokens).toBe(500)
    expect(turn!.outputTokens).toBe(300)
  })

  it('counts tool.started events as tool calls', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({ type: 'tool.started', callId: 'a', tool: 'fs_read', args: {} }),
      ev({ type: 'tool.started', callId: 'b', tool: 'shell', args: {} }),
      ev({ type: 'usage', usage: { tokensIn: 10, tokensOut: 5 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.toolCalls).toBe(2)
  })

  it('excludes subagent events from the main-run breakdown', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 10, tokensOut: 5 } }),
      ev(
        { type: 'run.started', model: 'cc/free', mode: 'act' },
        { runId: 'sub1', agent: 'agent1' }
      ),
      ev({ type: 'usage', usage: { tokensIn: 999, tokensOut: 999 } }, { runId: 'sub1', agent: 'agent1' })
    ]
    const turns = buildTurnUsage(events, MODELS)
    expect(turns).toHaveLength(1)
    expect(turns[0]!.freshInputTokens).toBe(10)
  })

  it('falls back to model list price and flags the estimate when cost is not reported', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.costEstimated).toBe(true)
    expect(turn!.costUsd).toBeCloseTo(3 + 15)
  })

  it('leaves cost at zero, unestimated, when the model has no known pricing', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.costEstimated).toBe(false)
    expect(turn!.costLocal).toBe(false)
    expect(turn!.costUsd).toBe(0)
  })

  it('flags a list-price estimate as locally computed but still estimated', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.costLocal).toBe(true)
    expect(turn!.costEstimated).toBe(true)
  })

  it('does not mark provider-reported cost as locally computed', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.5 } })
    ]
    const [turn] = buildTurnUsage(events, MODELS)
    expect(turn!.costLocal).toBe(false)
    expect(turn!.costEstimated).toBe(false)
    expect(turn!.costUsd).toBeCloseTo(0.5)
  })

  it('uses a user override — exact (no estimate), and prices cached/reasoning separately', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }),
      ev({
        type: 'usage',
        usage: {
          tokensIn: 1_000_000, // 400k fresh + 600k cached
          cacheReadTokens: 500_000,
          cacheWriteTokens: 100_000,
          tokensOut: 1_000_000, // 700k output + 300k reasoning
          tokensReasoning: 300_000
        }
      })
    ]
    const overrides = {
      'cc/priced': { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, reasoningPerMTok: 6 }
    }
    const [turn] = buildTurnUsage(events, MODELS, overrides)
    // 0.4*3 + 0.6*0.3 + 0.7*15 + 0.3*6 = 1.2 + 0.18 + 10.5 + 1.8 = 13.68
    expect(turn!.costUsd).toBeCloseTo(13.68)
    expect(turn!.costEstimated).toBe(false)
    expect(turn!.costLocal).toBe(true)
  })

  it('prices a model with no list price once an override is supplied', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
      ev({ type: 'usage', usage: { tokensIn: 1_000_000, tokensOut: 1_000_000 } })
    ]
    const overrides = { 'cc/free': { inputPerMTok: 1, outputPerMTok: 4 } }
    const [turn] = buildTurnUsage(events, MODELS, overrides)
    expect(turn!.costUsd).toBeCloseTo(1 + 4)
    expect(turn!.costEstimated).toBe(false)
    expect(turn!.costLocal).toBe(true)
  })

  it('orders turns most-recent-first and drops runs with no usage or tool activity', () => {
    reset()
    const events = [
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }, { runId: 'r1', ts: 1000 }),
      ev({ type: 'usage', usage: { tokensIn: 1, tokensOut: 1 } }, { runId: 'r1', ts: 1000 }),
      // r2 started but never produced usage or a tool call (e.g. errored immediately) — excluded.
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }, { runId: 'r2', ts: 2000 }),
      ev({ type: 'run.started', model: 'cc/free', mode: 'act' }, { runId: 'r3', ts: 3000 }),
      ev({ type: 'usage', usage: { tokensIn: 1, tokensOut: 1 } }, { runId: 'r3', ts: 3000 })
    ]
    const turns = buildTurnUsage(events, MODELS)
    expect(turns.map((t) => t.runId)).toEqual(['r3', 'r1'])
  })
})

describe('sumTurns', () => {
  it('adds metrics across turns and keeps the estimated flag if any turn estimated', () => {
    const turns = buildTurnUsage(
      [
        ev({ type: 'run.started', model: 'cc/priced', mode: 'act' }, { runId: 'a' }),
        ev({ type: 'usage', usage: { tokensIn: 100, tokensOut: 50, costUsd: 0.05 } }, { runId: 'a' }),
        ev({ type: 'run.started', model: 'cc/free', mode: 'act' }, { runId: 'b' }),
        ev({ type: 'usage', usage: { tokensIn: 200, tokensOut: 100 } }, { runId: 'b' })
      ],
      MODELS
    )
    const total = sumTurns(turns)
    expect(total.freshInputTokens).toBe(300)
    expect(total.outputTokens).toBe(150)
    expect(total.costUsd).toBeCloseTo(0.05)
    expect(total.costEstimated).toBe(false)
  })
})

describe('fmtCost', () => {
  it('shows four decimals for sub-cent amounts and two otherwise', () => {
    expect(fmtCost(0.0032, false)).toBe('$0.0032')
    expect(fmtCost(1.2, false)).toBe('$1.20')
  })
  it('does not prefix cost values with a tilde', () => {
    expect(fmtCost(1.2, true)).toBe('$1.20')
  })
})

describe('modelLabel', () => {
  it('resolves a known model id to its display name', () => {
    expect(modelLabel('cc/priced', MODELS)).toBe('Priced Model')
  })
  it('falls back to the raw id for an unknown model', () => {
    expect(modelLabel('cc/mystery', MODELS)).toBe('cc/mystery')
  })
  it('falls back to a placeholder when no model id is known at all', () => {
    expect(modelLabel(undefined, MODELS)).toBe('unknown model')
  })
})

describe('totalInputTokens', () => {
  it('sums fresh and cached input', () => {
    const [turn] = buildTurnUsage(
      [
        ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
        ev({ type: 'usage', usage: { tokensIn: 1000, cacheReadTokens: 300, cacheWriteTokens: 200 } })
      ],
      MODELS
    )
    expect(totalInputTokens(turn!)).toBe(1000)
  })
})

describe('cacheRatePct', () => {
  it('computes the cached share of total input', () => {
    const [turn] = buildTurnUsage(
      [
        ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
        ev({ type: 'usage', usage: { tokensIn: 1000, cacheReadTokens: 250, cacheWriteTokens: 0 } })
      ],
      MODELS
    )
    expect(cacheRatePct(turn!)).toBe(25)
  })

  it('returns null instead of a misleading 0% when there is no input yet', () => {
    const [turn] = buildTurnUsage(
      [
        ev({ type: 'run.started', model: 'cc/free', mode: 'act' }),
        ev({ type: 'tool.started', callId: 'a', tool: 'shell', args: {} })
      ],
      MODELS
    )
    expect(cacheRatePct(turn!)).toBeNull()
  })
})

describe('relativeTime', () => {
  const now = 1_000_000_000
  it('reads "just now" for anything under 5 seconds', () => {
    expect(relativeTime(now - 2_000, now)).toBe('just now')
  })
  it('formats seconds, minutes, hours, and days at their own scale', () => {
    expect(relativeTime(now - 30_000, now)).toBe('30s ago')
    expect(relativeTime(now - 5 * 60_000, now)).toBe('5m ago')
    expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  })
})

describe('per-round timing', () => {
  it('sums first-token waits and model time over rounds and takes the turn\'s tool total', () => {
    const ev = (body: object, seq: number): RunEvent => ({ id: `e${seq}`, runId: 'r1', threadId: 't', seq, ts: seq, body } as RunEvent)
    const turns = buildTurnUsage(
      [
        ev({ type: 'run.started', model: 'm', mode: 'act' }, 1),
        ev({ type: 'usage', usage: { round: true, ttftMs: 4000, wallMs: 6000, tokensIn: 100, tokensOut: 10 } }, 2),
        ev({ type: 'usage', usage: { round: true, ttftMs: 3000, wallMs: 5000, tokensIn: 100, tokensOut: 10 } }, 3),
        ev({ type: 'usage', usage: { toolMs: 1500 } }, 4)
      ],
      [],
      {}
    )
    expect(turns[0]).toMatchObject({ rounds: 2, ttftMs: 7000, modelMs: 11000, toolMs: 1500 })
    expect(sumTurns(turns)).toMatchObject({ rounds: 2, ttftMs: 7000, modelMs: 11000, toolMs: 1500 })
  })
})

describe('housekeeping usage (memory distillation / titling)', () => {
  it('counts a tagged usage event in the totals AND calls it out separately', () => {
    const events = [
      { id: 'e1', runId: 'r1', threadId: 't', seq: 1, ts: 1, body: { type: 'run.started', model: 'm', mode: 'act' } },
      { id: 'e2', runId: 'r1', threadId: 't', seq: 2, ts: 2, body: { type: 'usage', usage: { tokensIn: 1000, tokensOut: 100 } } },
      { id: 'e3', runId: 'r1', threadId: 't', seq: 3, ts: 3, body: { type: 'usage', usage: { tokensIn: 300, tokensOut: 20, purpose: 'distill' } } }
    ] as unknown as Parameters<typeof buildTurnUsage>[0]
    const [turn] = buildTurnUsage(events, [])
    expect(turn!.freshInputTokens).toBe(1300)
    expect(turn!.outputTokens).toBe(120)
    expect(turn!.housekeepingInputTokens).toBe(300)
    expect(turn!.housekeepingOutputTokens).toBe(20)
    const total = sumTurns([turn!, turn!])
    expect(total.housekeepingInputTokens).toBe(600)
  })
})
