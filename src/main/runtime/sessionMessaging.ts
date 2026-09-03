import type { PushEvent } from '@shared/ipc'
import type { SendOptions, SessionMessage, SessionSummary, ThreadId } from '@shared/types'
import { ulid } from '@shared/id'
import { getDb } from '../store/db'
import { getThreadMeta, listThreads } from '../store/eventStore'

/**
 * The inter-session messaging broker (Slice 9).
 *
 * A "session" is a thread. This module lets the model running in one thread address and message
 * another live session, and lets a session read the messages waiting for it. It is deliberately a
 * leaf module — it imports the store, never the run manager or the tool layer — so the dependency
 * graph stays acyclic (runManager → builtin → sessionTools → sessionMessaging → store). The two
 * couplings it does need (is a thread running? inject a message into a running thread) are supplied
 * by {@link configureSessionMessaging} as callbacks, exactly the way {@link asks} and
 * {@link approvals} take `push` as a parameter rather than reaching into the run manager.
 *
 * Delivery always reaches the recipient model right away, through the same push lane a finished
 * background agent uses:
 *  - **Live** (recipient has an active run): the message is steer-injected at the recipient run's
 *    next safe boundary, so the working agent folds it into what it is already doing.
 *  - **Idle** (no active run): the recipient thread is WOKEN — the message starts a fresh run there,
 *    exactly as a subagent completion does — so the target session acts on it now rather than
 *    keeping it in an inbox until a human happens to prompt it. (Originally an idle recipient only
 *    got an inbox row; in practice that meant "messaging" never did anything until someone typed
 *    into the other thread.)
 * Both lanes persist a user-role turn in the recipient transcript, attributed to the real sender
 * (`origin`), and record the message in the durable `session_messages` table already marked read,
 * so `check_inbox` never re-delivers what the model has already seen.
 */

type PushFn = (event: PushEvent) => void

interface Deps {
  push: PushFn
  /** True when the thread has live work and can be woken or steered, including detached agents. */
  isRunning: (threadId: ThreadId) => boolean
  /** Inject a message into a thread's live run at its next safe boundary (the steer path). */
  steer: (opts: SendOptions) => void
}

let deps: Deps | null = null

/** Wire the broker to the run manager + renderer push channel. Called once at startup by the IPC layer. */
export function configureSessionMessaging(d: Deps): void {
  deps = d
}

/** Reset wiring (tests). */
export function resetSessionMessaging(): void {
  deps = null
}

// ---------- directory ----------

/**
 * The directory of addressable sessions: every non-archived thread except the caller, most-recent
 * first, each annotated with whether it is running and how many messages sit unread in its inbox.
 */
export function listSessions(excludeThreadId?: ThreadId): SessionSummary[] {
  const running = deps?.isRunning ?? (() => false)
  return listThreads(undefined, false)
    .filter((t) => t.id !== excludeThreadId)
    .map((t) => ({
      threadId: t.id,
      title: t.title,
      model: t.model,
      running: running(t.id),
      updatedAt: t.updatedAt,
      unread: unreadCount(t.id)
    }))
}

/**
 * Resolve a target given by id or (case-insensitive) title. An exact id wins; then an exact title;
 * then a unique title prefix. Returns the resolved thread id, or a `{ error }` describing why it
 * could not resolve (unknown, or ambiguous) so the tool can hand the model a self-correcting hint.
 */
export function resolveTarget(
  idOrName: string,
  excludeThreadId?: ThreadId
): { threadId: ThreadId } | { error: string } {
  const query = idOrName.trim()
  if (!query) return { error: 'Provide a target session id or title.' }

  const byId = getThreadMeta(query)
  if (byId && !byId.archived) {
    if (byId.id === excludeThreadId) return { error: 'Cannot message the current session (that is you).' }
    return { threadId: byId.id }
  }

  const candidates = listThreads(undefined, false).filter((t) => t.id !== excludeThreadId)
  const lower = query.toLowerCase()
  const exact = candidates.filter((t) => t.title.toLowerCase() === lower)
  const pool = exact.length ? exact : candidates.filter((t) => t.title.toLowerCase().startsWith(lower))
  if (pool.length === 1) return { threadId: pool[0]!.id }
  if (pool.length > 1) {
    const names = pool.slice(0, 6).map((t) => `"${t.title}" (${shortId(t.id)})`).join(', ')
    return { error: `"${query}" matches more than one session: ${names}. Use the session id to disambiguate.` }
  }
  return { error: `No session matches "${query}". Call list_sessions to see addressable sessions.` }
}

