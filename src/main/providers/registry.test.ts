import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

const modelCache = new Map<string, { models: unknown[]; fetchedAt: number }>()
// Mutable stand-in for the persisted settings the registry reads (context overrides + provider list
// for the cache lookup). Tests reset it in beforeEach and set overrides where they exercise them.
const fakeSettings: {
  modelContextOverrides: Record<string, number>
  modelSourceOverrides: Record<string, string>
  providers: { id: string }[]
} = {
  modelContextOverrides: {},
  modelSourceOverrides: {},
  providers: [{ id: 'omni' }]
}

vi.mock('../store/eventStore', () => ({
  getCachedModels: (providerId: string) => modelCache.get(providerId) ?? null,
  setCachedModels: (providerId: string, models: unknown[]) => {
    modelCache.set(providerId, { models, fetchedAt: Date.now() })
  },
  getSettings: () => fakeSettings
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
    fakeSettings.modelContextOverrides = {}
    fakeSettings.modelSourceOverrides = {}
    fakeSettings.providers = [{ id: 'omni' }]
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
    fakeSettings.modelContextOverrides = {}
    fakeSettings.modelSourceOverrides = {}
    fakeSettings.providers = [{ id: 'omni' }]
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

describe('applyContextOverrides / cachedContextLength — per-model context window correction', () => {
  let registry: typeof import('./registry')

  beforeEach(async () => {
    vi.resetModules()
    modelCache.clear()
    fakeSettings.modelContextOverrides = {}
    fakeSettings.modelSourceOverrides = {}
    fakeSettings.providers = [{ id: 'omni' }]
    registry = await import('./registry')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('overwrites the gateway-reported window with the configured override at fetch time', async () => {
    fakeSettings.modelContextOverrides = { 'llamacpp/qwen3.6-35b-a3b': 65536 }
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          // Gateway advertises no context_length → would default to 128000 without the override.
          { id: 'llamacpp/qwen3.6-35b-a3b', object: 'model', owned_by: 'llamacpp' },
          { id: 'cc/claude-fable-5', object: 'model', owned_by: 'claude', context_length: 200000 }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider, true)

    expect(models.find((m) => m.id === 'llamacpp/qwen3.6-35b-a3b')!.contextLength).toBe(65536)
    // A model without an override keeps whatever the gateway reported.
    expect(models.find((m) => m.id === 'cc/claude-fable-5')!.contextLength).toBe(200000)
    // The corrected figure is what got cached, so every downstream reader agrees.
    expect(registry.cachedContextLength('llamacpp/qwen3.6-35b-a3b')).toBe(65536)
  })

  it('ignores a non-positive / non-finite override', async () => {
    fakeSettings.modelContextOverrides = { 'x/model': 0, 'y/model': Number.NaN }
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'x/model', owned_by: 'vllm', context_length: 40000 },
          { id: 'y/model', owned_by: 'vllm', context_length: 50000 }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider, true)
    expect(models.find((m) => m.id === 'x/model')!.contextLength).toBe(40000)
    expect(models.find((m) => m.id === 'y/model')!.contextLength).toBe(50000)
  })

  it('cachedContextLength returns undefined for an unknown id (cold cache)', () => {
    expect(registry.cachedContextLength('nope/unknown')).toBeUndefined()
    expect(registry.cachedContextLength(undefined)).toBeUndefined()
  })

  it('reassigns a model to its configured source group by overwriting owned_by', async () => {
    fakeSettings.modelSourceOverrides = { 'llamacpp/qwen3.6-35b-a3b': 'pc5080' }
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        data: [
          // Gateway reports the generic "llamacpp" runtime; the override files it under the 5080 rig.
          { id: 'llamacpp/qwen3.6-35b-a3b', object: 'model', owned_by: 'llamacpp' },
          { id: 'mac/qwen3', object: 'model', owned_by: 'mac' }
        ]
      })
    )
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider, true)
    expect(models.find((m) => m.id === 'llamacpp/qwen3.6-35b-a3b')!.ownedBy).toBe('pc5080')
    // A model without an override keeps its reported backend.
    expect(models.find((m) => m.id === 'mac/qwen3')!.ownedBy).toBe('mac')
  })

  it('applies a source override to alias routes whose parent is overridden', async () => {
    fakeSettings.modelSourceOverrides = { 'llamacpp/qwen3.6-35b-a3b': 'pc5080' }
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'llamacpp/qwen3.6-35b-a3b', owned_by: 'llama-cpp', capabilities: {} },
          { id: 'llama-cpp/qwen3.6-35b-a3b', owned_by: 'llama-cpp', parent: 'llamacpp/qwen3.6-35b-a3b', capabilities: {} },
          { id: 'llama-cpp/other', owned_by: 'llama-cpp', capabilities: {} }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models.map((m) => m.ownedBy)).toEqual(['pc5080', 'pc5080', 'llama-cpp'])
  })

  it('ignores an empty / non-string source override', async () => {
    fakeSettings.modelSourceOverrides = { 'a/b': '' }
    const fetchMock = vi.fn(async () => jsonResponse({ data: [{ id: 'a/b', owned_by: 'vllm' }] }))
    vi.stubGlobal('fetch', fetchMock)

    const models = await registry.fetchModels(provider, true)
    expect(models[0]!.ownedBy).toBe('vllm')
  })
})

