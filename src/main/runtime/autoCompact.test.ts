import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '@shared/id'
import type { ChatMessage, Role, ThreadId } from '@shared/types'

const testProvider = {
  id: 'test-provider',
  label: 'test',
  kind: 'openai-compat' as const,
  baseUrl: 'http://test.invalid',
  apiKey: 'k',
  enabled: true,
  promptCaching: false
}

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-auto-compact-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return {
    ...actual,
    // Every stream (summary write + the run turn + any title) yields one short line then stops.
    streamChat: vi.fn(async function* () {
      yield { type: 'text' as const, text: 'a concise summary of the earlier conversation' }
      yield { type: 'finish' as const, reason: 'stop' }
    })
  }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testProvider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn(() => Promise.resolve()) }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { compactThread, send } from './runManager'

const push = (): void => {}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

function makeThread(): ThreadId {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({
    workspaceId: workspace.id,
    title: 'Compact thread',
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace'
  }).id
}

function seed(threadId: ThreadId, role: Role, text: string): ChatMessage {
  const msg: ChatMessage = { id: ulid(), threadId, role, createdAt: Date.now(), text }
  store.insertMessage(msg)
  return msg
}

/** Seed a few real exchanges so there is enough history to compact. */
function seedHistory(threadId: ThreadId): void {
  seed(threadId, 'user', 'first question about the project')
  seed(threadId, 'assistant', 'first answer with some detail')
  seed(threadId, 'user', 'a follow-up question')
  seed(threadId, 'assistant', 'a follow-up answer with more detail')
}

const settled = (): Promise<void> => new Promise((r) => setTimeout(r, 20))

describe('compactThread preserveMessageId', () => {
  it('folds prior history but keeps the preserved turn live and verbatim', async () => {
    const t = makeThread()
    seedHistory(t)
    const current = seed(t, 'user', 'the current question, still being answered')

    const res = await compactThread(t, push, { preserveMessageId: current.id })
    expect(res.ok).toBe(true)

    const msgs = store.listMessages(t)
    // The preserved turn is untouched.
    const preserved = msgs.find((m) => m.id === current.id)!
    expect(preserved.compacted).toBeFalsy()
    expect(preserved.text).toBe('the current question, still being answered')
    // The four history turns are folded away.
    expect(msgs.filter((m) => m.compacted).length).toBe(4)
    // A summary system message now stands in for them.
    expect(msgs.some((m) => m.role === 'system' && !m.compacted && m.text.includes('summary'))).toBe(true)
  })
})

describe('auto-compaction on send', () => {
  it('compacts over-threshold history before the turn, keeping the new message live', async () => {
    const t = makeThread()
    seedHistory(t)
    // Force the threshold low enough that the seeded thread is already "over".
    store.setSettings({ autoCompact: true, compactionThreshold: 0.001 })

    const { messageId } = await send({ threadId: t, text: 'brand new question' }, push)
    await settled()

    const msgs = store.listMessages(t)
    // The four seeded turns are compacted; the just-sent message is preserved and live.
    expect(msgs.filter((m) => m.compacted).length).toBe(4)
    const fresh = msgs.find((m) => m.id === messageId)!
    expect(fresh.compacted).toBeFalsy()
    expect(fresh.text).toBe('brand new question')
    expect(msgs.some((m) => m.role === 'system' && !m.compacted)).toBe(true)
  })

  it('does not auto-compact when the setting is off', async () => {
    const t = makeThread()
    seedHistory(t)
    store.setSettings({ autoCompact: false, compactionThreshold: 0.001 })

    await send({ threadId: t, text: 'another question' }, push)
    await settled()

    const msgs = store.listMessages(t)
    expect(msgs.some((m) => m.compacted)).toBe(false)
    expect(msgs.some((m) => m.role === 'system')).toBe(false)
  })

  it('does not auto-compact a thread that is under the threshold', async () => {
    const t = makeThread()
    seedHistory(t)
    store.setSettings({ autoCompact: true, compactionThreshold: 0.99 })

    await send({ threadId: t, text: 'a small question' }, push)
    await settled()

    const msgs = store.listMessages(t)
    expect(msgs.some((m) => m.compacted)).toBe(false)
  })
})
