import { describe, expect, it } from 'vitest'
import type { ModelInfo } from './types'
import { formatUsd, summarizeTaskUsage } from './taskUsage'

const CAPS = { vision: false, tools: true, reasoning: true, effortTiers: [] }
const models: ModelInfo[] = [
  { id: 'deepseek/deepseek-v4-flash', name: 'Flash', provider: 'deepseek', contextLength: 1_000_000, maxOutputTokens: 8_000, capabilities: CAPS, pricing: { inputPerMTok: 0.22, outputPerMTok: 0.66, cachedInputPerMTok: 0.007 } },
  { id: 'mac/local', name: 'Local', provider: 'mac', contextLength: 32_000, maxOutputTokens: 4_000, capabilities: CAPS }
]

describe('summarizeTaskUsage', () => {
  it('sums calls and tokens and prices cached input at the cached rate', () => {
    const usage = summarizeTaskUsage(1, [
      { usage: { tokensIn: 100_000, cacheReadTokens: 90_000, tokensOut: 1_000, tokensReasoning: 200 } },
      { usage: { tokensIn: 120_000, cacheReadTokens: 100_000, tokensOut: 2_000 } },
      { usage: { round: true, ttftMs: 900 } }
    ], 'deepseek/deepseek-v4-flash', models)
    expect(usage).toMatchObject({ calls: 2, tokensIn: 220_000, cachedTokens: 190_000, tokensOut: 3_000, peakPromptTokens: 120_000, estimated: true })
    // 30k fresh × 0.22 + 190k cached × 0.007 + 3k out × 0.66, per million
    expect(usage.costUsd).toBeCloseTo((30_000 * 0.22 + 190_000 * 0.007 + 3_000 * 0.66) / 1e6, 8)
  })

  it('prefers provider-billed cost and leaves an unpriced route without a dollar figure', () => {
    expect(summarizeTaskUsage(1, [{ usage: { tokensIn: 10, tokensOut: 5, costUsd: 0.5 } }], 'mac/local', models).costUsd).toBe(0.5)
    const local = summarizeTaskUsage(1, [{ usage: { tokensIn: 10, tokensOut: 5 } }], 'mac/local', models)
    expect(local.costUsd).toBeUndefined()
    expect(local.calls).toBe(1)
  })

  it('does not let a side call (distill, roll) set the peak prompt size', () => {
    const usage = summarizeTaskUsage(1, [{ usage: { tokensIn: 5_000, tokensOut: 10 } }, { usage: { tokensIn: 90_000, tokensOut: 10, purpose: 'roll' } }], 'deepseek/deepseek-v4-flash', models)
    expect(usage.peakPromptTokens).toBe(5_000)
  })
})

describe('formatUsd', () => {
  it('stays short enough for a card', () => {
    expect(formatUsd(0.004)).toBe('<$0.01')
    expect(formatUsd(0.4212)).toBe('$0.42')
    expect(formatUsd(12.34)).toBe('$12.3')
    expect(formatUsd(250.5)).toBe('$251')
    expect(formatUsd(0)).toBe('$0.00')
  })
})
