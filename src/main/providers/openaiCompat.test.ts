import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import {
  makeControlTokenStripper,
  mapUsage,
  streamChat,
  withCacheBreakpoints,
  type WireMessage
} from './openaiCompat'

/** Indices of messages that carry a cache_control marker anywhere in their content. */
function stampedIndices(messages: WireMessage[]): number[] {
  return messages.flatMap((m, i) => {
    const parts = Array.isArray(m.content) ? m.content : []
    return parts.some((p) => (p as { cache_control?: unknown }).cache_control) ? [i] : []
  })
}

describe('withCacheBreakpoints — marker placement', () => {
  it('stamps the system block and the last message of a plain turn', () => {
    const out = withCacheBreakpoints([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }
    ])
    expect(stampedIndices(out)).toEqual([0, 2, 3])
  })

  it('stamps the trailing TOOL results in an agentic round, not just the last user turn', () => {
    // The case that tanked hit rates: rounds 2..n of a tool loop must cache the accumulated
    // tool tail, so each provider call reads the previous round's prefix instead of
    // re-processing every tool result since the last user message.
    const out = withCacheBreakpoints([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 't', content: '{"ok":true}' },
      { role: 'tool', tool_call_id: 'c2', name: 't', content: '{"ok":true}' }
    ])
    // system + the last two stampable messages (both tool results); the null-content
    // assistant tool_calls message is skipped as unstampable.
    expect(stampedIndices(out)).toEqual([0, 3, 4])
  })

  it('never stamps the system block twice or overflows onto it from the tail scan', () => {
    const out = withCacheBreakpoints([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q' }
    ])
    expect(stampedIndices(out)).toEqual([0, 1])
    const sysParts = out[0]!.content as { cache_control?: unknown }[]
    expect(sysParts.filter((p) => p.cache_control)).toHaveLength(1)
  })

  it('stays at or under 3 markers total (Anthropic allows 4)', () => {
    const long: WireMessage[] = [
      { role: 'system', content: 'sys' },
      ...Array.from({ length: 20 }, (_, i): WireMessage => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }))
    ]
    expect(stampedIndices(withCacheBreakpoints(long)).length).toBeLessThanOrEqual(3)
  })

  it('serializes shared-prefix messages byte-identically across consecutive requests', () => {
    // The flap bug: a message stamped on turn N (parts form) but unstamped on turn N+1 must not
    // revert to string form — gateways hash serialized bytes, and the flap breaks the prefix
    // match and zeroes the cache hit rate. Every message is parts-normalized, always.
    const turnN: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }
    ]
    const turnN1: WireMessage[] = [
      ...turnN,
      { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }
    ]
    const a = withCacheBreakpoints(turnN)
    const b = withCacheBreakpoints(turnN1)
    // The markers themselves legitimately move between requests (gateways strip them before
    // hashing — verified live). What must NOT change is the content serialization: with the
    // markers removed, every shared-prefix message must be byte-identical across requests.
    const strip = (m: WireMessage): string =>
      JSON.stringify({
        ...m,
        content: Array.isArray(m.content)
          ? m.content.map((p) => {
              const { cache_control: _, ...rest } = p as unknown as Record<string, unknown>
              return rest
            })
          : m.content
      })
    for (let i = 0; i < turnN.length; i++) expect(strip(b[i]!)).toBe(strip(a[i]!))
    // and every shared-prefix message is in parts form on both sides (no string<->parts flap)
    for (let i = 0; i < turnN.length; i++) {
      expect(Array.isArray(a[i]!.content)).toBe(true)
      expect(Array.isArray(b[i]!.content)).toBe(true)
    }
  })

  it('stamps the final part of multipart (attachment) content without duplicating parts', () => {
    const out = withCacheBreakpoints([
      { role: 'system', content: 'sys' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'look at this' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } }
        ]
      }
    ])
    const parts = out[1]!.content as unknown as ({ cache_control?: unknown } & Record<string, unknown>)[]
    expect(parts).toHaveLength(2)
    expect(parts[1]!.cache_control).toEqual({ type: 'ephemeral' })
  })
})

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

