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
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings; DELETE FROM thread_groups; DELETE FROM thread_tools')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
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

  it('keeps a prompt above its same-millisecond reply regardless of id ordering', () => {
    const t = mk('order host')
    const ts = Date.now()
    // The user prompt and its assistant reply are inserted in the same millisecond
    // (no await between them in the run), so they share created_at. Give the reply an
    // id that sorts BEFORE the prompt's — the exact case an `ORDER BY ..., id` tie-break
    // got wrong, flipping the reply above the prompt on reload.
    store.insertMessage({ id: 'zzz-user', threadId: t.id, role: 'user', createdAt: ts, text: 'question' })
    store.insertMessage({ id: 'aaa-reply', threadId: t.id, role: 'assistant', createdAt: ts, text: 'answer' })

    // Insertion order (user, then assistant) must win, not the lexicographic id order.
    expect(store.listMessages(t.id).map((m) => m.id)).toEqual(['zzz-user', 'aaa-reply'])
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

  it('files a thread into a group and clears it back out', () => {
    const t = mk('groupable')
    const g = store.createThreadGroup({ workspaceId: wsId, name: 'Work' })
    const filed = store.setThreadGroup(t.id, g.id)
    expect(filed.groupId).toBe(g.id)
    expect(store.getThreadMeta(t.id)?.groupId).toBe(g.id)
    const cleared = store.setThreadGroup(t.id, null)
    expect(cleared.groupId).toBeUndefined()
    expect(store.getThreadMeta(t.id)?.groupId).toBeUndefined()
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

describe('thread groups', () => {
  it('creates groups with ascending sort order and lists them in order', () => {
    const a = store.createThreadGroup({ workspaceId: wsId, name: 'Alpha' })
    const b = store.createThreadGroup({ workspaceId: wsId, name: 'Beta' })
    expect(a.sortOrder).toBe(0)
    expect(b.sortOrder).toBe(1)
    expect(store.listThreadGroups(wsId).map((g) => g.name)).toEqual(['Alpha', 'Beta'])
  })

  it('updates a group name and color', () => {
    const g = store.createThreadGroup({ workspaceId: wsId, name: 'Draft' })
    const up = store.updateThreadGroup(g.id, { name: 'Final', color: 'green' })
    expect(up.name).toBe('Final')
    expect(up.color).toBe('green')
    expect(store.listThreadGroups(wsId)[0]).toMatchObject({ name: 'Final', color: 'green' })
  })

  it('deleting a group un-files its threads but keeps them', () => {
    const g = store.createThreadGroup({ workspaceId: wsId, name: 'Temp' })
    const t1 = mk('one')
    const t2 = mk('two')
    store.setThreadGroup(t1.id, g.id)
    store.setThreadGroup(t2.id, g.id)

    store.deleteThreadGroup(g.id)

    expect(store.listThreadGroups(wsId)).toHaveLength(0)
    expect(store.getThreadMeta(t1.id)?.groupId).toBeUndefined()
    expect(store.getThreadMeta(t2.id)?.groupId).toBeUndefined()
    // the threads themselves survive
    expect(store.listThreads(undefined, true)).toHaveLength(2)
  })

  it('a thread can be created directly into a group', () => {
    const g = store.createThreadGroup({ workspaceId: wsId, name: 'Inbox' })
    const t = store.createThread({ workspaceId: wsId, title: 'seeded', model: 'm/x', groupId: g.id })
    expect(t.groupId).toBe(g.id)
    expect(store.getThreadMeta(t.id)?.groupId).toBe(g.id)
  })
})

describe('store memos: settings and model cache', () => {
  it('serves settings from memory after the first read and reflects setSettings immediately', () => {
    const first = store.getSettings()
    expect(first.pruneToolResults).not.toBe(false)
    store.setSettings({ pruneToolResults: false })
    expect(store.getSettings().pruneToolResults).toBe(false)
    // The write also reached the DB (not just the memo): a memo reset re-reads the same value.
    store.resetStoreMemos()
    expect(store.getSettings().pruneToolResults).toBe(false)
  })

  it('hands each caller its own settings object so mutation cannot poison the memo', () => {
    const a = store.getSettings()
    ;(a as { theme?: string }).theme = 'mutated-by-caller'
    expect(store.getSettings().theme).not.toBe('mutated-by-caller')
  })

  it('round-trips the model cache through the memo and the DB identically', () => {
    const models = [{ id: 'p/one', name: 'One', provider: 'p' }] as never[]
    store.setCachedModels('prov-1', models)
    const memoized = store.getCachedModels('prov-1')
    expect(memoized?.models[0]).toMatchObject({ id: 'p/one' })
    // Reset the memo and read from SQLite: same content.
    store.resetStoreMemos()
    const fromDb = store.getCachedModels('prov-1')
    expect(fromDb?.models).toEqual(memoized?.models)
    expect(fromDb?.fetchedAt).toBe(memoized?.fetchedAt)
  })

  it('memoizes a provider with no cached models without sticking after a write', () => {
    expect(store.getCachedModels('prov-cold')).toBeNull()
    store.setCachedModels('prov-cold', [])
    expect(store.getCachedModels('prov-cold')).not.toBeNull()
  })
})

describe('toolWireRevision: invalidation for wire-derived memos', () => {
  it('does not bump on streaming text flushes, the per-reply hot path', () => {
    const t = mk('rev thread')
    store.insertMessage({ id: 'm1', threadId: t.id, role: 'assistant', createdAt: Date.now(), text: '' })
    const before = store.toolWireRevision()
    store.updateMessage('m1', { text: 'partial reply…' })
    store.updateMessage('m1', { text: 'partial reply… more' })
    expect(store.toolWireRevision()).toBe(before)
  })

  it('bumps when tool exchanges land, on compaction, and on deletion', () => {
    const t = mk('rev thread 2')
    let rev = store.toolWireRevision()
    store.insertMessage({
      id: 'm2',
      threadId: t.id,
      role: 'assistant',
      createdAt: Date.now(),
      text: 'done',
      toolExchanges: [{ role: 'tool', tool_call_id: 'c1', name: 'fs_read', content: '{}' }]
    })
    expect(store.toolWireRevision()).toBeGreaterThan(rev)

    rev = store.toolWireRevision()
    store.insertMessage({ id: 'm3', threadId: t.id, role: 'user', createdAt: Date.now(), text: 'hi' })
    expect(store.toolWireRevision()).toBe(rev) // a plain text message does not affect the tool wire

    store.updateMessage('m3', { toolExchanges: [] })
    expect(store.toolWireRevision()).toBeGreaterThan(rev)

    rev = store.toolWireRevision()
    store.markMessagesCompacted(['m3'])
    expect(store.toolWireRevision()).toBeGreaterThan(rev)

    rev = store.toolWireRevision()
    store.deleteMessage('m2')
    expect(store.toolWireRevision()).toBeGreaterThan(rev)
  })
})

describe('thread tools: the per-thread loaded deferred set', () => {
  it('round-trips names in order and replaces on save', () => {
    const t = mk('t')
    expect(store.listThreadTools(t.id)).toEqual([])
    store.saveThreadTools(t.id, ['mcp__b__z', 'mcp__a__y'])
    expect(store.listThreadTools(t.id)).toEqual(['mcp__b__z', 'mcp__a__y']) // load order, not sorted
    store.saveThreadTools(t.id, ['mcp__b__z', 'mcp__a__y', 'mcp__c__x'])
    expect(store.listThreadTools(t.id)).toEqual(['mcp__b__z', 'mcp__a__y', 'mcp__c__x'])
    store.clearThreadTools(t.id)
    expect(store.listThreadTools(t.id)).toEqual([])
  })

  it('is scoped per thread and cascades on delete and on clearing content', () => {
    const a = mk('a')
    const b = mk('b')
    store.saveThreadTools(a.id, ['mcp__x__one'])
    store.saveThreadTools(b.id, ['mcp__x__two'])
    store.clearThreadContent(a.id)
    expect(store.listThreadTools(a.id)).toEqual([])
    expect(store.listThreadTools(b.id)).toEqual(['mcp__x__two'])
    store.deleteThread(b.id)
    expect(store.listThreadTools(b.id)).toEqual([])
  })
})

describe('usage stats queries: tool events and failed turns', () => {
  it('flattens tool.started / tool.result events into per-call stats rows', () => {
    const t = mk('tools')
    store.appendEvent('r1', t.id, { type: 'tool.started', callId: 'c1', tool: 'Bash', args: {} })
    store.appendEvent('r1', t.id, { type: 'tool.result', callId: 'c1', tool: 'Bash', ok: true, result: {}, durationMs: 120 })
    store.appendEvent('r1', t.id, { type: 'tool.started', callId: 'c2', tool: 'Bash', args: {} })
    store.appendEvent('r1', t.id, { type: 'tool.result', callId: 'c2', tool: 'Bash', ok: false, result: {}, durationMs: 300 })
    store.appendEvent('r1', t.id, { type: 'tool.started', callId: 'c3', tool: 'Edit', args: {} })
    // a non-tool event must be ignored
    store.appendEvent('r1', t.id, { type: 'run.completed', reason: 'done' })

    const rows = store.listToolEventStats()
    const started = rows.filter((r) => !r.completed)
    const results = rows.filter((r) => r.completed)
    expect(started.map((r) => r.tool).sort()).toEqual(['Bash', 'Bash', 'Edit'])
    expect(results).toHaveLength(2)
    const failed = results.find((r) => r.ok === false)!
    expect(failed.tool).toBe('Bash')
    expect(failed.durationMs).toBe(300)
    expect(rows.every((r) => typeof r.ts === 'number')).toBe(true)
  })

  it('lists only assistant turns that errored or were interrupted', () => {
    const t = mk('failures')
    store.insertMessage({ id: 'ok', threadId: t.id, role: 'assistant', model: 'm/x', createdAt: 1000, text: 'a', status: 'complete' })
    store.insertMessage({ id: 'err', threadId: t.id, role: 'assistant', model: 'm/x', createdAt: 2000, text: 'b', status: 'error' })
    store.insertMessage({ id: 'int', threadId: t.id, role: 'assistant', model: 'm/y', createdAt: 3000, text: 'c', status: 'interrupted' })
    store.insertMessage({ id: 'usr', threadId: t.id, role: 'user', createdAt: 4000, text: 'q' })

    const failed = store.listFailedTurns()
    expect(failed.map((f) => f.createdAt)).toEqual([2000, 3000])
    expect(failed.map((f) => f.model)).toEqual(['m/x', 'm/y'])
    expect(failed.every((f) => f.threadId === t.id)).toBe(true)
  })
})