describe('modelKind — keeping non-chat catalog entries out of the thread picker', () => {
  let registry: typeof import('./registry')

  beforeEach(async () => {
    vi.resetModules()
    modelCache.clear()
    fakeSettings.modelContextOverrides = {}
    fakeSettings.modelSourceOverrides = {}
    fakeSettings.providers = [{ id: 'omni' }]
    registry = await import('./registry')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads an explicit gateway type', () => {
    expect(registry.modelKind({ type: 'image' })).toBe('image')
    expect(registry.modelKind({ type: 'embeddings' })).toBe('embedding')
    expect(registry.modelKind({ type: 'rerank' })).toBe('rerank')
    expect(registry.modelKind({ type: 'tts' })).toBe('audio')
    expect(registry.modelKind({ type: 'video' })).toBe('video')
  })

  it('falls back to output modalities that exclude text', () => {
    expect(registry.modelKind({ output_modalities: ['image'] })).toBe('image')
    expect(registry.modelKind({ output_modalities: ['text', 'image'] })).toBe('chat')
  })

  it('treats a plain or unknown listing as chat, never hiding it', () => {
    expect(registry.modelKind({})).toBe('chat')
    expect(registry.modelKind({ type: 'something-new' })).toBe('chat')
  })

  it('stamps the kind onto every fetched model', async () => {
    modelCache.clear()
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          { id: 'x/chat', owned_by: 'x', capabilities: {} },
          { id: 'x/paint', owned_by: 'x', type: 'image', capabilities: {} }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models.map((m) => [m.id, m.kind])).toEqual([
      ['x/chat', 'chat'],
      ['x/paint', 'image']
    ])
  })
})

describe('parsePricing extras — cached and reasoning rates', () => {
  let registry: typeof import('./registry')

  beforeEach(async () => {
    vi.resetModules()
    modelCache.clear()
    fakeSettings.modelContextOverrides = {}
    fakeSettings.modelSourceOverrides = {}
    fakeSettings.providers = [{ id: 'omni' }]
    registry = await import('./registry')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('keeps a gateway-reported cached-input and reasoning rate alongside the headline prices', async () => {
    modelCache.clear()
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'x/priced',
            owned_by: 'x',
            capabilities: {},
            pricing: { input: 2, output: 8, cached: 1, reasoning: 12, cache_creation: 2 }
          },
          {
            id: 'x/pertoken',
            owned_by: 'x',
            capabilities: {},
            pricing: { prompt: '0.000003', completion: '0.000015', input_cache_read: '0.0000003' }
          }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models[0]!.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8, cachedInputPerMTok: 1, reasoningPerMTok: 12 })
    expect(models[1]!.pricing).toEqual({ inputPerMTok: 3, outputPerMTok: 15, cachedInputPerMTok: 0.3 })
  })

  it('does not misread a sub-cent per-MTok cached rate as per-token (deepseek-v4-flash regression)', async () => {
    // OmniRoute reports $/MTok; the old per-field magnitude test scaled `cached: 0.007` ×1e6 into
    // a $7000/MTok cached rate while leaving the headline 0.22/0.66 alone. The unit decision must
    // come from the headline rates and apply to the whole block.
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'deepseek/deepseek-v4-flash',
            owned_by: 'deepseek',
            capabilities: {},
            pricing: { input: 0.22, output: 0.66, cached: 0.007, reasoning: 0.66, cache_creation: 0.22 }
          }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models[0]!.pricing).toEqual({
      inputPerMTok: 0.22,
      outputPerMTok: 0.66,
      cachedInputPerMTok: 0.007,
      reasoningPerMTok: 0.66
    })
  })

  it('scales LiteLLM per-token numbers ×1e6, cached rate included', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'x/litellm',
            owned_by: 'x',
            capabilities: {},
            input_cost_per_token: 0.0000022,
            output_cost_per_token: 0.0000066,
            cache_read_input_token_cost: 0.00000007
          }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models[0]!.pricing).toEqual({
      inputPerMTok: expect.closeTo(2.2, 6),
      outputPerMTok: expect.closeTo(6.6, 6),
      cachedInputPerMTok: expect.closeTo(0.07, 6)
    })
  })

  it('still detects per-token magnitude on the ambiguous input/output shape and scales uniformly', async () => {
    globalThis.fetch = vi.fn(async () =>
      jsonResponse({
        data: [
          {
            id: 'x/ambiguous-pertoken',
            owned_by: 'x',
            capabilities: {},
            pricing: { input: 0.000002, output: 0.000008, cached: 0.0000005 }
          }
        ]
      })
    ) as unknown as typeof fetch
    const models = await registry.fetchModels(provider, true)
    expect(models[0]!.pricing).toEqual({
      inputPerMTok: expect.closeTo(2, 6),
      outputPerMTok: expect.closeTo(8, 6),
      cachedInputPerMTok: expect.closeTo(0.5, 6)
    })
  })
})
