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
import { isRunning, send, forkThread, buildWireMessages, cancelAgent } from './runManager'
import type { RunEvent } from '@shared/types'

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
})