// ---------- send ----------

export interface SendResult {
  ok: boolean
  delivery?: 'injected' | 'woken' | 'queued'
  toThreadId?: ThreadId
  toTitle?: string
  messageId?: string
  error?: string
}

/**
 * Send a message to a session (thread). `to` is a thread id or title (see {@link resolveTarget}).
 * Delivers live (steer) when the recipient is running, otherwise wakes it with the message.
 *
 * The sender is usually another thread, but may be a **subagent** messaging a thread (typically its
 * own parent): pass `fromKind:'agent'` with the subagent's display `fromLabel`, and leave
 * `selfThreadId` unset so the parent thread is a legal target (a subagent is not the thread it runs
 * under, so "can't message yourself" must not apply). `fromThreadId` then carries the parent thread
 * for reply routing and attribution.
 */
export function sendSessionMessage(opts: {
  fromThreadId: ThreadId
  to: string
  body: string
  replyTo?: string
  /** Display name of the sender. Defaults to the `fromThreadId` thread's title. */
  fromLabel?: string
  /** Whether the sender is a peer thread (`session`, default) or a subagent (`agent`). */
  fromKind?: 'session' | 'agent'
  /** Ephemeral subagent id, used for direct replies while the agent is still alive. */
  fromAgentId?: string
  /** Thread excluded from target resolution (the sender's own session). Defaults to `fromThreadId`;
   *  pass `undefined` for an agent sender so it may address the thread it runs under. */
  selfThreadId?: ThreadId
}): SendResult {
  if (!deps) return { ok: false, error: 'Session messaging is not available.' }
  const body = opts.body?.trim()
  if (!body) return { ok: false, error: 'Message body is empty.' }

  const from = getThreadMeta(opts.fromThreadId)
  const fromKind = opts.fromKind ?? 'session'
  const fromTitle = opts.fromLabel ?? from?.title ?? 'a session'

  const selfThreadId = 'selfThreadId' in opts ? opts.selfThreadId : opts.fromThreadId
  const resolved = resolveTarget(opts.to, selfThreadId)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const toMeta = getThreadMeta(resolved.threadId)
  if (!toMeta) return { ok: false, error: `Session not found: ${opts.to}` }

  const live = deps.isRunning(resolved.threadId)
  const message: SessionMessage = {
    id: ulid(),
    fromThreadId: opts.fromThreadId,
    toThreadId: resolved.threadId,
    fromTitle,
    fromKind,
    ...(opts.fromAgentId ? { fromAgentId: opts.fromAgentId } : {}),
    body,
    replyTo: opts.replyTo,
    createdAt: Date.now(),
    // Delivered to the model either way (see the module doc), so it is read on arrival.
    readAt: Date.now(),
    delivery: live ? 'injected' : 'woken'
  }
  insertSessionMessage(message)

  // Working recipient: fold the message into its run at the next safe boundary. Idle recipient: the
  // same steer-disposition send starts a fresh run there (the run manager routes a steer with no
  // live run into a new turn), i.e. the message WAKES the session. Either way the wire text is
  // persisted as a user turn in the recipient transcript, visible to the human and part of the
  // recipient model's context; `origin` attributes it to its real sender so the transcript renders
  // an incoming card, not a human bubble.
  deps.steer({
    threadId: resolved.threadId,
    text: formatIncomingMessage(message, fromKind),
    disposition: 'steer',
    origin: {
      kind: fromKind,
      label: fromTitle,
      fromThreadId: opts.fromThreadId,
      ...(opts.fromAgentId ? { agentId: opts.fromAgentId } : {})
    }
  })

  deps.push({ kind: 'session.message', message })
  return {
    ok: true,
    delivery: message.delivery,
    toThreadId: resolved.threadId,
    toTitle: toMeta.title,
    messageId: message.id
  }
}

