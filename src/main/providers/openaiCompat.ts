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
    messages: req.messages,
    stream: true,
    stream_options: { include_usage: true }
  }
  if (req.tools?.length) body.tools = req.tools
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  if (req.effort && req.effort !== 'none') body.reasoning_effort = req.effort

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
        queue.push({
          type: 'usage',
          usage: {
            tokensIn: json.usage.prompt_tokens,
            tokensOut: json.usage.completion_tokens,
            tokensReasoning:
              json.usage.completion_tokens_details?.reasoning_tokens ??
              json.usage.reasoning_tokens ??
              undefined,
            cacheReadTokens:
              json.usage.prompt_tokens_details?.cached_tokens ??
              json.usage.cache_read_input_tokens ??
              undefined,
            cacheWriteTokens: json.usage.cache_creation_input_tokens ?? undefined,
            costUsd: json.usage.cost ?? undefined
          }
        })
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      const reasoningText = delta.reasoning_content ?? delta.reasoning
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
    while (queue.length) yield queue.shift()!
  } finally {
    reader.releaseLock()
  }
}
