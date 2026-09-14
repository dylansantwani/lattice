import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ProviderConfig } from '@shared/types'
import {
  makeControlTokenStripper,
  mapUsage,
  salvageRawToolCalls,
  coerceToolArgs,
  sanitizeToolArgs,
  streamChat,
  withCacheBreakpoints,
  type WireMessage,
  flattenContentParts,
  withContinuationNudge,
  CONTINUE_INSTRUCTION,
  resetProviderQuirks
} from './openaiCompat'

/** Indices of messages that carry a cache_control marker — message-level (tool results) or on any content part. */
function stampedIndices(messages: WireMessage[]): number[] {
  return messages.flatMap((m, i) => {
    const messageLevel = (m as { cache_control?: unknown }).cache_control
    const parts = Array.isArray(m.content) ? m.content : []
    const partLevel = parts.some((p) => (p as { cache_control?: unknown }).cache_control)
    return messageLevel || partLevel ? [i] : []
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

  it('marks a trailing tool result on the MESSAGE, never inside tool_result.content', () => {
    // The live HTTP 400: "cache_control may not be specified within `tool_result.content`. Instead,
    // place it directly on `tool_result`." A role:'tool' message maps to an Anthropic tool_result
    // block, so the breakpoint must ride the message level, never a content part.
    const out = withCacheBreakpoints([
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 't', content: '{"ok":true}' }
    ])
    const toolMsg = out[3]! as WireMessage & { cache_control?: unknown }
    // marker on the message itself...
    expect(toolMsg.cache_control).toEqual({ type: 'ephemeral' })
    // ...and NOT on any content part (that is the exact shape Anthropic rejects).
    const toolParts = (toolMsg.content as unknown as { cache_control?: unknown }[]) ?? []
    expect(toolParts.some((p) => p.cache_control)).toBe(false)
    // non-tool targets keep the marker on a content part.
    const sysParts = out[0]!.content as unknown as { cache_control?: unknown }[]
    expect(sysParts.some((p) => p.cache_control)).toBe(true)
    expect((out[0]! as { cache_control?: unknown }).cache_control).toBeUndefined()
  })

  it('is idempotent — re-stamping a stamped transcript never accumulates past the cap', () => {
    // "A maximum of 4 blocks with cache_control may be provided" 400s if markers pile up when a
    // previously-stamped wire is fed back through. Each pass must reset to exactly the round's markers.
    const turn: WireMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'do the thing' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 't', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', name: 't', content: '{"a":1}' },
      { role: 'tool', tool_call_id: 'c2', name: 't', content: '{"b":2}' }
    ]
    const once = withCacheBreakpoints(turn)
    const twice = withCacheBreakpoints(once)
    expect(stampedIndices(twice)).toEqual(stampedIndices(once))
    expect(stampedIndices(twice).length).toBeLessThanOrEqual(4)
    // No message carries more than one marker across all its parts + message level.
    const markerCount = (m: WireMessage): number => {
      const parts = Array.isArray(m.content) ? m.content : []
      return (
        parts.filter((p) => (p as { cache_control?: unknown }).cache_control).length +
        ((m as { cache_control?: unknown }).cache_control ? 1 : 0)
      )
    }
    for (const m of twice) expect(markerCount(m)).toBeLessThanOrEqual(1)
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

  it('raises an error the gateway reported inside a 200 SSE body instead of ending empty', async () => {
    // OpenRouter's free pool reports upstream rate limits as `data: {"error":{...}}` on a 200
    // response. The chunk has no `choices`, so it used to be dropped: the round ended with no
    // content and the turn finished as a silent, complete-looking stop.
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([{ error: { code: 429, message: 'rate-limited upstream' } }])
    ))
    const chunks: string[] = []
    await expect(
      (async () => {
        for await (const chunk of streamChat(provider, {
          model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
        })) chunks.push(chunk.type)
      })()
    ).rejects.toMatchObject({ status: 429, body: expect.stringContaining('rate-limited upstream') })
    expect(chunks).toEqual([])
  })

  it('maps an in-stream cooldown payload (string code, no numeric status) to 429', async () => {
    // OpenRouter's free pool ends a stalled free route with a rate-limit error whose `code` is the
    // string "model_cooldown" (no numeric HTTP status). It must reach the model_cooldown branch of
    // classifyError, which is gated on 429 — not the generic 502 fallback.
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        {
          error: {
            type: 'rate_limit_error',
            code: 'model_cooldown',
            model: 'minimax/minimax-m3:free',
            reset_seconds: 24,
            message: 'All credentials for model minimax/minimax-m3:free are cooling down'
          }
        }
      ])
    ))
    let caught: unknown
    await (async () => {
      for await (const _ of streamChat(provider, {
        model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
      })) { /* drain */ }
    })().catch((e) => { caught = e })
    expect(caught).toMatchObject({ status: 429, body: expect.stringContaining('cooling down') })
    // The structured fields survive into the body so the classifier can name the model and wait.
    const details = JSON.parse((caught as { body: string }).body)
    expect(details).toMatchObject({ model: 'minimax/minimax-m3:free', reset_seconds: 24 })
  })

  it('treats a statusless in-stream error as a 502 so the round is retried, not rejected', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => sseFrom([{ error: { message: 'upstream connection closed' } }])))
    await expect(
      (async () => {
        for await (const _ of streamChat(provider, {
          model: 'm', messages: [{ role: 'user', content: 'q' }], cache: false, signal: new AbortController().signal
        })) { /* drain */ }
      })()
    ).rejects.toMatchObject({ status: 502 })
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
    expect((await captureBody('max')).reasoning_effort).toBe('max')
    expect((await captureBody('ultra')).reasoning_effort).toBe('ultra')
  })

  // "No thinking" must reach the gateway as an explicit `none`: OmniRoute fills in the model's
  // default effort when the field is absent, so an omitted field quietly re-enabled thinking on
  // every "No thinking" thread.
  it('sends reasoning_effort "none" for none / off', async () => {
    expect((await captureBody('none')).reasoning_effort).toBe('none')
    expect((await captureBody('off')).reasoning_effort).toBe('none')
  })

  // No preference is not a licence for the gateway to choose. Measured on claude-sonnet-5 with a
  // 17-token prompt, letting OmniRoute substitute the model's default effort took time to first
  // visible text from 1364ms to 3148ms — paid by every title, drift and compaction pass, and by any
  // thread whose meta carries no tier.
  it('sends "none" rather than omitting the field when no tier was requested', async () => {
    expect((await captureBody(undefined)).reasoning_effort).toBe('none')
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

describe('streamChat — parallel_tool_calls on tool-bearing requests', () => {
  const provider: ProviderConfig = {
    id: 'p',
    label: 'p',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:9999',
    apiKey: 'k',
    enabled: true
  }

  const someTool = {
    type: 'function' as const,
    function: { name: 'fs_read', description: 'read', parameters: { type: 'object', properties: {} } }
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

  async function drain(withTools: boolean, fetchMock: ReturnType<typeof vi.fn>): Promise<void> {
    vi.stubGlobal('fetch', fetchMock)
    for await (const _ of streamChat(provider, {
      model: 'ds/deepseek-v4-flash',
      messages: [{ role: 'user', content: 'hi' }],
      tools: withTools ? [someTool] : undefined,
      cache: false,
      signal: new AbortController().signal
    })) {
      void _
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderQuirks()
  })

  // A model emitting one tool call per round re-bills the whole transcript once per call (measured
  // 1.26 calls/round on a DeepSeek session), so batching is asked for explicitly — the OpenAI-compat
  // default varies by backend.
  it('sends parallel_tool_calls: true when tools are offered, and omits it otherwise', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      bodies.push(JSON.parse(init.body ?? '{}'))
      return sseOk()
    })
    await drain(true, fetchMock)
    await drain(false, fetchMock)
    expect(bodies[0]).toHaveProperty('parallel_tool_calls', true)
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls')
  })

  it('drops the field, remembers the quirk, and retries once when a strict backend 400s on it', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      return 'parallel_tool_calls' in parsed
        ? badRequest('Unrecognized request argument supplied: parallel_tool_calls')
        : sseOk()
    })
    await drain(true, fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(bodies[0]).toHaveProperty('parallel_tool_calls', true)
    expect(bodies[1]).not.toHaveProperty('parallel_tool_calls')

    // Later requests skip the field without paying another 400.
    await drain(true, fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodies[2]).not.toHaveProperty('parallel_tool_calls')
  })

  it('does not swallow an unrelated tool 400 as a parallel_tool_calls quirk', async () => {
    const fetchMock = vi.fn(async () => badRequest('tools[0].function.parameters is invalid'))
    await expect(drain(true, fetchMock)).rejects.toThrow(/HTTP 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
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

  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderQuirks()
  })

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

  it('does not retry a 400 that says nothing about reasoning', async () => {
    const fetchMock = vi.fn(async () => badRequest('some other problem'))
    await expect(drain(undefined, fetchMock)).rejects.toThrow(/HTTP 400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // A model whose tiers start at `low` (opus-5) rejects the `none` we send for "no thinking". That
  // proves only that it has no off switch — condemning it to an omitted field would hand the
  // gateway's default effort back to the very threads that asked for a tier explicitly.
  it('drops only the disabling "none" when a model rejects it, and still sends a chosen tier', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      return parsed.reasoning_effort === 'none'
        ? badRequest('Invalid value for reasoning_effort: none')
        : sseOk()
    })
    expect(await drain(undefined, fetchMock)).toBe('hi')
    expect(bodies[0]).toHaveProperty('reasoning_effort', 'none')
    expect(bodies[1]).not.toHaveProperty('reasoning_effort')

    // Same model, now with a real tier: it must go out, not be suppressed by the earlier rejection.
    expect(await drain('high', fetchMock)).toBe('hi')
    expect(bodies[2]).toHaveProperty('reasoning_effort', 'high')
    expect(fetchMock).toHaveBeenCalledTimes(3)

    // And a later "no thinking" request skips straight to the field-less form, no second 400.
    expect(await drain('off', fetchMock)).toBe('hi')
    expect(bodies[3]).not.toHaveProperty('reasoning_effort')
    expect(fetchMock).toHaveBeenCalledTimes(4)
  })

  it('remembers the rejection per model so later requests skip the field without a 400', async () => {
    const bodies: Record<string, unknown>[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      return 'reasoning_effort' in parsed ? badRequest('"qwen3-coder:30b" does not support thinking') : sseOk()
    })
    expect(await drain('high', fetchMock)).toBe('hi')
    expect(await drain('high', fetchMock)).toBe('hi')
    // First request: 400 + retry. Second request: straight through, field already dropped.
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodies[2]).not.toHaveProperty('reasoning_effort')
  })

  it('surfaces an unrelated 400 instead of retrying it away', async () => {
    const fetchMock = vi.fn(async () => badRequest('context length exceeded'))
    await expect(drain('high', fetchMock)).rejects.toThrow(/context length exceeded/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('streamChat — backends that refuse assistant prefill', () => {
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
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":" and on"},"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      }
    })
    return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } })
  }
  const prefillRejection = (): Response =>
    new Response(
      JSON.stringify({
        error: {
          message: '[400]: This model does not support assistant message prefill. The conversation must end with a user message.',
          type: 'invalid_request_error'
        }
      }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )

  /** A resumed reply's wire: history, then the partial answer as the trailing assistant message. */
  const resumeWire = () => [
    { role: 'user' as const, content: 'count to ten' },
    { role: 'assistant' as const, content: '1 2 3 4' }
  ]

  const drain = async (fetchMock: ReturnType<typeof vi.fn>, messages = resumeWire()): Promise<string> => {
    vi.stubGlobal('fetch', fetchMock)
    let text = ''
    for await (const chunk of streamChat(provider, {
      model: 'cc/claude-sonnet-5',
      messages,
      cache: false,
      signal: new AbortController().signal
    })) {
      if (chunk.type === 'text') text += chunk.text
    }
    return text
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderQuirks()
  })

  // The exact 400 from the Claude Code OAuth lane. Resuming an interrupted reply must not die on it.
  it('asks for the continuation in a user turn and retries once', async () => {
    const bodies: { messages: { role: string; content: string }[] }[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      const last = parsed.messages[parsed.messages.length - 1]
      return last.role === 'assistant' ? prefillRejection() : sseOk()
    })
    expect(await drain(fetchMock)).toBe(' and on')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    // First attempt: prefill. Second: the partial reply is still there, followed by the ask.
    expect(bodies[0]!.messages[bodies[0]!.messages.length - 1]!.role).toBe('assistant')
    const retried = bodies[1]!.messages
    expect(retried[retried.length - 2]).toMatchObject({ role: 'assistant', content: '1 2 3 4' })
    expect(retried[retried.length - 1]).toMatchObject({ role: 'user', content: CONTINUE_INSTRUCTION })
  })

  it('remembers the backend per model, so later resumes cost one request, not a 400 plus a retry', async () => {
    const bodies: { messages: { role: string }[] }[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      const last = parsed.messages[parsed.messages.length - 1]
      return last.role === 'assistant' ? prefillRejection() : sseOk()
    })
    await drain(fetchMock)
    await drain(fetchMock)
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodies[2]!.messages[bodies[2]!.messages.length - 1]!.role).toBe('user')
  })

  it('leaves an ordinary request alone — the nudge only applies to a trailing assistant message', () => {
    const ordinary = [{ role: 'user' as const, content: 'hi' }]
    expect(withContinuationNudge(ordinary)).toEqual(ordinary)
    // An assistant message carrying tool calls is a tool round, not a prefill.
    const toolRound = [
      { role: 'user' as const, content: 'hi' },
      {
        role: 'assistant' as const,
        content: null,
        tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 't', arguments: '{}' } }]
      }
    ]
    expect(withContinuationNudge(toolRound)).toEqual(toolRound)
  })

  it('tells the model not to repeat itself or start over', () => {
    // A resumed reply that re-introduces itself, or repeats its first half, is worse than a restart.
    expect(CONTINUE_INSTRUCTION).toMatch(/do not repeat/i)
    expect(CONTINUE_INSTRUCTION).toMatch(/do not start over/i)
    expect(CONTINUE_INSTRUCTION).toMatch(/preamble/i)
  })

  it('surfaces an unrelated 400 rather than nudging it away', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ error: { message: 'context length exceeded' } }), { status: 400 }))
    await expect(drain(fetchMock)).rejects.toThrow(/context length exceeded/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('withCacheBreakpoints — stable history anchor (4th marker)', () => {
  const turn = (n: number): WireMessage[] => {
    const wire: WireMessage[] = [{ role: 'system', content: 'sys' }, { role: 'user', content: 'q' }]
    for (let i = 0; i < n; i++) {
      wire.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'fs_read', arguments: '{}' } }]
      })
      wire.push({ role: 'tool', tool_call_id: `c${i}`, name: 'fs_read', content: `result ${i}` })
    }
    return wire
  }

  it('pins a marker at the history boundary in addition to system and the two tail markers', () => {
    // Anchor at the user turn (index 1) — the wire as the run found it — with 6 tool rounds after.
    const out = withCacheBreakpoints(turn(6), 1)
    const stamped = stampedIndices(out)
    expect(stamped).toContain(0) // system
    expect(stamped).toContain(1) // stable anchor
    expect(stamped.length).toBeLessThanOrEqual(4) // never exceeds Anthropic's cap
    // The two tail markers are still the last stampable messages.
    expect(stamped).toContain(out.length - 1)
  })

  it('walks back from an unstampable anchor (a content:null tool_calls turn) to real content', () => {
    const wire = turn(3)
    // Anchor on an assistant tool_calls message (content:null, index 2): the marker must land on
    // the nearest stampable message at or before it — the user turn at index 1.
    const out = withCacheBreakpoints(wire, 2)
    expect(stampedIndices(out)).toContain(1)
  })

  it('skips the anchor when a tail marker already covers it (a short turn)', () => {
    const out = withCacheBreakpoints(
      [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'q' },
        { role: 'assistant', content: 'a' }
      ],
      1
    )
    // Tail markers already stamp indices 1 and 2; the anchor adds nothing and nothing doubles up.
    expect(stampedIndices(out)).toEqual([0, 1, 2])
  })

  it('keeps the anchor byte-stable across successive rounds of the same turn', () => {
    // Round k and round k+1 of one turn share the anchor; the anchored message must serialize
    // identically in both requests (the tail markers may move, the anchor may not).
    const a = withCacheBreakpoints(turn(4), 1)
    const b = withCacheBreakpoints(turn(6), 1)
    expect(JSON.stringify(a[1])).toBe(JSON.stringify(b[1]))
    expect(stampedIndices(a)).toContain(1)
    expect(stampedIndices(b)).toContain(1)
  })
})

