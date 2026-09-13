import type { ChatMessage, MessageId, WireExchange } from '@shared/types'

export interface CompactionInput {
  transcript: string
  liveMessages: ChatMessage[]
  checkpoint: string
  beforeChars: number
}

export interface CompactionAcceptance {
  accepted: boolean
  reason?: string
}

/** Live messages include assistant turns whose visible text is empty but whose tool wire is not. */
export function selectLiveMessages(messages: ChatMessage[], preserveMessageId?: MessageId): ChatMessage[] {
  return messages.filter(
    (message) => !message.compacted && message.id !== preserveMessageId &&
      (message.text.trim().length > 0 || (message.toolExchanges?.length ?? 0) > 0)
  )
}

function exchangeText(exchange: WireExchange): string {
  if (typeof exchange.content === 'string') return exchange.content
  if (!Array.isArray(exchange.content)) return ''
  return exchange.content.map((part) => part.type === 'text' ? part.text ?? '' : '[image omitted]').join(' ')
}

function bounded(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 24))}\n… [truncated]`
}

function toolEvidence(message: ChatMessage, maxChars: number): string[] {
  const exchanges = message.toolExchanges ?? []
  return exchanges.flatMap((exchange) => {
    if (exchange.role !== 'tool' || !exchange.tool_call_id) return []
    const name = exchange.name ? ` tool=${exchange.name}` : ''
    return [`[tool-result callId=${exchange.tool_call_id}${name}] ${bounded(exchangeText(exchange), maxChars)}`]
  })
}

function checkpointFor(messages: ChatMessage[], maxChars: number): string {
  const constraints = messages.filter((m) => m.role === 'user').map((m) => m.text.trim()).filter(Boolean)
  const checklist: string[] = []
  const artifacts = new Set<string>()
  const calls = new Set<string>()
  const pathPattern = /(?:^|\s)((?:\/|\.\.?\/)[^\s`'"),;]+|[\w.-]+\/[\w./-]+\.[A-Za-z0-9]+)/g
  for (const message of messages) {
    for (const line of message.text.split(/\r?\n/)) {
      if (/\[\s*\]|\b(?:todo|fixme|pending|remaining|blocked|unresolved)\b/i.test(line)) checklist.push(line.trim())
      for (const match of line.matchAll(pathPattern)) artifacts.add(match[1]!)
    }
    for (const exchange of message.toolExchanges ?? []) if (exchange.tool_call_id) calls.add(exchange.tool_call_id)
  }
  const section = (title: string, values: string[]) => `${title}:\n${values.length ? values.map((v) => `- ${v}`).join('\n') : '- (none)'}`
  return bounded([
    'CHECKPOINT (deterministic; preserve these facts while summarizing)',
    section('USER CONSTRAINTS', constraints),
    section('OPEN CHECKLIST', [...new Set(checklist)]),
    section('ARTIFACTS', [...artifacts].sort()),
    section('TOOL EVIDENCE REFERENCES', [...calls].sort().map((id) => `callId=${id}`))
  ].join('\n'), maxChars)
}

/** Build a bounded, evidence-preserving prompt for a compaction summarizer. */
export function buildCompactionInput(
  messages: ChatMessage[],
  opts: { preserveMessageId?: MessageId; maxChars?: number } = {}
): CompactionInput {
  const liveMessages = selectLiveMessages(messages, opts.preserveMessageId)
  const maxChars = Math.max(512, opts.maxChars ?? 120_000)
  const entries = liveMessages.map((message) => {
    const who = message.role === 'user' ? 'User' : message.role === 'assistant' ? 'Assistant' : 'Summary'
    const text = message.text.trim() ? `${who}: ${message.text.trim()}` : `${who}: (tool-only turn)`
    return [text, ...toolEvidence(message, Math.min(8_000, maxChars))].join('\n')
  })
  const checkpoint = checkpointFor(liveMessages, Math.min(24_000, maxChars))
  const transcript = bounded([...entries, checkpoint].join('\n\n'), maxChars)
  return { transcript, liveMessages, checkpoint, beforeChars: entries.join('\n\n').length }
}

/** Reject empty summaries and summaries that fail to reduce the input meaningfully. */
export function acceptCompactionSummary(input: {
  summary: string
  beforeChars: number
  minReduction?: number
}): CompactionAcceptance {
  const summary = input.summary.trim()
  if (!summary) return { accepted: false, reason: 'summary is empty' }
  const reduction = input.beforeChars <= 0 ? 0 : 1 - summary.length / input.beforeChars
  if (input.beforeChars > 0 && reduction < (input.minReduction ?? 0.05)) {
    return { accepted: false, reason: 'summary does not reduce context' }
  }
  return { accepted: true }
}
