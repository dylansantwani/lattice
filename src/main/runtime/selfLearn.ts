import type { ChatMessage, MemoryItem, MemoryScope, MemoryType, ThreadMeta, TurnTelemetry } from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import {
  getDistillMark,
  getSettings,
  listMemory,
  listWorkspaces,
  searchMemoryFts,
  setDistillMark,
  upsertMemory
} from '../store/eventStore'
import { streamChat, type WireMessage } from '../providers/openaiCompat'
import type { ProviderConfig } from '@shared/types'
import { scheduleMemoryExport } from '../memory/bridge'
import { isImported } from '../memory/bridge'
import { addsInformation, contentTokens, digest, isNearDuplicate, type Digest } from '../memory/similarity'
import { utilityRoute } from './utilityModel'
import { extractDeterministic } from './selfLearnRules'
export { utilityRoute } from './utilityModel'

/**
 * Self-learning: after a run completes, read the just-finished exchange and distill 0–N durable,
 * reusable memories (preferences, stable facts, decisions, environment notes, warnings) that would
 * help on a future, unrelated turn. High-confidence, non-sensitive learnings are stored `approved`
 * (so they inject into the prompt and, once reviewed or aged, export to Claude Code + Hermes through
 * the memory bridge); everything else is stored `proposed` for the user to review in the Memory tab.
 *
 * Cost discipline: the pass is INCREMENTAL (a per-thread watermark means each message is distilled
 * once, not re-sent on every later turn), GATED (a "thanks" turn never pays a model call), routed to
 * the user's utility model when one is configured, and METERED (its tokens are reported back to the
 * run as a tagged usage event). Write discipline: drafts are compared to the store by token-set
 * similarity, and a refinement of a known fact revises that row in place instead of sitting beside
 * it. The whole pass is best-effort — a missing provider, a refusal, or malformed model output
 * distills nothing rather than throwing into the run.
 */

/** Hard cap on how many learnings we accept from one run, so a chatty model can't flood the store. */
export const MAX_LEARNINGS_PER_RUN = 6
/** Confidence at/above which a non-sensitive learning is auto-approved (when the setting allows). */
export const AUTO_APPROVE_CONFIDENCE = 0.75
/** Per-learning content cap — a durable memory is a sentence or two, not an essay. */
const MAX_CONTENT_CHARS = 600
/** Transcript budget handed to the reflection model, oldest turns dropped first. */
const MAX_TRANSCRIPT_CHARS = 12000
/** Below this much NEW conversation since the last pass there is nothing worth a model call. */
export const MIN_NEW_TRANSCRIPT_CHARS = 200
/** Budget for the "already known" list shown to the distiller so it refines instead of repeating. */
const KNOWN_CONTEXT_MAX_CHARS = 1800
const KNOWN_CONTEXT_MAX_ITEMS = 12
/** Default horizons for observation-shaped types when the model proposes none. Use defers expiry
 *  (see sweepMemory's grace window), so a note that keeps getting recalled never lapses. */
export const DEFAULT_TTL_DAYS: Partial<Record<MemoryType, number>> = { note: 120, warning: 180 }
const MAX_TTL_DAYS = 365
const DAY_MS = 24 * 3600_000

const MEMORY_TYPES: readonly MemoryType[] = [
  'preference',
  'fact',
  'decision',
  'environment',
  'warning',
  'note',
  'workflow'
]
/** Scopes the model may choose from; we resolve the concrete scopeId ourselves. */
const LEARN_SCOPES = ['user', 'workspace', 'thread'] as const
type LearnScope = (typeof LEARN_SCOPES)[number]

export interface LearnDraft {
  content: string
  type: MemoryType
  scope: LearnScope
  confidence: number
  /** id of an existing memory this draft refines (the model saw it in the "already known" list) */
  replaces?: string
  /** days until the fact should lapse; null/undefined = durable (or the type default) */
  ttlDays?: number | null
}

/** One existing memory shown to the distiller as context. */
export interface KnownMemory {
  id: string
  content: string
}

