/**
 * Rolling context: one conversation that never has to be restarted.
 *
 * Auto-compaction fires at 92% of the model's window and folds everything into one summary. On a
 * 1M-token model that means a personal assistant thread re-sends hundreds of thousands of tokens per
 * text before anything happens, and then forgets its recent turns all at once. A `rolling` thread
 * instead keeps a sliding window:
 *
 *  - When live history passes `triggerTokens`, the oldest whole turns are folded so about
 *    `keepTokens` of recent conversation stays verbatim.
 *  - The folded turns are merged into the thread's running summary (the previous summary is folded
 *    too, so there is only ever one), which stands in for them at the head of the history.
 *  - In parallel the same span goes through memory distillation, so durable facts (people, plans,
 *    preferences, decisions) land in long-term memory, where per-turn auto-recall finds them again
 *    long after the summary has compressed them away.
 *
 * Rolls run after a turn completes, so the person's next message never waits for one; a thread that
 * somehow got far past its trigger rolls before the turn instead. Folding is one transaction, so a
 * turn building its context concurrently sees either the old history or the new, never a mix.
 */
import type { ChatMessage, ContextPolicy, MessageId } from '@shared/types'

/** Flat estimate per image, matching the context budget's. */
export const ROLL_IMAGE_TOKENS = 1_200
/** A thread this far past its trigger rolls before the turn instead of after it. */
export const ROLL_URGENT_FACTOR = 1.5
/** Per-message ceiling in the transcript the summarizer reads. */
const TRANSCRIPT_MESSAGE_MAX_CHARS = 4_000
/** Per-tool-result ceiling in that transcript: the summary needs what was learned, not raw output. */
const TRANSCRIPT_TOOL_MAX_CHARS = 600
const TRANSCRIPT_MAX_CHARS = 90_000

const approxTokens = (chars: number): number => Math.ceil(chars / 4)

/** Rough token weight of one stored message: its text, replayed tool exchanges, and attachments. */
export function estimateMessageTokens(message: ChatMessage, count: (text: string) => number = (t) => approxTokens(t.length)): number {
  let tokens = message.text ? count(message.text) : 0
  for (const exchange of message.toolExchanges ?? []) {
    if (typeof exchange.content === 'string') tokens += approxTokens(exchange.content.length)
    else if (Array.isArray(exchange.content)) {
      for (const part of exchange.content) tokens += part.type === 'image_url' ? ROLL_IMAGE_TOKENS : approxTokens(part.text?.length ?? 0)
    }
    for (const call of exchange.tool_calls ?? []) tokens += approxTokens(call.function.arguments.length + call.function.name.length)
  }
  for (const attachment of message.attachments ?? []) {
    tokens += attachment.kind === 'image' ? ROLL_IMAGE_TOKENS : approxTokens(attachment.content?.length ?? 0)
  }
  return tokens + 4
}

export interface RollPlan {
  /** Live messages to fold, oldest first, including any earlier running summary. */
  fold: ChatMessage[]
  /** Live messages that stay verbatim. */
  keep: ChatMessage[]
  /** The newest earlier summary inside `fold`, if any. */
  previousSummary?: ChatMessage
  liveTokens: number
  keptTokens: number
}

/**
 * A turn starts at a user-role message (the person's, or a notice) that began a run, as opposed to
 * a mid-run steer. A fresh send is stored with no run id; a queued turn gets the id of the run it
 * started, which differs from whatever came before it; a steer carries the id of the run it joined,
 * the same as that run's assistant message stored just before it.
 */
function isTurnStart(live: ChatMessage[], index: number): boolean {
  const message = live[index]!
  if (message.role !== 'user' || message.queued) return false
  if (!message.runId || index === 0) return true
  return live[index - 1]!.runId !== message.runId
}