/**
 * Render an inbound message as the text the recipient model reads. It names the sender and tells the
 * model exactly how to reply, so reply routing needs no special affordance beyond the ordinary
 * `send_message` tool. A subagent sender is labeled as such; replying reaches the thread it runs
 * under (its `fromThreadId`), since the subagent itself is ephemeral.
 */
export function formatIncomingMessage(m: SessionMessage, fromKind: 'session' | 'agent' = m.fromKind ?? 'session'): string {
  const replyTarget = fromKind === 'agent' && m.fromAgentId ? m.fromAgentId : m.fromThreadId
  const reply = `To reply, use send_message with to:"${replyTarget}".`
  const who =
    fromKind === 'agent'
      ? `subagent "${m.fromTitle}" (working under session id ${m.fromThreadId})`
      : `session "${m.fromTitle}" (id ${m.fromThreadId})`
  return `📨 Message from ${who}. ${reply}\n\n${m.body}`
}

// ---------- inbox ----------

/** All messages addressed to a thread, newest first. */
export function listInbox(threadId: ThreadId): SessionMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM session_messages WHERE to_thread_id = ? ORDER BY created_at DESC')
    .all(threadId) as Record<string, unknown>[]
  return rows.map(rowToMessage)
}

/** Count of unread (undelivered/unseen) messages waiting for a thread. */
export function unreadCount(threadId: ThreadId): number {
  const row = getDb()
    .prepare('SELECT COUNT(*) AS n FROM session_messages WHERE to_thread_id = ? AND read_at IS NULL')
    .get(threadId) as { n: number }
  return row.n
}

/**
 * Drain a thread's unread inbox: return the unread messages (oldest first, the order they should be
 * acted on) and mark them read. Used by the `check_inbox` tool so a session can pull the queue that
 * accumulated while it was idle.
 */
export function drainInbox(threadId: ThreadId): SessionMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM session_messages WHERE to_thread_id = ? AND read_at IS NULL ORDER BY created_at ASC')
    .all(threadId) as Record<string, unknown>[]
  const messages = rows.map(rowToMessage)
  if (messages.length) {
    const now = Date.now()
    const stmt = getDb().prepare('UPDATE session_messages SET read_at = ? WHERE id = ?')
    const tx = getDb().transaction((list: SessionMessage[]) => {
      for (const m of list) stmt.run(now, m.id)
    })
    tx(messages)
    deps?.push({ kind: 'session.message', message: { ...messages[messages.length - 1]!, readAt: now } })
  }
  return messages
}

/** Mark a single inbox message read (renderer, when the user views it). Returns false if unknown. */
export function markSessionMessageRead(id: string): boolean {
  const info = getDb().prepare('UPDATE session_messages SET read_at = ? WHERE id = ? AND read_at IS NULL').run(Date.now(), id)
  return info.changes > 0
}

// ---------- storage ----------

function insertSessionMessage(m: SessionMessage): void {
  getDb()
    .prepare(
      `INSERT INTO session_messages (id, from_thread_id, to_thread_id, from_title, from_kind, from_agent_id, body, reply_to, created_at, read_at, delivery)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.id,
      m.fromThreadId,
      m.toThreadId,
      m.fromTitle,
      m.fromKind ?? 'session',
      m.fromAgentId ?? null,
      m.body,
      m.replyTo ?? null,
      m.createdAt,
      m.readAt ?? null,
      m.delivery
    )
}

function rowToMessage(r: Record<string, unknown>): SessionMessage {
  return {
    id: r.id as string,
    fromThreadId: r.from_thread_id as string,
    toThreadId: r.to_thread_id as string,
    fromTitle: r.from_title as string,
    fromKind: (r.from_kind as SessionMessage['fromKind']) ?? 'session',
    fromAgentId: (r.from_agent_id as string) ?? undefined,
    body: r.body as string,
    replyTo: (r.reply_to as string) ?? undefined,
    createdAt: r.created_at as number,
    readAt: (r.read_at as number) ?? undefined,
    delivery: r.delivery as SessionMessage['delivery']
  }
}

function shortId(id: string): string {
  return id.slice(-6)
}