describe('makeControlTokenStripper — dropped tool-call detection', () => {
  it('counts scrubbed sentinels so the run loop can recover the lost call', () => {
    const s = makeControlTokenStripper()
    s.push('<｜DSML｜tool_calls</｜DSML｜invoke> and then')
    expect(s.strippedCount()).toBeGreaterThan(0)
  })

  it('reports zero for clean prose and markup', () => {
    const s = makeControlTokenStripper()
    s.push('if x < y then render <div className="x">')
    s.flush()
    expect(s.strippedCount()).toBe(0)
  })
})

describe('streamChat — raw_tool_tokens signal', () => {
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

  it('emits raw_tool_tokens when DSML sentinels leaked into the content channel', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: 'Applying the fix. <｜DSML｜tool_calls</｜DSML｜invoke>' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
    ))
    const chunks: unknown[] = []
    for await (const c of streamChat(provider, { model: 'm', messages: [], signal: new AbortController().signal })) {
      chunks.push(c)
    }
    const signal = chunks.find((c) => (c as { type: string }).type === 'raw_tool_tokens')
    expect(signal).toBeTruthy()
    expect((signal as { count: number }).count).toBeGreaterThan(0)
  })

  it('does not emit raw_tool_tokens for a clean stream', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: 'plain reply with a < sign' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
    ))
    const chunks: unknown[] = []
    for await (const c of streamChat(provider, { model: 'm', messages: [], signal: new AbortController().signal })) {
      chunks.push(c)
    }
    expect(chunks.some((c) => (c as { type: string }).type === 'raw_tool_tokens')).toBe(false)
  })
})

