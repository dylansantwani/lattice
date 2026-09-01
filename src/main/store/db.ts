import Database from 'better-sqlite3'
import { app } from 'electron'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

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
  compacted INTEGER NOT NULL DEFAULT 0,
  queued INTEGER NOT NULL DEFAULT 0
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

CREATE TABLE IF NOT EXISTS model_cache (
  provider_id TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`

let db: Database.Database | null = null

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
  const addColumn = (table: string, column: string, ddl: string): void => {
    const cols = database.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
    if (!cols.some((c) => c.name === column)) {
      database.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`)
    }
  }
  addColumn('threads', 'goal', 'goal TEXT')
  addColumn('threads', 'group_id', 'group_id TEXT')
  addColumn('messages', 'compacted', 'compacted INTEGER NOT NULL DEFAULT 0')
  addColumn('messages', 'queued', 'queued INTEGER NOT NULL DEFAULT 0')
}

export function closeDb(): void {
  db?.close()
  db = null
}
