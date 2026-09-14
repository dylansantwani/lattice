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
    expect(s.defaultModel).toBe('deepseek/deepseek-v4-flash')
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

  it('migrates the former built-in model once without overriding later user choices', () => {
    getDb().prepare("DELETE FROM meta WHERE key = 'default_model_migration'").run()
    getDb()
      .prepare("INSERT INTO settings (key, value_json) VALUES ('app', ?)")
      .run(JSON.stringify({ defaultModel: 'cc/claude-fable-5', theme: 'midnight' }))
    store.resetStoreMemos()
    expect(store.getSettings().defaultModel).toBe('deepseek/deepseek-v4-flash')

    store.setSettings({ defaultModel: 'cc/claude-fable-5' })
    store.resetStoreMemos()
    expect(store.getSettings().defaultModel).toBe('cc/claude-fable-5')
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

describe('durable tool result lookup', () => {
  it('reads bounded results by call id within the caller thread', () => {
    const owner = mk('result owner')
    const other = mk('other thread')
    store.appendEvent('r-result', owner.id, { type: 'tool.result', callId: 'call-evidence', tool: 'fs_read', ok: true, result: 'abcdefghijklmnopqrstuvwxyz', durationMs: 1 })
    store.appendEvent('r-other', other.id, { type: 'tool.result', callId: 'call-evidence', tool: 'secret', ok: true, result: 'wrong scope', durationMs: 1 })
    expect(store.readToolResult(owner.id, 'call-evidence', { limit: 5 })).toMatchObject({
      callId: 'call-evidence', tool: 'fs_read', content: 'abcde', truncated: true, nextOffset: 5
    })
    expect(store.readToolResult(owner.id, 'missing')).toBeNull()
    expect(store.readToolResult(owner.id, 'call-evidence')?.content).toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('searches only the caller thread and paginates', () => {
    const owner = mk('search owner')
    const other = mk('search other')
    for (let i = 0; i < 3; i++) store.appendEvent('r-search', owner.id, { type: 'tool.result', callId: `s-${i}`, tool: 'grep_search', ok: true, result: `needle ${i}`, durationMs: 1 })
    store.appendEvent('r-search-other', other.id, { type: 'tool.result', callId: 's-x', tool: 'grep_search', ok: true, result: 'needle outside', durationMs: 1 })
    const first = store.searchToolResults(owner.id, 'needle', { pageSize: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextOffset).toBe(2)
    expect(store.searchToolResults(owner.id, 'needle', { offset: 2, pageSize: 2 }).items).toHaveLength(1)
  })
})

describe('memory store: FTS recall, pinned lane, usage, sweep, merge, marks', () => {
  beforeEach(() => {
    getDb().exec('DELETE FROM memory; DELETE FROM memory_distill_marks')
  })

  it('keeps the full-text index in step with the table through insert, update, and delete', () => {
    const m = store.upsertMemory({ content: 'The user prefers terse answers', author: 'model' })
    const count = (): number => (getDb().prepare('SELECT count(*) AS n FROM memory_fts').get() as { n: number }).n
    expect(count()).toBe(1)
    // Porter stemming: "preference" finds "prefers".
    expect(store.searchMemoryFts(['preference']).map((r) => r.id)).toEqual([m.id])
    store.upsertMemory({ ...m, content: 'The user wants verbose answers' })
    expect(store.searchMemoryFts(['terse'])).toEqual([])
    expect(store.searchMemoryFts(['verbose']).map((r) => r.id)).toEqual([m.id])
    store.deleteMemory(m.id)
    expect(count()).toBe(0)
  })

  it('ranks a short precise memory above a long document that merely contains the words', () => {
    const blob = store.upsertMemory({
      content: 'Claude Code global instructions:\n\n' + 'Do the whole thing well. '.repeat(120) + 'printer jams on cold mornings sometimes. ' + 'More text. '.repeat(120),
      author: 'import',
      id: 'mem:cc:global'
    })
    const precise = store.upsertMemory({ content: 'The user’s printer jams on cold mornings', author: 'model' })
    const hits = store.searchMemoryFts(['printer', 'jams', 'cold'])
    expect(hits.map((h) => h.id)).toEqual([precise.id, blob.id])
  })

  it('searches only the requested statuses, any-word, and never throws on operator-like tokens', () => {
    const a = store.upsertMemory({ content: 'alpha fact', status: 'approved' })
    store.upsertMemory({ content: 'alpha rejected', status: 'rejected' })
    const p = store.upsertMemory({ content: 'beta proposed', status: 'proposed' })
    expect(store.searchMemoryFts(['alpha', 'beta']).map((r) => r.id).sort()).toEqual([a.id, p.id].sort())
    expect(store.searchMemoryFts(['alpha'], { statuses: ['rejected'] })).toHaveLength(1)
    expect(() => store.searchMemoryFts(['and', 'or', 'not', '"x"', 'near('])).not.toThrow()
    expect(store.ftsMatchExpression(['a"b', 'c'])).toBe('"a""b" OR "c"')
    expect(store.ftsMatchExpression(['config'])).toBe('"config"*')
    expect(store.searchMemoryFts([])).toEqual([])
  })

  it('matches a longer word by prefix the way the old substring scan did', () => {
    const m = store.upsertMemory({ content: 'The user keeps the app configuration in ~/.config/lattice' })
    expect(store.searchMemoryFts(['config']).map((r) => r.id)).toEqual([m.id])
    expect(store.searchMemoryFts(['configuration']).map((r) => r.id)).toEqual([m.id])
  })

  it('listPinnedMemory returns only pinned approved rows, in stable id order', () => {
    store.upsertMemory({ id: 'b', content: 'b', pinned: true, status: 'approved' })
    store.upsertMemory({ id: 'a', content: 'a', pinned: true, status: 'approved' })
    store.upsertMemory({ id: 'c', content: 'c', pinned: true, status: 'proposed' })
    store.upsertMemory({ id: 'd', content: 'd', pinned: false, status: 'approved' })
    expect(store.listPinnedMemory().map((m) => m.id)).toEqual(['a', 'b'])
  })

  it('touchMemoryUsed stamps last_used_at and use_count without moving updated_at', () => {
    const m = store.upsertMemory({ content: 'used', author: 'model' })
    store.touchMemoryUsed([m.id], 1234)
    store.touchMemoryUsed([m.id], 2345)
    const after = store.getMemory(m.id)!
    expect(after.lastUsedAt).toBe(2345)
    expect(after.useCount).toBe(2)
    expect(after.updatedAt).toBe(m.updatedAt)
    expect(after.version).toBe(m.version)
    store.touchMemoryUsed([]) // no-op
  })

  it('upsert carries reviewedAt/useCount forward and `expiresAt: null` clears a horizon', () => {
    const m = store.upsertMemory({ content: 'x', expiresAt: 99, reviewedAt: 7 })
    store.touchMemoryUsed([m.id])
    const kept = store.upsertMemory({ id: m.id, content: 'x2' })
    expect(kept).toMatchObject({ expiresAt: 99, reviewedAt: 7, useCount: 1, version: 2 })
    const cleared = store.upsertMemory({ id: m.id, content: 'x3', expiresAt: null })
    expect(cleared.expiresAt).toBeUndefined()
    expect(store.getMemory(m.id)!.expiresAt).toBeUndefined()
  })

  it('mergeMemory folds the strongest signals into the survivor and deletes the rest', () => {
    const keep = store.upsertMemory({ content: 'The user prefers tabs', author: 'model', createdAt: 50, status: 'proposed', confidence: 0.6 })
    const drop1 = store.upsertMemory({ content: 'User prefers tabs', author: 'model', createdAt: 10, pinned: true, status: 'approved', confidence: 0.9, reviewedAt: 3 })
    const drop2 = store.upsertMemory({ content: 'prefers tabs', author: 'model', createdAt: 30, confidence: 0.5 })
    store.touchMemoryUsed([drop1.id], 500)
    store.touchMemoryUsed([drop2.id], 900)
    const merged = store.mergeMemory(keep.id, [drop1.id, drop2.id, keep.id])!
    expect(merged).toMatchObject({
      id: keep.id,
      content: 'The user prefers tabs',
      pinned: true,
      createdAt: 10,
      lastUsedAt: 900,
      useCount: 2,
      reviewedAt: 3,
      confidence: 0.9,
      status: 'approved',
      version: 2
    })
    expect(store.listMemory().map((m) => m.id)).toEqual([keep.id])
    expect(store.mergeMemory('nope', [keep.id])).toBeNull()
    expect(store.mergeMemory(keep.id, [], 'renamed')!.content).toBe('renamed')
  })

  it('sweepMemory expires, retires, and purges by the documented rules — never pinned or user rows', () => {
    const now = 10_000_000_000_000
    const day = 24 * 3600_000
    const past = store.upsertMemory({ content: 'past horizon', author: 'model', status: 'approved', expiresAt: now - 1 })
    const pastButUsed = store.upsertMemory({ content: 'past but used', author: 'model', status: 'approved', expiresAt: now - 1 })
    store.touchMemoryUsed([pastButUsed.id], now - 2 * day)
    const pastPinned = store.upsertMemory({ content: 'past pinned', author: 'model', status: 'approved', expiresAt: now - 1, pinned: true })
    const pastUser = store.upsertMemory({ content: 'past user', author: 'user', status: 'approved', expiresAt: now - 1 })
    const stale = store.upsertMemory({ content: 'never used', author: 'model', status: 'approved', createdAt: now - 91 * day })
    const staleReviewed = store.upsertMemory({ content: 'never used but reviewed', author: 'model', status: 'approved', createdAt: now - 91 * day, reviewedAt: now - 60 * day })
    const fresh = store.upsertMemory({ content: 'fresh', author: 'model', status: 'approved', createdAt: now - 5 * day })
    // Old rejected/expired rows are hard-deleted; recent ones are kept.
    getDb()
      .prepare(`INSERT INTO memory (id, scope, type, content, author, created_at, updated_at, status) VALUES (?, 'user', 'note', ?, 'model', ?, ?, ?)`)
      .run('old-rejected', 'r', now - 40 * day, now - 40 * day, 'rejected')
    getDb()
      .prepare(`INSERT INTO memory (id, scope, type, content, author, created_at, updated_at, status, expires_at) VALUES (?, 'user', 'note', ?, 'model', ?, ?, ?, ?)`)
      .run('old-expired', 'e', now - 40 * day, now - 40 * day, 'expired', now - 41 * day)
    // A row retired for never being used has no horizon: it is never purged, only parked.
    getDb()
      .prepare(`INSERT INTO memory (id, scope, type, content, author, created_at, updated_at, status) VALUES (?, 'user', 'note', ?, 'model', ?, ?, ?)`)
      .run('old-retired', 'parked', now - 200 * day, now - 100 * day, 'expired')
    getDb()
      .prepare(`INSERT INTO memory (id, scope, type, content, author, created_at, updated_at, status) VALUES (?, 'user', 'note', ?, 'model', ?, ?, ?)`)
      .run('new-rejected', 'r2', now - 2 * day, now - 2 * day, 'rejected')

    const report = store.sweepMemory(now)
    expect(report).toEqual({ expired: 1, retired: 1, deletedRejected: 1, deletedExpired: 1 })
    const status = (id: string): string | undefined => store.getMemory(id)?.status
    expect(status(past.id)).toBe('expired')
    expect(status(pastButUsed.id)).toBe('approved') // recent use defers expiry
    expect(status(pastPinned.id)).toBe('approved')
    expect(status(pastUser.id)).toBe('approved')
    expect(status(stale.id)).toBe('expired')
    expect(status(staleReviewed.id)).toBe('approved')
    expect(status(fresh.id)).toBe('approved')
    expect(store.getMemory('old-rejected')).toBeNull()
    expect(store.getMemory('old-expired')).toBeNull()
    expect(status('old-retired')).toBe('expired')
    expect(status('new-rejected')).toBe('rejected')
    // Idempotent.
    expect(store.sweepMemory(now)).toEqual({ expired: 0, retired: 0, deletedRejected: 0, deletedExpired: 0 })
  })

  it('memoryCounts reports totals without loading rows', () => {
    store.upsertMemory({ content: 'a', status: 'proposed' })
    store.upsertMemory({ content: 'b', pinned: true })
    expect(store.memoryCounts()).toEqual({ total: 2, proposed: 1, pinned: 1 })
  })

  it('distill marks round-trip and die with their thread', () => {
    const t = mk('marked')
    expect(store.getDistillMark(t.id)).toBeNull()
    store.setDistillMark(t.id, 'msg-1')
    store.setDistillMark(t.id, 'msg-2')
    expect(store.getDistillMark(t.id)).toBe('msg-2')
    store.deleteThread(t.id)
    expect(store.getDistillMark(t.id)).toBeNull()
  })

  it('has the indexes every read path filters on', () => {
    const names = (getDb().prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'memory'`).all() as { name: string }[]).map((r) => r.name)
    expect(names).toEqual(expect.arrayContaining(['idx_memory_pinned', 'idx_memory_scope', 'idx_memory_status_updated']))
  })
})
