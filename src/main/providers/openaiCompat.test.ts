import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import { mapUsage, streamChat } from './openaiCompat'

describe('mapUsage — cache token accounting', () => {
  it('adds the write count back onto prompt_tokens on an Anthropic-style cold turn', () => {
    // Cold turn: prompt_tokens EXCLUDES the freshly-written cache tokens.
    const u = mapUsage({
      prompt_tokens: 12,
      completion_tokens: 15,
      cache_creation_input_tokens: 3146
    })
    expect(u.tokensIn).toBe(3158) // 12 + 3146: the true total input processed
    expect(u.cacheWriteTokens).toBe(3146)
    expect(u.cacheReadTokens).toBeUndefined() // no reads → undefined, not 0
    expect(u.tokensOut).toBe(15)
  })

  it('reads cache hits from cache_read_input_tokens on an Anthropic-style warm turn', () => {
    // Warm turn: prompt_tokens INCLUDES the cache read; a tiny fresh write may also occur.
    const u = mapUsage({
      prompt_tokens: 3156,
      completion_tokens: 14,
      cache_read_input_tokens: 3146,
      cache_creation_input_tokens: 16
    })
    expect(u.cacheReadTokens).toBe(3146)
    expect(u.cacheWriteTokens).toBe(16)
    expect(u.tokensIn).toBe(3172) // 3156 + 16 → hit rate 3146/3172 ≈ 99%
  })

  it('reads cache hits from prompt_tokens_details on an OpenAI-style backend', () => {
    // OpenAI-style: cached tokens folded into prompt_tokens, no write count reported.
    const u = mapUsage({
      prompt_tokens: 5640,
      completion_tokens: 10,
      prompt_tokens_details: { cached_tokens: 5626 }
    })
    expect(u.cacheReadTokens).toBe(5626)
    expect(u.cacheWriteTokens).toBeUndefined()
    expect(u.tokensIn).toBe(5640) // no write to add back
  })

  it('leaves cache fields undefined (not 0) when the backend reports no cache activity', () => {
    // This is the case that used to render a misleading "0% cached": no cache fields at all.
    const u = mapUsage({ prompt_tokens: 6241, completion_tokens: 712 })
    expect(u.cacheReadTokens).toBeUndefined()
    expect(u.cacheWriteTokens).toBeUndefined()
    expect(u.tokensIn).toBe(6241)
  })

  it('preserves an explicit zero read count as 0', () => {
    // A backend that explicitly reports 0 reads keeps 0 (so callers can distinguish it from
    // "no field"); the UI treats 0 as "no reads to show" and renders no hit-rate chip.
    const u = mapUsage({
      prompt_tokens: 6116,
      completion_tokens: 587,
      prompt_tokens_details: { cached_tokens: 0 }
    })
    expect(u.cacheReadTokens).toBe(0)
    expect(u.tokensIn).toBe(6116)
  })

  it('reads reasoning tokens from either nesting', () => {
    expect(mapUsage({ completion_tokens_details: { reasoning_tokens: 42 } }).tokensReasoning).toBe(42)
    expect(mapUsage({ reasoning_tokens: 7 }).tokensReasoning).toBe(7)
  })

  it('returns undefined tokensIn when prompt_tokens is absent', () => {
    expect(mapUsage({ completion_tokens: 5 }).tokensIn).toBeUndefined()
  })
})

describe('streamChat — reasoning_effort in the request body', () => {
  const provider: ProviderConfig = {
    id: 'p',
    label: 'p',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:9999',
    apiKey: 'k',
    enabled: true
  }

  // A minimal SSE body that streamChat can drain to completion.
  function sseResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function captureBody(effort: string | undefined): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}')
      return sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    // drain the generator so the request actually goes out
    for await (const _ of streamChat(provider, {
      model: 'm',
      messages: [{ role: 'user', content: 'hi' }],
      effort,
      cache: false,
      signal: new AbortController().signal
    })) {
      void _
    }
    return captured
  }

  afterEach(() => vi.unstubAllGlobals())

  it('sends reasoning_effort for a real tier', async () => {
    expect((await captureBody('low')).reasoning_effort).toBe('low')
    expect((await captureBody('high')).reasoning_effort).toBe('high')
  })

  // The invariant the auto-title fix relies on: a non-reasoning model runs with effort
  // 'none'/'off'/undefined, and those must NOT emit reasoning_effort (which 400s such models).
  it('omits reasoning_effort for none / off / undefined', async () => {
    expect(await captureBody('none')).not.toHaveProperty('reasoning_effort')
    expect(await captureBody('off')).not.toHaveProperty('reasoning_effort')
    expect(await captureBody(undefined)).not.toHaveProperty('reasoning_effort')
  })
})
