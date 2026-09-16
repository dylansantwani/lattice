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
  let callArgs = args
  if (method === 'setSettings' && args[0] && typeof args[0] === 'object') {
    callArgs = [restoreRedactedSecrets(args[0] as Record<string, unknown>, (await api.getSettings()) as unknown as Record<string, unknown>), ...args.slice(1)]
  } else if (method === 'synthesizeSpeech' || method === 'listSpeechVoices') {
    callArgs = stripSpeechEndpointOverride(method, args)
  } else if (method === 'upsertMcpServer' && args[0] && typeof args[0] === 'object') {
    callArgs = [restoreMaskedEnv(args[0] as Record<string, unknown>, (await api.listMcpServers()) as unknown[]), ...args.slice(1)]
  }
  const result = await fn(...callArgs)
  return redactForRemote(method, result)
}

/**
 * A remote client only ever sees redacted settings (keys blanked, `hasKey`/`hasApiKey` flags added).
 * If it echoes such an object back through setSettings — the natural "fetch, change one field, save"
 * pattern — the blanks would overwrite the real secrets. Anything still carrying a redaction flag gets
 * its stored secret back; a client that genuinely wants to change a key sends one without the flag.
 */
export function restoreRedactedSecrets(patch: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const next = { ...patch }
  const speech = patch.speech as Record<string, unknown> | undefined
  const storedSpeech = current.speech as Record<string, unknown> | undefined
  if (speech && typeof speech === 'object' && 'hasApiKey' in speech) {
    const { hasApiKey: _flag, ...rest } = speech
    next.speech = { ...rest, apiKey: storedSpeech?.apiKey ?? '' }
  }
  if (Array.isArray(patch.providers)) {
    const stored = new Map(((current.providers as Array<Record<string, unknown>> | undefined) ?? []).map((p) => [p.id, p]))
    next.providers = patch.providers.map((entry) => {
      const provider = entry as Record<string, unknown>
      if (!('hasKey' in provider) && !('headerNames' in provider)) return provider
      const { hasKey: _hasKey, headerNames: _headerNames, ...rest } = provider
      const original = stored.get(provider.id)
      return { ...rest, apiKey: original?.apiKey ?? '', ...(original?.headers ? { headers: original.headers } : {}) }
    })
  }
  return next
}

/** Speech over the bridge uses the stored endpoint only: a remote caller cannot aim synthesis elsewhere. */
function stripSpeechEndpointOverride(method: string, args: unknown[]): unknown[] {
  const index = method === 'synthesizeSpeech' ? 1 : 0
  const overrides = args[index]
  if (!overrides || typeof overrides !== 'object') return args
  const { baseUrl: _baseUrl, apiKey: _apiKey, ...safe } = overrides as Record<string, unknown>
  const next = [...args]
  next[index] = safe
  return next
}

/**
 * A remote client only ever sees MCP env with secret values masked as `***`. If it echoes such a
 * config back through upsertMcpServer - "fetch, change one field, save" - every masked value must
 * come back from the stored config, not be written as the literal mask.
 */
export function restoreMaskedEnv(config: Record<string, unknown>, list: unknown[]): Record<string, unknown> {
  const env = config.env
  if (!env || typeof env !== 'object') return config
  const stored = (Array.isArray(list) ? list : []).find((entry) => {
    const e = entry as { config?: { id?: unknown } }
    return e?.config?.id === config.id
  }) as { config?: { env?: Record<string, string> } } | undefined
  const storedEnv = stored?.config?.env ?? {}
  const restored = Object.fromEntries(
    Object.entries(env as Record<string, string>).map(([k, v]) => [k, v === ENV_MASK && k in storedEnv ? storedEnv[k] : v])
  )
  return { ...config, env: restored }
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
  // The speech endpoint key is a credential like a provider key: presence only.
  const speech = s.speech && typeof s.speech === 'object' ? (s.speech as Record<string, unknown>) : undefined
  return {
    ...s,
    ...(speech ? { speech: { ...speech, apiKey: '', hasApiKey: typeof speech.apiKey === 'string' && speech.apiKey.length > 0 } } : {}),
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

// Secret-looking env *words*, not substrings: `LATCHKEY_VIEWER_PORT` is not a key because its
// name contains "KEY" - matching on the bare substring masked every LATCHKEY_* variable, and a
// client that echoed the masked config back through upsertMcpServer wrote `***` into the
// stored env (which is exactly how Lattice's latchkey server lost its viewer port).
const SECRET_ENV =
  /(^|[^A-Z0-9])(API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|SECRET_?KEY|KEY|TOKEN|SECRET|PASSWORD|PASS|AUTH(?:ORIZATION)?|CREDENTIALS?)([^A-Z0-9]|$)/i
const ENV_MASK = '***'

function redactMcpList(result: unknown): unknown {
  if (!Array.isArray(result)) return result
  return result.map((entry) => {
    const e = entry as Record<string, unknown>
    const config = e.config as Record<string, unknown> | undefined
    if (!config) return e
    const env = config.env as Record<string, string> | undefined
    const redactedEnv = env
      ? Object.fromEntries(Object.entries(env).map(([k, v]) => [k, SECRET_ENV.test(k) ? ENV_MASK : v]))
      : env
    return { ...e, config: { ...config, env: redactedEnv } }
  })
}

/** test hook */
export function _resetBridge(): void {
  api = null
  subscribers.clear()
}