describe('salvageRawToolCalls — recovering calls a route emitted as raw text', () => {
  const OFFERED = ['fs_read', 'shell', 'grep_search']

  it('parses the documented classic DeepSeek framing', () => {
    const raw =
      'Let me check.\n<｜tool▁calls▁begin｜><｜tool▁call▁begin｜>function<｜tool▁sep｜>fs_read\n' +
      '```json\n{"path":"src/main.ts"}\n```<｜tool▁call▁end｜><｜tool▁calls▁end｜>'
    expect(salvageRawToolCalls(raw, OFFERED)).toEqual([{ name: 'fs_read', args: '{"path":"src/main.ts"}' }])
  })

  it('parses a DSML-style leak: offered name near a sentinel, followed by JSON args', () => {
    const raw = 'Applying the fix now.\n<｜DSML｜invoke｜>shell\n{"command":"pnpm test"}\n</｜DSML｜invoke>'
    expect(salvageRawToolCalls(raw, OFFERED)).toEqual([{ name: 'shell', args: '{"command":"pnpm test"}' }])
  })

  it('recovers multiple calls in stream order', () => {
    const raw =
      '<｜DSML｜invoke｜>fs_read {"path":"a.ts"}</｜DSML｜invoke>' +
      '<｜DSML｜invoke｜>grep_search {"pattern":"foo","path":"src"}</｜DSML｜invoke>'
    expect(salvageRawToolCalls(raw, OFFERED).map((c) => c.name)).toEqual(['fs_read', 'grep_search'])
  })

  it('handles braces inside JSON string values', () => {
    const raw = '<｜DSML｜invoke｜>shell {"command":"echo \'{not json}\' && ls"}</｜DSML｜invoke>'
    const calls = salvageRawToolCalls(raw, OFFERED)
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0]!.args)).toEqual({ command: "echo '{not json}' && ls" })
  })

  it('never fabricates a call from plain prose mentioning a tool', () => {
    expect(salvageRawToolCalls('You could use fs_read {"path":"x"} for this.', OFFERED)).toEqual([])
  })

  it('rejects unoffered tool names and invalid JSON', () => {
    expect(salvageRawToolCalls('<｜DSML｜invoke｜>rm_rf {"path":"/"}</｜DSML｜invoke>', OFFERED)).toEqual([])
    expect(salvageRawToolCalls('<｜DSML｜invoke｜>shell {command: broken</｜DSML｜invoke>', OFFERED)).toEqual([])
  })

  it('returns nothing for empty input or an empty tool list', () => {
    expect(salvageRawToolCalls('', OFFERED)).toEqual([])
    expect(salvageRawToolCalls('<｜x｜>shell {"a":1}', [])).toEqual([])
  })
})

