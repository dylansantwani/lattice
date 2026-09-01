import { createParser, type EventSourceMessage } from 'eventsource-parser'
import type { ProviderConfig, ReasoningFidelity, TurnTelemetry } from '@shared/types'

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[] | null
  tool_calls?: WireToolCall[]
  tool_call_id?: string
  name?: string
}

export interface WireContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

export interface StreamRequest {
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  maxTokens?: number
  temperature?: number
  effort?: string
  /** inject Anthropic-style cache_control breakpoints on the stable prefix */
  cache?: boolean
  signal: AbortSignal
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; fidelity: ReasoningFidelity }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: Partial<TurnTelemetry> }
  | { type: 'finish'; reason: string }

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    public body: string
  ) {
    super(`provider HTTP ${status}: ${body.slice(0, 400)}`)
  }
}

type CacheControl = { type: 'ephemeral' }

/** Whether a message can carry a cache_control marker: it has text content to attach it to. */
function stampable(msg: WireMessage): boolean {
  if (typeof msg.content === 'string') return msg.content.length > 0
  if (Array.isArray(msg.content)) return msg.content.some((p) => p.type === 'text' || p.type === 'image_url')
  return false
}

/**
 * Add Anthropic-style `cache_control` breakpoints so the gateway reuses the prompt prefix.
 * Providers that don't support caching ignore the extra field.
 *
 * Two rules, both load-bearing (verified live against the OmniRoute gateway):
 *
 * 1. EVERY message with content is normalized to parts form (`[{type:'text',text}]`), stamped or
 *    not. Stamping converts a message to parts form; if unstamped messages stayed plain strings,
 *    a message would FLAP between the two serializations as the moving tail markers passed over
 *    it turn-to-turn — and gateways hash the serialized bytes, so the flap breaks the prefix
 *    match at that position and zeroes the hit rate. Byte-stable form across requests is what
 *    turned a measured 0% turn-over-turn hit rate into 98% on the Claude routes.
 *
 * 2. Marker placement (max 3, under Anthropic's limit of 4):
 *    - the system block — the long stable prefix shared by every request in the thread;
 *    - the LAST stampable message, whatever its role — including tool results, so each agentic
 *      round caches the accumulated transcript instead of re-processing the whole tool tail;
 *    - the second-to-last stampable message, as an anchor when a round appends more blocks than
 *      the provider's automatic prefix-lookback (~20) covers, e.g. a large parallel tool batch.
 */
export function withCacheBreakpoints(messages: WireMessage[]): WireMessage[] {
  const toParts = (msg: WireMessage, stamp: boolean): WireMessage => {
    const parts: (WireContentPart & { cache_control?: CacheControl })[] =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map((p) => ({ ...p }))
          : []
    if (parts.length === 0) return msg
    if (stamp) parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: { type: 'ephemeral' } }
    return { ...msg, content: parts as WireContentPart[] }
  }
  const systemIndex = messages.findIndex((m) => m.role === 'system')
  const stampIndices = new Set<number>()
  for (let i = messages.length - 1; i >= 0 && stampIndices.size < 2; i--) {
    if (i === systemIndex) break
    if (stampable(messages[i]!)) stampIndices.add(i)
  }
  if (systemIndex >= 0 && stampable(messages[systemIndex]!)) stampIndices.add(systemIndex)
  return messages.map((m, i) => toParts(m, stampIndices.has(i)))
}

/** The `usage` object shape we read from an OpenAI-compatible stream (with cache extensions). */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  reasoning_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cost?: number
}

/**
 * Map a provider `usage` object to canonical turn telemetry.
 *
 * Cache-token accounting is deliberately careful because backends disagree on how
 * `prompt_tokens` relates to cache activity:
 *   - Anthropic-style: `prompt_tokens` EXCLUDES freshly-written cache tokens
 *     (`cache_creation_input_tokens`) but INCLUDES cache reads. A cold turn reports a tiny
 *     `prompt_tokens` (e.g. 12) alongside a large `cache_creation_input_tokens` (e.g. 3146).
 *   - OpenAI-style: cached tokens are folded into `prompt_tokens` and no write count is
 *     reported; `prompt_tokens_details.cached_tokens` carries the read count.
 * Adding the write count back onto `prompt_tokens` yields the true total input processed in
 * both cases, so `tokensIn` (context budget, cost, and the cache-hit denominator) stays honest
 * even on the cache-write turn. `cacheReadTokens`/`cacheWriteTokens` stay `undefined` (not 0)
 * when the backend omits them, so the UI can tell "no cache activity" from "zero reads".
 */
