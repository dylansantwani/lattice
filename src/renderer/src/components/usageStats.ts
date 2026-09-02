import type { CostRates, ModelInfo, RunEvent } from '@shared/types'
import { computeCost, resolveCostRates } from '@shared/cost'

/** Aggregated usage for one main-run turn (a single user message's run — it may span several
 * provider round-trips when the model makes tool calls, so several `usage` events fold into it). */
export interface TurnUsage {
  runId: string
  ts: number
  model?: string
  effort?: string
  /** input tokens processed fresh this turn, i.e. NOT served from or written to the prompt cache */
  freshInputTokens: number
  /** input tokens read from or written to the prompt cache (read + write combined) */
  cachedInputTokens: number
  /** completion tokens excluding reasoning tokens (kept separate so the two never double-count) */
  outputTokens: number
  reasoningTokens: number
  toolCalls: number
  costUsd: number
  /** true once any part of costUsd came from a local *list-price* estimate rather than the provider */
  costEstimated: boolean
  /** true once any part of costUsd was computed locally (list price OR a user override) rather than
   * reported by the provider — i.e. the cost is user-adjustable via a cost override. Distinct from
   * `costEstimated`: an override makes cost exact (no "~") but still locally computed. */
  costLocal: boolean
  /** true once we saw at least one usage event this turn (distinguishes "$0.00" from "unknown") */
  hasUsage: boolean
}

function emptyTurn(runId: string, ts: number, model?: string, effort?: string): TurnUsage {
  return {
    runId,
    ts,
    model,
    effort,
    freshInputTokens: 0,
    cachedInputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    toolCalls: 0,
    costUsd: 0,
    costEstimated: false,
    costLocal: false,
    hasUsage: false
  }
}

/**
 * One entry per main-run turn, most-recent first. Subagent events (tagged with `agent`) are
 * excluded — they belong to their own runs and aren't part of the session-level breakdown the
 * user is directly waiting on and billed for; the Agents tab covers them separately.
 */
export function buildTurnUsage(
  events: RunEvent[],
  models: ModelInfo[],
  overrides: Record<string, CostRates> = {}
): TurnUsage[] {
  const byRun = new Map<string, TurnUsage>()
  const order: string[] = []
  for (const ev of events) {
    if (ev.agent) continue
    const b = ev.body
    if (b.type === 'run.started') {
      if (!byRun.has(ev.runId)) {
        byRun.set(ev.runId, emptyTurn(ev.runId, ev.ts, b.model, b.effort))
        order.push(ev.runId)
      }
      continue
    }
    const turn = byRun.get(ev.runId)
    if (!turn) continue // events from before the inspector's window, or a malformed stream
    if (b.type === 'tool.started') {
      turn.toolCalls += 1
    } else if (b.type === 'usage') {
      turn.hasUsage = true
      const u = b.usage
      const cached = (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
      const reasoning = u.tokensReasoning ?? 0
      const fresh = Math.max(0, (u.tokensIn ?? 0) - cached)
      const output = Math.max(0, (u.tokensOut ?? 0) - reasoning)
      turn.cachedInputTokens += cached
      turn.freshInputTokens += fresh
      turn.reasoningTokens += reasoning
      turn.outputTokens += output
      if (u.costUsd !== undefined) {
        turn.costUsd += u.costUsd
      } else {
        // Provider didn't report cost (common on local/self-hosted routes) — fall back to a local
        // cost model: the user's override if set (exact), else the model's list price (estimated).
        const resolved = resolveCostRates(turn.model, models, overrides)
        if (resolved) {
          turn.costUsd += computeCost(resolved.rates, {
            freshInput: fresh,
            cachedInput: cached,
            output,
            reasoning
          })
          turn.costLocal = true
          if (resolved.estimated) turn.costEstimated = true
        }
      }
    }
  }
  return order
    .map((id) => byRun.get(id)!)
    .reverse()
    .filter((t) => t.hasUsage || t.toolCalls > 0)
}

export function sumTurns(turns: TurnUsage[]): TurnUsage {
  const total = emptyTurn('total', 0)
  for (const t of turns) {
    total.freshInputTokens += t.freshInputTokens
    total.cachedInputTokens += t.cachedInputTokens
    total.outputTokens += t.outputTokens
    total.reasoningTokens += t.reasoningTokens
    total.toolCalls += t.toolCalls
    total.costUsd += t.costUsd
    total.costEstimated ||= t.costEstimated
    total.costLocal ||= t.costLocal
    total.hasUsage ||= t.hasUsage
  }
  return total
}

export function fmtCost(usd: number, estimated: boolean): string {
  return `${estimated ? '~' : ''}$${usd < 0.01 && usd > 0 ? usd.toFixed(4) : usd.toFixed(2)}`
}

export function modelLabel(id: string | undefined, models: ModelInfo[]): string {
  if (!id) return 'unknown model'
  return models.find((m) => m.id === id)?.name ?? id
}

/** All input tokens this turn processed, cached or not — the number that maps to what the
 * provider actually billed for input, before splitting it out by cache status. */
export function totalInputTokens(t: TurnUsage): number {
  return t.freshInputTokens + t.cachedInputTokens
}

/** Share of input tokens that were cache reads or writes, 0-100. `null` when there's no input
 * to take a share of yet, so the UI can render "—" instead of a misleading 0%. */
export function cacheRatePct(t: TurnUsage): number | null {
  const total = totalInputTokens(t)
  return total > 0 ? Math.round((t.cachedInputTokens / total) * 100) : null
}

/** Coarse "how long ago", for a quick scan of when a turn happened without doing the mental math
 * on a raw clock time. Callers pair it with the absolute time (e.g. in a `title` tooltip) since a
 * relative label goes stale between renders — this is a snapshot at render time, not a live clock. */
export function relativeTime(ts: number, now: number = Date.now()): string {
  const diffSec = Math.round((now - ts) / 1000)
  if (diffSec < 5) return 'just now'
  if (diffSec < 60) return `${diffSec}s ago`
  const diffMin = Math.round(diffSec / 60)
  if (diffMin < 60) return `${diffMin}m ago`
  const diffHr = Math.round(diffMin / 60)
  if (diffHr < 24) return `${diffHr}h ago`
  const diffDay = Math.round(diffHr / 24)
  return `${diffDay}d ago`
}
