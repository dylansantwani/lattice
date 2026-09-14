CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  roots_json TEXT NOT NULL DEFAULT '[]',
  created_at INTEGER NOT NULL
);
CREATE TABLE threads (
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
, group_id TEXT, title_source TEXT NOT NULL DEFAULT 'user', title_msgs INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0, cwd TEXT);
CREATE INDEX idx_threads_updated ON threads(updated_at DESC);
CREATE TABLE thread_groups (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  name TEXT NOT NULL,
  color TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX idx_thread_groups_ws ON thread_groups(workspace_id, sort_order);
CREATE TABLE messages (
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
, reasoning_content TEXT);
CREATE INDEX idx_messages_thread ON messages(thread_id, created_at);
CREATE TABLE events (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts INTEGER NOT NULL,
  agent TEXT,
  body_json TEXT NOT NULL
);
CREATE INDEX idx_events_run ON events(run_id, seq);
CREATE INDEX idx_events_thread ON events(thread_id, ts);
CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);
CREATE TABLE todos (
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
, source TEXT NOT NULL DEFAULT 'agent');
CREATE INDEX idx_todos_thread ON todos(thread_id);
CREATE TABLE memory (
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
, reviewed_at INTEGER, use_count INTEGER NOT NULL DEFAULT 0);
CREATE TABLE permission_rules (
  id TEXT PRIMARY KEY,
  rule_json TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE mcp_servers (
  id TEXT PRIMARY KEY,
  config_json TEXT NOT NULL
);
CREATE TABLE thread_tools (
  thread_id TEXT NOT NULL,
  name TEXT NOT NULL,
  ord INTEGER NOT NULL,
  PRIMARY KEY (thread_id, name)
);
CREATE TABLE model_cache (
  provider_id TEXT PRIMARY KEY,
  models_json TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
CREATE TABLE session_messages (
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
CREATE INDEX idx_session_messages_to ON session_messages(to_thread_id, created_at);
CREATE TABLE file_changes (
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
CREATE INDEX idx_file_changes_thread ON file_changes(thread_id, last_at);
CREATE INDEX idx_memory_pinned ON memory(pinned, status);
CREATE INDEX idx_memory_scope ON memory(scope, scope_id);
CREATE INDEX idx_memory_status_updated ON memory(status, updated_at DESC);
CREATE TABLE memory_distill_marks (
  thread_id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memory', content_rowid='rowid', tokenize='porter unicode61')
/* memory_fts(content) */;
CREATE TRIGGER memory_fts_ai AFTER INSERT ON memory BEGIN
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
CREATE TRIGGER memory_fts_ad AFTER DELETE ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    END;
CREATE TRIGGER memory_fts_au AFTER UPDATE OF content ON memory BEGIN
      INSERT INTO memory_fts(memory_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
      INSERT INTO memory_fts(rowid, content) VALUES (new.rowid, new.content);
    END;
