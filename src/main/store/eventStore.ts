import { ulid } from '@shared/id'
import { getDb } from './db'
import type {
  AppSettings,
  ChatMessage,
  MemoryItem,
  RunEvent,
  RunEventBody,
  ThreadId,
  ThreadMeta,
  ThreadSearchHit,
  Todo,
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
    roots: [process.env.HOME ?? '/'],
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
}): ThreadMeta {
  const now = Date.now()
  const meta: ThreadMeta = {
    id: ulid(),
    workspaceId: opts.workspaceId,
    title: opts.title ?? 'New thread',
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
    goal: opts.goal
  }
  getDb()
    .prepare(
      `INSERT INTO threads (id, workspace_id, title, created_at, updated_at, pinned, archived, model, effort, mode, permission_preset, parent_thread_id, parent_event_id, goal)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      meta.id,
      meta.workspaceId,
      meta.title,
      meta.createdAt,
      meta.updatedAt,
      meta.model,
      meta.effort ?? null,
      meta.mode,
      meta.permissionPreset,
      meta.parentThreadId ?? null,
      meta.parentEventId ?? null,
      meta.goal ?? null
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
  const row = getDb().prepare('SELECT * FROM threads WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToThread(row) : null
}

export function updateThread(id: ThreadId, patch: Partial<ThreadMeta>): ThreadMeta {
  const current = getThreadMeta(id)
  if (!current) throw new Error(`thread not found: ${id}`)
  const next = { ...current, ...patch, id, updatedAt: Date.now() }
  // A blank goal clears it (stored as NULL) rather than persisting an empty string.
  const goal = next.goal && next.goal.trim() ? next.goal.trim() : null
  next.goal = goal ?? undefined
  getDb()
    .prepare(
      `UPDATE threads SET title=?, updated_at=?, pinned=?, archived=?, model=?, effort=?, mode=?, permission_preset=?, goal=? WHERE id=?`
    )
    .run(
      next.title,
      next.updatedAt,
      next.pinned ? 1 : 0,
      next.archived ? 1 : 0,
      next.model,
      next.effort ?? null,
      next.mode,
      next.permissionPreset,
      goal,
      id
    )
  return next
}

export function deleteThread(id: ThreadId): void {
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(id)
  db.prepare('DELETE FROM events WHERE thread_id = ?').run(id)
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
    parentThreadId: (r.parent_thread_id as string) ?? undefined,
    parentEventId: (r.parent_event_id as string) ?? undefined,
    goal: (r.goal as string) ?? undefined
  }
}

// ---------- messages ----------

export function insertMessage(msg: ChatMessage): void {
  getDb()
    .prepare(
      `INSERT INTO messages (id, thread_id, run_id, role, created_at, text, model, effort, status, telemetry_json, attachments_json, compacted, queued)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
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
      msg.compacted ? 1 : 0,
      msg.queued ? 1 : 0
    )
  getDb().prepare('UPDATE threads SET updated_at = ? WHERE id = ?').run(Date.now(), msg.threadId)
}

export function updateMessage(id: string, patch: Partial<ChatMessage>): ChatMessage | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  if (!row) return null
  const current = rowToMessage(row)
  const next = { ...current, ...patch, id }
  getDb()
    .prepare(
      `UPDATE messages SET text=?, status=?, telemetry_json=?, model=?, effort=?, run_id=?, queued=? WHERE id=?`
    )
    .run(
      next.text,
      next.status ?? null,
      next.telemetry ? JSON.stringify(next.telemetry) : null,
      next.model ?? null,
      next.effort ?? null,
      next.runId ?? null,
      next.queued ? 1 : 0,
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

/** Permanently remove a single message (used to drop a queued turn the user removed). */
export function deleteMessage(id: string): void {
  getDb().prepare('DELETE FROM messages WHERE id = ?').run(id)
}

export function listMessages(threadId: ThreadId): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at, id')
    .all(threadId) as Record<string, unknown>[]
  return rows.map(rowToMessage)
}

/** Mark a set of messages as compacted (folded into a summary; no longer sent to the model in full). */
export function markMessagesCompacted(ids: string[]): void {
  if (!ids.length) return
  const stmt = getDb().prepare('UPDATE messages SET compacted = 1 WHERE id = ?')
  const tx = getDb().transaction((list: string[]) => {
    for (const id of list) stmt.run(id)
  })
  tx(ids)
}

