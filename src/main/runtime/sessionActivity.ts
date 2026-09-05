import type { PushEvent } from '@shared/ipc'
import type {
  ActivityMessage,
  ActivityToolCall,
  ChatMessage,
  RunEvent,
  SessionActivity,
  SessionActivitySummary,
  SessionStatus,
  ThreadId,
  ThreadMeta
} from '@shared/types'
import { getSettings, getThreadMeta, listRecentEvents, listRecentMessages, listThreads } from '../store/eventStore'
import { listPendingApprovals } from './approvals'
import { listPendingAsks } from './asks'
import { unreadCount } from './sessionMessaging'

/**
 * The cross-session live activity view (Slice 9).
 *
 * `list_sessions` and point-to-point messages told you a session EXISTS. This module tells you what
 * it is DOING: its status, the one line of "working on X" that matters, its recent transcript and
 * tool calls, and anything it is parked on waiting for a human. Read-only in every direction — there
 * is no write path here at all — and served both to the user's activity panel and, through
 * `peek_session`, to an agent coordinating with another session.
 *
 * ## Privacy boundaries
 * These are enforced here, in the one place snapshots are built, rather than trusted to callers:
 *
 *  1. **Reasoning never leaves its session.** `reasoning.delta` / `reasoning.done` events are not
 *     read at all — an observer cannot see another model's hidden thinking, in any status, ever.
 *  2. **Secrets are redacted** from every string that leaves: message text, tool summaries, approval
 *     summaries, questions ({@link redactSecrets}).
 *  3. **Tool arguments are summarized, never dumped.** An observer sees `shell · npm test`, not the
 *     full argument object, which is where paths, tokens and payloads live.
 *  4. **Bodies are truncated.** This is a status view, not an exfiltration channel for a transcript.
 *  5. **A thread can be marked private** ({@link ThreadMeta.isPrivate}); another *session* then gets
 *     status only. The user's own windows always see their own threads — every session here belongs
 *     to one person, so hiding a thread from its owner's activity panel would be theater, while
 *     hiding it from an agent that might quote it into another context is a real boundary.
 *  6. **The agent lane has a global off switch** (`settings.sessionObservation: 'deny'`).
 *
 * Like {@link sessionMessaging} this is a leaf module: it reads the store and the two brokers, and
 * takes its couplings to the run manager ("is this running?", "how many subagents?") as callbacks,
 * so the dependency graph stays acyclic.
 */

type PushFn = (event: PushEvent) => void

interface Deps {
  push: PushFn
  /** True when the thread has live work: a model turn, a detached subagent, or a pending job. */
  isRunning: (threadId: ThreadId) => boolean
  /** How many background subagents are still running on the thread. */
  runningAgents: (threadId: ThreadId) => number
  /** How many background shell jobs are still running on the thread. */
  runningJobs: (threadId: ThreadId) => number
}

let deps: Deps | null = null

/** How many recent turns / tool calls a snapshot carries. */
export const ACTIVITY_MESSAGES = 12
export const ACTIVITY_TOOLS = 12
/** How many raw events we scan back through to build one snapshot. */
const EVENT_WINDOW = 300
/** Per-message ceiling in an activity snapshot: enough to follow along, not a transcript export. */
export const ACTIVITY_TEXT_CAP = 600
/** Live pushes for one thread are coalesced onto this interval — a streaming run emits constantly. */
export const ACTIVITY_PUSH_MS = 400

export function configureSessionActivity(d: Deps): void {
  deps = d
}

/** Reset wiring and watches (tests). */
export function resetSessionActivity(): void {
  deps = null
  watched.clear()
  for (const timer of pending.values()) clearTimeout(timer)
  pending.clear()
}

// ---------- redaction ----------

/**
 * Patterns for things that must never cross a session boundary, in rough order of specificity.
 * Deliberately conservative: each one matches a shape that is only ever a credential, so ordinary
 * prose and code survive intact. (An over-eager redactor makes the view useless, which is its own
 * failure — an observer that cannot read anything just goes and opens the thread instead.)
 */
