import type { ModelHealth, ModelHealthStatus, ModelInfo } from '@shared/types'
import { peelAlwaysTiers, peelAmbiguousTier, orderTiers, baseStem } from './effort'
import { quickPicksLabel, type QuickPicks } from './modelOrder'

/**
 * Pure model-catalog logic behind the model picker and the composer's quick picker: source
 * grouping, effort-variant collapsing, display names, search scoring, and the filter → sections
 * pipeline. Framework-free so it has one test surface and never re-renders anything.
 */
export type ModelSection = { key: string; label: string; models: ModelInfo[]; hint?: string; count?: number }
export type CapKey = 'tools' | 'vision' | 'reasoning'
export type SortKey = 'source' | 'default' | 'used' | 'cost-low' | 'cost-high' | 'context' | 'name'

export const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'source', label: 'By source' },
  { value: 'default', label: 'By family' },
  { value: 'used', label: 'Most used' },
  { value: 'cost-low', label: 'Cheapest' },
  { value: 'cost-high', label: 'Priciest' },
  { value: 'context', label: 'Largest context' },
  { value: 'name', label: 'A–Z' }
]

/** Blended $/Mtok used for cost sorting; null when the provider reports no price. */
export function costOf(model: ModelInfo): number | null {
  const p = model.pricing
  if (!p) return null
  return p.inputPerMTok + p.outputPerMTok
}

