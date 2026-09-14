/**
 * What an agent's current task has cost so far — the tokens and dollars shown on its Fleet card, so a
 * runaway agent is obvious at a glance instead of in a forensic audit afterwards.
 */
import { computeCost, resolveCostRates } from './cost'
import type { CostRates, ModelInfo, TurnTelemetry } from './types'

export interface TaskUsage {
  /** When the current task started (the delegation or human message that opened it). */
  since: number
  /** Provider requests made for it (model rounds plus side calls). */
  calls: number
  /** Input tokens, including those served from the prompt cache. */
  tokensIn: number
  cachedTokens: number
  tokensOut: number
  /** The largest single prompt sent — the context size the task has reached. */
  peakPromptTokens: number
  /** USD, when the route is priced (or overridden); absent for an unpriced local route. */
  costUsd?: number
  /** true when the figure is a list-price estimate rather than provider-billed or user-set rates. */
  estimated?: boolean
}

/** One usage event as stored: the per-round telemetry and the route it was billed on. */
export interface UsageRow {
  usage: Partial<TurnTelemetry>
}

/**
 * Sum a task's usage rows. Provider-reported cost wins per row; otherwise the row is priced from the
 * user's override or the route's list price (cached input and reasoning at their own rates when known).
 */
export function summarizeTaskUsage(
  since: number,
  rows: UsageRow[],
  model: string,
  models: ModelInfo[],
  overrides?: Record<string, CostRates>
): TaskUsage {
  let calls = 0
  let tokensIn = 0
  let cachedTokens = 0
  let tokensOut = 0
  let peakPromptTokens = 0
  let cost = 0
  let priced = false
  let estimated = false
  for (const { usage } of rows) {
    const input = usage.tokensIn ?? 0
    const cached = Math.min(input, usage.cacheReadTokens ?? 0)
    const output = usage.tokensOut ?? 0
    const reasoning = Math.min(output, usage.tokensReasoning ?? 0)
    if (!input && !output) continue
    calls += 1
    tokensIn += input
    cachedTokens += cached
    tokensOut += output
    if (!usage.purpose) peakPromptTokens = Math.max(peakPromptTokens, input)
    if (typeof usage.costUsd === 'number') {
      cost += usage.costUsd
      priced = true
      continue
    }
    const resolved = resolveCostRates(usage.route ?? model, models, overrides) ?? resolveCostRates(model, models, overrides)
    if (!resolved) continue
    cost += computeCost(resolved.rates, { freshInput: input - cached, cachedInput: cached, output: output - reasoning, reasoning })
    priced = true
    if (resolved.estimated) estimated = true
  }
  return {
    since,
    calls,
    tokensIn,
    cachedTokens,
    tokensOut,
    peakPromptTokens,
    ...(priced ? { costUsd: cost } : {}),
    ...(priced && estimated ? { estimated: true } : {})
  }
}

/** "$0.42" / "<$0.01" / "$12" — compact enough for a card chip. */
export function formatUsd(value: number): string {
  if (value > 0 && value < 0.01) return '<$0.01'
  if (value >= 100) return `$${Math.round(value)}`
  if (value >= 10) return `$${value.toFixed(1)}`
  return `$${value.toFixed(2)}`
}