const SECRET_PATTERNS: { re: RegExp; replace: string }[] = [
  // Bearer/Basic auth headers, with or without quotes.
  { re: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}/gi, replace: '$1 [redacted]' },
  // Vendor-shaped keys: OpenAI/Anthropic sk-, GitHub gh*_, Slack xox*-, Google AIza, AWS AKIA.
  { re: /\bsk-[A-Za-z0-9_-]{12,}/g, replace: '[redacted-key]' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{16,}/g, replace: '[redacted-key]' },
  { re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replace: '[redacted-key]' },
  { re: /\bAIza[A-Za-z0-9_-]{20,}/g, replace: '[redacted-key]' },
  { re: /\bAKIA[0-9A-Z]{16}\b/g, replace: '[redacted-key]' },
  // A quoted assignment: `password = "hunter2"`, `api_key: 'abc…'`. The value is always a literal.
  {
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|auth)\b(\s*[:=]\s*)(["'])[^"'\n]{4,}\3/gi,
    replace: '$1$2$3[redacted]$3'
  },
  // An unquoted assignment: `API_KEY=ab12cd34ef56`. Deliberately narrow — the value must look like a
  // literal (8+ chars of key alphabet) and must NOT be followed by `(` or a word character, so
  // `const password = getPassword()` and `token = readToken(x)` are left alone. Redacting live code
  // would make the activity view useless without protecting anything.
  {
    re: /\b(api[_-]?key|secret|token|password|passwd|pwd|access[_-]?key|auth)\b(\s*[:=]\s*)([A-Za-z0-9_\-./+=]{8,})(?![\w(])/gi,
    replace: '$1$2[redacted]'
  }
]

/** Strip credential-shaped substrings from text leaving a session. Idempotent and non-throwing. */
export function redactSecrets(text: string): string {
  let out = text
  for (const { re, replace } of SECRET_PATTERNS) out = out.replace(re, replace)
  return out
}

/** Redact, collapse, and clip a string for an activity snapshot. */
export function clean(text: string, cap = ACTIVITY_TEXT_CAP): { text: string; truncated?: boolean } {
  const redacted = redactSecrets(text ?? '').trim()
  if (redacted.length <= cap) return { text: redacted }
  return { text: `${redacted.slice(0, cap)}…`, truncated: true }
}

// ---------- status ----------

/** Compact "3s"/"12m"/"4h"/"2d" for how long ago something happened. */
export function ago(deltaMs: number): string {
  const s = Math.max(0, Math.round(deltaMs / 1000))
  if (s < 60) return `${s}s`
  const m = Math.round(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.round(m / 60)
  return h < 48 ? `${h}h` : `${Math.round(h / 24)}d`
}

/**
 * What a session's state is, from the things that can be true about it. Waiting on a human beats
 * "running" — a session parked on an approval nobody has answered is the one you actually want to
 * see in a list, even though its run is technically still live.
 */
export function deriveStatus(opts: {
  running: boolean
  awaitingApproval: boolean
  awaitingAsk: boolean
  lastError?: string
  isPrivate?: boolean
  hiddenFromObserver?: boolean
}): SessionStatus {
  if (opts.hiddenFromObserver) return 'private'
  if (opts.awaitingApproval) return 'waiting-approval'
  if (opts.awaitingAsk) return 'waiting-answer'
  if (opts.running) return 'running'
  if (opts.lastError) return 'error'
  return 'idle'
}

/** The short human status shown beside a session's name. */
export function statusText(status: SessionStatus, opts: { activity?: string; idleForMs?: number; lastError?: string }): string {
  switch (status) {
    case 'private':
      return 'private'
    case 'waiting-approval':
      return 'waiting on you — approval'
    case 'waiting-answer':
      return 'waiting on you — question'
    case 'running':
      return opts.activity ? `running · ${opts.activity}` : 'running'
    case 'error':
      return opts.lastError ? `failed · ${opts.lastError}` : 'failed'
    default:
      return typeof opts.idleForMs === 'number' ? `idle ${ago(opts.idleForMs)}` : 'idle'
  }
}

/**
 * One line describing what a session is doing right now, read backwards from its recent events:
 * the tool it is running, or that it is writing a reply, or the last thing it finished. Returns
 * undefined when there is nothing worth saying.
 */
export function summarizeActivity(events: RunEvent[]): string | undefined {
  const started = new Map<string, string>()
  const finished = new Set<string>()
  let writing = false
  for (const e of events) {
    const b = e.body
    if (b.type === 'tool.started') started.set(b.callId, b.tool)
    else if (b.type === 'tool.result' || b.type === 'tool.denied') finished.add(b.callId)
    else if (b.type === 'text.delta') writing = true
    else if (b.type === 'run.started') {
      // A new run supersedes anything the previous one was doing.
      started.clear()
      finished.clear()
      writing = false
    } else if (b.type === 'run.completed') {
      started.clear()
      writing = false
    }
  }
  const live = [...started.entries()].filter(([callId]) => !finished.has(callId)).map(([, tool]) => tool)
  if (live.length === 1) return live[0]
  if (live.length > 1) return `${live.length} tools`
  if (writing) return 'writing a reply'
  return undefined
}

/** The most recent error message on a thread, when its last run ended badly. */
function lastErrorOf(events: RunEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const b = events[i]!.body
    if (b.type === 'run.started' || b.type === 'run.completed') {
      // Only report an error from the run that is (or was) most recent; older failures are history.
      if (b.type === 'run.completed' && b.reason === 'error') continue
      return undefined
    }
    if (b.type === 'error') return clean(b.message, 120).text
  }
  return undefined
}

// ---------- snapshots ----------

/**
 * The tool calls in a window of events, newest last, each with its own status. Arguments are never
 * included: the tool's `summarize()` output is captured on the `tool.proposed` event, and that
 * one-line description is what an observer gets.
 */
export function toolCallsFrom(events: RunEvent[], limit = ACTIVITY_TOOLS): ActivityToolCall[] {
  const calls = new Map<string, ActivityToolCall>()
  for (const e of events) {
    const b = e.body
    if (b.type === 'tool.started') {
      calls.set(b.callId, {
        callId: b.callId,
        tool: b.tool,
        status: 'running',
        startedAt: e.ts,
        ...(e.agent ? { agent: e.agent } : {})
      })
    } else if (b.type === 'tool.result') {
      const call = calls.get(b.callId)
      if (call) {
        call.status = b.ok ? 'ok' : 'failed'
        call.durationMs = b.durationMs
      }
    } else if (b.type === 'tool.denied') {
      const call = calls.get(b.callId)
      if (call) {
        call.status = 'denied'
        call.summary = b.reason ? clean(b.reason, 120).text : call.summary
      }
    }
  }
  return [...calls.values()].slice(-limit)
}

/** The recent turns of a session, redacted and clipped. System (compaction) messages are skipped. */
function messagesFrom(messages: ChatMessage[]): ActivityMessage[] {
  return messages
    // A turn still streaming (or one that failed before writing anything) has no text yet; an empty
    // row in the observer's transcript is noise, not information.
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.text.trim())
    .map((m) => {
      const { text, truncated } = clean(m.text)
      return {
        id: m.id,
        role: m.role,
        createdAt: m.createdAt,
        text,
        ...(truncated ? { truncated } : {}),
        ...(m.origin ? { from: m.origin.label } : {})
      }
    })
}

