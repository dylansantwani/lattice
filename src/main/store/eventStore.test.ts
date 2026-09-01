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
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces')
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const mk = (title: string) => store.createThread({ workspaceId: wsId, title, model: 'm/x' })

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
