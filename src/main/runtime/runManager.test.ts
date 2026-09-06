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
import { isRunning, send, forkThread, buildWireMessages, cancelAgent, steerQueuedMessage, classifyError } from './runManager'
import { ProviderHttpError } from '../providers/openaiCompat'
import { getJob, listJobs } from '../tools/bgJobs'
import type { RunEvent } from '@shared/types'

const waitFor = async (predicate: () => boolean, timeoutMs = 1500): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM session_messages; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
  testState.reset()
  testState.streamChat.mockClear()
  testState.distillMemories.mockClear()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('classifyError — provider diagnostics', () => {
  it('surfaces a model availability explanation and gives the user a next step', () => {
    const result = classifyError(
      new ProviderHttpError(
        404,
        JSON.stringify([
          {
            error: {
              code: 404,
              message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.6-flash.',
              status: 'NOT_FOUND'
            }
          }
        ])
      )
    )

    expect(result.category).toBe('model_unavailable')
    expect(result.retryable).toBe(false)
    expect(result.message).toContain('Choose another model, then retry')
    expect(result.message).toContain('models/gemini-3.6-flash')
  })

  it('surfaces plain-text provider errors instead of reducing them to only an HTTP status', () => {
    const result = classifyError(new ProviderHttpError(400, 'The selected route does not support tools'))
    expect(result.message).toContain('The selected route does not support tools')
  })
})

