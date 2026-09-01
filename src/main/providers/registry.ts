import type { ModelInfo, ProviderConfig } from '@shared/types'
import { getCachedModels, setCachedModels } from '../store/eventStore'

const CACHE_TTL_MS = 10 * 60 * 1000

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
    contextLength: numberOr(raw.context_length, numberOr(raw.max_input_tokens, 128000)),
    maxOutputTokens: numberOr(raw.max_output_tokens, 16384),
    capabilities: {
      vision:
        boolOr(caps.vision, false) ||
        (Array.isArray(raw.input_modalities) && (raw.input_modalities as string[]).includes('image')),
      tools: boolOr(caps.tool_calling ?? caps.tools, false),
      reasoning: boolOr(caps.reasoning ?? caps.thinking ?? caps.supportsThinking, false),
      effortTiers: Array.isArray(caps.effort_tiers) ? (caps.effort_tiers as string[]) : []
    },
    raw
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback
}
function boolOr(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback
}
