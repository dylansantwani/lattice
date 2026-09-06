import { describe, expect, it, vi } from 'vitest'
import { ProviderHttpError } from '../providers/openaiCompat'
import {
  DEFAULT_MAX_ENDPOINT_RETRIES,
  EmptyStreamError,
  backoffDelayMs,
  decideEndpointRetry,
  endpointRetryReason,
  isRetryableEndpointError,
  parseRetryAfter,
  retryAfterMs,
  retryDelay
} from './endpointRetry'

describe('isRetryableEndpointError', () => {
  it('retries rate limits, request timeouts, and 5xx', () => {
    expect(isRetryableEndpointError(new ProviderHttpError(429, 'slow down'))).toBe(true)
    expect(isRetryableEndpointError(new ProviderHttpError(408, 'timeout'))).toBe(true)
    expect(isRetryableEndpointError(new ProviderHttpError(500, 'boom'))).toBe(true)
    expect(isRetryableEndpointError(new ProviderHttpError(503, 'unavailable'))).toBe(true)
  })

  it('retries a round whose stream carried no content at all', () => {
    // The silent-stop failure: a route ends the SSE on a bare [DONE] after a long wait. Redoing the
    // round is the only recovery — the alternative is a turn that finishes with no reply.
    expect(isRetryableEndpointError(new EmptyStreamError())).toBe(true)
    expect(endpointRetryReason(new EmptyStreamError(), 1, 4, 700)).toContain('empty response')
  })

  it('does NOT retry permanent client errors (auth, bad request, not found)', () => {
    expect(isRetryableEndpointError(new ProviderHttpError(401, 'unauthorized'))).toBe(false)
    expect(isRetryableEndpointError(new ProviderHttpError(403, 'forbidden'))).toBe(false)
    expect(isRetryableEndpointError(new ProviderHttpError(400, 'context length exceeded'))).toBe(false)
    expect(isRetryableEndpointError(new ProviderHttpError(404, 'no such model'))).toBe(false)
  })

  it('retries network-level faults, matching the errno tucked in err.cause', () => {
    const dropped = Object.assign(new TypeError('fetch failed'), {
      cause: { code: 'ECONNRESET', message: 'read ECONNRESET' }
    })
    expect(isRetryableEndpointError(dropped)).toBe(true)
    const refused = Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } })
    expect(isRetryableEndpointError(refused)).toBe(true)
    // A mid-stream drop surfaces as a "terminated" TypeError from undici.
    expect(isRetryableEndpointError(new TypeError('terminated'))).toBe(true)
    expect(isRetryableEndpointError(new Error('socket hang up'))).toBe(true)
  })

  it('never retries an abort (a user Stop or a steer) or an unknown non-network error', () => {
    const abort = new Error('The operation was aborted')
    abort.name = 'AbortError'
    expect(isRetryableEndpointError(abort)).toBe(false)
    expect(isRetryableEndpointError(new Error('some parse bug'))).toBe(false)
    expect(isRetryableEndpointError('a string')).toBe(false)
    expect(isRetryableEndpointError(undefined)).toBe(false)
  })
})

describe('parseRetryAfter', () => {
  it('parses a delta-seconds value into ms', () => {
    expect(parseRetryAfter('5')).toBe(5000)
    expect(parseRetryAfter('  12 ')).toBe(12000)
  })

  it('parses an HTTP-date into ms from now, clamped at zero', () => {
    const now = Date.now()
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBeGreaterThanOrEqual(0)
    expect(parseRetryAfter(new Date(now + 3000).toUTCString(), now)).toBeLessThanOrEqual(3000)
    // A date in the past never yields a negative wait.
    expect(parseRetryAfter(new Date(now - 10000).toUTCString(), now)).toBe(0)
  })

  it('clamps an absurd value to the 60s ceiling and rejects garbage', () => {
    expect(parseRetryAfter('99999')).toBe(60000)
    expect(parseRetryAfter('soon')).toBeNull()
    expect(parseRetryAfter('')).toBeNull()
    expect(parseRetryAfter(null)).toBeNull()
    expect(parseRetryAfter(undefined)).toBeNull()
  })

  it('reads Retry-After off a ProviderHttpError', () => {
    expect(retryAfterMs(new ProviderHttpError(429, 'slow', '3'))).toBe(3000)
    expect(retryAfterMs(new ProviderHttpError(429, 'slow', null))).toBeNull()
    expect(retryAfterMs(new ProviderHttpError(500, 'boom'))).toBeNull()
  })
})

