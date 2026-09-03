import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

const modelCache = new Map<string, { models: unknown[]; fetchedAt: number }>()

vi.mock('../store/eventStore', () => ({
  getCachedModels: (providerId: string) => modelCache.get(providerId) ?? null,
  setCachedModels: (providerId: string, models: unknown[]) => {
    modelCache.set(providerId, { models, fetchedAt: Date.now() })
  }
}))

const provider: ProviderConfig = {
  id: 'omni',
  label: 'OmniRoute',
  kind: 'openai-compat',
  baseUrl: 'http://localhost:20128',
  apiKey: 'test-key',
  enabled: true
}

/** Shape OmniRoute actually returns for an `openrouter/…` route: no `pricing` block at all. */
function omniModel(id: string, root: string): Record<string, unknown> {
  return {
    id,
    object: 'model',
    owned_by: 'openrouter',
    root,
    context_length: 128000,
    capabilities: { tool_calling: true }
  }
}

/** Shape OpenRouter's own public /v1/models returns: per-token USD strings, keyed by native id. */
function openRouterModel(id: string, promptPerTok: string, completionPerTok: string): Record<string, unknown> {
  return { id, pricing: { prompt: promptPerTok, completion: completionPerTok } }
}

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body
  } as Response
}

describe('fetchModels — OpenRouter pricing backfill', () => {
  let registry: typeof import('./registry')

  beforeEach(async () => {
    vi.resetModules()
    modelCache.clear()
    registry = await import('./registry')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('backfills pricing for openrouter/ models missing it from the gateway listing', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.includes('/v1/models') && u.startsWith('http://localhost:20128')) {
        return jsonResponse({ data: [omniModel('openrouter/openai/gpt-5.6-luna', 'openai/gpt-5.6-luna')] })
      }
      if (u === 'https://openrouter.ai/api/v1/models') {
        return jsonResponse({ data: [openRouterModel('openai/gpt-5.6-luna', '0.000002', '0.000008')] })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider)

    expect(models).toHaveLength(1)
    expect(models[0]!.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8 })
    // Both the gateway listing and the OpenRouter pricing catalog were consulted.
    expect(fetchMock).toHaveBeenCalledWith('https://openrouter.ai/api/v1/models', expect.anything())
  })

  it('matches by the raw "root" field, not the routed id, for aliased/prefixed ids', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('http://localhost:20128')) {
        // Routed id carries a "~" alias marker the native OpenRouter catalog doesn't use.
        return jsonResponse({ data: [omniModel('openrouter/~openai/gpt-latest', 'openai/gpt-5.6-luna')] })
      }
      return jsonResponse({ data: [openRouterModel('openai/gpt-5.6-luna', '0.000002', '0.000008')] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider)
    expect(models[0]!.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8 })
  })

  it('does not call the OpenRouter catalog when no openrouter/ model is missing pricing', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('http://localhost:20128')) {
        return jsonResponse({
          data: [{ id: 'mac/qwen3-coder:30b', object: 'model', owned_by: 'mac', context_length: 32000 }]
        })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider)
    expect(models[0]!.pricing).toBeUndefined()
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('does not call the OpenRouter catalog when the gateway already reports pricing', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('http://localhost:20128')) {
        return jsonResponse({
          data: [
            {
              ...omniModel('openrouter/openai/gpt-5.6-luna', 'openai/gpt-5.6-luna'),
              pricing: { prompt: '0.000001', completion: '0.000003' }
            }
          ]
        })
      }
      throw new Error(`unexpected fetch: ${u}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider)
    expect(models[0]!.pricing).toEqual({ inputPerMTok: 1, outputPerMTok: 3 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('leaves pricing undefined (and does not throw) when openrouter.ai is unreachable', async () => {
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('http://localhost:20128')) {
        return jsonResponse({ data: [omniModel('openrouter/openai/gpt-5.6-luna', 'openai/gpt-5.6-luna')] })
      }
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider)
    expect(models[0]!.pricing).toBeUndefined()
  })

  it('caches the OpenRouter pricing catalog across repeated fetchModels calls', async () => {
    let openRouterCalls = 0
    const fetchMock = vi.fn(async (url: string | URL) => {
      const u = String(url)
      if (u.startsWith('http://localhost:20128')) {
        return jsonResponse({ data: [omniModel('openrouter/openai/gpt-5.6-luna', 'openai/gpt-5.6-luna')] })
      }
      openRouterCalls++
      return jsonResponse({ data: [openRouterModel('openai/gpt-5.6-luna', '0.000002', '0.000008')] })
    })
    vi.stubGlobal('fetch', fetchMock)

    await registry.fetchModels(provider, true)
    await registry.fetchModels(provider, true)

    expect(openRouterCalls).toBe(1)
  })
})

describe('probeProvider — provider reachability status', () => {
  let registry: typeof import('./registry')

  beforeEach(async () => {
    vi.resetModules()
    modelCache.clear()
    registry = await import('./registry')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reports ok + model count and warms the cache on success', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'qwen27b', owned_by: 'vllm' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const res = await registry.probeProvider(provider)

    expect(res).toEqual({ ok: true, count: 1 })
    // Cache warmed so the picker's next listModels() shows the models without another round-trip.
    expect(modelCache.get('omni')?.models).toHaveLength(1)
  })

  it('reports the HTTP status when the endpoint answers with an error', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => jsonResponse(null, false, 404)))

    const res = await registry.probeProvider(provider)

    expect(res.ok).toBe(false)
    expect(res.count).toBe(0)
    expect(res.error).toContain('404')
    expect(modelCache.has('omni')).toBe(false)
  })

  it('rejects a pasted-curl base URL up front, before any fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const res = await registry.probeProvider({
      ...provider,
      baseUrl: 'POST http://9igc8cj79e629i-8000.proxy.runpod.net/v1/chat/completions'
    })

    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/http:\/\/ or https:\/\//)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('surfaces a network failure as the error reason without throwing', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw new Error('fetch failed')
    }))

    const res = await registry.probeProvider(provider)

    expect(res.ok).toBe(false)
    expect(res.error).toBe('fetch failed')
  })
})
