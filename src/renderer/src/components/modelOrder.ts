/**
 * Shared recent/most-used model ordering — the "quick picks" logic used by the model picker's
 * top strip and the composer's compact quick-picker dropdown. Pure and framework-free so both
 * call sites share one definition (and one test surface) instead of duplicating the blend.
 *
 * The blend: recency is the PRIMARY signal, usage is the FALLBACK. Recently-selected models
 * lead (in recency order); when they don't fill the row, the most-used models top it up. That
 * keeps the strip useful the moment you've run anything, even in a fresh session with no
 * recents recorded yet.
 */
import type { ModelInfo } from '@shared/types'
import { baseStem } from './effort'

/**
 * Index models by their base stem (effort variants — `…:low`, `…-high`, `…-ultracode` — collapse
 * onto one key), so a recent/usage id that carries an effort suffix still resolves to the single
 * selectable row. First entry wins for a given stem; feed this the already-collapsed model list
 * (`collapseVariants`) where there is at most one row per stem anyway.
 */
export function modelsByBase(models: ModelInfo[]): Map<string, ModelInfo> {
  const map = new Map<string, ModelInfo>()
  for (const m of models) {
    const k = baseStem(m.id)
    if (!map.has(k)) map.set(k, m)
  }
  return map
}

/**
 * Fold per-selected-id usage counts onto base-stem keys, so a model and its effort variants
 * share one tally (usage is recorded against the exact selected id, which may carry a suffix).
 */
export function foldUsageByBase(modelUsage: Record<string, number>): Map<string, number> {
  const map = new Map<string, number>()
  for (const [id, n] of Object.entries(modelUsage)) {
    const k = baseStem(id)
    map.set(k, (map.get(k) ?? 0) + n)
  }
  return map
}

/**
 * Resolve the user's starred favorite ids to real, selectable models, in the order they were
 * starred, de-duped. An id is matched exactly first, then by base stem (so a favorite saved with an
 * effort suffix still resolves onto its collapsed row); ids no longer present in the list — a model
 * that vanished when a provider was removed — are simply dropped. Pure and framework-free so the
 * picker's "Favorites" section has one tested definition. Feed it the collapsed model list.
 */
export function favoriteModelsList(favoriteIds: string[], models: ModelInfo[]): ModelInfo[] {
  const byId = new Map(models.map((m) => [m.id, m]))
  const byBase = modelsByBase(models)
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  for (const id of favoriteIds) {
    if (typeof id !== 'string' || !id) continue
    const m = byId.get(id) ?? byBase.get(baseStem(id))
    if (m && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  return out
}

export interface QuickPicks {
  /** The ordered, de-duped models (recent first, then usage fill), capped at `max`. */
  picks: ModelInfo[]
  /** How many leading picks came from the recent list; the rest are most-used fill. */
  recentCount: number
}

/**
 * Recent-then-most-used ordering, de-duped by model id and capped at `max`.
 *
 * @param recentModelIds most-recent-first selected ids (may carry effort suffixes)
 * @param usageByBase    per-base-stem usage counts (see {@link foldUsageByBase})
 * @param byBase         base-stem → representative model (see {@link modelsByBase})
 */
export function quickPickModels(
  recentModelIds: string[],
  usageByBase: Map<string, number>,
  byBase: Map<string, ModelInfo>,
  max = 6
): QuickPicks {
  const seen = new Set<string>()
  const out: ModelInfo[] = []
  // Recent first, in recency order.
  for (const id of recentModelIds) {
    const m = byBase.get(baseStem(id))
    if (m && !seen.has(m.id)) {
      seen.add(m.id)
      out.push(m)
    }
  }
  const recentCount = out.length
  // Fall back to most-used to fill the row when recents don't cover it.
  if (out.length < max) {
    const used = [...usageByBase.entries()]
      .filter(([, n]) => n > 0)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => byBase.get(k))
      .filter((m): m is ModelInfo => !!m)
    for (const m of used) {
      if (out.length >= max) break
      if (!seen.has(m.id)) {
        seen.add(m.id)
        out.push(m)
      }
    }
  }
  return { picks: out.slice(0, max), recentCount }
}

/** The strip label for a {@link QuickPicks} result: reflects which signals actually contributed. */
export function quickPicksLabel(qp: QuickPicks): 'Recent' | 'Recent & used' | 'Most used' {
  if (qp.recentCount === 0) return 'Most used'
  return qp.picks.length > qp.recentCount ? 'Recent & used' : 'Recent'
}