describe('send — run lifecycle races', () => {
  it('starts a fresh run immediately for a message sent during post-run cleanup — never queued behind it', async () => {
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
    // The model loop has completed and the thread has settled (idle to the user), but the run still
    // lingers in `active` while distillation is awaited — deliberately NOT released yet. This is the
    // regression window: the previous turn is done, so a new message must run now, not wait.
    await testState.distillationStarted
    expect(isRunning(thread.id)).toBe(false)

    const late = await send({ threadId: thread.id, text: 'follow up', disposition: 'send' }, push)
    // The message binds to a brand-new run, not the lingering one, and is never marked queued.
    expect(late.runId).not.toBe(first.runId)
    const pending = store.listMessages(thread.id).find((message) => message.id === late.messageId)
    expect(pending).toMatchObject({ text: 'follow up' })
    // Not queued: it starts a run right away. (Like any first send, the user message itself carries
    // no runId — only the assistant reply binds to the run.)
    expect(pending?.queued).toBeFalsy()

    // The fresh run completes WITHOUT the first turn's distillation ever being released — proof it
    // did not wait behind post-run housekeeping. (Its own distillation resolves immediately.)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (message) => message.role === 'assistant' && message.text === 'follow-up response' && message.status === 'complete'
      )
    )
    expect(testState.streamChat).toHaveBeenCalledTimes(2)

    const messages = store.listMessages(thread.id)
    expect(messages.filter((message) => message.role === 'user').map((message) => message.text)).toEqual([
      'first prompt',
      'follow up'
    ])
    expect(messages.filter((message) => message.role === 'assistant').map((message) => message.text)).toEqual([
      'first response',
      'follow-up response'
    ])
    expect(pushed.some((event) => (event as { kind?: string }).kind === 'message.updated')).toBe(true)

    // Release the first turn's lingering distillation so the old run tears down; it must not clobber
    // the fresh run's state on the way out.
    testState.releaseFirstDistillation()
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

  it('starts a queued turn at model completion instead of waiting for post-run cleanup', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}

    // Hold the first provider response open long enough to enqueue the next turn. Once released,
    // the first model response ends, but its mocked distillation remains blocked deliberately.
    testState.enableStreamGate()
    const first = await send({ threadId: thread.id, text: 'first prompt', disposition: 'send' }, push)
    await testState.firstStreamReached
    const queued = await send({ threadId: thread.id, text: 'queued prompt', disposition: 'queue' }, push)
    expect(store.listMessages(thread.id).find((m) => m.id === queued.messageId)?.queued).toBe(true)

    testState.releaseFirstStream()
    await testState.distillationStarted

    try {
      // The second provider call must already be underway while the first turn's cleanup is still
      // blocked. This is the user-visible instant handoff the queue promises.
      await waitFor(() => testState.streamChat.mock.calls.length >= 2)
      const started = store.listMessages(thread.id).find((m) => m.id === queued.messageId)
      expect(started?.queued).toBe(false)
      expect(started?.runId).toBeTruthy()
      expect(started?.runId).not.toBe(first.runId)
    } finally {
      testState.releaseFirstDistillation()
    }

    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.text === 'follow-up response' && m.status === 'complete'
      )
    )
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

  it('interrupts the in-flight response the instant a steer arrives, without waiting for it to finish', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread', // already titled → no title-generation call to interfere
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}

    const stream = testState.streamChat as unknown as Mock
    let reachedResolve: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve
    })
    stream
      // First response: stream some text, then hang until THIS response's signal is aborted — i.e.
      // never finishes on its own. A real provider stream throws AbortError when the fetch aborts;
      // the ONLY thing that ends this generator is the steer tripping responseAbort.
      .mockImplementationOnce(async function* (_provider: unknown, req: { signal: AbortSignal }) {
        yield { type: 'text' as const, text: 'let me look into that' }
        reachedResolve?.()
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
          if (req.signal.aborted) fail()
          else req.signal.addEventListener('abort', fail)
        })
      })
      // Continuation after the steer is injected.
      .mockImplementationOnce(async function* () {
        yield { type: 'text' as const, text: 'switching to X' }
        yield { type: 'finish' as const, reason: 'stop' }
      })

    const first = await send({ threadId: thread.id, text: 'do the thing', disposition: 'send' }, push)
    await reached // the model is mid-reply, stream held open

    // Steer WITHOUT releasing anything: if steering only injected at end-of-response, this stream
    // would hang forever and the second call would never happen. The interrupt must end it now.
    const steer = await send({ threadId: thread.id, text: 'stop, do X instead', disposition: 'steer' }, push)
    expect(steer.runId).toBe(first.runId) // a true mid-run steer binds to the active run

    // The second stream running at all is the proof: the interrupt ended the first response so the
    // loop could inject the steer and continue.
    await waitFor(() => stream.mock.calls.length >= 2)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.text === 'switching to X' && m.status === 'complete'
      )
    )

    // The partial pre-steer reply is preserved as its own finalized bubble, and order reads
    // prompt → partial reply → steer → continuation.
    const messages = store.listMessages(thread.id)
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:do the thing',
      'assistant:let me look into that',
      'user:stop, do X instead',
      'assistant:switching to X'
    ])
    expect(messages.filter((m) => m.role === 'assistant').every((m) => m.status === 'complete')).toBe(true)

    // The continuation request carries the partial reply and the steer, in order, in its wire.
    const wire2 = (stream.mock.calls[1]![1] as { messages: { role: string; content: unknown }[] }).messages
    const tail = wire2.slice(-2)
    expect(tail).toEqual([
      { role: 'assistant', content: 'let me look into that' },
      { role: 'user', content: 'stop, do X instead' }
    ])
    expect(stream.mock.calls.length).toBe(2)
  })
  it('promotes a queued turn into the live run as a steer, interrupting the reply in progress', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}

    const stream = testState.streamChat as unknown as Mock
    let reachedResolve: (() => void) | undefined
    const reached = new Promise<void>((resolve) => {
      reachedResolve = resolve
    })
    stream
      // First response hangs until THIS response's signal is aborted — only the steer promotion
      // tripping responseAbort can end it.
      .mockImplementationOnce(async function* (_provider: unknown, req: { signal: AbortSignal }) {
        yield { type: 'text' as const, text: 'let me look into that' }
        reachedResolve?.()
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => reject(new DOMException('aborted', 'AbortError'))
          if (req.signal.aborted) fail()
          else req.signal.addEventListener('abort', fail)
        })
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text' as const, text: 'switching to X' }
        yield { type: 'finish' as const, reason: 'stop' }
      })

    const first = await send({ threadId: thread.id, text: 'do the thing', disposition: 'send' }, push)
    await reached

    // Compose a message while the run is mid-reply: default disposition queues it as a pending turn.
    const queued = await send({ threadId: thread.id, text: 'actually, do X instead', disposition: 'queue' }, push)
    const queuedMsg = store.listMessages(thread.id).find((m) => m.id === queued.messageId)
    expect(queuedMsg?.queued).toBe(true)
    expect(queuedMsg?.runId).toBeFalsy() // not yet bound to a run — it's still waiting in the queue

    // Promote it: it must fold into the live run NOW, not wait for the (hung) reply to finish.
    const promoted = steerQueuedMessage(thread.id, queued.messageId, push)
    expect(promoted).toBe(true)
    const steeredMsg = store.listMessages(thread.id).find((m) => m.id === queued.messageId)
    expect(steeredMsg?.queued).toBeFalsy() // no longer queued — it's part of the turn in flight
    expect(steeredMsg?.runId).toBe(first.runId)
    // A steer.injected event was recorded so the transcript renders the "Steered" marker.
    expect(store.listEvents(thread.id).some(
      (e) => e.body.type === 'steer.injected' && e.body.messageId === queued.messageId
    )).toBe(true)

    // The second stream running at all proves the interrupt ended the first response.
    await waitFor(() => stream.mock.calls.length >= 2)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.text === 'switching to X' && m.status === 'complete'
      )
    )

    const messages = store.listMessages(thread.id)
    expect(messages.map((m) => `${m.role}:${m.text}`)).toEqual([
      'user:do the thing',
      'assistant:let me look into that',
      'user:actually, do X instead',
      'assistant:switching to X'
    ])
    expect(messages.filter((m) => m.role === 'assistant').every((m) => m.status === 'complete')).toBe(true)
  })

  it('refuses to steer a queued turn once the run can no longer reach a boundary, leaving it queued', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}
    // An unknown message on an idle thread has no live run to steer into.
    expect(steerQueuedMessage(thread.id, 'nonexistent', push)).toBe(false)
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

  it('closes a reasoning bout with a measured durationMs when the model reasons then calls a tool', async () => {
    // Regression for "THOUGHT FOR 0S": a bout that streams reasoning and then a tool call (no spoken
    // text between) used to have its whole reasoning buffer persisted at the tool-call instant, so the
    // renderer's endTs−startTs collapsed to 0. The run loop must now stamp the bout's real start on the
    // delta and emit a reasoning.done carrying the true span.
    const stream = testState.streamChat as unknown as Mock
    stream.mockImplementationOnce(async function* () {
      yield { type: 'reasoning', text: 'The user wants a screenshot; ' }
      // Real thinking time elapses before the tool call — the whole point the duration must capture.
      await new Promise((r) => setTimeout(r, 30))
      yield { type: 'reasoning', text: 'let me snapshot the page first.' }
      yield { type: 'tool_call_delta', index: 0, id: 'call_shot', name: 'probe_tool', argsDelta: '{}' }
      yield { type: 'finish', reason: 'tool_calls' }
    }).mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'Here it is.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'take a screenshot', disposition: 'send' }, (): void => {})
    await waitFor(() =>
      store.listMessages(thread.id).some((m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Here it is.'))
    )
    testState.releaseFirstDistillation()

    const events = store.listEvents(thread.id)
    const delta = events.find((e) => e.body.type === 'reasoning.delta')
    const done = events.find((e) => e.body.type === 'reasoning.done')
    expect(delta).toBeDefined()
    expect(done).toBeDefined()
    // The delta carries the bout's real start, and the done carries a positive measured span — so the
    // timeline never has to (mis)infer the duration from coalesced event timestamps.
    const deltaBody = delta!.body as { startedAt?: number }
    const doneBody = done!.body as { durationMs?: number }
    expect(typeof deltaBody.startedAt).toBe('number')
    expect(doneBody.durationMs).toBeGreaterThan(0)
    // reasoning.done must be persisted before the tool row it precedes, so it closes the segment first.
    const doneSeq = done!.seq
    const draftSeq = events.find((e) => e.body.type === 'tool.drafting')?.seq ?? Infinity
    expect(doneSeq).toBeLessThan(draftSeq)
  })

  it('surfaces an error instead of a silent empty bubble when a turn ends after tools with reasoning but no reply', async () => {
    // The exact "not returning a response" failure captured live: the model reasons, calls a browser
    // tool, gets the result, then its FINAL round streams only reasoning ("…let me call browser_screenshot:")
    // and finishes with reason "stop" — no tool call, no visible content. The run must not complete as a
    // blank bubble; the empty-response safeguard has to fire even though a tool ran earlier (toolMs > 0).
    const stream = testState.streamChat as unknown as Mock
    stream
      .mockImplementationOnce(async function* () {
        yield { type: 'reasoning', text: 'The user wants a screenshot. Let me snapshot the page.' }
        yield { type: 'tool_call_delta', index: 0, id: 'call_snap', name: 'probe_tool', argsDelta: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      })
      .mockImplementationOnce(async function* () {
        // Reasoning-only trailing off mid-intent, then a plain stop — no content, no tool call.
        yield { type: 'reasoning', text: 'That gave a snapshot, not an image. Let me call browser_screenshot:' }
        yield { type: 'finish', reason: 'stop' }
      })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'take a screenshot', disposition: 'send' }, (): void => {})
    await waitFor(() => store.listEvents(thread.id).some((e) => e.body.type === 'run.completed'))
    testState.releaseFirstDistillation()

    const events = store.listEvents(thread.id)
    // A tool call really happened this turn — the turn is not text-only, which is what used to
    // suppress the empty-response safeguard.
    expect(events.some((e) => e.body.type.startsWith('tool.'))).toBe(true)
    // …yet the empty visible reply is surfaced as an actionable, retryable error, not a blank bubble.
    const err = events.find((e) => e.body.type === 'error')
    expect(err).toBeDefined()
    const body = err!.body as { category: string; message: string; retryable: boolean }
    expect(body.category).toBe('malformed_stream')
    expect(body.retryable).toBe(true)
    // The reasoning-specific wording only the new branch produces — the old guard, when it fired at
    // all, said "empty response" with no mention of reasoning. So this assertion fails against the
    // pre-fix code whether toolMs rounded to 0 (old guard fired the generic message) or was > 0 (old
    // guard stayed silent and there is no error to find).
    expect(body.message).toMatch(/reasoning/i)
    // The assistant bubble itself carries no visible text — the error card is the signal.
    const assistant = store.listMessages(thread.id).find((m) => m.role === 'assistant')
    expect(assistant?.text.trim()).toBe('')
  })
})

