import { describe, it, expect } from 'vitest'
import type { ModelInfo } from './types'
import { computeCost, prefillRates, resolveCostRates } from './cost'

const CAPS = { vision: false, tools: true, reasoning: false, effortTiers: [] }
const MODELS: ModelInfo[] = [
  {
    id: 'cc/priced',
    name: 'Priced',
    provider: 'cc',
    contextLength: 200_000,
    maxOutputTokens: 8_000,
    capabilities: CAPS,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 }
  },
  {
    id: 'cc/free',
    name: 'Free',
    provider: 'cc',
    contextLength: 200_000,
    maxOutputTokens: 8_000,
    capabilities: CAPS
  }
]

describe('resolveCostRates', () => {
  it('prefers a user override (exact) over list price', () => {
    const r = resolveCostRates('cc/priced', MODELS, { 'cc/priced': { inputPerMTok: 1, outputPerMTok: 2 } })
    expect(r).toEqual({ rates: { inputPerMTok: 1, outputPerMTok: 2 }, estimated: false })
  })

  it('falls back to list price (estimated) when no override', () => {
    const r = resolveCostRates('cc/priced', MODELS, {})
    expect(r).toEqual({ rates: { inputPerMTok: 3, outputPerMTok: 15 }, estimated: true })
  })

  it('keeps separately reported cached and reasoning list prices', () => {
    const models: ModelInfo[] = [{ ...MODELS[0]!, id: 'deepseek/flash', pricing: { inputPerMTok: 0.22, outputPerMTok: 0.66, cachedInputPerMTok: 0.007, reasoningPerMTok: 0.66 } }]
    expect(resolveCostRates('deepseek/flash', models, {})).toEqual({
      rates: { inputPerMTok: 0.22, outputPerMTok: 0.66, cachedInputPerMTok: 0.007, reasoningPerMTok: 0.66 },
      estimated: true
    })
  })

  it('returns null when neither an override nor a list price is known', () => {
    expect(resolveCostRates('cc/free', MODELS, {})).toBeNull()
    expect(resolveCostRates(undefined, MODELS, {})).toBeNull()
  })

  it('prices an otherwise-free model via an override', () => {
    const r = resolveCostRates('cc/free', MODELS, { 'cc/free': { inputPerMTok: 0.5, outputPerMTok: 1 } })
    expect(r).toEqual({ rates: { inputPerMTok: 0.5, outputPerMTok: 1 }, estimated: false })
  })
})

describe('computeCost', () => {
  const tokens = { freshInput: 400_000, cachedInput: 600_000, output: 700_000, reasoning: 300_000 }

  it('charges each dimension at its own rate', () => {
    const cost = computeCost(
      { inputPerMTok: 3, cachedInputPerMTok: 0.3, outputPerMTok: 15, reasoningPerMTok: 6 },
      tokens
    )
    // 0.4*3 + 0.6*0.3 + 0.7*15 + 0.3*6
    expect(cost).toBeCloseTo(1.2 + 0.18 + 10.5 + 1.8)
  })

  it('defaults cached→input and reasoning→output, reproducing the coarse list-price estimate', () => {
    // With cached omitted (→ input) and reasoning omitted (→ output), the four-way split collapses to
    // totalInput*inputRate + totalOutput*outputRate — exactly the old estimate.
    const cost = computeCost({ inputPerMTok: 3, outputPerMTok: 15 }, tokens)
    const totalIn = (tokens.freshInput + tokens.cachedInput) / 1_000_000
    const totalOut = (tokens.output + tokens.reasoning) / 1_000_000
    expect(cost).toBeCloseTo(totalIn * 3 + totalOut * 15)
  })
})

describe('prefillRates', () => {
  it('expands list price to all four fields (cached←input, reasoning←output)', () => {
    expect(prefillRates('cc/priced', MODELS, {})).toEqual({
      inputPerMTok: 3,
      cachedInputPerMTok: 3,
      outputPerMTok: 15,
      reasoningPerMTok: 15
    })
  })

  it('returns an existing override with its optional fields filled in', () => {
    expect(prefillRates('cc/priced', MODELS, { 'cc/priced': { inputPerMTok: 2, outputPerMTok: 8 } })).toEqual({
      inputPerMTok: 2,
      cachedInputPerMTok: 2,
      outputPerMTok: 8,
      reasoningPerMTok: 8
    })
  })

  it('starts at zero for a model with neither pricing nor an override', () => {
    expect(prefillRates('cc/free', MODELS, {})).toEqual({
      inputPerMTok: 0,
      cachedInputPerMTok: 0,
      outputPerMTok: 0,
      reasoningPerMTok: 0
    })
  })
})
