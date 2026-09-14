import type { StatsGroup } from '@shared/statsSnapshot'
import { baseStem } from './effort'

/**
 * What you have actually done with a model, folded from the app-wide usage snapshot for the model
 * browser's detail pane and row sub-lines. The snapshot groups by the exact route id a turn ran on;
 * effort variants (`…-high`, `…:low`) are separate ids there but one selectable row in the picker,
 * so everything is re-keyed onto the base stem. Pure and framework-free.
 */
export interface ModelStats {
  /** main-run turns on this model (all effort variants) */
  requests: number
  /** turns that errored or were interrupted */
  failed: number
  /** every token touched: fresh in + cached in + output + reasoning */
  totalTokens: number
  outputTokens: number
  costUsd: number
  /** true when any part of the spend is a list-price estimate rather than a billed figure */
  costEstimated: boolean
  /** wall-time-weighted output tokens per second, 0 when nothing timed */
  tps: number
  /** mean request → first-token latency in ms, null when no turn reported one */
  avgTtftMs: number | null
  /** prompt-cache hit share 0–100, null with no input tokens */
  cacheHitPct: number | null
  /** ms since epoch of the most recent turn */
  lastAt: number
}

function empty(): ModelStats {
  return {
    requests: 0,
    failed: 0,
    totalTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    costEstimated: false,
    tps: 0,
    avgTtftMs: null,
    cacheHitPct: null,
    lastAt: 0
  }
}

/** Fold the snapshot's per-route groups onto base-stem keys. */
export function foldModelStats(groups: readonly StatsGroup[]): Map<string, ModelStats> {
  const acc = new Map<string, { s: ModelStats; wallMs: number; ttftMs: number; input: number; cached: number }>()
  for (const g of groups) {
    if (!g.key || g.key === 'unknown') continue
    const key = baseStem(g.key)
    let a = acc.get(key)
    if (!a) {
      a = { s: empty(), wallMs: 0, ttftMs: 0, input: 0, cached: 0 }
      acc.set(key, a)
    }
    a.s.requests += g.requests
    a.s.failed += g.failed
    a.s.totalTokens += g.totalTokens
    a.s.outputTokens += g.outputTokens
    a.s.costUsd += g.costUsd
    a.s.costEstimated = a.s.costEstimated || g.costEstimated
    a.s.lastAt = Math.max(a.s.lastAt, g.lastAt)
    a.wallMs += g.wallMs
    a.ttftMs += g.ttftMs
    a.input += g.freshInputTokens + g.cachedInputTokens
    a.cached += g.cachedInputTokens
  }
  const out = new Map<string, ModelStats>()
  for (const [key, a] of acc) {
    a.s.tps = a.wallMs > 0 ? Math.round((a.s.outputTokens / a.wallMs) * 1000) : 0
    a.s.avgTtftMs = a.ttftMs > 0 && a.s.requests > 0 ? Math.round(a.ttftMs / a.s.requests) : null
    a.s.cacheHitPct = a.input > 0 ? Math.round((a.cached / a.input) * 100) : null
    out.set(key, a.s)
  }
  return out
}

/** The stats for a model id, resolving through its base stem; undefined when never used. */
export function statsFor(stats: ReadonlyMap<string, ModelStats> | undefined, modelId: string): ModelStats | undefined {
  return stats?.get(baseStem(modelId))
}

/** Compact USD: "$0.004", "$0.42", "$12", "$1.2k". */
export function fmtUsd(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(3)}`
  if (n < 1) return `$${n.toFixed(2)}`
  if (n < 100) return `$${n.toFixed(n < 10 ? 2 : 1)}`
  if (n < 10_000) return `$${Math.round(n)}`
  return `$${(n / 1000).toFixed(1)}k`
}

/** Coarse relative time for a timestamp: "just now", "3h ago", "yesterday", "12 days ago", "Aug 4". */
export function fmtWhen(ts: number, now = Date.now()): string {
  if (!ts) return 'never'
  const s = Math.max(0, Math.round((now - ts) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.round(h / 24)
  if (d === 1) return 'yesterday'
  if (d < 30) return `${d} days ago`
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}
