import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '@shared/id'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-orch-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

// Deterministic provider: streamChat yields a fixed summary so /compact doesn't hit the network.
vi.mock('../providers/openaiCompat', () => ({
  ProviderHttpError: class extends Error {},
  streamChat: async function* () {
    yield { type: 'text', text: 'SUMMARY: the user asked for X; we did Y; next step is Z.' }
  }
}))

import * as store from '../store/eventStore'
import { getDb, closeDb } from '../store/db'
import { compactThread, forkThread } from './runManager'
import type { ChatMessage } from '@shared/types'

let wsId: string
const noop = (): void => {}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM settings')
  wsId = store.ensureDefaultWorkspace().id
  // an enabled provider so resolveProvider() succeeds inside compactThread
  store.setSettings({
    providers: [
      { id: 'p', label: 'test', kind: 'openai-compat', baseUrl: 'http://x', apiKey: 'k', enabled: true }
    ]
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const mkThread = (over?: Partial<Parameters<typeof store.createThread>[0]>) =>
  store.createThread({ workspaceId: wsId, model: 'm/x', title: 'Parent', ...over })

const addMsg = (threadId: string, role: ChatMessage['role'], text: string): ChatMessage => {
  const msg: ChatMessage = { id: ulid(), threadId, role, createdAt: Date.now(), text }
  store.insertMessage(msg)
  return msg
}

describe('thread goal persistence', () => {
  it('stores and clears a goal', () => {
    const t = mkThread({ goal: 'ship the beta' })
    expect(store.getThreadMeta(t.id)?.goal).toBe('ship the beta')
    store.updateThread(t.id, { goal: '   ' })
    expect(store.getThreadMeta(t.id)?.goal).toBeUndefined()
  })
})

describe('forkThread', () => {
  it('copies live history, links the parent, and opens read-only', () => {
    const parent = mkThread({ goal: 'north star' })
    addMsg(parent.id, 'user', 'hello')
    addMsg(parent.id, 'assistant', 'hi there')

    const child = forkThread(parent.id, { titlePrefix: 'Side' })
    expect(child).not.toBeNull()
    expect(child!.parentThreadId).toBe(parent.id)
    expect(child!.permissionPreset).toBe('manual') // read-only by default
    expect(child!.goal).toBe('north star') // goal carries over
    expect(child!.title.startsWith('Side:')).toBe(true)

    const copied = store.listMessages(child!.id)
    expect(copied.map((m) => m.text)).toEqual(['hello', 'hi there'])
    // the copies are independent rows, not the parent's
    expect(copied[0]!.id).not.toBe(store.listMessages(parent.id)[0]!.id)
  })

  it('does not copy compacted turns into the fork', () => {
    const parent = mkThread()
    const a = addMsg(parent.id, 'user', 'old question')
    addMsg(parent.id, 'assistant', 'fresh answer')
    store.markMessagesCompacted([a.id])

    const child = forkThread(parent.id)
    expect(store.listMessages(child!.id).map((m) => m.text)).toEqual(['fresh answer'])
  })

  it('returns null for a missing thread', () => {
    expect(forkThread('nope')).toBeNull()
  })
})

describe('compactThread', () => {
  it('refuses when there is not enough conversation', async () => {
    const t = mkThread()
    addMsg(t.id, 'user', 'just one message')
    const res = await compactThread(t.id, noop)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/not enough/i)
  })

  it('summarizes live history, marks it compacted, and inserts a summary', async () => {
    const t = mkThread()
    addMsg(t.id, 'user', 'question one')
    addMsg(t.id, 'assistant', 'answer one')
    addMsg(t.id, 'user', 'question two')

    const res = await compactThread(t.id, noop)
    expect(res.ok).toBe(true)
    expect(res.beforeTokens).toBeGreaterThan(0)

    const msgs = store.listMessages(t.id)
    const originals = msgs.filter((m) => m.role !== 'system')
    const summary = msgs.find((m) => m.role === 'system')
    expect(originals.every((m) => m.compacted)).toBe(true) // originals folded away
    expect(summary?.compacted).toBe(false) // the summary itself stays live
    expect(summary?.text).toMatch(/SUMMARY:/)
  })
})