describe('makeControlTokenStripper — DeepSeek/DSML sentinel leakage', () => {
  const strip = (chunks: string[]): string => {
    const s = makeControlTokenStripper()
    return chunks.map((c) => s.push(c)).join('') + s.flush()
  }

  it('removes the exact DSML tool-call sentinels observed leaking into content', () => {
    // Byte-for-byte the corruption captured in the event store (U+FF5C delimiters):
    // `<｜DSML｜tool_calls</｜DSML｜invoke>` rendered as visible text around real prose.
    const leaked =
      '\n<｜DSML｜tool_calls</｜DSML｜invoke>...\n\nLet me check the workspace and set up the plan.\n\n<｜DSML｜tool_calls</｜DSML｜invoke>\n'
    expect(strip([leaked])).toBe('\n...\n\nLet me check the workspace and set up the plan.\n\n\n')
  })

  it('strips classic DeepSeek tool-call sentinels (U+2581 markers)', () => {
    expect(strip(['<｜tool▁calls▁begin｜>hi<｜tool▁calls▁end｜>'])).toBe('hi')
  })

  it('reassembles and strips a sentinel split across chunk boundaries', () => {
    expect(strip(['before <', '｜DSML｜tool', '_calls｜> after'])).toBe('before  after')
    expect(strip(['mid<｜DSM', 'L｜invoke> tail'])).toBe('mid tail')
  })

  it('never eats ordinary prose or markup — only ｜-bearing tags go', () => {
    expect(strip(['if x < y and a > b then'])).toBe('if x < y and a > b then')
    expect(strip(['render <div className="x"> ok'])).toBe('render <div className="x"> ok')
    // a trailing `<` at a boundary is held then released, not dropped
    expect(strip(['count 3 <', ' 4 always'])).toBe('count 3 < 4 always')
  })

  it('releases a held partial verbatim on flush when it never became a sentinel', () => {
    const s = makeControlTokenStripper()
    expect(s.push('trailing <')).toBe('trailing ')
    expect(s.flush()).toBe('<')
  })
})

