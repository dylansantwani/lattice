/**
 * Local OpenAI-compatible model gateway.
 *
 * Fronts every provider Lattice has configured behind a single loopback endpoint so other local
 * tools — notably the OpenDesign app's BYOK/opencode agent — can generate through *Lattice's*
 * models without re-entering keys or base URLs. Lattice stays the single source of truth for model
 * routing: the gateway aggregates each enabled provider's `/v1/models` into one catalog, and for a
 * chat request it resolves which provider owns the requested model id (via {@link providerForModel})
 * and proxies the request there with that provider's upstream auth injected.
 *
 * It is a faithful passthrough, not a re-implementation: the client already sends a valid
 * OpenAI-compatible body (including `stream: true`), so we forward the bytes verbatim and only swap
 * in the `Authorization` header + the provider's default headers. Streaming responses (SSE) are
 * piped straight back, so token-by-token generation reaches the caller unbuffered.
 *
 * Endpoints (loopback only, no auth — single-user machine, same trust model as the OpenDesign
 * daemon it talks to):
 *   GET  /health             → { ok: true, port }
 *   GET  /v1/models          → { object: 'list', data: [{ id, object: 'model', … }] }
 *   POST /v1/chat/completions → proxied to the owning provider, response streamed back
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { getSettings } from '../store/eventStore'
import { fetchAllModels, providerForModel } from '../providers/registry'

/** Fixed default so the OpenDesign provider preset (a static base URL) stays valid across launches. */
export const DEFAULT_GATEWAY_PORT = 8917

const MAX_BODY_BYTES = 16 * 1024 * 1024

let server: Server | null = null
let currentPort = 0

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'cache-control': 'no-store'
  })
  res.end(text)
}

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('request body too large')
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks)
}

/** Proxy a chat/completions request to the provider that owns the requested model, streaming back. */
async function proxyChatCompletions(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const raw = await readRawBody(req)
  let model: string | undefined
  try {
    model = (JSON.parse(raw.toString('utf8')) as { model?: string }).model
  } catch {
    return json(res, 400, { error: { message: 'invalid JSON body' } })
  }

  const providers = getSettings().providers
  const provider = providerForModel(model, providers)
  if (!provider) {
    return json(res, 503, {
      error: { message: `no enabled Lattice provider serves model ${model ?? '(unspecified)'}` }
    })
  }

  let upstream: Response
  try {
    upstream = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers
      },
      body: raw
    })
  } catch (e) {
    return json(res, 502, {
      error: { message: `upstream ${provider.label} unreachable: ${(e as Error).message}` }
    })
  }

  res.writeHead(upstream.status, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    'cache-control': 'no-store'
  })
  if (!upstream.body) {
    res.end()
    return
  }
  // Pipe the (possibly SSE) response straight through so streamed tokens are not buffered.
  const reader = upstream.body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (value) res.write(Buffer.from(value))
    }
  } finally {
    res.end()
  }
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const path = new URL(req.url || '/', 'http://localhost').pathname

  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { ok: true, port: currentPort })
  }

  // Accept both the /v1-prefixed and bare forms; opencode/OpenAI clients vary.
  if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
    const models = await fetchAllModels(getSettings().providers).catch(() => [])
    return json(res, 200, {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: Math.floor(Date.now() / 1000),
        owned_by: 'lattice'
      }))
    })
  }

  if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
    return proxyChatCompletions(req, res)
  }

  json(res, 404, { error: { message: 'not found' } })
}

/** Start the gateway on `port` (loopback). Idempotent-ish: stops any existing instance first. */
export async function startModelGateway(
  port = Number(process.env.LATTICE_GATEWAY_PORT) || DEFAULT_GATEWAY_PORT,
  host = '127.0.0.1'
): Promise<number> {
  await stopModelGateway()
  await new Promise<void>((resolve, reject) => {
    const s = createServer((req, res) => {
      handleRequest(req, res).catch((e) => {
        try {
          json(res, 500, { error: { message: (e as Error).message } })
        } catch {
          /* response already started */
        }
      })
    })
    s.on('error', reject)
    s.listen(port, host, () => {
      server = s
      const addr = s.address()
      currentPort = typeof addr === 'object' && addr ? addr.port : port
      resolve()
    })
  })
  return currentPort
}

export async function stopModelGateway(): Promise<void> {
  if (!server) return
  const s = server
  server = null
  currentPort = 0
  await new Promise<void>((resolve) => s.close(() => resolve()))
}

export function modelGatewayStatus(): { running: boolean; port: number } {
  return { running: !!server, port: currentPort }
}