/** Compact USD-per-million-tokens label, e.g. $0, $0.50, $3, $15. */
export function fmtPrice(n: number): string {
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
export function familyOf(model: ModelInfo): string {
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

export function isAuto(model: ModelInfo): boolean {
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
/**
 * The known source groups a model can be filed under, as {key,label} sorted by section rank — the
 * choices offered when the user reassigns a model's group in Settings (Model source overrides).
 */
export const SOURCE_GROUP_OPTIONS: { key: string; label: string }[] = Object.entries(SOURCES)
  .map(([key, m]) => ({ key, label: m.label, rank: m.rank ?? 5 }))
  .sort((a, b) => a.rank - b.rank || a.label.localeCompare(b.label))
  .map(({ key, label }) => ({ key, label }))

/**
 * Generic inference-runtime names a dedicated endpoint reports as `owned_by` — they identify the
 * server software, not a distinct *source*, so grouping by them ("vllm", "llama.cpp") is meaningless.
 * When we see one, we group by the configured Lattice provider label instead (e.g. "runpod2").
 */
const GENERIC_BACKENDS = new Set([
  'vllm', 'llama.cpp', 'llamacpp', 'llama-cpp', 'tgi', 'text-generation-inference',
  'sglang', 'default', 'unknown', 'local', 'openai'
])

/**
 * The source bucket for a model. Prefer the gateway's real backend `owned_by` when it names a
 * recognized or meaningful source (so OmniRoute still splits into Claude/Codex/OpenRouter/local).
 * But a dedicated endpoint reports a generic runtime ("vllm") or nothing — there, group by the
 * configured provider label ("runpod2") so its models appear under the provider you added, not "vllm".
 */
export function sourceKey(model: ModelInfo): string {
  if (model.provider === 'no-think') return 'no-think'
  const owned = model.ownedBy
  if (owned && SOURCES[owned]) return owned
  if (owned && !GENERIC_BACKENDS.has(owned.toLowerCase())) return owned
  return model.providerLabel || owned || model.provider
}
/** The provider-prefix chip on a row; falls back to the provider label for prefix-less ids. */
export function chipLabel(model: ModelInfo): string {
  if (model.provider && model.provider !== 'default') return model.provider
  return model.providerLabel || sourceKey(model)
}
export function providerMeta(key: string): ProviderMeta {
  return SOURCES[key] ?? { label: key }
}
export function providerLabel(key: string): string {
  return providerMeta(key).label
}
export function sourceRank(key: string): number {
  return providerMeta(key).rank ?? 5
}
export function isExperimental(model: ModelInfo): boolean {
  return providerMeta(sourceKey(model)).experimental === true
}
export function isLocal(model: ModelInfo): boolean {
  return providerMeta(sourceKey(model)).local === true
}
/** Free to run: local (no per-token cost) or the provider prices it at $0. */
export function isFree(model: ModelInfo): boolean {
  if (isLocal(model)) return true
  const p = model.pricing
  return !!p && p.inputPerMTok === 0 && p.outputPerMTok === 0
}
/** The route id with its provider prefix removed, e.g. "openrouter/x/y" → "x/y". */
export function routeTail(model: ModelInfo): string {
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
export function prettyName(model: ModelInfo): string {
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

export function sortByName(a: ModelInfo, b: ModelInfo): number {
  return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }) || a.id.localeCompare(b.id)
}

/**
 * Token-aware relevance score for a query. Every whitespace-separated token must appear
 * somewhere (AND), so "opus 4" narrows to Opus 4.x. Name hits beat id hits; prefix beats
 * substring; shorter names win ties. Returns null when a token doesn't match at all.
 */
export function scoreModel(model: ModelInfo, tokens: string[]): number | null {
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
    // A whole-word hit ("5" in "Opus 5") outranks a fragment of a bigger token ("5" in "4.5").
    if (new RegExp(`(^|[\\s/:_-])${escapeRe(t)}($|[\\s/:_-])`).test(name)) score += 60
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
export function sectionBySource(models: ModelInfo[]): ModelSection[] {
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
        key: `src:${key}`,
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
export function dedupeAliases(models: ModelInfo[]): ModelInfo[] {
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
export function sectionModels(models: ModelInfo[]): ModelSection[] {
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
    key: `fam:${fam}`,
    label: fam,
    count: byFamily.get(fam)!.length,
    models: byFamily.get(fam)!.sort(sortByName)
  }))
  if (auto.length) sections.push({ key: 'fam:auto', label: 'Automatic routes', count: auto.length, models: auto })
  return sections
}

/**
 * `collapseVariants` walks the whole listing (1000+ rows); every picker surface asks for the same
 * collapsed list of the same store array, so remember the last answer per input array.
 */
const collapsedCache = new WeakMap<ModelInfo[], ModelInfo[]>()
export function collapseVariantsMemo(models: ModelInfo[]): ModelInfo[] {
  let out = collapsedCache.get(models)
  if (!out) {
    out = collapseVariants(models)
    collapsedCache.set(models, out)
  }
  return out
}

// ---------- model health (pings, see src/main/providers/health.ts) ----------

/** How many models the picker pings automatically when it opens (the rows it leads with). */
export const AUTO_HEALTH_LIMIT = 10
/** Ceiling on an explicit sweep, so one click can never fire hundreds of requests at a gateway. */
export const MANUAL_HEALTH_LIMIT = 40

/** Dot colour + label per health status. `unknown` is deliberately absent: it renders nothing. */
export const HEALTH_LOOK: Record<Exclude<ModelHealthStatus, 'unknown'>, { label: string; tone: string }> = {
  live: { label: 'Live', tone: 'ok' },
  slow: { label: 'Slow', tone: 'warn' },
  limited: { label: 'Limited', tone: 'warn' },
  down: { label: 'Down', tone: 'bad' }
}

/**
 * A model we pinged and found unusable right now. This — never "unknown" — is what the
 * "Healthy only" filter hides, so an unchecked catalog is never silently emptied.
 */
export function isUnhealthy(health: ModelHealth | undefined): boolean {
  return health?.status === 'down' || health?.status === 'limited'
}

/** Human latency: "820ms" / "3.4s". Empty when the ping never got far enough to time anything. */
export function fmtLatency(ms: number | undefined): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** The tooltip behind a row's health dot: what happened, how fast, why not, and how long ago. */
export function healthTitle(health: ModelHealth, now = Date.now()): string {
  const label = health.status === 'unknown' ? 'Not checked' : HEALTH_LOOK[health.status].label
  const latency = fmtLatency(health.latencyMs)
  const parts = [latency ? `${label} · ${latency}` : label]
  if (health.error) parts.push(health.error)
  parts.push(`checked ${agoLabel(now - health.checkedAt)}`)
  return parts.join(' — ')
}

/** "just now" / "40s ago" / "6m ago" — coarse on purpose; a ping's exact second means nothing. */
export function agoLabel(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000))
  if (s < 5) return 'just now'
  if (s < 90) return `${s}s ago`
  const m = Math.round(s / 60)
  return m < 60 ? `${m}m ago` : `${Math.round(m / 60)}h ago`
}

/**
 * The models worth pinging when the picker opens: the model in use, then favorites, then recents —
 * deduped, in that order of interest, capped. Never the whole catalog: a ping is a real request.
 */
export function autoHealthTargets(
  currentModel: string | undefined,
  favorites: ModelInfo[],
  quickPicks: ModelInfo[],
  limit = AUTO_HEALTH_LIMIT
): string[] {
  const ids = [currentModel, ...favorites.map((m) => m.id), ...quickPicks.map((m) => m.id)]
  return [...new Set(ids.filter((id): id is string => !!id))].slice(0, limit)
}

export interface PickerFilters {
  query: string
  caps: Record<CapKey, boolean>
  localOnly: boolean
  freeOnly: boolean
  favOnly: boolean
  /** hide models a ping found down or limited (models never pinged are always kept) */
  healthyOnly: boolean
  showExperimental: boolean
  /** 'all' or a source key (see {@link sourceKey}) */
  source: string
  sort: SortKey
}

export const DEFAULT_FILTERS: PickerFilters = {
  query: '',
  caps: { tools: false, vision: false, reasoning: false },
  localOnly: false,
  freeOnly: false,
  favOnly: false,
  healthyOnly: false,
  showExperimental: false,
  source: 'all',
  sort: 'source'
}

export interface PickerContext {
  /** the user's starred models, resolved to rows, in starring order */
  favorites: ModelInfo[]
  usageByBase: Map<string, number>
  quickPicks: QuickPicks
  /** last health ping per model id; empty until something has been pinged */
  health?: Record<string, ModelHealth>
}

/** Tokenize a search query: whitespace-split, lower-cased, empties dropped. */
export function queryTokens(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean)
}