describe('send — an entirely empty round after a tool result', () => {
  it('redoes the round instead of finishing the turn silently, and keeps the recovered reply', async () => {
    // Captured live (openrouter free routes, and a local llama.cpp route): the model streams text and
    // a tool call, the tool result comes back, and the NEXT round's stream carries nothing at all —
    // no text, no reasoning, no tool call — after ~50s. The turn then finalized as reason "done" with
    // no error, because the turn-level empty guard only looks at the whole turn's text, which earlier
    // rounds had already filled. From the UI the model "just stopped responding" mid-task.
    const stream = testState.streamChat as unknown as Mock
    stream
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'Checking the file. ' }
        yield { type: 'tool_call_delta', index: 0, id: 'call_probe', name: 'probe_tool', argsDelta: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      })
      .mockImplementationOnce(async function* () {
        // The broken round: a bare finish, nothing else.
        yield { type: 'finish', reason: 'stop' }
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'The edit did not apply; here is why.' }
        yield { type: 'finish', reason: 'stop' }
      })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'fix the server', disposition: 'send' }, (): void => {})
    await waitFor(() => store.listEvents(thread.id).some((e) => e.body.type === 'run.completed'))
    testState.releaseFirstDistillation()

    const events = store.listEvents(thread.id)
    // The empty round was retried rather than accepted…
    const retry = events.find((e) => e.body.type === 'retry')
    expect(retry).toBeDefined()
    expect((retry!.body as { reason: string }).reason).toMatch(/empty response/i)
    // …the redo's reply is what the user ends up with…
    const assistant = store.listMessages(thread.id).find((m) => m.role === 'assistant')
    expect(assistant?.text).toContain('The edit did not apply')
    // …and the turn is a genuine completion, with no error left over.
    expect(events.some((e) => e.body.type === 'error')).toBe(false)
    const completed = events.find((e) => e.body.type === 'run.completed')
    expect((completed!.body as { reason: string }).reason).toBe('done')
    expect(stream).toHaveBeenCalledTimes(3)
  })
})

