import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage } from '@shared/types'

// Chat naming: threads are titled from a model summary on the first completed turn, REFRESHED on a
// geometric cadence as the conversation evolves, and never touched once a human (rename UI) or the
// model (set_thread_title) has claimed the name. Provenance lives in ThreadMeta.titleSource.

const testState = vi.hoisted(() => {
  const provider = {
    id: 'test-provider',
    label: 'test provider',
    kind: 'openai-compat' as const,
    baseUrl: 'http://test.invalid',
    apiKey: 'test-key',
    enabled: true,
    promptCaching: false
  }
  const streamChat = vi.fn<typeof import('../providers/openaiCompat').streamChat>()
  return { provider, streamChat, driftReply: 'KEEP' }
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-titling-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return { ...actual, streamChat: testState.streamChat }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testState.provider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn(() => Promise.resolve()) }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { driftDigest, fallbackTitle, parseDriftReply, send, shouldAutoTitle, shouldCheckTitleDrift, titleDigest } from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
  testState.streamChat.mockReset()
  testState.driftReply = 'KEEP'
  // Default script: chat rounds answer with plain text; the TITLE call (recognizable by its
  // "Write a short, specific title" prompt) answers with a fixed name.
  testState.streamChat.mockImplementation(async function* (_provider, req) {
    const first = req.messages[0]
    const isTitleCall =
      req.messages.length === 1 &&
      typeof first?.content === 'string' &&
      first.content.startsWith('Write a short, specific title')
    const isDriftCall =
      req.messages.length === 1 &&
      typeof first?.content === 'string' &&
      first.content.startsWith('The chat is currently titled')
    if (isTitleCall) {
      yield { type: 'text' as const, text: 'Model Written Title' }
    } else if (isDriftCall) {
      yield { type: 'text' as const, text: testState.driftReply }
    } else {
      yield { type: 'text' as const, text: 'a reply' }
    }
    yield { type: 'finish' as const, reason: 'stop' }
  })
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const makeAutoThread = (): string =>
  store.createThread({
    workspaceId: store.ensureDefaultWorkspace().id,
    model: 'test/model',
    mode: 'act',
    permissionPreset: 'workspace'
  }).id

const runTurn = async (threadId: string, text = 'help me fix the flaky auth test'): Promise<void> => {
  await send({ threadId, text, disposition: 'send' }, () => {})
  await waitFor(() => {
    const assistants = store.listMessages(threadId).filter((m) => m.role === 'assistant')
    return assistants.length > 0 && assistants.every((m) => m.status === 'complete' || m.status === 'error')
  })
}

describe('auto-titling — end to end', () => {
  it('titles a fresh thread from the model summary after the first turn', async () => {
    const threadId = makeAutoThread()
    expect(store.getThreadMeta(threadId)?.title).toBe('New thread')
    await runTurn(threadId)
    await waitFor(() => store.getThreadMeta(threadId)?.title !== 'New thread')
    const meta = store.getThreadMeta(threadId)!
    expect(meta.title).toBe('Model Written Title')
    expect(meta.titleSource).toBe('auto')
    expect(meta.titleMsgs).toBe(1)
  })

  it('falls back to the user message, cut at a word boundary, when the summary call fails', async () => {
    testState.streamChat.mockImplementation(async function* (_provider, req) {
      const first = req.messages[0]
      const isTitleCall =
        req.messages.length === 1 &&
        typeof first?.content === 'string' &&
        first.content.startsWith('Write a short, specific title')
      if (isTitleCall) throw new Error('provider fell over')
      yield { type: 'text' as const, text: 'a reply' }
      yield { type: 'finish' as const, reason: 'stop' }
    })
    const threadId = makeAutoThread()
    await runTurn(threadId, 'please investigate why the production deploy pipeline keeps timing out on the asset upload step')
    await waitFor(() => store.getThreadMeta(threadId)?.title !== 'New thread')
    const meta = store.getThreadMeta(threadId)!
    expect(meta.title.endsWith('…')).toBe(true)
    expect(meta.title).not.toMatch(/\s…$/) // cut at a word boundary, not mid-word with a space
    expect(meta.title.length).toBeLessThanOrEqual(61)
    // Still 'auto': a fallback name self-heals at the next refresh threshold.
    expect(meta.titleSource).toBe('auto')
  })

  it('never rewrites a title the user set — even while a summary is pending', async () => {
    const threadId = makeAutoThread()
    await runTurn(threadId)
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Model Written Title')
    // The human renames (the UI patches only `title`; provenance flips to 'user' automatically).
    store.updateThread(threadId, { title: 'My Own Name' })
    expect(store.getThreadMeta(threadId)?.titleSource).toBe('user')
    // Many more turns: the title must stay put.
    for (let i = 0; i < 4; i++) await runTurn(threadId, `follow-up ${i}`)
    expect(store.getThreadMeta(threadId)?.title).toBe('My Own Name')
  })

  it('refreshes an auto title once the conversation has tripled in user messages', async () => {
    const threadId = makeAutoThread()
    await runTurn(threadId)
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Model Written Title')
    // Retarget the title script so a refresh is observable.
    testState.streamChat.mockImplementation(async function* (_provider, req) {
      const first = req.messages[0]
      const isTitleCall =
        req.messages.length === 1 &&
        typeof first?.content === 'string' &&
        first.content.startsWith('Write a short, specific title')
      yield { type: 'text' as const, text: isTitleCall ? 'Evolved Topic Title' : 'a reply' }
      yield { type: 'finish' as const, reason: 'stop' }
    })
    await runTurn(threadId, 'second message') // 2 user msgs: below 3× threshold — no refresh
    expect(store.getThreadMeta(threadId)?.title).toBe('Model Written Title')
    await runTurn(threadId, 'third message, new topic entirely') // 3 user msgs: refresh
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Evolved Topic Title')
    expect(store.getThreadMeta(threadId)?.titleMsgs).toBe(3)
  })
})

describe('shouldAutoTitle — refresh policy', () => {
  it('titles an untitled auto thread and refreshes at 3× the last titling count', () => {
    expect(shouldAutoTitle({ title: 'New thread', titleSource: 'auto', titleMsgs: 0 }, 1)).toBe(true)
    expect(shouldAutoTitle({ title: 'Named', titleSource: 'auto', titleMsgs: 1 }, 2)).toBe(false)
    expect(shouldAutoTitle({ title: 'Named', titleSource: 'auto', titleMsgs: 1 }, 3)).toBe(true)
    expect(shouldAutoTitle({ title: 'Named', titleSource: 'auto', titleMsgs: 3 }, 8)).toBe(false)
    expect(shouldAutoTitle({ title: 'Named', titleSource: 'auto', titleMsgs: 3 }, 9)).toBe(true)
  })

  it('never touches user- or agent-named threads, and never fires with no user messages', () => {
    expect(shouldAutoTitle({ title: 'New thread', titleSource: 'user', titleMsgs: 0 }, 5)).toBe(false)
    expect(shouldAutoTitle({ title: 'Named', titleSource: 'agent', titleMsgs: 0 }, 50)).toBe(false)
    expect(shouldAutoTitle({ title: 'New thread', titleSource: 'auto', titleMsgs: 0 }, 0)).toBe(false)
    // Missing provenance (defensive) is treated as user-owned.
    expect(shouldAutoTitle({ title: 'New thread', titleMsgs: 0 }, 1)).toBe(false)
  })
})

describe('titleDigest / fallbackTitle', () => {
  const msg = (role: ChatMessage['role'], text: string, origin?: boolean): ChatMessage =>
    ({ id: text, threadId: 't', role, createdAt: 0, text, ...(origin ? { origin: { kind: 'agent', label: 'x' } } : {}) }) as ChatMessage

  it('covers the opening message, recent user turns, and the latest reply', () => {
    const digest = titleDigest([
      msg('user', 'opening question about caching'),
      msg('assistant', 'first answer'),
      msg('user', 'now about naming'),
      msg('assistant', 'latest answer about naming')
    ])
    expect(digest).toContain('opening question about caching')
    expect(digest).toContain('now about naming')
    expect(digest).toContain('latest answer about naming')
  })

  it('excludes agent/shell-origin messages from the user turns', () => {
    const digest = titleDigest([
      msg('user', 'real human ask'),
      msg('user', 'background agent finished blah', true),
      msg('assistant', 'reply')
    ])
    expect(digest).not.toContain('background agent finished')
  })

  it('fallbackTitle trims at a word boundary and handles empties', () => {
    expect(fallbackTitle('short ask')).toBe('short ask')
    const long = fallbackTitle('investigate why the production deploy pipeline keeps timing out on asset upload')!
    expect(long.length).toBeLessThanOrEqual(61)
    expect(long.endsWith('…')).toBe(true)
    expect(fallbackTitle('   ')).toBeNull()
  })
})

describe('scope drift — the name follows the conversation', () => {
  const substantial = 'Actually forget the auth test. Can you set up the new billing webhook endpoint with Stripe signature checks?'

  it('renames an auto-titled thread when the model says the goal changed', async () => {
    const threadId = makeAutoThread()
    await runTurn(threadId)
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Model Written Title')
    testState.driftReply = 'Stripe Webhook Endpoint'
    await runTurn(threadId, substantial)
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Stripe Webhook Endpoint')
    const meta = store.getThreadMeta(threadId)!
    expect(meta.titleSource).toBe('auto')
    expect(meta.titleMsgs).toBe(2)
  })

  it('keeps the name when the model answers KEEP, and never re-checks the same turn', async () => {
    const threadId = makeAutoThread()
    await runTurn(threadId)
    await waitFor(() => store.getThreadMeta(threadId)?.title === 'Model Written Title')
    await runTurn(threadId, substantial)
    await waitFor(() => (store.getThreadMeta(threadId)?.titleMsgs ?? 0) >= 2)
    expect(store.getThreadMeta(threadId)?.title).toBe('Model Written Title')
    const driftCalls = (): number =>
      testState.streamChat.mock.calls.filter((c) => {
        const first = (c[1] as { messages: { content: unknown }[] }).messages[0]
        return typeof first?.content === 'string' && first.content.startsWith('The chat is currently titled')
      }).length
    expect(driftCalls()).toBe(1)
  })

  it('also follows drift on a model-named thread, but never on a human-named one', async () => {
    const agentNamed = makeAutoThread()
    store.updateThread(agentNamed, { title: 'Auth Test Fix', titleSource: 'agent', titleMsgs: 1 })
    await runTurn(agentNamed)
    testState.driftReply = 'Billing Webhooks'
    await runTurn(agentNamed, substantial)
    await waitFor(() => store.getThreadMeta(agentNamed)?.title === 'Billing Webhooks')
    expect(store.getThreadMeta(agentNamed)?.titleSource).toBe('agent')

    const humanNamed = makeAutoThread()
    store.updateThread(humanNamed, { title: 'My Own Name', titleSource: 'user' })
    await runTurn(humanNamed)
    await runTurn(humanNamed, substantial)
    await new Promise((r) => setTimeout(r, 40))
    expect(store.getThreadMeta(humanNamed)?.title).toBe('My Own Name')
  })
})

describe('drift helpers', () => {
  it('shouldCheckTitleDrift gates on provenance, a real title, and a substantial new user turn', () => {
    const msgs = (texts: string[]) => texts.map((text) => ({ text }))
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'auto', titleMsgs: 1 }, msgs(['a', substantialText()]))).toBe(true)
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'agent', titleMsgs: 1 }, msgs(['a', substantialText()]))).toBe(true)
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'user', titleMsgs: 1 }, msgs(['a', substantialText()]))).toBe(false)
    expect(shouldCheckTitleDrift({ title: 'New thread', titleSource: 'auto' }, msgs(['a', substantialText()]))).toBe(false)
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'auto', titleMsgs: 1 }, msgs(['a', 'ok thanks']))).toBe(false)
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'auto', titleMsgs: 2 }, msgs(['a', substantialText()]))).toBe(false)
    expect(shouldCheckTitleDrift({ title: 'T', titleSource: 'auto' }, msgs([substantialText()]))).toBe(false)
  })

  it('parseDriftReply treats KEEP and an unchanged name as keep, and cleans a new one', () => {
    expect(parseDriftReply('KEEP', 'Old Name')).toBeNull()
    expect(parseDriftReply('keep.', 'Old Name')).toBeNull()
    expect(parseDriftReply('old name', 'Old Name')).toBeNull()
    expect(parseDriftReply('"Stripe Webhook Endpoint"\n', 'Old Name')).toBe('Stripe Webhook Endpoint')
  })

  it('driftDigest carries only the latest turns', () => {
    const m = (role: 'user' | 'assistant', text: string, origin?: object): ChatMessage =>
      ({ id: text, threadId: 't', role, createdAt: 0, text, origin }) as ChatMessage
    const d = driftDigest([m('user', 'one'), m('user', 'two'), m('user', 'three'), m('user', 'four'), m('assistant', 'reply'), m('user', 'from agent', { kind: 'agent' })])
    expect(d).not.toContain('User: one')
    expect(d).toContain('User: two')
    expect(d).toContain('User: four')
    expect(d).toContain('Assistant (latest): reply')
    expect(d).not.toContain('from agent')
  })
})

function substantialText(): string {
  return 'Actually forget that, set up the billing webhook endpoint with Stripe signature checks instead'
}
