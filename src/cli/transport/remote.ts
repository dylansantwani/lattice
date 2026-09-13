import WebSocket from 'ws'
import type { PushEvent } from '@shared/ipc'
import { LOCAL_PROTOCOL_VERSION } from '../../main/net/local'
import { cacheToken, readCachedToken } from '../config'
import { createApiProxy, PushEventQueue, TransportError, type LatticeTransport } from './types'

interface RemoteOptions {
  endpoint: string
  token?: string
  password?: string
  device?: string
  timeoutMs?: number
}

interface RpcResponse {
  ok?: boolean
  result?: unknown
  error?: { message?: string; code?: string }
  protocol?: number
}

function httpEndpoint(endpoint: string): string {
  const raw = endpoint.trim()
  if (!raw) throw new TransportError('remote endpoint is empty')
  return /^https?:\/\//i.test(raw) ? raw.replace(/\/$/, '') : `http://${raw.replace(/\/$/, '')}`
}

function wsEndpoint(http: string): string {
  return http.replace(/^http/i, 'ws')
}

async function fetchJson(url: string, init?: RequestInit): Promise<RpcResponse> {
  const response = await fetch(url, init)
  let body: RpcResponse
  try {
    body = (await response.json()) as RpcResponse
  } catch {
    throw new TransportError(`remote endpoint returned HTTP ${response.status}`)
  }
  if (!response.ok) {
    const error = new TransportError(body.error?.message || `remote endpoint returned HTTP ${response.status}`)
    ;(error as Error & { status?: number }).status = response.status
    throw error
  }
  return body
}

export async function connectRemoteTransport(options: RemoteOptions): Promise<LatticeTransport> {
  const endpoint = httpEndpoint(options.endpoint)
  let token = options.token || process.env.LATTICE_TOKEN || await readCachedToken(endpoint)
  const password = options.password ?? process.env.LATTICE_PASSWORD
  const authenticateRemote = async (): Promise<void> => {
    if (!password) throw new TransportError('remote authentication requires LATTICE_TOKEN or LATTICE_PASSWORD')
    const auth = await fetchJson(`${endpoint}/auth`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password, device: options.device || `lattice-cli-${process.pid}` })
    })
    token = String((auth as unknown as { token?: unknown }).token ?? '')
    if (!token) throw new TransportError('remote authentication returned no device token')
    await cacheToken(endpoint, token).catch(() => undefined)
  }
  if (!token) await authenticateRemote()

  const health = await fetchJson(`${endpoint}/health`)
  if (health.protocol !== undefined && health.protocol !== LOCAL_PROTOCOL_VERSION) {
    throw new TransportError(`remote protocol mismatch: CLI expects ${LOCAL_PROTOCOL_VERSION}, remote reports ${health.protocol}; upgrade one side.`)
  }

  const queue = new PushEventQueue()
  const ws = new WebSocket(`${wsEndpoint(endpoint)}/events`, { headers: { authorization: `Bearer ${token}` } })
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate()
      reject(new TransportError(`timed out connecting to remote event stream ${endpoint}`))
    }, options.timeoutMs ?? 5000)
    ws.once('open', () => { clearTimeout(timer); resolve() })
    ws.once('error', (error) => { clearTimeout(timer); reject(new TransportError(`remote event stream failed: ${(error as Error).message}`, { cause: error })) })
  })
  ws.on('message', (data) => {
    try {
      const value = JSON.parse(data.toString()) as PushEvent | { kind?: string }
      if ('kind' in value && value.kind !== 'hello') queue.push(value as PushEvent)
    } catch {
      /* ignore malformed push frames */
    }
  })
  ws.on('close', () => queue.end())
  ws.on('error', () => queue.end())

  const request = async (method: string, args: unknown[]): Promise<unknown> => {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetchJson(`${endpoint}/rpc/${encodeURIComponent(method)}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
          body: JSON.stringify({ args })
        })
        if (response.ok === false) throw new Error(response.error?.message || 'remote RPC failed')
        return response.result
      } catch (error) {
        const status = (error as Error & { status?: number }).status
        if (status !== 401 || attempt !== 0 || !password) throw error
        await authenticateRemote()
      }
    }
    throw new TransportError('remote RPC retry failed')
  }

  return {
    api: createApiProxy(request),
    events: queue,
    mode: 'remote',
    async close(): Promise<void> {
      queue.end()
      if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close()
    }
  }
}