describe('forkThread — carries tool-call context into the child', () => {
  it('copies a parent assistant message\'s toolExchanges onto the forked copy', async () => {
    // Regression: forkThread (/side, /btw) rebuilt each copied message from scratch and dropped
    // toolExchanges entirely, so a side conversation forked after any tool call lost everything
    // the parent's tools had returned — the model in the fork could see the assistant's narration
    // but not what it actually found. It must carry the full agentic-loop history, not just text.
    const stream = testState.streamChat as unknown as Mock
    stream
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'Let me check the file.' }
        yield { type: 'tool_call_delta', index: 0, id: 'call_x', name: 'probe_tool', argsDelta: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: ' Found it.' }
        yield { type: 'finish', reason: 'stop' }
      })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'read the file', disposition: 'send' }, (): void => {})
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Found it.')
      )
    )
    testState.releaseFirstDistillation()

    const parentAssistant = store
      .listMessages(thread.id)
      .find((m) => m.role === 'assistant' && m.toolExchanges?.length)
    expect(parentAssistant?.toolExchanges?.length).toBeGreaterThan(0)

    const child = forkThread(thread.id, { titlePrefix: 'Side' })
    expect(child).not.toBeNull()

    const childAssistant = store
      .listMessages(child!.id)
      .find((m) => m.role === 'assistant' && m.text.includes('Found it.'))
    expect(childAssistant?.toolExchanges).toEqual(parentAssistant!.toolExchanges)

    // And it actually reaches the wire: a fresh request built from the fork's history replays the
    // tool_calls/tool-result round, not just the visible narration.
    const wire = buildWireMessages(child!.id, child!, 'test/model', 'high')
    const hasToolCall = wire.some((m) => m.role === 'assistant' && Array.isArray((m as { tool_calls?: unknown }).tool_calls))
    const hasToolResult = wire.some((m) => m.role === 'tool')
    expect(hasToolCall).toBe(true)
    expect(hasToolResult).toBe(true)
  })
})

describe('cancelAgent — stop a single subagent', () => {
  it('frees the parent turn immediately and never delivers a result for a stopped agent', async () => {
    // Distinguish the subagent's own stream calls from the parent's by system prompt (SUBAGENT_PROMPT
    // is unique to it) rather than call order — spawnBackgroundAgent starts the subagent's loop
    // synchronously inside the parent's tool round, and exactly when its first streamChat call lands
    // relative to the parent's next round is an implementation detail, not something to assert on.
    // Parent: round 1 delegates to a background subagent via run_agent; round 2 (after the tool
    // result comes back) finishes normally with no further tool calls. Subagent: hangs until its
    // agent-specific abort fires, then rejects — exactly like a real fetch stream would on
    // AbortController#abort().
    const stream = testState.streamChat as unknown as Mock
    let subagentAborted = false
    let parentRounds = 0
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      const sysPrompt = req.messages[0]?.content
      if (typeof sysPrompt === 'string' && sysPrompt.includes('You are a Lattice subagent')) {
        yield { type: 'text', text: 'digging in…' }
        await new Promise<void>((resolve, reject) => {
          const fail = (): void => {
            subagentAborted = true
            reject(new Error('aborted'))
          }
          if (req.signal.aborted) fail()
          else req.signal.addEventListener('abort', fail)
        })
        return
      }
      parentRounds += 1
      if (parentRounds === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_bg',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'investigate the flaky test', name: 'Flake Hunter', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'done while it works in the background' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const pushed: { kind?: string; event?: RunEvent }[] = []
    await send({ threadId: thread.id, text: 'go find the flaky test', disposition: 'send' }, (e) =>
      pushed.push(e as { kind?: string; event?: RunEvent })
    )

    // The parent turn does NOT block on the background subagent: its reply completes while the
    // subagent is still mid-flight (hanging in its stream). This is the whole point of backgrounding
    // — the orchestrator is freed the instant the model finishes, not when the agent does.
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('done while it works')
      )
    )
    await waitFor(() =>
      pushed.some((e) => e.kind === 'run.event' && !!e.event?.agent && e.event.body.type === 'run.started')
    )

    const agentId = pushed.find(
      (e): e is { kind: string; event: RunEvent } => e.kind === 'run.event' && !!e.event?.agent
    )!.event.agent!

    // Release the parent's own (gated) distillation now that its reply is complete, so the parent
    // run fully settles and drops out of `active` — proving the stopped agent below outlives it.
    testState.releaseFirstDistillation()

    cancelAgent(agentId)

    await waitFor(() =>
      pushed.some(
        (e) =>
          e.kind === 'run.event' &&
          e.event?.agent === agentId &&
          e.event.body.type === 'run.completed' &&
          e.event.body.reason === 'canceled'
      )
    )
    expect(subagentAborted).toBe(true)

    // A stopped agent must not wake the thread: no completion turn is delivered for it. Give the
    // rejection's `finally` a beat to run, then assert no 🤖 completion message ever landed.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.listMessages(thread.id).some((m) => m.text.includes('🤖 Background agent'))).toBe(false)
    await waitFor(() => !isRunning(thread.id))

    // The parent run itself was never touched: its reply completed normally, with no parent-level
    // cancellation, and it did not re-run to consume a delivered result (still exactly two rounds).
    const parentAssistant = store.listMessages(thread.id).find((m) => m.role === 'assistant')
    expect(parentAssistant?.status).toBe('complete')
    expect(parentRounds).toBe(2)
    expect(
      pushed.some(
        (e) => e.kind === 'run.event' && !e.event?.agent && e.event?.body.type === 'run.completed' && e.event.body.reason === 'canceled'
      )
    ).toBe(false)

    // A repeat call on the now-finished agentId is a documented no-op, not a throw.
    expect(() => cancelAgent(agentId)).not.toThrow()
  })

  it('is a silent no-op for an unknown or already-finished agentId', () => {
    expect(() => cancelAgent('not-a-real-agent-id')).not.toThrow()
  })
})

