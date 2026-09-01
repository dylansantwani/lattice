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
