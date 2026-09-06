import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The transcript's retry action. Two behaviors:
//  - RESUME (the default when there is anything to continue): the interrupted reply is adopted by a
//    new run, keeping its text and its completed tool calls, and the model picks up from its own
//    last words. Nothing is re-run and nothing is thrown away.
//  - RESTART: the reply and its events are dropped and the user's turn runs again from the top.
//    Used when the reply produced nothing, or when the user explicitly asks to start over.

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
import { canResumeMessage, retryTurn, send } from './runManager'

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

describe('canResumeMessage', () => {
  const msg = (over: Record<string, unknown>) =>
    ({ id: 'm', threadId: 't', role: 'assistant', createdAt: 0, text: '', ...over }) as never

  it('resumes only a failed reply that actually produced something', () => {
    expect(canResumeMessage(msg({ status: 'interrupted', text: 'half a th' }))).toBe(true)
    expect(canResumeMessage(msg({ status: 'error', text: 'half a th' }))).toBe(true)
    // Tool work with no prose is still worth continuing — those calls should not be re-run.
    expect(canResumeMessage(msg({ status: 'interrupted', text: '', toolExchanges: [{ role: 'tool', content: 'x' }] }))).toBe(true)
    // Nothing to continue.
    expect(canResumeMessage(msg({ status: 'interrupted', text: '   ' }))).toBe(false)
    expect(canResumeMessage(msg({ status: 'complete', text: 'done' }))).toBe(false)
    expect(canResumeMessage(msg({ text: 'streaming' }))).toBe(false)
    expect(canResumeMessage(undefined)).toBe(false)
  })
})

