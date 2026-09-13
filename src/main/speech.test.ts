import { createServer, type IncomingMessage, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { listSpeechVoices, synthesizeSpeech } from './speech'

let server: Server
let base: string
let requests: Array<{ path: string; auth?: string; body: Record<string, unknown> }>
let reply: (path: string, res: import('node:http').ServerResponse) => void

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return chunks.length ? (JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>) : {}
}

beforeEach(async () => {
  requests = []
  reply = (path, res) => {
    if (path === '/v1/audio/speech') {
      res.writeHead(200, { 'content-type': 'audio/mpeg' })
      res.end(Buffer.from('ID3fake-mp3'))
      return
    }
    if (path === '/v1/audio/voices') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ voices: ['af_heart', 'am_michael'] }))
      return
    }
    res.writeHead(404)
    res.end()
  }
  server = createServer((req, res) => {
    void body(req).then((parsed) => {
      requests.push({ path: req.url ?? '', auth: req.headers.authorization, body: parsed })
      reply(req.url ?? '', res)
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}/v1`
})

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

describe('synthesizeSpeech', () => {
  it('posts an OpenAI speech request and returns base64 audio', async () => {
    const audio = await synthesizeSpeech('Hello there.', { baseUrl: `${base}/`, model: 'kokoro', voice: 'af_heart', rate: 1.25, apiKey: 'k1' })
    expect(audio).toEqual({ mime: 'audio/mpeg', base64: Buffer.from('ID3fake-mp3').toString('base64') })
    expect(requests[0]).toEqual({
      path: '/v1/audio/speech',
      auth: 'Bearer k1',
      body: { model: 'kokoro', voice: 'af_heart', input: 'Hello there.', response_format: 'mp3', speed: 1.25 }
    })
  })

  it('lets overrides win over stored settings and omits auth without a key', async () => {
    await synthesizeSpeech('Hi', { baseUrl: 'http://nowhere.invalid/v1', voice: 'x' }, { baseUrl: base, voice: 'am_michael' })
    expect(requests[0]!.auth).toBeUndefined()
    expect(requests[0]!.body.voice).toBe('am_michael')
  })

  it('surfaces the endpoint error message', async () => {
    reply = (_path, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'voice not found: zz' } }))
    }
    await expect(synthesizeSpeech('Hi', { baseUrl: base, voice: 'zz' })).rejects.toThrow('Speech synthesis failed: HTTP 400 — voice not found: zz')
  })

  it('rejects a JSON reply that is not audio', async () => {
    reply = (_path, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'model loading' }))
    }
    await expect(synthesizeSpeech('Hi', { baseUrl: base })).rejects.toThrow(/non-audio reply/)
  })

  it('explains an unreachable endpoint and refuses blank or oversized input', async () => {
    await expect(synthesizeSpeech('Hi', { baseUrl: 'http://127.0.0.1:1/v1' })).rejects.toThrow(/Could not reach the speech endpoint/)
    await expect(synthesizeSpeech('   ', { baseUrl: base })).rejects.toThrow('Nothing to read.')
    await expect(synthesizeSpeech('x'.repeat(5000), { baseUrl: base })).rejects.toThrow(/split it/)
    await expect(synthesizeSpeech('Hi', { baseUrl: 'ftp://x' })).rejects.toThrow(/http\(s\) base URL/)
  })
})

describe('the stored speech key', () => {
  it('goes to the stored endpoint only; an override pointing elsewhere gets no key unless it brings one', async () => {
    const stored = { baseUrl: base, apiKey: 'sk-real' }
    await synthesizeSpeech('Hi', stored)
    expect(requests.at(-1)!.auth).toBe('Bearer sk-real')
    await synthesizeSpeech('Hi', stored, { baseUrl: `${base}/` })
    expect(requests.at(-1)!.auth).toBe('Bearer sk-real')
    const other = base.replace('127.0.0.1', 'localhost')
    await synthesizeSpeech('Hi', stored, { baseUrl: other })
    expect(requests.at(-1)!.auth).toBeUndefined()
    await synthesizeSpeech('Hi', stored, { baseUrl: other, apiKey: 'sk-trial' })
    expect(requests.at(-1)!.auth).toBe('Bearer sk-trial')
  })
})

describe('listSpeechVoices', () => {
  it('reads a local server voice list and falls back to the OpenAI set', async () => {
    expect(await listSpeechVoices({ baseUrl: base })).toEqual(['af_heart', 'am_michael'])
    expect(await listSpeechVoices({ baseUrl: 'http://127.0.0.1:1/v1' })).toContain('alloy')
    expect(await listSpeechVoices({ baseUrl: 'https://api.openai.com/v1' })).toContain('nova')
  })
})
