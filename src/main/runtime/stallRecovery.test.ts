import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { WireMessage } from '../providers/openaiCompat'

// Recovery for the "announced an action but never called a tool" failure — most often a
// DeepSeek/DSML route that emits the tool call as raw control tokens the gateway drops (observed
// live on openrouter/deepseek/deepseek-v4-flash-0731: the turn ends "Let me write the merged
// tooling directly." and finalizes complete with nothing done). The run loop must nudge the model
// to re-issue the call instead of finalizing, bounded so a narrate-only model still surfaces.

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

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-stall-recovery-'))
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
import type { RunEvent } from '../../shared/types'
import {
  cancelAgent,
  classifyStall,
  endsWithActionIntent,
  endsWithDeferredPromise,
  isRunning,
  send
} from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
  testState.streamChat.mockReset()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

const makeThread = (): { threadId: string } => {
  const workspace = store.ensureDefaultWorkspace()
  const thread = store.createThread({
    workspaceId: workspace.id,
    title: 'Stall thread',
    model: 'test/model',
    mode: 'act',
    permissionPreset: 'workspace'
  })
  return { threadId: thread.id }
}

/** Script the mock provider: each entry is the chunk list one round yields, in call order. */
type Chunk = import('../providers/openaiCompat').StreamChunk
const scriptRounds = (...rounds: Chunk[][]): void => {
  let call = 0
  testState.streamChat.mockImplementation(async function* () {
    const mine = rounds[Math.min(call, rounds.length - 1)]!
    call += 1
    for (const chunk of mine) yield chunk
  })
}

const runToCompletion = async (threadId: string): Promise<void> => {
  await send({ threadId, text: 'do the thing', disposition: 'send' }, () => {})
  await waitFor(() =>
    store
      .listMessages(threadId)
      .some((m) => m.role === 'assistant' && (m.status === 'complete' || m.status === 'error'))
  )
}

describe('stall recovery — announced action without a tool call', () => {
  it('nudges the model to continue when the reply ends on intent language', async () => {
    const { threadId } = makeThread()
    scriptRounds(
      [
        { type: 'text', text: 'Both codebases are understood. Let me write the merged tooling directly.' },
        { type: 'finish', reason: 'stop' }
      ],
      [
        { type: 'text', text: 'Done — the merged tooling is written.' },
        { type: 'finish', reason: 'stop' }
      ]
    )
    await runToCompletion(threadId)

    expect(testState.streamChat).toHaveBeenCalledTimes(2)
    // The second request carries the reply-so-far plus the wire-only corrective nudge.
    const secondReq = testState.streamChat.mock.calls[1]![1]
    const roles = (secondReq.messages as WireMessage[]).map((m) => m.role)
    expect(roles[roles.length - 1]).toBe('user')
    const nudge = (secondReq.messages as WireMessage[]).at(-1)!.content
    expect(nudge).toContain('no tool call was received')
    // The nudge is a wire-only carrier, never a persisted transcript message.
    expect(store.listMessages(threadId).some((m) => String(m.text).includes('no tool call was received'))).toBe(false)
    // The recovery is observable as a retry event, and the final bubble holds BOTH rounds' text.
    const events = store.listEvents(threadId)
    expect(events.some((e) => e.body.type === 'retry')).toBe(true)
    const assistant = store.listMessages(threadId).find((m) => m.role === 'assistant')!
    expect(assistant.text).toContain('Let me write the merged tooling directly.')
    expect(assistant.text).toContain('Done — the merged tooling is written.')
    expect(assistant.status).toBe('complete')
  })

  it('recovers deterministically when the route dropped raw tool-call control tokens', async () => {
    const { threadId } = makeThread()
    scriptRounds(
      [
        // No intent phrasing at all — the deterministic sentinel signal alone must trigger recovery.
        { type: 'text', text: 'Applying the fix.' },
        { type: 'raw_tool_tokens', count: 2 },
        { type: 'finish', reason: 'stop' }
      ],
      [{ type: 'text', text: 'Re-issued and finished.' }, { type: 'finish', reason: 'stop' }]
    )
    await runToCompletion(threadId)

    expect(testState.streamChat).toHaveBeenCalledTimes(2)
    const retry = store.listEvents(threadId).find((e) => e.body.type === 'retry')
    expect(retry && retry.body.type === 'retry' ? retry.body.reason : '').toContain('control tokens')
  })

  it('gives up after the continuation cap instead of looping on a narrate-only model', async () => {
    const { threadId } = makeThread()
    scriptRounds([
      { type: 'text', text: 'Understood. Let me write the implementation now.' },
      { type: 'finish', reason: 'stop' }
    ]) // every round stalls the same way
    await runToCompletion(threadId)
    // 1 original + MAX_STALL_CONTINUATIONS (2) nudged rounds, then the turn finalizes.
    expect(testState.streamChat).toHaveBeenCalledTimes(3)
  })

  it('does not trigger on ordinary closers or completed replies', async () => {
    const { threadId } = makeThread()
    scriptRounds([
      { type: 'text', text: 'All done — the file is updated. Let me know if you need anything else.' },
      { type: 'finish', reason: 'stop' }
    ])
    await runToCompletion(threadId)
    expect(testState.streamChat).toHaveBeenCalledTimes(1)
  })
})

