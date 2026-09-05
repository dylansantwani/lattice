/**
 * The single source of truth for Lattice's usage statistics.
 *
 * `buildStatsSnapshot` folds the raw per-turn telemetry rows, tool-call events and failed-turn
 * markers into one richly-detailed `StatsSnapshot`: windowed headline totals (today / 7d / 30d /
 * all-time), a 30-day daily activity series, and per-model / per-provider / per-thread / per-tool
 * breakdowns for each window. Everything the app shows about usage — the in-app Usage page AND the
 * external macOS menu-bar widget (LatticeBar) — is rendered from this one document, so the cards,
 * the heat-map and the breakdown tables can never disagree with each other.
 *
 * It is deliberately dependency-free (no electron/node imports) so it can run in the main process,
 * the renderer, or a standalone probe. Cost semantics reuse {@link computeCost} exactly: a turn's
 * cost is the provider-reported figure when present, else the user's cost override (exact), else the
 * model's list price (an estimate) — see ./cost.ts.
 */
import type { CostRates, ModelInfo } from './types'
import { computeCost, resolveCostRates } from './cost'

/** The bump in the schema so a stale reader (an old LatticeBar build) can tell it's out of date. */
export const STATS_SNAPSHOT_VERSION = 1

export const STATS_RANGE_KEYS = ['today', '7d', '30d', 'all'] as const
export type StatsRangeKey = (typeof STATS_RANGE_KEYS)[number]

/** The minimum a turn row needs to contribute to the rollup. Mirrors {@link UsageRow}. */
export interface StatsUsageInput {
  threadId: string
  threadTitle: string
  model?: string
  createdAt: number
  telemetry: {
    ttftMs?: number
    wallMs?: number
    toolMs?: number
    tokensIn?: number
    tokensOut?: number
    tokensReasoning?: number
    cacheReadTokens?: number
    cacheWriteTokens?: number
    costUsd?: number
  }
}

/** One tool invocation observed in the event log, flattened from `tool.started` / `tool.result`. */
export interface StatsToolInput {
  tool: string
  /** ms since epoch */
  ts: number
  /** true on a `tool.result` row; false on a bare `tool.started` (still running / no result yet) */
  completed: boolean
  ok?: boolean
  durationMs?: number
}

/** A main-run turn that ended in a failure (endpoint error, or a run interrupted mid-flight). */
export interface StatsFailureInput {
  threadId: string
  model?: string
  createdAt: number
}

/** Everything the aggregator needs, gathered by the caller (main process or probe). */
export interface StatsSnapshotInput {
  usage: StatsUsageInput[]
  tools: StatsToolInput[]
  failures: StatsFailureInput[]
  models: ModelInfo[]
  overrides?: Record<string, CostRates>
  /** ms since epoch; injectable for tests / deterministic snapshots */
  now?: number
  /** short local-zone name, e.g. "CDT" — for the "today = local calendar day" header */
  tz?: string
  /** true when written by a live Lattice; false/absent marks a snapshot read off disk after quit */
  appOpen?: boolean
}

/** Headline totals for one time window. Token fields are cache-aware (see field docs). */
export interface StatsWindow {
  requests: number
  /** main-run turns that ended in an error or were interrupted in this window */
  failed: number
  /** input tokens processed fresh — NOT served from or written to the prompt cache */
  freshInputTokens: number
  /** input tokens read from OR written to the prompt cache (read + write) */
  cachedInputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** completion tokens excluding reasoning */
  outputTokens: number
  reasoningTokens: number
  /** freshInput + output — the cache-exclusive "new tokens" figure (matches the menu-bar headline) */
  freshTotalTokens: number
  /** every token touched: fresh in + cached in + output + reasoning */
  totalTokens: number
  toolCalls: number
  costUsd: number
  /** true once any part of costUsd is a local *list-price* estimate (drives the "Est." labels) */
  costEstimated: boolean
  /** true once any part of costUsd was computed locally (list price OR a user override) */
  costLocal: boolean
  /** summed wall-clock time across turns, ms (denominator for the weighted tok/s) */
  wallMs: number
  /** summed request→first-token time across turns, ms (avg TTFT = ttftMs / requests) */
  ttftMs: number
  /** output tokens per second, weighted by wall time */
  tps: number
  /** share of input tokens that were cache reads or writes, 0-100; null with no input */
  cacheHitPct: number | null
  /** distinct threads that produced a turn in this window */
  activeThreads: number
}