describe('background subagents — notify-on-completion', () => {
  it('delivers a finished background agent’s result as a new turn that wakes the thread', async () => {
    // The orchestrator spawns a background agent and ENDS ITS TURN — it never calls agent_result.
    // When the agent finishes, its result must be pushed back into the thread as a fresh turn that
    // re-invokes the model, so it can act on the result (here: report to the user).
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let wokenWire: { role: string; content: unknown }[] | undefined
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      const sysPrompt = req.messages[0]?.content
      if (typeof sysPrompt === 'string' && sysPrompt.includes('You are a Lattice subagent')) {
        yield { type: 'text', text: 'I sent the test email.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_bg',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'send a test email', name: 'Email Sender', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        yield { type: 'text', text: 'Spawned Email Sender; ending my turn.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      // mainCalls === 3: the woken run, started by the delivered completion turn.
      wokenWire = req.messages
      yield { type: 'text', text: 'The email was sent — all done.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Email thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    await send({ threadId: thread.id, text: 'send a test email in the background', disposition: 'send' }, () => {})

    // The completion is delivered as a user-role turn carrying the agent's result…
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'user' && m.text.includes('🤖 Background agent "Email Sender" finished') && m.text.includes('I sent the test email.')
      )
    )
    const completion = store
      .listMessages(thread.id)
      .find((m) => m.role === 'user' && m.text.includes('🤖 Background agent "Email Sender" finished'))
    expect(completion?.origin).toMatchObject({ kind: 'agent', label: 'Email Sender' })
    expect(completion?.origin?.agentId).toEqual(expect.any(String))
    // The agent's own run.started names the run_agent call that spawned it (and the agent id it
    // was handed back as), so the transcript can attach the live agent to that delegation row.
    const agentStart = store
      .listEvents(thread.id)
      .find((e) => e.agent === completion?.origin?.agentId && e.body.type === 'run.started')
    expect(agentStart?.body).toMatchObject({ type: 'run.started', name: 'Email Sender', parentCallId: 'call_bg' })
    // …which wakes the thread into a third model call that can see the result and answer the user.
    await waitFor(() => mainCalls >= 3)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('The email was sent — all done.')
      )
    )
    // The woken run genuinely had the agent's result in its context (not just a bare wake-up).
    expect(
      wokenWire?.some((m) => typeof m.content === 'string' && m.content.includes('I sent the test email.'))
    ).toBe(true)

    testState.releaseFirstDistillation()
  })

  it('does not double-deliver when agent_result collects the result inline', async () => {
    // When the model DELIBERATELY blocks with agent_result, it reads the result inline as the tool
    // result — so the auto-delivery lane must stay quiet: no separate 🤖 completion turn.
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      const sysPrompt = req.messages[0]?.content
      if (typeof sysPrompt === 'string' && sysPrompt.includes('You are a Lattice subagent')) {
        yield { type: 'text', text: 'FOUND: the bug is in parse().' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_bg',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'find the bug', name: 'Bug Hunter', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_collect',
          name: 'agent_result',
          argsDelta: JSON.stringify({ wait: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Collected it inline.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Bug thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    await send({ threadId: thread.id, text: 'find the bug and wait for it', disposition: 'send' }, () => {})

    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Collected it inline.')
      )
    )
    // Give any stray delivery microtask a beat, then assert it never fired.
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(store.listMessages(thread.id).some((m) => m.text.includes('🤖 Background agent'))).toBe(false)
    // The model saw the result inline via the agent_result tool result, not a woken turn: exactly
    // the three rounds it scripted, no auto-delivery wake-up round.
    expect(mainCalls).toBe(3)

    testState.releaseFirstDistillation()
  })

  it('peek_agents reports a live, still-running agent without consuming it', async () => {
    // The orchestrator spawns a background agent, then — while it is still mid-flight — calls
    // peek_agents to check in. The peek must see it as `running`, and must NOT consume it: the
    // agent still delivers its result as its own 🤖 turn once it finishes.
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let releaseSub!: () => void
    const subReleased = new Promise<void>((r) => {
      releaseSub = r
    })
    let subReached!: () => void
    const subReachedP = new Promise<void>((r) => {
      subReached = r
    })
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[] }
    ) {
      const sys = req.messages[0]?.content
      if (typeof sys === 'string' && sys.includes('You are a Lattice subagent')) {
        subReached() // signal the sub-run has started so the orchestrator can peek mid-flight
        await subReleased // stay running until the peek has happened
        yield { type: 'text', text: 'All investigated.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_bg',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'investigate', name: 'Slow Worker', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        await subReachedP // don't peek until the agent is genuinely underway
        yield { type: 'tool_call_delta', index: 0, id: 'call_peek', name: 'peek_agents', argsDelta: '{}' }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'Peeked while it works; ending my turn.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Peek thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    await send({ threadId: thread.id, text: 'investigate in the background then check on it', disposition: 'send' }, () => {})

    // The peek landed as a tool.result while the agent was still running.
    await waitFor(() =>
      store.listEvents(thread.id).some((e) => e.body.type === 'tool.result' && e.body.tool === 'peek_agents')
    )
    const peekEvent = store
      .listEvents(thread.id)
      .find((e) => e.body.type === 'tool.result' && e.body.tool === 'peek_agents')
    const payload = (peekEvent!.body as { result: { agents: Array<Record<string, unknown>>; running: number } }).result
    expect(payload.running).toBe(1)
    expect(payload.agents).toHaveLength(1)
    const snapshot = payload.agents[0]!
    expect(snapshot).toMatchObject({ name: 'Slow Worker', status: 'running' })
    expect(typeof snapshot.activity).toBe('string')
    expect((snapshot.activity as string).length).toBeGreaterThan(0)
    expect(typeof snapshot.elapsedMs).toBe('number')
    // Peeking never hands back a result — the agent is still working.
    expect(snapshot.result).toBeUndefined()

    // The main model turn has already completed and is waiting in post-turn housekeeping, but the
    // detached subagent keeps the thread genuinely active so a reload/sidebar snapshot preserves
    // the training-circle state.
    await waitFor(() => store.listMessages(thread.id).some((m) => m.role === 'assistant' && m.text.includes('Peeked while it works')))
    await testState.distillationStarted
    expect(isRunning(thread.id)).toBe(true)

    // Let the agent finish. Because the peek did NOT consume it, its result is still auto-delivered
    // as its own 🤖 turn — the proof that peek_agents is purely observational, unlike agent_result.
    releaseSub()
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'user' && m.text.includes('🤖 Background agent "Slow Worker" finished')
      )
    )

    testState.releaseFirstDistillation()
  })

  it('agent_result returns on the FIRST finisher and lets the slow one auto-deliver', async () => {
    // The orchestrator spawns two background agents — one fast, one slow — then blocks on
    // agent_result(wait:true). First-finish semantics: the call must return the moment the FAST one
    // finishes, handing back its result inline while the SLOW one is still running (reported, not
    // claimed). The slow one then keeps working and delivers its own 🤖 turn when it finishes — the
    // model never stalls on the slowest agent, and never loses the other's result.
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let releaseSlow!: () => void
    const slowReleased = new Promise<void>((r) => {
      releaseSlow = r
    })
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      const sys = req.messages[0]?.content
      if (typeof sys === 'string' && sys.includes('You are a Lattice subagent')) {
        const isSlow = req.messages.some((m) => typeof m.content === 'string' && m.content.includes('SLOW'))
        if (isSlow) await slowReleased // stay running until the fast one has already been collected
        yield { type: 'text', text: isSlow ? 'Slow work done.' : 'Fast work done.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_fast',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'investigate FAST', name: 'Fast Worker', background: true })
        }
        yield {
          type: 'tool_call_delta',
          index: 1,
          id: 'call_slow',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'investigate SLOW', name: 'Slow Worker', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_collect',
          name: 'agent_result',
          argsDelta: JSON.stringify({ wait: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 3) {
        yield { type: 'text', text: 'Got the first result; continuing.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      // mainCalls === 4: woken by the slow agent's own auto-delivered completion turn.
      yield { type: 'text', text: 'Slow one is back too.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Race thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    await send({ threadId: thread.id, text: 'spawn two and wait', disposition: 'send' }, () => {})

    // agent_result came back on the FIRST finisher: the fast agent's result is inline (done), and the
    // slow one is reported as still running — pending:1 — without its result being consumed.
    await waitFor(() =>
      store.listEvents(thread.id).some((e) => e.body.type === 'tool.result' && e.body.tool === 'agent_result')
    )
    const collectEvent = store
      .listEvents(thread.id)
      .find((e) => e.body.type === 'tool.result' && e.body.tool === 'agent_result')
    const payload = (collectEvent!.body as { result: { agents: Array<Record<string, unknown>>; pending: number } }).result
    expect(payload.pending).toBe(1)
    const fast = payload.agents.find((a) => a.name === 'Fast Worker')
    const slow = payload.agents.find((a) => a.name === 'Slow Worker')
    expect(fast).toMatchObject({ status: 'done', result: 'Fast work done.' })
    expect(slow).toMatchObject({ status: 'running' })
    expect(slow!.result).toBeUndefined()

    // The model reacted to the first result inline (turn 3) while the slow agent was still working.
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Got the first result; continuing.')
      )
    )
    // The fast agent was collected inline, so it must NOT also arrive as its own 🤖 turn.
    expect(store.listMessages(thread.id).some((m) => m.text.includes('🤖 Background agent "Fast Worker"'))).toBe(false)

    // Now let the slow agent finish: it was left tracked, so it delivers its OWN 🤖 completion turn…
    releaseSlow()
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'user' && m.text.includes('🤖 Background agent "Slow Worker" finished') && m.text.includes('Slow work done.')
      )
    )
    // …which wakes a further model call that can act on it.
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Slow one is back too.')
      )
    )
    expect(mainCalls).toBe(4)

    testState.releaseFirstDistillation()
  })
})