export interface PlanRollOptions {
  keepTokens: number
  /** Roll only when live history is past this. Omit (with `force`) for an on-demand roll. */
  triggerTokens?: number
  force?: boolean
  /** Never fold at or after this message (a run in flight). */
  protectFromId?: MessageId
  count?: (text: string) => number
}

/**
 * Decide what to fold, or null when nothing should. The cut always lands on a turn boundary, so a
 * question is never separated from its answer and a run's tool exchanges stay with their reply; it
 * keeps a little more than `keepTokens` rather than split a turn. Pure.
 */
export function planRoll(messages: ChatMessage[], options: PlanRollOptions): RollPlan | null {
  const live = messages.filter((message) => !message.compacted)
  const weights = live.map((message) => estimateMessageTokens(message, options.count))
  const liveTokens = weights.reduce((sum, weight) => sum + weight, 0)
  if (!options.force && (options.triggerTokens === undefined || liveTokens <= options.triggerTokens)) return null

  let limit = live.length
  if (options.protectFromId) {
    const protectedIndex = live.findIndex((message) => message.id === options.protectFromId)
    if (protectedIndex >= 0) limit = protectedIndex
  }
  // A queued turn and everything after it are still to come.
  const firstQueued = live.findIndex((message) => message.queued)
  if (firstQueued >= 0) limit = Math.min(limit, firstQueued)

  // Walk back from the end until the kept tail holds keepTokens.
  let kept = 0
  let target = live.length
  if (options.keepTokens > 0) {
    for (let index = live.length - 1; index >= 0; index -= 1) {
      kept += weights[index]!
      target = index
      if (kept >= options.keepTokens) break
    }
  }
  // Snap back to the turn start at or before the target (keep more, never split a turn).
  let cut = -1
  for (let index = Math.min(target, limit); index >= 0; index -= 1) {
    // The protected or queued boundary is itself a clean place to cut: it is the user message that
    // opens what must stay.
    const atBoundary = index === limit && limit < live.length && live[limit]!.role === 'user'
    if (index === live.length || atBoundary || isTurnStart(live, index)) {
      cut = index
      break
    }
  }
  if (cut <= 0) return null
  const fold = live.slice(0, cut)
  const conversational = fold.filter((message) => message.role === 'user' || message.role === 'assistant')
  if (conversational.length === 0) return null
  if (!options.force && conversational.length < 4) return null
  const keep = live.slice(cut)
  const previousSummary = [...fold].reverse().find((message) => message.role === 'system' && message.text.trim())
  return {
    fold,
    keep,
    ...(previousSummary ? { previousSummary } : {}),
    liveTokens,
    keptTokens: weights.slice(cut).reduce((sum, weight) => sum + weight, 0)
  }
}

function clipped(text: string, max: number): string {
  const clean = text.trim()
  return clean.length <= max ? clean : `${clean.slice(0, max)} …[${clean.length - max} more chars]`
}

function stamp(at: number, timeZone?: string): string {
  try {
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(at))
  } catch {
    return new Date(at).toISOString()
  }
}

/**
 * The folded span as the summarizer reads it: who said what, when, with each tool call reduced to
 * its name and a clipped result. Earlier summaries are excluded (they are passed separately).
 */
