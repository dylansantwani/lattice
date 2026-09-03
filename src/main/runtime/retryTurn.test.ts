import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The transcript's Retry button: a reply that errored (or was interrupted) is dropped along with its
// run's events, and its user turn is run again from the existing history — no duplicate user bubble.

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
  return { provider, streamChat }
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-retry-turn-'))
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
import { retryTurn, send } from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 3000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos()
  // No endpoint auto-retry: a failing round must surface as an errored reply for Retry to act on.
  store.setSettings({ maxEndpointRetries: 0 })
  testState.streamChat.mockReset()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const makeThread = (): string => {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({
    workspaceId: workspace.id,
    title: 'Retry thread',
    model: 'test/model',
    mode: 'act',
    permissionPreset: 'workspace'
  }).id
}

const assistantOf = (threadId: string) => store.listMessages(threadId).filter((m) => m.role === 'assistant')

describe('retryTurn', () => {
  it('drops an errored reply and its events, then re-runs the same user turn', async () => {
    const threadId = makeThread()
    let calls = 0
    testState.streamChat.mockImplementation(async function* () {
      calls += 1
      if (calls === 1) throw new Error('upstream exploded')
      yield { type: 'text', text: 'recovered on the second try' }
      yield { type: 'finish', reason: 'stop' }
    })
    const pushed: { kind?: string }[] = []
    await send({ threadId, text: 'do the thing', disposition: 'send' }, (e) => pushed.push(e as { kind?: string }))
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'error'))
    const failed = assistantOf(threadId)[0]!
    const failedRunId = failed.runId!
    expect(store.listEvents(threadId).some((e) => e.runId === failedRunId)).toBe(true)

    const ok = await retryTurn(threadId, failed.id, (e) => pushed.push(e as { kind?: string }))
    expect(ok).toBe(true)
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))

    const messages = store.listMessages(threadId)
    // One user turn, one (fresh) reply: the failed reply is gone and the user bubble was not duplicated.
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(messages[1]!.text).toContain('recovered on the second try')
    expect(messages[1]!.id).not.toBe(failed.id)
    expect(store.listEvents(threadId).some((e) => e.runId === failedRunId)).toBe(false)
    expect(pushed.some((e) => e.kind === 'message.deleted')).toBe(true)
    expect(calls).toBe(2)
  })

  it('refuses a reply that completed, one that is not the last message, or an unknown id', async () => {
    const threadId = makeThread()
    testState.streamChat.mockImplementation(async function* () {
      yield { type: 'text', text: 'fine' }
      yield { type: 'finish', reason: 'stop' }
    })
    await send({ threadId, text: 'first', disposition: 'send' }, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))
    const done = assistantOf(threadId)[0]!
    expect(await retryTurn(threadId, done.id, () => {})).toBe(false)
    expect(await retryTurn(threadId, 'nope', () => {})).toBe(false)
    expect(store.listMessages(threadId)).toHaveLength(2)
  })
})
