import type { AppSettings, ThreadMeta } from '@shared/types'

/**
 * Per-model default reasoning tier.
 *
 * A single global `defaultEffort` is applied to every new thread regardless of model, and the tier
 * that makes sense for a local model is the wrong one for a hosted route. Measured against the
 * OmniRoute gateway on claude-sonnet-5, time to the FIRST VISIBLE TEXT token on a prompt that
 * induces some thinking, two runs each:
 *
 *   reasoning_effort: none      1194 / 1461 ms
 *   reasoning_effort: low       3728 / 1516 ms
 *   reasoning_effort: high      3554 / 3494 ms
 *
 * So a `defaultEffort` of `high` chosen for a local model (where thinking is nearly free) silently
 * costs seconds of dead air on every Claude turn. Note the cliff is between thinking and NOT
 * thinking, not between tiers: `low` only helps because the model sometimes elects to skip thinking
 * at that tier, so it is a compromise rather than the fast option. This module resolves the tier a
 * thread should start on from the model it will run, falling back to the global default when
 * nothing matches.
 *
 * Resolution order:
 *   1. the user's own `defaultEffortByModel` map — most specific matching pattern wins;
 *   2. {@link BUILTIN_EFFORT_DEFAULTS}, consulted ONLY when no user pattern matched, so adding any
 *      pattern of your own for a model fully overrides the built-in opinion about it;
 *   3. nothing (`undefined`) — the caller falls back to the global `defaultEffort`.
 *
 * Patterns are shell-style globs over the model id (`*` matches any run of characters, matching is
 * case-insensitive and must cover the whole id): `claude-sonnet-5`, `*claude*`, `openrouter/*`.
 */

/**
 * Built-in opinions, applied when the user has said nothing about a model.
 *
 * Only hosted Anthropic routes, and only down to `low` rather than `none`. `low` is the compromise:
 * it keeps thinking available for work that needs it (turning it off wholesale is a capability
 * decision, not a latency fix) and it is a tier every Claude model accepts, where `none` is not —
 * opus-5's tiers start at `low`. Set `none` in `defaultEffortByModel` for the reliably fast path;
 * a model that rejects it degrades gracefully through the `noDisableReasoning` quirk in
 * `providers/openaiCompat`. Local and other hosted models are deliberately absent here — they keep
 * whatever global default is configured.
 */
export const BUILTIN_EFFORT_DEFAULTS: Readonly<Record<string, string>> = Object.freeze({
  // Matches `claude-sonnet-5`, `cc/claude-fable-5`, `openrouter/anthropic/claude-opus-5`, …
  '*claude*': 'low'
})

/** Compile a shell-style glob (only `*` is special) into an anchored, case-insensitive regex. */
function globToRegExp(pattern: string): RegExp {
  const source = pattern
    .split('*')
    .map((literal) => literal.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
    .join('.*')
  return new RegExp(`^${source}$`, 'i')
}

/**
 * How specific a pattern is: its literal (non-wildcard) character count. `claude-sonnet-5` (15)
 * beats `*claude*` (6) beats `*` (0), which is the intuitive reading of "most specific wins".
 */
function specificity(pattern: string): number {
  return pattern.replace(/\*/g, '').length
}

/**
 * The value of the most specific pattern in `map` matching `model`, or undefined if none do. Ties
 * on specificity break toward the pattern declared first, so the map reads top-down like a config.
 */
function bestMatch(map: Record<string, string> | undefined, model: string): string | undefined {
  if (!map) return undefined
  let best: { tier: string; score: number } | undefined
  for (const [pattern, tier] of Object.entries(map)) {
    // An empty pattern or a blank tier is treated as "not configured" rather than as a match on
    // everything — a half-filled row in the settings map must not silently capture every model.
    if (!pattern || typeof tier !== 'string' || !tier) continue
    if (!globToRegExp(pattern).test(model)) continue
    const score = specificity(pattern)
    if (!best || score > best.score) best = { tier, score }
  }
  return best?.tier
}

/**
 * The reasoning tier a thread on `model` should default to, or undefined when nothing has an
 * opinion and the caller should use the global {@link AppSettings.defaultEffort}.
 */
export function effortDefaultFor(
  model: string | undefined,
  settings: Pick<AppSettings, 'defaultEffortByModel'>
): string | undefined {
  if (!model) return undefined
  return bestMatch(settings.defaultEffortByModel, model) ?? bestMatch(BUILTIN_EFFORT_DEFAULTS, model)
}

/**
 * The effort a thread should carry after its model is switched.
 *
 * Switching model is the common path to a Claude thread — a thread is created on the global default
 * model and re-pointed from the composer — so without this the per-model default at creation almost
 * never gets to apply. It re-derives the tier ONLY when the thread is still carrying the tier it
 * inherited when it was created (what {@link effortDefaultFor} would have produced for the old
 * model, or the global default); an effort the user picked by hand for this thread is left exactly
 * as it is. Returns the effort to store, which is `current` whenever nothing should change.
 */
export function effortForModelSwitch(
  current: string | undefined,
  previousModel: string | undefined,
  nextModel: string,
  settings: Pick<AppSettings, 'defaultEffort' | 'defaultEffortByModel'>
): string | undefined {
  const inherited = effortDefaultFor(previousModel, settings) ?? settings.defaultEffort
  if (current !== inherited) return current // hand-picked for this thread: never touch it
  return effortDefaultFor(nextModel, settings) ?? settings.defaultEffort
}

/**
 * A thread-update patch with {@link effortForModelSwitch} applied, for the IPC layer. Returns the
 * patch unchanged unless it switches the model to a different one, names no effort of its own, and
 * the thread is still carrying an inherited tier — the one case where the tier should follow the
 * model. `meta` is the thread as it stands before the patch; a missing one (thread not found) is a
 * no-op, leaving the store to reject the update as it always did.
 */
export function withDerivedEffort(
  patch: Partial<ThreadMeta>,
  meta: Pick<ThreadMeta, 'model' | 'effort'> | null | undefined,
  settings: Pick<AppSettings, 'defaultEffort' | 'defaultEffortByModel'>
): Partial<ThreadMeta> {
  if (patch.model === undefined || patch.effort !== undefined) return patch
  if (!meta || meta.model === patch.model) return patch
  const effort = effortForModelSwitch(meta.effort, meta.model, patch.model, settings)
  return effort === meta.effort ? patch : { ...patch, effort }
}