/** May an observing SESSION (not the user's own window) see this thread's contents? */
export function observationAllowed(meta: ThreadMeta): { ok: true } | { ok: false; reason: string } {
  if (getSettings().sessionObservation === 'deny') {
    return { ok: false, reason: 'Session observation is turned off in settings.' }
  }
  if (meta.isPrivate) return { ok: false, reason: 'This session is marked private.' }
  return { ok: true }
}

interface SnapshotOptions {
  /**
   * Set when the snapshot is for another SESSION rather than the user's own window. Enforces the
   * private-thread and policy boundaries; the contents are redacted either way.
   */
  forObserver?: boolean
}

/** The directory row for one thread. */
function summarize(meta: ThreadMeta, events: RunEvent[], opts: SnapshotOptions): SessionActivitySummary {
  const running = deps?.isRunning(meta.id) ?? false
  const blocked = opts.forObserver ? observationAllowed(meta) : ({ ok: true } as const)
  const hidden = !blocked.ok
  const awaitingApproval = listPendingApprovals().some((a) => a.threadId === meta.id)
  const awaitingAsk = listPendingAsks().some((a) => a.threadId === meta.id)
  const lastError = hidden ? undefined : lastErrorOf(events)
  const status = deriveStatus({
    running,
    awaitingApproval,
    awaitingAsk,
    lastError,
    isPrivate: meta.isPrivate,
    hiddenFromObserver: hidden
  })
  // A private thread still reports whether it is busy — that is not a secret, and an agent needs it
  // to decide whether to wait — but never what it is busy WITH.
  const activity = hidden ? undefined : summarizeActivity(events)
  return {
    threadId: meta.id,
    title: hidden ? meta.title : meta.title,
    model: meta.model,
    mode: meta.mode,
    permissionPreset: meta.permissionPreset,
    status,
    statusText: hidden
      ? running
        ? 'private · running'
        : 'private'
      : statusText(status, { activity, idleForMs: Date.now() - meta.updatedAt, lastError }),
    ...(activity ? { activity } : {}),
    running,
    updatedAt: meta.updatedAt,
    unread: unreadCount(meta.id),
    agents: deps?.runningAgents(meta.id) ?? 0,
    jobs: deps?.runningJobs(meta.id) ?? 0,
    ...(meta.isPrivate ? { isPrivate: true } : {})
  }
}