export function mapUsage(u: RawUsage): Partial<TurnTelemetry> {
  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens
  const cacheWriteTokens = u.cache_creation_input_tokens
  const tokensIn =
    typeof u.prompt_tokens === 'number' ? u.prompt_tokens + (cacheWriteTokens ?? 0) : undefined
  return {
    tokensIn,
    tokensOut: u.completion_tokens,
    tokensReasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: u.cost
  }
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint (OmniRoute).
 * Yields canonical chunks; caller assembles messages/tool calls.
 */
export async function* streamChat(
  provider: ProviderConfig,
  req: StreamRequest
): AsyncGenerator<StreamChunk> {
  const body: Record<string, unknown> = {
    model: req.model,
    messages: req.cache ? withCacheBreakpoints(req.messages) : req.messages,
    stream: true,
    stream_options: { include_usage: true }
  }
  if (req.tools?.length) body.tools = req.tools
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.effort && req.effort !== 'none' && req.effort !== 'off') body.reasoning_effort = req.effort

  const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${provider.apiKey}`,
      ...provider.headers
    },
    body: JSON.stringify(body),
    signal: req.signal
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new ProviderHttpError(res.status, text)
  }

  const queue: StreamChunk[] = []
  let done = false
  let latestUsage: Partial<TurnTelemetry> | null = null

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') {
        done = true
        return
      }
      let json: any
      try {
        json = JSON.parse(event.data)
      } catch {
        return
      }
      if (json.usage) {
        // Latest-wins, emitted once at stream end: some gateways report a cumulative running
        // total on EVERY chunk when include_usage is set — queueing each one would let the
        // caller sum them and inflate token counts by the number of usage events.
        latestUsage = mapUsage(json.usage)
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      // Reasoning arrives in three shapes across backends: `reasoning_content` (DeepSeek-style),
      // `reasoning` (OpenRouter-style), or ONLY inside `reasoning_details` entries with the
      // plain fields null (observed live on openrouter/meta routes — dropping these made the
      // model look frozen through its whole reasoning phase). Prefer the plain fields; fall
      // back to concatenating detail texts/summaries only when both are absent, so content
      // duplicated across shapes is never double-counted.
      let reasoningText = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoningText !== 'string' || reasoningText.length === 0) {
        if (Array.isArray(delta.reasoning_details)) {
          reasoningText = delta.reasoning_details
            .map((d: { text?: unknown; summary?: unknown }) =>
              typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''
            )
            .join('')
        }
      }
      if (typeof reasoningText === 'string' && reasoningText.length > 0) {
        queue.push({ type: 'reasoning', text: reasoningText, fidelity: 'raw' })
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        queue.push({ type: 'text', text: delta.content })
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          queue.push({
            type: 'tool_call_delta',
            index: tc.index ?? 0,
            id: tc.id ?? undefined,
            name: tc.function?.name ?? undefined,
            argsDelta: tc.function?.arguments ?? undefined
          })
        }
      }
      if (choice.finish_reason) {
        queue.push({ type: 'finish', reason: choice.finish_reason })
      }
    }
  })

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  try {
    while (!done) {
      const { value, done: rdone } = await reader.read()
      if (rdone) break
      parser.feed(decoder.decode(value, { stream: true }))
      while (queue.length) yield queue.shift()!
    }
    // Flush the decoder's buffered tail (a body can end mid-codepoint) before the final drain.
    parser.feed(decoder.decode())
    while (queue.length) yield queue.shift()!
    if (latestUsage) yield { type: 'usage', usage: latestUsage }
  } finally {
    // Cancel before releasing: a consumer that breaks out early (title/compaction helpers cap
    // output mid-stream) must tear the HTTP stream down, not leave it draining until GC.
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
