import { describe, expect, it } from 'vitest'
import type { ModelInfo } from '@shared/types'
import {
  buildSections,
  collapseVariantsMemo,
  DEFAULT_FILTERS,
  flattenSections,
  HEADER_ROW_H,
  MODEL_ROW_H,
  rowOffsets,
  scoreModel,
  visibleRange,
  type PickerContext
} from './modelCatalog'

function model(partial: Partial<ModelInfo> & { id: string }): ModelInfo {
  return {
    name: partial.id,
    provider: partial.id.includes('/') ? partial.id.slice(0, partial.id.indexOf('/')) : 'default',
    contextLength: 128000,
    maxOutputTokens: 8192,
    capabilities: { vision: false, tools: true, reasoning: false, effortTiers: [] },
    ...partial
  }
}

const CATALOG: ModelInfo[] = [
  model({ id: 'cc/claude-opus-5', name: 'Claude Opus 5', ownedBy: 'claude', pricing: { inputPerMTok: 5, outputPerMTok: 25 } }),
  model({ id: 'cc/claude-sonnet-5', name: 'Claude Sonnet 5', ownedBy: 'claude', capabilities: { vision: true, tools: true, reasoning: true, effortTiers: [] } }),
  model({ id: 'openrouter/anthropic/opus-4.5', name: 'Opus 4.5', ownedBy: 'openrouter', pricing: { inputPerMTok: 15, outputPerMTok: 75 } }),
  model({ id: 'mac/qwen3:8b', name: 'qwen3:8b', ownedBy: 'mac' }),
  model({ id: 'duckduckgo-web/gpt-mini', name: 'GPT mini (DDG)', ownedBy: 'duckduckgo-web', pricing: { inputPerMTok: 0, outputPerMTok: 0 } })
]

const ctx = (over: Partial<PickerContext> = {}): PickerContext => ({
  favorites: [],
  usageByBase: new Map(),
  quickPicks: { picks: [], recentCount: 0 },
  ...over
})

describe('scoreModel', () => {
  it('ranks a whole-word hit above a fragment inside a bigger token', () => {
    const tokens = ['opus', '5']
    const opus5 = scoreModel(CATALOG[0]!, tokens)!
    const opus45 = scoreModel(CATALOG[2]!, tokens)!
    expect(opus5).toBeGreaterThan(opus45)
  })
  it('requires every token to match', () => {
    expect(scoreModel(CATALOG[3]!, ['qwen', 'opus'])).toBeNull()
  })
})

