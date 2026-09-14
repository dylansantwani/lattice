/**
 * The remote bridge HTTP + WebSocket server.
 *
 * Exposes the existing LatticeApi over the network for the Lattice iOS app:
 *   GET  /health            → { ok, protocol, subscribers }        (no auth)
 *   POST /auth              → { token, expiresAt }                  (password → device token)
 *   POST /rpc/<method>      → { ok, result } | { ok:false, error }  (bearer; method ∈ API_METHODS)
 *   WS   /events            → stream of PushEvent JSON              (bearer; heartbeat)
 *   POST /push-token        → { ok }                                (bearer; register APNs token — P1 stub)
 *
 * Binds loopback only. A local reverse tunnel / cloudflared publishes it at the public hostname.
 * Auth and secret redaction live in ./auth.ts and ./bridge.ts; this file is just transport.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { gzipSync } from 'node:zlib'
import { WebSocketServer, type WebSocket } from 'ws'
import { API_METHODS, type PushEvent } from '@shared/ipc'
import { dispatch, subscribe, subscriberCount, UnknownMethodError } from './bridge'
import { allowAuthAttempt, authenticate, hasPassword, verifyToken } from './auth'

export const PROTOCOL_VERSION = 1

const MAX_BODY_BYTES = 32 * 1024 * 1024 // 32MB — image data URLs in tool results can be large
const HEARTBEAT_MS = 30_000

let server: Server | null = null
let wss: WebSocketServer | null = null
let heartbeat: ReturnType<typeof setInterval> | null = null
let currentPort = 0

// APNs device tokens registered by clients (used by ../notify wiring in a later pass).
const pushTokens = new Set<string>()
export function registeredPushTokens(): string[] {
  return [...pushTokens]
}

/** Bodies at or above this size are gzipped when the client accepts it. A thread view or a model
 *  catalog is JSON that shrinks 4–8×; below this the header overhead is not worth it. */
const GZIP_MIN_BYTES = 1024

function json(res: ServerResponse, status: number, body: unknown, req?: IncomingMessage): void {
  const text = JSON.stringify(body)
  const bytes = Buffer.byteLength(text)
  const accept = req?.headers['accept-encoding']
  const wantsGzip = typeof accept === 'string' && /\bgzip\b/.test(accept)
  if (wantsGzip && bytes >= GZIP_MIN_BYTES) {
    // The bridge is published through a tunnel on the Mac's uplink; every byte saved here is a byte
    // not sent upstream. URLSession and browsers decompress transparently.
    const gz = gzipSync(text, { level: 6 })
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-encoding': 'gzip',
      'content-length': gz.length,
      'cache-control': 'no-store',
      vary: 'accept-encoding'
    })
    res.end(gz)
    return
  }
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': bytes,
    'cache-control': 'no-store'
  })
  res.end(text)
}

function clientIp(req: IncomingMessage): string {
  return (req.socket.remoteAddress || 'unknown').replace(/^::ffff:/, '')
}

function bearer(req: IncomingMessage): string | undefined {
  const h = req.headers['authorization']
  if (typeof h === 'string' && h.startsWith('Bearer ')) return h.slice(7).trim()
  return undefined
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    total += (chunk as Buffer).length
    if (total > MAX_BODY_BYTES) throw new Error('body too large')
    chunks.push(chunk as Buffer)
  }
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'))
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url || '/', 'http://localhost')
  const path = url.pathname

  // Health is unauthenticated so the tunnel/monitor can probe liveness.
  if (req.method === 'GET' && path === '/health') {
    return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, subscribers: subscriberCount() })
  }

  if (req.method === 'POST' && path === '/auth') {
    const ip = clientIp(req)
    if (!allowAuthAttempt(ip)) return json(res, 429, { ok: false, error: { message: 'too many attempts' } })
    if (!hasPassword()) return json(res, 403, { ok: false, error: { message: 'remote access has no password set' } })
    let body: { password?: string; device?: string }
    try {
      body = (await readBody(req)) as typeof body
    } catch {
      return json(res, 400, { ok: false, error: { message: 'bad request body' } })
    }
    const result = authenticate(String(body.password ?? ''), String(body.device ?? ''))
    if (!result) return json(res, 401, { ok: false, error: { message: 'invalid password' } })
    return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, ...result })
  }

  // Everything below requires a valid device token.
  const device = verifyToken(bearer(req))
  if (!device) return json(res, 401, { ok: false, error: { message: 'unauthorized' } })

  if (req.method === 'POST' && path.startsWith('/rpc/')) {
    const method = decodeURIComponent(path.slice('/rpc/'.length))
    if (!API_METHODS.includes(method as never)) {
      return json(res, 404, { ok: false, error: { message: `unknown method: ${method}` } })
    }
    let body: { args?: unknown[] }
    try {
      body = (await readBody(req)) as typeof body
    } catch (e) {
      return json(res, 400, { ok: false, error: { message: (e as Error).message } })
    }
    const args = Array.isArray(body.args) ? body.args : []
    try {
      const result = await dispatch(method, args)
      return json(res, 200, { ok: true, protocol: PROTOCOL_VERSION, result: result ?? null }, req)
    } catch (e) {
      if (e instanceof UnknownMethodError) return json(res, 404, { ok: false, error: { message: e.message } })
      const err = e as Error & { category?: string }
      return json(res, 500, {
        ok: false,
        error: { message: err.message || 'internal error', code: err.category }
      })
    }
  }

  if (req.method === 'POST' && path === '/push-token') {
    try {
      const body = (await readBody(req)) as { token?: string }
      if (body.token) pushTokens.add(String(body.token))
      return json(res, 200, { ok: true })
    } catch {
      return json(res, 400, { ok: false, error: { message: 'bad request body' } })
    }
  }

  json(res, 404, { ok: false, error: { message: 'not found' } })
}