describe('streamChat — eager request + salvage integration', () => {
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

  it('fires the HTTP request at call time, before the generator is consumed', async () => {
    const fetchMock = vi.fn(async () => sseFrom([{ choices: [{ delta: { content: 'hi' }, finish_reason: 'stop' }] }]))
    vi.stubGlobal('fetch', fetchMock)
    const gen = streamChat(provider, { model: 'm', messages: [], signal: new AbortController().signal })
    await new Promise((r) => setTimeout(r, 0))
    expect(fetchMock).toHaveBeenCalledTimes(1) // the request went out with zero next() calls
    const chunks: unknown[] = []
    for await (const c of gen) chunks.push(c)
    expect(chunks.some((c) => (c as { type: string }).type === 'text')).toBe(true)
  })

  it('synthesizes tool_call_delta chunks from a leaked call instead of raw_tool_tokens', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: 'Reading it now. <｜DSML｜invoke｜>fs_read {"path":"src/a.ts"}</｜DSML｜invoke>' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
    ))
    const chunks: { type: string; name?: string; argsDelta?: string }[] = []
    for await (const c of streamChat(provider, {
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'fs_read', parameters: {} } }],
      signal: new AbortController().signal
    })) {
      chunks.push(c as { type: string })
    }
    const call = chunks.find((c) => c.type === 'tool_call_delta')
    expect(call).toMatchObject({ name: 'fs_read', argsDelta: '{"path":"src/a.ts"}' })
    expect(chunks.some((c) => c.type === 'raw_tool_tokens')).toBe(false)
  })

  it('still emits raw_tool_tokens when the leak holds nothing recoverable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () =>
      sseFrom([
        { choices: [{ delta: { content: 'Doing it. <｜DSML｜tool_calls</｜DSML｜invoke>' } }] },
        { choices: [{ delta: {}, finish_reason: 'stop' }] }
      ])
    ))
    const chunks: { type: string }[] = []
    for await (const c of streamChat(provider, {
      model: 'm',
      messages: [],
      tools: [{ type: 'function', function: { name: 'fs_read', parameters: {} } }],
      signal: new AbortController().signal
    })) {
      chunks.push(c as { type: string })
    }
    expect(chunks.some((c) => c.type === 'raw_tool_tokens')).toBe(true)
    expect(chunks.some((c) => c.type === 'tool_call_delta')).toBe(false)
  })
})

