import type { RunEvent } from '@shared/types'
import type { TurnUsage } from './usageStats'

/** Anthropic-style cache entries expire after about five minutes of silence. */
export const CACHE_TTL_MS = 5 * 60 * 1000

export interface CacheInsight {
  runId: string
  readTokens: number
  writeTokens: number
  freshTokens: number
  /** share of this turn's input that was served from cache, 0–100, or null with no usage */
  hitRatePct: number | null
  /** one-line verdict */
  verdict: 'hit' | 'partial' | 'cold' | 'none' | 'off' | 'unknown'
  /** human explanations, most likely cause first */
  reasons: string[]
}

/**
 * Why the prompt cache did (or did not) help on a turn. Pure — derives everything from the usage
 * events folded into `turns` (most-recent first, as `buildTurnUsage` returns them) and the raw
 * events for the compaction check. The causes are heuristics stated as such: a cold prefix is
 * explained by whatever changed since the previous turn (model, effort, a compaction, a long gap),
 * falling back to the generic "prefix changed or entry expired".
 */
export function explainCache(turns: TurnUsage[], events: RunEvent[], index = 0): CacheInsight | null {
  const turn = turns[index]
  if (!turn) return null
  const prev = turns[index + 1]
  const read = turn.cacheReadTokens
  const write = turn.cacheWriteTokens
  const fresh = turn.freshInputTokens
  const input = read + write + fresh
  const base = { runId: turn.runId, readTokens: read, writeTokens: write, freshTokens: fresh }

  if (!turn.hasUsage) {
    return { ...base, hitRatePct: null, verdict: 'unknown', reasons: ['No usage was reported for this turn yet.'] }
  }
  if (turn.promptCaching === false) {
    return {
      ...base,
      hitRatePct: input ? Math.round((read / input) * 100) : 0,
      verdict: 'off',
      reasons: ['Prompt caching is switched off for the provider serving this thread (Settings → Providers).']
    }
  }
  const hitRatePct = input ? Math.round((read / input) * 100) : 0
  if (read === 0 && write === 0) {
    return {
      ...base,
      hitRatePct,
      verdict: 'none',
      reasons: [
        'The route reported no cache activity at all — this model or provider may not support prompt caching, or the gateway did not pass the cache markers through.'
      ]
    }
  }
  if (read === 0) {
    const reasons: string[] = ['The cached prefix was cold: everything was written, nothing was read.']
    if (!prev) reasons.push('This is the thread\'s first turn — the prefix had to be written once.')
    else {
      if (prev.model && turn.model && prev.model !== turn.model) reasons.push(`The model changed since the previous turn (${prev.model} → ${turn.model}); caches are per model.`)
      if ((prev.effort ?? '') !== (turn.effort ?? '')) reasons.push('The thinking effort changed; the system prompt names it, so the prefix changed.')
      if (compactedBetween(events, prev.runId, turn.runId)) reasons.push('The history was compacted between the turns, rewriting the prefix.')
      if (turn.ts - prev.ts > CACHE_TTL_MS) reasons.push(`More than five minutes passed since the previous turn (${Math.round((turn.ts - prev.ts) / 60000)} min) — the entry likely expired.`)
      if (reasons.length === 1) reasons.push('Something in the stable prefix changed (system prompt, tool set, or settings) — or the entry expired.')
    }
    return { ...base, hitRatePct, verdict: 'cold', reasons }
  }
  if (fresh > 0 && hitRatePct < 80) {
    return {
      ...base,
      hitRatePct,
      verdict: 'partial',
      reasons: [
        `Partial hit: ${hitRatePct}% of the input came from cache; the fresh ${fresh.toLocaleString()} tokens are this turn's new text and tool results, which is normal.`,
        ...(write > 0 ? ['The tail was re-written so the next turn can read it.'] : [])
      ]
    }
  }
  return {
    ...base,
    hitRatePct,
    verdict: 'hit',
    reasons: [`Cache hit: ${hitRatePct}% of the input was read from cache.`]
  }
}

/** True when a compaction event lies between two main runs' first events. */
function compactedBetween(events: RunEvent[], olderRunId: string, newerRunId: string): boolean {
  let seenOlder = false
  for (const ev of events) {
    if (ev.agent) continue
    if (ev.runId === olderRunId) seenOlder = true
    if (ev.runId === newerRunId) return false
    if (seenOlder && ev.body.type === 'compaction') return true
  }
  return false
}
