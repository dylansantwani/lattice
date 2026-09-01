import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { SendOptions, ThreadMeta, WorkspaceMeta } from '@shared/types'
import type { ToolContext, ToolDefinition } from './types'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-sesstools-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import { getDb, closeDb } from '../store/db'
import * as sm from '../runtime/sessionMessaging'
import { sessionMessagingTools } from './sessionTools'

const tool = (name: string): ToolDefinition => {
  const t = sessionMessagingTools.find((x) => x.name === name)
  if (!t) throw new Error(`tool not found: ${name}`)
  return t
}

let wsId: string
let steers: SendOptions[]
let runningIds: Set<string>

const mk = (title: string): string => store.createThread({ workspaceId: wsId, title, model: 'm/x' }).id

const ctxFor = (threadId: string): ToolContext => {
  const meta = store.getThreadMeta(threadId) as ThreadMeta
  const workspace: WorkspaceMeta = { id: wsId, name: 'ws', roots: ['/tmp'], createdAt: 0 }
  return { threadMeta: meta, workspace, runId: 'run-x', signal: new AbortController().signal }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages')
  wsId = store.ensureDefaultWorkspace().id
  steers = []
  runningIds = new Set()
  sm.configureSessionMessaging({
    push: (_e: PushEvent) => {},
    isRunning: (id) => runningIds.has(id),
    steer: (opts) => steers.push(opts)
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('tool policy metadata', () => {
  it('list_sessions and check_inbox are R0 reads allowed in plan; send_message is an R1 submit not in plan', () => {
    expect(tool('list_sessions')).toMatchObject({ action: 'read', riskTier: 'R0', allowedInPlan: true, resource: 'external_action' })
    expect(tool('check_inbox')).toMatchObject({ action: 'read', riskTier: 'R0', allowedInPlan: true })
    expect(tool('send_message')).toMatchObject({ action: 'submit', riskTier: 'R1', allowedInPlan: false, resource: 'external_action' })
  })
})

describe('list_sessions tool', () => {
  it('returns other sessions with id/title/running/unread and excludes self', async () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    runningIds.add(b)
    const res = (await tool('list_sessions').run({}, ctxFor(a))) as {
      count: number
      sessions: { id: string; title: string; running: boolean; unread: number }[]
    }
    expect(res.count).toBe(1)
    expect(res.sessions[0]).toMatchObject({ id: b, title: 'Beta', running: true, unread: 0 })
  })
})

describe('send_message tool', () => {
  it('sends to a named session and reports the delivery lane', async () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const res = (await tool('send_message').run({ to: 'Beta', body: 'hello' }, ctxFor(a))) as {
      ok: boolean
      delivery: string
      summary: string
    }
    expect(res.ok).toBe(true)
    expect(res.delivery).toBe('queued')
    expect(res.summary).toMatch(/inbox/i)
    expect(sm.unreadCount(b)).toBe(1)
  })

  it('surfaces a resolution error as ok:false', async () => {
    const a = mk('Alpha')
    const res = (await tool('send_message').run({ to: 'ghost', body: 'x' }, ctxFor(a))) as {
      ok: boolean
      error: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/no session matches/i)
  })

  it('rejects an over-long body without hitting the store', async () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const res = (await tool('send_message').run({ to: b, body: 'x'.repeat(9000) }, ctxFor(a))) as {
      ok: boolean
      error: string
    }
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/too long/i)
    expect(sm.unreadCount(b)).toBe(0)
  })
})

describe('check_inbox tool', () => {
  it('drains unread messages oldest-first and marks them read', async () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    const c = mk('Gamma')
    sm.sendSessionMessage({ fromThreadId: b, to: c, body: 'one' })
    sm.sendSessionMessage({ fromThreadId: a, to: c, body: 'two' })
    const res = (await tool('check_inbox').run({}, ctxFor(c))) as {
      count: number
      messages: { from: string; fromTitle: string; body: string }[]
    }
    expect(res.count).toBe(2)
    expect(res.messages.map((m) => m.body)).toEqual(['one', 'two'])
    expect(res.messages[0]!.fromTitle).toBe('Beta')
    expect(sm.unreadCount(c)).toBe(0)
  })
})