describe('endsWithActionIntent — the trailing-intent heuristic', () => {
  it('matches replies that end on a commitment to act', () => {
    expect(endsWithActionIntent('Both codebases are understood. Let me write the merged tooling directly.')).toBe(true)
    expect(endsWithActionIntent("I've found the bug. I'll fix the null check now.")).toBe(true)
    expect(endsWithActionIntent('Plan is clear.\n\nNow let me run the tests.')).toBe(true)
    expect(endsWithActionIntent("Okay, I'm going to update the config.")).toBe(true)
    expect(endsWithActionIntent('Time to write the migration.')).toBe(true)
  })

  it('ignores benign closers, waiting language, and finished replies', () => {
    expect(endsWithActionIntent('The file is updated. Let me know if you need anything else.')).toBe(false)
    expect(endsWithActionIntent("I'll wait for your confirmation before proceeding.")).toBe(false)
    expect(endsWithActionIntent('Done! All tests pass.')).toBe(false)
    expect(endsWithActionIntent('')).toBe(false)
    // Intent language mid-reply that was followed by real content is not a stall.
    expect(endsWithActionIntent('Let me check the file. It contains three functions, all correct.')).toBe(false)
  })
})

describe('endsWithDeferredPromise — a reply that ends on a promise of later work', () => {
  it('matches a trailing first-person promise whatever the verb', () => {
    // The live failure: the orchestrator spawned two agents, then signed off on this.
    expect(endsWithDeferredPromise('Both are working. I\'ll report back with receipts as each agent finishes.')).toBe(true)
    expect(endsWithDeferredPromise('I’ll fold their results in as they land.')).toBe(true)
    expect(endsWithDeferredPromise('Let me summarize what they find.')).toBe(true)
    expect(endsWithDeferredPromise('I will keep you posted.')).toBe(true)
  })

  it('matches a mid-sentence promise only when it is explicitly deferred', () => {
    expect(
      endsWithDeferredPromise('While they run, I\'ll re-scan the 6,200-host corpus the moment the coder agent lands its changes.')
    ).toBe(true)
    expect(endsWithDeferredPromise('When they finish, I\'ll merge the results.')).toBe(true)
    expect(endsWithDeferredPromise('Both agents are running now, and I\'ll merge the results once they report.')).toBe(true)
    // No deferral cue: a description of what is happening, not a promise scheduled for later.
    expect(endsWithDeferredPromise('Both agents are running; I\'ll take the discovery half myself.')).toBe(false)
  })

  it('leaves honest status lines and benign closers alone', () => {
    expect(endsWithDeferredPromise('Both agents are running.')).toBe(false)
    expect(endsWithDeferredPromise('Waiting on both agents; nothing else can proceed until they report.')).toBe(false)
    expect(endsWithDeferredPromise('The scan will finish in about ten minutes.')).toBe(false)
    expect(endsWithDeferredPromise('Let me know if you want a different split.')).toBe(false)
    expect(endsWithDeferredPromise('I\'ll wait for both agents to finish.')).toBe(false)
    expect(endsWithDeferredPromise('I\'ll stand by.')).toBe(false)
    expect(endsWithDeferredPromise('')).toBe(false)
  })

  it('only examines the final sentence', () => {
    expect(
      endsWithDeferredPromise('I\'ll re-scan the corpus once the coder lands. Meanwhile, here is the current fingerprint count: 27.')
    ).toBe(false)
  })
})

