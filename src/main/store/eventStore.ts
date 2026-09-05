import { ulid } from '@shared/id'
import { getDb, onDbClose, prep } from './db'
import { homedir } from 'node:os'
import type {
  AppSettings,
  ChatMessage,
  RunId,
  FileChange,
  FileChangeKind,
  MemoryItem,
  RunEvent,
  RunEventBody,
  ThreadGroup,
  ThreadId,
  ThreadMeta,
  ThreadSearchHit,
  Todo,
  TodoPatch,
  UsageRow,
  WorkspaceMeta,
  McpServerConfig,
  ModelInfo
} from '@shared/types'
import { DEFAULT_SETTINGS } from '@shared/types'

// ---------- workspaces ----------

export function ensureDefaultWorkspace(): WorkspaceMeta {
  const db = getDb()
  const row = db.prepare('SELECT * FROM workspaces ORDER BY created_at LIMIT 1').get() as
    | Record<string, unknown>
    | undefined
  if (row) return rowToWorkspace(row)
  const ws: WorkspaceMeta = {
    id: ulid(),
    name: 'Workspace',
    roots: [homedir()],
    createdAt: Date.now()
  }
  db.prepare('INSERT INTO workspaces (id, name, roots_json, created_at) VALUES (?, ?, ?, ?)').run(
    ws.id,
    ws.name,
    JSON.stringify(ws.roots),
    ws.createdAt
  )
  return ws
}

export function listWorkspaces(): WorkspaceMeta[] {
  const rows = getDb().prepare('SELECT * FROM workspaces ORDER BY created_at').all() as Record<
    string,
    unknown
  >[]
  return rows.map(rowToWorkspace)
}

function rowToWorkspace(r: Record<string, unknown>): WorkspaceMeta {
  return {
    id: r.id as string,
    name: r.name as string,
    roots: JSON.parse(r.roots_json as string),
    createdAt: r.created_at as number
  }
}

// ---------- threads ----------