function attachWebSocket(httpServer: Server): void {
  wss = new WebSocketServer({ noServer: true })

  httpServer.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '/', 'http://localhost')
    if (url.pathname !== '/events') {
      socket.destroy()
      return
    }
    // Token may arrive as a Bearer header (native clients set it on the upgrade) or as ?token=
    // (fallback for clients that cannot set upgrade headers).
    const token = bearer(req) || url.searchParams.get('token') || undefined
    if (!verifyToken(token)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n')
      socket.destroy()
      return
    }
    wss!.handleUpgrade(req, socket, head, (ws) => {
      wss!.emit('connection', ws, req)
    })
  })

  wss.on('connection', (ws: WebSocket) => {
    ;(ws as WebSocket & { isAlive: boolean }).isAlive = true
    ws.send(JSON.stringify({ kind: 'hello', protocol: PROTOCOL_VERSION }))

    const unsubscribe = subscribe((event: PushEvent) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(event))
    })

    ws.on('message', (data) => {
      // Clients only send keepalive pings; ignore anything else. All mutations go over RPC.
      try {
        const msg = JSON.parse(data.toString())
        if (msg?.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
      } catch {
        /* ignore malformed client frames */
      }
    })
    ws.on('pong', () => {
      ;(ws as WebSocket & { isAlive: boolean }).isAlive = true
    })
    ws.on('close', unsubscribe)
    ws.on('error', unsubscribe)
  })

  // Drop sockets that stop answering heartbeats so a sleeping phone doesn't leak a subscriber.
  heartbeat = setInterval(() => {
    for (const ws of wss!.clients) {
      const alive = ws as WebSocket & { isAlive: boolean }
      if (!alive.isAlive) {
        ws.terminate()
        continue
      }
      alive.isAlive = false
      try {
        ws.ping()
      } catch {
        /* terminated between checks */
      }
    }
  }, HEARTBEAT_MS)
}

export interface BridgeStatus {
  running: boolean
  port: number
  subscribers: number
  control?: { path: string; connections: number }
}

let controlStatus: { path: string; connections: number | (() => number) } | undefined

/** Main-process lifecycle wiring reports the local control socket without coupling this server to it. */
export function setControlStatus(status: { path: string; connections: number | (() => number) } | undefined): void {
  controlStatus = status
}

export function bridgeStatus(): BridgeStatus {
  return {
    running: !!server,
    port: currentPort,
    subscribers: subscriberCount(),
    ...(controlStatus
      ? { control: { path: controlStatus.path, connections: typeof controlStatus.connections === 'function' ? controlStatus.connections() : controlStatus.connections } }
      : {})
  }
}

/**
 * Start the bridge on `port`, bound to `host` (default loopback). The Electron desktop app binds
 * `127.0.0.1` and is fronted by a tunnel; a headless VM deployment binds its own interface (e.g.
 * `0.0.0.0`) so it is directly reachable, still gated by the password. Idempotent-ish: stops any
 * existing server first.
 */
export async function startBridge(port: number, host = '127.0.0.1'): Promise<void> {
  await stopBridge()
  await new Promise<void>((resolve, reject) => {
    const s = createServer((req, res) => {
      handleRequest(req, res).catch((e) => {
        try {
          json(res, 500, { ok: false, error: { message: (e as Error).message } })
        } catch {
          /* response already sent */
        }
      })
    })
    attachWebSocket(s)
    s.on('error', reject)
    s.listen(port, host, () => {
      server = s
      const addr = s.address()
      currentPort = typeof addr === 'object' && addr ? addr.port : port
      resolve()
    })
  })
}

export async function stopBridge(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat)
    heartbeat = null
  }
  if (wss) {
    for (const ws of wss.clients) ws.terminate()
    wss.close()
    wss = null
  }
  if (server) {
    const s = server
    server = null
    currentPort = 0
    await new Promise<void>((resolve) => s.close(() => resolve()))
  }
}