describe('classifyStall — precedence and gating', () => {
  it('ranks leaked tool tokens above intent, and intent above a deferred promise', () => {
    expect(classifyStall({ sawRawToolTokens: true, responseText: 'Let me write it.', backgroundWorkRunning: true })).toBe(
      'raw_tool_tokens'
    )
    expect(classifyStall({ sawRawToolTokens: false, responseText: 'Let me write it.', backgroundWorkRunning: true })).toBe(
      'action_intent'
    )
    expect(
      classifyStall({ sawRawToolTokens: false, responseText: 'I\'ll report back as each agent finishes.', backgroundWorkRunning: true })
    ).toBe('parked_on_background_work')
  })

  it('never reports a parked orchestrator when nothing is running in the background', () => {
    // "I'll report back…" with no agents/jobs in flight is just a closer — there is nothing to
    // park on, and nudging would only make the model repeat itself.
    expect(
      classifyStall({ sawRawToolTokens: false, responseText: 'I\'ll report back as each agent finishes.', backgroundWorkRunning: false })
    ).toBeNull()
    expect(classifyStall({ sawRawToolTokens: false, responseText: 'All done.', backgroundWorkRunning: true })).toBeNull()
  })
})

describe('stall recovery — orchestrator parked on background subagents', () => {
  /**
   * Script a parent that delegates to a background subagent on round 1 and then replies with
   * `replies[i]` on round i+2, while the subagent hangs in its stream until it is stopped (exactly
   * like a real fetch stream on AbortController#abort()). Subagent calls are told apart by their
   * system prompt, not call order — when the subagent's first request lands relative to the
   * parent's next round is an implementation detail.
   */
  const scriptParkedParent = (
    replies: string[]
  ): { parentRounds: () => number; parentRequests: WireMessage[][] } => {
    let rounds = 0
    const parentRequests: WireMessage[][] = []
    testState.streamChat.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: WireMessage[]; signal?: AbortSignal }
    ) {
      const sysPrompt = req.messages[0]?.content
      if (typeof sysPrompt === 'string' && sysPrompt.includes('You are a Lattice subagent')) {
        yield { type: 'text', text: 'digging in…' } as Chunk
        await new Promise<void>((_resolve, reject) => {
          const fail = (): void => reject(new Error('aborted'))
          if (req.signal?.aborted) fail()
          else req.signal?.addEventListener('abort', fail)
        })
        return
      }
      rounds += 1
      parentRequests.push(req.messages)
      if (rounds === 1) {
        yield {
          type: 'tool_call_delta',
          index: 0,
          id: 'call_bg',
          name: 'run_agent',
          argsDelta: JSON.stringify({ task: 'extend the fingerprints', name: 'Fingerprint Coder', background: true })
        } as Chunk
        yield { type: 'finish', reason: 'tool_calls' } as Chunk
        return
      }
      yield { type: 'text', text: replies[Math.min(rounds - 2, replies.length - 1)]! } as Chunk
      yield { type: 'finish', reason: 'stop' } as Chunk
    })
    return { parentRounds: () => rounds, parentRequests }
  }

  const spawnedAgentId = (pushed: { kind?: string; event?: RunEvent }[]): string =>
    pushed.find((e): e is { kind: string; event: RunEvent } => e.kind === 'run.event' && !!e.event?.agent)!.event
      .agent!

  it('nudges a reply that ends on a promise of later work while the subagent is still running', async () => {
    const { threadId } = makeThread()
    const parked =
      'Two subagents are now working in the background. While they run, I\'ll re-scan the corpus ' +
      'the moment the coder agent lands its changes. I\'ll report back with receipts as each agent finishes.'
    const { parentRounds, parentRequests } = scriptParkedParent([
      parked,
      'Waiting on the Fingerprint Coder; nothing else can proceed until it reports.'
    ])
    const pushed: { kind?: string; event?: RunEvent }[] = []
    await send({ threadId, text: 'use subagents to make it faster', disposition: 'send' }, (e) =>
      pushed.push(e as { kind?: string; event?: RunEvent })
    )
    await waitFor(() =>
      store
        .listMessages(threadId)
        .some((m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Waiting on the Fingerprint Coder'))
    )

    // Round 1 delegated, round 2 parked on a promise, round 3 answered the nudge: exactly one nudge.
    expect(parentRounds()).toBe(3)
    const nudge = parentRequests[2]!.at(-1)!
    expect(nudge.role).toBe('user')
    expect(nudge.content).toContain('still running')
    expect(nudge.content).toContain('subagent "Fingerprint Coder"')
    expect(nudge.content).toContain('promise of later work')
    // The parked reply itself is fed back as the trailing assistant message before the nudge.
    expect(parentRequests[2]!.at(-2)).toMatchObject({ role: 'assistant', content: parked })
    // Wire-only: the nudge never becomes a transcript message.
    expect(store.listMessages(threadId).some((m) => String(m.text).includes('still running ('))).toBe(false)
    // Observable as a retry notice with the parked-specific reason, and the bubble holds both rounds.
    const retry = store.listEvents(threadId).find((e) => e.body.type === 'retry')
    expect(retry?.body.type === 'retry' && retry.body.reason).toContain('promise of later work')
    const assistant = store.listMessages(threadId).find((m) => m.role === 'assistant')!
    expect(assistant.text).toContain('report back with receipts')
    expect(assistant.text).toContain('Waiting on the Fingerprint Coder')

    cancelAgent(spawnedAgentId(pushed))
    await waitFor(() => !isRunning(threadId))
  })

  it('leaves an honest one-line status alone while the subagent is still running', async () => {
    const { threadId } = makeThread()
    const { parentRounds } = scriptParkedParent([
      'The Fingerprint Coder is running; nothing else can proceed until it reports.'
    ])
    const pushed: { kind?: string; event?: RunEvent }[] = []
    await send({ threadId, text: 'use subagents to make it faster', disposition: 'send' }, (e) =>
      pushed.push(e as { kind?: string; event?: RunEvent })
    )
    await waitFor(() =>
      store.listMessages(threadId).some((m) => m.role === 'assistant' && m.status === 'complete')
    )
    expect(parentRounds()).toBe(2)
    expect(store.listEvents(threadId).some((e) => e.body.type === 'retry')).toBe(false)

    cancelAgent(spawnedAgentId(pushed))
    await waitFor(() => !isRunning(threadId))
  })

  it('does not treat a report-back closer as parked once nothing is running in the background', async () => {
    // Same closer, no delegation: a plain reply that happens to end "I'll report back…" is the
    // model signing off, not parking — nudging it would only make it repeat itself.
    const { threadId } = makeThread()
    scriptRounds([
      { type: 'text', text: 'Nothing to do until you decide. I\'ll report back as each agent finishes.' },
      { type: 'finish', reason: 'stop' }
    ])
    await runToCompletion(threadId)
    expect(testState.streamChat).toHaveBeenCalledTimes(1)
    expect(store.listEvents(threadId).some((e) => e.body.type === 'retry')).toBe(false)
  })
})
