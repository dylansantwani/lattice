import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'
import type { MessageOrigin } from '@shared/types'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roots_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  archived INTEGER NOT NULL DEFAULT 0,
  model TEXT NOT NULL,
  effort TEXT,
  mode TEXT NOT NULL DEFAULT 'act',
  permission_preset TEXT NOT NULL DEFAULT 'workspace',
  parent_thread_id TEXT,
  parent_event_id TEXT,
  goal TEXT
);
CREATE INDEX IF NOT EXISTS idx_threads_updated ON threads(updated_at DESC);

CREATE TABLE IF NOT EXISTS thread_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_thread_groups_ws ON thread_groups(workspace_id, sort_order);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  run_id TEXT,
  role TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  text TEXT NOT NULL DEFAULT '',
  model TEXT,
  effort TEXT,
  status TEXT,
  telemetry_json TEXT,
  attachments_json TEXT,
  tool_wire_json TEXT,
  compacted INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0,
  origin_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  agent TEXT,
  body_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_run ON events(run_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_thread ON events(thread_id, ts);

CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS todos (
  id TEXT PRIMARY KEY,
  thread_id TEXT,
  workspace_id TEXT NOT NULL,
  title TEXT NOT NULL,
  details TEXT,
  status TEXT NOT NULL DEFAULT 'todo',
  parent_id TEXT,
  priority INTEGER NOT NULL DEFAULT 0,
  assignee TEXT,
  source_event_id TEXT,
  result TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  durable INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_todos_thread ON todos(thread_id);

CREATE TABLE IF NOT EXISTS memory (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  scope_id TEXT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  source_event_id TEXT,
  author TEXT NOT NULL,
  confidence REAL NOT NULL DEFAULT 1.0,
  sensitivity TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_used_at INTEGER,
  expires_at INTEGER,
  version INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'approved',
  pinned INTEGER NOT NULL DEFAULT 0
);
CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(content, content='memory', content_rowid='rowid');

CREATE TABLE IF NOT EXISTS permission_rules (
  id TEXT PRIMARY KEY,
  rule_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL
);

-- The deferred (MCP) tools a thread has loaded, in load order. Persisted so a relaunch does not
-- forget them: the transcript still references those tools by name, and the model calls them
-- again on the next turn. See src/main/runtime/toolCatalog.ts.
CREATE TABLE IF NOT EXISTS thread_tools (
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (thread_id, name)
);

CREATE TABLE IF NOT EXISTS model_cache (
  provider_id TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_messages (
  id TEXT PRIMARY KEY,
  from_thread_id TEXT NOT NULL,
  to_thread_id TEXT NOT NULL,
  from_title TEXT NOT NULL,
  from_kind TEXT NOT NULL DEFAULT 'session',
  from_agent_id TEXT,
  body TEXT NOT NULL,
  reply_to TEXT,
  created_at INTEGER NOT NULL,
  read_at INTEGER,
  delivery TEXT NOT NULL DEFAULT 'queued'
);
CREATE INDEX IF NOT EXISTS idx_session_messages_to ON session_messages(to_thread_id, created_at);

-- One row per (thread, path) the agent touched: the pre-edit baseline and the current content, so
-- the Files inspector can show a real session diff. before_content is NULL for a file the agent
-- created; after_content is NULL for one it deleted.
CREATE TABLE IF NOT EXISTS file_changes (
  thread_id TEXT NOT NULL,
  path TEXT NOT NULL,
  kind TEXT NOT NULL,
  before_content TEXT,
  after_content TEXT,
  before_truncated INTEGER NOT NULL DEFAULT 0,
  after_truncated INTEGER NOT NULL DEFAULT 0,
  first_at INTEGER NOT NULL,
  last_at INTEGER NOT NULL,
  PRIMARY KEY (thread_id, path)
);
CREATE INDEX IF NOT EXISTS idx_file_changes_thread ON file_changes(thread_id, last_at);
`

let db: Database.Database | null = null

/**
 * Compiled-statement cache. `db.prepare()` re-compiles the SQL text on every call, and the hot
 * paths (event appends, streaming message flushes, per-round meta reads) run the same handful of
 * statements thousands of times per session. Statements are safe to reuse here because every
 * caller runs them synchronously to completion (run/get/all — no held iterators). Keyed by SQL
 * text; cleared with the connection so a reopened database never sees a stale handle.
 */
const stmtCache = new Map<string, Database.Statement>()

/** Listeners that must drop in-memory caches when the connection closes (see eventStore). */
const closeListeners: (() => void)[] = []
export function onDbClose(listener: () => void): void {
  closeListeners.push(listener)
}

/** A prepared statement for `sql`, compiled once per connection and reused thereafter. */
export function prep(sql: string): Database.Statement {
  const cached = stmtCache.get(sql)
  if (cached) return cached
  const stmt = getDb().prepare(sql)
  stmtCache.set(sql, stmt)
  return stmt
}

export function getDb(): Database.Database {
  if (db) return db
  const dir = join(app.getPath('userData'), 'data')
  mkdirSync(dir, { recursive: true })
  db = new Database(join(dir, 'lattice.db'))
  db.pragma('journal_mode = WAL')
  db.pragma('synchronous = NORMAL')
  db.pragma('foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

/**
 * Additive column migrations for databases created before a column existed.
 * `CREATE TABLE IF NOT EXISTS` never alters an existing table, so new columns are
 * backfilled here. Each entry is idempotent — it only adds the column when absent.
 */
function migrate(database: Database.Database): void {
  const addColumn = (table: string, column: string, ddl: string): boolean => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
      return true
    }
    return false
  }
  addColumn('threads', 'goal', 'goal TEXT')
  addColumn('threads', 'group_id', 'group_id TEXT')
  // Title provenance for auto-retitling. Existing threads default conservatively to 'user' (their
  // titles are never rewritten automatically), EXCEPT ones still on the untouched default 'New
  // thread', which are exactly the auto-titling population. Backfilled only when the column is
  // first added so a later user rename to anything is never re-flagged.
  if (addColumn('threads', 'title_source', "title_source TEXT NOT NULL DEFAULT 'user'")) {
    database.exec(`UPDATE threads SET title_source = 'auto' WHERE title = 'New thread'`)
  }
  addColumn('threads', 'title_msgs', 'title_msgs INTEGER NOT NULL DEFAULT 0')
  addColumn('messages', 'compacted', 'compacted INTEGER NOT NULL DEFAULT 0')
  // Checklist provenance (agent via todo_write vs. the user editing the Tasks panel by hand).
  addColumn('todos', 'source', "source TEXT NOT NULL DEFAULT 'agent'")
  // Tool-supplied checklist ids ("1", "2a") used to be stored bare, so every run that numbered its
  // items from 1 silently overwrote another thread's rows (id is the primary key). They are now
  // scoped as `<threadId>:<key>`; rewrite legacy bare keys once. Store-generated ULIDs are 26
  // chars with no colon and are left alone. Idempotent: a scoped id contains ':' and is skipped.
  database.exec(
    `UPDATE todos SET parent_id = thread_id || ':' || parent_id
      WHERE thread_id IS NOT NULL AND parent_id IS NOT NULL AND instr(parent_id, ':') = 0 AND length(parent_id) < 26`
  )
  database.exec(
    `UPDATE todos SET id = thread_id || ':' || id
      WHERE thread_id IS NOT NULL AND instr(id, ':') = 0 AND length(id) < 26`
  )
  addColumn('messages', 'queued', 'queued INTEGER NOT NULL DEFAULT 0')
  addColumn('messages', 'tool_wire_json', 'tool_wire_json TEXT')
  // Sender attribution for user-role turns that were not typed by the human (subagent completions,
  // background-command output, inter-session messages). Rows written before the column existed
  // carry only their machine-generated lead-in text; recover the origin from that once, when the
  // column is first added, so old completions stop rendering as bubbles the person appears to have
  // typed. See {@link inferLegacyOrigin}.
  if (addColumn('messages', 'origin_json', 'origin_json TEXT')) backfillLegacyOrigins(database)
  addColumn('session_messages', 'from_kind', "from_kind TEXT NOT NULL DEFAULT 'session'")
  addColumn('session_messages', 'from_agent_id', 'from_agent_id TEXT')
}

/**
 * Recover a {@link MessageOrigin} from the lead-in text of a user-role turn persisted before
 * `origin_json` existed. Each automated sender has a fixed, machine-written prefix a person would
 * never type, so the match is exact-prefix rather than fuzzy. Returns undefined for anything else
 * (an ordinary human message), which is left untouched.
 */
export function inferLegacyOrigin(text: string): MessageOrigin | undefined {
  // runManager.formatAgentCompletion: `🤖 Background agent "Name" finished.` / `… (id X) failed:`
  const agent = /^🤖 Background agent (?:"(.*?)"|\(id ([^)]+)\)) (?:finished|failed)/u.exec(text)
  if (agent) {
    const [, name, id] = agent
    return name !== undefined
      ? { kind: 'agent', label: name }
      : { kind: 'agent', label: `agent ${(id ?? '').slice(-6)}`, agentId: id }
  }
  // sessionMessaging.formatIncomingMessage: `📨 Message from session "T" (id X).` and
  // `📨 Message from subagent "T" (working under session id X).`
  const session = /^📨 Message from (session|subagent) "(.*?)" \((?:working under session )?id ([^)]+)\)\./u.exec(
    text
  )
  if (session) {
    const [, who, title, threadId] = session
    return { kind: who === 'subagent' ? 'agent' : 'session', label: title ?? '', fromThreadId: threadId }
  }
  // runManager.formatShellJobCompletion: every variant opens with `⏳ Background job …` or
  // `⏳ The command you started that ran past its timeout …`.
  if (/^⏳ (?:Background job |The command you started that ran past its timeout)/u.test(text)) {
    return { kind: 'shell', label: 'shell' }
  }
  return undefined
}

/** One-shot pass over pre-`origin_json` rows; see {@link inferLegacyOrigin}. Idempotent. */
function backfillLegacyOrigins(database: Database.Database): void {
  const rows = database
    .prepare(
      `SELECT id, text FROM messages WHERE role = 'user' AND origin_json IS NULL
         AND (text LIKE '🤖 Background agent %' OR text LIKE '📨 Message from %' OR text LIKE '⏳ %')`
    )
    .all() as { id: string; text: string }[]
  if (rows.length === 0) return
  const update = database.prepare('UPDATE messages SET origin_json = ? WHERE id = ?')
  database.transaction(() => {
    for (const row of rows) {
      const origin = inferLegacyOrigin(row.text)
      if (origin) update.run(JSON.stringify(origin), row.id)
    }
  })()
}

export function closeDb(): void {
  stmtCache.clear()
  for (const listener of closeListeners) listener()
  db?.close()
  db = null
}