describe('streamChat — reasoning delta shapes', () => {
  const provider: ProviderConfig = {
    id: 'p', label: 'p', kind: 'openai-compat', baseUrl: 'http://localhost:9999', apiKey: 'k', enabled: true
  }

  function sseFrom(chunks: unknown[]): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const c of chunks) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(c)}\n\n`))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  afterEach(() => vi.unstubAllGlobals())

  it('reads reasoning from reasoning_details when the plain fields are null (openrouter/meta shape)', async () => {
    // Observed live: chunks carry reasoning:null with the actual text only in reasoning_details.
    // Dropping these made reasoning models look frozen for their whole thinking phase.
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { role: 'assistant', content: '', reasoning: 'thinking aloud ' } }] },
        { choices: [{ delta: { role: 'assistant', content: '', reasoning: null, reasoning_details: [{ type: 'reasoning.text', text: 'more thought' }] } }] },
        { choices: [{ delta: { content: 'answer' }, finish_reason: 'stop' }] }
      ])
    ))
    let reasoning = ''
    let text = ''
    for await (const chunk of streamChat(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
    })) {
      if (chunk.type === 'reasoning') reasoning += chunk.text
      if (chunk.type === 'text') text += chunk.text
    }
    expect(reasoning).toBe('thinking aloud more thought')
    expect(text).toBe('answer')
  })

  it('scrubs leaked DSML tool-call sentinels out of the streamed text', async () => {
    // The openrouter/deepseek-v4 failure: native tool-call tokens arrive as literal content.
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: '<｜DSML｜tool_calls</｜DSML｜invoke>...\n\nLet me check the workspace.' } }] },
        { choices: [{ delta: { content: ' Done.' }, finish_reason: 'stop' }] }
      ])
    ))
    let text = ''
    for await (const chunk of streamChat(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
    })) {
      if (chunk.type === 'text') text += chunk.text
    }
    expect(text).toBe('...\n\nLet me check the workspace. Done.')
  })

  it('emits ONE usage chunk (latest wins) when a gateway reports cumulative usage on every chunk', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: 'a' } }], usage: { prompt_tokens: 100, completion_tokens: 1 } },
        { choices: [{ delta: { content: 'b' } }], usage: { prompt_tokens: 100, completion_tokens: 2 } },
        { choices: [{ delta: {} , finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 3 } }
      ])
    ))
    const usages: unknown[] = []
    let tokensOut = 0
    for await (const chunk of streamChat(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
    })) {
      if (chunk.type === 'usage') {
        usages.push(chunk.usage)
        tokensOut = chunk.usage.tokensOut ?? 0
      }
    }
    // A caller that sums usage chunks across rounds must see exactly one per stream — three
    // cumulative reports summed naively would claim 300 input / 6 output tokens.
    expect(usages).toHaveLength(1)
    expect(tokensOut).toBe(3)
  })

  it('never double-counts reasoning present in both the plain field and reasoning_details', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { reasoning: 'once', reasoning_details: [{ type: 'reasoning.text', text: 'once' }] } }] }
      ])
    ))
    let reasoning = ''
    for await (const chunk of streamChat(provider, {
      model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
    })) {
      if (chunk.type === 'reasoning') reasoning += chunk.text
    }
    expect(reasoning).toBe('once')
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

describe('streamChat — OpenRouter usage.include extension', () => {
  const provider: ProviderConfig = {
    id: 'p',
    label: 'p',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:9999',
    apiKey: 'k',
    enabled: true
  }

  function sseResponse(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  async function captureBody(model: string): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {}
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}')
      return sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)
    for await (const _ of streamChat(provider, {
      model,
      messages: [{ role: 'user', content: 'hi' }],
      cache: false,
      signal: new AbortController().signal
    })) {
      void _
    }
    return captured
  }

  afterEach(() => vi.unstubAllGlobals())

  // Without this, OpenRouter (hit directly or via a gateway proxying to it) omits `usage.cost`
  // from the response, forcing the caller onto the less-accurate list-price estimate.
  it('requests cost in usage for an openrouter/-routed model', async () => {
    expect((await captureBody('openrouter/openai/gpt-5.6-luna')).usage).toEqual({ include: true })
  })

  // Scoped deliberately: an unrecognized top-level field has caused hard 400s on other strict
  // OpenAI-compatible backends (see the reasoning_effort retry above), so non-OpenRouter models
  // must never carry it.
  it('omits it for every other model', async () => {
    expect(await captureBody('cc/claude-fable-5')).not.toHaveProperty('usage')
    expect(await captureBody('mac/qwen3-coder:30b')).not.toHaveProperty('usage')
  })
})

describe('streamChat — retry when the backend rejects reasoning_effort', () => {
  const provider: ProviderConfig = {
    id: 'p',
    label: 'p',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:9999',
    apiKey: 'k',
    enabled: true
  }

  function sseOk(): Response {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }

  function badRequest(message: string): Response {
    return new Response(JSON.stringify({ error: { message, type: 'invalid_request_error', code: 'bad_request' } }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' }
    })
  }

  async function drain(effort: string | undefined, fetchMock: ReturnType<typeof vi.fn>): Promise<string> {
    vi.stubGlobal('fetch', fetchMock)
    let text = ''
    for await (const chunk of streamChat(provider, {
      model: 'qwen3-coder:30b',
      messages: [{ role: 'user', content: 'hi' }],
      effort,
      cache: false,
      signal: new AbortController().signal
    })) {
      if (chunk.type === 'text') text += chunk.text
    }
    return text
  }

  afterEach(() => vi.unstubAllGlobals())

  // The exact failure from the screenshot: qwen3-coder on Ollama 400s `does not support thinking`.
  // The stream must recover transparently by retrying without reasoning_effort.
  it('drops reasoning_effort and retries once on a "does not support thinking" 400', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      return 'reasoning_effort' in parsed ? badRequest('"qwen3-coder:30b" does not support thinking') : sseOk()
    })
    expect(await drain('high', fetchMock)).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toHaveProperty('reasoning_effort', 'high')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')
  })

  it('does not retry when reasoning_effort was never sent', async () => {
    const fetchMock = vi.fn(async () => badRequest('some other problem'))
    await expect(drain(undefined, fetchMock)).rejects.toThrow(/HTTP 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('surfaces an unrelated 400 instead of retrying it away', async () => {
    const fetchMock = vi.fn(async () => badRequest('context length exceeded'))
    await expect(drain('high', fetchMock)).rejects.toThrow(/context length exceeded/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