export function createThread(opts: {
  workspaceId: string
  title?: string
  model: string
  effort?: string
  mode?: ThreadMeta['mode']
  permissionPreset?: ThreadMeta['permissionPreset']
  parentThreadId?: string
  parentEventId?: string
  goal?: string
  groupId?: string
  /** Override title provenance; defaults to 'user' for an explicit title, 'auto' otherwise. */
  titleSource?: ThreadMeta['titleSource']
}): ThreadMeta {
  const now = Date.now()
  const meta: ThreadMeta = {
    id: ulid(),
    workspaceId: opts.workspaceId,
    title: opts.title ?? 'New thread',
    // An explicitly-passed title (a /side fork, a scripted creation) is someone's deliberate name
    // and is never auto-rewritten; the default 'New thread' is auto-titling's population.
    titleSource: opts.titleSource ?? (opts.title ? 'user' : 'auto'),
    titleMsgs: 0,
    createdAt: now,
    updatedAt: now,
    pinned: false,
    archived: false,
    model: opts.model,
    effort: opts.effort,
    mode: opts.mode ?? 'act',
    permissionPreset: opts.permissionPreset ?? 'workspace',
    parentThreadId: opts.parentThreadId,
    parentEventId: opts.parentEventId,
    goal: opts.goal,
    groupId: opts.groupId
  }
  getDb()
    .prepare(
      `INSERT INTO threads (id, workspace_id, title, title_source, title_msgs, created_at, updated_at, pinned, archived, model, effort, mode, permission_preset, parent_thread_id, parent_event_id, goal, group_id)
       VALUES (?, ?, ?, ?, 0, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      meta.id,
      meta.workspaceId,
      meta.title,
      meta.titleSource,
      meta.createdAt,
      meta.updatedAt,
      meta.model,
      meta.effort ?? null,
      meta.mode,
      meta.permissionPreset,
      meta.parentThreadId ?? null,
      meta.parentEventId ?? null,
      meta.goal ?? null,
      meta.groupId ?? null
    )
  return meta
}

export function listThreads(workspaceId?: string, includeArchived = false): ThreadMeta[] {
  const db = getDb()
  const archivedClause = includeArchived ? '' : ' AND archived = 0'
  const rows = (
    workspaceId
      ? db
          .prepare(`SELECT * FROM threads WHERE workspace_id = ?${archivedClause} ORDER BY updated_at DESC`)
          .all(workspaceId)
      : db
          .prepare(`SELECT * FROM threads WHERE 1 = 1${archivedClause} ORDER BY updated_at DESC`)
          .all()
  ) as Record<string, unknown>[]
  return rows.map(rowToThread)
}

export function getThreadMeta(id: ThreadId): ThreadMeta | null {
  const row = prep('SELECT * FROM threads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToThread(row) : null
}

export function updateThread(id: ThreadId, patch: Partial<ThreadMeta>): ThreadMeta {
  const current = getThreadMeta(id)
  if (!current) throw new Error(`thread not found: ${id}`)
  const next = { ...current, ...patch, id, updatedAt: Date.now() }
  // A title change with no explicit provenance is a human rename (the UI's rename control patches
  // only `title`), which permanently opts the thread out of auto-retitling. Auto-titling and the
  // model's set_thread_title pass their own titleSource so they are attributed correctly.
  if (patch.title !== undefined && patch.title !== current.title && patch.titleSource === undefined) {
    next.titleSource = 'user'
  }
  // A blank goal clears it (stored as NULL) rather than persisting an empty string.
  const goal = next.goal && next.goal.trim() ? next.goal.trim() : null
  next.goal = goal ?? undefined
  getDb()
    .prepare(
      `UPDATE threads SET title=?, title_source=?, title_msgs=?, updated_at=?, pinned=?, archived=?, model=?, effort=?, mode=?, permission_preset=?, goal=?, group_id=?, is_private=? WHERE id=?`
    )
    .run(
      next.title,
      next.titleSource ?? 'user',
      next.titleMsgs ?? 0,
      next.updatedAt,
      next.pinned ? 1 : 0,
      next.archived ? 1 : 0,
      next.model,
      next.effort ?? null,
      next.mode,
      next.permissionPreset,
      goal,
      next.groupId ?? null,
      next.isPrivate ? 1 : 0,
      id
    )
  return next
}

/**
 * File a thread into a group (or clear its group with `null`). A dedicated call rather than
 * `updateThread({ groupId })` because IPC's structured clone drops `undefined` keys, so
 * "remove from group" needs an explicit `null` sentinel that survives the boundary.
 */
export function setThreadGroup(id: ThreadId, groupId: string | null): ThreadMeta {
  const current = getThreadMeta(id)
  if (!current) throw new Error(`thread not found: ${id}`)
  const updatedAt = Date.now()
  getDb()
    .prepare('UPDATE threads SET group_id=?, updated_at=? WHERE id=?')
    .run(groupId, updatedAt, id)
  return { ...current, groupId: groupId ?? undefined, updatedAt }
}

export function deleteThread(id: ThreadId): void {
  toolWireRev += 1
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM events WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM file_changes WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM thread_tools WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM threads WHERE id = ?').run(id)
}

function rowToThread(r: Record<string, unknown>): ThreadMeta {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    title: r.title as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    pinned: !!r.pinned,
    archived: !!r.archived,
    model: r.model as string,
    effort: (r.effort as string) ?? undefined,
    mode: r.mode as ThreadMeta['mode'],
    permissionPreset: r.permission_preset as ThreadMeta['permissionPreset'],
    titleSource: (r.title_source as ThreadMeta['titleSource']) ?? 'user',
    titleMsgs: (r.title_msgs as number) ?? 0,
    parentThreadId: (r.parent_thread_id as string) ?? undefined,
    parentEventId: (r.parent_event_id as string) ?? undefined,
    goal: (r.goal as string) ?? undefined,
    groupId: (r.group_id as string) ?? undefined,
    ...(r.is_private ? { isPrivate: true } : {})
  }
}

// ---------- thread groups ----------

export function listThreadGroups(workspaceId?: string): ThreadGroup[] {
  const rows = (
    workspaceId
      ? getDb()
          .prepare('SELECT * FROM thread_groups WHERE workspace_id = ? ORDER BY sort_order, created_at')
          .all(workspaceId)
      : getDb().prepare('SELECT * FROM thread_groups ORDER BY sort_order, created_at').all()
  ) as Record<string, unknown>[]
  return rows.map(rowToGroup)
}

export function createThreadGroup(opts: { workspaceId: string; name: string; color?: string }): ThreadGroup {
  const now = Date.now()
  // append to the end of the current ordering
  const maxRow = getDb()
    .prepare('SELECT MAX(sort_order) AS m FROM thread_groups WHERE workspace_id = ?')
    .get(opts.workspaceId) as { m: number | null }
  const group: ThreadGroup = {
    id: ulid(),
    workspaceId: opts.workspaceId,
    name: opts.name.trim() || 'New group',
    color: opts.color,
    sortOrder: (maxRow.m ?? -1) + 1,
    createdAt: now,
    updatedAt: now
  }
  getDb()
    .prepare(
      'INSERT INTO thread_groups (id, workspace_id, name, color, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
    )
    .run(group.id, group.workspaceId, group.name, group.color ?? null, group.sortOrder, group.createdAt, group.updatedAt)
  return group
}

export function updateThreadGroup(
  id: string,
  patch: Partial<Pick<ThreadGroup, 'name' | 'color' | 'sortOrder'>>
): ThreadGroup {
  const row = getDb().prepare('SELECT * FROM thread_groups WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) throw new Error(`thread group not found: ${id}`)
  const current = rowToGroup(row)
  const next: ThreadGroup = {
    ...current,
    ...patch,
    name: (patch.name ?? current.name).trim() || current.name,
    updatedAt: Date.now()
  }
  getDb()
    .prepare('UPDATE thread_groups SET name=?, color=?, sort_order=?, updated_at=? WHERE id=?')
    .run(next.name, next.color ?? null, next.sortOrder, next.updatedAt, id)
  return next
}

/** Delete a group and un-file every thread that referenced it (threads themselves are kept). */
export function deleteThreadGroup(id: string): void {
  const db = getDb()
  const tx = db.transaction(() => {
    db.prepare('UPDATE threads SET group_id = NULL WHERE group_id = ?').run(id)
    db.prepare('DELETE FROM thread_groups WHERE id = ?').run(id)
  })
  tx()
}

function rowToGroup(r: Record<string, unknown>): ThreadGroup {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    color: (r.color as string) ?? undefined,
    sortOrder: r.sort_order as number,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

// ---------- messages ----------

/**
 * Bumped whenever a mutation could change which tool exchanges a thread's wire replays — a message
 * carrying tool exchanges landing or changing, a compaction, a deletion. Streaming text flushes
 * (updateMessage with only `text`) deliberately do NOT bump it: they land every ~80ms during a
 * reply, and the whole point of this counter is to let the per-tick context-budget math memoize
 * work (see reclaimedByToolPruning) across those flushes instead of re-reading the thread each time.
 */
let toolWireRev = 0
export function toolWireRevision(): number {
  return toolWireRev
}

export function insertMessage(msg: ChatMessage): void {
  if (msg.toolExchanges?.length || msg.compacted) toolWireRev += 1
  prep(
    `INSERT INTO messages (id, thread_id, run_id, role, created_at, text, model, effort, status, telemetry_json, attachments_json, tool_wire_json, compacted, queued, origin_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .run(
      msg.id,
      msg.threadId,
      msg.runId ?? null,
      msg.role,
      msg.createdAt,
      msg.text,
      msg.model ?? null,
      msg.effort ?? null,
      msg.status ?? null,
      msg.telemetry ? JSON.stringify(msg.telemetry) : null,
      msg.attachments ? JSON.stringify(msg.attachments) : null,
      msg.toolExchanges?.length ? JSON.stringify(msg.toolExchanges) : null,
      msg.compacted ? 1 : 0,
      msg.queued ? 1 : 0,
      msg.origin ? JSON.stringify(msg.origin) : null
    )
  prep('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), msg.threadId)
}

export function updateMessage(id: string, patch: Partial<ChatMessage>): ChatMessage | null {
  const row = prep('SELECT * FROM messages WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  if ('toolExchanges' in patch || 'compacted' in patch) toolWireRev += 1
  const current = rowToMessage(row)
  const next = { ...current, ...patch, id }
  prep(
    `UPDATE messages SET text=?, status=?, telemetry_json=?, model=?, effort=?, run_id=?, tool_wire_json=?, queued=?, origin_json=? WHERE id=?`
  )
    .run(
      next.text,
      next.status ?? null,
      next.telemetry ? JSON.stringify(next.telemetry) : null,
      next.model ?? null,
      next.effort ?? null,
      next.runId ?? null,
      next.toolExchanges?.length ? JSON.stringify(next.toolExchanges) : null,
      next.queued ? 1 : 0,
      next.origin ? JSON.stringify(next.origin) : null,
      id
    )
  return next
}

/**
 * Reconcile runs that were in flight when the app last quit. A run lives only in
 * the main process's in-memory map, so any run active at quit is gone on the next
 * launch — its assistant message was never finalized and still has a NULL status,
 * which the transcript would otherwise render as perpetually "running". Mark those
 * as interrupted so the UI is truthful and consistent with the (empty) run map.
 * Returns the ids of the threads that had an interrupted run.
 */
export function reconcileInterruptedRuns(): ThreadId[] {
  const db = getDb()
  const rows = db
    .prepare(`SELECT DISTINCT thread_id FROM messages WHERE role = 'assistant' AND status IS NULL`)
    .all() as { thread_id: string }[]
  if (rows.length === 0) return []
  db.prepare(`UPDATE messages SET status = 'interrupted' WHERE role = 'assistant' AND status IS NULL`).run()
  return rows.map((r) => r.thread_id)
}

/** Permanently remove every event of one run (used when an interrupted turn is retried). */
/**
 * Move a finished run's events onto another run id. Used when an interrupted reply is RESUMED: the
 * continuation is a new run, but the events it continues from belong to the same visible message, so
 * the transcript must keep showing them as one timeline. `appendEvent` seeds a cold run's sequence
 * counter from `MAX(seq)`, so the resumed run numbers its own events after the migrated ones and
 * ordering stays intact.
 */
export function reassignRunEvents(fromRunId: RunId, toRunId: RunId): number {
  const info = prep('UPDATE events SET run_id = ? WHERE run_id = ?').run(toRunId, fromRunId)
  releaseSeqCounter(toRunId)
  return info.changes
}

export function deleteRunEvents(runId: RunId): void {
  prep('DELETE FROM events WHERE run_id = ?').run(runId)
}

/** Permanently remove a single message (used to drop a queued turn the user removed). */
export function deleteMessage(id: string): void {
  toolWireRev += 1
  prep('DELETE FROM messages WHERE id = ?').run(id)
}

export function listMessages(threadId: ThreadId): ChatMessage[] {
  // Tie-break on rowid (insertion order), NOT id. A user message and its assistant
  // reply are inserted in the same millisecond, so they share created_at, and our
  // ulid()s are not monotonic within a millisecond (80 random bits) — an `id`
  // tie-break sorts same-ms messages arbitrarily, which flipped the reply above the
  // prompt on reload. rowid is monotonic with insertion and needs no schema change,
  // so it also repairs threads already persisted with random ids.
  const rows = prep('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, rowid').all(
    threadId
  ) as Record<string, unknown>[]
  return rows.map(rowToMessage)
}

/**
 * Every completed main-run turn across every thread (including archived and forked ones),
 * oldest first, for the app-wide Usage page. Threads deleted since are naturally absent —
 * {@link deleteThread} cascades to their messages. Cheap enough to load in full and aggregate
 * client-side at this app's scale (one row per assistant turn, not per event).
 */
export function listUsageRows(): UsageRow[] {
  const rows = getDb()
    .prepare(
      `SELECT m.id, m.thread_id, m.created_at, m.model, m.effort, m.telemetry_json, t.title
       FROM messages m JOIN threads t ON t.id = m.thread_id
       WHERE m.role = 'assistant' AND m.telemetry_json IS NOT NULL
       ORDER BY m.created_at, m.rowid`
    )
    .all() as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    threadId: r.thread_id as string,
    threadTitle: r.title as string,
    model: (r.model as string) ?? undefined,
    effort: (r.effort as string) ?? undefined,
    createdAt: r.created_at as number,
    telemetry: JSON.parse(r.telemetry_json as string)
  }))
}

/**
 * Every tool invocation across every thread (main runs and subagents alike), flattened from the
 * event log for the Usage page's per-tool breakdown. A `tool.started` row is the call; the matching
 * `tool.result` carries ok/duration. Uses SQLite's json_extract so we never load full event bodies.
 */
export function listToolEventStats(): {
  tool: string
  ts: number
  completed: boolean
  ok?: boolean
  durationMs?: number
}[] {
  const rows = getDb()
    .prepare(
      `SELECT ts,
              json_extract(body_json,'$.type')       AS type,
              json_extract(body_json,'$.tool')       AS tool,
              json_extract(body_json,'$.ok')         AS ok,
              json_extract(body_json,'$.durationMs') AS duration
       FROM events
       WHERE json_extract(body_json,'$.type') IN ('tool.started','tool.result')
       ORDER BY ts`
    )
    .all() as { ts: number; type: string; tool: string | null; ok: number | null; duration: number | null }[]
  return rows
    .filter((r) => r.tool)
    .map((r) => ({
      tool: r.tool as string,
      ts: r.ts,
      completed: r.type === 'tool.result',
      ok: r.ok === null ? undefined : r.ok === 1,
      durationMs: r.duration === null ? undefined : r.duration
    }))
}

/**
 * Every main-run assistant turn that ended in a failure (an endpoint error, or a run the user
 * interrupted mid-flight), for the Usage page's failure counts. These carry no telemetry so they're
 * absent from {@link listUsageRows}; counted here separately.
 */
export function listFailedTurns(): { threadId: string; model?: string; createdAt: number }[] {
  const rows = getDb()
    .prepare(
      `SELECT thread_id, model, created_at FROM messages
       WHERE role = 'assistant' AND status IN ('error','interrupted')
       ORDER BY created_at`
    )
    .all() as { thread_id: string; model: string | null; created_at: number }[]
  return rows.map((r) => ({ threadId: r.thread_id, model: r.model ?? undefined, createdAt: r.created_at }))
}

/** Mark a set of messages as compacted (folded into a summary; no longer sent to the model in full). */
export function markMessagesCompacted(ids: string[]): void {
  if (!ids.length) return
  toolWireRev += 1
  const stmt = prep('UPDATE messages SET compacted = 1 WHERE id = ?')
  const tx = getDb().transaction((list: string[]) => {
    for (const id of list) stmt.run(id)
  })
  tx(ids)
}

/** Delete every message and run event for a thread, leaving the thread and its settings intact. */
export function clearThreadContent(threadId: ThreadId): void {
  toolWireRev += 1
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
  db.prepare('DELETE FROM events WHERE thread_id = ?').run(threadId)
  db.prepare('DELETE FROM file_changes WHERE thread_id = ?').run(threadId)
  // The loaded-tool set follows the transcript: it exists so tools the history references stay
  // callable, so an emptied history starts from the bare core again.
  db.prepare('DELETE FROM thread_tools WHERE thread_id = ?').run(threadId)
  db.prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), threadId)
}

