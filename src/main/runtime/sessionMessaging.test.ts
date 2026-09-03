import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { SendOptions } from '@shared/types'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-sessionmsg-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import { getDb, closeDb } from '../store/db'
import * as sm from './sessionMessaging'

let wsId: string
let pushed: PushEvent[]
let steers: SendOptions[]
let runningIds: Set<string>

const mk = (title: string): string => store.createThread({ workspaceId: wsId, title, model: 'm/x' }).id

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages')
  wsId = store.ensureDefaultWorkspace().id
  pushed = []
  steers = []
  runningIds = new Set()
  sm.configureSessionMessaging({
    push: (e) => pushed.push(e),
    isRunning: (id) => runningIds.has(id),
    steer: (opts) => steers.push(opts)
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('directory: listSessions', () => {
  it('lists other non-archived sessions, excluding the caller, with running + unread', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const c = mk('Gamma')
    runningIds.add(b)
    sm.sendSessionMessage({ fromThreadId: a, to: c, body: 'hi gamma' }) // c idle → woken, read on arrival

    const list = sm.listSessions(a)
    expect(list.map((s) => s.threadId).sort()).toEqual([b, c].sort())
    expect(list.find((s) => s.threadId === b)!.running).toBe(true)
    expect(list.find((s) => s.threadId === c)!.unread).toBe(0)
    expect(list.find((s) => s.threadId === c)!.running).toBe(false)
    expect(steers.some((st) => st.threadId === c)).toBe(true)
  })

  it('excludes archived sessions', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    store.updateThread(b, { archived: true })
    expect(sm.listSessions(a)).toEqual([])
  })
})

describe('resolveTarget', () => {
  it('resolves by exact id', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    expect(sm.resolveTarget(b, a)).toEqual({ threadId: b })
  })

  it('resolves by exact title (case-insensitive), then unique prefix', () => {
    const a = mk('Alpha')
    const b = mk('Research Bot')
    expect(sm.resolveTarget('research bot', a)).toEqual({ threadId: b })
    expect(sm.resolveTarget('Research', a)).toEqual({ threadId: b })
  })

  it('reports ambiguity when a title/prefix matches more than one', () => {
    const a = mk('Alpha')
    mk('Worker')
    mk('Worker')
    const r = sm.resolveTarget('Worker', a)
    expect('error' in r && r.error).toMatch(/more than one/i)
  })

  it('rejects the caller messaging itself', () => {
    const a = mk('Alpha')
    const r = sm.resolveTarget(a, a)
    expect('error' in r && r.error).toMatch(/that is you/i)
  })

  it('reports an unknown target', () => {
    const a = mk('Alpha')
    const r = sm.resolveTarget('nonexistent', a)
    expect('error' in r && r.error).toMatch(/no session matches/i)
  })
})

