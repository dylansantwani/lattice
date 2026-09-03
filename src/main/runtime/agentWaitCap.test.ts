import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RunEvent } from '../../shared/types'

// agent_result(wait:true) must never park the orchestrator: with nothing finished inside the cap it
// hands back the running statuses and a "move on" note, leaving the agents to deliver themselves.

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

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-agent-wait-cap-'))
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
import { AGENT_WAIT, cancelAgent, isRunning, send } from './runManager'

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
  testState.streamChat.mockReset()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

type Chunk = import('../providers/openaiCompat').StreamChunk

describe('agent_result wait cap', () => {
  it('returns running statuses with a move-on note once the cap expires', async () => {
    AGENT_WAIT.maxMs = 60
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({ workspaceId: workspace.id, title: 'Cap', model: 'test/model', mode: 'act', permissionPreset: 'workspace' })
    let rounds = 0
    let toolResultSeen: unknown
    testState.streamChat.mockImplementation(async function* (
      _provider: unknown,
      req: { messages: { role: string; content: unknown }[]; signal?: AbortSignal }
    ) {
      const sys = req.messages[0]?.content
      if (typeof sys === 'string' && sys.includes('You are a Lattice subagent')) {
        yield { type: 'text', text: 'working…' } as Chunk
        await new Promise<void>((_r, reject) => {
          const fail = (): void => reject(new Error('aborted'))
          if (req.signal?.aborted) fail()
          else req.signal?.addEventListener('abort', fail)
        })
        return
      }
      rounds += 1
      if (rounds === 1) {
        yield { type: 'tool_call_delta', index: 0, id: 'c1', name: 'run_agent', argsDelta: JSON.stringify({ task: 'slow', name: 'Slow One', background: true }) } as Chunk
        yield { type: 'finish', reason: 'tool_calls' } as Chunk
        return
      }
      if (rounds === 2) {
        yield { type: 'tool_call_delta', index: 0, id: 'c2', name: 'agent_result', argsDelta: JSON.stringify({ wait: true }) } as Chunk
        yield { type: 'finish', reason: 'tool_calls' } as Chunk
        return
      }
      // Round 3 sees the agent_result tool message; capture it.
      const toolMsg = [...req.messages].reverse().find((m) => m.role === 'tool')
      const envelope = typeof toolMsg?.content === 'string' ? JSON.parse(toolMsg.content) : toolMsg?.content
      // The wire carries the tool envelope { ok, result }; the model reads the result inside it.
      toolResultSeen = envelope && typeof envelope === 'object' && 'result' in envelope ? envelope.result : envelope
      yield { type: 'text', text: 'Moving on; waiting on Slow One.' } as Chunk
      yield { type: 'finish', reason: 'stop' } as Chunk
    })
    const pushed: { kind?: string; event?: RunEvent }[] = []
    const t0 = Date.now()
    await send({ threadId: thread.id, text: 'go', disposition: 'send' }, (e) => pushed.push(e as { kind?: string; event?: RunEvent }))
    await waitFor(() => store.listMessages(thread.id).some((m) => m.role === 'assistant' && m.status === 'complete'))
    expect(Date.now() - t0).toBeLessThan(2500)
    expect(rounds).toBe(3)
    expect(toolResultSeen).toMatchObject({ pending: 1, timedOut: true })
    expect(String((toolResultSeen as { note: string }).note)).toMatch(/CONTINUE WORKING/)
    // The agent was NOT claimed by the expired wait: it is still running and still owed a delivery.
    const agentId = pushed.find((e): e is { kind: string; event: RunEvent } => e.kind === 'run.event' && !!e.event?.agent)!.event.agent!
    expect(isRunning(thread.id)).toBe(true)
    cancelAgent(agentId)
    await waitFor(() => !isRunning(thread.id))
    AGENT_WAIT.maxMs = 20_000
  })
})
