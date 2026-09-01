import type { AutoGroupBy, Mode, ThreadMeta } from '@shared/types'

/**
 * Accent palette for user-defined groups. Each entry is a CSS color token defined in the theme;
 * the sidebar renders a group's dot/accent from `--group-<key>` (falling back to violet).
 */
export const GROUP_COLORS = ['violet', 'blue', 'green', 'amber', 'red', 'pink', 'teal', 'slate'] as const
export type GroupColor = (typeof GROUP_COLORS)[number]

export interface AutoBucket {
  /** stable key for React + collapse persistence */
  key: string
  label: string
  threads: ThreadMeta[]
}

const DAY = 86_400_000

const MODE_LABEL: Record<Mode, string> = { plan: 'Plan', act: 'Act', review: 'Review' }

/** Start-of-day (local) for a timestamp, so "today"/"yesterday" respect calendar days, not 24h windows. */
function startOfDay(ts: number): number {
  const d = new Date(ts)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/**
 * Derive the sidebar's automatic buckets for a set of threads. Pure and deterministic given
 * `now` (injected so it can be tested). Threads keep their incoming order within a bucket, so
 * callers should pass an already-sorted list (pinned first, then most-recent). Empty buckets
 * are omitted; the returned buckets are in display order.
 */
export function autoBucket(threads: ThreadMeta[], by: AutoGroupBy, now: number): AutoBucket[] {
  if (by === 'mode') return byKey(threads, (t) => t.mode, MODE_LABEL, ['plan', 'act', 'review'])
  if (by === 'model') return byKey(threads, (t) => t.model, (m) => modelLabel(m))
  return byDate(threads, now)
}

/** Human-friendly model label: drop a leading provider prefix ("cc/claude-fable-5" → "claude-fable-5"). */
export function modelLabel(model: string): string {
  const slash = model.indexOf('/')
  return slash >= 0 ? model.slice(slash + 1) : model
}

function byDate(threads: ThreadMeta[], now: number): AutoBucket[] {
  const today = startOfDay(now)
  const defs: { key: string; label: string; min: number }[] = [
    { key: 'today', label: 'Today', min: today },
    { key: 'yesterday', label: 'Yesterday', min: today - DAY },
    { key: 'week', label: 'Previous 7 days', min: today - 7 * DAY },
    { key: 'month', label: 'Previous 30 days', min: today - 30 * DAY },
    { key: 'older', label: 'Older', min: -Infinity }
  ]
  const buckets = new Map<string, AutoBucket>()
  for (const d of defs) buckets.set(d.key, { key: d.key, label: d.label, threads: [] })
  for (const t of threads) {
    const def = defs.find((d) => t.updatedAt >= d.min)! // last def has -Infinity, always matches
    buckets.get(def.key)!.threads.push(t)
  }
  return defs.map((d) => buckets.get(d.key)!).filter((b) => b.threads.length > 0)
}

/**
 * Generic bucketing by a derived key. When `order` is given, buckets appear in that fixed order;
 * otherwise buckets are ordered by first appearance (which, for a recency-sorted input, means
 * the most recently used key leads). `label` maps a key to its display string.
 */
function byKey(
  threads: ThreadMeta[],
  keyOf: (t: ThreadMeta) => string,
  label: Record<string, string> | ((key: string) => string),
  order?: string[]
): AutoBucket[] {
  const labelOf = (k: string): string => (typeof label === 'function' ? label(k) : label[k] ?? k)
  const buckets = new Map<string, AutoBucket>()
  const seen: string[] = []
  for (const t of threads) {
    const k = keyOf(t)
    if (!buckets.has(k)) {
      buckets.set(k, { key: k, label: labelOf(k), threads: [] })
      seen.push(k)
    }
    buckets.get(k)!.threads.push(t)
  }
  const keys = order ? [...order.filter((k) => buckets.has(k)), ...seen.filter((k) => !order.includes(k))] : seen
  return keys.map((k) => buckets.get(k)!)
}
