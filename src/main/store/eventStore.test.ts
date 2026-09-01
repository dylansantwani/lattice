import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-store-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from './eventStore'
import { getDb, closeDb } from './db'

let wsId: string

beforeEach(() => {
  // fresh slate per test
  const db = getDb()
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const mk = (title: string) => store.createThread({ workspaceId: wsId, title, model: 'm/x' })

describe('settings: defaults, merge, and forward-compat', () => {
  it('returns the full defaults when nothing is stored', () => {
    const s = store.getSettings()
    expect(s.defaultModel).toBe('cc/claude-fable-5')
    expect(s.defaultEffort).toBe('high')
    expect(s.temperature).toBeNull()
    expect(s.maxOutputTokens).toBe(0)
    expect(s.customInstructions).toBe('')
    expect(s.includeMemory).toBe(true)
    expect(s.sendKey).toBe('enter')
    expect(s.reasoningVisibility).toBe('auto')
  })

  it('a partial patch persists and preserves untouched fields', () => {
    store.setSettings({ temperature: 0.3, sendKey: 'mod-enter' })
    const first = store.setSettings({ customInstructions: 'be terse' })
    expect(first.temperature).toBe(0.3)
    expect(first.sendKey).toBe('mod-enter')
    expect(first.customInstructions).toBe('be terse')
    // a fresh read round-trips through the DB, not just the in-memory merge
    const reread = store.getSettings()
    expect(reread.temperature).toBe(0.3)
    expect(reread.sendKey).toBe('mod-enter')
    expect(reread.customInstructions).toBe('be terse')
  })

  it('round-trips temperature = 0 distinctly from the null default', () => {
    store.setSettings({ temperature: 0 })
    expect(store.getSettings().temperature).toBe(0)
  })

  it('backfills new fields onto an older settings row that predates them', () => {
    // simulate a settings row written before the new keys existed
    getDb()
      .prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?)")
      .run(JSON.stringify({ defaultModel: 'old/model', theme: 'midnight' }))
    const s = store.getSettings()
    expect(s.defaultModel).toBe('old/model') // stored value wins
    expect(s.theme).toBe('midnight')
    expect(s.includeMemory).toBe(true) // new field backfilled from defaults
    expect(s.sendKey).toBe('enter')
    expect(s.temperature).toBeNull()
  })
})

describe('thread lifecycle: pin, archive, rename, delete', () => {
  it('creates threads unpinned and unarchived', () => {
    const t = mk('hello')
    expect(t.pinned).toBe(false)
    expect(t.archived).toBe(false)
    expect(store.listThreads()).toHaveLength(1)
  })

  it('renames a thread and persists the new title', () => {
    const t = mk('old name')
    const updated = store.updateThread(t.id, { title: 'new name' })
    expect(updated.title).toBe('new name')
    expect(store.getThreadMeta(t.id)?.title).toBe('new name')
  })

  it('pins a thread and reflects it on read', () => {
    const t = mk('pin me')
    store.updateThread(t.id, { pinned: true })
    expect(store.getThreadMeta(t.id)?.pinned).toBe(true)
    store.updateThread(t.id, { pinned: false })
    expect(store.getThreadMeta(t.id)?.pinned).toBe(false)
  })

  it('hides archived threads from the default list but includes them on request', () => {
    const keep = mk('keep')
    const gone = mk('archive me')
    store.updateThread(gone.id, { archived: true })

    const visible = store.listThreads()
    expect(visible.map((t) => t.id)).toEqual([keep.id])

    const all = store.listThreads(undefined, true)
    expect(all.map((t) => t.id).sort()).toEqual([keep.id, gone.id].sort())

    // scoped-by-workspace variant honours the same filter
    expect(store.listThreads(wsId).map((t) => t.id)).toEqual([keep.id])
    expect(store.listThreads(wsId, true)).toHaveLength(2)
  })

  it('unarchives a thread back into the default list', () => {
    const t = mk('back')
    store.updateThread(t.id, { archived: true })
    expect(store.listThreads()).toHaveLength(0)
    store.updateThread(t.id, { archived: false })
    expect(store.listThreads().map((x) => x.id)).toEqual([t.id])
  })

  it('round-trips the queued flag and deletes a single queued message', () => {
    const t = mk('queue host')
    store.insertMessage({
      id: 'q1',
      threadId: t.id,
      role: 'user',
      createdAt: Date.now(),
      text: 'do this next',
      queued: true
    })
    store.insertMessage({
      id: 'm1',
      threadId: t.id,
      role: 'user',
      createdAt: Date.now() + 1,
      text: 'already sent'
    })

    // the queued flag survives a persist/read round-trip
    const [queuedMsg, normalMsg] = store.listMessages(t.id)
    expect(queuedMsg?.queued).toBe(true)
    expect(normalMsg?.queued).toBe(false)

    // starting the turn clears the flag and binds a run id
    const started = store.updateMessage('q1', { queued: false, runId: 'run-x' })
    expect(started?.queued).toBe(false)
    expect(started?.runId).toBe('run-x')
    expect(store.listMessages(t.id).find((m) => m.id === 'q1')?.queued).toBe(false)

    // removing a queued turn deletes just that message
    store.deleteMessage('m1')
    const remaining = store.listMessages(t.id)
    expect(remaining.map((m) => m.id)).toEqual(['q1'])
  })

  it('reconciles interrupted runs: finalizes dangling assistant messages as interrupted', () => {
    const live = mk('was mid-run at quit')
    const done = mk('finished cleanly')

    // an assistant message left unfinished when the app quit (NULL status)
    store.insertMessage({
      id: 'a-live',
      threadId: live.id,
      runId: 'run-live',
      role: 'assistant',
      createdAt: Date.now(),
      text: 'partial answer'
    })
    // a normally-completed assistant message must not be touched
    store.insertMessage({
      id: 'a-done',
      threadId: done.id,
      runId: 'run-done',
      role: 'assistant',
      createdAt: Date.now(),
      text: 'full answer',
      status: 'complete'
    })
    // a user message has no status and must never be marked interrupted
    store.insertMessage({
      id: 'u1',
      threadId: live.id,
      role: 'user',
      createdAt: Date.now(),
      text: 'a question'
    })

    const affected = store.reconcileInterruptedRuns()
    expect(affected).toEqual([live.id])

    const liveMsgs = store.listMessages(live.id)
    expect(liveMsgs.find((m) => m.id === 'a-live')?.status).toBe('interrupted')
    expect(liveMsgs.find((m) => m.id === 'u1')?.status).toBeUndefined()
    expect(store.listMessages(done.id).find((m) => m.id === 'a-done')?.status).toBe('complete')

    // idempotent: a second pass finds nothing left to reconcile
    expect(store.reconcileInterruptedRuns()).toEqual([])
  })

  it('deletes a thread along with its messages and events', () => {
    const t = mk('doomed')
    store.insertMessage({
      id: 'msg1',
      threadId: t.id,
      role: 'user',
      createdAt: Date.now(),
      text: 'hi'
    })
    store.appendEvent('run1', t.id, { type: 'run.completed', reason: 'done' })

    store.deleteThread(t.id)

    expect(store.getThreadMeta(t.id)).toBeNull()
    expect(store.listThreads(undefined, true)).toHaveLength(0)
    expect(store.listMessages(t.id)).toHaveLength(0)
    expect(store.listEvents(t.id)).toHaveLength(0)
  })
})
