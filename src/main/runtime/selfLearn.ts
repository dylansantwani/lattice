import type { ChatMessage, MemoryScope, MemoryType, ThreadMeta } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import { getSettings, listMemory, listWorkspaces, upsertMemory } from '../store/eventStore'
import { streamChat, type WireMessage } from '../providers/openaiCompat'
import type { ProviderConfig } from '@shared/types'
import { runMemorySync } from '../memory/bridge'

/**
 * Self-learning: after a run completes, read the just-finished exchange and distill 0–N durable,
 * reusable memories (preferences, stable facts, decisions, environment notes, warnings) that would
 * help on a future, unrelated turn. High-confidence, non-sensitive learnings are stored `approved`
 * (so they inject into the prompt and export to Claude Code + Hermes through the memory bridge);
 * everything else is stored `proposed` for the user to review in the Memory tab. The whole pass is
 * best-effort — a missing provider, a refusal, or malformed model output distills nothing rather
 * than throwing into the run.
 */

/** Hard cap on how many learnings we accept from one run, so a chatty model can't flood the store. */
export const MAX_LEARNINGS_PER_RUN = 6
/** Confidence at/above which a non-sensitive learning is auto-approved (when the setting allows). */
export const AUTO_APPROVE_CONFIDENCE = 0.75
/** Per-learning content cap — a durable memory is a sentence or two, not an essay. */
const MAX_CONTENT_CHARS = 600
/** Transcript budget handed to the reflection model, oldest turns dropped first. */
const MAX_TRANSCRIPT_CHARS = 12000

const MEMORY_TYPES: readonly MemoryType[] = [
  'preference',
  'fact',
  'decision',
  'environment',
  'warning',
  'note'
]
/** Scopes the model may choose from; we resolve the concrete scopeId ourselves. */
const LEARN_SCOPES = ['user', 'workspace', 'thread'] as const
type LearnScope = (typeof LEARN_SCOPES)[number]

export interface LearnDraft {
  content: string
  type: MemoryType
  scope: LearnScope
  confidence: number
}

/** The reflection instruction. Kept strict about durability and output shape. */
export function buildLearnPrompt(transcript: string): string {
  return (
    'You are the memory-distillation pass for an AI assistant. Read the conversation below and ' +
    'extract only durable, reusable facts worth remembering for a FUTURE, unrelated conversation — ' +
    'the kind of thing a thoughtful colleague would jot down about how this person works.\n\n' +
    'Save things like: stable preferences ("prefers tabs over spaces", "wants terse answers"), ' +
    'durable facts about the user or their projects, decisions with lasting effect, environment/setup ' +
    'notes, and warnings/gotchas that will recur.\n\n' +
    'Do NOT save: the task itself or its one-off details, transient state, restatements of the ' +
    'question, anything already obvious, or secrets/credentials/tokens/keys. When in doubt, leave it ' +
    'out — most conversations yield nothing worth saving, and returning an empty list is the correct, ' +
    'common answer.\n\n' +
    'Reply with ONLY a JSON array (no prose, no code fence). Each element:\n' +
    '  {"content": string, "type": "preference|fact|decision|environment|warning|note", ' +
    '"scope": "user|workspace|thread", "confidence": number 0..1}\n' +
    'Write each "content" as a standalone durable statement that makes sense with no other context. ' +
    'Use "user" scope for facts about the person that travel everywhere, "workspace" for things ' +
    'specific to the current project, "thread" only for this conversation. Return [] if nothing ' +
    'qualifies.\n\n' +
    '--- CONVERSATION ---\n' +
    transcript
  )
}

