/**
 * The seam between Lattice's existing IPC surface and the remote (iOS) clients.
 *
 * `registerIpc()` builds one plain `api: LatticeApi` object and calls one `push(event)` fan-out.
 * This module lets the network server reach both without the run manager or ipc layer knowing the
 * server exists:
 *   - `registerApi(api)` / `push()` are called from ipc.ts.
 *   - `dispatch(method, args)` invokes an api method by name (allow-listed to API_METHODS).
 *   - `subscribe(fn)` receives every PushEvent for forwarding over the WebSocket.
 *   - `redactForRemote()` strips secrets (provider API keys, MCP secret env) from RPC results.
 *
 * Keeping this a leaf module (no import of runManager/ipc) mirrors how the ask/approval/session
 * brokers are wired: ipc.ts hands it what it needs; it never reaches back up.
 */
import { API_METHODS, type LatticeApi, type PushEvent } from '@shared/ipc'

let api: LatticeApi | null = null
const subscribers = new Set<(event: PushEvent) => void>()

const METHODS = new Set<string>(API_METHODS as string[])

/** ipc.ts registers the built api object here once, at startup. */
export function registerApi(built: LatticeApi): void {
  api = built
}

/** ipc.ts's push() calls this so every remote client sees the same events the renderer does. */
export function broadcast(event: PushEvent): void {
  for (const fn of subscribers) {
    try {
      fn(event)
    } catch {
      /* a dead socket must not break the fan-out to the others */
    }
  }
}

/** The WebSocket layer subscribes; returns an unsubscribe. */
export function subscribe(fn: (event: PushEvent) => void): () => void {
  subscribers.add(fn)
  return () => subscribers.delete(fn)
}

export function subscriberCount(): number {
  return subscribers.size
}

export class UnknownMethodError extends Error {}

/**
 * Invoke a LatticeApi method by name with positional args. Only names in API_METHODS are callable —
 * a client cannot reach arbitrary properties. Result is passed through {@link redactForRemote}.
 */
export async function dispatch(method: string, args: unknown[]): Promise<unknown> {
  if (!api) throw new Error('bridge api not registered')
  if (!METHODS.has(method)) throw new UnknownMethodError(`unknown method: ${method}`)
  const fn = (api as unknown as Record<string, (...a: unknown[]) => unknown>)[method]
  if (typeof fn !== 'function') throw new UnknownMethodError(`not callable: ${method}`)
  const result = await fn(...args)
  return redactForRemote(method, result)
}

// ---------- secret redaction ----------

/**
 * Some LatticeApi results carry credentials that must never leave the machine. `getSettings`
 * returns providers with plaintext `apiKey`; MCP configs can hold secret `env`. Strip them here,
 * replacing each with a boolean presence flag the UI can still show. Add a case whenever a method's
 * payload gains a secret-bearing field. Everything not listed passes through untouched.
 */
export function redactForRemote(method: string, result: unknown): unknown {
  if (method === 'getSettings' || method === 'setSettings') {
    return redactSettings(result)
  }
  if (method === 'listMcpServers') {
    return redactMcpList(result)
  }
  return result
}

function redactSettings(result: unknown): unknown {
  if (!result || typeof result !== 'object') return result
  const s = result as Record<string, unknown>
  const providers = Array.isArray(s.providers) ? s.providers : []
  return {
    ...s,
    providers: providers.map((p) => {
      const prov = p as Record<string, unknown>
      const { apiKey, headers, ...rest } = prov
      return {
        ...rest,
        // never send the key; the client only needs to know one is present
        hasKey: typeof apiKey === 'string' && apiKey.length > 0,
        // headers can carry auth too — expose only the header names
        headerNames: headers && typeof headers === 'object' ? Object.keys(headers as object) : []
      }
    })
  }
}

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH|CREDENTIAL)/i

function redactMcpList(result: unknown): unknown {
  if (!Array.isArray(result)) return result
  return result.map((entry) => {
    const e = entry as Record<string, unknown>
    const config = e.config as Record<string, unknown> | undefined
    if (!config) return e
    const env = config.env as Record<string, string> | undefined
    const redactedEnv = env
      ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_ENV.test(k) ? '***' : v]))
      : env
    return { ...e, config: { ...config, env: redactedEnv } }
  })
}

/** test hook */
export function _resetBridge(): void {
  api = null
  subscribers.clear()
}
