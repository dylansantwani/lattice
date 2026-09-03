import { afterAll, describe, expect, it, vi } from 'vitest'
import Database from 'better-sqlite3'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-db-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import { closeDb, getDb, inferLegacyOrigin } from './db'

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('inferLegacyOrigin: recovers the sender from pre-origin_json lead-in text', () => {
  it('attributes a named subagent completion', () => {
    expect(
      inferLegacyOrigin('🤖 Background agent "Lattice Config Survey" finished. Its result is below — fold it in.\n\n# Report')
    ).toEqual({ kind: 'agent', label: 'Lattice Config Survey' })
  })

  it('attributes a failed, unnamed subagent by id', () => {
    expect(inferLegacyOrigin('🤖 Background agent (id 01JABCDEFG123456) failed: boom')).toEqual({
      kind: 'agent',
      label: 'agent 123456',
      agentId: '01JABCDEFG123456'
    })
  })

  it('attributes an inter-session message to the sending session', () => {
    expect(
      inferLegacyOrigin('📨 Message from session "Planning" (id thr_1). To reply, use send_message with to:"thr_1".\n\nhi')
    ).toEqual({ kind: 'session', label: 'Planning', fromThreadId: 'thr_1' })
  })

  it('attributes a message from a subagent in another session as an agent', () => {
    expect(
      inferLegacyOrigin(
        '📨 Message from subagent "Scout" (working under session id thr_9). To reply, use send_message with to:"ag_1".\n\nfound it'
      )
    ).toEqual({ kind: 'agent', label: 'Scout', fromThreadId: 'thr_9' })
  })

  it('attributes both background-shell completion variants to the shell', () => {
    expect(inferLegacyOrigin('⏳ Background job j1 has finished (exit 0) — `ls`. Its full output is below')).toEqual({
      kind: 'shell',
      label: 'shell'
    })
    expect(
      inferLegacyOrigin('⏳ The command you started that ran past its timeout has finished (exit 0) in the background — `sleep 99`.')
    ).toEqual({ kind: 'shell', label: 'shell' })
    expect(inferLegacyOrigin('⏳ Background job j2 finished: `ls` (output unavailable).')).toEqual({
      kind: 'shell',
      label: 'shell'
    })
  })

  it('leaves human-authored text alone, including near-misses', () => {
    expect(inferLegacyOrigin('hello')).toBeUndefined()
    expect(inferLegacyOrigin('Background agent finished — can you look?')).toBeUndefined()
    expect(inferLegacyOrigin('🤖 what does the background agent do?')).toBeUndefined()
    expect(inferLegacyOrigin('⏳ waiting on you')).toBeUndefined()
    expect(inferLegacyOrigin('📨 Message from my boss: ship it')).toBeUndefined()
  })
})

describe('migrate: origin_json backfill on a database created before the column existed', () => {
  it('tags legacy automated turns and leaves human turns and already-tagged rows untouched', () => {
    // Build the pre-origin_json shape by hand: CREATE TABLE IF NOT EXISTS in the live schema will
    // not touch it, so the migration must add the column and run the backfill.
    const dir = join(mockDataDir, 'data')
    mkdirSync(dir, { recursive: true })
    const raw = new Database(join(dir, 'lattice.db'))
    raw.exec(`CREATE TABLE messages (
      id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
      created_at INTEGER NOT NULL, text TEXT NOT NULL DEFAULT '', model TEXT, effort TEXT, status TEXT,
      telemetry_json TEXT, attachments_json TEXT, tool_wire_json TEXT,
      compacted INTEGER NOT NULL DEFAULT 0, queued INTEGER NOT NULL DEFAULT 0
    )`)
    const ins = raw.prepare(
      `INSERT INTO messages (id, thread_id, role, created_at, text) VALUES (?, 't', ?, ?, ?)`
    )
    ins.run('m1', 'user', 1, '🤖 Background agent "Survey" finished. Its result is below.\n\nreport')
    ins.run('m2', 'user', 2, 'please summarize that')
    ins.run('m3', 'user', 3, '📨 Message from session "Ops" (id thr_ops). To reply, use send_message with to:"thr_ops".\n\nping')
    ins.run('m4', 'user', 4, '⏳ Background job j7 has failed (exit 1) — `make`. Its full output is below\n\nerr')
    ins.run('m5', 'assistant', 5, '🤖 Background agent "Not me" finished.') // wrong role: never tagged
    raw.close()

    const db = getDb()
    const origin = (id: string): unknown => {
      const row = db.prepare('SELECT origin_json FROM messages WHERE id = ?').get(id) as { origin_json: string | null }
      return row.origin_json ? JSON.parse(row.origin_json) : null
    }
    expect(origin('m1')).toEqual({ kind: 'agent', label: 'Survey' })
    expect(origin('m2')).toBeNull()
    expect(origin('m3')).toEqual({ kind: 'session', label: 'Ops', fromThreadId: 'thr_ops' })
    expect(origin('m4')).toEqual({ kind: 'shell', label: 'shell' })
    expect(origin('m5')).toBeNull()
  })
})