/** A breakdown row (one model / provider / thread), carrying full window stats plus identity. */
export interface StatsGroup extends StatsWindow {
  key: string
  label: string
  /** secondary label — a model's provider, a thread's… (unset for providers) */
  sublabel?: string
  /** ms since epoch of the most recent turn in this group */
  lastAt: number
}

/** Per-tool usage over a window. */
export interface StatsTool {
  tool: string
  calls: number
  failed: number
  /** mean duration of completed calls, ms; null with none */
  avgMs: number | null
  lastAt: number
}

/** One local calendar day in the 30-day activity series. */
export interface StatsDay {
  /** local YYYY-MM-DD */
  date: string
  /** 0 = Sunday … 6 = Saturday */
  weekday: number
  requests: number
  /** fresh total tokens (freshInput + output) for the day */
  tokens: number
  costUsd: number
}

/** All breakdowns for a single window. */
export interface StatsRange {
  window: StatsWindow
  byModel: StatsGroup[]
  byProvider: StatsGroup[]
  byThread: StatsGroup[]
  tools: StatsTool[]
}

export interface StatsSnapshot {
  version: number
  /** ms since epoch this snapshot was computed */
  generatedAt: number
  tz: string
  appOpen: boolean
  /** last 30 local days, oldest first, for the activity heat-map */
  daily: StatsDay[]
  ranges: Record<StatsRangeKey, StatsRange>
}

function emptyWindow(): StatsWindow {
  return {
    requests: 0,
    failed: 0,
    freshInputTokens: 0,
    cachedInputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    freshTotalTokens: 0,
    totalTokens: 0,
    toolCalls: 0,
    costUsd: 0,
    costEstimated: false,
    costLocal: false,
    wallMs: 0,
    ttftMs: 0,
    tps: 0,
    cacheHitPct: null,
    activeThreads: 0
  }
}

