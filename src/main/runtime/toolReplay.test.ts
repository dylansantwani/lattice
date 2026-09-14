import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '@shared/id'
import type { ChatMessage, ThreadId, ThreadMeta, WireExchange } from '@shared/types'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-tool-replay-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn() }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { buildWireMessages, getContextBudget } from './runManager'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

function makeThread(): ThreadMeta {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({
    workspaceId: workspace.id,
    title: 'Replay thread',
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace'
  })
}

// A realistic captured round: assistant tool_calls (text nulled) → tool result.
function exampleExchange(): WireExchange[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'read_file', content: JSON.stringify({ ok: true, text: 'file body' }) }
  ]
}

function insert(threadId: ThreadId, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const msg: ChatMessage = { id: ulid(), threadId, role, createdAt: Date.now(), text, ...extra }
  store.insertMessage(msg)
  return msg
}

describe('tool-exchange persistence', () => {
  it('round-trips toolExchanges through insert and listMessages', () => {
    const t = makeThread()
    const ex = exampleExchange()
    insert(t.id, 'assistant', 'I read the file.', { runId: 'r1', toolExchanges: ex })

    const msg = store.listMessages(t.id)[0]!
    expect(msg.toolExchanges).toEqual(ex)
  })

  it('preserves toolExchanges across an unrelated updateMessage', () => {
    const t = makeThread()
    const m = insert(t.id, 'assistant', '', { runId: 'r1', toolExchanges: exampleExchange() })
    // Finalizing the visible text must not drop the already-stored exchanges.
    const updated = store.updateMessage(m.id, { text: 'done', status: 'complete' })
    expect(updated?.toolExchanges).toEqual(exampleExchange())
    expect(store.listMessages(t.id)[0]!.toolExchanges).toEqual(exampleExchange())
  })
})

describe('buildWireMessages tool replay', () => {
  it('replays tool exchanges before the assistant text, in order', () => {
    const t = makeThread()
    insert(t.id, 'user', 'read a.ts for me')
    insert(t.id, 'assistant', 'I read the file.', { runId: 'r1', toolExchanges: exampleExchange() })

    const wire = buildWireMessages(t.id, t, t.model, t.effort)
    // Drop the leading system prompt; assert the conversation shape that follows.
    const convo = wire.filter((m) => m.role !== 'system')
    expect(convo.map((m) => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant'])
    // The assistant tool-call message carries the call and no duplicated text.
    const toolCallMsg = convo[1]!
    expect(toolCallMsg.tool_calls?.[0]?.function.name).toBe('read_file')
    expect(toolCallMsg.content).toBeNull()
    // Its result immediately follows, matched by id.
    expect(convo[2]).toMatchObject({ role: 'tool', tool_call_id: 'call_1' })
    // The visible text lands after the exchange.
    expect(convo[3]).toMatchObject({ role: 'assistant', content: 'I read the file.' })
  })

  it('replays DeepSeek reasoning_content but strips it for other models', () => {
    const t = makeThread()
    const exchanges: WireExchange[] = [
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'tool-call thought',
        tool_calls: [{ id: 'call_ds', type: 'function', function: { name: 'read_file', arguments: '{}' } }]
      },
      { role: 'tool', tool_call_id: 'call_ds', name: 'read_file', content: 'ok' }
    ]
    insert(t.id, 'user', 'inspect it')
    insert(t.id, 'assistant', 'Finished.', {
      runId: 'r1',
      model: 'deepseek/deepseek-v4.1-flash-expires-on-0910',
      reasoningContent: 'final-answer thought',
      toolExchanges: exchanges
    })

    const deepSeek = buildWireMessages(t.id, t, 'deepseek/deepseek-v4.1-flash-expires-on-0910', 'high')
    const deepSeekToolCall = deepSeek.find((m) => m.role === 'assistant' && m.tool_calls)
    const deepSeekFinal = deepSeek.find((m) => m.role === 'assistant' && m.content === 'Finished.')
    expect(deepSeekToolCall?.reasoning_content).toBe('tool-call thought')
    expect(deepSeekFinal?.reasoning_content).toBe('final-answer thought')

    const otherModel = buildWireMessages(t.id, t, 'test/model', 'high')
    expect(otherModel.some((m) => 'reasoning_content' in m)).toBe(false)
  })

  it('does not replay tool exchanges from a compacted message', () => {
    const t = makeThread()
    const a = insert(t.id, 'assistant', 'old work', { runId: 'r1', toolExchanges: exampleExchange() })
    store.markMessagesCompacted([a.id])
    insert(t.id, 'system', 'summary of the old work') // the compaction summary that replaces it

    const wire = buildWireMessages(t.id, t, t.model, t.effort)
    // No tool-role messages survive from the folded-away turn.
    expect(wire.some((m) => m.role === 'tool')).toBe(false)
  })
})

describe('getContextBudget with tool exchanges', () => {
  it('counts replayed tool exchanges toward history', () => {
    const withEx = makeThread()
    insert(withEx.id, 'assistant', 'short', { runId: 'r1', toolExchanges: exampleExchange() })
    const withoutEx = makeThread()
    insert(withoutEx.id, 'assistant', 'short', { runId: 'r1' })

    const a = getContextBudget(withEx.id, [])!.segments.history
    const b = getContextBudget(withoutEx.id, [])!.segments.history
    // The tool call + its result are real re-sent context, so they lift history above the bare text.
    expect(a).toBeGreaterThan(b)
  })
})

describe('buildWireMessages persisted recall', () => {
  it('prepends the recall block stored with a user turn, byte-identically on every build', () => {
    const t = store.createThread({ workspaceId: store.ensureDefaultWorkspace().id, title: 'recall', model: 'm/x' })
    const msg: ChatMessage = {
      id: ulid(),
      threadId: t.id,
      role: 'user',
      createdAt: Date.now(),
      text: 'what were we doing?',
      recallText: '[recalled memory] Facts.\n- port 8092 is the qwen box'
    }
    store.insertMessage(msg)
    const first = buildWireMessages(t.id, t, t.model, t.effort)
    const user = first.find((m) => m.role === 'user')!
    expect(user.content).toBe('[recalled memory] Facts.\n- port 8092 is the qwen box\n\nwhat were we doing?')
    const second = buildWireMessages(t.id, t, t.model, t.effort)
    expect(second.find((m) => m.role === 'user')!.content).toBe(user.content)
    // A turn with nothing recalled ('' = computed, empty) is sent verbatim.
    store.insertMessage({ id: ulid(), threadId: t.id, role: 'user', createdAt: Date.now() + 1, text: 'plain', recallText: '' })
    const wire = buildWireMessages(t.id, t, t.model, t.effort)
    expect([...wire].reverse().find((m) => m.role === 'user')!.content).toBe('plain')
  })
})
