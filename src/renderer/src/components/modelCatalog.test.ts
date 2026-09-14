import { describe, expect, it } from 'vitest'
import type { ModelHealth, ModelInfo } from '@shared/types'
import {
  agoLabel,
  AUTO_HEALTH_LIMIT,
  autoHealthTargets,
  buildNav,
  buildSections,
  collapseVariantsMemo,
  DEFAULT_FILTERS,
  familyMark,
  familyOf,
  flattenSections,
  fmtLatency,
  HEADER_ROW_H,
  healthTitle,
  inScope,
  isChat,
  isFree,
  isUnhealthy,
  MODEL_ROW_H,
  nameParts,
  prettyName,
  rowOffsets,
  scopeKey,
  scopeLabel,
  scoreModel,
  siblingRoutes,
  sourceGroup,
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

const ids = (sections: ReturnType<typeof buildSections>): string[] => sections.flatMap((s) => s.models.map((m) => m.id))

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

describe('names', () => {
  it('splits an Ollama tag, a quant and a parenthetical off the title', () => {
    expect(nameParts(model({ id: 'mac/qwen3:30b-a3b', name: 'qwen3:30b-a3b' }))).toEqual({ title: 'qwen3', tag: '30b-a3b' })
    expect(nameParts(model({ id: 'x', name: 'GPT 5.6 Sol (Ultra)' }))).toEqual({ title: 'GPT 5.6 Sol', tag: 'Ultra' })
    expect(nameParts(model({ id: 'x', name: 'Qwen3.8-27B-GGUF:UD-Q3_K_XL' }))).toEqual({ title: 'Qwen3.8-27B-GGUF', tag: 'UD-Q3_K_XL' })
    expect(nameParts(model({ id: 'x', name: 'Claude Opus 5' }))).toEqual({ title: 'Claude Opus 5' })
  })

  it('reduces a path-shaped name that mirrors the id to its last segment, leaving curated names alone', () => {
    expect(prettyName(model({ id: 'mac/hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL', name: 'hf.co/unsloth/Qwen3.8-27B-GGUF:UD-Q3_K_XL' }))).toBe('Qwen3.8-27B-GGUF:UD-Q3_K_XL')
    expect(prettyName(model({ id: 'mac/DeepHat/DeepHat-V1-7B:latest', name: 'DeepHat/DeepHat-V1-7B:latest' }))).toBe('DeepHat-V1-7B:latest')
    expect(prettyName(model({ id: 'openrouter/tencent/hy4-preview', name: 'tencent/hy4-preview' }))).toBe('hy4-preview')
    expect(prettyName(model({ id: 'x/curated', name: 'Claude / Sonnet' }))).toBe('Claude / Sonnet')
  })

  it('recognizes newer families and gives every family a stable avatar', () => {
    expect(familyOf(model({ id: 'openrouter/z-ai/glm-5.2:free' }))).toBe('Z.ai GLM')
    expect(familyOf(model({ id: 'nvidia/minimaxai/minimax-m2.7' }))).toBe('MiniMax')
    expect(familyOf(model({ id: 'mac/gpt-oss:20b' }))).toBe('OpenAI gpt-oss')
    expect(familyMark(CATALOG[0]!)).toEqual({ mark: 'CL', hue: 24 })
    const unknown = model({ id: 'x/frobnicator-9000', name: 'frobnicator-9000' })
    expect(familyMark(unknown)).toEqual(familyMark(unknown))
    expect(familyMark(unknown).mark).toBe('FR')
  })
})

describe('sources and kinds', () => {
  it('files sources into navigator groups', () => {
    expect(sourceGroup('mac')).toBe('local')
    expect(sourceGroup('claude')).toBe('subscription')
    expect(sourceGroup('codex')).toBe('subscription')
    expect(sourceGroup('openrouter')).toBe('cloud')
    expect(sourceGroup('some-unknown-backend')).toBe('cloud')
    expect(sourceGroup('duckduckgo-web')).toBe('experimental')
  })

  it('treats :free routes and $0 prices and local rigs as free', () => {
    expect(isFree(model({ id: 'openrouter/z-ai/glm-5.2:free', ownedBy: 'openrouter' }))).toBe(true)
    expect(isFree(CATALOG[3]!)).toBe(true)
    expect(isFree(CATALOG[4]!)).toBe(true)
    expect(isFree(CATALOG[0]!)).toBe(false)
  })

  it('only chat models are chat', () => {
    expect(isChat(CATALOG[0]!)).toBe(true)
    expect(isChat(model({ id: 'x/flux', kind: 'image' }))).toBe(false)
  })

  it('finds the same model behind other routes, best source first', () => {
    const all = [
      model({ id: 'opencode-zen/claude-fable-5', name: 'Claude Fable 5', ownedBy: 'opencode-zen' }),
      model({ id: 'cc/claude-fable-5', name: 'Claude Fable 5', ownedBy: 'claude' }),
      model({ id: 'openrouter/anthropic/claude-fable-5', name: 'Claude Fable 5', ownedBy: 'openrouter' }),
      model({ id: 'cc/claude-opus-5', name: 'Claude Opus 5', ownedBy: 'claude' })
    ]
    expect(siblingRoutes(all[0]!, all).map((m) => m.id)).toEqual(['cc/claude-fable-5', 'openrouter/anthropic/claude-fable-5'])
    expect(siblingRoutes(all[3]!, all)).toEqual([])
  })
})

describe('scopes', () => {
  it('serializes and labels every scope', () => {
    expect(scopeKey({ kind: 'all' })).toBe('all')
    expect(scopeKey({ kind: 'group', group: 'local' })).toBe('group:local')
    expect(scopeKey({ kind: 'source', source: 'mac' })).toBe('source:mac')
    expect(scopeLabel({ kind: 'source', source: 'mac' })).toBe('Mac · Ollama')
    expect(scopeLabel({ kind: 'group', group: 'experimental' })).toBe('Free bridges')
    expect(scopeLabel({ kind: 'nonchat' })).toBe('Not for chat')
  })

  it('the default scope is chat models from non-experimental sources', () => {
    const c = ctx()
    expect(inScope(CATALOG[0]!, { kind: 'all' }, c)).toBe(true)
    expect(inScope(CATALOG[4]!, { kind: 'all' }, c)).toBe(false)
    expect(inScope(model({ id: 'openrouter/flux', ownedBy: 'openrouter', kind: 'image' }), { kind: 'all' }, c)).toBe(false)
    expect(inScope(CATALOG[4]!, { kind: 'source', source: 'duckduckgo-web' }, c)).toBe(true)
    expect(inScope(CATALOG[3]!, { kind: 'group', group: 'local' }, c)).toBe(true)
    expect(inScope(CATALOG[0]!, { kind: 'group', group: 'local' }, c)).toBe(false)
  })
})

describe('buildSections', () => {
  it('groups by source with local rigs and subscriptions first, experimental hidden by default', () => {
    const sections = buildSections(CATALOG, DEFAULT_FILTERS, ctx())
    expect(sections.map((s) => s.label)).toEqual(['Mac · Ollama', 'Claude subscription', 'OpenRouter'])
    expect(ids(sections)).not.toContain('duckduckgo-web/gpt-mini')
  })

  it('reveals experimental sources when scoped to them, searched, or when a favorite lives there', () => {
    const scoped = buildSections(CATALOG, { ...DEFAULT_FILTERS, scope: { kind: 'group', group: 'experimental' } }, ctx())
    expect(scoped.map((s) => s.label)).toEqual(['DuckDuckGo AI Chat'])
    const searched = buildSections(CATALOG, { ...DEFAULT_FILTERS, query: 'ddg' }, ctx())
    expect(ids(searched)).toEqual(['duckduckgo-web/gpt-mini'])
    const fav = buildSections(CATALOG, DEFAULT_FILTERS, ctx({ favorites: [CATALOG[4]!] }))
    expect(fav[0]!.key).toBe('fav')
    expect(fav[0]!.models[0]!.id).toBe('duckduckgo-web/gpt-mini')
  })

  it('keeps non-chat models out of every view but their own', () => {
    const flux = model({ id: 'openrouter/black-forest/flux', name: 'FLUX', ownedBy: 'openrouter', kind: 'image' })
    const embed = model({ id: 'openrouter/openai/text-embedding-3', name: 'text-embedding-3', ownedBy: 'openrouter', kind: 'embedding' })
    const catalog = [...CATALOG, flux, embed]
    expect(ids(buildSections(catalog, DEFAULT_FILTERS, ctx()))).not.toContain(flux.id)
    expect(ids(buildSections(catalog, { ...DEFAULT_FILTERS, query: 'flux' }, ctx()))).toEqual([])
    expect(ids(buildSections(catalog, { ...DEFAULT_FILTERS, scope: { kind: 'source', source: 'openrouter' } }, ctx()))).not.toContain(flux.id)
    const nonchat = buildSections(catalog, { ...DEFAULT_FILTERS, scope: { kind: 'nonchat' } }, ctx())
    expect(nonchat.map((s) => [s.label, s.models.map((m) => m.id)])).toEqual([
      ['Image generation', [flux.id]],
      ['Embeddings', [embed.id]]
    ])
  })

  it('leads with Favorites then Recent in the default view, without repeating a row between them', () => {
    const sections = buildSections(
      CATALOG,
      DEFAULT_FILTERS,
      ctx({ favorites: [CATALOG[1]!], quickPicks: { picks: [CATALOG[1]!, CATALOG[3]!], recentCount: 2 } })
    )
    expect(sections[0]!.key).toBe('fav')
    expect(sections[0]!.models.map((m) => m.id)).toEqual(['cc/claude-sonnet-5'])
    expect(sections[1]!.key).toBe('recent')
    expect(sections[1]!.models.map((m) => m.id)).toEqual(['mac/qwen3:8b'])
  })

  it('the Favorites and Recent scopes keep their own ordering and no lead sections', () => {
    const c = ctx({ favorites: [CATALOG[2]!, CATALOG[0]!], quickPicks: { picks: [CATALOG[3]!, CATALOG[1]!], recentCount: 2 } })
    const fav = buildSections(CATALOG, { ...DEFAULT_FILTERS, scope: { kind: 'favorites' } }, c)
    expect(fav).toHaveLength(1)
    expect(ids(fav)).toEqual(['openrouter/anthropic/opus-4.5', 'cc/claude-opus-5'])
    const recent = buildSections(CATALOG, { ...DEFAULT_FILTERS, scope: { kind: 'recent' } }, c)
    expect(ids(recent)).toEqual(['mac/qwen3:8b', 'cc/claude-sonnet-5'])
  })

  it('applies capability, free, group and source filters', () => {
    expect(ids(buildSections(CATALOG, { ...DEFAULT_FILTERS, caps: { tools: false, vision: true, reasoning: false } }, ctx()))).toEqual(['cc/claude-sonnet-5'])
    expect(ids(buildSections(CATALOG, { ...DEFAULT_FILTERS, scope: { kind: 'group', group: 'local' } }, ctx()))).toEqual(['mac/qwen3:8b'])
    expect(ids(buildSections(CATALOG, { ...DEFAULT_FILTERS, freeOnly: true }, ctx()))).toEqual(['mac/qwen3:8b'])
    expect(ids(buildSections(CATALOG, { ...DEFAULT_FILTERS, scope: { kind: 'source', source: 'openrouter' } }, ctx()))).toEqual(['openrouter/anthropic/opus-4.5'])
  })

  it('sorts by cost with unpriced models in their own trailing section', () => {
    const sections = buildSections(CATALOG, { ...DEFAULT_FILTERS, sort: 'cost-low' }, ctx())
    expect(sections.map((s) => s.key)).toEqual(['cost', 'unpriced'])
    expect(sections[0]!.models.map((m) => m.id)).toEqual(['cc/claude-opus-5', 'openrouter/anthropic/opus-4.5'])
  })

  it('search returns one relevance-ranked section', () => {
    const sections = buildSections(CATALOG, { ...DEFAULT_FILTERS, query: 'opus 5' }, ctx())
    expect(sections).toHaveLength(1)
    expect(sections[0]!.models[0]!.id).toBe('cc/claude-opus-5')
  })
})

describe('buildNav', () => {
  it('lists the personal collections, then sources grouped local → subscriptions → cloud → free bridges', () => {
    const nav = buildNav(CATALOG, ctx({ favorites: [CATALOG[0]!], quickPicks: { picks: [CATALOG[3]!], recentCount: 1 } }))
    expect(nav.pinned.map((e) => [e.key, e.count])).toEqual([
      ['all', 4],
      ['favorites', 1],
      ['recent', 1]
    ])
    expect(nav.groups.map((g) => [g.group, g.count, g.entries.map((e) => e.label)])).toEqual([
      ['local', 1, ['Mac · Ollama']],
      ['subscription', 2, ['Claude subscription']],
      ['cloud', 1, ['OpenRouter']],
      ['experimental', 1, ['DuckDuckGo AI Chat']]
    ])
    expect(nav.nonChat).toBe(0)
  })

  it('counts de-duplicated chat models and reports non-chat entries separately', () => {
    const alias = model({ id: 'claude/claude-opus-5', name: 'Claude Opus 5', ownedBy: 'claude', parent: 'cc/claude-opus-5' })
    const flux = model({ id: 'openrouter/flux', name: 'FLUX', ownedBy: 'openrouter', kind: 'image' })
    const nav = buildNav([...CATALOG, alias, flux], ctx())
    const claude = nav.groups.find((g) => g.group === 'subscription')!.entries[0]!
    expect(claude.count).toBe(2)
    expect(nav.nonChat).toBe(1)
  })

  it('rolls pinged health up per source', () => {
    const h = (id: string, status: ModelHealth['status']): ModelHealth => ({ modelId: id, status, checkedAt: 0 })
    const nav = buildNav(CATALOG, ctx(), { 'cc/claude-opus-5': h('cc/claude-opus-5', 'live'), 'cc/claude-sonnet-5': h('cc/claude-sonnet-5', 'down') }, new Set(['mac/qwen3:8b']))
    const claude = nav.groups.find((g) => g.group === 'subscription')!.entries[0]!
    expect(claude.health).toEqual({ ok: 1, bad: 1, checking: 0 })
    const mac = nav.groups.find((g) => g.group === 'local')!.entries[0]!
    expect(mac.health).toEqual({ ok: 0, bad: 0, checking: 1 })
    expect(nav.pinned[0]!.health).toEqual({ ok: 1, bad: 1, checking: 1 })
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

// ---------------------------------------------------------------- model health (ping status)

describe('model health', () => {
  const health = (over: Partial<ModelHealth> & { modelId: string }): ModelHealth => ({
    status: 'live',
    checkedAt: Date.now(),
    ...over
  })

  it('treats only a pinged-and-failing model as unhealthy', () => {
    expect(isUnhealthy(health({ modelId: 'a', status: 'down' }))).toBe(true)
    expect(isUnhealthy(health({ modelId: 'a', status: 'limited' }))).toBe(true)
    expect(isUnhealthy(health({ modelId: 'a', status: 'live' }))).toBe(false)
    expect(isUnhealthy(health({ modelId: 'a', status: 'slow' }))).toBe(false)
    // Never checked is never "unhealthy" — the filter must not empty an unpinged catalog.
    expect(isUnhealthy(health({ modelId: 'a', status: 'unknown' }))).toBe(false)
    expect(isUnhealthy(undefined)).toBe(false)
  })

  it('hides dead models when asked, and keeps every unchecked one', () => {
    const filters = { ...DEFAULT_FILTERS, healthyOnly: true }
    const sections = buildSections(CATALOG, filters, {
      ...ctx(),
      health: {
        'cc/claude-opus-5': health({ modelId: 'cc/claude-opus-5', status: 'down' }),
        'mac/qwen3:8b': health({ modelId: 'mac/qwen3:8b', status: 'live' })
      }
    })
    const list = ids(sections)
    expect(list).not.toContain('cc/claude-opus-5')
    expect(list).toContain('mac/qwen3:8b')
    // Never pinged, so never hidden.
    expect(list).toContain('cc/claude-sonnet-5')
  })

  it('leaves the list untouched when the filter is off', () => {
    const withDead = buildSections(CATALOG, DEFAULT_FILTERS, {
      ...ctx(),
      health: { 'cc/claude-opus-5': health({ modelId: 'cc/claude-opus-5', status: 'down' }) }
    })
    expect(ids(withDead)).toContain('cc/claude-opus-5')
  })

  it('pings the model in use first, then favorites, then recents — deduped and capped', () => {
    const favorites = [CATALOG[2]!, CATALOG[3]!]
    const recents = [CATALOG[3]!, CATALOG[4]!] // qwen repeats a favorite
    // mac/qwen3:8b is a local rig, so it is skipped even though it sits in favorites and recents.
    expect(autoHealthTargets('cc/claude-opus-5', favorites, recents, CATALOG)).toEqual([
      'cc/claude-opus-5',
      'openrouter/anthropic/opus-4.5',
      'duckduckgo-web/gpt-mini'
    ])
    expect(autoHealthTargets('cc/claude-opus-5', favorites, recents, CATALOG, 2)).toEqual([
      'cc/claude-opus-5',
      'openrouter/anthropic/opus-4.5'
    ])
    // No thread, no favorites, no recents → nothing is pinged at all.
    expect(autoHealthTargets(undefined, [], [], CATALOG)).toEqual([])
  })

  it('never pings a local rig (Mac / PC 5080) — a ping there cold-loads the model', () => {
    const macModel = CATALOG[3]! // ownedBy: 'mac'
    const pc = model({ id: 'pc5080/qwen3:8b', ownedBy: 'pc5080' })
    const catalog = [...CATALOG, pc]
    // Every candidate is local: current model, favorite, and recent — so nothing is pinged.
    expect(autoHealthTargets('mac/qwen3:8b', [pc], [macModel], catalog)).toEqual([])
    // A cloud current model survives; the local favorite/recent are dropped.
    expect(autoHealthTargets('cc/claude-opus-5', [macModel], [pc], catalog)).toEqual(['cc/claude-opus-5'])
  })

  it('never auto-pings more than a handful, whatever the catalog size', () => {
    const many = Array.from({ length: 200 }, (_, i) => model({ id: `x/m${i}` }))
    expect(autoHealthTargets('x/m0', many, many, many)).toHaveLength(AUTO_HEALTH_LIMIT)
  })

  it('formats latency and builds a tooltip that says what happened and when', () => {
    expect(fmtLatency(820)).toBe('820ms')
    expect(fmtLatency(3400)).toBe('3.4s')
    expect(fmtLatency(undefined)).toBe('')
    const now = 1_000_000
    expect(healthTitle(health({ modelId: 'a', latencyMs: 812, checkedAt: now - 2000 }), now)).toBe(
      'Live · 812ms — checked just now'
    )
    expect(
      healthTitle(
        health({ modelId: 'a', status: 'down', latencyMs: 40, error: 'HTTP 404 · no such model', checkedAt: now - 120_000 }),
        now
      )
    ).toBe('Down · 40ms — HTTP 404 · no such model — checked 2m ago')
  })

  it('describes ping age coarsely', () => {
    expect(agoLabel(1_000)).toBe('just now')
    expect(agoLabel(40_000)).toBe('40s ago')
    expect(agoLabel(6 * 60_000)).toBe('6m ago')
    expect(agoLabel(3 * 3_600_000)).toBe('3h ago')
  })
})
