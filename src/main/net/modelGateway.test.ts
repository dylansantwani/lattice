import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

// The gateway reads providers from the store and resolves a model's owner via the registry. Mock
// both so the test exercises pure routing/proxy behavior without Electron or a real DB.
const providers = [
  { id: 'p1', label: 'Primary', kind: 'openai-compat', baseUrl: '', apiKey: 'secret-key', enabled: true }
]
vi.mock('../store/eventStore', () => ({ getSettings: () => ({ providers }) }))
vi.mock('../providers/registry', () => ({
  fetchAllModels: async () => [
    { id: 'model-a', label: 'A' },
    { id: 'model-b', label: 'B' }
  ],
  providerForModel: (model: string | undefined) => (model === 'nope' ? null : providers[0])
}))

import { startModelGateway, stopModelGateway, modelGatewayStatus } from './modelGateway'

// A fake upstream OpenAI-compatible provider: records what it received, streams an SSE reply.
let upstream: Server
let upstreamUrl = ''
let lastAuth: string | undefined
let lastBody = ''

beforeAll(async () => {
  upstream = createServer((req, res) => {
    lastAuth = req.headers['authorization']
    let raw = ''
    req.on('data', (c) => (raw += c))
    req.on('end', () => {
      lastBody = raw
      res.writeHead(200, { 'content-type': 'text/event-stream' })
      res.write('data: {"choices":[{"delta":{"content":"hel"}}]}\n\n')
      res.write('data: {"choices":[{"delta":{"content":"lo"}}]}\n\n')
      res.write('data: [DONE]\n\n')
      res.end()
    })
  })
  await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r))
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`
  providers[0]!.baseUrl = upstreamUrl
  await startModelGateway(0)
})

afterAll(async () => {
  await stopModelGateway()
  await new Promise<void>((r) => upstream.close(() => r()))
})

const base = () => `http://127.0.0.1:${modelGatewayStatus().port}`

describe('model gateway', () => {
  it('reports a running status with a bound port', () => {
    expect(modelGatewayStatus().running).toBe(true)
    expect(modelGatewayStatus().port).toBeGreaterThan(0)
  })

  it('health is unauthenticated', async () => {
    const res = await fetch(`${base()}/health`)
    expect(res.status).toBe(200)
    expect(((await res.json()) as { ok: boolean }).ok).toBe(true)
  })

  it('aggregates provider models in OpenAI list shape', async () => {
    const res = await fetch(`${base()}/v1/models`)
    const body = (await res.json()) as { object: string; data: { id: string; object: string }[] }
    expect(body.object).toBe('list')
    expect(body.data.map((m) => m.id)).toEqual(['model-a', 'model-b'])
    expect(body.data[0]!.object).toBe('model')
  })

  it('proxies chat completions to the owning provider, injecting its auth, streaming back', async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'model-a', messages: [{ role: 'user', content: 'hi' }], stream: true })
    })
    expect(res.status).toBe(200)
    const text = await res.text()
    // upstream saw Lattice's provider key, not whatever the client sent
    expect(lastAuth).toBe('Bearer secret-key')
    // body forwarded verbatim
    expect(JSON.parse(lastBody).model).toBe('model-a')
    // SSE chunks piped straight through
    expect(text).toContain('hel')
    expect(text).toContain('lo')
    expect(text).toContain('[DONE]')
  })

  it('503s when no provider serves the model', async () => {
    const res = await fetch(`${base()}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'nope', messages: [] })
    })
    expect(res.status).toBe(503)
  })

  it('404s an unknown path', async () => {
    expect((await fetch(`${base()}/nope`)).status).toBe(404)
  })
})