/**
 * Every session's live state, most-recently-active first (the activity directory). `excludeThreadId`
 * drops the caller's own session.
 */
export function listSessionActivity(excludeThreadId?: ThreadId, opts: SnapshotOptions = {}): SessionActivitySummary[] {
  return listThreads(undefined, false)
    .filter((t) => t.id !== excludeThreadId)
    .map((t) => summarize(t, listRecentEvents(t.id, 60), opts))
}

/**
 * A full read-only window onto one session. Returns null when the thread does not exist; returns a
 * status-only snapshot with `withheld` set when an observing session may not see its contents.
 */
export function getSessionActivity(threadId: ThreadId, opts: SnapshotOptions = {}): SessionActivity | null {
  const meta = getThreadMeta(threadId)
  if (!meta) return null
  const blocked = opts.forObserver ? observationAllowed(meta) : ({ ok: true } as const)
  const events = blocked.ok ? listRecentEvents(threadId, EVENT_WINDOW) : []
  const summary = summarize(meta, events, opts)
  if (!blocked.ok) {
    return {
      ...summary,
      messages: [],
      tools: [],
      pending: { approvals: [], asks: [] },
      observedAt: Date.now(),
      withheld: blocked.reason
    }
  }
  return {
    ...summary,
    ...(meta.goal ? { goal: clean(meta.goal, 200).text } : {}),
    messages: messagesFrom(listRecentMessages(threadId, ACTIVITY_MESSAGES)),
    tools: toolCallsFrom(events),
    pending: {
      approvals: listPendingApprovals()
        .filter((a) => a.threadId === threadId)
        .map((a) => ({ id: a.id, tool: a.tool, summary: clean(a.summary, 200).text, riskTier: a.riskTier })),
      asks: listPendingAsks()
        .filter((a) => a.threadId === threadId)
        .map((a) => ({ id: a.id, question: clean(a.question, 300).text, kind: a.kind }))
    },
    observedAt: Date.now()
  }
}

// ---------- live stream ----------

const watched = new Set<ThreadId>()
const pending = new Map<ThreadId, ReturnType<typeof setTimeout>>()

/**
 * Set the sessions the UI is watching — the WHOLE set, not a delta. Idempotent by design: a renderer
 * that reloads (or a window that goes away) simply re-declares what it wants, so a dropped client
 * can never leak a watch, and reconnecting needs no bookkeeping on either side.
 */
export function setWatchedSessions(threadIds: ThreadId[]): void {
  watched.clear()
  for (const id of threadIds) watched.add(id)
  for (const [id, timer] of pending) {
    if (!watched.has(id)) {
      clearTimeout(timer)
      pending.delete(id)
    }
  }
}

/** Which sessions are being watched right now (tests, and the IPC status read). */
export function watchedSessions(): ThreadId[] {
  return [...watched]
}

/**
 * Something happened on a thread. If anyone is watching it, push a fresh snapshot — coalesced onto
 * {@link ACTIVITY_PUSH_MS}, because a streaming run emits events faster than any UI needs to redraw.
 */
export function noteSessionChange(threadId: ThreadId): void {
  if (!deps || !watched.has(threadId) || pending.has(threadId)) return
  const timer = setTimeout(() => {
    pending.delete(threadId)
    if (!watched.has(threadId)) return
    const activity = getSessionActivity(threadId)
    if (activity) deps?.push({ kind: 'session.activity', activity })
  }, ACTIVITY_PUSH_MS)
  // Never hold the process open for a UI refresh.
  timer.unref?.()
  pending.set(threadId, timer)
}

/** The thread a push event concerns, when it concerns one — the hook into the app's push fan-out. */
export function threadOfEvent(event: PushEvent): ThreadId | undefined {
  switch (event.kind) {
    case 'run.event':
      return event.event.threadId
    case 'thread.updated':
      return event.meta.id
    case 'message.updated':
      return event.message.threadId
    case 'message.deleted':
    case 'todos.updated':
    case 'jobs.updated':
    case 'files.changed':
      return event.threadId
    case 'approval.request':
      return event.request.threadId
    case 'ask.request':
      return event.request.threadId
    case 'session.message':
      return event.message.toThreadId
    default:
      return undefined
  }
}
