import type { ChatMessage } from '@shared/types'

/**
 * Presentation logic for the transcript's recovery card — the thing you see when a reply was
 * interrupted or failed.
 *
 * The distinction it exists to make: a reply that got a long way in before dying should be
 * **resumed**, not re-run. Restarting throws away everything the model wrote and re-runs every tool
 * call it had already completed. So the card leads with Resume whenever there is anything to
 * continue, says plainly what will be kept, and keeps "Start over" as the deliberate second choice.
 */

/** What the card offers, given how far the dead reply got. */
export interface RecoveryPlan {
  /** true when the reply produced something worth continuing */
  canResume: boolean
  /** headline: what happened */
  title: string
  /** sub-line: what happens if you act */
  detail: string
  /** label for the primary button */
  primaryLabel: string
  primaryIcon: string
}

/**
 * How much of the reply survives — the numbers behind "1,240 characters and 3 tool calls".
 *
 * Tool calls are counted from the message's persisted `toolExchanges` (the `tool`-role results),
 * NOT from the timeline. That is deliberate: `canResumeMessage` in the run manager decides on
 * exactly this evidence, and a timeline row can exist for a call that never completed — a tool the
 * model was still drafting when the reply died leaves a row but nothing to resume from. Counting
 * rows made the card offer "Resume · 1 tool call kept" for a reply the backend would silently
 * restart instead.
 */
export function recoveredWork(msg: ChatMessage): { chars: number; tools: number } {
  const chars = msg.text.trim().length
  const tools = (msg.toolExchanges ?? []).reduce((n, ex) => (ex.role === 'tool' ? n + 1 : n), 0)
  return { chars, tools }
}

/** "1,240 characters and 3 tool calls" / "2 tool calls" / "" — only the parts that are non-zero. */
export function describeRecoveredWork(work: { chars: number; tools: number }): string {
  const parts: string[] = []
  if (work.chars > 0) parts.push(`${work.chars.toLocaleString()} character${work.chars === 1 ? '' : 's'}`)
  if (work.tools > 0) parts.push(`${work.tools} tool call${work.tools === 1 ? '' : 's'}`)
  return parts.join(' and ')
}

/**
 * What the recovery card should say and offer. A reply with work behind it gets Resume as the
 * primary action and an explicit account of what is being kept; one that died before producing
 * anything gets a plain retry, because resuming and restarting would be the same thing.
 */
export function recoveryPlan(msg: ChatMessage): RecoveryPlan {
  const interrupted = msg.status === 'interrupted'
  const work = recoveredWork(msg)
  const kept = describeRecoveredWork(work)
  const canResume = work.chars > 0 || work.tools > 0
  const title = interrupted ? 'This reply was interrupted.' : 'This reply failed.'
  if (!canResume) {
    return {
      canResume: false,
      title,
      detail: 'It stopped before producing anything, so there is nothing to pick up from.',
      primaryLabel: 'Try again',
      primaryIcon: 'replay'
    }
  }
  return {
    canResume: true,
    title: `${title} ${capitalize(kept)} kept.`,
    detail: 'Resume picks up from where it stopped — nothing already written or already run is repeated.',
    primaryLabel: 'Resume',
    primaryIcon: 'resume'
  }
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
