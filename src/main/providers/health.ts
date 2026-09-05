import type { ModelHealth, ModelHealthStatus, ProviderConfig } from '@shared/types'
import { getSettings } from '../store/eventStore'
import { providerForModel } from './registry'

/**
 * Model health pings.
 *
 * The model picker lists every route the gateway advertises, and a fair number of them are dead at
 * any given moment — a local rig that is powered off, a free bridge that has gone away, a route
 * whose upstream key expired. Until now the only way to find out was to pick the model, send a
 * message, and read the error. This module answers the question BEFORE selection: it sends each
 * candidate model a one-token, non-streaming completion and reports whether it answered, how fast,
 * and — when it did not — why.
 *
 * A ping is a real inference call because that is the only thing that actually proves a route is
 * live: `/v1/models` lists routes whose backends are unreachable. It is kept tiny — a two-word
 * prompt and {@link PING_MAX_TOKENS} of output — so the cost is a rounding error even on paid
 * routes, and it is never issued automatically for the whole catalog: only the handful of models
 * the picker leads with, or a set the user explicitly asks to check.
 *
 * It is NOT made as small as a request can possibly be, and that distinction matters. An earlier
 * version sent `max_tokens: 1`, which measured the probe rather than the route: a reasoning-capable
 * model cannot produce a usable completion inside a single token, so the gateway got an empty
 * upstream response and answered **HTTP 502** — reporting `cc/claude-sonnet-5` as DOWN seconds after
 * it had finished a multi-tool turn. Measured against the same three Claude routes: `max_tokens: 1`
 * → 502, 502, 200; `max_tokens: 16` with "Reply with: ok" → 200 "ok" three times, and faster. A
 * health check that fails on healthy models is worse than none, so the probe asks for something a
 * model can actually say.
 *
 * Results are cached briefly ({@link HEALTH_TTL_MS}): health is volatile enough that a stale answer
 * misleads, but reopening the picker twice in a minute should not re-ping everything.
 */

/** How long a health result is served from cache before another ping is made. */
export const HEALTH_TTL_MS = 60_000
/**
 * A ping slower than this answered, but not usefully fast — reported as `slow`, not `live`.
 * Calibrated against real measurements through the local gateway, where a healthy top-tier cloud
 * route answers this probe in 1.4–2.4s; a threshold below that would flag working models as slow.
 */
export const SLOW_MS = 4_000
/** A ping is abandoned after this; a route that cannot manage a two-word reply in 15s is down for our purposes. */
const PING_TIMEOUT_MS = 15_000
/**
 * Output budget for a ping. Enough for a model to actually answer (see the note above about
 * `max_tokens: 1` making live routes 502), small enough that the cost is noise.
 */
export const PING_MAX_TOKENS = 16
/** Concurrent pings. Low enough not to hammer one gateway with a whole picker's worth of requests. */
const PING_CONCURRENCY = 5

const cache = new Map<string, ModelHealth>()

/** Drop every cached result (tests, and a provider-config change that invalidates routing). */
export function resetModelHealth(): void {
  cache.clear()
}

/** The cached health for a model, if it is still fresh. */
export function cachedModelHealth(modelId: string): ModelHealth | null {
  const hit = cache.get(modelId)
  if (!hit) return null
  return Date.now() - hit.checkedAt < HEALTH_TTL_MS ? hit : null
}

/**
 * Ping a set of models and report each one's health, calling `onResult` as each lands so the UI can
 * light rows up progressively instead of waiting for the slowest route in the batch. Fresh cached
 * results are returned immediately (and reported through `onResult` too, so the caller has one code
 * path); `refresh` forces a real ping.
 */
export async function checkModelHealth(
  modelIds: string[],
  opts: { refresh?: boolean; onResult?: (health: ModelHealth) => void } = {}
): Promise<ModelHealth[]> {
  const unique = [...new Set(modelIds.filter((id) => typeof id === 'string' && id.trim()))]
  const providers = getSettings().providers
  const out: ModelHealth[] = []
  const queue: string[] = []

  for (const id of unique) {
    const hit = opts.refresh ? null : cachedModelHealth(id)
    if (hit) {
      out.push(hit)
      opts.onResult?.(hit)
    } else {
      queue.push(id)
    }
  }

  let next = 0
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++
      const id = queue[index]
      if (id === undefined) return
      const health = await pingModel(id, providers)
      cache.set(id, health)
      out.push(health)
      opts.onResult?.(health)
    }
  }
  await Promise.all(Array.from({ length: Math.min(PING_CONCURRENCY, queue.length) }, worker))
  return out
}

/**
 * Ping ONE model: a single-token completion against the provider that serves it. Returns a health
 * record either way — a failed ping is a result, not an exception.
 */