/**
 * The filter → sections pipeline. Filters narrow the (already collapsed) list; a query yields one
 * relevance-ranked section; otherwise the sort decides the layout, and the grouped layouts
 * (source/family) lead with Favorites and Recent so the models you actually use come first.
 */
export function buildSections(models: ModelInfo[], f: PickerFilters, ctx: PickerContext): ModelSection[] {
  const tokens = queryTokens(f.query)
  const favSet = new Set(ctx.favorites.map((m) => m.id))
  const usageOf = (m: ModelInfo): number => ctx.usageByBase.get(baseStem(m.id)) ?? 0
  let list = models
  if (f.caps.tools) list = list.filter((m) => m.capabilities.tools)
  if (f.caps.vision) list = list.filter((m) => m.capabilities.vision)
  if (f.caps.reasoning) list = list.filter((m) => m.capabilities.reasoning)
  if (f.localOnly) list = list.filter(isLocal)
  if (f.freeOnly) list = list.filter(isFree)
  if (f.favOnly) list = list.filter((m) => favSet.has(m.id))
  if (f.healthyOnly) list = list.filter((m) => !isUnhealthy(ctx.health?.[m.id]))
  // Free/no-auth web bridges drown out real accounts in a 1000-model list: hidden unless revealed,
  // searched, or targeted. A starred model is always kept — starring pins it into view.
  const reveal = f.showExperimental || tokens.length > 0 || f.source !== 'all' || f.freeOnly || f.favOnly
  if (!reveal) list = list.filter((m) => !isExperimental(m) || favSet.has(m.id))
  if (f.source !== 'all') list = list.filter((m) => sourceKey(m) === f.source)

  if (tokens.length) {
    const scored = list
      .map((m) => ({ m, s: scoreModel(m, tokens) }))
      .filter((x): x is { m: ModelInfo; s: number } => x.s !== null)
      .sort((a, b) => b.s - a.s || sortByName(a.m, b.m))
      .map((x) => x.m)
    return [{ key: 'search', label: `${scored.length} result${scored.length === 1 ? '' : 's'}`, models: scored }]
  }
  if (f.sort === 'used') {
    const used = [...list].filter((m) => usageOf(m) > 0).sort((a, b) => usageOf(b) - usageOf(a) || sortByName(a, b))
    if (!used.length) return [{ key: 'used', label: 'No models used yet', models: sectionModels(list).flatMap((s) => s.models) }]
    return [{ key: 'used', label: 'Most used first', models: used, count: used.length }]
  }
  if (f.sort === 'cost-low' || f.sort === 'cost-high') {
    const priced = list.filter((m) => costOf(m) !== null)
    const unpriced = list.filter((m) => costOf(m) === null).sort(sortByName)
    priced.sort((a, b) => {
      const d = (costOf(a) ?? 0) - (costOf(b) ?? 0)
      return (f.sort === 'cost-low' ? d : -d) || sortByName(a, b)
    })
    const sections: ModelSection[] = [
      { key: 'cost', label: f.sort === 'cost-low' ? 'Cheapest first' : 'Priciest first', models: priced, count: priced.length }
    ]
    if (unpriced.length) sections.push({ key: 'unpriced', label: 'No price reported', models: unpriced, count: unpriced.length })
    return sections
  }
  if (f.sort === 'context')
    return [{ key: 'ctx', label: 'Largest context first', models: [...list].sort((a, b) => b.contextLength - a.contextLength || sortByName(a, b)), count: list.length }]
  if (f.sort === 'name') return [{ key: 'az', label: 'A–Z', models: [...list].sort(sortByName), count: list.length }]

  const lead: ModelSection[] = []
  const visible = new Set(list.map((m) => m.id))
  const favLead = f.favOnly ? [] : ctx.favorites.filter((m) => visible.has(m.id))
  if (favLead.length) lead.push({ key: 'fav', label: 'Favorites', models: favLead, count: favLead.length })
  const recent = ctx.quickPicks.picks.filter((m) => visible.has(m.id) && !favSet.has(m.id))
  if (recent.length) lead.push({ key: 'recent', label: quickPicksLabel(ctx.quickPicks), models: recent, count: recent.length })
  return [...lead, ...(f.sort === 'default' ? sectionModels(list) : sectionBySource(list))]
}

