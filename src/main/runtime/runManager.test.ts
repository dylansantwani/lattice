import { afterAll, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

  let streamCalls = 0
  let distillCalls = 0
  let resolveFirstDistillation: (() => void) | undefined
  let distillationStartedResolve: (() => void) | undefined
  let distillationStarted = Promise.resolve()
  // Opt-in gate: when enabled, the first stream yields its text then blocks (after signalling
  // `firstStreamReached`) until `releaseFirstStream()` — a window to inject a mid-run steer that
  // reaches the safe boundary. Off by default so the other tests stream straight through.
  let gateFirstStream = false
  let firstStreamReachedResolve: (() => void) | undefined
  let firstStreamReached = Promise.resolve()
  let releaseFirstStreamResolve: (() => void) | undefined

  const reset = (): void => {
    streamCalls = 0
    distillCalls = 0
    distillationStarted = new Promise<void>((resolve) => {
      distillationStartedResolve = resolve
    })
    resolveFirstDistillation = undefined
    gateFirstStream = false
    firstStreamReached = new Promise<void>((resolve) => {
      firstStreamReachedResolve = resolve
    })
    releaseFirstStreamResolve = undefined
  }

  // Typed against the real streamChat so mock.calls carry the (provider, req) tuple — the tests
  // read `req.messages` off call args — and mockImplementationOnce accepts the full StreamChunk
  // union (e.g. tool_call_delta), not just the text/finish this default impl happens to yield.
  const streamChat = vi.fn<typeof import('../providers/openaiCompat').streamChat>(async function* () {
    streamCalls += 1
    const mine = streamCalls
    yield { type: 'text' as const, text: mine === 1 ? 'first response' : 'follow-up response' }
    if (mine === 1 && gateFirstStream) {
      firstStreamReachedResolve?.()
      await new Promise<void>((resolve) => {
        releaseFirstStreamResolve = resolve
      })
    }
    yield { type: 'finish' as const, reason: 'stop' }
  })

  const distillMemories = vi.fn(() => {
    distillCalls += 1
    if (distillCalls !== 1) return Promise.resolve()
    distillationStartedResolve?.()
    return new Promise<void>((resolve) => {
      resolveFirstDistillation = resolve
    })
  })

  reset()

  return {
    provider,
    streamChat,
    distillMemories,
    reset,
    get distillationStarted() {
      return distillationStarted
    },
    releaseFirstDistillation(): void {
      resolveFirstDistillation?.()
    },
    enableStreamGate(): void {
      gateFirstStream = true
    },
    get firstStreamReached() {
      return firstStreamReached
    },
    releaseFirstStream(): void {
      releaseFirstStreamResolve?.()
    }
  }
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-run-manager-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return { ...actual, streamChat: testState.streamChat }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testState.provider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: testState.distillMemories }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { isRunning, send } from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 1500): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  testState.reset()
  testState.streamChat.mockClear()
  testState.distillMemories.mockClear()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('send — run lifecycle races', () => {
  it('queues a steer sent during post-run cleanup as a new turn', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const pushed: unknown[] = []
    const push = (event: unknown): void => {
      pushed.push(event)
    }

    const first = await send({ threadId: thread.id, text: 'first prompt', disposition: 'send' }, push)
    await testState.distillationStarted

    // The model loop has completed, but the run is still active while distillation is awaited.
    // A renderer with stale `running: true` state sends this as a steer.
    const late = await send({ threadId: thread.id, text: 'follow up', disposition: 'steer' }, push)
    const pending = store.listMessages(thread.id).find((message) => message.id === late.messageId)
    expect(late.runId).toBe(first.runId)
    expect(pending).toMatchObject({ text: 'follow up', queued: true })
    expect(pending?.runId).toBeUndefined()

    testState.releaseFirstDistillation()
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (message) => message.role === 'assistant' && message.text === 'follow-up response' && message.status === 'complete'
      )
    )

    const messages = store.listMessages(thread.id)
    expect(messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'first prompt',
      'follow up'
    ])
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'first response',
      'follow-up response'
    ])
    expect(testState.streamChat).toHaveBeenCalledTimes(2)
    expect(pushed.some((event) => (event as { kind?: string }).kind === 'message.updated')).toBe(true)
  })

  it('reports the thread idle as soon as the model turn ends, before distillation finishes', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread', // already titled → no title-generation call to interfere
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const pushed: unknown[] = []
    const push = (event: unknown): void => {
      pushed.push(event)
    }

    await send({ threadId: thread.id, text: 'first prompt', disposition: 'send' }, push)
    // The model loop has completed and distillation is now blocking. The thread must already read as
    // idle — this is the bug fix: the Stop button/spinner clear the instant generation stops rather
    // than lingering through best-effort post-run housekeeping.
    await testState.distillationStarted

    expect(isRunning(thread.id)).toBe(false)
    const runningEvents = pushed.filter(
      (event): event is { kind: string; meta: { running?: boolean } } =>
        (event as { kind?: string }).kind === 'thread.updated'
    )
    // Last running-state signal before distillation finished must be false.
    expect(runningEvents.at(-1)?.meta.running).toBe(false)
    expect(runningEvents.some((event) => event.meta.running === true)).toBe(true)
    // Distillation is still in-flight — the run has not been torn down yet.
    expect(testState.streamChat).toHaveBeenCalledTimes(1)

    testState.releaseFirstDistillation()
  })
})

