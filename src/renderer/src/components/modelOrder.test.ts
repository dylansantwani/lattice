import { describe, it, expect } from 'vitest'
import type { ModelInfo } from '@shared/types'
import {
  modelsByBase,
  foldUsageByBase,
  quickPickModels,
  quickPicksLabel
} from './modelOrder'

/** Minimal ModelInfo stub — only `id`/`name` matter to the ordering. */
function model(id: string, name = id): ModelInfo {
  return {
    id,
    name,
    provider: 'default',
    contextLength: 8000,
    maxOutputTokens: 4000,
    capabilities: { tools: false, vision: false, reasoning: false, effortTiers: [] }
  } as ModelInfo
}

const OPUS = model('claude-opus-5', 'Claude Opus 5')
const GPT = model('gpt-5', 'GPT-5')
const GEMINI = model('gemini-2.5-pro', 'Gemini 2.5 Pro')
const GROK = model('grok-4', 'Grok 4')
const LUNA = model('luna-1', 'Luna 1')
const ALL = [OPUS, GPT, GEMINI, GROK, LUNA]

describe('modelsByBase', () => {
  it('indexes by base stem, collapsing effort suffixes onto one key', () => {
    const map = modelsByBase([OPUS, model('claude-opus-5-high')])
    // both share the base stem "claude-opus-5"; first entry wins
    expect(map.size).toBe(1)
    expect(map.get('claude-opus-5')).toBe(OPUS)
  })

  it('keeps distinct models under distinct keys', () => {
    const map = modelsByBase(ALL)
    expect(map.size).toBe(5)
    expect(map.get('gpt-5')).toBe(GPT)
  })
})

describe('foldUsageByBase', () => {
  it('sums usage of a model and its effort variants onto the base stem', () => {
    const usage = foldUsageByBase({ 'gpt-5': 3, 'gpt-5-high': 2, 'claude-opus-5': 1 })
    expect(usage.get('gpt-5')).toBe(5)
    expect(usage.get('claude-opus-5')).toBe(1)
  })
})

describe('quickPickModels', () => {
  const byBase = modelsByBase(ALL)

  it('orders by recency first', () => {
    const qp = quickPickModels(['gemini-2.5-pro', 'gpt-5'], new Map(), byBase)
    expect(qp.picks.map((m) => m.id)).toEqual(['gemini-2.5-pro', 'gpt-5'])
    expect(qp.recentCount).toBe(2)
  })

  it('resolves recent ids that carry an effort suffix back to the base row', () => {
    const qp = quickPickModels(['gpt-5-high'], new Map(), byBase)
    expect(qp.picks.map((m) => m.id)).toEqual(['gpt-5'])
    expect(qp.recentCount).toBe(1)
  })

  it('fills the row with most-used models after recents, without duplicating', () => {
    const usage = foldUsageByBase({ 'grok-4': 10, 'luna-1': 5, 'gpt-5': 99 })
    const qp = quickPickModels(['gpt-5'], usage, byBase, 6)
    // gpt-5 came from recents (not repeated by usage); grok (10) then luna (5) fill by usage desc
    expect(qp.picks.map((m) => m.id)).toEqual(['gpt-5', 'grok-4', 'luna-1'])
    expect(qp.recentCount).toBe(1)
  })

  it('falls back to pure usage ordering when there are no recents', () => {
    const usage = foldUsageByBase({ 'luna-1': 2, 'grok-4': 8 })
    const qp = quickPickModels([], usage, byBase)
    expect(qp.picks.map((m) => m.id)).toEqual(['grok-4', 'luna-1'])
    expect(qp.recentCount).toBe(0)
  })

  it('respects the max cap', () => {
    const usage = foldUsageByBase({ 'gpt-5': 5, 'grok-4': 4, 'luna-1': 3, 'gemini-2.5-pro': 2 })
    const qp = quickPickModels(['claude-opus-5'], usage, byBase, 2)
    expect(qp.picks).toHaveLength(2)
    expect(qp.picks[0]!.id).toBe('claude-opus-5')
  })

  it('ignores unknown recent ids and zero-usage entries', () => {
    const usage = foldUsageByBase({ 'grok-4': 0 })
    const qp = quickPickModels(['does-not-exist'], usage, byBase)
    expect(qp.picks).toEqual([])
    expect(qp.recentCount).toBe(0)
  })
})

describe('quickPicksLabel', () => {
  it('labels by which signals contributed', () => {
    expect(quickPicksLabel({ picks: [OPUS], recentCount: 1 })).toBe('Recent')
    expect(quickPicksLabel({ picks: [OPUS, GPT], recentCount: 1 })).toBe('Recent & used')
    expect(quickPicksLabel({ picks: [OPUS], recentCount: 0 })).toBe('Most used')
  })
})
