import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// A provider mock that asks for one tool call on the first turn, then answers with text.
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
  let calls = 0
  const streamChat = vi.fn(async function* () {
    calls += 1
    if (calls === 1) {
      yield {
        type: 'tool_call_delta' as const,
        index: 0,
        id: 'call_rename',
        name: 'set_thread_title',
        argsDelta: '{"title":"Renamed by tool"}'
      }
      yield { type: 'finish' as const, reason: 'tool_calls' }
      return
    }
    yield { type: 'text' as const, text: 'Done — renamed the thread.' }
    yield { type: 'finish' as const, reason: 'stop' }
  })
  return { provider, streamChat, reset: () => (calls = 0) }
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-tool-replay-e2e-'))
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
import { send, buildWireMessages } from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
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
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('tool exchange capture (end to end)', () => {
  it('captures a real tool round and replays it into the next turn', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: workspace.id,
      title: 'E2E', // non-default title so auto-title generation is skipped
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    const push = (): void => {}

    await send({ threadId: thread.id, text: 'rename this thread', disposition: 'send' }, push)
    await waitFor(() =>
      store
        .listMessages(thread.id)
        .some((m) => m.role === 'assistant' && m.status === 'complete' && m.text.includes('Done'))
    )

    const assistant = store.listMessages(thread.id).find((m) => m.role === 'assistant' && m.status === 'complete')!
    // The tool round was captured verbatim onto the producing assistant message.
    expect(assistant.toolExchanges?.length).toBeGreaterThanOrEqual(2)
    const callMsg = assistant.toolExchanges![0]!
    const resultMsg = assistant.toolExchanges![1]!
    expect(callMsg).toMatchObject({ role: 'assistant', content: null })
    expect(callMsg.tool_calls?.[0]?.function.name).toBe('set_thread_title')
    expect(resultMsg).toMatchObject({ role: 'tool', tool_call_id: callMsg.tool_calls![0]!.id })

    // While the call was still streaming in, a `tool.drafting` event surfaced it live so the
    // transcript could show a "preparing" row before the whole stream landed. It must carry the
    // same callId the executed call uses, so the drafted row and the executed row are one.
    const events = store.listEvents(thread.id)
    const drafting = events.find((e) => e.body.type === 'tool.drafting')
    expect(drafting?.body).toMatchObject({ type: 'tool.drafting', callId: 'call_rename', tool: 'set_thread_title' })
    const started = events.find((e) => e.body.type === 'tool.started')
    expect((started?.body as { callId: string }).callId).toBe('call_rename')

    // And a fresh turn's wire re-sends that exchange, so the model still sees what the tool did.
    const meta = store.getThreadMeta(thread.id)!
    const wire = buildWireMessages(thread.id, meta, meta.model, meta.effort)
    const toolMsgs = wire.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0]!.name).toBe('set_thread_title')
  })
})
