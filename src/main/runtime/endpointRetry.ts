import { ProviderHttpError } from '../providers/openaiCompat'

/**
 * Automatic retry policy for transient endpoint (provider) failures.
 *
 * A single model round streams from an OpenAI-compatible endpoint. That request can fail for two
 * very different reasons: a *permanent* one (bad auth, an over-long prompt, an unknown model) that
 * retrying can only repeat, and a *transient* one (the endpoint rate-limited us, returned a 5xx,
 * or the socket dropped) that a moment's wait usually clears. This module encodes which failures
 * are worth redoing, how long to wait before each redo (exponential backoff with jitter, honoring a
 * `Retry-After` the endpoint sent), and a cancellable sleep so a user's Stop still wins during the
 * wait. The run loop captures a rollback point before each attempt so a *mid-stream* drop — bytes
 * already streamed, then the connection died — restarts the round cleanly instead of stitching a
 * broken half-reply onto the retry (see the `rewound` retry event the transcript honors).
 */

/** Default number of automatic redo attempts after the first failure. Overridable in Settings. */
export const DEFAULT_MAX_ENDPOINT_RETRIES = 4

const BASE_DELAY_MS = 500
const MAX_DELAY_MS = 20_000
/** Cap a server-provided Retry-After so a hostile/erroneous header can't park a run for minutes. */
const MAX_RETRY_AFTER_MS = 60_000

/**
 * Whether a failed endpoint request is a *transient* one worth retrying. Deliberately conservative:
 * only rate limits (429), request-timeout (408), server errors (5xx), and network-level drops
 * qualify. A 4xx that isn't 408/429 is the model/prompt/credentials being wrong — retrying just
 * repeats it — so it surfaces immediately, exactly as before this policy existed. An abort (a user
 * Stop or a steer) is never a failure to retry.
 */
export function isRetryableEndpointError(err: unknown): boolean {
  if (err instanceof ProviderHttpError) {
    return err.status === 408 || err.status === 429 || err.status >= 500
  }
  if (err instanceof Error) {
    if (err.name === 'AbortError') return false
    // Node's fetch surfaces network faults as `TypeError: fetch failed` with the real cause (an
    // errno like ECONNRESET) tucked in `err.cause`. Match against message + cause so a reset/refused
    // socket, a DNS miss, or a mid-stream "terminated" all count.
    const cause = (err as { cause?: { message?: unknown; code?: unknown } }).cause
    const haystack = [
      err.message,
      typeof cause?.message === 'string' ? cause.message : '',
      typeof cause?.code === 'string' ? cause.code : ''
    ].join(' ')
    return /fetch failed|network|terminated|other side closed|socket hang up|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|EPIPE|UND_ERR/i.test(
      haystack
    )
  }
  return false
}

/**
 * Parse an HTTP `Retry-After` header (a delta in seconds, or an HTTP date) into milliseconds from
 * `now`, clamped to [0, {@link MAX_RETRY_AFTER_MS}]. Returns null for a missing/unparseable value.
 */
export function parseRetryAfter(header: string | null | undefined, now = Date.now()): number | null {
  if (header == null) return null
  const s = header.trim()
  if (s === '') return null
  if (/^\d+$/.test(s)) return Math.min(Number(s) * 1000, MAX_RETRY_AFTER_MS)
  const when = Date.parse(s)
  if (!Number.isNaN(when)) return Math.min(Math.max(0, when - now), MAX_RETRY_AFTER_MS)
  return null
}

/** The Retry-After the endpoint asked for on this error, in ms, or null when it named none. */
export function retryAfterMs(err: unknown, now = Date.now()): number | null {
  if (err instanceof ProviderHttpError && err.retryAfter != null) {
    return parseRetryAfter(err.retryAfter, now)
  }
  return null
}

/**
 * The delay before the given attempt (1-based: 1 is the first *redo*). When the endpoint sent a
 * Retry-After we obey it exactly. Otherwise: exponential backoff (500ms, 1s, 2s, 4s… capped at 20s)
 * with full jitter — the delay is uniform in [half, full] of the capped ceiling, so a fleet of runs
 * that were all rate-limited at once don't retry in lockstep and re-collide.
 */
export function backoffDelayMs(attempt: number, retryAfter: number | null, rng: () => number = Math.random): number {
  if (retryAfter != null) return retryAfter
  const ceiling = Math.min(BASE_DELAY_MS * 2 ** (attempt - 1), MAX_DELAY_MS)
  return Math.round(ceiling / 2 + rng() * (ceiling / 2))
}

/** A short human label for what failed, used in the transcript's retry notice. */
export function endpointFailureLabel(err: unknown): string {
  if (err instanceof ProviderHttpError) {
    if (err.status === 429) return 'The endpoint rate-limited the request'
    if (err.status === 408) return 'The endpoint timed out'
    if (err.status >= 500) return `The endpoint returned an error (HTTP ${err.status})`
    return `The endpoint rejected the request (HTTP ${err.status})`
  }
  return 'Could not reach the endpoint'
}

/** The full retry-notice string surfaced as a `retry` event, e.g. "… — retrying (1/4) in 0.7s…". */
export function endpointRetryReason(err: unknown, attempt: number, max: number, delayMs: number): string {
  const secs = delayMs < 1000 ? `${(delayMs / 1000).toFixed(1)}s` : `${Math.round(delayMs / 1000)}s`
  return `${endpointFailureLabel(err)} — retrying (${attempt}/${max}) in ${secs}…`
}

/**
 * A promise that resolves after `ms`, but resolves *early* if `wake` aborts (a steer landed during
 * the backoff — stop waiting and let the round fold the steer in) and *rejects* with an AbortError
 * if `cancel` aborts (a real Stop — propagate so the run tears down). Either signal already aborted
 * short-circuits before the timer is even armed.
 */
export function retryDelay(ms: number, cancel?: AbortSignal, wake?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (cancel?.aborted) return reject(new DOMException('Aborted', 'AbortError'))
    if (wake?.aborted) return resolve()
    const cleanup = (): void => {
      clearTimeout(timer)
      cancel?.removeEventListener('abort', onCancel)
      wake?.removeEventListener('abort', onWake)
    }
    const onCancel = (): void => {
      cleanup()
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const onWake = (): void => {
      cleanup()
      resolve()
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    cancel?.addEventListener('abort', onCancel, { once: true })
    wake?.addEventListener('abort', onWake, { once: true })
  })
}

export interface EndpointRetryState {
  /** Attempts already spent (0 before the first redo). */
  attempts: number
}

/**
 * Decide what to do with an error thrown while streaming a round. Pure — the caller owns the
 * rollback, the notice emit, and the sleep — this just answers "should I redo, and after how long?"
 * so the same policy drives both the main turn loop and every subagent loop identically.
 */
export function decideEndpointRetry(
  err: unknown,
  state: EndpointRetryState,
  max: number,
  now = Date.now(),
  rng: () => number = Math.random
): { retry: false } | { retry: true; attempt: number; delayMs: number; reason: string } {
  if (max <= 0 || state.attempts >= max || !isRetryableEndpointError(err)) return { retry: false }
  const attempt = state.attempts + 1
  const delayMs = backoffDelayMs(attempt, retryAfterMs(err, now), rng)
  return { retry: true, attempt, delayMs, reason: endpointRetryReason(err, attempt, max, delayMs) }
}