/**
 * Search message text across all threads. Returns at most one hit per thread
 * (the most recent matching message), ordered by thread recency, each with a
 * short snippet centered on the first match.
 */
export function searchThreadContent(query: string, limit = 50): ThreadSearchHit[] {
  const q = query.trim()
  if (!q) return []
  // escape LIKE wildcards so a literal % or _ in the query matches literally
  const like = `%${q.replace(/[\\%_]/g, (c) => '\\' + c)}%`
  const rows = getDb()
    .prepare(
      `SELECT m.thread_id AS threadId, m.role AS role, m.text AS text
       FROM messages m
       JOIN threads t ON t.id = m.thread_id
       WHERE m.text LIKE ? ESCAPE '\\'
       ORDER BY t.updated_at DESC, m.created_at DESC`
    )
    .all(like) as { threadId: string; role: string; text: string }[]

  const seen = new Set<string>()
  const hits: ThreadSearchHit[] = []
  for (const r of rows) {
    if (seen.has(r.threadId)) continue
    seen.add(r.threadId)
    hits.push({
      threadId: r.threadId,
      role: r.role as ThreadSearchHit['role'],
      snippet: makeSnippet(r.text, q)
    })
    if (hits.length >= limit) break
  }
  return hits
}

/** Collapse whitespace and return a ~120-char window centered on the first match. */
function makeSnippet(text: string, query: string): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  const idx = clean.toLowerCase().indexOf(query.toLowerCase())
  if (idx < 0) return clean.slice(0, 120)
  const pad = 48
  const start = Math.max(0, idx - pad)
  const end = Math.min(clean.length, idx + query.length + pad)
  return (start > 0 ? '…' : '') + clean.slice(start, end) + (end < clean.length ? '…' : '')
}

