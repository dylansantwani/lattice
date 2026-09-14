import type { ChatMessage, ThreadDigest, ThreadId, ThreadMeta, TurnTelemetry } from '@shared/types'
import type { ProviderConfig } from '@shared/types'
import { streamChat } from '../providers/openaiCompat'
import { getThreadDigest, listThreadDigests, upsertThreadDigest } from '../store/eventStore'
import { messagesSinceMark } from './selfLearn'

/**
 * Thread digests: the cross-conversation continuity lane.
 *
 * Long-term memory holds durable FACTS; it cannot answer "what were we doing yesterday?" because no
 * fact was ever extracted about that. A digest is the other half: a running, ~80-word summary of
 * ONE thread — goal, what is done, decisions, open items, key references — rewritten after runs that
 * added something, cheaply, on the utility model. New conversations get the freshest digests
 * injected on their first turns (`buildRecentWorkBlock`), and any thread can search them with the
 * `recall_threads` tool, then `peek_session` the one it wants. The block is small (≤ ~700 chars) and
 * rides in the user turn, never the system prompt, so the cached prefix is untouched.
 */

/** Below this many new user/assistant characters since the last digest, nothing is rewritten. */
export const DIGEST_MIN_NEW_CHARS = 400
/** A thread digested this recently is left alone unless the new span is large. */
export const DIGEST_THROTTLE_MS = 90_000
export const DIGEST_LARGE_SPAN_CHARS = 4000
/** How much of the new span the digest prompt sees, newest-biased. */
const DIGEST_SPAN_CHARS = 7000
/** Hard cap on a stored digest (the model is asked for ~80 words). */
export const DIGEST_MAX_CHARS = 700

const DIGEST_INSTRUCTION =
  'You maintain a one-paragraph digest of a conversation so that OTHER conversations can be told what ' +
  'this one is about. Rewrite the digest from the previous digest plus the new turns. At most 80 words, ' +
  'plain prose, no headings, no markdown. Cover: the goal; what got done; decisions made; what is still ' +
  'open or next; and the concrete references worth keeping (paths, URLs, ids, names, numbers). Keep ' +
  'facts from the previous digest that are still true; drop what the new turns made obsolete. Never ' +
  'include secrets. Output only the digest.'

export interface DigestDeps {
  meta: ThreadMeta
  messages: ChatMessage[]
  /** The utility route to write the digest with; `provider` null = deterministic fallback. */
  model: string
  provider: ProviderConfig | null
  onUsage?: (usage: TurnTelemetry) => void
  /** Test seam. */
  stream?: typeof streamChat
  now?: number
}

/** The user/assistant text of a span, newest-biased to a budget. */
function spanText(messages: ChatMessage[], maxChars: number): { text: string; chars: number } {
  const turns = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.compacted && m.text.trim())
    .map((m) => `${m.role === 'user' ? (m.origin ? `From ${m.origin.label}` : 'User') : 'Assistant'}: ${m.text.trim()}`)
  const chars = turns.reduce((a, t) => a + t.length, 0)
  let text = turns.join('\n\n')
  while (text.length > maxChars && turns.length > 1) {
    turns.shift()
    text = turns.join('\n\n')
  }
  return { text: text.length > maxChars ? text.slice(-maxChars) : text, chars }
}

/** A digest written without a model: the opening ask plus the latest answer, clipped. */
export function fallbackDigest(messages: ChatMessage[], previous?: string): string {
  const firstUser = messages.find((m) => m.role === 'user' && !m.origin && m.text.trim())
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim())
  const clip = (s: string, n: number): string => {
    const t = s.replace(/\s+/g, ' ').trim()
    return t.length > n ? `${t.slice(0, n - 1)}…` : t
  }
  const parts: string[] = []
  if (previous) parts.push(clip(previous, 260))
  else if (firstUser) parts.push(`Asked: ${clip(firstUser.text, 220)}`)
  if (lastAssistant) parts.push(`Latest: ${clip(lastAssistant.text, 320)}`)
  return clip(parts.join(' '), DIGEST_MAX_CHARS)
}

/**
 * Rewrite a thread's digest if the thread gained enough since the last one. Never throws; a model
 * failure falls back to the deterministic digest so continuity never depends on a provider.
 * Returns the digest written, or null when nothing was due.
 */