/** The reflection instruction. Kept strict about durability, subject, and output shape. */
export function buildLearnPrompt(transcript: string, known: KnownMemory[] = [], focus?: string): string {
  const knownBlock = known.length
    ? '--- ALREADY KNOWN (do not repeat these; to refine or correct one, return it with "replaces" set to its id) ---\n' +
      known.map((k) => `[${k.id}] ${k.content}`).join('\n') +
      '\n\n'
    : ''
  return (
    'You are the memory-distillation pass for an AI assistant. Read the conversation below and ' +
    'extract only durable, reusable facts worth remembering for a FUTURE, unrelated conversation — ' +
    'the kind of thing a thoughtful colleague would jot down about how this person works.\n\n' +
    'Save things like: stable preferences ("prefers tabs over spaces", "wants terse answers"), ' +
    'durable facts about the user or their projects, decisions with lasting effect, environment/setup ' +
    'notes, warnings/gotchas that will recur, and — the most valuable kind — WORKFLOWS: the reusable ' +
    'how-to this conversation actually worked out (the commands, the order, the flags/paths/ports, and ' +
    'the one thing that goes wrong). If the exchange established HOW to do something that will be needed ' +
    'again, capture the procedure even when no single sentence of it is a "fact".\n\n' +
    'Do NOT save: the task itself or its one-off details, transient state (counts, statuses, what is ' +
    'currently open or running), restatements of the question, anything already obvious, anything in ' +
    'the ALREADY KNOWN list, or secrets/credentials/tokens/keys. When in doubt, leave it out — most ' +
    'conversations yield nothing worth saving, and returning an empty list is the correct, common answer.\n\n' +
    'Reply with ONLY a JSON array (no prose, no code fence). Each element:\n' +
    '  {"content": string, "type": "preference|fact|decision|environment|warning|note|workflow", ' +
    '"scope": "user|workspace|thread", "confidence": number 0..1, "ttlDays": number|null, ' +
    '"replaces": string|null}\n' +
    'Write each "content" as a standalone durable statement that makes sense with no other context. ' +
    'Always write about the person in the third person as "The user …" (never their name, never ' +
    '"you"). Use "user" scope for facts about the person that travel everywhere, "workspace" for things ' +
    'specific to the current project, "thread" only for this conversation. Set "ttlDays" (7–90) only ' +
    'for a fact that describes a current state and will go stale; null for anything durable. Set ' +
    '"replaces" to the id of an ALREADY KNOWN item when your statement is a more precise or corrected ' +
    'version of it. Return [] if nothing qualifies.\n\n' +
    'For a "workflow", write the trigger, then the ordered steps with the exact commands/flags/paths, ' +
    'then the gotcha that would otherwise cost time to rediscover. Keep it under 600 characters, and ' +
    'never include secrets.\n\n' +
    (focus?.trim() ? `${focus.trim()}\n\n` : '') +
    knownBlock +
    '--- CONVERSATION ---\n' +
    transcript
  )
}

/** Build a compact user/assistant transcript from a thread's messages, newest-biased to a budget. */
export function buildTranscript(messages: ChatMessage[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const turns = messages
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && !m.compacted && (m.text.trim() || m.toolExchanges?.length))
    .map((m) => {
      if (m.role === 'user') return `User: ${m.text.trim()}`
      // The commands the turn actually ran — the workflow rule needs the real sequence, not only
      // commands the assistant happened to quote in prose.
      const ran = commandsRun(m)
      const body = [ran ? `Ran:\n${ran}` : '', m.text.trim()].filter(Boolean).join('\n')
      return `Assistant: ${body}`
    })
  let transcript = turns.join('\n\n')
  // Keep the most recent turns if we're over budget — the tail is where fresh, durable signal lives.
  while (transcript.length > maxChars && turns.length > 1) {
    turns.shift()
    transcript = turns.join('\n\n')
  }
  return transcript
}

/** Shell commands from a turn's tool exchanges, one per line (at most 8, each clipped). */
export function commandsRun(m: ChatMessage): string {
  const out: string[] = []
  for (const ex of m.toolExchanges ?? []) {
    for (const call of ex.tool_calls ?? []) {
      const name = call.function?.name
      if (name !== 'shell' && name !== 'start_job') continue
      try {
        const args = JSON.parse(call.function.arguments || '{}') as { command?: unknown; cmd?: unknown }
        const cmd = typeof args.command === 'string' ? args.command : typeof args.cmd === 'string' ? args.cmd : ''
        if (cmd.trim()) out.push(cmd.trim().length > 200 ? `${cmd.trim().slice(0, 199)}…` : cmd.trim())
      } catch {
        /* unparseable args carry no command */
      }
      if (out.length >= 8) return out.join('\n')
    }
  }
  return out.join('\n')
}

