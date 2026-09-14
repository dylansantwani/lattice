/**
 * Task-scoped context for fleet workers.
 *
 * A worker on a rolling policy used to carry every earlier job into each new one. On the 2026-09-14
 * 3D Print Desk run that did two kinds of damage: tokens (each new task re-sent the history of all
 * the previous ones) and correctness (Photo Puller copied invented measurements from an earlier,
 * already-voided report of its own into a new one). A worker whose policy sets `freshPerTask`
 * therefore starts every newly delegated task clean: when a task arrives while it is idle, the live
 * history is set aside behind a short, fixed marker. Nothing is summarized — a summary would carry the
 * old job's claims forward, which is exactly the contamination this prevents. Standing knowledge
 * lives where it belongs: the agent's role (system prompt), its working memory (shown every run),
 * and long-term memory (memory_search), which the folded span is still distilled into.
 *
 * A task that arrives while the worker is busy is a follow-up to the current work (a steer), so it
 * never triggers a boundary; nor does a peer message (send_message) — only a delegation does.
 */
import type { ChatMessage } from '@shared/types'

export interface TaskBoundaryPlan {
  /** Live messages to set aside (mark compacted). */
  fold: ChatMessage[]
  /** The marker that stands in for them. */
  marker: string
}

/**
 * The fixed text left in place of earlier tasks. Deliberately content-free (only a count and a date
 * span), so no claim from an earlier task leaks into the next one.
 */
export function taskBoundaryMarker(fold: ChatMessage[], timeZone?: string): string {
  const turns = fold.filter((message) => message.role === 'user' && !message.queued).length
  const day = (at: number): string => {
    try {
      return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', ...(timeZone ? { timeZone } : {}) }).format(new Date(at))
    } catch {
      return new Date(at).toISOString()
    }
  }
  const first = fold.find((message) => message.role !== 'system') ?? fold[0]
  const last = fold[fold.length - 1]
  const span = first && last ? ` (${day(first.createdAt)} – ${day(last.createdAt)})` : ''
  return (
    `Your earlier tasks in this thread${span}, ${turns} message${turns === 1 ? '' : 's'}, were set aside so this task ` +
    'starts with a clean context. Work from the new task below, your role, and your working memory. ' +
    'Do not assume details from earlier tasks: if the new task refers to earlier work, look it up with ' +
    'memory_search, or ask the orchestrator with send_message.'
  )
}

/**
 * What to set aside before a new task: every live message, including any previous rolling summary or
 * boundary marker (there is only ever one marker). Null when there is nothing worth folding — an empty
 * thread, or one holding only an earlier marker. Anything still queued stays (it is yet to run).
 */
export function planTaskBoundary(live: ChatMessage[], timeZone?: string): TaskBoundaryPlan | null {
  const firstQueued = live.findIndex((message) => message.queued && !message.compacted)
  const candidates = (firstQueued >= 0 ? live.slice(0, firstQueued) : live).filter((message) => !message.compacted)
  if (!candidates.some((message) => message.role === 'user' || message.role === 'assistant')) return null
  return { fold: candidates, marker: taskBoundaryMarker(candidates, timeZone) }
}

/** Plain-text transcript of a set-aside span for memory distillation (tool results clipped hard). */
export function taskTranscript(fold: ChatMessage[]): string {
  const lines: string[] = []
  for (const message of fold) {
    if (message.role === 'system') continue
    const text = message.text.trim()
    if (text) lines.push(`${message.role === 'user' ? 'Task/message' : 'Agent'}: ${text.length > 3_000 ? `${text.slice(0, 3_000)} …` : text}`)
  }
  const joined = lines.join('\n\n')
  return joined.length > 60_000 ? joined.slice(joined.length - 60_000) : joined
}