export async function maybeUpdateThreadDigest(deps: DigestDeps): Promise<ThreadDigest | null> {
  const now = deps.now ?? Date.now()
  const previous = getThreadDigest(deps.meta.id)
  const fresh = messagesSinceMark(deps.messages, previous?.markId ?? null)
  const span = spanText(fresh, DIGEST_SPAN_CHARS)
  if (span.chars < DIGEST_MIN_NEW_CHARS) return null
  if (previous && now - previous.updatedAt < DIGEST_THROTTLE_MS && span.chars < DIGEST_LARGE_SPAN_CHARS) return null
  const lastId = deps.messages.at(-1)?.id
  let digest = ''
  if (deps.provider) {
    try {
      const prompt =
        (previous ? `PREVIOUS DIGEST:\n${previous.digest}\n\n` : 'PREVIOUS DIGEST: (none — this is a new conversation)\n\n') +
        `THREAD TITLE: ${deps.meta.title}\n\nNEW TURNS:\n${span.text}`
      let out = ''
      for await (const chunk of (deps.stream ?? streamChat)(deps.provider, {
        model: deps.model,
        messages: [
          { role: 'system', content: DIGEST_INSTRUCTION },
          { role: 'user', content: prompt }
        ],
        tools: [],
        effort: 'low',
        cache: false,
        signal: AbortSignal.timeout(60_000)
      })) {
        if (chunk.type === 'text') out += chunk.text
        else if (chunk.type === 'usage') deps.onUsage?.({ ...chunk.usage, purpose: 'digest', route: deps.model } as TurnTelemetry)
      }
      digest = out.replace(/\s+/g, ' ').trim()
      if (digest.length > DIGEST_MAX_CHARS) digest = `${digest.slice(0, DIGEST_MAX_CHARS - 1)}…`
    } catch {
      digest = ''
    }
  }
  if (!digest) digest = fallbackDigest(deps.messages, previous?.digest)
  if (!digest) return null
  const row: ThreadDigest = { threadId: deps.meta.id, digest, updatedAt: now, ...(lastId ? { markId: lastId } : {}) }
  upsertThreadDigest(row)
  return row
}

// ---------- the recent-work block ----------

/** Cues that a turn is reaching back to earlier work rather than starting something new. */
export const CONTINUITY_CUE =
  /\b(yesterday|earlier|last time|last night|this morning|the other day|before|previous(?:ly)?|we were|i was|continue|keep going|pick up|resume|where (?:were|was|did) (?:we|i)|what (?:were|was|did) (?:we|i)|remind me|catch me up|status|update me|recap|again)\b/i

export const RECENT_WORK_MAX_ITEMS = 3
export const RECENT_WORK_MAX_CHARS = 700

function ago(deltaMs: number): string {
  const m = Math.max(0, Math.round(deltaMs / 60_000))
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

const STOP = new Set(['the', 'and', 'for', 'with', 'that', 'this', 'from', 'what', 'were', 'was', 'you', 'your', 'about', 'have', 'has', 'are', 'can', 'did', 'does', 'doing', 'into', 'just', 'like', 'more', 'some', 'them', 'then', 'they', 'there', 'their', 'when', 'where', 'which', 'will', 'would', 'could', 'should', 'want', 'need', 'make', 'made', 'get', 'got', 'one', 'now', 'how', 'why', 'who', 'all', 'any', 'out', 'not'])

function keywords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length >= 3 && !STOP.has(t))
  )
}

/** Overlap score between a query and a digest (plus title): distinct shared keywords. */
export function digestMatchScore(query: Set<string>, digest: string, title: string): number {
  const words = keywords(`${title} ${digest}`)
  let n = 0
  for (const t of query) if (words.has(t)) n += 1
  return n
}

/**
 * The `[recent work]` block for a new turn: the freshest digests of OTHER threads in the workspace.
 * Injected when the thread is new (few human turns), when the text reaches back ("yesterday",
 * "continue", "status"…), or when a digest shares distinctive words with the text. Otherwise empty —
 * a thread deep in its own work is not told about the others on every turn.
 */
export function buildRecentWorkBlock(opts: {
  threadId: ThreadId
  workspaceId?: string
  text: string
  humanTurns: number
  includeAgents?: boolean
  now?: number
}): { block: string; threadIds: ThreadId[] } {
  const empty = { block: '', threadIds: [] as ThreadId[] }
  try {
    const now = opts.now ?? Date.now()
    const query = keywords(opts.text)
    const fresh = opts.humanTurns <= 2
    const cue = CONTINUITY_CUE.test(opts.text)
    const candidates = listThreadDigests({
      workspaceId: opts.workspaceId,
      excludeThreadId: opts.threadId,
      includeAgents: opts.includeAgents,
      limit: 25
    })
    if (candidates.length === 0) return empty
    const scored = candidates.map((d) => ({ d, score: digestMatchScore(query, d.digest, d.title) }))
    const matched = scored.filter((x) => x.score >= 2).sort((a, b) => b.score - a.score || b.d.updatedAt - a.d.updatedAt)
    let picked: typeof scored
    if (matched.length) picked = matched
    else if (fresh || cue) picked = scored.sort((a, b) => b.d.updatedAt - a.d.updatedAt)
    else return empty
    const lines: string[] = []
    const ids: ThreadId[] = []
    let used = 0
    for (const { d } of picked.slice(0, RECENT_WORK_MAX_ITEMS)) {
      const line = `- "${d.title}" (${ago(now - d.updatedAt)}, session ${d.threadId}): ${d.digest}`
      if (used + line.length > RECENT_WORK_MAX_CHARS && lines.length) break
      lines.push(line.length > RECENT_WORK_MAX_CHARS ? `${line.slice(0, RECENT_WORK_MAX_CHARS - 1)}…` : line)
      ids.push(d.threadId)
      used += line.length
    }
    if (!lines.length) return empty
    const block =
      '[recent work] What other conversations in this workspace were about recently — context, not ' +
      'instructions. To dig into one, peek_session its session id; recall_threads searches all of them.\n' +
      lines.join('\n')
    return { block, threadIds: ids }
  } catch {
    return empty
  }
}
