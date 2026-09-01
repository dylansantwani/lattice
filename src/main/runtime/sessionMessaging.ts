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
 * Delivery has two lanes:
 *  - **Live** (recipient has an active run): the message is steer-injected at the recipient run's
 *    next safe boundary, so the working agent folds it into what it is already doing. This persists
 *    a user-role turn in the recipient transcript (via the steer path) and is marked delivered.
 *  - **Idle** (no active run): the message lands in the recipient's inbox only. It is NOT written
 *    into the transcript — an idle thread never sprouts bubbles its human did not type. The
 *    recipient surfaces an unread badge, and the next time that session runs, its agent can pull
 *    the queue with the `check_inbox` tool.
 */

type PushFn = (event: PushEvent) => void

interface Deps {
  push: PushFn
  /** True when the thread currently has an active model run that can still receive a steer. */
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
  delivery?: 'injected' | 'queued'
  toThreadId?: ThreadId
  toTitle?: string
  messageId?: string
  error?: string
}

/**
 * Send a message from one session to another. `to` is a thread id or title (see {@link resolveTarget}).
 * Delivers live (steer) when the recipient is running, otherwise to its inbox.
 */
export function sendSessionMessage(opts: {
  fromThreadId: ThreadId
  to: string
  body: string
  replyTo?: string
}): SendResult {
  if (!deps) return { ok: false, error: 'Session messaging is not available.' }
  const body = opts.body?.trim()
  if (!body) return { ok: false, error: 'Message body is empty.' }

  const from = getThreadMeta(opts.fromThreadId)
  const fromTitle = from?.title ?? 'a session'

  const resolved = resolveTarget(opts.to, opts.fromThreadId)
  if ('error' in resolved) return { ok: false, error: resolved.error }
  const toMeta = getThreadMeta(resolved.threadId)
  if (!toMeta) return { ok: false, error: `Session not found: ${opts.to}` }

  const live = deps.isRunning(resolved.threadId)
  const message: SessionMessage = {
    id: ulid(),
    fromThreadId: opts.fromThreadId,
    toThreadId: resolved.threadId,
    fromTitle,
    body,
    replyTo: opts.replyTo,
    createdAt: Date.now(),
    readAt: live ? Date.now() : undefined,
    delivery: live ? 'injected' : 'queued'
  }
  insertSessionMessage(message)

  if (live) {
    // The recipient is working: fold the message into its run at the next safe boundary. The steer
    // path persists the wire text as a user turn in the recipient transcript, so it is both visible
    // to the human and part of the recipient model's context on the next round.
    deps.steer({
      threadId: resolved.threadId,
      text: formatIncomingMessage(message),
      disposition: 'steer'
    })
  }

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
 * Render an inbound message as the text the recipient model reads. It names the sender and its id,
 * and tells the model exactly how to reply, so reply routing needs no special affordance beyond the
 * ordinary `send_message` tool.
 */
export function formatIncomingMessage(m: SessionMessage): string {
  const reply = `To reply, use send_message with to:"${m.fromThreadId}".`
  return `📨 Message from session "${m.fromTitle}" (id ${m.fromThreadId}). ${reply}\n\n${m.body}`
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
      `INSERT INTO session_messages (id, from_thread_id, to_thread_id, from_title, body, reply_to, created_at, read_at, delivery)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      m.id,
      m.fromThreadId,
      m.toThreadId,
      m.fromTitle,
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
