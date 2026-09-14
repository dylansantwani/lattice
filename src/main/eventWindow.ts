/**
 * Tail-window helpers for reading a thread's event log.
 *
 * Kept free of electron/DB imports so they can be tested directly: this is the logic that decides
 * how much of a thread a reader actually pays for, and getting it wrong means either a truncated
 * timeline or a 66 MB response.
 */

/**
 * A tail-window size from a caller, or undefined for "no window". Unusable shapes (NaN, zero,
 * negatives, non-numbers) mean no window rather than an empty transcript, and absurd ones are
 * clamped: a window larger than the log is just the full log with extra steps.
 */
export function windowLimit(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.floor(value)
  if (n < 1) return undefined
  return Math.min(n, 20_000)
}

/**
 * Trim an event log to about `limit` events from its tail, without cutting a run in half.
 *
 * `events` is the thread's log in time order. The tail is taken by count, then extended back to the
 * first event of the oldest run it touched, so the client never receives half a run — a half-run
 * weaves into a nonsense timeline — and the newest run, which a live reader is watching and which
 * can be longer than the whole window on its own, is always returned whole.
 */
export function windowEvents<T extends { runId: string }>(events: T[], limit: number): T[] {
  if (events.length <= limit) return events
  const runsInTail = new Set(events.slice(events.length - limit).map((e) => e.runId))
  const firstKept = events.findIndex((e) => runsInTail.has(e.runId))
  return firstKept <= 0 ? events : events.slice(firstKept)
}