describe('retryTurn — resume', () => {
  /** Run a turn that streams `text`, then fails, leaving a resumable partial reply. */
  const partialThenFail = async (threadId: string, text: string): Promise<void> => {
    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text }
      throw new Error('connection dropped mid-reply')
    })
    await send({ threadId, text: 'write me a long thing', disposition: 'send' }, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'error'))
  }

  it('continues the interrupted reply in place instead of starting it over', async () => {
    const threadId = makeThread()
    await partialThenFail(threadId, 'The first half of the answer.')
    const failed = assistantOf(threadId)[0]!
    const failedRunId = failed.runId!

    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text: ' And the second half.' }
      yield { type: 'finish', reason: 'stop' }
    })
    const pushed: { kind?: string }[] = []
    expect(await retryTurn(threadId, failed.id, (e) => pushed.push(e as { kind?: string }))).toBe(true)
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))

    const messages = store.listMessages(threadId)
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    const reply = messages[1]!
    // Same message, continued — not a second bubble, and not a rewritten one.
    expect(reply.id).toBe(failed.id)
    expect(reply.createdAt).toBe(failed.createdAt)
    expect(reply.text).toBe('The first half of the answer. And the second half.')
    expect(pushed.some((e) => e.kind === 'message.deleted')).toBe(false)

    // The interrupted run's events moved onto the resumed run, so the timeline stays continuous.
    const events = store.listEvents(threadId)
    expect(events.some((e) => e.runId === failedRunId)).toBe(false)
    expect(events.every((e) => e.runId === reply.runId)).toBe(true)
    // …and event ordering did not collapse: sequence numbers continue rather than restarting.
    const seqs = events.map((e) => e.seq)
    expect(new Set(seqs).size).toBe(seqs.length)
    // The seam is recorded, so the reader can see the reply was resumed rather than rewritten.
    expect(events.some((e) => e.body.type === 'retry' && /resum/i.test((e.body as { reason: string }).reason))).toBe(true)
  })

  it('hands the model its own last words, so it continues rather than restarting the answer', async () => {
    const threadId = makeThread()
    await partialThenFail(threadId, 'Step 1 is done.')
    const failed = assistantOf(threadId)[0]!

    let seen: { role: string; content: unknown }[] = []
    // streamChat(provider, req) — the wire is the second argument.
    testState.streamChat.mockImplementationOnce(async function* (_p: unknown, req: { messages: { role: string; content: unknown }[] }) {
      seen = req.messages
      yield { type: 'text', text: ' Step 2 is done.' }
      yield { type: 'finish', reason: 'stop' }
    } as never)
    await retryTurn(threadId, failed.id, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))

    // The request ends with the partial reply itself — the assistant-prefill continuation the run
    // loop already uses when a reply is cut off at the output ceiling.
    const last = seen[seen.length - 1]!
    expect(last.role).toBe('assistant')
    expect(last.content).toBe('Step 1 is done.')
    // The user's prompt is still there once, not repeated.
    expect(seen.filter((m) => m.role === 'user' && m.content === 'write me a long thing')).toHaveLength(1)
  })

  it('keeps the tool calls the interrupted reply already made, so they are not run twice', async () => {
    const threadId = makeThread()
    testState.streamChat.mockImplementationOnce(async function* () {
      yield {
        type: 'tool_call_delta',
        index: 0,
        id: 'call_1',
        name: 'todo_write',
        argsDelta: '{"items":[{"title":"a","status":"pending"}]}'
      }
      yield { type: 'finish', reason: 'tool_calls' }
    })
    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'Checklist created.' }
      throw new Error('dropped after the tool call')
    })
    await send({ threadId, text: 'make a checklist', disposition: 'send' }, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'error'))
    const failed = assistantOf(threadId)[0]!
    expect(failed.toolExchanges?.length).toBeGreaterThan(0)

    let seen: { role: string }[] = []
    testState.streamChat.mockImplementationOnce(async function* (_p: unknown, req: { messages: { role: string }[] }) {
      seen = req.messages
      yield { type: 'text', text: ' Done.' }
      yield { type: 'finish', reason: 'stop' }
    } as never)
    await retryTurn(threadId, failed.id, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))

    const reply = assistantOf(threadId)[0]!
    // The completed exchange survives on the resumed message, and rode along in the request.
    expect(reply.toolExchanges?.length).toBeGreaterThan(0)
    expect(seen.some((m) => m.role === 'tool')).toBe(true)
    expect(reply.text).toBe('Checklist created. Done.')
  })

  it('restarts instead when the reply died before producing anything', async () => {
    const threadId = makeThread()
    testState.streamChat.mockImplementationOnce(async function* () {
      throw new Error('died immediately')
    })
    await send({ threadId, text: 'go', disposition: 'send' }, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'error'))
    const failed = assistantOf(threadId)[0]!

    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'second attempt' }
      yield { type: 'finish', reason: 'stop' }
    })
    expect(await retryTurn(threadId, failed.id, () => {})).toBe(true)
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))
    const reply = assistantOf(threadId)[0]!
    expect(reply.id).not.toBe(failed.id) // a fresh reply: there was nothing to continue
    expect(reply.text).toBe('second attempt')
  })

  it('honors an explicit restart, discarding the partial reply', async () => {
    const threadId = makeThread()
    await partialThenFail(threadId, 'A wrong turn.')
    const failed = assistantOf(threadId)[0]!

    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'A better answer.' }
      yield { type: 'finish', reason: 'stop' }
    })
    expect(await retryTurn(threadId, failed.id, () => {}, 'restart')).toBe(true)
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'complete'))
    const reply = assistantOf(threadId)[0]!
    expect(reply.id).not.toBe(failed.id)
    expect(reply.text).toBe('A better answer.')
    expect(store.listMessages(threadId).map((m) => m.role)).toEqual(['user', 'assistant'])
  })

  it('refuses an explicit resume when there is nothing to continue', async () => {
    const threadId = makeThread()
    testState.streamChat.mockImplementationOnce(async function* () {
      throw new Error('died immediately')
    })
    await send({ threadId, text: 'go', disposition: 'send' }, () => {})
    await waitFor(() => assistantOf(threadId).some((m) => m.status === 'error'))
    const failed = assistantOf(threadId)[0]!
    expect(await retryTurn(threadId, failed.id, () => {}, 'resume')).toBe(false)
    // The reply is untouched: refusing must not destroy anything.
    expect(assistantOf(threadId)[0]!.id).toBe(failed.id)
  })
})