export async function pingModel(modelId: string, providers: ProviderConfig[]): Promise<ModelHealth> {
  const provider = providerForModel(modelId, providers)
  const checkedAt = Date.now()
  if (!provider) {
    return { modelId, status: 'unknown', checkedAt, error: 'No enabled provider serves this model.' }
  }
  const started = Date.now()
  try {
    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers
      },
      // The smallest request that still asks the model for something it can actually produce. No
      // temperature, no reasoning_effort, no tools: every optional field is one more thing a strict
      // backend can 400 on, which would make a live model look broken.
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: 'user', content: 'Reply with: ok' }],
        max_tokens: PING_MAX_TOKENS,
        stream: false
      }),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS)
    })
    const latencyMs = Date.now() - started
    if (res.ok) {
      // A 200 is not proof on its own: some routes answer the request and hand back an empty
      // completion, which is reachable-but-not-usable, not healthy.
      const spoke = replyHasContent(await res.text().catch(() => ''))
      return {
        modelId,
        providerId: provider.id,
        status: spoke ? (latencyMs > SLOW_MS ? 'slow' : 'live') : 'limited',
        latencyMs,
        checkedAt: Date.now(),
        ...(spoke ? {} : { error: 'answered, but produced no output' })
      }
    }
    const detail = summarizeErrorBody(await res.text().catch(() => ''))
    return {
      modelId,
      providerId: provider.id,
      status: statusForHttp(res.status),
      latencyMs,
      checkedAt: Date.now(),
      error: `HTTP ${res.status}${detail ? ` · ${detail}` : ''}`
    }
  } catch (err) {
    return {
      modelId,
      providerId: provider.id,
      status: 'down',
      latencyMs: Date.now() - started,
      checkedAt: Date.now(),
      error: pingErrorMessage(err)
    }
  }
}

/**
 * What an HTTP status says about a route's health.
 *
 * `limited` is the interesting one: the endpoint answered and routed the request, but would not
 * serve it right now — rate-limited (429), or a 400 that means the model exists but rejected this
 * particular (minimal) request shape. Both are worth distinguishing from `down`, which means the
 * route is not usable at all: unauthorized, missing, or a broken upstream.
 */
export function statusForHttp(status: number): ModelHealthStatus {
  if (status === 429) return 'limited'
  if (status === 400 || status === 422) return 'limited'
  return 'down'
}

/**
 * Did the model actually say anything? Reads the first choice's content across the shapes gateways
 * return (a string, or OpenAI-style content parts). A body we cannot parse is given the benefit of
 * the doubt — a 200 from an unfamiliar shape is far more likely to be a working route than a broken
 * one, and calling it unhealthy on a parsing guess is the failure mode this whole module exists to
 * avoid.
 */
export function replyHasContent(body: string): boolean {
  try {
    const json = JSON.parse(body) as {
      choices?: { message?: { content?: unknown; reasoning_content?: unknown }; text?: unknown }[]
    }
    const choice = json.choices?.[0]
    if (!choice) return true
    const content = choice.message?.content ?? choice.text
    if (typeof content === 'string') return content.trim().length > 0
    if (Array.isArray(content)) {
      return content.some((part) => {
        const text = (part as { text?: unknown })?.text
        return typeof text === 'string' && text.trim().length > 0
      })
    }
    // No content at all, but the model may have spent the budget on reasoning — still "spoke".
    if (typeof choice.message?.reasoning_content === 'string' && choice.message.reasoning_content.trim()) return true
    return content != null
  } catch {
    return true
  }
}

/** A short, human failure reason for a ping: abort → timeout, else the error's own message. */
function pingErrorMessage(err: unknown): string {
  if (err instanceof DOMException && err.name === 'TimeoutError') {
    return `no response in ${PING_TIMEOUT_MS / 1000}s`
  }
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Pull the human part out of an error body: gateways answer with `{"error":{"message":"…"}}`,
 * `{"error":"…"}`, or plain text. Clipped — this rides in a tooltip, not a log.
 */
export function summarizeErrorBody(body: string): string {
  const text = body.trim()
  if (!text) return ''
  try {
    const json = JSON.parse(text) as { error?: unknown; message?: unknown }
    const err = json.error
    const message =
      (typeof err === 'object' && err !== null && typeof (err as { message?: unknown }).message === 'string'
        ? (err as { message: string }).message
        : typeof err === 'string'
          ? err
          : typeof json.message === 'string'
            ? json.message
            : '') || ''
    if (message) return clip(message)
  } catch {
    // not JSON — fall through to the raw text
  }
  return clip(text)
}

function clip(s: string): string {
  const one = s.replace(/\s+/g, ' ').trim()
  return one.length > 160 ? `${one.slice(0, 157)}…` : one
}
