import type { ModelInfo, ModelPricing, ProviderConfig, ProviderProbe } from '@shared/types'
import { getCachedModels, setCachedModels } from '../store/eventStore'

const CACHE_TTL_MS = 10 * 60 * 1000

/**
 * Fetch and merge models from every enabled provider, in provider order. When two providers
 * expose the same model id, the FIRST enabled provider wins — matching `providerForModel`, so
 * the picker and the request path always agree on who serves a given id. A provider that fails
 * to respond contributes nothing rather than failing the whole listing.
 */
export async function fetchAllModels(providers: ProviderConfig[], refresh = false): Promise<ModelInfo[]> {
  const enabled = providers.filter((p) => p.enabled)
  const lists = await Promise.all(enabled.map((p) => fetchModels(p, refresh).catch(() => [] as ModelInfo[])))
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const models of lists) {
    for (const m of models) {
      if (seen.has(m.id)) continue
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

/**
 * Which enabled provider serves this model id, judged by each provider's cached /v1/models
 * listing (fetched at startup / picker refresh, so normally warm). Falls back to the first
 * enabled provider when no cached listing claims the id — the single-provider behavior.
 */
export function providerForModel(model: string | undefined, providers: ProviderConfig[]): ProviderConfig | null {
  const enabled = providers.filter((p) => p.enabled)
  if (enabled.length === 0) return null
  if (model && enabled.length > 1) {
    for (const p of enabled) {
      if (getCachedModels(p.id)?.models.some((m) => m.id === model)) return p
    }
    // No cached listing claims the id. Kick a background refresh for any cold cache so the NEXT
    // resolution can route correctly (e.g. a provider added seconds ago), then fall through.
    for (const p of enabled) {
      if (!getCachedModels(p.id)) void fetchModels(p).catch(() => {})
    }
  }
  return enabled[0]!
}

/** Fetch and normalize /v1/models from an OpenAI-compatible provider. */
export async function fetchModels(provider: ProviderConfig, refresh = false): Promise<ModelInfo[]> {
  if (!refresh) {
    const cached = getCachedModels(provider.id)
    if (cached && Date.now() - cached.fetchedAt < CACHE_TTL_MS) return cached.models
  }
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/models`, {
      headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) throw new Error(`models fetch failed: HTTP ${res.status}`)
    const json = (await res.json()) as { data?: unknown[] }
    const models = (json.data ?? []).map((m) => normalizeModel(m as Record<string, unknown>, provider))
    await enrichOpenRouterPricing(models)
    setCachedModels(provider.id, models)
    return models
  } catch (err) {
    // fall back to stale cache when the gateway is unreachable
    const cached = getCachedModels(provider.id)
    if (cached) return cached.models
    throw err
  }
}

/**
 * Live-probe ONE provider's `/v1/models` and report what actually happened, so a bad base URL or a
 * dead endpoint surfaces in the UI instead of silently contributing zero models (as it does in
 * {@link fetchAllModels}, which swallows per-provider errors). Always hits the network (never a cached
 * hit), and on success warms the same cache the picker reads — so a probe doubles as a manual refetch.
 */
export async function probeProvider(provider: ProviderConfig): Promise<ProviderProbe> {
  try {
    const url = `${provider.baseUrl.replace(/\/$/, '')}/v1/models`
    // Catch a pasted-curl base URL ("POST http://…/v1/chat/completions") before fetch throws a
    // terse "Failed to parse URL", which reads as a network error rather than a config mistake.
    if (!/^https?:\/\//i.test(url)) {
      return { ok: false, count: 0, error: `Base URL must start with http:// or https:// (got "${provider.baseUrl}")` }
    }
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${provider.apiKey}`, ...provider.headers },
      signal: AbortSignal.timeout(15000)
    })
    if (!res.ok) return { ok: false, count: 0, error: `HTTP ${res.status}${res.statusText ? ` ${res.statusText}` : ''}` }
    const json = (await res.json()) as { data?: unknown[] }
    const models = (json.data ?? []).map((m) => normalizeModel(m as Record<string, unknown>, provider))
    await enrichOpenRouterPricing(models)
    setCachedModels(provider.id, models)
    return { ok: true, count: models.length }
  } catch (err) {
    return { ok: false, count: 0, error: probeErrorMessage(err) }
  }
}

/** A short, human failure reason for a probe: abort → timeout, else the error's own message. */
function probeErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') return 'timed out (no response in 15s)'
  if (err instanceof Error) return err.message
  return String(err)
}

function normalizeModel(raw: Record<string, unknown>, provider?: ProviderConfig): ModelInfo {
  const id = String(raw.id ?? '')
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    provider: id.includes('/') ? id.split('/')[0]! : 'default',
    ownedBy: typeof raw.owned_by === 'string' && raw.owned_by ? raw.owned_by : undefined,
    parent: typeof raw.parent === 'string' && raw.parent ? raw.parent : undefined,
    providerId: provider?.id,
    providerLabel: provider?.label,
    contextLength: numberOr(raw.context_length, numberOr(raw.max_input_tokens, 128000)),
    maxOutputTokens: numberOr(raw.max_output_tokens, 16384),
    capabilities: {
      vision:
        boolOr(caps.vision, false) ||
        (Array.isArray(raw.input_modalities) && (raw.input_modalities as string[]).includes('image')),
      // Default to tool-capable when the gateway omits the flag. Tools are always sent
      // and modern models handle them; a false-y default previously hid real capability.
      tools: boolOr(caps.tool_calling ?? caps.tools, true),
      reasoning: boolOr(caps.reasoning ?? caps.thinking ?? caps.supportsThinking, false),
      // The gateway names the ladder differently per source (`effort_tiers`, and for routes it
      // probes itself `supportedReasoningEfforts` / `supported_reasoning_efforts`); take any of them.
      effortTiers: firstStringList(
        caps.effort_tiers,
        caps.supportedReasoningEfforts,
        caps.supported_reasoning_efforts,
        raw.supportedReasoningEfforts,
        raw.supported_reasoning_efforts
      )
    },
    pricing: parsePricing(raw),
    raw
  }
}

/** The first candidate that is a non-empty array of strings, else []. */
function firstStringList(...candidates: unknown[]): string[] {
  for (const c of candidates) {
    if (Array.isArray(c) && c.length && c.every((x) => typeof x === 'string')) return c as string[]
  }
  return []
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}

/** A price that may arrive as a number or a numeric string ("0.000003"). Negatives/NaN → null. */
function priceNum(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN
  return Number.isFinite(n) && n >= 0 ? n : null
}

/**
 * Normalize provider pricing to USD per *million* tokens. Gateways disagree on shape:
 *  - OpenRouter: `pricing: { prompt, completion }` as per-token USD strings.
 *  - LiteLLM:    `input_cost_per_token` / `output_cost_per_token` as per-token USD numbers.
 *  - Some:       `pricing: { input, output }` already per-million, or per-token — we detect
 *                by magnitude (per-token prices are tiny, < 0.01), scaling up when so.
 * Returns undefined when no usable price is present (common for local models).
 */
function parsePricing(raw: Record<string, unknown>): ModelPricing | undefined {
  const p = (raw.pricing ?? {}) as Record<string, unknown>
  const inRaw =
    priceNum(p.prompt) ?? priceNum(p.input) ?? priceNum(raw.input_cost_per_token)
  const outRaw =
    priceNum(p.completion) ?? priceNum(p.output) ?? priceNum(raw.output_cost_per_token)
  if (inRaw === null && outRaw === null) return undefined
  const toPerMTok = (n: number | null): number => {
    if (n === null || n === 0) return 0
    // Per-token prices are fractions of a cent; anything below 0.01 is per-token, scale ×1e6.
    return n < 0.01 ? n * 1_000_000 : n
  }
  return { inputPerMTok: toPerMTok(inRaw), outputPerMTok: toPerMTok(outRaw) }
}

const OPENROUTER_MODELS_URL = 'https://openrouter.ai/api/v1/models'
/** Pricing barely moves; cache far longer than the model listing itself to avoid a network
 *  round-trip to openrouter.ai on every /v1/models refresh. */
const OPENROUTER_PRICING_TTL_MS = 60 * 60 * 1000

let openRouterPricingCache: { byId: Map<string, ModelPricing>; fetchedAt: number } | null = null

/**
 * Fetch OpenRouter's own public, unauthenticated model list purely for its `pricing` field,
 * keyed by OpenRouter's native model id (e.g. "openai/gpt-5.6-luna"). Needed because a proxying
 * gateway (e.g. OmniRoute) that re-exposes OpenRouter's catalog under an `openrouter/` prefix
 * commonly drops the `pricing` block from its own `/v1/models` — {@link enrichOpenRouterPricing}
 * fills it back in so cost estimation still works for those routes.
 */
async function fetchOpenRouterPricing(): Promise<Map<string, ModelPricing>> {
  if (openRouterPricingCache && Date.now() - openRouterPricingCache.fetchedAt < OPENROUTER_PRICING_TTL_MS) {
    return openRouterPricingCache.byId
  }
  try {
    const res = await fetch(OPENROUTER_MODELS_URL, { signal: AbortSignal.timeout(15000) })
    if (!res.ok) throw new Error(`openrouter pricing fetch failed: HTTP ${res.status}`)
    const json = (await res.json()) as { data?: Record<string, unknown>[] }
    const byId = new Map<string, ModelPricing>()
    for (const m of json.data ?? []) {
      const id = typeof m.id === 'string' ? m.id : undefined
      if (!id) continue
      const pricing = parsePricing(m)
      if (pricing) byId.set(id, pricing)
    }
    openRouterPricingCache = { byId, fetchedAt: Date.now() }
    return byId
  } catch {
    // Unreachable/rate-limited: keep serving a stale cache if we have one rather than blocking
    // the whole /v1/models fetch on openrouter.ai being up.
    return openRouterPricingCache?.byId ?? new Map()
  }
}

/**
 * Backfill `pricing` on any already-normalized `openrouter/…` model that came back from the
 * gateway with none, using OpenRouter's own catalog as the price source. Mutates in place.
 * No-op (and no network call) when every openrouter model already carries pricing.
 */
async function enrichOpenRouterPricing(models: ModelInfo[]): Promise<void> {
  const unpriced = models.filter((m) => m.provider === 'openrouter' && !m.pricing)
  if (unpriced.length === 0) return
  const pricing = await fetchOpenRouterPricing()
  if (pricing.size === 0) return
  for (const m of unpriced) {
    const raw = m.raw as Record<string, unknown> | undefined
    const nativeId = typeof raw?.root === 'string' && raw.root ? raw.root : m.id.replace(/^openrouter\//, '')
    const p = pricing.get(nativeId)
    if (p) m.pricing = p
  }
}