/** Build a compact user/assistant transcript from a thread's messages, newest-biased to a budget. */
export function buildTranscript(messages: ChatMessage[]): string {
  const turns = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.compacted && m.text.trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.trim()}`)
  let transcript = turns.join('\n\n')
  // Keep the most recent turns if we're over budget — the tail is where fresh, durable signal lives.
  while (transcript.length > MAX_TRANSCRIPT_CHARS && turns.length > 1) {
    turns.shift()
    transcript = turns.join('\n\n')
  }
  return transcript
}

function coerceType(raw: unknown): MemoryType {
  const t = String(raw ?? '').toLowerCase()
  return (MEMORY_TYPES as readonly string[]).includes(t) ? (t as MemoryType) : 'note'
}

function coerceScope(raw: unknown): LearnScope {
  const s = String(raw ?? '').toLowerCase()
  return (LEARN_SCOPES as readonly string[]).includes(s) ? (s as LearnScope) : 'user'
}

function coerceConfidence(raw: unknown): number {
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n)) return 0.5
  return Math.min(1, Math.max(0, n))
}

/**
 * Parse the reflection model's output into validated drafts. Tolerant of a stray code fence or a
 * line of preamble: we extract the first top-level JSON array and validate each element. Anything
 * malformed yields an empty list rather than throwing.
 */
export function parseLearnings(raw: string): LearnDraft[] {
  if (!raw) return []
  // Strip a leading ```json / ``` fence if the model wrapped its answer despite instructions.
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Fall back to the first '[' … last ']' span so a line of prose before the array still parses.
  if (!text.startsWith('[')) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end < start) return []
    text = text.slice(start, end + 1)
  }
  let arr: unknown
  try {
    arr = JSON.parse(text)
  } catch {
    return []
  }
  if (!Array.isArray(arr)) return []
  const out: LearnDraft[] = []
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue
    const rec = el as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content.trim() : ''
    if (!content) continue
    out.push({
      content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS).trim() : content,
      type: coerceType(rec.type),
      scope: coerceScope(rec.scope),
      confidence: coerceConfidence(rec.confidence)
    })
  }
  return out
}

/** Normalize memory text for similarity comparison: lowercase, strip punctuation, collapse spaces. */
export function normalizeForDedup(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Drop drafts that duplicate an existing memory or an earlier draft in the same batch. Two texts are
 * "the same" when, normalized, one contains the other (so a slight rewording of a known fact is
 * treated as already-known). Keeps the highest-confidence draft among in-batch near-duplicates.
 */
export function dedupeLearnings(drafts: LearnDraft[], existing: { content: string }[]): LearnDraft[] {
  const known = existing.map((m) => normalizeForDedup(m.content)).filter(Boolean)
  const similar = (a: string, b: string): boolean => {
    if (!a || !b) return false
    if (a === b) return true
    // Treat a rewording as already-known when one text contains the other. Require the shorter
    // (contained) string to be reasonably long so a common short phrase can't swallow distinct facts.
    const [short, long] = a.length <= b.length ? [a, b] : [b, a]
    return short.length >= 8 && long.includes(short)
  }

  const kept: LearnDraft[] = []
  const keptNorms: string[] = []
  for (const d of [...drafts].sort((a, b) => b.confidence - a.confidence)) {
    const norm = normalizeForDedup(d.content)
    if (!norm) continue
    if (known.some((k) => similar(k, norm))) continue
    if (keptNorms.some((k) => similar(k, norm))) continue
    kept.push(d)
    keptNorms.push(norm)
  }
  return kept
}

/**
 * Heuristic: does this content look like a secret/credential we must never auto-store or export?
 * Errs toward caution — a match forces the item to `proposed` (human review) regardless of settings.
 */
export function looksSensitive(content: string): boolean {
  const s = content.toLowerCase()
  if (/\b(password|passwd|secret|api[\s_-]?key|token|credential|private[\s_-]?key|passphrase|bearer)\b/.test(s))
    return true
  // Long high-entropy-ish runs: base64/hex blobs, sk-/ghp_-style keys, JWTs.
  if (/\b(sk|pk|ghp|gho|xox[baprs])[-_][a-z0-9]{16,}/i.test(content)) return true
  if (/\beyJ[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\.[a-z0-9_-]{10,}\b/i.test(content)) return true // JWT
  if (/[a-f0-9]{40,}/i.test(content)) return true // long hex (hashes/keys)
  return false
}

/** Decide the stored status for a learning given the auto-approve setting and its confidence. */
export function statusFor(draft: LearnDraft, autoApprove: boolean): 'approved' | 'proposed' {
  if (!autoApprove) return 'proposed'
  if (looksSensitive(draft.content)) return 'proposed'
  return draft.confidence >= AUTO_APPROVE_CONFIDENCE ? 'approved' : 'proposed'
}

/** Resolve the concrete scope + scopeId a draft's chosen scope maps to for this thread. */
export function resolveScope(
  scope: LearnScope,
  meta: ThreadMeta
): { scope: MemoryScope; scopeId?: string } {
  switch (scope) {
    case 'workspace':
      return { scope: 'workspace', scopeId: meta.workspaceId }
    case 'thread':
      return { scope: 'thread', scopeId: meta.id }
    default:
      return { scope: 'user' }
  }
}

type PushFn = (event: PushEvent) => void

export interface DistillDeps {
  meta: ThreadMeta
  model: string
  effort: string | undefined
  messages: ChatMessage[]
  provider: ProviderConfig | null
  push: PushFn
}

/**
 * Run the self-learning pass for a completed run. Returns the number of learnings stored (0 on any
 * best-effort short-circuit). Never throws. When anything was stored, pushes `memory.updated` and
 * reconciles the memory bridge so fresh approved learnings reach Claude Code and Hermes.
 */
export async function distillMemories(deps: DistillDeps): Promise<number> {
  const { meta, model, effort, messages, provider, push } = deps
  const settings = getSettings()
  if (!settings.selfLearning || !provider) return 0

  const hasUser = messages.some((m) => m.role === 'user' && m.text.trim())
  const hasAssistant = messages.some((m) => m.role === 'assistant' && m.text.trim())
  if (!hasUser || !hasAssistant) return 0

  const transcript = buildTranscript(messages)
  if (transcript.length < 40) return 0

  const wire: WireMessage[] = [{ role: 'user', content: buildLearnPrompt(transcript) }]
  let out = ''
  try {
    for await (const chunk of streamChat(provider, {
      model,
      messages: wire,
      tools: [],
      effort,
      cache: false,
      signal: AbortSignal.timeout(20000)
    })) {
      if (chunk.type === 'text') out += chunk.text
      if (out.length > 8000) break
    }
  } catch {
    return 0
  }

  const parsed = parseLearnings(out)
  if (parsed.length === 0) return 0
  const fresh = dedupeLearnings(parsed, listMemory()).slice(0, MAX_LEARNINGS_PER_RUN)
  if (fresh.length === 0) return 0

  let stored = 0
  for (const d of fresh) {
    const { scope, scopeId } = resolveScope(d.scope, meta)
    upsertMemory({
      content: d.content,
      type: d.type,
      scope,
      scopeId,
      author: 'model',
      confidence: d.confidence,
      status: statusFor(d, settings.selfLearningAutoApprove)
    })
    stored += 1
  }

  push({ kind: 'memory.updated' })
  // Propagate freshly approved learnings outward. Best-effort — the bridge itself never throws, but
  // guard anyway so a self-learning success is never undone by a sync hiccup.
  try {
    const workspace = listWorkspaces().find((w) => w.id === meta.workspaceId)
    if (workspace) runMemorySync(workspace)
  } catch {
    /* bridge is a convenience; a failed export doesn't undo what we learned */
  }
  return stored
}