export function rollTranscript(fold: ChatMessage[], timeZone?: string): string {
  const entries: string[] = []
  for (const message of fold) {
    if (message.role === 'system') continue
    const when = stamp(message.createdAt, timeZone)
    if (message.role === 'user') {
      const who = message.origin ? `Notice from ${message.origin.kind === 'shell' ? 'a background command' : message.origin.label}` : 'Owner'
      const images = (message.attachments ?? []).filter((attachment) => attachment.kind === 'image').length
      const body = clipped(message.text, TRANSCRIPT_MESSAGE_MAX_CHARS) || '(no text)'
      entries.push(`[${when}] ${who}: ${body}${images ? ` (+${images} image${images === 1 ? '' : 's'})` : ''}`)
      continue
    }
    const tools: string[] = []
    for (const exchange of message.toolExchanges ?? []) {
      if (exchange.role === 'assistant') {
        for (const call of exchange.tool_calls ?? []) tools.push(`${call.function.name}(${clipped(call.function.arguments, 160)})`)
      } else if (exchange.role === 'tool' && typeof exchange.content === 'string') {
        tools.push(`→ ${clipped(exchange.content, TRANSCRIPT_TOOL_MAX_CHARS)}`)
      }
    }
    const lines = [`[${when}] Assistant: ${clipped(message.text, TRANSCRIPT_MESSAGE_MAX_CHARS) || '(worked without replying)'}`]
    if (tools.length) lines.push(`  tools: ${tools.join(' | ')}`)
    entries.push(lines.join('\n'))
  }
  let transcript = entries.join('\n\n')
  // Oversized spans keep their newest turns: that is where open threads live.
  while (transcript.length > TRANSCRIPT_MAX_CHARS && entries.length > 1) {
    entries.shift()
    transcript = entries.join('\n\n')
  }
  return transcript
}

export const ROLLING_SUMMARY_INSTRUCTION = `You keep the running memory of a conversation that never ends: an assistant and its owner, over days and weeks. The oldest turns are about to leave the assistant's context window. Merge them into the existing summary so the assistant can pick up naturally with only the summary plus the recent turns it still has.

Write plain text in short labeled sections (skip a section with nothing in it):
Open threads: tasks in progress, things the assistant promised to do, check or follow up on, questions still waiting on an answer, with their current state and any ids, paths or links needed to continue.
Recent topics: what was discussed, oldest first, a line or two each, with the concrete outcomes (numbers, names, decisions, what was changed where).
About the owner: preferences, corrections and instructions they gave about how to work or talk, and facts about their situation that came up.

Rules: keep facts exact (amounts, dates, names, versions, file paths). Drop small talk, raw tool output, dead ends, and anything later superseded or finished and no longer relevant. Never include passwords, keys or codes. Refer to people by name. Do not address the assistant or the owner; no preamble.`

export function buildRollingSummaryPrompt(previousSummary: string | undefined, transcript: string, targetWords: number): string {
  return [
    `Keep the result under about ${targetWords} words.`,
    '',
    '--- EXISTING SUMMARY ---',
    previousSummary?.trim() || '(none yet)',
    '',
    '--- TURNS LEAVING THE WINDOW ---',
    transcript
  ].join('\n')
}

/** Summary length scales with how much is kept verbatim: a bigger window affords a richer summary. */
export function summaryTargetWords(policy: Pick<ContextPolicy, 'keepTokens'>): number {
  return Math.max(250, Math.min(1_400, Math.round(policy.keepTokens / 12)))
}

/** The prefix a running summary rides under in the wire (see buildWireMessages). */
export const ROLLING_SUMMARY_PREFIX =
  'Summary of the earlier conversation (older turns were rolled out of your context; details also live in long-term memory, use memory_search):\n\n'

/** Extra guidance for memory distillation of an assistant's rolled-off turns. */
export const ROLLING_MEMORY_FOCUS =
  'This conversation is with a personal assistant the user texts about their whole life, not only code. Also save: ' +
  'people in the user\'s life (who they are, relationship, how to reach them, what matters about them), ' +
  'accounts, services, devices and subscriptions the user has and how they are set up, recurring plans and ' +
  'commitments (with ttlDays when they expire), and how the user wants the assistant to talk and act. Still skip ' +
  'one-off lookups and transient numbers (a balance today, a download\'s progress).'

export interface RollDeps {
  /** The thread's live (unfolded) messages, oldest first. */
  liveMessages: () => ChatMessage[]
  /** Fold `ids` into `summary` in one transaction; false when any was folded meanwhile. */
  commitFold: (ids: string[], summary: ChatMessage) => boolean
  /** One model call: the rolling summary instruction and the prompt. */
  summarize: (instruction: string, prompt: string) => Promise<string>
  /** Distill long-term memories from the folded transcript; resolves to how many were stored. */
  distill: (transcript: string) => Promise<number>
  /** Tell readers what changed (the folded originals, now dimmed, and the new summary). */
  publish: (changed: ChatMessage[], stats: { beforeTokens: number; afterTokens: number; summaryId: string }) => void
  newId: () => string
  timeZone?: string
  count?: (text: string) => number
}

