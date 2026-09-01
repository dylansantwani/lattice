import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { ModelInfo } from '@shared/types'
import { useStore, activeThread } from '@/state/store'
import { fmtTokens } from './ContextOrbit'
import { I } from './Icon'
import { peelAlwaysTiers, peelAmbiguousTier, orderTiers, baseStem } from './effort'

type ModelSection = { label: string; models: ModelInfo[]; hint?: string; count?: number }
type CapKey = 'tools' | 'vision' | 'reasoning'
type SortKey = 'source' | 'default' | 'used' | 'cost-low' | 'cost-high' | 'context' | 'name'

/** Blended $/Mtok used for cost sorting; null when the provider reports no price. */
function costOf(model: ModelInfo): number | null {
  const p = model.pricing
  if (!p) return null
  return p.inputPerMTok + p.outputPerMTok
}

/** Compact USD-per-million-tokens label, e.g. $0, $0.50, $3, $15. */
function fmtPrice(n: number): string {
  if (n <= 0) return '$0'
  if (n < 1) return `$${n.toFixed(2)}`
  if (n < 10) return `$${n.toFixed(1)}`
  return `$${Math.round(n)}`
}

/** Preferred display order for known families. Anything else sorts alphabetically after. */
const FAMILY_ORDER = [
  'Claude Opus',
  'Claude Sonnet',
  'Claude Haiku',
  'Claude Fable',
  'OpenAI GPT',
  'OpenAI o-series',
  'Luna',
  'Google Gemini',
  'xAI Grok',
  'DeepSeek',
  'Qwen',
  'Llama',
  'Mistral'
]

/** Group a model into a human family from its name/id, so the list reads like real models. */
function familyOf(model: ModelInfo): string {
  const s = `${model.name} ${model.id}`.toLowerCase()
  if (/opus/.test(s)) return 'Claude Opus'
  if (/sonnet/.test(s)) return 'Claude Sonnet'
  if (/haiku/.test(s)) return 'Claude Haiku'
  if (/fable/.test(s)) return 'Claude Fable'
  if (/claude/.test(s)) return 'Claude'
  if (/\bo[13457]\b|o1-|o3-|o4-/.test(s)) return 'OpenAI o-series'
  if (/gpt|openai/.test(s)) return 'OpenAI GPT'
  if (/luna/.test(s)) return 'Luna'
  if (/gemini|palm/.test(s)) return 'Google Gemini'
  if (/grok/.test(s)) return 'xAI Grok'
  if (/deepseek/.test(s)) return 'DeepSeek'
  if (/qwen/.test(s)) return 'Qwen'
  if (/llama/.test(s)) return 'Llama'
  if (/mistral|mixtral|codestral/.test(s)) return 'Mistral'
  if (model.provider && model.provider !== 'default') {
    return model.provider.charAt(0).toUpperCase() + model.provider.slice(1)
  }
  return 'Other models'
}

function isAuto(model: ModelInfo): boolean {
  return model.id.toLowerCase().startsWith('auto/')
}

/**
 * The gateway aggregates many upstream backends behind cryptic route prefixes (the first
 * id segment). Map the ones we can identify to human labels and flag which run locally, so a
 * row's backend is obvious at a glance. Unknown prefixes fall back to the raw code — honest,
 * and still 1:1 with the route id.
 */