/**
 * The messages after the watermark `markId`. A mark that no longer resolves (the message was
 * deleted or the thread compacted) means the whole list — bounded by the transcript budget anyway.
 */
export function messagesSinceMark(messages: ChatMessage[], markId: string | null): ChatMessage[] {
  if (!markId) return messages
  const idx = messages.findIndex((m) => m.id === markId)
  return idx === -1 ? messages : messages.slice(idx + 1)
}

/**
 * Cheap pre-flight: is there anything in the new span worth a model call? Requires a message the
 * human actually typed (not a subagent completion, background-job report, or inter-session
 * message), an assistant reply, and enough new text to plausibly contain a durable fact.
 */
export function hasLearnSignal(
  newMessages: ChatMessage[],
  transcript: string,
  opts: { acceptSessionOrigin?: boolean } = {}
): boolean {
  // A fleet worker's task arrives from its orchestrator (origin.kind 'session'); that is real work
  // worth learning from, so an agent thread counts those as the human's turn.
  const human = newMessages.filter(
    (m) =>
      m.role === 'user' &&
      (!m.origin || (opts.acceptSessionOrigin && m.origin.kind === 'session')) &&
      !m.compacted &&
      m.text.trim()
  )
  const answered = newMessages.some((m) => m.role === 'assistant' && !m.compacted && m.text.trim())
  if (human.length === 0 || !answered) return false
  // An explicit cue ("remember that…", "from now on…", "I always…") is signal at any length —
  // the person is literally asking for a memory, so a short turn must not be gated out.
  if (human.some((m) => EXPLICIT_MEMORY_CUE.test(m.text))) return true
  return transcript.length >= MIN_NEW_TRANSCRIPT_CHARS
}

/** Phrases that mark a turn as a deliberate instruction about how to work with the user. */
export const EXPLICIT_MEMORY_CUE =
  /\b(remember|don't forget|note that|for future reference|from now on|going forward|in (?:the )?future|i (?:always|never|prefer|usually|don't like|hate|love|want you to)|my (?:preference|rule) is|stop (?:doing|using)|never (?:do|use|run))\b/i

/** The most frequent identity tokens of a transcript, for pulling related known memories. */
export function transcriptKeywords(transcript: string, max = 24): string[] {
  const counts = new Map<string, number>()
  for (const t of transcript.toLowerCase().split(/[^a-z0-9]+/)) {
    if (t.length < 3) continue
    counts.set(t, (counts.get(t) ?? 0) + 1)
  }
  const identity = contentTokens(transcript)
  return [...counts.entries()]
    .filter(([t]) => identity.has(t))
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([t]) => t)
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

function coerceTtl(raw: unknown): number | null | undefined {
  if (raw === null) return null
  if (raw === undefined || raw === '') return undefined
  const n = typeof raw === 'number' ? raw : Number(raw)
  if (!Number.isFinite(n) || n <= 0) return undefined
  return Math.min(MAX_TTL_DAYS, Math.max(1, Math.round(n)))
}

/**
 * Parse the reflection model's output into validated drafts. Tolerant of a stray code fence or a
 * line of preamble: we extract the first top-level JSON array and validate each element. Anything
 * malformed yields an empty list rather than throwing.
 */
export function parseLearnings(raw: string): LearnDraft[] {
  return parseLearningsResult(raw).drafts
}

/**
 * Like {@link parseLearnings}, but also says whether the output was a well-formed JSON array at
 * all. The distiller advances its watermark only on a well-formed reply: a garbled one (a small
 * utility model rambling, a truncated stream) must not consume the span it failed to read.
 */