export type PickerRow =
  | { kind: 'header'; key: string; section: ModelSection; collapsed: boolean }
  | { kind: 'model'; key: string; model: ModelInfo; index: number; sectionKey: string }

/**
 * Sections → the flat row list the virtualized list renders. Collapsed sections keep their header
 * and drop their rows. `models` is the selectable list in row order (keyboard ↑/↓ walks it) and
 * each model row carries its index into it.
 */
export function flattenSections(sections: ModelSection[], collapsed: ReadonlySet<string>): { rows: PickerRow[]; models: ModelInfo[] } {
  const rows: PickerRow[] = []
  const models: ModelInfo[] = []
  for (const section of sections) {
    const isCollapsed = collapsed.has(section.key)
    rows.push({ kind: 'header', key: `h:${section.key}`, section, collapsed: isCollapsed })
    if (isCollapsed) continue
    for (const model of section.models) {
      rows.push({ kind: 'model', key: `${section.key}:${model.id}`, model, index: models.length, sectionKey: section.key })
      models.push(model)
    }
  }
  return { rows, models }
}

export const HEADER_ROW_H = 30
export const MODEL_ROW_H = 40

/** Pixel offset of each row plus the total height, for fixed-height virtualization. */
export function rowOffsets(rows: PickerRow[]): { offsets: number[]; total: number } {
  const offsets = new Array<number>(rows.length)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y
    y += rows[i]!.kind === 'header' ? HEADER_ROW_H : MODEL_ROW_H
  }
  return { offsets, total: y }
}

/** The [first, last] row indexes to render for a scroll window, with `overscan` rows either side. */
export function visibleRange(offsets: number[], total: number, scrollTop: number, viewport: number, overscan = 6): [number, number] {
  if (!offsets.length) return [0, -1]
  const top = Math.max(0, Math.min(scrollTop, total))
  const bottom = top + viewport
  // binary search the first row whose bottom edge is past `top`
  let lo = 0
  let hi = offsets.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const end = mid + 1 < offsets.length ? offsets[mid + 1]! : total
    if (end <= top) lo = mid + 1
    else hi = mid
  }
  let last = lo
  while (last + 1 < offsets.length && offsets[last + 1]! < bottom) last++
  return [Math.max(0, lo - overscan), Math.min(offsets.length - 1, last + overscan)]
}