interface ProviderMeta {
  label: string
  local?: boolean
  /** one-line explanation of what this source is, shown under the section header */
  hint?: string
  /** section ordering: lower sorts higher. Your own subscriptions & local rigs come first. */
  rank?: number
  /**
   * Free, no-auth web bridges and community pools — useful to have, but noise in a list this
   * large. Hidden by default behind the "Experimental" toggle. Your authenticated subscriptions,
   * local rigs, and paid clouds (OpenRouter/Fireworks) are NOT experimental.
   */
  experimental?: boolean
}
// Keyed by the gateway's `owned_by` backend id (NOT the route prefix) so a single source that is
// exposed under several alias prefixes — your Claude sub as cc/ + claude/, your Codex sub as
// codex/ + cx/ — collapses into ONE section. Labels/backends verified against OmniRoute's own
// provider registry (~/.local/lib/node_modules/omniroute) and its routed-account call logs.
// Ranks: 0 local · 1 your Claude sub · 2 your Codex sub · 3–4 paid cloud · 6 free bridges ·
// 7 media · 9 meta-routes. Unknown backends fall back to the raw id (honest) and sort mid-list.
const SOURCES: Record<string, ProviderMeta> = {
  // your local machines — free and private
  mac: { label: 'Local · Ollama (Mac)', local: true, hint: 'Runs on your Mac — free & private', rank: 0 },
  pc5080: { label: 'Local · Ollama (PC 5080)', local: true, hint: 'Runs on your PC — free & private', rank: 0 },
  ollama: { label: 'Local · Ollama', local: true, rank: 0 },
  // YOUR Claude subscription — Claude Code OAuth (exposed as cc/ and the claude/ alias)
  claude: { label: 'Claude — your subscription', hint: 'Claude Code OAuth · cc/ and claude/ routes', rank: 1 },
  // YOUR Codex / OpenAI subscription — OAuth (exposed as codex/ and the cx/ alias)
  codex: { label: 'Codex — your subscription', hint: 'OpenAI Codex OAuth · codex/ and cx/ routes', rank: 2 },
  'codex-app-server': { label: 'Codex (app-server)', hint: 'OpenAI Codex app-server route', rank: 2 },
  // pay-per-token cloud you top up
  openrouter: { label: 'OpenRouter', hint: 'Pay-per-token aggregator (hundreds of models)', rank: 3 },
  fireworks: { label: 'Fireworks AI', hint: 'Pay-per-token cloud', rank: 4 },
  // gateway auto-routing combos (pick a backend by goal) — genuinely useful, not experimental
  combo: { label: 'Auto-route (combos)', hint: 'The gateway picks a backend by goal', rank: 5 },
  // free / no-auth web bridges & community pools — hidden by default
  zcode: { label: 'ZCode (GLM Coding Plan)', hint: 'Free GLM coding models', rank: 6, experimental: true },
  auggie: { label: 'Augment (Auggie CLI)', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  'cloudflare-playground': { label: 'Cloudflare AI Playground', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  'duckduckgo-web': { label: 'DuckDuckGo AI Chat', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  'devin-cli-agentic': { label: 'Devin CLI Bridge', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  'felo-web': { label: 'Felo', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  opencode: { label: 'OpenCode (free)', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  theoldllm: { label: 'The Old LLM', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  uncloseai: { label: 'UncloseAI', hint: 'Free, no-auth bridge', rank: 6, experimental: true },
  chipotle: { label: 'Chipotle Pepper AI', hint: 'Free, no-auth novelty bridge', rank: 6, experimental: true },
  aihorde: { label: 'AI Horde', hint: 'Free, volunteer-hosted — can be slow', rank: 6, experimental: true },
  // media generation (video) — free, hidden by default
  'veoaifree-web': { label: 'Veo (video, free)', hint: 'Free video generation', rank: 7, experimental: true },
  // reasoning-disabled wrapper routes over other backends — their own bucket, hidden by default
  'no-think': { label: 'No-think (reasoning off)', hint: 'Wrapper routes with reasoning disabled', rank: 9, experimental: true }
}
/** The source bucket for a model: its backend `owned_by`, except no-think wrappers keep their prefix. */
function sourceKey(model: ModelInfo): string {
  if (model.provider === 'no-think') return 'no-think'
  return model.ownedBy || model.provider
}
function providerMeta(key: string): ProviderMeta {
  return SOURCES[key] ?? { label: key }
}
function providerLabel(key: string): string {
  return providerMeta(key).label
}
function sourceRank(key: string): number {
  return providerMeta(key).rank ?? 5
}
function isExperimental(model: ModelInfo): boolean {
  return providerMeta(sourceKey(model)).experimental === true
}
function isLocal(model: ModelInfo): boolean {
  return providerMeta(sourceKey(model)).local === true
}
/** Free to run: local (no per-token cost) or the provider prices it at $0. */
function isFree(model: ModelInfo): boolean {
  if (isLocal(model)) return true
  const p = model.pricing
  return !!p && p.inputPerMTok === 0 && p.outputPerMTok === 0
}
/** The route id with its provider prefix removed, e.g. "openrouter/x/y" → "x/y". */
function routeTail(model: ModelInfo): string {
  const slash = model.id.indexOf('/')
  return slash >= 0 ? model.id.slice(slash + 1) : model.id
}

/**
 * Gateways list a separate model row per reasoning effort (…:low, …-high, …-ultracode).
 * Effort is its own request parameter, so those rows are redundant clutter. Collapse each
 * effort family to a single real, selectable model, merging the discovered tiers + capabilities
 * onto it so the composer's native effort selector still offers the right levels.
 *
 * Two passes, so ambiguous tokens (`medium`, `max`) are only treated as effort when a sibling
 * base model actually exists — never merging genuinely distinct models like mistral-medium or
 * qwen-max. `thinking`/`reasoning` are left intact, keeping gpt-5 and gpt-5-thinking separate.
 */
export function collapseVariants(models: ModelInfo[]): ModelInfo[] {
  // Pass 1 — peel always-safe tiers + ultracode → a preliminary stem and the tiers found.
  const pre = models.map((m) => {
    const { stem, tiers } = peelAlwaysTiers(m.id)
    return { m, stem: stem.toLowerCase(), tiers }
  })
  const stems = new Set(pre.map((p) => p.stem))

  // Pass 2 — an ambiguous token counts as effort only when the base (without it) is a real stem.
  const norm = pre.map((p) => {
    const amb = peelAmbiguousTier(p.stem)
    if (amb && stems.has(amb.stem.toLowerCase())) {
      return { m: p.m, key: amb.stem.toLowerCase(), tiers: [...p.tiers, amb.tier] }
    }
    return { m: p.m, key: p.stem, tiers: p.tiers }
  })

  const groups = new Map<string, typeof norm>()
  for (const n of norm) {
    const list = groups.get(n.key) ?? []
    list.push(n)
    groups.set(n.key, list)
  }

  const out: ModelInfo[] = []
  for (const [key, list] of groups) {
    if (list.length === 1) {
      const only = list[0]!.m
      out.push({ ...only, name: prettyName(only) })
      continue
    }
    // Representative is always a real, selectable id — prefer the canonical base id,
    // otherwise the shortest (least-suffixed) member of the family.
    const rep = (
      list.find((n) => n.m.id.toLowerCase() === key) ??
      [...list].sort((a, b) => a.m.id.length - b.m.id.length)[0]!
    ).m
    const tiers = new Set<string>(rep.capabilities.effortTiers.map((t) => t.toLowerCase()))
    let reasoning = rep.capabilities.reasoning
    let tools = rep.capabilities.tools
    let vision = rep.capabilities.vision
    for (const n of list) {
      n.m.capabilities.effortTiers.forEach((t) => tiers.add(t.toLowerCase()))
      n.tiers.forEach((t) => tiers.add(t))
      if (n.m.capabilities.reasoning || n.tiers.length) reasoning = true
      tools = tools || n.m.capabilities.tools
      vision = vision || n.m.capabilities.vision
    }
    out.push({
      ...rep,
      name: prettyName(rep),
      capabilities: { vision, tools, reasoning, effortTiers: orderTiers([...tiers]) }
    })
  }
  return out
}

/**
 * A clean display name. Keep a gateway-provided friendly name as-is (minus any effort suffix);
 * otherwise the "name" is really the raw route id, so drop the provider prefix (shown separately
 * on the route line) and the effort suffix so the list reads like real model names.
 */
function prettyName(model: ModelInfo): string {
  const hasFriendly = model.name && model.name !== model.id
  // Strip only unambiguous effort/ultracode suffixes so a real "Mistral Medium" keeps its name.
  let n = peelAlwaysTiers(hasFriendly ? model.name : model.id).stem
  if (!hasFriendly && n.includes('/')) n = n.slice(n.lastIndexOf('/') + 1)
  // Some gateways bake the route prefix into the friendly name ("cc/Claude Fable 5",
  // "zc/GLM 5.2"). It's shown separately as a provider chip, so strip it from the name.
  if (hasFriendly && model.provider && model.provider !== 'default') {
    const pre = `${model.provider}/`.toLowerCase()
    if (n.toLowerCase().startsWith(pre)) n = n.slice(pre.length)
  }
  return n || model.name || model.id
}

function sortByName(a: ModelInfo, b: ModelInfo): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)
}

/**
 * Token-aware relevance score for a query. Every whitespace-separated token must appear
 * somewhere (AND), so "opus 4" narrows to Opus 4.x. Name hits beat id hits; prefix beats
 * substring; shorter names win ties. Returns null when a token doesn't match at all.
 */
function scoreModel(model: ModelInfo, tokens: string[]): number | null {
  const name = model.name.toLowerCase()
  const id = model.id.toLowerCase()
  const fam = familyOf(model).toLowerCase()
  const hay = `${name} ${id} ${fam} ${model.provider.toLowerCase()} ${providerLabel(sourceKey(model)).toLowerCase()}`
  let score = 0
  for (const t of tokens) {
    if (!hay.includes(t)) return null
    if (name === t) score += 200
    else if (name.startsWith(t)) score += 120
    else if (new RegExp(`\\b${escapeRe(t)}`).test(name)) score += 70
    else if (name.includes(t)) score += 40
    if (id.startsWith(t)) score += 30
    else if (id.includes(t)) score += 15
    if (fam.includes(t)) score += 8
  }
  return score - name.length * 0.15
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Group models by their source (the gateway route prefix), so the list answers "which of these
 * come from my Claude sub / Codex sub / OpenRouter / local rigs". Sources are ordered by rank
 * (your own subscriptions and local machines first), then by size; each header carries a count
 * and a one-line hint of what the source actually is.
 */
function sectionBySource(models: ModelInfo[]): ModelSection[] {
  const bySource = new Map<string, ModelInfo[]>()
  for (const m of models) {
    const key = sourceKey(m)
    const list = bySource.get(key) ?? []
    list.push(m)
    bySource.set(key, list)
  }
  return [...bySource.keys()]
    .sort((a, b) => {
      const ra = sourceRank(a)
      const rb = sourceRank(b)
      if (ra !== rb) return ra - rb
      return bySource.get(b)!.length - bySource.get(a)!.length || providerLabel(a).localeCompare(providerLabel(b))
    })
    .map((key) => {
      const deduped = dedupeAliases(bySource.get(key)!)
      return {
        label: providerLabel(key),
        hint: providerMeta(key).hint,
        count: deduped.length,
        models: deduped.sort(sortByName)
      }
    })
}

/**
 * Within one source, the gateway often lists the same model under several route prefixes (e.g.
 * `cc/claude-opus-5` and its alias `claude/claude-opus-5` whose `parent` points back to cc). Keep
 * one row per distinct model, preferring the canonical (parent-less) route so the id stays stable.
 */
function dedupeAliases(models: ModelInfo[]): ModelInfo[] {
  const best = new Map<string, ModelInfo>()
  for (const m of models) {
    const k = prettyName(m).toLowerCase()
    const prev = best.get(k)
    if (!prev) best.set(k, m)
    else if (prev.parent && !m.parent) best.set(k, m) // prefer the canonical (non-alias) route
    else if (!!prev.parent === !!m.parent && m.id.length < prev.id.length) best.set(k, m)
  }
  return [...best.values()]
}

/** Real (named) models grouped by family first; automatic routes collapse into one trailing group. */
function sectionModels(models: ModelInfo[]): ModelSection[] {
  const real = models.filter((m) => !isAuto(m))
  const auto = models.filter(isAuto).sort(sortByName)

  const byFamily = new Map<string, ModelInfo[]>()
  for (const m of real) {
    const fam = familyOf(m)
    const list = byFamily.get(fam) ?? []
    list.push(m)
    byFamily.set(fam, list)
  }

  const families = [...byFamily.keys()].sort((a, b) => {
    const ai = FAMILY_ORDER.indexOf(a)
    const bi = FAMILY_ORDER.indexOf(b)
    if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
    return a.localeCompare(b)
  })

  const sections: ModelSection[] = families.map((fam) => ({
    label: fam,
    models: byFamily.get(fam)!.sort(sortByName)
  }))
  if (auto.length) sections.push({ label: 'Automatic routes', models: auto })
  return sections
}

export function ModelPicker(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.modelPickerOpen)
  const setUi = useStore((s) => s.setUi)
  const rawModels = useStore((s) => s.models)
  const thread = useStore(activeThread)
  const setModel = useStore((s) => s.setModel)
  const setDefaultModel = useStore((s) => s.setDefaultModel)
  const recentModelIds = useStore((s) => s.recentModelIds)
  const modelUsage = useStore((s) => s.modelUsage)
  const defaultModel = useStore((s) => s.settings?.defaultModel)
  const [query, setQuery] = useState('')
  const [caps, setCaps] = useState<Record<CapKey, boolean>>({ tools: false, vision: false, reasoning: false })
  const [localOnly, setLocalOnly] = useState(false)
  const [freeOnly, setFreeOnly] = useState(false)
  const [showExperimental, setShowExperimental] = useState(false)
  const [family, setFamily] = useState('all')
  const [providerFilter, setProviderFilter] = useState('all')
  const [sort, setSort] = useState<SortKey>('source')
  const [selected, setSelected] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const models = useMemo(() => collapseVariants(rawModels), [rawModels])

  const families = useMemo(() => {
    const set = new Set(models.filter((m) => !isAuto(m)).map(familyOf))
    return [...set].sort((a, b) => {
      const ai = FAMILY_ORDER.indexOf(a)
      const bi = FAMILY_ORDER.indexOf(b)
      if (ai !== bi) return (ai < 0 ? 999 : ai) - (bi < 0 ? 999 : bi)
      return a.localeCompare(b)
    })
  }, [models])

  // Distinct sources present (by backend owned_by), with a count each; ordered by rank so your
  // subscriptions and local rigs lead and the free bridges trail.
  const providers = useMemo(() => {
    const counts = new Map<string, number>()
    for (const m of models) counts.set(sourceKey(m), (counts.get(sourceKey(m)) ?? 0) + 1)
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count, ...providerMeta(id) }))
      .sort((a, b) => {
        const ra = sourceRank(a.id)
        const rb = sourceRank(b.id)
        if (ra !== rb) return ra - rb
        return b.count - a.count || a.label.localeCompare(b.label)
      })
  }, [models])
  const hasLocal = useMemo(() => providers.some((p) => p.local), [providers])
  const hasFree = useMemo(() => models.some(isFree), [models])
  const experimentalCount = useMemo(() => models.filter(isExperimental).length, [models])

  const baseKey = (id: string): string => baseStem(id)
  const defaultBase = defaultModel ? baseKey(defaultModel) : null

  const byBase = useMemo(() => {
    const map = new Map<string, ModelInfo>()
    for (const m of models) map.set(baseKey(m.id), m)
    return map
  }, [models])

  // Usage is tallied per selected id; fold it onto base ids so counts line up with
  // the collapsed rows (a model + its effort variants share one count).
  const usageByBase = useMemo(() => {
    const map = new Map<string, number>()
    for (const [id, n] of Object.entries(modelUsage)) {
      const k = baseKey(id)
      map.set(k, (map.get(k) ?? 0) + n)
    }
    return map
  }, [modelUsage])
  const usageOf = (m: ModelInfo): number => usageByBase.get(baseKey(m.id)) ?? 0

  const recents = useMemo(() => {
    const seen = new Set<string>()
    const out: ModelInfo[] = []
    for (const id of recentModelIds) {
      const m = byBase.get(baseKey(id))
      if (m && !seen.has(m.id)) {
        seen.add(m.id)
        out.push(m)
      }
    }
    return out.slice(0, 5)
  }, [recentModelIds, byBase])

  const sections = useMemo(() => {
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
    let list = models
    if (caps.tools) list = list.filter((m) => m.capabilities.tools)
    if (caps.vision) list = list.filter((m) => m.capabilities.vision)
    if (caps.reasoning) list = list.filter((m) => m.capabilities.reasoning)
    if (localOnly) list = list.filter(isLocal)
    if (freeOnly) list = list.filter(isFree)
    // Hide free/no-auth web bridges & community pools unless explicitly revealed, searched, or
    // targeted directly — they're handy but drown out your real accounts in a 1700-model list.
    const revealExperimental = showExperimental || tokens.length > 0 || providerFilter !== 'all' || freeOnly
    if (!revealExperimental) list = list.filter((m) => !isExperimental(m))
    if (providerFilter !== 'all') list = list.filter((m) => sourceKey(m) === providerFilter)
    if (family !== 'all') list = list.filter((m) => familyOf(m) === family)

    // Query present → one flat, relevance-ranked result list.
    if (tokens.length) {
      const scored = list
        .map((m) => ({ m, s: scoreModel(m, tokens) }))
        .filter((x): x is { m: ModelInfo; s: number } => x.s !== null)
        .sort((a, b) => b.s - a.s || sortByName(a.m, b.m))
        .map((x) => x.m)
      return [{ label: `${scored.length} result${scored.length === 1 ? '' : 's'}`, models: scored }]
    }
    // No query → honor the sort; "default" keeps the family-grouped layout.
    if (sort === 'used') {
      const used = [...list]
        .filter((m) => usageOf(m) > 0)
        .sort((a, b) => usageOf(b) - usageOf(a) || sortByName(a, b))
      if (!used.length)
        return [{ label: 'No models used yet', models: sectionModels(list).flatMap((s) => s.models) }]
      return [{ label: 'Most used first', models: used }]
    }
    if (sort === 'cost-low' || sort === 'cost-high') {
      const priced = list.filter((m) => costOf(m) !== null)
      const unpriced = list.filter((m) => costOf(m) === null).sort(sortByName)
      priced.sort((a, b) => {
        const d = (costOf(a) ?? 0) - (costOf(b) ?? 0)
        return (sort === 'cost-low' ? d : -d) || sortByName(a, b)
      })
      const label = sort === 'cost-low' ? 'Cheapest first' : 'Most expensive first'
      const sections: ModelSection[] = [{ label, models: priced }]
      if (unpriced.length) sections.push({ label: 'No price reported', models: unpriced })
      return sections
    }
    if (sort === 'context')
      return [{ label: 'Largest context first', models: [...list].sort((a, b) => b.contextLength - a.contextLength || sortByName(a, b)) }]
    if (sort === 'name') return [{ label: 'A–Z', models: [...list].sort(sortByName) }]
    if (sort === 'default') return sectionModels(list)
    return sectionBySource(list)
  }, [models, query, caps, localOnly, freeOnly, showExperimental, providerFilter, family, sort, usageByBase])

  const visibleModels = useMemo(() => sections.flatMap((section) => section.models), [sections])

  useEffect(() => {
    if (open) {
      setQuery('')
      setCaps({ tools: false, vision: false, reasoning: false })
      setLocalOnly(false)
      setFreeOnly(false)
      setShowExperimental(false)
      setProviderFilter('all')
      setFamily('all')
      setSort('source')
      setSelected(0)
      setTimeout(() => inputRef.current?.focus(), 0)
    }
  }, [open, models, thread?.model])

  useEffect(() => {
    setSelected((index) => Math.max(0, Math.min(index, visibleModels.length - 1)))
  }, [visibleModels.length])

  if (!open) return null

  const choose = (id: string): void => {
    void setModel(id)
    setUi({ modelPickerOpen: false })
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key === 'Escape') setUi({ modelPickerOpen: false })
    else if (event.key === 'ArrowDown') {
      event.preventDefault()
      setSelected((index) => Math.min(index + 1, visibleModels.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setSelected((index) => Math.max(index - 1, 0))
    } else if (event.key === 'Enter' && visibleModels[selected]) {
      choose(visibleModels[selected].id)
    }
  }

  let modelIndex = 0

  return (
    <div className="overlay" onMouseDown={(event) => event.target === event.currentTarget && setUi({ modelPickerOpen: false })}>
      <div className="palette model-palette" onKeyDown={onKeyDown} role="dialog" aria-label="Choose model">
        <div className="model-picker-head">
          <div>
            <div className="model-picker-title">Choose a model</div>
            <div className="model-picker-help">Grouped by source — your Claude &amp; Codex subscriptions and local rigs first, then paid clouds like OpenRouter. Dozens of free web bridges are hidden behind “Experimental”. Search or filter by source anytime.</div>
          </div>
          <span className="model-count">{models.length} available</span>
        </div>
        <input
          ref={inputRef}
          placeholder="Search Opus, GPT, Luna, Gemini…"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value)
            setSelected(0)
          }}
          aria-label="Search models"
          aria-activedescendant={visibleModels[selected] ? `model-option-${visibleModels[selected].id}` : undefined}
        />
        {recents.length > 0 && !query && (
          <div className="model-recents" aria-label="Recently used models">
            <span className="model-recents-label">Recent</span>
            {recents.map((model) => (
              <button
                key={model.id}
                className={`model-recent-chip ${model.id === thread?.model ? 'current' : ''}`}
                onClick={() => choose(model.id)}
                title={model.id}
              >
                {baseKey(model.id) === defaultBase && <I name="star" size={12} />}
                {model.name}
              </button>
            ))}
          </div>
        )}
        <div className="model-filters" aria-label="Model filters">
          <div className="cap-chips" role="group" aria-label="Filter by capability">
            {(
              [
                ['tools', 'Tools', 'build'],
                ['vision', 'Vision', 'visibility'],
                ['reasoning', 'Reasoning', 'neurology']
              ] as const
            ).map(([key, label, icon]) => (
              <button
                key={key}
                className={`cap-chip ${caps[key] ? 'active' : ''}`}
                aria-pressed={caps[key]}
                onClick={() => {
                  setCaps((c) => ({ ...c, [key]: !c[key] }))
                  setSelected(0)
                }}
              >
                <I name={icon} size={13} />
                {label}
              </button>
            ))}
            {hasLocal && (
              <button
                className={`cap-chip ${localOnly ? 'active' : ''}`}
                aria-pressed={localOnly}
                title="Show only models running on your local machines"
                onClick={() => {
                  setLocalOnly((v) => !v)
                  setSelected(0)
                }}
              >
                <I name="hard_drive" size={13} />
                Local
              </button>
            )}
            {hasFree && (
              <button
                className={`cap-chip ${freeOnly ? 'active' : ''}`}
                aria-pressed={freeOnly}
                title="Show only free models — local, or priced at $0 by the provider"
                onClick={() => {
                  setFreeOnly((v) => !v)
                  setSelected(0)
                }}
              >
                <I name="savings" size={13} />
                Free
              </button>
            )}
            {experimentalCount > 0 && (
              <button
                className={`cap-chip ${showExperimental ? 'active' : ''}`}
                aria-pressed={showExperimental}
                title="Show free, no-auth web bridges & community pools (Pepper AI, DuckDuckGo, AI Horde, etc.). Hidden by default so your real accounts stand out."
                onClick={() => {
                  setShowExperimental((v) => !v)
                  setSelected(0)
                }}
              >
                <I name="science" size={13} />
                Experimental ({experimentalCount})
              </button>
            )}
          </div>
          <div className="filter-spacer" />
          <select
            className="mini-select"
            value={providerFilter}
            aria-label="Filter by provider"
            title="Filter by backend / provider"
            onChange={(e) => {
              setProviderFilter(e.target.value)
              setSelected(0)
            }}
          >
            <option value="all">All providers</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label} ({p.count})
              </option>
            ))}
          </select>
          <select
            className="mini-select"
            value={family}
            aria-label="Filter by family"
            onChange={(e) => {
              setFamily(e.target.value)
              setSelected(0)
            }}
          >
            <option value="all">All families</option>
            {families.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
          <select
            className="mini-select"
            value={sort}
            aria-label="Sort models"
            disabled={!!query.trim()}
            title={query.trim() ? 'Sorted by relevance while searching' : 'Sort order'}
            onChange={(e) => {
              setSort(e.target.value as SortKey)
              setSelected(0)
            }}
          >
            <option value="source">By source</option>
            <option value="default">By family</option>
            <option value="used">Most used</option>
            <option value="cost-low">Cheapest</option>
            <option value="cost-high">Most expensive</option>
            <option value="context">Context size</option>
            <option value="name">Name A–Z</option>
          </select>
          <span className="filter-count">{visibleModels.length} shown</span>
        </div>
        <div className="palette-list" role="listbox" aria-label="Available models">
          {sections.map((section) => (
            <section className="model-section" key={section.label} aria-label={section.label}>
              <div className="model-section-label">
                <span className="model-section-name">{section.label}</span>
                {typeof section.count === 'number' && (
                  <span className="model-section-count">{section.count}</span>
                )}
                {section.hint && <span className="model-section-hint">{section.hint}</span>}
              </div>
              {section.models.map((model) => {
                const index = modelIndex++
                const isCurrent = model.id === thread?.model
                const isDefault = baseKey(model.id) === defaultBase
                return (
                  <div
                    key={model.id}
                    id={`model-option-${model.id}`}
                    className={`palette-item model-option ${index === selected ? 'selected' : ''} ${isCurrent ? 'current' : ''}`}
                    role="option"
                    aria-selected={isCurrent}
                    onMouseEnter={() => setSelected(index)}
                    onClick={() => choose(model.id)}
                  >
                    <div className="model-option-main">
                      <div className="model-option-name">{model.name}</div>
                      <div className="model-option-route">
                        <span
                          className={`provider-chip ${isLocal(model) ? 'local' : ''}`}
                          title={`Source: ${providerLabel(sourceKey(model))} · route ${model.id}`}
                        >
                          {isLocal(model) && <I name="hard_drive" size={11} />}
                          {model.provider}
                        </span>
                        <span className="route-tail">{routeTail(model)}</span>
                      </div>
                    </div>
                    <div className="model-option-badges">
                      {isCurrent && <span className="model-badge current">Current</span>}
                      {isDefault && <span className="model-badge default">Default</span>}
                      {model.capabilities.tools && <span className="model-badge tools">Tools</span>}
                      {model.capabilities.reasoning && <span className="model-badge">Reasoning</span>}
                      {model.capabilities.vision && <span className="model-badge">Vision</span>}
                    </div>
                    <div className="meta">
                      <span>{fmtTokens(model.contextLength)} ctx</span>
                      <span>{fmtTokens(model.maxOutputTokens)} out</span>
                      {model.pricing && (
                        <span title="USD per million tokens (input / output)">
                          {fmtPrice(model.pricing.inputPerMTok)}/{fmtPrice(model.pricing.outputPerMTok)}
                          <span className="meta-unit"> /Mtok</span>
                        </span>
                      )}
                      {usageOf(model) > 0 && (
                        <span title="Times you've selected this model">
                          used {usageOf(model)}×
                        </span>
                      )}
                    </div>
                    <button
                      className={`model-star ${isDefault ? 'on' : ''}`}
                      title={isDefault ? 'Default model for new threads' : 'Set as default model'}
                      aria-label={isDefault ? 'Default model' : 'Set as default model'}
                      aria-pressed={isDefault}
                      onClick={(e) => {
                        e.stopPropagation()
                        void setDefaultModel(model.id)
                      }}
                    >
                      <I name={isDefault ? 'star' : 'star_outline'} size={16} />
                    </button>
                  </div>
                )
              })}
            </section>
          ))}
          {visibleModels.length === 0 && (
            <div className="model-picker-empty">
              {models.length === 0 ? 'No models — check provider settings.' : 'No matching models.'}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
