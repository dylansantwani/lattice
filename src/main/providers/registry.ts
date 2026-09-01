import type { ModelInfo, ModelPricing, ProviderConfig } from '@shared/types'
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
    const models = (json.data ?? []).map((m) => normalizeModel(m as Record<string, unknown>))
    setCachedModels(provider.id, models)
    return models
  } catch (err) {
    // fall back to stale cache when the gateway is unreachable
    const cached = getCachedModels(provider.id)
    if (cached) return cached.models
    throw err
  }
}

function normalizeModel(raw: Record<string, unknown>): ModelInfo {
  const id = String(raw.id ?? '')
  const caps = (raw.capabilities ?? {}) as Record<string, unknown>
  return {
    id,
    name: typeof raw.name === 'string' && raw.name ? raw.name : id,
    provider: id.includes('/') ? id.split('/')[0]! : 'default',
    ownedBy: typeof raw.owned_by === 'string' && raw.owned_by ? raw.owned_by : undefined,
    parent: typeof raw.parent === 'string' && raw.parent ? raw.parent : undefined,
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
      effortTiers: Array.isArray(caps.effort_tiers) ? (caps.effort_tiers as string[]) : []
    },
    pricing: parsePricing(raw),
    raw
  }
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
