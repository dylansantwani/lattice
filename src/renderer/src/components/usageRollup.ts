import type { CostRates, ModelInfo, UsageRow } from '@shared/types'
import { computeCost, resolveCostRates } from '@shared/cost'
import { modelLabel } from './usageStats'

export type UsageRange = '1d' | '7d' | '30d' | 'all'
export const USAGE_RANGES: { key: UsageRange; label: string }[] = [
  { key: '1d', label: 'Today' },
  { key: '7d', label: '7 days' },
  { key: '30d', label: '30 days' },
  { key: 'all', label: 'All time' }
]

export interface UsageTotals {
  requests: number
  freshInputTokens: number
  cachedInputTokens: number
  outputTokens: number
  reasoningTokens: number
  costUsd: number
  /** true once any part of costUsd came from a local *list-price* estimate (drives estimate labels) */
  costEstimated: boolean
  /** true once any part of costUsd was computed locally (list price OR a user override) — i.e. the
   * cost is user-adjustable via an override. An override makes cost exact yet still locally computed. */
  costLocal: boolean
  /** summed wall-clock time across turns, ms — the denominator behind the weighted tok/s below */
  wallMs: number
  /** output tokens / elapsed seconds, weighted by wall time (not an average of per-turn rates,
   * which would over-weight short answers) */
  tps: number
}

export interface UsageGroup extends UsageTotals {
  key: string
  label: string
}

export interface UsageDayBucket extends UsageTotals {
  /** local-time YYYY-MM-DD */
  date: string
}

export interface UsagePageData {
  totals: UsageTotals
  cacheHitRate: number | null
  byModel: UsageGroup[]
  byProvider: UsageGroup[]
  byThread: UsageGroup[]
  byDay: UsageDayBucket[]
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    freshInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
    costEstimated: false,
    costLocal: false,
    wallMs: 0,
    tps: 0
  }
}

/** Local (not UTC) calendar day the timestamp falls on, so "Today" matches the user's clock. */
function localDateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

export function filterByRange(rows: UsageRow[], range: UsageRange, now = Date.now()): UsageRow[] {
  if (range === 'all') return rows
  const days = range === '1d' ? 1 : range === '7d' ? 7 : 30
  const cutoff = now - days * 24 * 60 * 60 * 1000
  return rows.filter((r) => r.createdAt >= cutoff)
}

function addRow(
  totals: UsageTotals,
  row: UsageRow,
  models: ModelInfo[],
  overrides: Record<string, CostRates>
): void {
  const t = row.telemetry
  const cached = (t.cacheReadTokens ?? 0) + (t.cacheWriteTokens ?? 0)
  const reasoning = t.tokensReasoning ?? 0
  const fresh = Math.max(0, (t.tokensIn ?? 0) - cached)
  const output = Math.max(0, (t.tokensOut ?? 0) - reasoning)
  totals.requests += 1
  totals.cachedInputTokens += cached
  totals.freshInputTokens += fresh
  totals.reasoningTokens += reasoning
  totals.outputTokens += output
  totals.wallMs += t.wallMs ?? 0
  if (t.costUsd !== undefined) {
    totals.costUsd += t.costUsd
  } else {
    // Same fallback as the per-thread Run tab and ModelSwitchWarning: a local cost model — the
    // user's override if set (exact), else the model's list price (estimated) — for routes that
    // don't report actual billed cost (common on local/self-hosted routes).
    const resolved = resolveCostRates(row.model, models, overrides)
    if (resolved) {
      totals.costUsd += computeCost(resolved.rates, { freshInput: fresh, cachedInput: cached, output, reasoning })
      totals.costLocal = true
      if (resolved.estimated) totals.costEstimated = true
    }
  }
}

function finalizeTps(totals: UsageTotals): void {
  totals.tps = totals.wallMs > 0 ? Math.round((totals.outputTokens / totals.wallMs) * 1000) : 0
}

function groupInto(
  map: Map<string, UsageGroup>,
  key: string,
  label: string,
  row: UsageRow,
  models: ModelInfo[],
  overrides: Record<string, CostRates>
): void {
  let g = map.get(key)
  if (!g) {
    g = { key, label, ...emptyTotals() }
    map.set(key, g)
  }
  addRow(g, row, models, overrides)
}

/**
 * Rolls per-turn telemetry rows (already filtered to the desired time range) up into the
 * session/lifetime aggregates the Usage page shows: a headline total, and breakdowns by model,
 * provider, and thread, plus a daily time series for the requests-over-time chart.
 */
export function buildUsagePageData(
  rows: UsageRow[],
  models: ModelInfo[],
  overrides: Record<string, CostRates> = {}
): UsagePageData {
  const totals = emptyTotals()
  const byModel = new Map<string, UsageGroup>()
  const byProvider = new Map<string, UsageGroup>()
  const byThread = new Map<string, UsageGroup>()
  const byDay = new Map<string, UsageDayBucket>()

  for (const row of rows) {
    addRow(totals, row, models, overrides)

    const modelId = row.model ?? 'unknown'
    groupInto(byModel, modelId, modelLabel(row.model, models), row, models, overrides)

    const provider = models.find((m) => m.id === row.model)?.provider ?? 'unknown'
    groupInto(byProvider, provider, provider === 'unknown' ? 'Unknown provider' : provider, row, models, overrides)

    groupInto(byThread, row.threadId, row.threadTitle, row, models, overrides)

    const date = localDateKey(row.createdAt)
    let day = byDay.get(date)
    if (!day) {
      day = { date, ...emptyTotals() }
      byDay.set(date, day)
    }
    addRow(day, row, models, overrides)
  }

  finalizeTps(totals)
  for (const g of byModel.values()) finalizeTps(g)
  for (const g of byProvider.values()) finalizeTps(g)
  for (const g of byThread.values()) finalizeTps(g)
  for (const d of byDay.values()) finalizeTps(d)

  const byCostDesc = (a: UsageTotals, b: UsageTotals): number => b.costUsd - a.costUsd

  const totalInput = totals.freshInputTokens + totals.cachedInputTokens
  const cacheHitRate = totalInput > 0 ? totals.cachedInputTokens / totalInput : null

  return {
    totals,
    cacheHitRate,
    byModel: [...byModel.values()].sort(byCostDesc),
    byProvider: [...byProvider.values()].sort(byCostDesc),
    byThread: [...byThread.values()].sort(byCostDesc),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date))
  }
}