describe('buildSections', () => {
  it('groups by source with subscriptions and local rigs first, experimental hidden by default', () => {
    const sections = buildSections(CATALOG, DEFAULT_FILTERS, ctx())
    expect(sections.map((s) => s.label)).toEqual(['Local · Ollama (Mac)', 'Claude — your subscription', 'OpenRouter'])
    expect(sections.flatMap((s) => s.models).some((m) => m.ownedBy === 'duckduckgo-web')).toBe(false)
  })

  it('reveals experimental sources when asked, searched, or when a favorite lives there', () => {
    const shown = buildSections(CATALOG, { ...DEFAULT_FILTERS, showExperimental: true }, ctx())
    expect(shown.some((s) => s.label === 'DuckDuckGo AI Chat')).toBe(true)
    const searched = buildSections(CATALOG, { ...DEFAULT_FILTERS, query: 'ddg' }, ctx())
    expect(searched[0]!.models.map((m) => m.id)).toEqual(['duckduckgo-web/gpt-mini'])
    const fav = buildSections(CATALOG, DEFAULT_FILTERS, ctx({ favorites: [CATALOG[4]!] }))
    expect(fav[0]!.key).toBe('fav')
    expect(fav[0]!.models[0]!.id).toBe('duckduckgo-web/gpt-mini')
  })

  it('leads with Favorites then Recent, without repeating a row between them', () => {
    const sections = buildSections(
      CATALOG,
      DEFAULT_FILTERS,
      ctx({ favorites: [CATALOG[0]!], quickPicks: { picks: [CATALOG[0]!, CATALOG[1]!], recentCount: 2 } })
    )
    expect(sections[0]!.label).toBe('Favorites')
    expect(sections[1]!.label).toBe('Recent')
    expect(sections[1]!.models.map((m) => m.id)).toEqual(['cc/claude-sonnet-5'])
  })

  it('applies capability, local, free and source filters', () => {
    const f = DEFAULT_FILTERS
    expect(buildSections(CATALOG, { ...f, caps: { ...f.caps, vision: true } }, ctx()).flatMap((s) => s.models).map((m) => m.id)).toEqual(['cc/claude-sonnet-5'])
    expect(buildSections(CATALOG, { ...f, localOnly: true }, ctx()).flatMap((s) => s.models).map((m) => m.id)).toEqual(['mac/qwen3:8b'])
    expect(buildSections(CATALOG, { ...f, freeOnly: true }, ctx()).flatMap((s) => s.models).map((m) => m.id).sort()).toEqual(['duckduckgo-web/gpt-mini', 'mac/qwen3:8b'])
    expect(buildSections(CATALOG, { ...f, source: 'openrouter' }, ctx()).flatMap((s) => s.models).map((m) => m.id)).toEqual(['openrouter/anthropic/opus-4.5'])
  })

  it('sorts by cost with unpriced models in their own trailing section', () => {
    const sections = buildSections(CATALOG, { ...DEFAULT_FILTERS, sort: 'cost-low', showExperimental: true }, ctx())
    expect(sections[0]!.models.map((m) => m.id)).toEqual(['duckduckgo-web/gpt-mini', 'cc/claude-opus-5', 'openrouter/anthropic/opus-4.5'])
    expect(sections[1]!.label).toBe('No price reported')
  })

  it('search returns one relevance-ranked section', () => {
    const sections = buildSections(CATALOG, { ...DEFAULT_FILTERS, query: 'opus 5' }, ctx())
    expect(sections).toHaveLength(1)
    expect(sections[0]!.models[0]!.id).toBe('cc/claude-opus-5')
  })
})

describe('flattenSections + virtualization', () => {
  const sections = buildSections(CATALOG, DEFAULT_FILTERS, ctx())

  it('produces header + model rows with keyboard indexes, and drops rows of collapsed sections', () => {
    const open = flattenSections(sections, new Set())
    expect(open.rows.filter((r) => r.kind === 'header')).toHaveLength(3)
    expect(open.models).toHaveLength(4)
    const modelRows = open.rows.filter((r) => r.kind === 'model')
    expect(modelRows.map((r) => (r.kind === 'model' ? r.index : -1))).toEqual([0, 1, 2, 3])
    const collapsed = flattenSections(sections, new Set([sections[1]!.key]))
    expect(collapsed.models).toHaveLength(2)
    expect(collapsed.rows.filter((r) => r.kind === 'header')).toHaveLength(3)
  })

  it('computes fixed-height offsets and a windowed range', () => {
    const { rows } = flattenSections(sections, new Set())
    const { offsets, total } = rowOffsets(rows)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(HEADER_ROW_H)
    expect(offsets[2]).toBe(HEADER_ROW_H + MODEL_ROW_H)
    expect(total).toBe(3 * HEADER_ROW_H + 4 * MODEL_ROW_H)
    // a window exactly one header + one row tall from the top, no overscan
    expect(visibleRange(offsets, total, 0, HEADER_ROW_H + MODEL_ROW_H, 0)).toEqual([0, 1])
    // scrolled past the first two rows
    expect(visibleRange(offsets, total, HEADER_ROW_H + MODEL_ROW_H, MODEL_ROW_H, 0)[0]).toBe(2)
    expect(visibleRange([], 0, 0, 100)).toEqual([0, -1])
  })
})

describe('collapseVariantsMemo', () => {
  it('returns the same collapsed array for the same input array', () => {
    const a = collapseVariantsMemo(CATALOG)
    expect(collapseVariantsMemo(CATALOG)).toBe(a)
    expect(collapseVariantsMemo([...CATALOG])).not.toBe(a)
  })
})
