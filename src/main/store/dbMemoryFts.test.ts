import { afterAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Upgrade path for a store created before the memory index worked: the original `memory_fts` was
 * declared (default tokenizer), never populated, and never queried. Opening such a store must
 * rebuild it with porter stemming, add the sync triggers and the new columns, and leave every
 * existing row searchable — without touching the rows themselves.
 */
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-db-fts-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

// Seed an OLD-schema database before the app's db module ever opens it.
mkdirSync(join(mockDataDir, 'data'), { recursive: true })
const legacy = new Database(join(mockDataDir, 'data', 'lattice.db'))
legacy.exec(`
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE memory (
    id TEXT PRIMARY KEY, scope TEXT NOT NULL, scope_id TEXT, type TEXT NOT NULL, content TEXT NOT NULL,
    source_event_id TEXT, author TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
    sensitivity TEXT NOT NULL DEFAULT 'normal', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    last_used_at INTEGER, expires_at INTEGER, version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'approved', pinned INTEGER NOT NULL DEFAULT 0
  );
  CREATE VIRTUAL TABLE memory_fts USING fts5(content, content='memory', content_rowid='rowid');
  INSERT INTO memory (id, scope, type, content, author, created_at, updated_at)
    VALUES ('m1', 'user', 'preference', 'The user prefers terse answers', 'model', 1, 1),
           ('m2', 'user', 'fact', 'Runs everything through pnpm workspaces', 'model', 2, 2);
`)
// Prove the legacy index is empty (the bug being migrated away from).
expect((legacy.prepare(`SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'terse'`).get() as { n: number }).n).toBe(0)
legacy.close()

import { closeDb, getDb } from './db'
import * as store from './eventStore'

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('memory FTS migration on an existing store', () => {
  it('rebuilds the index with stemming, adds triggers and columns, and keeps rows intact', () => {
    const db = getDb()
    expect((db.prepare(`SELECT value FROM meta WHERE key = 'memory_fts_version'`).get() as { value: string }).value).toBe('2')
    const triggers = (db.prepare(`SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'memory'`).all() as { name: string }[]).map((t) => t.name).sort()
    expect(triggers).toEqual(['memory_fts_ad', 'memory_fts_ai', 'memory_fts_au'])
    const cols = (db.prepare('PRAGMA table_info(memory)').all() as { name: string }[]).map((c) => c.name)
    expect(cols).toEqual(expect.arrayContaining(['reviewed_at', 'use_count']))

    // Existing rows are searchable immediately, with stemming ("preference" → "prefers").
    expect(store.searchMemoryFts(['preference']).map((m) => m.id)).toEqual(['m1'])
    expect(store.searchMemoryFts(['workspace']).map((m) => m.id)).toEqual(['m2'])
    expect(store.listMemory()).toHaveLength(2)
    expect(store.getMemory('m1')).toMatchObject({ useCount: 0, reviewedAt: undefined })

    // And the triggers keep it that way for new writes.
    const fresh = store.upsertMemory({ content: 'Deploys with electron-builder', author: 'model' })
    expect(store.searchMemoryFts(['deploy']).map((m) => m.id)).toEqual([fresh.id])
    store.deleteMemory(fresh.id)
    expect(store.searchMemoryFts(['deploy'])).toEqual([])
  })

  it('is idempotent on reopen', () => {
    closeDb()
    const db = getDb()
    expect((db.prepare(`SELECT count(*) AS n FROM memory_fts WHERE memory_fts MATCH 'terse'`).get() as { n: number }).n).toBe(1)
  })
})
