/**
 * Token-set similarity for memory content. Used by every write path (self-learning distillation,
 * the `memory_save` tool, the Memory tab's duplicate finder) so "is this already known?" has ONE
 * answer everywhere. Pure: no store access, no I/O.
 *
 * Why token sets and not containment: the store accumulated five separate rows for the same
 * username fact ("User's macOS username is dylan", "User's username on macOS is dylan", …) because
 * no rewording contains another verbatim. Jaccard over content tokens collapses all of them while
 * leaving two genuinely different facts that merely share common words apart.
 */

/** Words that carry no identity for a memory: articles, copulas, and the generic subject nouns
 *  the distiller alternates between ("User …" / "The user …"). */
const SIMILARITY_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'is',
  'are',
  'was',
  'were',
  'be',
  'been',
  'has',
  'have',
  'had',
  'of',
  'to',
  'in',
  'on',
  'at',
  'for',
  'and',
  'or',
  'with',
  'as',
  'by',
  'it',
  'its',
  'this',
  'that',
  'their',
  'they',
  'them',
  'user',
  'users',
  's'
])

/** Longest a "contained" fact may be swallowed by: a containing text more than this many times longer
 *  (or longer than the absolute ceiling) is a document, not a rewording, and never counts as the
 *  same fact. This is what stops an 8 KB imported CLAUDE.md from silently eating every short
 *  learning whose words happen to appear inside it. */
const CONTAINMENT_MAX_RATIO = 3
const CONTAINMENT_MAX_LONG_CHARS = 400
/** Jaccard at/above which two memories are the same fact reworded. */
export const NEAR_DUPLICATE_JACCARD = 0.6
/** Minimum normalized length of the contained side for containment to count (a common short
 *  phrase must not swallow distinct facts). */
const CONTAINMENT_MIN_SHORT_CHARS = 8

/** Normalize memory text for comparison: lowercase, strip punctuation, collapse spaces. */
export function normalizeText(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** The identity-bearing tokens of a memory: normalized words minus stopwords, as a set. */
export function contentTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const t of normalizeText(s).split(' ')) {
    if (t.length >= 2 && !SIMILARITY_STOPWORDS.has(t)) out.add(t)
  }
  return out
}

/** Jaccard index of two token sets (0 for two empty sets). */
export function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const t of a) if (b.has(t)) inter += 1
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

/** A memory text pre-digested for repeated comparison (compute once per stored item). */
export interface Digest {
  norm: string
  tokens: Set<string>
}

export function digest(s: string): Digest {
  return { norm: normalizeText(s), tokens: contentTokens(s) }
}

/**
 * Whether one text contains the other as a rewording — the fast path. Requires the contained side
 * to be a real sentence (≥ 8 chars) and the containing side to be a comparable-length text, not a
 * document (see {@link CONTAINMENT_MAX_RATIO}).
 */
export function containsAsRewording(a: Digest, b: Digest): boolean {
  if (!a.norm || !b.norm) return false
  if (a.norm === b.norm) return true
  const [short, long] = a.norm.length <= b.norm.length ? [a.norm, b.norm] : [b.norm, a.norm]
  if (short.length < CONTAINMENT_MIN_SHORT_CHARS) return false
  if (long.length > Math.max(CONTAINMENT_MAX_LONG_CHARS, short.length * CONTAINMENT_MAX_RATIO)) return false
  return long.includes(short)
}

/** How alike two memories are: exact/containment short-circuit, else token-set Jaccard. */
export function similarity(a: Digest, b: Digest): number {
  if (containsAsRewording(a, b)) return 1
  return jaccard(a.tokens, b.tokens)
}

/** True when the two texts are the same fact (possibly reworded). */
export function isNearDuplicate(a: Digest, b: Digest, threshold = NEAR_DUPLICATE_JACCARD): boolean {
  return similarity(a, b) >= threshold
}

/**
 * Whether `candidate` carries strictly more information than `existing`: every identity token of the
 * existing text appears in the candidate and the candidate adds at least one more, or — for a
 * rewording that drops a token or two — the candidate is meaningfully longer. Used to decide
 * "revise the stored row in place" versus "discard the draft as already known".
 */
export function carriesMoreInformation(candidate: Digest, existing: Digest): boolean {
  if (candidate.tokens.size <= existing.tokens.size) return false
  let missing = 0
  for (const t of existing.tokens) if (!candidate.tokens.has(t)) missing += 1
  if (missing === 0) return true
  // Allow a rewording that loses a token while adding several (e.g. swaps "macOS username" for
  // "login name" but adds the home directory): at most 1 dropped token and ≥ 2 net new ones.
  return missing <= 1 && candidate.tokens.size - existing.tokens.size >= 2
}

/**
 * Whether `candidate` says anything `existing` does not: false only when every identity token of
 * the candidate already appears in the existing text (a strict subset, or the same set reworded).
 * A near-duplicate that passes this is either a refinement (adds tokens) or a CORRECTION (swaps
 * one — "cloud mode" → "LAN mode"); both must revise the stored row, never be discarded as known.
 */
export function addsInformation(candidate: Digest, existing: Digest): boolean {
  if (candidate.tokens.size === 0) return false
  for (const t of candidate.tokens) if (!existing.tokens.has(t)) return true
  return false
}

export interface DuplicatePair<T> {
  a: T
  b: T
  score: number
}

/**
 * Every pair of items at or above `threshold` similarity, highest first. O(n²) over digests, which
 * is fine for a personal memory store (a few hundred to a few thousand rows).
 */
export function findDuplicatePairs<T extends { content: string }>(
  items: T[],
  threshold = NEAR_DUPLICATE_JACCARD
): DuplicatePair<T>[] {
  const digests = items.map((m) => digest(m.content))
  const out: DuplicatePair<T>[] = []
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      const score = similarity(digests[i]!, digests[j]!)
      if (score >= threshold) out.push({ a: items[i]!, b: items[j]!, score })
    }
  }
  return out.sort((x, y) => y.score - x.score)
}