describe('sanitizeToolArgs — never send non-object tool_use.input', () => {
  it('passes a valid object through byte-for-byte (cache stays intact)', () => {
    const valid = '{"path":"src/main.ts","start":1}'
    expect(sanitizeToolArgs(valid)).toBe(valid)
    // whitespace/formatting inside a valid object is preserved, not reformatted
    const spaced = '{ "a": 1 }'
    expect(sanitizeToolArgs(spaced)).toBe(spaced)
  })

  it('coerces empty / whitespace / null / undefined to {}', () => {
    expect(sanitizeToolArgs('')).toBe('{}')
    expect(sanitizeToolArgs('   ')).toBe('{}')
    expect(sanitizeToolArgs(null)).toBe('{}')
    expect(sanitizeToolArgs(undefined)).toBe('{}')
  })

  it('rejects non-object JSON (arrays, bare strings, numbers) → {}', () => {
    expect(sanitizeToolArgs('[1,2,3]')).toBe('{}')
    expect(sanitizeToolArgs('"just a string"')).toBe('{}')
    expect(sanitizeToolArgs('42')).toBe('{}')
  })

  it('drops a truncated fragment rather than fabricating a close', () => {
    // The exact wedge observed in the wild: a run_agent call persisted mid-stream, quote-wrapped
    // and cut off before its closing brace. Auto-closing would invent arguments, so it becomes {}.
    const truncated = '\'{"name": "eBay Offer Finder", "agent_type": "researcher", "model": "codex/gpt-5.6-luna"\''
    expect(sanitizeToolArgs(truncated)).toBe('{}')
  })

  it('unwraps one layer of stray surrounding quotes around a complete object', () => {
    expect(sanitizeToolArgs('\'{"a":1}\'')).toBe('{"a":1}')
    expect(sanitizeToolArgs('"{"a":1}"')).toBe('{"a":1}')
    // smart quotes some routes emit
    expect(sanitizeToolArgs('“{"a":1}”')).toBe('{"a":1}')
  })

  it('takes a balanced object followed by trailing junk', () => {
    expect(sanitizeToolArgs('{"a":1} trailing sentinel garbage')).toBe('{"a":1}')
  })

  it('keeps braces that live inside string values intact', () => {
    const withBraces = '{"cmd":"echo {hi}","n":1}'
    expect(sanitizeToolArgs(withBraces)).toBe(withBraces)
  })
})