describe('send — mid-run steering', () => {
  it('splits the assistant turn so an injected steer sits between reply and continuation', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread', // already titled → no title-generation call to interfere
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const deleted: string[] = []
    const push = (event: unknown): void => {
      const e = event as { kind?: string; messageId?: string }
      if (e.kind === 'message.deleted' && e.messageId) deleted.push(e.messageId)
    }

    // Hold the first stream open after it emits its text, so the steer is injected while the run
    // is genuinely mid-flight and still accepting steers.
    testState.enableStreamGate()
    const first = await send({ threadId: thread.id, text: 'first prompt', disposition: 'send' }, push)
    await testState.firstStreamReached

    const steer = await send({ threadId: thread.id, text: 'actually, also do X', disposition: 'steer' }, push)
    // A true mid-run steer binds to the active run and is NOT a queued turn.
    expect(steer.runId).toBe(first.runId)
    const steerMsg = store.listMessages(thread.id).find((m) => m.id === steer.messageId)
    expect(steerMsg?.runId).toBe(first.runId)
    expect(steerMsg?.queued).toBeFalsy()

    // Let the first stream finish; the safe-boundary handler injects the steer and re-streams.
    testState.releaseFirstStream()
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.text === 'follow-up response' && m.status === 'complete'
      )
    )

    const messages = store.listMessages(thread.id)
    // Chronological order must read: prompt → reply → steer → continuation. The continuation is a
    // SEPARATE assistant bubble, not appended to the pre-steer reply (which would render the
    // model's answer above the interjection).
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:first prompt',
      'assistant:first response',
      'user:actually, also do X',
      'assistant:follow-up response'
    ])
    // Both assistant segments are finalized, and no blank bubble was left behind.
    expect(messages.filter((m) => m.role === 'assistant').every((m) => m.status === 'complete')).toBe(true)
    expect(deleted).toHaveLength(0)
    expect(testState.streamChat).toHaveBeenCalledTimes(2)
  })
})

describe('send — cache-stable tool replay', () => {
  it('sends the tool-call message with content:null so the next turn replays a byte-identical prefix', async () => {
    // Turn 1: the model narrates, then calls a tool (round 1), then replies (round 2). Turn 2: a
    // plain reply that replays turn 1's history. The regression: if the live tool-call request
    // carried the pre-tool narration as `content` but the persisted replay nulled it, the gateway's
    // prefix hash would diverge and every post-tool turn would re-process the tool transcript
    // uncached. Guard the invariant by asserting the live request and the replay are byte-identical.
    // The shared mock's yield type is inferred narrowly (text/finish); widen it here so the
    // tool-call round can be scripted. mockImplementationOnce entries survive beforeEach's
    // mockClear and are consumed in call order, and this test consumes exactly the three it queues.
    const stream = testState.streamChat as unknown as Mock
    stream
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'Let me check the file.' }
        yield { type: 'tool_call_delta', index: 0, id: 'call_x', name: 'probe_tool', argsDelta: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: ' Done.' }
        yield { type: 'finish', reason: 'stop' }
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'second turn reply' }
        yield { type: 'finish', reason: 'stop' }
      })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread', // already titled → no title-generation stream to perturb the call sequence
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}

    await send({ threadId: thread.id, text: 'read the file', disposition: 'send' }, push)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Done.')
      )
    )
    // Unblock the (mocked) distillation so the run tears down and the queued second turn can run.
    testState.releaseFirstDistillation()

    // The tool round's follow-up request (call 2) must carry the assistant tool-call message with
    // content nulled — the narration lives in the visible bubble, not on this wire message.
    type WireMsg = { role: string; content: unknown; tool_calls?: unknown }
    const messagesOf = (i: number): WireMsg[] => (stream.mock.calls[i]![1] as { messages: WireMsg[] }).messages
    const toolCallIn = (msgs: WireMsg[]): WireMsg | undefined =>
      msgs.find((m) => m.role === 'assistant' && Array.isArray(m.tool_calls))
    const sentToolCall = toolCallIn(messagesOf(1))
    expect(sentToolCall).toBeDefined()
    expect(sentToolCall!.content).toBeNull()

    await send({ threadId: thread.id, text: 'thanks', disposition: 'send' }, push)
    await waitFor(() => stream.mock.calls.length >= 3)
    await waitFor(() =>
      store.listMessages(thread.id).some((m) => m.role === 'assistant' && m.text === 'second turn reply' && m.status === 'complete')
    )

    // The replayed prefix on turn 2 must be byte-identical to what the run cached: same tool-call
    // message (content:null, same call), so the gateway's prefix match — and the cache hit — survives.
    const replayToolCall = toolCallIn(messagesOf(2))
    expect(replayToolCall).toEqual(sentToolCall)

    // And the narration is not lost: it rides the visible bubble, replayed as the trailing assistant
    // message after the tool exchange.
    const replay = messagesOf(2)
    const replayText = replay.filter((m) => m.role === 'assistant' && !m.tool_calls).map((m) => m.content)
    expect(replayText).toContain('Let me check the file. Done.')
  })
})
