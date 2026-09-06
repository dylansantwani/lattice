import type { ActivityToolCall, SessionActivitySummary, SessionStatus } from '@shared/types'

/**
 * Pure presentation logic for the cross-session activity view: how sessions are ordered, what each
 * status looks like, and how a tool call and a timestamp read. Framework-free so it has a real test
 * surface — the panel itself is then only markup and fetching.
 */

/** Icon + tone per status. Tone drives the CSS class; the icon is a Material Symbols name. */
export const STATUS_LOOK: Record<SessionStatus, { icon: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; label: string }> = {
  running: { icon: 'play_circle', tone: 'ok', label: 'Running' },
  'waiting-approval': { icon: 'front_hand', tone: 'warn', label: 'Needs approval' },
  'waiting-answer': { icon: 'help', tone: 'warn', label: 'Needs an answer' },
  error: { icon: 'error', tone: 'bad', label: 'Failed' },
  idle: { icon: 'pause_circle', tone: 'idle', label: 'Idle' },
  private: { icon: 'lock', tone: 'idle', label: 'Private' }
}

/**
 * How urgently a session wants the reader's attention. A session parked on an approval nobody has
 * answered is doing nothing at all until someone looks at it, so it leads the list — ahead of the
 * ones that are happily working.
 */
export function statusRank(status: SessionStatus): number {
  switch (status) {
    case 'waiting-approval':
      return 0
    case 'waiting-answer':
      return 1
    case 'running':
      return 2
    case 'error':
      return 3
    default:
      return 4
  }
}

/** Sessions in reading order: whoever needs you first, then whoever is busy, then by recency. */
export function sortSessions(sessions: SessionActivitySummary[]): SessionActivitySummary[] {
  return [...sessions].sort(
    (a, b) => statusRank(a.status) - statusRank(b.status) || b.updatedAt - a.updatedAt || a.title.localeCompare(b.title)
  )
}

/** How many sessions are parked on the user right now — the panel's header badge. */
export function needsYouCount(sessions: SessionActivitySummary[]): number {
  return sessions.filter((s) => s.status === 'waiting-approval' || s.status === 'waiting-answer').length
}

/** "just now" / "4m ago" / "3h ago" / "2d ago". */
export function relTime(ts: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

/** "1.2s" / "340ms" for a finished tool call; empty while it is still running. */
export function toolDuration(call: ActivityToolCall): string {
  if (call.durationMs == null) return ''
  return call.durationMs < 1000 ? `${call.durationMs}ms` : `${(call.durationMs / 1000).toFixed(1)}s`
}

/** The badges under a session's title: background work and waiting messages. */
export function sessionBadges(s: SessionActivitySummary): string[] {
  const out: string[] = []
  if (s.agents) out.push(`${s.agents} subagent${s.agents === 1 ? '' : 's'}`)
  if (s.jobs) out.push(`${s.jobs} job${s.jobs === 1 ? '' : 's'}`)
  if (s.unread) out.push(`${s.unread} unread`)
  if (s.isPrivate) out.push('private')
  return out
}