describe('sendSessionMessage', () => {
  it('injects into a live recipient via the steer path and marks it read', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    runningIds.add(b)
    const res = sm.sendSessionMessage({ fromThreadId: a, to: 'Beta', body: 'ping' })
    expect(res.ok).toBe(true)
    expect(res.delivery).toBe('injected')
    expect(steers).toHaveLength(1)
    expect(steers[0]!).toMatchObject({ threadId: b, disposition: 'steer' })
    expect(steers[0]!.text).toContain('ping')
    expect(steers[0]!.text).toContain(a) // reply-to address is the sender id
    // persisted, already read (delivered into context)
    const inbox = sm.listInbox(b)
    expect(inbox).toHaveLength(1)
    expect(inbox[0]!.delivery).toBe('injected')
    expect(inbox[0]!.readAt).toBeTypeOf('number')
    expect(sm.unreadCount(b)).toBe(0)
    expect(pushed.some((e) => e.kind === 'session.message')).toBe(true)
  })

  it('preserves subagent identity in a live message and its transcript origin', () => {
    const parent = mk('Parent')
    const recipient = mk('Recipient')
    runningIds.add(recipient)
    const res = sm.sendSessionMessage({
      fromThreadId: parent,
      to: recipient,
      body: 'the child found the fix',
      fromKind: 'agent',
      fromLabel: 'Fix Hunter',
      fromAgentId: 'agent-fix-1',
      selfThreadId: undefined
    })
    expect(res.ok).toBe(true)
    expect(steers[0]).toMatchObject({
      origin: { kind: 'agent', label: 'Fix Hunter', agentId: 'agent-fix-1', fromThreadId: parent }
    })
    expect(steers[0]!.text).toContain('to:"agent-fix-1"')
    expect(sm.listInbox(recipient)[0]).toMatchObject({
      fromKind: 'agent',
      fromAgentId: 'agent-fix-1',
      fromTitle: 'Fix Hunter'
    })
  })

  it('wakes an idle recipient with the message (a steer-disposition send starts its run)', () => {
    // An idle session used to get only an inbox row, which meant "messaging" did nothing until a
    // human typed into the other thread. Now the same send lane a finished subagent uses wakes it.
    const a = mk('Alpha')
    const b = mk('Beta')
    const res = sm.sendSessionMessage({ fromThreadId: a, to: b, body: 'later' })
    expect(res.ok).toBe(true)
    expect(res.delivery).toBe('woken')
    expect(steers).toHaveLength(1)
    expect(steers[0]).toMatchObject({ threadId: b, disposition: 'steer', origin: { kind: 'session', label: 'Alpha' } })
    expect(steers[0]!.text).toContain('later')
    // Delivered to the model on arrival, so it is already read: check_inbox must not re-deliver it.
    expect(sm.unreadCount(b)).toBe(0)
    const inbox = sm.listInbox(b)
    expect(inbox[0]!.readAt).toBeDefined()
    expect(inbox[0]!.delivery).toBe('woken')
    expect(inbox[0]!.fromTitle).toBe('Alpha')
  })

  it('rejects empty bodies and self-sends', () => {
    const a = mk('Alpha')
    expect(sm.sendSessionMessage({ fromThreadId: a, to: a, body: 'hi' }).ok).toBe(false)
    const b = mk('Beta')
    expect(sm.sendSessionMessage({ fromThreadId: a, to: b, body: '   ' }).ok).toBe(false)
  })

  it('carries replyTo through for reply routing', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const first = sm.sendSessionMessage({ fromThreadId: a, to: b, body: 'q' })
    const reply = sm.sendSessionMessage({ fromThreadId: b, to: a, body: 'a', replyTo: first.messageId })
    expect(reply.ok).toBe(true)
    expect(sm.listInbox(a)[0]!.replyTo).toBe(first.messageId)
  })
})

describe('inbox: drain + markRead', () => {
  it('drainInbox returns unread oldest-first and marks them read', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const c = mk('Gamma')
    sm.sendSessionMessage({ fromThreadId: b, to: c, body: 'first' })
    sm.sendSessionMessage({ fromThreadId: a, to: c, body: 'second' })
    // Delivered on arrival, so nothing is unread — the inbox lane now only ever holds legacy rows
    // (queued before the wake lane existed). Simulate two of those.
    expect(sm.unreadCount(c)).toBe(0)
    getDb().prepare('UPDATE session_messages SET read_at = NULL WHERE to_thread_id = ?').run(c)
    expect(sm.unreadCount(c)).toBe(2)

    const drained = sm.drainInbox(c)
    expect(drained.map((m) => m.body)).toEqual(['first', 'second'])
    expect(sm.unreadCount(c)).toBe(0)
    // a second drain yields nothing
    expect(sm.drainInbox(c)).toEqual([])
  })

  it('markSessionMessageRead flips a single message and is idempotent', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const res = sm.sendSessionMessage({ fromThreadId: a, to: b, body: 'x' })
    expect(sm.markSessionMessageRead(res.messageId!)).toBe(false) // already read: delivered on arrival
    getDb().prepare('UPDATE session_messages SET read_at = NULL WHERE id = ?').run(res.messageId!)
    expect(sm.unreadCount(b)).toBe(1)
    expect(sm.markSessionMessageRead(res.messageId!)).toBe(true)
    expect(sm.unreadCount(b)).toBe(0)
    expect(sm.markSessionMessageRead(res.messageId!)).toBe(false) // already read
    expect(sm.markSessionMessageRead('nope')).toBe(false)
  })
})

describe('formatIncomingMessage', () => {
  it('names the sender and tells the model how to reply', () => {
    const text = sm.formatIncomingMessage({
      id: 'm1',
      fromThreadId: 'thread-123',
      toThreadId: 'thread-456',
      fromTitle: 'Researcher',
      body: 'found it',
      createdAt: 0,
      delivery: 'injected'
    })
    expect(text).toContain('Researcher')
    expect(text).toContain('thread-123')
    expect(text).toContain('send_message')
    expect(text).toContain('found it')
  })

  it('routes a reply to a live subagent by agent id', () => {
    const text = sm.formatIncomingMessage({
      id: 'm2',
      fromThreadId: 'parent-thread',
      toThreadId: 'recipient-thread',
      fromTitle: 'Worker',
      fromKind: 'agent',
      fromAgentId: 'agent-7',
      body: 'status update',
      createdAt: 0,
      delivery: 'injected'
    })
    expect(text).toContain('subagent "Worker"')
    expect(text).toContain('to:"agent-7"')
  })
})