describe('shell — auto-background a long command + notify-on-completion', () => {
  it('moves a command past its timeout to the background and pings the thread with its output', async () => {
    // The model runs a shell command that outlives its (short) timeout. Instead of being killed, it
    // is auto-moved to the background; the tool returns immediately so the model ends its turn, and
    // when the command finishes its output is pushed back as a fresh turn that wakes the thread.
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let wokenWire: { role: string; content: unknown }[] | undefined
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_shell',
          name: 'shell',
          // Runs ~2s but is given a 700ms timeout, so it is promoted to the background at 700ms.
          argsDelta: JSON.stringify({ command: 'echo phase1; sleep 2; echo phase2', timeout_ms: 700 })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        yield { type: 'text', text: 'It is running in the background; ending my turn.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      // mainCalls === 3: the run woken by the completion ping.
      wokenWire = req.messages
      yield { type: 'text', text: 'The background command finished.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Shell thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      // full preset so the R2 shell tool runs without an approval prompt in the test.
      permissionPreset: 'full'
    })
    await send({ threadId: thread.id, text: 'run the long command', disposition: 'send' }, () => {})

    // The tool result told the model it was auto-backgrounded (not killed as timed-out).
    await waitFor(() =>
      store
        .listEvents(thread.id)
        .some(
          (e) =>
            e.body.type === 'tool.result' &&
            e.body.tool === 'shell' &&
            JSON.stringify(e.body).includes('autoBackgrounded')
        )
    )

    // The completion is delivered as a shell-attributed user-role turn carrying the full output…
    await waitFor(
      () =>
        store
          .listMessages(thread.id)
          .some((m) => m.role === 'user' && m.origin?.kind === 'shell' && m.text.includes('phase2')),
      15000
    )
    const completion = store
      .listMessages(thread.id)
      .find((m) => m.role === 'user' && m.origin?.kind === 'shell')
    expect(completion?.text).toContain('phase1')
    expect(completion?.text).toContain('phase2')

    // …which wakes the thread into a third model call whose context genuinely has the output.
    await waitFor(() => mainCalls >= 3, 15000)
    expect(
      wokenWire?.some((m) => typeof m.content === 'string' && m.content.includes('phase2'))
    ).toBe(true)

    testState.releaseFirstDistillation()
  }, 25000)
})