export interface RollRequest {
  threadId: string
  policy: Pick<ContextPolicy, 'keepTokens'> & Partial<Pick<ContextPolicy, 'triggerTokens'>>
  force?: boolean
  protectFromId?: MessageId
}

/** Threads with a roll in flight: a second request while one runs is a no-op, not a double fold. */
const rolling = new Set<string>()

export function isRolling(threadId: string): boolean {
  return rolling.has(threadId)
}

/**
 * Fold the thread's oldest turns per `request` (see {@link planRoll}). Memory distillation runs
 * alongside the summary and is best-effort; a failed or useless summary folds nothing. Never throws.
 */
export async function rollContext(request: RollRequest, deps: RollDeps): Promise<import('@shared/types').RollResult> {
  if (rolling.has(request.threadId)) return { ok: false, reason: 'A roll is already in progress.' }
  rolling.add(request.threadId)
  try {
    const plan = planRoll(deps.liveMessages(), {
      keepTokens: request.policy.keepTokens,
      triggerTokens: request.policy.triggerTokens,
      force: request.force,
      protectFromId: request.protectFromId,
      count: deps.count
    })
    if (!plan) return { ok: false, reason: 'Nothing to roll yet.' }
    const transcript = rollTranscript(plan.fold, deps.timeZone)
    const targetWords = summaryTargetWords(request.policy)
    const [summaryOutcome, memoriesOutcome] = await Promise.allSettled([
      deps.summarize(ROLLING_SUMMARY_INSTRUCTION, buildRollingSummaryPrompt(plan.previousSummary?.text, transcript, targetWords)),
      transcript.trim() ? deps.distill(transcript) : Promise.resolve(0)
    ])
    const memories = memoriesOutcome.status === 'fulfilled' ? memoriesOutcome.value : 0
    if (summaryOutcome.status === 'rejected') {
      return { ok: false, reason: `Could not write the summary: ${(summaryOutcome.reason as Error)?.message ?? String(summaryOutcome.reason)}`, memories }
    }
    const summaryText = summaryOutcome.value.trim()
    if (!summaryText) return { ok: false, reason: 'The summary came back empty.', memories }
    const count = deps.count ?? ((text: string) => approxTokens(text.length))
    const foldedTokens = plan.liveTokens - plan.keptTokens
    const summaryTokens = count(summaryText)
    if (summaryTokens >= foldedTokens) return { ok: false, reason: 'The summary was not shorter than what it replaces.', memories }
    // Just ahead of the first kept message, so readers and the wire place it where the folded span was.
    const first = plan.keep[0]
    const createdAt = first ? first.createdAt - 1 : plan.fold[plan.fold.length - 1]!.createdAt + 1
    const summary: ChatMessage = { id: deps.newId(), threadId: request.threadId, role: 'system', createdAt, text: summaryText }
    if (!deps.commitFold(plan.fold.map((message) => message.id), summary)) {
      return { ok: false, reason: 'The history changed while rolling; try again.', memories }
    }
    const afterTokens = plan.keptTokens + summaryTokens
    deps.publish([...plan.fold.map((message) => ({ ...message, compacted: true })), summary], {
      beforeTokens: plan.liveTokens,
      afterTokens,
      summaryId: summary.id
    })
    return { ok: true, folded: plan.fold.length, beforeTokens: plan.liveTokens, afterTokens, memories, summaryMessageId: summary.id }
  } catch (error) {
    return { ok: false, reason: (error as Error).message }
  } finally {
    rolling.delete(request.threadId)
  }
}