function rowToMessage(r: Record<string, unknown>): ChatMessage {
  return {
    id: r.id as string,
    threadId: r.thread_id as string,
    runId: (r.run_id as string) ?? undefined,
    role: r.role as ChatMessage['role'],
    createdAt: r.created_at as number,
    text: r.text as string,
    model: (r.model as string) ?? undefined,
    effort: (r.effort as string) ?? undefined,
    status: (r.status as ChatMessage['status']) ?? undefined,
    telemetry: r.telemetry_json ? JSON.parse(r.telemetry_json as string) : undefined,
    attachments: r.attachments_json ? JSON.parse(r.attachments_json as string) : undefined,
    toolExchanges: r.tool_wire_json ? JSON.parse(r.tool_wire_json as string) : undefined,
    compacted: !!r.compacted,
    queued: !!r.queued,
    origin: r.origin_json ? JSON.parse(r.origin_json as string) : undefined
  }
}

// ---------- events ----------

const seqCounters = new Map<string, number>()

/**
 * Drop a finished run's in-memory seq counter. Without this the map gains one entry per run
 * (main runs, subagent-sharing runs, one-shot compaction runs) for the process lifetime. Safe
 * to call as soon as no more events will be appended for the run: a late append would just
 * re-seed the counter from MAX(seq) in the DB, which yields the same next value.
 */