describe('streamChat — request body sanitizes tool_call arguments', () => {
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

  afterEach(() => vi.unstubAllGlobals())

  it('replaces a malformed replayed tool_use.input with {} before it reaches the model', async () => {
    let captured: { messages?: WireMessage[] } = {}
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      captured = JSON.parse(init.body ?? '{}')
      return sseResponse()
    })
    vi.stubGlobal('fetch', fetchMock)

    const poisoned: WireMessage[] = [
      { role: 'user', content: 'go' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'ok_tool', arguments: '{"path":"x"}' } },
          { id: 'c2', type: 'function', function: { name: 'run_agent', arguments: '\'{"name":"broken"' } }
        ]
      }
    ]
    for await (const _ of streamChat(provider, {
      model: 'claude/claude-opus-4-8',
      messages: poisoned,
      cache: false,
      signal: new AbortController().signal
    })) {
      void _
    }

    const sentCalls = captured.messages?.[1]?.tool_calls
    expect(sentCalls?.[0]?.function.arguments).toBe('{"path":"x"}') // healthy call untouched
    expect(sentCalls?.[1]?.function.arguments).toBe('{}') // malformed call neutralized
    // the caller's array is not mutated in place
    expect(poisoned[1]?.tool_calls?.[1]?.function.arguments).toBe('\'{"name":"broken"')
  })
})

