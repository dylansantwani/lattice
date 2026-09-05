import { describe, it, expect } from 'vitest'
import { buildStatsSnapshot, type StatsSnapshotInput } from './statsSnapshot'
import type { ModelInfo } from './types'

const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-09-03T18:00:00').getTime() // local afternoon

const models: ModelInfo[] = [
  {
    id: 'cc/opus',
    name: 'Claude Opus',
    provider: 'cc',
    ownedBy: 'claude',
    contextLength: 200000,
    maxOutputTokens: 64000,
    capabilities: {} as ModelInfo['capabilities'],
    pricing: { inputPerMTok: 15, outputPerMTok: 75 }
  },
  {
    id: 'local/qwen',
    name: 'Qwen 3.6',
    provider: 'llamacpp',
    providerLabel: 'llama.cpp',
    contextLength: 64000,
    maxOutputTokens: 8000,
    capabilities: {} as ModelInfo['capabilities']
    // no pricing → cost unknown, contributes 0 and no estimate
  }
]

function base(overrides: Partial<StatsSnapshotInput> = {}): StatsSnapshotInput {
  return {
    usage: [],
    tools: [],
    failures: [],
    models,
    now: NOW,
    tz: 'CDT',
    ...overrides
  }
}

describe('buildStatsSnapshot', () => {
  it('splits cache-aware token components and computes fresh vs cached input', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [
          {
            threadId: 't1',
            threadTitle: 'One',
            model: 'cc/opus',
            createdAt: NOW - 1000,
            telemetry: {
              tokensIn: 1000, // 400 fresh + 600 cached
              cacheReadTokens: 500,
              cacheWriteTokens: 100,
              tokensOut: 300, // 250 output + 50 reasoning
              tokensReasoning: 50,
              wallMs: 2000,
              ttftMs: 400,
              costUsd: 0.5
            }
          }
        ]
      })
    )
    const w = snap.ranges.today.window
    expect(w.requests).toBe(1)
    expect(w.freshInputTokens).toBe(400)
    expect(w.cachedInputTokens).toBe(600)
    expect(w.cacheReadTokens).toBe(500)
    expect(w.cacheWriteTokens).toBe(100)
    expect(w.outputTokens).toBe(250)
    expect(w.reasoningTokens).toBe(50)
    expect(w.freshTotalTokens).toBe(650) // 400 fresh + 250 output
    expect(w.totalTokens).toBe(1300) // 400 fresh + 600 cached + 250 output + 50 reasoning
    expect(w.costUsd).toBeCloseTo(0.5)
    expect(w.costLocal).toBe(false)
    // cache hit = 600 / (400 + 600) = 60%
    expect(w.cacheHitPct).toBe(60)
    // tps = output/wallSec = 250 / 2 = 125
    expect(w.tps).toBe(125)
    expect(w.activeThreads).toBe(1)
  })

  it('estimates cost from list price when the provider reports none', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [
          {
            threadId: 't1',
            threadTitle: 'One',
            model: 'cc/opus',
            createdAt: NOW - 1000,
            telemetry: { tokensIn: 1_000_000, tokensOut: 1_000_000 } // no costUsd
          }
        ]
      })
    )
    const w = snap.ranges.all.window
    // 1M fresh input @ $15 + 1M output @ $75 = $90
    expect(w.costUsd).toBeCloseTo(90)
    expect(w.costEstimated).toBe(true)
    expect(w.costLocal).toBe(true)
  })

  it('leaves cost at 0 with no pricing and no override, and never fabricates an estimate', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [
          {
            threadId: 't1',
            threadTitle: 'Local',
            model: 'local/qwen',
            createdAt: NOW - 1000,
            telemetry: { tokensIn: 5000, tokensOut: 5000 }
          }
        ]
      })
    )
    const w = snap.ranges.all.window
    expect(w.costUsd).toBe(0)
    expect(w.costEstimated).toBe(false)
    expect(w.costLocal).toBe(false)
  })

  it('windows by local calendar day / 7d / 30d / all', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [
          row('t1', NOW - 1000), // today
          row('t1', NOW - 3 * DAY), // within 7d
          row('t2', NOW - 10 * DAY), // within 30d
          row('t2', NOW - 60 * DAY) // only in all
        ]
      })
    )
    expect(snap.ranges.today.window.requests).toBe(1)
    expect(snap.ranges['7d'].window.requests).toBe(2)
    expect(snap.ranges['30d'].window.requests).toBe(3)
    expect(snap.ranges.all.window.requests).toBe(4)
  })

  it('breaks down by model and provider, grouping aliases by owned_by', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [row('t1', NOW - 1000, 'cc/opus'), row('t1', NOW - 2000, 'local/qwen'), row('t2', NOW - 3000, 'cc/opus')]
      })
    )
    const models = snap.ranges.all.byModel
    expect(models.map((m) => m.key).sort()).toEqual(['cc/opus', 'local/qwen'])
    const opus = models.find((m) => m.key === 'cc/opus')!
    expect(opus.requests).toBe(2)
    expect(opus.label).toBe('Claude Opus')
    expect(opus.sublabel).toBe('claude') // provider = owned_by
    const providers = snap.ranges.all.byProvider
    expect(providers.map((p) => p.key).sort()).toEqual(['claude', 'llama.cpp'])
  })

  it('summarizes tool calls: started counts calls, result carries ok/duration', () => {
    const snap = buildStatsSnapshot(
      base({
        tools: [
          { tool: 'Bash', ts: NOW - 5000, completed: false },
          { tool: 'Bash', ts: NOW - 4000, completed: true, ok: true, durationMs: 100 },
          { tool: 'Bash', ts: NOW - 3000, completed: false },
          { tool: 'Bash', ts: NOW - 2000, completed: true, ok: false, durationMs: 300 },
          { tool: 'Edit', ts: NOW - 1000, completed: false }
        ]
      })
    )
    const t = snap.ranges.today
    expect(t.window.toolCalls).toBe(3) // 2 Bash starts + 1 Edit start
    const bash = t.tools.find((x) => x.tool === 'Bash')!
    expect(bash.calls).toBe(2)
    expect(bash.failed).toBe(1)
    expect(bash.avgMs).toBe(200) // (100 + 300) / 2
  })

  it('counts failed turns per window and attributes them to model/thread groups', () => {
    const snap = buildStatsSnapshot(
      base({
        usage: [row('t1', NOW - 1000, 'cc/opus')],
        failures: [
          { threadId: 't1', model: 'cc/opus', createdAt: NOW - 500 },
          { threadId: 't1', model: 'cc/opus', createdAt: NOW - 40 * DAY } // out of 30d window
        ]
      })
    )
    expect(snap.ranges.today.window.failed).toBe(1)
    expect(snap.ranges['30d'].window.failed).toBe(1)
    expect(snap.ranges.all.window.failed).toBe(2)
    expect(snap.ranges.today.byModel.find((m) => m.key === 'cc/opus')!.failed).toBe(1)
  })

  it('emits a 30-day daily series, oldest first, zero-filling gaps', () => {
    const snap = buildStatsSnapshot(base({ usage: [row('t1', NOW - 1000), row('t1', NOW - 2 * DAY)] }))
    expect(snap.daily).toHaveLength(30)
    const d = snap.daily
    expect(d[0]!.date < d[29]!.date).toBe(true)
    expect(d[29]!.date).toBe('2026-09-03') // today, last
    expect(d[29]!.requests).toBe(1)
    expect(d[27]!.requests).toBe(1) // two days ago
    expect(d[28]!.requests).toBe(0) // gap day zero-filled
    expect(d[29]!.weekday).toBe(new Date(NOW).getDay())
  })
})

function row(threadId: string, createdAt: number, model = 'cc/opus'): StatsSnapshotInput['usage'][number] {
  return {
    threadId,
    threadTitle: threadId.toUpperCase(),
    model,
    createdAt,
    telemetry: { tokensIn: 1000, tokensOut: 200, wallMs: 1000, ttftMs: 200 }
  }
}
