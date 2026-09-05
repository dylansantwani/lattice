import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'

const modelCache = new Map<string, { models: { id: string }[]; fetchedAt: number }>()
const fakeSettings: { providers: ProviderConfig[]; modelContextOverrides: Record<string, number>; modelSourceOverrides: Record<string, string> } = {
  providers: [],
  modelContextOverrides: {},
  modelSourceOverrides: {}
}

vi.mock('../store/eventStore', () => ({
  getCachedModels: (providerId: string) => modelCache.get(providerId) ?? null,
  setCachedModels: (providerId: string, models: { id: string }[]) => {
    modelCache.set(providerId, { models, fetchedAt: Date.now() })
  },
  getSettings: () => fakeSettings
}))

import {
  checkModelHealth,
  cachedModelHealth,
  pingModel,
  resetModelHealth,
  statusForHttp,
  summarizeErrorBody,
  replyHasContent,
  PING_MAX_TOKENS,
  SLOW_MS
} from './health'

const provider: ProviderConfig = {
  id: 'omni',
  label: 'OmniRoute',
  kind: 'openai-compat',
  baseUrl: 'http://localhost:20128',
  apiKey: 'test-key',
  enabled: true
}

const ok = (): Response => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })
/** A 200 whose completion is empty — reachable, but the route produced nothing usable. */
const emptyReply = (): Response => new Response(JSON.stringify({ choices: [{ message: { content: '' } }] }), { status: 200 })
const fail = (status: number, body: unknown): Response =>
  new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })

beforeEach(() => {
  modelCache.clear()
  resetModelHealth()
  fakeSettings.providers = [provider]
  modelCache.set('omni', { models: [{ id: 'cc/claude-opus-5' }, { id: 'mac/qwen' }], fetchedAt: Date.now() })
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('pingModel', () => {
  it('sends the smallest possible completion and reports it live with a latency', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
    const health = await pingModel('cc/claude-opus-5', [provider])
    expect(health).toMatchObject({ modelId: 'cc/claude-opus-5', status: 'live', providerId: 'omni' })
    expect(health.latencyMs).toBeGreaterThanOrEqual(0)

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('http://localhost:20128/v1/chat/completions')
    const body = JSON.parse(String(init.body)) as Record<string, unknown>
    // Every optional field is one more thing a strict backend can 400 on, which would make a live
    // model look broken — so the probe sends none of them. The output budget is NOT 1: a
    // reasoning-capable model cannot answer inside one token, and the gateway then 502s a route
    // that is demonstrably working (measured against cc/claude-sonnet-5 and cc/claude-fable-5).
    expect(body).toEqual({
      model: 'cc/claude-opus-5',
      messages: [{ role: 'user', content: 'Reply with: ok' }],
      max_tokens: PING_MAX_TOKENS,
      stream: false
    })
    expect(PING_MAX_TOKENS).toBeGreaterThan(1)
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key')
  })

  it('reports a slow-but-answering route as slow, not live', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      vi.advanceTimersByTime(SLOW_MS + 500)
      return ok()
    })
    vi.useFakeTimers()
    const health = await pingModel('mac/qwen', [provider])
    expect(health.status).toBe('slow')
    expect(health.latencyMs).toBeGreaterThan(SLOW_MS)
  })

  it('reports a dead route as down, with the endpoint’s own reason', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(404, { error: { message: 'model not found: mac/qwen' } }))
    const health = await pingModel('mac/qwen', [provider])
    expect(health).toMatchObject({ status: 'down', error: 'HTTP 404 · model not found: mac/qwen' })
  })

  it('reports a 200 with an empty completion as limited, not live — reachable is not usable', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(emptyReply())
    expect(await pingModel('mac/qwen', [provider])).toMatchObject({
      status: 'limited',
      error: 'answered, but produced no output'
    })
  })

  it('reports a rate-limited route as limited — the route works, it just will not serve now', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(fail(429, { error: { message: 'rate limit exceeded' } }))
    expect((await pingModel('mac/qwen', [provider])).status).toBe('limited')
  })

  it('reports a network failure as down with a readable message', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:20128'))
    const health = await pingModel('mac/qwen', [provider])
    expect(health).toMatchObject({ status: 'down', error: 'connect ECONNREFUSED 127.0.0.1:20128' })
  })

  it('reports a model no enabled provider serves as unknown, without a request', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
    const health = await pingModel('x/y', [])
    expect(health).toMatchObject({ status: 'unknown' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('checkModelHealth', () => {
  it('pings each model once, reports results progressively, and caches them', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
    const seen: string[] = []
    const results = await checkModelHealth(['cc/claude-opus-5', 'mac/qwen', 'cc/claude-opus-5'], {
      onResult: (h) => seen.push(h.modelId)
    })
    expect(results).toHaveLength(2)
    expect(seen.sort()).toEqual(['cc/claude-opus-5', 'mac/qwen'])
    expect(fetchMock).toHaveBeenCalledTimes(2)

    // A second check inside the TTL is served from cache — reopening the picker must not re-ping.
    await checkModelHealth(['cc/claude-opus-5', 'mac/qwen'])
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(cachedModelHealth('mac/qwen')?.status).toBe('live')

    // …unless the caller explicitly asks for a fresh answer.
    await checkModelHealth(['mac/qwen'], { refresh: true })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('ignores blank ids and pings nothing for an empty set', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(ok())
    expect(await checkModelHealth(['', '   '])).toEqual([])
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('keeps a failing route from failing the batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      const body = JSON.parse(String((init as RequestInit).body)) as { model: string }
      if (body.model === 'mac/qwen') throw new Error('offline')
      return ok()
    })
    const results = await checkModelHealth(['cc/claude-opus-5', 'mac/qwen'])
    expect(results.find((r) => r.modelId === 'mac/qwen')?.status).toBe('down')
    expect(results.find((r) => r.modelId === 'cc/claude-opus-5')?.status).toBe('live')
  })
})

describe('error reporting helpers', () => {
  it('classifies HTTP statuses', () => {
    expect(statusForHttp(429)).toBe('limited')
    expect(statusForHttp(400)).toBe('limited')
    expect(statusForHttp(401)).toBe('down')
    expect(statusForHttp(500)).toBe('down')
  })

  it('pulls the human message out of the shapes gateways actually return', () => {
    expect(summarizeErrorBody('{"error":{"message":"upstream timeout"}}')).toBe('upstream timeout')
    expect(summarizeErrorBody('{"error":"bad key"}')).toBe('bad key')
    expect(summarizeErrorBody('{"message":"nope"}')).toBe('nope')
    expect(summarizeErrorBody('  plain text  ')).toBe('plain text')
    expect(summarizeErrorBody('')).toBe('')
    expect(summarizeErrorBody(`{"error":{"message":"${'x'.repeat(300)}"}}`)).toHaveLength(158)
  })
})

describe('replyHasContent', () => {
  it('recognizes a model that actually said something', () => {
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }))).toBe(true)
    expect(replyHasContent(JSON.stringify({ choices: [{ text: 'ok' }] }))).toBe(true)
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { content: [{ type: 'text', text: 'ok' }] } }] }))).toBe(true)
    // Budget spent on hidden reasoning still means the route answered.
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { reasoning_content: 'hmm' } }] }))).toBe(true)
  })

  it('recognizes an empty completion', () => {
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { content: '' } }] }))).toBe(false)
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { content: '   ' } }] }))).toBe(false)
    expect(replyHasContent(JSON.stringify({ choices: [{ message: { content: [] } }] }))).toBe(false)
  })

  it('gives an unfamiliar or unparseable 200 the benefit of the doubt', () => {
    // Mislabelling a working route as unhealthy is the failure this module exists to avoid.
    expect(replyHasContent('not json at all')).toBe(true)
    expect(replyHasContent(JSON.stringify({ ok: true }))).toBe(true)
    expect(replyHasContent('')).toBe(true)
  })
})
