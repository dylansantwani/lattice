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
 * A round whose provider stream carried NOTHING: no text, no reasoning, no tool-call delta — only a
 * `[DONE]` (and sometimes a usage/finish chunk) after a long wait. Free/overloaded routes do this
 * instead of returning an HTTP error, and the round is indistinguishable from a model that chose to
 * say nothing. Treated as a transient endpoint failure so the round is redone rather than finalizing
 * the turn as a silent, complete-looking stop (which is what "the model just stopped responding"
 * looked like from the UI: a tool result, then nothing, then a finished turn).
 */
export class EmptyStreamError extends Error {
  constructor() {
    super('The provider stream ended without any content.')
    this.name = 'EmptyStreamError'
  }
}

/**
 * A 429 can mean a short request throttle, or that every credential for a particular model is
 * cooling down. The latter is not helped by immediately replaying the same request, and repeated
 * probes can extend the provider's cooldown, so it should surface to the user immediately.
 */
export function isModelCooldownError(err: unknown): boolean {
  if (!(err instanceof ProviderHttpError) || err.status !== 429) return false
  return /model_cooldown|(?:model|credentials?)[^\n]{0,120}cooling down/i.test(err.body)
}

/**
 * Whether a failed endpoint request is a *transient* one worth retrying. Deliberately conservative:
 * only ordinary rate limits (429), request-timeout (408), server errors (5xx), and network-level
 * drops qualify. A model cooldown is a deliberate exception: it is a 429, but replaying the same
 * model request cannot clear it. A 4xx that isn't 408/429 is the model/prompt/credentials being
 * wrong — retrying just repeats it — so it surfaces immediately, exactly as before this policy
 * existed. An abort (a user Stop or a steer) is never a failure to retry.
 */
export function isRetryableEndpointError(err: unknown): boolean {
  if (err instanceof EmptyStreamError) return true
  if (err instanceof ProviderHttpError) {
    if (isModelCooldownError(err)) return false
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
  if (err instanceof EmptyStreamError) return 'The endpoint returned an empty response'
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

// ---------- reasoning-only replies ----------

/**
 * A round that streamed readable reasoning and then a clean `stop` — no visible text, no tool
 * call — is not an endpoint failure: the connection was fine and the model finished on purpose.
 * It is a *routing* fault in the model's own output. Captured live on OpenCode Zen's
 * `ling-3.0-flash` mid-turn, after five tool rounds: the model wrote its whole final answer
 * ("## Short answer …") inside the thinking channel, never emitted the think-close token, and the
 * upstream's own usage counted 435 of its 437 output tokens as reasoning. `content` came back null,
 * so the answer rendered as a "Thought for 1s" over an empty reply. Replaying the archived request
 * reproduced it about one time in three, so a redo usually lands the answer in the right channel.
 *
 * Policy: redo the round immediately (no backoff — nothing is overloaded) up to
 * {@link MAX_REASONING_ONLY_REDOS} times, rewinding the misrouted reasoning from the transcript
 * each time. If every redo misroutes as well, PROMOTE the last attempt's reasoning into the visible
 * reply: that text *is* the model's answer, and showing it beats an error over a blank bubble. The
 * promoted text then flows through the ordinary stall recovery, so a bout that trailed off on an
 * announced action ("let me call browser_screenshot:") still gets the follow-through nudge.
 */
export const MAX_REASONING_ONLY_REDOS = 2

export interface ReasoningOnlyRedoState {
  /** Redos already spent on this round (0 before the first). */
  redos: number
}

/**
 * Decide what to do with a round that ended reasoning-only. Pure, like {@link decideEndpointRetry}:
 * the caller owns the rollback/promotion and the notice emit. `redo: true` means roll the round
 * back and stream it again at once; `redo: false` means promote the reasoning as the reply.
 */
export function decideReasoningOnlyRedo(
  state: ReasoningOnlyRedoState,
  max = MAX_REASONING_ONLY_REDOS
): { redo: true; attempt: number; reason: string } | { redo: false; reason: string } {
  if (max <= 0 || state.redos >= max) {
    return {
      redo: false,
      reason:
        (max <= 0
          ? 'The model wrote its reply inside the reasoning channel with no visible answer'
          : `The model wrote its reply inside the reasoning channel again (${state.redos}/${max} redos used)`) +
        ' — showing that text as the reply.'
    }
  }
  const attempt = state.redos + 1
  return {
    redo: true,
    attempt,
    reason: `The model wrote its reply inside the reasoning channel with no visible answer — redoing the round (${attempt}/${max})…`
  }
}
