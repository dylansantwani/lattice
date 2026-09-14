/**
 * Cost model helpers — the single source of truth for turning token counts into a USD figure when
 * the provider itself doesn't report billed cost.
 *
 * Priority, per route:
 *   1. provider-reported cost   → authoritative, handled by the caller (this module never overrides it)
 *   2. user cost override       → exact, from `AppSettings.costOverrides`
 *   3. model list price         → estimated, from the gateway/OpenRouter catalog
 *
 * The estimate (case 3) is deliberately coarse: it only knows an input rate and an output rate, so it
 * charges every input token (cached or not) at the input rate and every output token (reasoning
 * included) at the output rate. `computeCost` reproduces that exactly when the cached/reasoning rates
 * are omitted, so introducing this module changes no existing estimate — it only adds the ability to
 * refine the four dimensions independently once a user supplies an override.
 */
import type { CostRates, ModelInfo } from './types'

export interface ResolvedRates {
  rates: CostRates
  /** true when the rates came from list price (estimated); false when user-authored (exact). */
  estimated: boolean
}

/** Token components of a turn/row, already split by cache status and reasoning. */
export interface CostTokens {
  /** input tokens processed fresh (not served from or written to cache) */
  freshInput: number
  /** input tokens read from or written to the prompt cache */
  cachedInput: number
  /** completion tokens excluding reasoning */
  output: number
  /** reasoning tokens */
  reasoning: number
}

/**
 * Resolve the rates to use for a route: the user override (exact) if one exists, else the model's
 * list price (estimated), else `null` when neither is known (e.g. a local model with no pricing and
 * no override — the caller then shows "—" rather than a fabricated $0).
 */
export function resolveCostRates(
  modelId: string | undefined,
  models: ModelInfo[],
  overrides: Record<string, CostRates> | undefined
): ResolvedRates | null {
  if (modelId && overrides) {
    const o = overrides[modelId]
    if (o) return { rates: o, estimated: false }
  }
  const pricing = models.find((m) => m.id === modelId)?.pricing
  if (pricing) {
    // A catalog that prices cache hits or reasoning separately is used as reported: on a cache-heavy
    // agent thread (DeepSeek V4 Flash: $0.22 fresh vs $0.007 cached per MTok) charging every input
    // token at the fresh rate overstated the bill ~20x.
    return {
      rates: {
        inputPerMTok: pricing.inputPerMTok,
        outputPerMTok: pricing.outputPerMTok,
        ...(pricing.cachedInputPerMTok !== undefined ? { cachedInputPerMTok: pricing.cachedInputPerMTok } : {}),
        ...(pricing.reasoningPerMTok !== undefined ? { reasoningPerMTok: pricing.reasoningPerMTok } : {})
      },
      estimated: true
    }
  }
  return null
}

/**
 * Cost in USD for the given token components at the given rates. Cached input falls back to the input
 * rate and reasoning to the output rate when those dimensions aren't priced separately.
 */
export function computeCost(rates: CostRates, tk: CostTokens): number {
  const cachedRate = rates.cachedInputPerMTok ?? rates.inputPerMTok
  const reasoningRate = rates.reasoningPerMTok ?? rates.outputPerMTok
  return (
    (tk.freshInput / 1_000_000) * rates.inputPerMTok +
    (tk.cachedInput / 1_000_000) * cachedRate +
    (tk.output / 1_000_000) * rates.outputPerMTok +
    (tk.reasoning / 1_000_000) * reasoningRate
  )
}

/**
 * The rates to pre-fill the cost editor with for a route: the existing override verbatim, else the
 * list price expanded to all four fields (cached ← input, reasoning ← output, matching how the
 * current estimate already treats them), else zeros. Never returns undefined so the editor always
 * has a starting point.
 */
export function prefillRates(
  modelId: string,
  models: ModelInfo[],
  overrides: Record<string, CostRates> | undefined
): CostRates {
  const existing = overrides?.[modelId]
  if (existing) {
    return {
      inputPerMTok: existing.inputPerMTok,
      cachedInputPerMTok: existing.cachedInputPerMTok ?? existing.inputPerMTok,
      outputPerMTok: existing.outputPerMTok,
      reasoningPerMTok: existing.reasoningPerMTok ?? existing.outputPerMTok
    }
  }
  const pricing = models.find((m) => m.id === modelId)?.pricing
  const input = pricing?.inputPerMTok ?? 0
  const output = pricing?.outputPerMTok ?? 0
  return {
    inputPerMTok: input,
    cachedInputPerMTok: input,
    outputPerMTok: output,
    reasoningPerMTok: output
  }
}