export function parseLearningsResult(raw: string): { wellFormed: boolean; drafts: LearnDraft[] } {
  if (!raw) return { wellFormed: false, drafts: [] }
  // Strip a leading ```json / ``` fence if the model wrapped its answer despite instructions.
  let text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim()
  // Fall back to the first '[' … last ']' span so a line of prose before the array still parses.
  if (!text.startsWith('[')) {
    const start = text.indexOf('[')
    const end = text.lastIndexOf(']')
    if (start === -1 || end === -1 || end < start) return { wellFormed: false, drafts: [] }
    text = text.slice(start, end + 1)
  }
  let arr: unknown
  try {
    arr = JSON.parse(text)
  } catch {
    return { wellFormed: false, drafts: [] }
  }
  if (!Array.isArray(arr)) return { wellFormed: false, drafts: [] }
  const out: LearnDraft[] = []
  for (const el of arr) {
    if (!el || typeof el !== 'object') continue
    const rec = el as Record<string, unknown>
    const content = typeof rec.content === 'string' ? rec.content.trim() : ''
    if (!content) continue
    const replaces = typeof rec.replaces === 'string' && rec.replaces.trim() ? rec.replaces.trim() : undefined
    const ttlDays = coerceTtl(rec.ttlDays)
    out.push({
      content: content.length > MAX_CONTENT_CHARS ? content.slice(0, MAX_CONTENT_CHARS).trim() : content,
      type: coerceType(rec.type),
      scope: coerceScope(rec.scope),
      confidence: coerceConfidence(rec.confidence),
      ...(replaces ? { replaces } : {}),
      ...(ttlDays !== undefined ? { ttlDays } : {})
    })
  }
  return { wellFormed: true, drafts: out }
}

/** Normalize memory text for similarity comparison: lowercase, strip punctuation, collapse spaces. */
export function normalizeForDedup(s: string): string {
  return digest(s).norm
}

/** The subset of a stored memory the write-side planner needs. */
export type ExistingMemory = Pick<MemoryItem, 'id' | 'content'> & Partial<Pick<MemoryItem, 'author' | 'status'>>

/** What to do with one accepted draft: insert it, or revise the row it refines. */
export interface LearnPlan {
  draft: LearnDraft
  /** revise this existing row in place (its version bumps) instead of inserting */
  replaces?: ExistingMemory
}

/**
 * Decide, for each draft, whether it is new, a refinement of a stored memory, or already known.
 * Similarity is token-set Jaccard with a containment fast path (see memory/similarity.ts), so a
 * rewording — "User's macOS username is dylan" vs "The user's username on macOS is dylan" — is
 * recognized without a verbatim substring, and an 8 KB imported instructions file can no longer
 * swallow a one-line learning whose words happen to appear inside it.
 *
 *  - near-duplicate of an imported or rejected item → dropped (known, or explicitly unwanted);
 *  - near-duplicate of a Lattice-authored item that says anything new — a refinement that adds a
 *    detail OR a correction that swaps one ("cloud mode" → "LAN mode") → revise in place; the
 *    newest statement from a live conversation is the current one;
 *  - near-duplicate whose tokens are all already in the stored row → dropped;
 *  - an explicit `replaces` naming a Lattice-authored row → revise that row;
 *  - otherwise → insert. In-batch near-duplicates keep the highest-confidence draft.
 */
export function planLearnings(drafts: LearnDraft[], existing: ExistingMemory[]): LearnPlan[] {
  const known = existing
    .map((m) => ({ m, d: digest(m.content) }))
    .filter((k) => k.d.norm.length > 0)
  const byId = new Map(existing.map((m) => [m.id, m]))
  const revisable = (m: ExistingMemory): boolean =>
    m.author !== 'import' && !m.id.startsWith('mem:') && m.status !== 'rejected'

  const plans: LearnPlan[] = []
  const keptDigests: Digest[] = []
  const claimed = new Set<string>()
  for (const d of [...drafts].sort((a, b) => b.confidence - a.confidence)) {
    const dd = digest(d.content)
    if (!dd.norm) continue
    if (keptDigests.some((k) => isNearDuplicate(k, dd))) continue

    // The model named the row it is refining: honor it when that row is ours and not yet claimed.
    const named = d.replaces ? byId.get(d.replaces) : undefined
    if (named && revisable(named) && !claimed.has(named.id)) {
      plans.push({ draft: d, replaces: named })
      claimed.add(named.id)
      keptDigests.push(dd)
      continue
    }

    let best: { m: ExistingMemory; d: Digest } | undefined
    for (const k of known) {
      if (!isNearDuplicate(k.d, dd)) continue
      if (!best || k.d.tokens.size > best.d.tokens.size) best = k
    }
    if (best) {
      if (!revisable(best.m) || claimed.has(best.m.id)) continue
      if (!addsInformation(dd, best.d)) continue
      plans.push({ draft: d, replaces: best.m })
      claimed.add(best.m.id)
      keptDigests.push(dd)
      continue
    }
    plans.push({ draft: d })
    keptDigests.push(dd)
  }
  return plans
}