describe('streamChat — flatten content parts for a backend that wants strings', () => {
  const provider: ProviderConfig = {
    id: 'p',
    label: 'p',
    kind: 'openai-compat',
    baseUrl: 'http://localhost:9999',
    apiKey: 'k',
    enabled: true,
    promptCaching: true
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
  const ollama400 = (): Response =>
    new Response(
      JSON.stringify({ error: { message: 'json: cannot unmarshal array into Go struct field ChatRequest.messages.content of type string' } }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    )
  async function drain(fetchMock: ReturnType<typeof vi.fn>): Promise<string> {
    vi.stubGlobal('fetch', fetchMock)
    let text = ''
    for await (const chunk of streamChat(provider, {
      model: 'pentest/hsnr-staging/gemma4:e4b',
      messages: [
        { role: 'system', content: 'You are Lattice.' },
        { role: 'user', content: 'hi' }
      ],
      effort: 'off',
      cache: true,
      signal: new AbortController().signal
    })) {
      if (chunk.type === 'text') text += chunk.text
    }
    return text
  }
  afterEach(() => {
    vi.unstubAllGlobals()
    resetProviderQuirks()
  })

  // The live failure: a gemma4 route on Ollama 400'd every turn because prompt-cache breakpoints
  // turn `content` into parts, and Ollama's native chat struct only reads a string.
  it('flattens the parts, retries once, and remembers the model wants strings', async () => {
    const bodies: { messages: { content: unknown }[] }[] = []
    const fetchMock = vi.fn(async (_url: unknown, init: { body?: string }) => {
      const parsed = JSON.parse(init.body ?? '{}')
      bodies.push(parsed)
      return parsed.messages.some((m: { content: unknown }) => Array.isArray(m.content)) ? ollama400() : sseOk()
    })
    expect(await drain(fetchMock)).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(Array.isArray(bodies[0]!.messages[0]!.content)).toBe(true)
    expect(bodies[1]!.messages.map((m) => m.content)).toEqual(['You are Lattice.', 'hi'])
    // Second request for the same model goes out flat from the start.
    expect(await drain(fetchMock)).toBe('hi')
    expect(fetchMock).toHaveBeenCalledTimes(3)
    expect(bodies[2]!.messages.every((m) => typeof m.content === 'string')).toBe(true)
  })

  it('flattenContentParts joins text parts, drops cache markers, and leaves image messages alone', () => {
    const out = flattenContentParts([
      { role: 'system', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
      { role: 'tool', content: [{ type: 'text', text: 'r' }], tool_call_id: 't1', cache_control: { type: 'ephemeral' } },
      { role: 'user', content: [{ type: 'text', text: 'see' }, { type: 'image_url', image_url: { url: 'data:x' } }] },
      { role: 'assistant', content: null, tool_calls: [] }
    ])
    expect(out[0]).toEqual({ role: 'system', content: 'ab' })
    expect(out[1]).toEqual({ role: 'tool', content: 'r', tool_call_id: 't1' })
    expect(Array.isArray(out[2]!.content)).toBe(true)
    expect(out[3]!.content).toBeNull()
  })
})

describe('coerceToolArgs — repair vs. honest failure', () => {
  // Verbatim DeepSeek V4 flash outputs captured from OmniRoute's call log on 2026-09-11 (run
  // 01M294GM7HJ344QM5W3NZRZ3K0). Both ended with finish_reason tool_calls and one brace short:
  // the inner MCP-batch `args` object is never closed before `, "tool"`.
  const REAL_A = "{\"parallel\": true, \"calls\": [{\"args\": {\"command\": \"find \\\"$HOME/Downloads\\\" \\\"$HOME/Desktop\\\" \\\"$HOME/Pictures\\\" \\\"$HOME/Documents\\\" -maxdepth 5 -type f \\\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.webp' -o -iname '*.stl' -o -iname '*.3mf' -o -iname '*.step' -o -iname '*.psd' \\\\) 2>/dev/null | grep -iE 'vinyl|shelf|lounge|mini|record|3d|print' | head -40; echo '--- newest images in Downloads/Desktop ---'; find \\\"$HOME/Downloads\\\" \\\"$HOME/Desktop\\\" -maxdepth 3 -type f \\\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' \\\\) -newermt '2026-05-01' -exec ls -la {} \\\\; 2>/dev/null | head -25\", \"purpose\": \"Hunt for original product photos and 3D source files\"}, \"tool\": \"shell\"}, {\"args\": {\"calls\": [{\"args\": {\"url\": \"https://sellercentral.amazon.com/performance/account/health/product-policies\", \"session\": \"sc\"}, \"tool\": \"abrowser_open\"}, {\"args\": {\"actions\": [{\"do\": \"wait\", \"ms\": 4500}], \"session\": \"sc\"}, \"tool\": \"abrowser_act\"}, {\"args\": {\"js\": \"(()=>{const rows=[...document.querySelectorAll('.ahd-product-policy-table-row')];const out=rows.map(r=>{const imgs=[...r.querySelectorAll('img')].map(i=>(i.src||'').replace(/^.*\\\\/images\\\\/I\\\\//,'').split('.')[0]).filter(Boolean);return {txt:(r.innerText||'').replace(/\\\\s+/g,' ').slice(0,140),imgs:imgs}}).filter(o=>/copyright/i.test(o.txt));return {copyrightRows:out,allImgCount:document.querySelectorAll('img').length};})()\", \"session\": \"sc\"}, \"tool\": \"abrowser_eval\"}], \"tool\": \"mcp__abrowser__abrowser_batch\"}]}"
  const REAL_B = "{\"parallel\": true, \"calls\": [{\"args\": {\"command\": \"echo '== candidate original files =='; find ~/Downloads ~/Desktop ~/Pictures ~/Documents ~/Movies -maxdepth 5 -type f \\\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.tif' -o -iname '*.stl' -o -iname '*.3mf' -o -iname '*.step' -o -iname '*.obj' \\\\) \\\\( -iname '*vinyl*' -o -iname '*shelf*' -o -iname '*lounge*' -o -iname '*mini*' -o -iname '*record*' \\\\) -exec stat -f '%Sm  %z bytes  %N' -t '%Y-%m-%d %H:%M' {} \\\\; 2>/dev/null | sort | head -40; echo; echo '== newest images anywhere in Downloads/Desktop/Pictures =='; find ~/Downloads ~/Desktop ~/Pictures -maxdepth 4 -type f \\\\( -iname '*.jpg' -o -iname '*.png' -o -iname '*.heic' \\\\) -newermt '2026-07-01' -exec stat -f '%Sm  %z  %N' -t '%Y-%m-%d %H:%M' {} \\\\; 2>/dev/null | sort | tail -25; echo; echo '== exiftool? =='; which exiftool || echo 'no exiftool (mdls/sips available)'\", \"purpose\": \"Hunt for original photo/STL files with timestamps\"}, \"tool\": \"shell\"}, {\"args\": {\"calls\": [{\"args\": {\"session\": \"sc\", \"url\": \"https://sellercentral.amazon.com/performance/account/health/product-policies\"}, \"tool\": \"abrowser_open\"}, {\"args\": {\"actions\": [{\"do\": \"wait\", \"ms\": 5000}], \"session\": \"sc\"}, \"tool\": \"abrowser_act\"}, {\"args\": {\"js\": \"(()=>{const imgs=[...document.querySelectorAll('img')].map(i=>({src:(i.src||'').replace(/^https:\\\\/\\\\/m\\\\.media-amazon\\\\.com\\\\/images\\\\/I\\\\//,''),w:i.naturalWidth,h:i.naturalHeight,alt:(i.alt||'').slice(0,60),near:(i.closest('tr,[role=row],div')||{}).innerText?i.closest('tr,[role=row],div').innerText.replace(/\\\\s+/g,' ').slice(0,120):''})).filter(o=>/media-amazon|B0|jpg/i.test(o.src));return {count:imgs.length,imgs:imgs.slice(0,12),removedText:(document.body.innerText.match(/image[s]? removed[^\\\\n]{0,80}/gi)||[]).slice(0,6)};})()\", \"session\": \"sc\"}, \"tool\": \"abrowser_eval\"}], \"tool\": \"mcp__abrowser__abrowser_batch\"}]}"

  it('leaves the captured mid-stream brace miss UNRECOVERABLE but names the fault', () => {
    for (const real of [REAL_A, REAL_B]) {
      expect(() => JSON.parse(real)).toThrow()
      // Appending closers cannot fix it: the miss is before the final `]`, not at the end.
      expect(() => JSON.parse(real + '}')).toThrow()
      const c = coerceToolArgs(real)
      expect(c).toMatchObject({ text: '{}', kind: 'unrecoverable' })
      expect(c.issue).toMatch(/Expected ',' or '}'/)
      expect(c.issue).toMatch(/a "\]" at position \d+ arrives while an object is still open — a "}" is missing somewhere before it/)
    }
  })

  it('does not "repair" a mismatch by inserting a closer where the stack says (that yields valid JSON with the wrong structure)', () => {
    // Inserting `}` before the `]` here would put `tool` inside `args` — plausible JSON, wrong call.
    const c = coerceToolArgs('{"calls": [{"args": {"x": 1, "tool": "t"}]}')
    expect(c.kind).toBe('unrecoverable')
  })

  it('appends the closers a complete call left off its END, in the right order ({ [ { → } ] })', () => {
    expect(coerceToolArgs('{"calls": [{"tool": "shell", "args": {"command": "ls"}')).toEqual({
      text: '{"calls": [{"tool": "shell", "args": {"command": "ls"}}]}',
      kind: 'repaired'
    })
    expect(coerceToolArgs('{"a": {"b": 1}').text).toBe('{"a": {"b": 1}}')
  })

  it('never closes a buffer cut mid-value (ends inside a string or after a value, not on a closer)', () => {
    expect(coerceToolArgs('{"a": {"b": "unterminated').kind).toBe('unrecoverable')
    expect(coerceToolArgs('{"a": {"b": "unterminated').issue).toMatch(/unterminated string/)
    expect(coerceToolArgs('{"a": {"b": 1').kind).toBe('unrecoverable')
    expect(coerceToolArgs('{"a": {"b": "x"').kind).toBe('unrecoverable')
    // The original wedge: a quote-wrapped run_agent call cut before its closing brace stays {}.
    const truncated = '\'{"name": "eBay Offer Finder", "agent_type": "researcher", "model": "codex/gpt-5.6-luna"\''
    expect(coerceToolArgs(truncated)).toMatchObject({ text: '{}', kind: 'unrecoverable' })
  })

  it('refuses a wrong-kind closer and anything needing more than 4', () => {
    // A balanced object followed by a stray closer is the existing trailing-junk repair, not autoclose.
    expect(coerceToolArgs('{"a": 1}}')).toEqual({ text: '{"a": 1}', kind: 'repaired' })
    expect(coerceToolArgs('{"a": [1, 2}')).toMatchObject({ kind: 'unrecoverable' })
    expect(coerceToolArgs('{"a": [1, 2}').issue).toMatch(/a "}" at position 11 arrives while an array is still open/)
    expect(coerceToolArgs('{"a": [[[[[1]').kind).toBe('unrecoverable')
    expect(coerceToolArgs('{"a": [[[1]').text).toBe('{"a": [[[1]]]}')
  })

  it('ignores braces inside strings when counting', () => {
    expect(coerceToolArgs('{"cmd": "echo {", "n": [1]').text).toBe('{"cmd": "echo {", "n": [1]}')
  })

  it('reports kind and issue for every path', () => {
    expect(coerceToolArgs('{"a":1}')).toEqual({ text: '{"a":1}', kind: 'valid' })
    expect(coerceToolArgs('"{"a":1}"')).toEqual({ text: '{"a":1}', kind: 'repaired' })
    expect(coerceToolArgs('{"a":1} junk')).toEqual({ text: '{"a":1}', kind: 'repaired' })
    expect(coerceToolArgs('')).toMatchObject({ text: '{}', kind: 'unrecoverable', issue: 'no arguments were sent' })
    expect(coerceToolArgs('[1]')).toMatchObject({ text: '{}', kind: 'unrecoverable', issue: 'top-level value is an array, not an object' })
  })

  it('sanitizeToolArgs stays the wire view of coerceToolArgs', () => {
    expect(sanitizeToolArgs(REAL_A)).toBe('{}')
    expect(sanitizeToolArgs('{"a": {"b": 1}')).toBe('{"a": {"b": 1}}')
  })
})