describe('backoffDelayMs', () => {
  it('obeys a Retry-After exactly when present, ignoring the schedule', () => {
    expect(backoffDelayMs(1, 7000)).toBe(7000)
    expect(backoffDelayMs(3, 250)).toBe(250)
  })

  it('grows exponentially and stays within the full-jitter band [ceiling/2, ceiling]', () => {
    // rng at its extremes pins the band edges: 0 → ceiling/2, ~1 → ceiling.
    expect(backoffDelayMs(1, null, () => 0)).toBe(250) // ceiling 500 → 250
    expect(backoffDelayMs(1, null, () => 0.999999)).toBeCloseTo(500, -1)
    expect(backoffDelayMs(2, null, () => 0)).toBe(500) // ceiling 1000 → 500
    expect(backoffDelayMs(3, null, () => 0)).toBe(1000) // ceiling 2000 → 1000
  })

  it('caps the ceiling at 20s no matter how many attempts', () => {
    expect(backoffDelayMs(20, null, () => 0.999999)).toBeLessThanOrEqual(20000)
    expect(backoffDelayMs(20, null, () => 0)).toBe(10000) // capped ceiling 20000 → 10000
  })
})

describe('decideEndpointRetry', () => {
  const rng = (): number => 0 // deterministic: delay sits at the low edge of the jitter band

  it('retries a transient failure until the attempt budget is spent', () => {
    const state = { attempts: 0 }
    const err = new ProviderHttpError(503, 'unavailable')
    const first = decideEndpointRetry(err, state, 2, 0, rng)
    expect(first).toEqual({ retry: true, attempt: 1, delayMs: 250, reason: expect.stringContaining('retrying (1/2)') })
    state.attempts = 1
    const second = decideEndpointRetry(err, state, 2, 0, rng)
    expect(second.retry).toBe(true)
    state.attempts = 2
    // Budget spent — no more redos.
    expect(decideEndpointRetry(err, state, 2, 0, rng)).toEqual({ retry: false })
  })

  it('never retries a permanent failure regardless of remaining budget', () => {
    expect(decideEndpointRetry(new ProviderHttpError(401, 'nope'), { attempts: 0 }, 4, 0, rng)).toEqual({
      retry: false
    })
  })

  it('disables retry entirely when max is 0', () => {
    expect(decideEndpointRetry(new ProviderHttpError(500, 'boom'), { attempts: 0 }, 0, 0, rng)).toEqual({
      retry: false
    })
  })

  it('threads the endpoint Retry-After into the computed delay', () => {
    const d = decideEndpointRetry(new ProviderHttpError(429, 'slow', '4'), { attempts: 0 }, 4, 0, rng)
    expect(d).toMatchObject({ retry: true, delayMs: 4000 })
  })
})

describe('endpointRetryReason', () => {
  it('names the failure and shows the attempt count and wait', () => {
    expect(endpointRetryReason(new ProviderHttpError(429, 'x'), 1, 4, 700)).toContain('rate-limited')
    expect(endpointRetryReason(new ProviderHttpError(429, 'x'), 1, 4, 700)).toContain('(1/4)')
    expect(endpointRetryReason(new ProviderHttpError(429, 'x'), 1, 4, 700)).toContain('0.7s')
    expect(endpointRetryReason(new ProviderHttpError(500, 'x'), 2, 4, 4000)).toContain('HTTP 500')
    expect(endpointRetryReason(new ProviderHttpError(500, 'x'), 2, 4, 4000)).toContain('4s')
    expect(endpointRetryReason(new Error('fetch failed'), 1, 4, 500)).toContain('reach the endpoint')
  })
})

describe('retryDelay', () => {
  it('resolves after the timeout when nothing aborts', async () => {
    vi.useFakeTimers()
    try {
      const p = retryDelay(1000)
      let done = false
      void p.then(() => (done = true))
      await vi.advanceTimersByTimeAsync(999)
      expect(done).toBe(false)
      await vi.advanceTimersByTimeAsync(1)
      await p
      expect(done).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('rejects immediately with AbortError when the cancel signal is already aborted', async () => {
    await expect(retryDelay(1000, AbortSignal.abort())).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects when the cancel signal fires mid-wait (a Stop during backoff)', async () => {
    vi.useFakeTimers()
    try {
      const cancel = new AbortController()
      const p = retryDelay(5000, cancel.signal)
      const assertion = expect(p).rejects.toMatchObject({ name: 'AbortError' })
      cancel.abort()
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })

  it('resolves early (does not reject) when the wake signal fires — a steer during backoff', async () => {
    const wake = new AbortController()
    const p = retryDelay(60000, undefined, wake.signal)
    wake.abort()
    await expect(p).resolves.toBeUndefined()
  })

  it('resolves at once when the wake signal is already aborted', async () => {
    await expect(retryDelay(60000, undefined, AbortSignal.abort())).resolves.toBeUndefined()
  })
})

describe('DEFAULT_MAX_ENDPOINT_RETRIES', () => {
  it('is a small positive number', () => {
    expect(DEFAULT_MAX_ENDPOINT_RETRIES).toBeGreaterThan(0)
    expect(DEFAULT_MAX_ENDPOINT_RETRIES).toBeLessThanOrEqual(10)
  })
})