/** Delete every message and run event for a thread, leaving the thread and its settings intact. */
export function clearThreadContent(threadId: ThreadId): void {
  const db = getDb()
  db.prepare('DELETE FROM messages WHERE thread_id = ?').run(threadId)
  db.prepare('DELETE FROM events WHERE thread_id = ?').run(threadId)
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
    compacted: !!r.compacted,
    queued: !!r.queued
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
    const row = getDb().prepare('SELECT MAX(seq) as m FROM events WHERE run_id = ?').get(runId) as {
      m: number | null
    }
    seq = (row.m ?? -1) + 1
  } else {
    seq += 1
  }
  seqCounters.set(runId, seq)
  const ev: RunEvent = { id: ulid(), runId, threadId, seq, ts: Date.now(), agent, body }
  getDb()
    .prepare('INSERT INTO events (id, run_id, thread_id, seq, ts, agent, body_json) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(ev.id, runId, threadId, seq, ev.ts, agent ?? null, JSON.stringify(body))
  return ev
}

export function listEvents(threadId: ThreadId): RunEvent[] {
  const rows = getDb()
    .prepare('SELECT * FROM events WHERE thread_id = ? ORDER BY ts, seq')
    .all(threadId) as Record<string, unknown>[]
  return rows.map((r) => ({
    id: r.id as string,
    runId: r.run_id as string,
    threadId: r.thread_id as string,
    seq: r.seq as number,
    ts: r.ts as number,
    agent: (r.agent as string) ?? undefined,
    body: JSON.parse(r.body_json as string)
  }))
}

// ---------- settings ----------

export function getSettings(): AppSettings {
  const row = getDb().prepare("SELECT value_json FROM settings WHERE key = 'app'").get() as
    | { value_json: string }
    | undefined
  if (!row) return { ...DEFAULT_SETTINGS }
  return { ...DEFAULT_SETTINGS, ...JSON.parse(row.value_json) }
}

export function setSettings(patch: Partial<AppSettings>): AppSettings {
  const next = { ...getSettings(), ...patch }
  getDb()
    .prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json")
    .run(JSON.stringify(next))
  return next
}

// ---------- todos ----------

export function listTodos(threadId?: string): Todo[] {
  const rows = (
    threadId
      ? getDb().prepare('SELECT * FROM todos WHERE thread_id = ? ORDER BY priority DESC, created_at').all(threadId)
      : getDb().prepare('SELECT * FROM todos ORDER BY priority DESC, created_at').all()
  ) as Record<string, unknown>[]
  return rows.map((r) => ({
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
    durable: !!r.durable
  }))
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
    durable: todo.durable ?? false
  }
  getDb()
    .prepare(
      `INSERT INTO todos (id, thread_id, workspace_id, title, details, status, parent_id, priority, assignee, source_event_id, result, created_at, updated_at, durable)
       VALUES (@id, @threadId, @workspaceId, @title, @details, @status, @parentId, @priority, @assignee, @sourceEventId, @result, @createdAt, @updatedAt, @durable)
       ON CONFLICT(id) DO UPDATE SET title=@title, details=@details, status=@status, parent_id=@parentId, priority=@priority, assignee=@assignee, result=@result, updated_at=@updatedAt, durable=@durable`
    )
    .run({
      ...full,
      threadId: full.threadId ?? null,
      details: full.details ?? null,
      parentId: full.parentId ?? null,
      assignee: full.assignee ?? null,
      sourceEventId: full.sourceEventId ?? null,
      result: full.result ?? null,
      durable: full.durable ? 1 : 0
    })
  return full
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

// ---------- model cache ----------

export function getCachedModels(providerId: string): { models: ModelInfo[]; fetchedAt: number } | null {
  const row = getDb().prepare('SELECT models_json, fetched_at FROM model_cache WHERE provider_id = ?').get(providerId) as
    | { models_json: string; fetched_at: number }
    | undefined
  return row ? { models: JSON.parse(row.models_json), fetchedAt: row.fetched_at } : null
}

export function setCachedModels(providerId: string, models: ModelInfo[]): void {
  getDb()
    .prepare(
      'INSERT INTO model_cache (provider_id, models_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT(provider_id) DO UPDATE SET models_json = excluded.models_json, fetched_at = excluded.fetched_at'
    )
    .run(providerId, JSON.stringify(models), Date.now())
}