describe('start_job — a deliberate background job + notify-on-completion', () => {
  it('pings the thread with the job\'s output when it finishes, without holding the thread "running" meanwhile', async () => {
    // The model starts a job with start_job and ends its turn. The job must NOT keep the thread
    // spinning (it could be a server that never exits), but when it does finish its output is
    // pushed back as a fresh turn that wakes the thread — exactly like a background subagent.
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let wokenWire: { role: string; content: unknown }[] | undefined
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_job',
          name: 'start_job',
          argsDelta: JSON.stringify({ command: 'echo job-start; sleep 2; echo job-done' })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        // The model reads the jobId from the tool result and ends its turn without waiting.
        yield { type: 'text', text: 'Started the job; ending my turn.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }
      wokenWire = req.messages
      yield { type: 'text', text: 'The job finished.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Job thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'full'
    })
    await send({ threadId: thread.id, text: 'run the tests in the background', disposition: 'send' }, () => {})

    // The turn ends while the job is still running — and the thread is idle to the user.
    await waitFor(() => mainCalls >= 2, 5000)
    const jobId = listJobs(thread.id)[0]?.id
    expect(jobId).toMatch(/^job_/)
    await waitFor(() => !isRunning(thread.id), 5000)
    expect(getJob(jobId!)?.running).toBe(true)

    // When the job finishes, its output is delivered as a shell-attributed user-role turn…
    await waitFor(
      () =>
        store
          .listMessages(thread.id)
          .some((m) => m.role === 'user' && m.origin?.kind === 'shell' && m.text.includes('job-done')),
      15000
    )
    const completion = store
      .listMessages(thread.id)
      .find((m) => m.role === 'user' && m.origin?.kind === 'shell')
    expect(completion?.text).toContain(`Background job ${jobId} has finished (exit 0)`)
    expect(completion?.text).toContain('job-start')
    // Raw terminal output is delivered inside a fenced code block so the transcript's Markdown
    // renderer shows it as monospace rather than parsing `ls`/`---` separators as headings.
    expect(completion?.text).toMatch(/```\njob-start\njob-done\n```/)

    // …which wakes the thread into a third model call whose context genuinely has the output.
    await waitFor(() => mainCalls >= 3, 15000)
    expect(wokenWire?.some((m) => typeof m.content === 'string' && m.content.includes('job-done'))).toBe(true)

    testState.releaseFirstDistillation()
  }, 25000)
})

describe('background subagents — live peer messaging', () => {
  it('interrupts a running subagent response and folds a parent message into its next round', async () => {
    const stream = testState.streamChat as unknown as Mock
    let mainCalls = 0
    let subCalls = 0
    let subSawMessage = false
    stream.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal: AbortSignal }
    ) {
      const system = req.messages[0]?.content
      if (typeof system === 'string' && system.includes('You are a Lattice subagent')) {
        subCalls += 1
        if (subCalls === 1) {
          yield { type: 'text', text: 'I am still investigating.' }
          await new Promise<void>((_resolve, reject) => {
            const interrupted = (): void => reject(new Error('response interrupted'))
            if (req.signal.aborted) interrupted()
            else req.signal.addEventListener('abort', interrupted, { once: true })
          })
          return
        }
        subSawMessage = req.messages.some(
          (message) => typeof message.content === 'string' && message.content.includes('please prioritize the failing test')
        )
        yield { type: 'text', text: 'I received the priority change.' }
        yield { type: 'finish', reason: 'stop' }
        return
      }

      mainCalls += 1
      if (mainCalls === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_spawn',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'investigate the failing test', name: 'Test Worker', background: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 2) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_message',
          name: 'send_message',
          argsDelta: JSON.stringify({ to: 'Test Worker', body: 'please prioritize the failing test' })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      if (mainCalls === 3) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_collect',
          name: 'agent_result',
          argsDelta: JSON.stringify({ agents: ['Test Worker'], wait: true })
        }
        yield { type: 'finish', reason: 'tool_calls' }
        return
      }
      yield { type: 'text', text: 'The worker received the update.' }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Messaging thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'full'
    })
    await send({ threadId: thread.id, text: 'investigate and update the worker', disposition: 'send' }, () => {})

    await waitFor(() => subSawMessage)
    await waitFor(() =>
      store.listMessages(thread.id).some(
        (message) => message.role === 'assistant' && message.status === 'complete' && message.text.includes('worker received')
      )
    )
    expect(subCalls).toBe(2)
    expect(mainCalls).toBe(4)
    testState.releaseFirstDistillation()
  })
})