export function releaseSeqCounter(runId: string): void {
  seqCounters.delete(runId)
}

export function appendEvent(runId: string, threadId: ThreadId, body: RunEventBody, agent?: string): RunEvent {
  let seq = seqCounters.get(runId)
  if (seq === undefined) {
    const row = prep('SELECT MAX(seq) as m FROM events WHERE run_id = ?').get(runId) as {
      m: number | null
    }
    seq = (row.m ?? -1) + 1
  } else {
    seq += 1
  }
  seqCounters.set(runId, seq)
  const ev: RunEvent = { id: ulid(), runId, threadId, seq, ts: Date.now(), agent, body }
  prep(
    'INSERT INTO events (id, run_id, thread_id, seq, ts, agent, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)'
  ).run(ev.id, runId, threadId, seq, ev.ts, agent ?? null, JSON.stringify(body))
  return ev
}

/**
 * The last `limit` events on a thread, oldest-first. {@link listEvents} loads a thread's ENTIRE
 * event history, which is the right thing for the transcript and the wrong thing for a live status
 * read of somebody else's session — a long-running thread has tens of thousands of rows and the
 * activity view only ever shows the tail.
 */
export function listRecentEvents(threadId: ThreadId, limit: number): RunEvent[] {
  const rows = prep('SELECT * FROM events WHERE thread_id = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(
    threadId,
    Math.max(1, limit)
  ) as Record<string, unknown>[]
  return rows.reverse().map(rowToEvent)
}

/** The last `limit` messages on a thread, oldest-first (see {@link listRecentEvents}). */
export function listRecentMessages(threadId: ThreadId, limit: number): ChatMessage[] {
  const rows = prep('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?').all(
    threadId,
    Math.max(1, limit)
  ) as Record<string, unknown>[]
  return rows.reverse().map(rowToMessage)
}

export function listEvents(threadId: ThreadId): RunEvent[] {
  // rowid, not seq, as the tie-break: `seq` restarts at 0 for every run, so two runs that begin in
  // the same millisecond would interleave. rowid is monotonic with insertion (see listMessages).
  const rows = prep('SELECT * FROM events WHERE thread_id = ? ORDER BY ts, rowid').all(
    threadId
  ) as Record<string, unknown>[]
  return rows.map(rowToEvent)
}

function rowToEvent(r: Record<string, unknown>): RunEvent {
  return {
    id: r.id as string,
    runId: r.run_id as string,
    threadId: r.thread_id as string,
    seq: r.seq as number,
    ts: r.ts as number,
    agent: (r.agent as string) ?? undefined,
    body: JSON.parse(r.body_json as string)
  }
}

// ---------- settings ----------

/**
 * Settings live in one JSON row but are read on every hot path (each run round, each context-budget
 * tick, each tool call). Parse once and serve from memory; every write goes through setSettings in
 * this process, which refreshes the memo. A shallow copy is returned so a caller mutating its copy
 * can never poison the cache. Dropped when the DB connection closes (tests reopen fresh DBs).
 */
let settingsMemo: AppSettings | null = null

export function getSettings(): AppSettings {
  let loaded = settingsMemo
  if (!loaded) {
    const row = prep("SELECT value_json FROM settings WHERE key = 'app'").get() as
      | { value_json: string }
      | undefined
    loaded = row
      ? ({ ...DEFAULT_SETTINGS, ...JSON.parse(row.value_json) } as AppSettings)
      : { ...DEFAULT_SETTINGS }
    settingsMemo = loaded
  }
  return { ...loaded }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next: AppSettings = { ...getSettings(), ...patch }
  prep(
    "INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json"
  ).run(JSON.stringify(next))
  settingsMemo = next
  return { ...next }
}

// ---------- file changes (Files inspector session diff) ----------

function rowToFileChange(r: Record<string, unknown>): FileChange {
  return {
    threadId: r.thread_id as ThreadId,
    path: r.path as string,
    kind: r.kind as FileChangeKind,
    before: (r.before_content as string | null) ?? null,
    after: (r.after_content as string | null) ?? null,
    beforeTruncated: !!r.before_truncated,
    afterTruncated: !!r.after_truncated,
    firstAt: r.first_at as number,
    lastAt: r.last_at as number
  }
}

/**
 * Record that the agent touched a file. The FIRST change to a path in a thread stores the pre-edit
 * baseline (`before`); later changes keep that original baseline and only refresh `after`, so the row
 * always represents the whole-session diff (original → current) rather than the last hunk. `kind` is
 * derived from that baseline and the current content: a file with no baseline is a `create`, one
 * whose current content is gone is a `delete`, otherwise an `edit`.
 */