/**
 * Drop drafts that duplicate an existing memory or an earlier draft in the same batch; the drafts
 * that survive are the ones {@link planLearnings} would insert OR revise. Kept as the simple
 * "what is new here?" view for callers that do not supersede.
 */
export function dedupeLearnings(drafts: LearnDraft[], existing: { content: string; id?: string }[]): LearnDraft[] {
  return planLearnings(
    drafts,
    existing.map((m, i) => ({ id: m.id ?? `existing-${i}`, content: m.content, author: 'import' }))
  ).map((p) => p.draft)
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
export function statusFor(draft: Pick<LearnDraft, 'content' | 'confidence'>, autoApprove: boolean): 'approved' | 'proposed' {
  if (!autoApprove) return 'proposed'
  if (looksSensitive(draft.content)) return 'proposed'
  // Auto-approve ON means add it now. The old `confidence >= AUTO_APPROVE_CONFIDENCE` gate
  // parked every sub-0.75 distillation in 'proposed' indefinitely — 149 rows awaiting a
  // review that never happens, since the distiller's typical confidence is 0.6-0.7.
  // Sensitivity is the only guard left; confidence is still stored on the row, and the
  // Memory tab still allows reject/expire/pin after the fact.
  return 'approved'
}

/** The expiry timestamp for a draft: the model's ttl, else the type default, else durable. */
export function expiryFor(draft: Pick<LearnDraft, 'type' | 'ttlDays'>, now = Date.now()): number | undefined {
  if (draft.ttlDays === null) return undefined
  const days = draft.ttlDays ?? DEFAULT_TTL_DAYS[draft.type]
  return days ? now + days * DAY_MS : undefined
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

/**
 * Persist one planned learning. A revision keeps the row's id/createdAt/pinned/review state (the
 * fact is the same, now more precise), bumps its version, and stays approved if it was; an
 * approved-or-proposed draft never demotes an approved row. Exported for the memory_save tool,
 * which goes through the same gate.
 */
export function storeLearning(
  plan: LearnPlan,
  meta: ThreadMeta,
  autoApprove: boolean,
  now = Date.now()
): MemoryItem {
  const { draft, replaces } = plan
  const { scope, scopeId } = resolveScope(draft.scope, meta)
  const status = statusFor(draft, autoApprove)
  const sensitive = looksSensitive(draft.content)
  if (replaces) {
    const keepApproved = replaces.status === 'approved' && !sensitive
    return upsertMemory({
      id: replaces.id,
      content: draft.content,
      type: draft.type,
      scope,
      scopeId,
      confidence: draft.confidence,
      sensitivity: sensitive ? 'sensitive' : 'normal',
      status: keepApproved ? 'approved' : status,
      // A revived expired row gets a fresh horizon; a durable draft clears the old one.
      expiresAt: expiryFor(draft, now) ?? null
    })
  }
  return upsertMemory({
    content: draft.content,
    type: draft.type,
    scope,
    scopeId,
    author: 'model',
    confidence: draft.confidence,
    sensitivity: sensitive ? 'sensitive' : 'normal',
    status,
    expiresAt: expiryFor(draft, now)
  })
}

type PushFn = (event: PushEvent) => void

export interface DistillDeps {
  meta: ThreadMeta
  model: string
  effort: string | undefined
  messages: ChatMessage[]
  provider: ProviderConfig | null
  push: PushFn
  /** Resolve the provider for the utility model (runManager's resolveProvider). */
  resolveProvider?: (model: string) => ProviderConfig | null
  /** Receives the pass's provider-reported usage so the run can account for it. */
  onUsage?: (usage: TurnTelemetry) => void
  /** Test seam: the streaming call to use instead of the real provider client. */
  stream?: typeof streamChat
}

export interface DistillOutcome {
  /** learnings inserted or revised */
  stored: number
  /** why nothing ran, when nothing ran */
  skipped?: 'off' | 'no-provider' | 'no-signal' | 'no-candidates' | 'model-error'
  model?: string
}

/**
 * Run the self-learning pass for a completed run. Never throws. When anything was stored, pushes
 * `memory.updated` and schedules a bridge export so approved learnings reach Claude Code and Hermes.
 */
export async function distillMemories(deps: DistillDeps): Promise<DistillOutcome> {
  const { meta, messages, push } = deps
  const settings = getSettings()
  if (!settings.selfLearning) return { stored: 0, skipped: 'off' }
  // Incremental: only what the last pass has not seen. The mark advances once a span has been
  // judged, so a span is never scanned twice, and a too-short span rides along with the next turn.
  const fresh = messagesSinceMark(messages, getDistillMark(meta.id))
  const transcript = buildTranscript(fresh)
  if (!hasLearnSignal(fresh, transcript, { acceptSessionOrigin: !!meta.isAgent })) return { stored: 0, skipped: 'no-signal' }
  const lastId = messages.at(-1)?.id

  // Deterministic extraction: rules, not a model call, so self-learning costs nothing per run. It
  // catches explicit remember-this statements and standing preferences, decisions, durable
  // environment facts (path / port / host / version), gotchas, and any real command sequence the
  // run carried out (a workflow). Precision over recall on purpose — a wrong memory costs
  // attention every turn it is injected, and this pass no longer pays a call to find nothing.
  let drafts: LearnDraft[] = extractDeterministic(transcript).map(
    (d) => ({ content: d.content, type: d.type, scope: d.scope, confidence: d.confidence }) as LearnDraft
  )
  if (lastId) setDistillMark(meta.id, lastId)
  let modelUsed: string | undefined
  if (drafts.length === 0) {
    // The rules saw nothing durable in a substantial exchange. That is exactly where a
    // conversation's real conclusions ("we're moving X to Y because Z") hide, phrased in a way no
    // regex anticipates — so spend ONE small utility-model call, throttled per thread.
    const extracted = await modelExtractionFallback({ ...deps, transcript })
    if (extracted.skipped) return { stored: 0, skipped: extracted.skipped }
    drafts = extracted.drafts
    modelUsed = extracted.model
    if (drafts.length === 0) return { stored: 0, skipped: 'no-candidates', model: modelUsed }
  }

  const plans = planLearnings(drafts, listMemory()).slice(0, MAX_LEARNINGS_PER_RUN)
  if (plans.length === 0) return { stored: 0 }

  let stored = 0
  for (const plan of plans) {
    storeLearning(plan, meta, settings.selfLearningAutoApprove)
    stored += 1
  }

  push({ kind: 'memory.updated' })
  // Propagate freshly approved learnings outward, coalesced with any other pending write.
  try {
    const workspace = listWorkspaces().find((w) => w.id === meta.workspaceId)
    if (workspace) scheduleMemoryExport(workspace)
  } catch {
    /* bridge is a convenience; a failed export doesn't undo what we learned */
  }
  return { stored, ...(modelUsed ? { model: modelUsed } : {}) }
}

/** A run's span must be at least this long before the model fallback is worth a call. */
export const MODEL_EXTRACTION_MIN_CHARS = 1500
/** At most one model extraction per thread per this interval. */
export const MODEL_EXTRACTION_THROTTLE_MS = 10 * 60_000
const lastModelExtraction = new Map<string, number>()

/** Reset the per-thread throttle (tests). */
export function resetModelExtractionThrottle(): void {
  lastModelExtraction.clear()
}

/**
 * One utility-model extraction over a run's new span, used only when the deterministic rules found
 * nothing (see distillMemories). Gated by `selfLearningModelExtraction`, a minimum span length and
 * a per-thread throttle, so it costs at most a small call every few minutes on an active thread.
 */
async function modelExtractionFallback(
  deps: DistillDeps & { transcript: string; now?: number }
): Promise<{ drafts: LearnDraft[]; model?: string; skipped?: DistillOutcome['skipped'] }> {
  const settings = getSettings()
  if (settings.selfLearningModelExtraction === false) return { drafts: [], skipped: 'no-candidates' }
  if (deps.transcript.length < MODEL_EXTRACTION_MIN_CHARS) return { drafts: [], skipped: 'no-candidates' }
  const now = deps.now ?? Date.now()
  const last = lastModelExtraction.get(deps.meta.id) ?? 0
  if (now - last < MODEL_EXTRACTION_THROTTLE_MS) return { drafts: [], skipped: 'no-candidates' }
  const route = utilityRoute(deps.model, deps.provider, deps.effort, deps.resolveProvider, settings.utilityModel)
  if (!route.provider) return { drafts: [], skipped: 'no-provider' }
  lastModelExtraction.set(deps.meta.id, now)
  const prompt = buildLearnPrompt(deps.transcript, relatedKnownMemories(deps.transcript))
  let raw = ''
  try {
    for await (const chunk of (deps.stream ?? streamChat)(route.provider, {
      model: route.model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      effort: 'low',
      cache: false,
      signal: AbortSignal.timeout(90_000)
    })) {
      if (chunk.type === 'text') raw += chunk.text
      else if (chunk.type === 'usage') deps.onUsage?.({ ...chunk.usage, purpose: 'distill', route: route.model } as TurnTelemetry)
    }
  } catch {
    return { drafts: [], model: route.model, skipped: 'model-error' }
  }
  const parsed = parseLearningsResult(raw)
  if (!parsed.wellFormed) return { drafts: [], model: route.model, skipped: 'model-error' }
  return { drafts: parsed.drafts, model: route.model }
}

/**
 * The stored, Lattice-authored memories most related to a transcript (by full-text rank), trimmed
 * to a small budget, for the distiller's "already known" list. Imports are excluded: they are
 * external files the model cannot revise. Best-effort — an FTS hiccup means an empty list.
 */
export function relatedKnownMemories(transcript: string): KnownMemory[] {
  let candidates: MemoryItem[]
  try {
    candidates = searchMemoryFts(transcriptKeywords(transcript), { statuses: ['approved', 'proposed'], limit: 40 })
  } catch {
    return []
  }
  const out: KnownMemory[] = []
  let chars = 0
  for (const m of candidates) {
    if (isImported(m)) continue
    const content = m.content.replace(/\s+/g, ' ').trim()
    if (chars + content.length > KNOWN_CONTEXT_MAX_CHARS) continue
    out.push({ id: m.id, content })
    chars += content.length
    if (out.length >= KNOWN_CONTEXT_MAX_ITEMS) break
  }
  return out
}

/** Most learnings accepted from one rolled-off span (a whole stretch of conversation, not one turn). */
export const MAX_LEARNINGS_PER_SPAN = 12

export interface SpanDistillDeps {
  meta: ThreadMeta
  transcript: string
  /** Extra guidance for what matters in this kind of conversation. */
  focus?: string
  model: string
  provider: ProviderConfig
  push: PushFn
  onUsage?: (usage: Partial<TurnTelemetry>) => void
  /** Test seam. */
  stream?: typeof streamChat
  timeoutMs?: number
}

/**
 * Model-based distillation of one span of conversation that is leaving the context window (see
 * rollingContext). The per-turn pass is rule-based to cost nothing; a span that is about to exist
 * only as a summary is worth one real extraction call, so the facts in it stay findable by recall.
 * Throws on a provider failure or unparseable output (the caller treats that as "no memories").
 */
export async function distillSpan(deps: SpanDistillDeps): Promise<number> {
  const settings = getSettings()
  if (!settings.selfLearning) return 0
  const prompt = buildLearnPrompt(deps.transcript, relatedKnownMemories(deps.transcript), deps.focus)
  let raw = ''
  for await (const chunk of (deps.stream ?? streamChat)(deps.provider, {
    model: deps.model,
    messages: [{ role: 'user', content: prompt }],
    tools: [],
    effort: 'low',
    cache: false,
    signal: AbortSignal.timeout(deps.timeoutMs ?? 120_000)
  })) {
    if (chunk.type === 'text') raw += chunk.text
    else if (chunk.type === 'usage') deps.onUsage?.(chunk.usage)
  }
  const parsed = parseLearningsResult(raw)
  if (!parsed.wellFormed) throw new Error('memory extraction returned no JSON array')
  const plans = planLearnings(parsed.drafts, listMemory()).slice(0, MAX_LEARNINGS_PER_SPAN)
  for (const plan of plans) storeLearning(plan, deps.meta, settings.selfLearningAutoApprove)
  if (plans.length === 0) return 0
  deps.push({ kind: 'memory.updated' })
  try {
    const workspace = listWorkspaces().find((w) => w.id === deps.meta.workspaceId)
    if (workspace) scheduleMemoryExport(workspace)
  } catch {
    /* the bridge is a convenience */
  }
  return plans.length
}