describe('send — live budget & usage during a run', () => {
  type Pushed = { kind: string; threadId?: string; budget?: { threadId?: string; segments: Record<string, number> }; event?: RunEvent }

  it('pushes budget snapshots before the run completes and streams usage as it lands', async () => {
    // One round that reports provider usage, so the run emits a real usage delta mid-turn.
    testState.streamChat.mockImplementationOnce(async function* () {
      yield { type: 'text', text: 'streaming a reply' }
      yield { type: 'usage', usage: { tokensIn: 500, tokensOut: 40 } }
      yield { type: 'finish', reason: 'stop' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread', // already titled → no title-generation stream to interfere
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const pushed: Pushed[] = []
    const push = (event: unknown): void => {
      pushed.push(event as Pushed)
    }

    await send({ threadId: thread.id, text: 'go', disposition: 'send' }, push)
    await waitFor(() =>
      pushed.some((e) => e.kind === 'run.event' && e.event?.body.type === 'run.completed')
    )

    // The Context Orbit gets a live snapshot BEFORE the turn finishes — not only the post-run pull.
    const completedIdx = pushed.findIndex((e) => e.kind === 'run.event' && e.event?.body.type === 'run.completed')
    const firstBudgetIdx = pushed.findIndex((e) => e.kind === 'budget.updated')
    expect(firstBudgetIdx).toBeGreaterThanOrEqual(0)
    expect(firstBudgetIdx).toBeLessThan(completedIdx)

    // Each live budget carries this thread's real, assembled budget (system prompt already counted).
    const budgets = pushed.filter((e) => e.kind === 'budget.updated')
    expect(budgets[0]!.threadId).toBe(thread.id)
    expect(budgets[0]!.budget!.segments.system).toBeGreaterThan(0)

    // Usage is streamed as run-events that SUM to the provider totals (usageStats.buildTurnUsage
    // sums them), so the Run inspector's totals move live yet still land exactly right.
    const usage = pushed
      .filter((e) => e.kind === 'run.event' && e.event?.body.type === 'usage')
      .map((e) => (e.event!.body as { type: 'usage'; usage: { tokensIn?: number; tokensOut?: number } }).usage)
    expect(usage.length).toBeGreaterThan(0)
    expect(usage.reduce((n, u) => n + (u.tokensIn ?? 0), 0)).toBe(500)
    expect(usage.reduce((n, u) => n + (u.tokensOut ?? 0), 0)).toBe(40)

    testState.releaseFirstDistillation()
  })

  it('still reports estimated output tokens when the provider reports no usage at all', async () => {
    // Default stream yields text + finish with NO usage chunk — the run must reconcile a usage
    // event from the estimated output so the Run inspector still shows a number.
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const pushed: Pushed[] = []
    await send({ threadId: thread.id, text: 'go', disposition: 'send' }, (e) => pushed.push(e as Pushed))
    await waitFor(() =>
      pushed.some((e) => e.kind === 'run.event' && e.event?.body.type === 'run.completed')
    )

    const usage = pushed
      .filter((e) => e.kind === 'run.event' && e.event?.body.type === 'usage')
      .map((e) => (e.event!.body as { type: 'usage'; usage: { tokensOut?: number } }).usage)
    // Exactly one reconciling event, carrying the estimated output-token count (> 0 for real text).
    expect(usage.reduce((n, u) => n + (u.tokensOut ?? 0), 0)).toBeGreaterThan(0)

    testState.releaseFirstDistillation()
  })
})

describe('send — output-ceiling (finish_reason "length") continuation', () => {
  it('continues a reply cut off at the output-token ceiling instead of finalizing it half-finished', async () => {
    // The "cut off in a longer agentic loop" failure: a round ends with finish_reason "length"
    // (the output cap, not a tool call) after streaming some text. The turn must NOT finalize as a
    // complete reply — the loop feeds the partial back and lets the model finish from where it stopped.
    const stream = testState.streamChat as unknown as Mock
    stream
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: 'The first half of the answer' }
        yield { type: 'finish', reason: 'length' }
      })
      .mockImplementationOnce(async function* () {
        yield { type: 'text', text: ' and the second half.' }
        yield { type: 'finish', reason: 'stop' }
      })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'answer at length', disposition: 'send' }, (): void => {})
    await waitFor(() => store.listEvents(thread.id).some((e) => e.body.type === 'run.completed'))
    testState.releaseFirstDistillation()

    // The loop made a second provider call to continue the truncated reply.
    expect(stream).toHaveBeenCalledTimes(2)
    // The continuation request carried the partial reply back as the trailing assistant message so
    // the model resumes from exactly where the ceiling stopped it (assistant-prefill continuation).
    const continuationWire = stream.mock.calls[1]![1]!.messages
    const lastMsg = continuationWire[continuationWire.length - 1]!
    expect(lastMsg.role).toBe('assistant')
    expect(lastMsg.content).toContain('The first half of the answer')
    // The finalized bubble holds the FULL concatenated reply, both halves — nothing was dropped.
    const assistant = store.listMessages(thread.id).find((m) => m.role === 'assistant')
    expect(assistant?.text).toContain('The first half of the answer')
    expect(assistant?.text).toContain('and the second half.')
    // A clean completion: the reply finished, so no truncation notice is raised.
    const err = store.listEvents(thread.id).find((e) => e.body.type === 'error')
    expect(err).toBeUndefined()
  })

  it('stops after a bounded number of continuations and surfaces a truncation notice', async () => {
    // A model that only ever returns "length" (e.g. its whole budget is spent before it can finish)
    // must not spin forever: the loop caps auto-continuations, then flags the still-truncated reply
    // as a retryable notice rather than passing it off as a finished turn.
    const stream = testState.streamChat as unknown as Mock
    stream.mockImplementation(async function* () {
      yield { type: 'text', text: 'more' }
      yield { type: 'finish', reason: 'length' }
    })

    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'Existing thread',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })

    await send({ threadId: thread.id, text: 'answer at length', disposition: 'send' }, (): void => {})
    await waitFor(() => store.listEvents(thread.id).some((e) => e.body.type === 'run.completed'))
    testState.releaseFirstDistillation()

    // 1 initial round + MAX_LENGTH_CONTINUATIONS (8) continuations = 9 provider calls, then it stops.
    expect(stream).toHaveBeenCalledTimes(9)
    // The still-truncated reply is surfaced as an actionable, retryable notice.
    const err = store.listEvents(thread.id).find((e) => e.body.type === 'error')
    expect(err).toBeDefined()
    const body = err!.body as { category: string; message: string; retryable: boolean }
    expect(body.category).toBe('truncated_output')
    expect(body.retryable).toBe(true)
    expect(body.message).toMatch(/output-token limit/i)
    // Completion reason reflects the truncation, not a clean "done".
    const completed = store
      .listEvents(thread.id)
      .find((e) => e.body.type === 'run.completed')!
    expect((completed.body as { reason: string }).reason).toBe('length')
  })
})
