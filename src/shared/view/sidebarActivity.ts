import type { ThreadMeta } from '../types'

export type ActivityState = 'waiting' | 'running' | 'failed'

export interface ActivityEntry {
  threadId: string
  title: string
  state: ActivityState
}

/**
 * The threads with something going on, for the sidebar's activity strip — a single place to see
 * and stop every live run without scrolling the list. Waiting (an approval or question parked on
 * the user) leads, since the model there is stuck; then running; then failed-while-away. The
 * active thread is included: the strip is a status board, not an inbox.
 */
export function activeThreads(
  threads: ThreadMeta[],
  waiting: Set<string>,
  failed: Set<string>
): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const t of threads) {
    if (t.archived) continue
    const state: ActivityState | null = waiting.has(t.id)
      ? 'waiting'
      : t.running
        ? 'running'
        : failed.has(t.id)
          ? 'failed'
          : null
    if (state) out.push({ threadId: t.id, title: t.title, state })
  }
  const rank: Record<ActivityState, number> = { waiting: 0, running: 1, failed: 2 }
  return out.sort((a, b) => rank[a.state] - rank[b.state])
}

/** "2 running · 1 waiting" — the strip's headline. */
export function describeActivity(entries: ActivityEntry[]): string {
  const n = (state: ActivityState): number => entries.filter((e) => e.state === state).length
  const parts: string[] = []
  if (n('waiting')) parts.push(`${n('waiting')} waiting on you`)
  if (n('running')) parts.push(`${n('running')} running`)
  if (n('failed')) parts.push(`${n('failed')} failed`)
  return parts.join(' · ')
}