/** Local (not UTC) calendar day key, so "Today" matches the user's wall clock. */
export function localDateKey(ts: number): string {
  const d = new Date(ts)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function windowCutoff(key: StatsRangeKey, now: number): number {
  if (key === 'all') return -Infinity
  if (key === 'today') return new Date(now).setHours(0, 0, 0, 0)
  const days = key === '7d' ? 7 : 30
  return now - days * 24 * 60 * 60 * 1000
}

/** Split a telemetry row into the cache-aware token components the cost model and totals want. */
function splitTokens(t: StatsUsageInput['telemetry']): {
  cached: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
  fresh: number
  output: number
} {
  const cacheRead = t.cacheReadTokens ?? 0
  const cacheWrite = t.cacheWriteTokens ?? 0
  const cached = cacheRead + cacheWrite
  const reasoning = t.tokensReasoning ?? 0
  const fresh = Math.max(0, (t.tokensIn ?? 0) - cached)
  const output = Math.max(0, (t.tokensOut ?? 0) - reasoning)
  return { cached, cacheRead, cacheWrite, reasoning, fresh, output }
}

function addUsage(
  w: StatsWindow,
  row: StatsUsageInput,
  models: ModelInfo[],
  overrides: Record<string, CostRates>
): void {
  const t = row.telemetry
  const { cached, cacheRead, cacheWrite, reasoning, fresh, output } = splitTokens(t)
  w.requests += 1
  w.freshInputTokens += fresh
  w.cachedInputTokens += cached
  w.cacheReadTokens += cacheRead
  w.cacheWriteTokens += cacheWrite
  w.outputTokens += output
  w.reasoningTokens += reasoning
  w.freshTotalTokens += fresh + output
  w.totalTokens += fresh + cached + output + reasoning
  w.wallMs += t.wallMs ?? 0
  w.ttftMs += t.ttftMs ?? 0
  if (t.costUsd !== undefined) {
    w.costUsd += t.costUsd
  } else {
    const resolved = resolveCostRates(row.model, models, overrides)
    if (resolved) {
      w.costUsd += computeCost(resolved.rates, { freshInput: fresh, cachedInput: cached, output, reasoning })
      w.costLocal = true
      if (resolved.estimated) w.costEstimated = true
    }
  }
}

function finalizeWindow(w: StatsWindow, threads: Set<string>): void {
  w.activeThreads = threads.size
  w.tps = w.wallMs > 0 ? Math.round((w.outputTokens / w.wallMs) * 1000) : 0
  const totalInput = w.freshInputTokens + w.cachedInputTokens
  w.cacheHitPct = totalInput > 0 ? Math.round((w.cachedInputTokens / totalInput) * 1000) / 10 : null
}

function modelLabel(id: string | undefined, models: ModelInfo[]): string {
  if (!id) return 'unknown model'
  return models.find((m) => m.id === id)?.name ?? id
}

/** Group a model to a stable, human backend name: owned_by / providerLabel / route prefix. */
function providerOf(modelId: string | undefined, models: ModelInfo[]): { key: string; label: string } {
  const m = models.find((mm) => mm.id === modelId)
  if (!m) return { key: 'unknown', label: 'Unknown provider' }
  const key = m.ownedBy || m.providerLabel || m.provider || 'unknown'
  return { key, label: key }
}

function groupInto(
  map: Map<string, StatsGroup>,
  key: string,
  label: string,
  sublabel: string | undefined,
  row: StatsUsageInput,
  models: ModelInfo[],
  overrides: Record<string, CostRates>,
  threads: Map<string, Set<string>>
): void {
  let g = map.get(key)
  if (!g) {
    g = { key, label, sublabel, lastAt: 0, ...emptyWindow() }
    map.set(key, g)
    threads.set(key, new Set())
  }
  addUsage(g, row, models, overrides)
  g.lastAt = Math.max(g.lastAt, row.createdAt)
  threads.get(key)!.add(row.threadId)
}

function summarizeTools(tools: StatsToolInput[]): StatsTool[] {
  const out = new Map<string, StatsTool>()
  const durations = new Map<string, number[]>()
  for (const ev of tools) {
    let s = out.get(ev.tool)
    if (!s) {
      s = { tool: ev.tool, calls: 0, failed: 0, avgMs: null, lastAt: ev.ts }
      out.set(ev.tool, s)
    }
    s.lastAt = Math.max(s.lastAt, ev.ts)
    // A `tool.started` marks one call; the matching `tool.result` carries ok/duration but must not
    // double-count the call, so only started rows increment `calls`.
    if (!ev.completed) {
      s.calls += 1
    } else {
      if (ev.ok === false) s.failed += 1
      if (typeof ev.durationMs === 'number') {
        const d = durations.get(ev.tool) ?? []
        d.push(ev.durationMs)
        durations.set(ev.tool, d)
      }
    }
  }
  for (const [tool, d] of durations) {
    const s = out.get(tool)
    if (s && d.length) s.avgMs = Math.round(d.reduce((a, b) => a + b, 0) / d.length)
  }
  return [...out.values()].sort((a, b) => b.calls - a.calls)
}

function buildRange(
  key: StatsRangeKey,
  input: Required<Pick<StatsSnapshotInput, 'usage' | 'tools' | 'failures' | 'models'>> & {
    overrides: Record<string, CostRates>
    now: number
  }
): StatsRange {
  const { usage, tools, failures, models, overrides, now } = input
  const cutoff = windowCutoff(key, now)
  const window = emptyWindow()
  const windowThreads = new Set<string>()
  const byModel = new Map<string, StatsGroup>()
  const byProvider = new Map<string, StatsGroup>()
  const byThread = new Map<string, StatsGroup>()
  const modelThreads = new Map<string, Set<string>>()
  const providerThreads = new Map<string, Set<string>>()
  const threadThreads = new Map<string, Set<string>>()

  for (const row of usage) {
    if (row.createdAt < cutoff) continue
    addUsage(window, row, models, overrides)
    windowThreads.add(row.threadId)
    const modelId = row.model ?? 'unknown'
    groupInto(byModel, modelId, modelLabel(row.model, models), providerOf(row.model, models).label, row, models, overrides, modelThreads)
    const prov = providerOf(row.model, models)
    groupInto(byProvider, prov.key, prov.label, undefined, row, models, overrides, providerThreads)
    groupInto(byThread, row.threadId, row.threadTitle || 'Untitled thread', undefined, row, models, overrides, threadThreads)
  }

  // Tool calls come from the event log, not the telemetry rows, so they're counted separately and
  // attributed to the window total (not to model/provider groups, which the events don't name).
  const rangeTools = tools.filter((t) => t.ts >= cutoff)
  for (const t of rangeTools) if (!t.completed) window.toolCalls += 1

  for (const f of failures) {
    if (f.createdAt < cutoff) continue
    window.failed += 1
    const mg = byModel.get(f.model ?? 'unknown')
    if (mg) mg.failed += 1
    const pg = byProvider.get(providerOf(f.model, models).key)
    if (pg) pg.failed += 1
    const tg = byThread.get(f.threadId)
    if (tg) tg.failed += 1
  }

  finalizeWindow(window, windowThreads)
  for (const g of byModel.values()) finalizeWindow(g, modelThreads.get(g.key)!)
  for (const g of byProvider.values()) finalizeWindow(g, providerThreads.get(g.key)!)
  for (const g of byThread.values()) finalizeWindow(g, threadThreads.get(g.key)!)

  const byCost = (a: StatsGroup, b: StatsGroup): number =>
    b.costUsd - a.costUsd || b.freshTotalTokens - a.freshTotalTokens
  const byTokens = (a: StatsGroup, b: StatsGroup): number => b.freshTotalTokens - a.freshTotalTokens

  return {
    window,
    byModel: [...byModel.values()].sort(byTokens),
    byProvider: [...byProvider.values()].sort(byCost),
    byThread: [...byThread.values()].sort((a, b) => b.lastAt - a.lastAt),
    tools: summarizeTools(rangeTools)
  }
}

/** Build the last-30-local-days activity series (oldest first, gap days zero-filled). */
function buildDaily(usage: StatsUsageInput[], now: number): StatsDay[] {
  const byDate = new Map<string, { requests: number; tokens: number; costUsd: number }>()
  for (const row of usage) {
    const { fresh, output } = splitTokens(row.telemetry)
    const key = localDateKey(row.createdAt)
    let d = byDate.get(key)
    if (!d) {
      d = { requests: 0, tokens: 0, costUsd: 0 }
      byDate.set(key, d)
    }
    d.requests += 1
    d.tokens += fresh + output
    d.costUsd += row.telemetry.costUsd ?? 0
  }
  const out: StatsDay[] = []
  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  for (let i = 29; i >= 0; i--) {
    const d = new Date(start)
    d.setDate(d.getDate() - i)
    const key = localDateKey(d.getTime())
    const hit = byDate.get(key)
    out.push({
      date: key,
      weekday: d.getDay(),
      requests: hit?.requests ?? 0,
      tokens: hit?.tokens ?? 0,
      costUsd: hit?.costUsd ?? 0
    })
  }
  return out
}

export function buildStatsSnapshot(input: StatsSnapshotInput): StatsSnapshot {
  const now = input.now ?? Date.now()
  const overrides = input.overrides ?? {}
  const base = {
    usage: input.usage,
    tools: input.tools,
    failures: input.failures,
    models: input.models,
    overrides,
    now
  }
  const ranges = {} as Record<StatsRangeKey, StatsRange>
  for (const key of STATS_RANGE_KEYS) ranges[key] = buildRange(key, base)
  return {
    version: STATS_SNAPSHOT_VERSION,
    generatedAt: now,
    tz: input.tz ?? '',
    appOpen: input.appOpen ?? true,
    daily: buildDaily(input.usage, now),
    ranges
  }
}

/** The short local-zone name for the header ("CDT"). Falls back to the IANA id, then "". */
export function localZoneAbbrev(now = new Date()): string {
  try {
    const parts = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(now)
    const tz = parts.find((p) => p.type === 'timeZoneName')?.value
    if (tz) return tz
  } catch {
    /* fall through */
  }
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return ''
  }
}