export function recordFileChange(c: {
  threadId: ThreadId
  path: string
  before: string | null
  after: string | null
  beforeTruncated?: boolean
  afterTruncated?: boolean
}): FileChange {
  const now = Date.now()
  const existing = getDb()
    .prepare('SELECT * FROM file_changes WHERE thread_id = ? AND path = ?')
    .get(c.threadId, c.path) as Record<string, unknown> | undefined
  const baselineBefore = existing ? (existing.before_content as string | null) : c.before
  const kind: FileChangeKind =
    c.after === null ? 'delete' : baselineBefore == null ? 'create' : 'edit'
  if (existing) {
    getDb()
      .prepare(
        'UPDATE file_changes SET kind = ?, after_content = ?, after_truncated = ?, last_at = ? WHERE thread_id = ? AND path = ?'
      )
      .run(kind, c.after, c.afterTruncated ? 1 : 0, now, c.threadId, c.path)
  } else {
    getDb()
      .prepare(
        `INSERT INTO file_changes
          (thread_id, path, kind, before_content, after_content, before_truncated, after_truncated, first_at, last_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        c.threadId,
        c.path,
        kind,
        c.before,
        c.after,
        c.beforeTruncated ? 1 : 0,
        c.afterTruncated ? 1 : 0,
        now,
        now
      )
  }
  const row = getDb()
    .prepare('SELECT * FROM file_changes WHERE thread_id = ? AND path = ?')
    .get(c.threadId, c.path) as Record<string, unknown>
  return rowToFileChange(row)
}

export function listFileChanges(threadId: ThreadId): FileChange[] {
  const rows = getDb()
    .prepare('SELECT * FROM file_changes WHERE thread_id = ? ORDER BY last_at DESC')
    .all(threadId) as Record<string, unknown>[]
  return rows.map(rowToFileChange)
}

export function clearFileChanges(threadId: ThreadId): void {
  getDb().prepare('DELETE FROM file_changes WHERE thread_id = ?').run(threadId)
}

// ---------- todos ----------

/**
 * Tool-supplied checklist ids ("1", "2a") are scoped to their thread in storage, so two runs that
 * both number their items from 1 can never overwrite each other's rows. The public form (what the
 * model sends and sees) is the bare key; the stored form is `<threadId>:<key>`.
 */
export function scopedTodoId(threadId: string, key: string): string {
  return key.includes(':') ? key : `${threadId}:${key}`
}
export function publicTodoId(threadId: string | undefined, id: string): string {
  const prefix = `${threadId}:`
  return threadId && id.startsWith(prefix) ? id.slice(prefix.length) : id
}

const TODO_STATUSES: ReadonlySet<string> = new Set(['todo', 'in_progress', 'blocked', 'review', 'done', 'canceled'])
export function isTodoStatus(s: unknown): s is Todo['status'] {
  return typeof s === 'string' && TODO_STATUSES.has(s)
}

function rowToTodo(r: Record<string, unknown>): Todo {
  return {
    id: r.id as string,
    threadId: (r.thread_id as string) ?? undefined,
    workspaceId: r.workspace_id as string,
    title: r.title as string,
    details: (r.details as string) ?? undefined,
    status: r.status as Todo['status'],
    parentId: (r.parent_id as string) ?? undefined,
    priority: r.priority as number,
    assignee: (r.assignee as string) ?? undefined,
    sourceEventId: (r.source_event_id as string) ?? undefined,
    result: (r.result as string) ?? undefined,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    durable: !!r.durable,
    source: r.source === 'user' ? 'user' : 'agent'
  }
}

/** A thread's checklist in display order: manual order (priority, high first), then creation. */
export function listTodos(threadId?: string): Todo[] {
  const rows = (
    threadId
      ? prep('SELECT * FROM todos WHERE thread_id = ? ORDER BY priority DESC, created_at, id').all(threadId)
      : prep('SELECT * FROM todos ORDER BY priority DESC, created_at, id').all()
  ) as Record<string, unknown>[]
  return rows.map(rowToTodo)
}

export function getTodo(id: string): Todo | null {
  const row = prep('SELECT * FROM todos WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToTodo(row) : null
}

export function upsertTodo(todo: Partial<Todo> & { title: string; workspaceId: string }): Todo {
  const now = Date.now()
  const full: Todo = {
    id: todo.id ?? ulid(),
    threadId: todo.threadId,
    workspaceId: todo.workspaceId,
    title: todo.title,
    details: todo.details,
    status: todo.status ?? 'todo',
    parentId: todo.parentId,
    priority: todo.priority ?? 0,
    assignee: todo.assignee,
    sourceEventId: todo.sourceEventId,
    result: todo.result,
    createdAt: todo.createdAt ?? now,
    updatedAt: now,
    durable: todo.durable ?? false,
    source: todo.source ?? 'agent'
  }
  // On update, a caller that doesn't say who it is keeps the row's provenance: the agent re-sending
  // a user-added item must not relabel it as its own. Priority likewise survives an update unless
  // explicitly set, so a manual reorder isn't undone by the agent's next full-list write.
  prep(
    `INSERT INTO todos (id, thread_id, workspace_id, title, details, status, parent_id, priority, assignee, source_event_id, result, created_at, updated_at, durable, source)
       VALUES (@id, @threadId, @workspaceId, @title, @details, @status, @parentId, @priority, @assignee, @sourceEventId, @result, @createdAt, @updatedAt, @durable, @source)
       ON CONFLICT(id) DO UPDATE SET title=@title, details=@details, status=@status, parent_id=@parentId,
         priority=COALESCE(@explicitPriority, priority), assignee=@assignee, result=@result, updated_at=@updatedAt, durable=@durable,
         source=COALESCE(@explicitSource, source)`
  ).run({
    ...full,
    threadId: full.threadId ?? null,
    details: full.details ?? null,
    parentId: full.parentId ?? null,
    assignee: full.assignee ?? null,
    sourceEventId: full.sourceEventId ?? null,
    result: full.result ?? null,
    durable: full.durable ? 1 : 0,
    explicitPriority: todo.priority ?? null,
    explicitSource: todo.source ?? null
  })
  return getTodo(full.id) ?? full
}

/** Write several items atomically (one transaction) — the tool's full-list update. */
export function upsertTodos(items: (Partial<Todo> & { title: string; workspaceId: string })[]): Todo[] {
  return getDb().transaction(() => items.map(upsertTodo))()
}

/** Patch one item in place. Returns null when the id is unknown. */
export function updateTodo(id: string, patch: TodoPatch): Todo | null {
  const current = getTodo(id)
  if (!current) return null
  const title = patch.title !== undefined ? patch.title.trim() : current.title
  if (!title) return current
  // A parent must be a different item in the same thread, never the item itself or a descendant
  // (that would detach a cycle from every root and make it vanish from the panel).
  let parentId = patch.parentId === undefined ? current.parentId : patch.parentId || undefined
  if (parentId === id || (parentId && descendantIds(id).has(parentId))) parentId = current.parentId
  return upsertTodo({
    ...current,
    title,
    details: patch.details === undefined ? current.details : patch.details || undefined,
    status: patch.status && isTodoStatus(patch.status) ? patch.status : current.status,
    parentId,
    priority: patch.priority ?? current.priority,
    createdAt: current.createdAt
  })
}

/** Ids of every item nested (at any depth) under `id`, within its thread. */
function descendantIds(id: string): Set<string> {
  const root = getTodo(id)
  if (!root) return new Set()
  const all = listTodos(root.threadId)
  const kids = new Map<string, string[]>()
  for (const t of all) if (t.parentId) kids.set(t.parentId, [...(kids.get(t.parentId) ?? []), t.id])
  const out = new Set<string>()
  const stack = [id]
  while (stack.length) {
    for (const c of kids.get(stack.pop()!) ?? []) if (!out.has(c)) { out.add(c); stack.push(c) }
  }
  return out
}

/** Delete an item together with its subtasks. Unknown ids are a no-op. */
export function deleteTodo(id: string): void {
  const ids = [id, ...descendantIds(id)]
  getDb().transaction(() => {
    for (const x of ids) prep('DELETE FROM todos WHERE id = ?').run(x)
  })()
}

/** Delete several items (and their subtasks) atomically. */
export function deleteTodos(ids: string[]): void {
  getDb().transaction(() => {
    for (const id of ids) deleteTodo(id)
  })()
}

/**
 * Clear a thread's checklist: `done` removes finished items (done + canceled) — a finished parent
 * takes its subtasks with it — and `all` empties the list. Returns how many rows were removed.
 */
export function clearTodos(threadId: string, mode: 'done' | 'all'): number {
  if (mode === 'all') return prep('DELETE FROM todos WHERE thread_id = ?').run(threadId).changes
  const before = listTodos(threadId).length
  const finished = listTodos(threadId).filter((t) => t.status === 'done' || t.status === 'canceled')
  deleteTodos(finished.map((t) => t.id))
  return before - listTodos(threadId).length
}

/**
 * Persist a manual order: the first id gets the highest priority. Ids from other threads are
 * ignored; items not mentioned keep their priority (they fall in behind, by creation time).
 */
export function reorderTodos(threadId: string, orderedIds: string[]): void {
  const own = new Set(listTodos(threadId).map((t) => t.id))
  const ids = orderedIds.filter((id) => own.has(id))
  const now = Date.now()
  getDb().transaction(() => {
    ids.forEach((id, i) => {
      prep('UPDATE todos SET priority = ?, updated_at = ? WHERE id = ?').run(ids.length - i, now, id)
    })
  })()
}

// ---------- memory ----------

export function listMemory(): MemoryItem[] {
  const rows = getDb().prepare('SELECT * FROM memory ORDER BY updated_at DESC').all() as Record<
    string,
    unknown
  >[]
  return rows.map((r) => ({
    id: r.id as string,
    scope: r.scope as MemoryItem['scope'],
    scopeId: (r.scope_id as string) ?? undefined,
    type: r.type as MemoryItem['type'],
    content: r.content as string,
    sourceEventId: (r.source_event_id as string) ?? undefined,
    author: r.author as MemoryItem['author'],
    confidence: r.confidence as number,
    sensitivity: r.sensitivity as MemoryItem['sensitivity'],
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number,
    lastUsedAt: (r.last_used_at as number) ?? undefined,
    expiresAt: (r.expires_at as number) ?? undefined,
    version: r.version as number,
    status: r.status as MemoryItem['status'],
    pinned: !!r.pinned
  }))
}

export function upsertMemory(item: Partial<MemoryItem> & { content: string }): MemoryItem {
  const now = Date.now()
  const existing = item.id
    ? (getDb().prepare('SELECT * FROM memory WHERE id = ?').get(item.id) as Record<string, unknown> | undefined)
    : undefined
  const full: MemoryItem = {
    id: item.id ?? ulid(),
    scope: item.scope ?? (existing?.scope as MemoryItem['scope'] | undefined) ?? 'user',
    scopeId: item.scopeId ?? ((existing?.scope_id as string | null) ?? undefined),
    type: item.type ?? (existing?.type as MemoryItem['type'] | undefined) ?? 'note',
    content: item.content,
    sourceEventId: item.sourceEventId ?? ((existing?.source_event_id as string | null) ?? undefined),
    author: item.author ?? (existing?.author as MemoryItem['author'] | undefined) ?? 'user',
    confidence: item.confidence ?? (existing?.confidence as number | undefined) ?? 1,
    sensitivity: item.sensitivity ?? (existing?.sensitivity as MemoryItem['sensitivity'] | undefined) ?? 'normal',
    createdAt: item.createdAt ?? (existing?.created_at as number | undefined) ?? now,
    updatedAt: now,
    lastUsedAt: item.lastUsedAt ?? ((existing?.last_used_at as number | null) ?? undefined),
    expiresAt: item.expiresAt ?? ((existing?.expires_at as number | null) ?? undefined),
    version: (item.version ?? (existing?.version as number | undefined) ?? 0) + 1,
    status: item.status ?? (existing?.status as MemoryItem['status'] | undefined) ?? 'approved',
    pinned: item.pinned ?? (existing ? !!existing.pinned : false)
  }
  getDb()
    .prepare(
      `INSERT INTO memory (id, scope, scope_id, type, content, source_event_id, author, confidence, sensitivity, created_at, updated_at, last_used_at, expires_at, version, status, pinned)
       VALUES (@id, @scope, @scopeId, @type, @content, @sourceEventId, @author, @confidence, @sensitivity, @createdAt, @updatedAt, @lastUsedAt, @expiresAt, @version, @status, @pinned)
       ON CONFLICT(id) DO UPDATE SET scope=@scope, scope_id=@scopeId, type=@type, content=@content,
         source_event_id=@sourceEventId, author=@author, confidence=@confidence,
         sensitivity=@sensitivity, updated_at=@updatedAt, last_used_at=@lastUsedAt,
         expires_at=@expiresAt, version=@version, status=@status, pinned=@pinned`
    )
    .run({
      ...full,
      scopeId: full.scopeId ?? null,
      sourceEventId: full.sourceEventId ?? null,
      lastUsedAt: full.lastUsedAt ?? null,
      expiresAt: full.expiresAt ?? null,
      pinned: full.pinned ? 1 : 0
    })
  return full
}

export function deleteMemory(id: string): void {
  getDb().prepare('DELETE FROM memory WHERE id = ?').run(id)
}

// ---------- mcp ----------

export function listMcpConfigs(): McpServerConfig[] {
  const rows = getDb().prepare('SELECT config_json FROM mcp_servers').all() as {
    config_json: string
  }[]
  return rows.map((r) => JSON.parse(r.config_json))
}

export function upsertMcpConfig(config: McpServerConfig): void {
  getDb()
    .prepare(
      'INSERT INTO mcp_servers (id, config_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET config_json = excluded.config_json'
    )
    .run(config.id, JSON.stringify(config))
}

export function deleteMcpConfig(id: string): void {
  getDb().prepare('DELETE FROM mcp_servers WHERE id = ?').run(id)
}

// ---------- per-thread loaded deferred tools ----------
// Names only: resolution against the live MCP registry happens in toolCatalog, so a name whose
// server is currently disconnected is simply dormant (not dropped) until the server returns.

/** The deferred tool names a thread has loaded, in load order. */
export function listThreadTools(threadId: ThreadId): string[] {
  const rows = prep('SELECT name FROM thread_tools WHERE thread_id = ? ORDER BY ord ASC').all(threadId) as {
    name: string
  }[]
  return rows.map((r) => r.name)
}

/** Replace a thread's loaded set with `names` (their array order becomes the load order). */
export function saveThreadTools(threadId: ThreadId, names: string[]): void {
  const db = getDb()
  const replace = db.transaction((list: string[]) => {
    db.prepare('DELETE FROM thread_tools WHERE thread_id = ?').run(threadId)
    const insert = db.prepare('INSERT INTO thread_tools (thread_id, name, ord) VALUES (?, ?, ?)')
    list.forEach((name, ord) => insert.run(threadId, name, ord))
  })
  replace(names)
}

export function clearThreadTools(threadId: ThreadId): void {
  getDb().prepare('DELETE FROM thread_tools WHERE thread_id = ?').run(threadId)
}

// ---------- model cache ----------

/**
 * In-memory face of the model_cache table. A provider's model listing can run to hundreds of KB of
 * JSON, and it is consulted constantly (provider routing, the live context-budget tick, the
 * auto-compaction check) — re-parsing it from SQLite each time was measurable main-process CPU.
 * All writes go through setCachedModels in this process, which keeps the memo coherent. The models
 * array is shared with callers (they treat listings as read-only, exactly as the pre-memo code's
 * per-call parse results were treated); the wrapper object is copied per call.
 */
const modelMemo = new Map<string, { models: ModelInfo[]; fetchedAt: number } | null>()

export function getCachedModels(providerId: string): { models: ModelInfo[]; fetchedAt: number } | null {
  const hit = modelMemo.get(providerId)
  if (hit !== undefined) return hit ? { ...hit } : null
  const row = prep('SELECT models_json, fetched_at FROM model_cache WHERE provider_id = ?').get(providerId) as
    | { models_json: string; fetched_at: number }
    | undefined
  const value = row ? { models: JSON.parse(row.models_json) as ModelInfo[], fetchedAt: row.fetched_at } : null
  modelMemo.set(providerId, value)
  return value ? { ...value } : null
}

export function setCachedModels(providerId: string, models: ModelInfo[]): void {
  const fetchedAt = Date.now()
  prep(
    'INSERT INTO model_cache (provider_id, models_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET models_json = excluded.models_json, fetched_at = excluded.fetched_at'
  ).run(providerId, JSON.stringify(models), fetchedAt)
  modelMemo.set(providerId, { models, fetchedAt })
}

/**
 * Drop the in-memory memos (settings, model cache) so the next read re-parses from SQLite. Only
 * needed by code that mutates the underlying tables directly instead of going through this
 * module's writers — in practice, tests that reset tables with raw SQL between cases.
 */
export function resetStoreMemos(): void {
  settingsMemo = null
  modelMemo.clear()
}

// A fresh DB connection (tests, recovery) must not see the previous connection's memos.
onDbClose(() => {
  resetStoreMemos()
  seqCounters.clear()
})
