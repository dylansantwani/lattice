import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '@shared/id'
import type { ChatMessage, ThreadId, WireExchange } from '@shared/types'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-tool-pruning-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn() }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import {
  buildWireMessages,
  getContextBudget,
  pruneStaleExchanges,
  prunedResultPlaceholder,
  reclaimedByToolPruning,
  staleToolTurnIds,
  TOOL_RESULT_KEEP_RECENT_TURNS,
  TOOL_RESULT_KEEP_RECENT_BUDGET_TOKENS
} from './runManager'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// A tool result body large enough to cross the prune threshold (~512 tokens). Varied prose so the
// tokenizer counts it normally rather than diverting to the repeated-char heuristic.
const bigBody = JSON.stringify({ text: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(200) })

function bigExchange(callId = 'call_1'): WireExchange[] {
  return [
    {
      role: 'assistant',
      content: null,
      tool_calls: [{ id: callId, type: 'function', function: { name: 'fs_read', arguments: '{"path":"a.ts"}' } }]
    },
    { role: 'tool', tool_call_id: callId, name: 'fs_read', content: bigBody }
  ]
}

function makeThread(): ThreadId {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({
    workspaceId: workspace.id,
    title: 'Pruning thread',
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace'
  }).id
}

function insertToolTurn(threadId: ThreadId, callId: string): ChatMessage {
  const msg: ChatMessage = {
    id: ulid(),
    threadId,
    role: 'assistant',
    createdAt: Date.now(),
    text: 'did some work',
    toolExchanges: bigExchange(callId)
  }
  store.insertMessage(msg)
  return msg
}

describe('staleToolTurnIds', () => {
  it('marks every tool turn except the most recent N as stale', () => {
    const turns: ChatMessage[] = Array.from({ length: 9 }, (_, i) => ({
      id: `m${i}`,
      threadId: 't' as ThreadId,
      role: 'assistant',
      createdAt: i,
      text: '',
      toolExchanges: bigExchange(`c${i}`)
    }))
    const stale = staleToolTurnIds(turns)
    // 9 tool turns, keep 6 → 3 oldest are stale.
    expect(stale.size).toBe(9 - TOOL_RESULT_KEEP_RECENT_TURNS)
    expect(stale.has('m0')).toBe(true)
    expect(stale.has('m2')).toBe(true)
    expect(stale.has('m3')).toBe(false) // first kept turn
    expect(stale.has('m8')).toBe(false) // most recent
  })

  it('ignores non-tool and compacted turns', () => {
    const turns: ChatMessage[] = [
      { id: 'plain', threadId: 't' as ThreadId, role: 'assistant', createdAt: 0, text: 'no tools' },
      { id: 'compacted', threadId: 't' as ThreadId, role: 'assistant', createdAt: 1, text: '', toolExchanges: bigExchange('x'), compacted: true },
      { id: 'live', threadId: 't' as ThreadId, role: 'assistant', createdAt: 2, text: '', toolExchanges: bigExchange('y') }
    ]
    // Only one live tool turn → nothing stale (well under the keep window).
    expect(staleToolTurnIds(turns).size).toBe(0)
  })

  // One delegation mega-turn can carry hundreds of KB of tool wire, so a turn-count window alone
  // kept ~90% of a measured 280k-token transcript verbatim and every later run re-billed it on
  // every round. The kept-recent set is therefore also token-budgeted.
  it('marks turns beyond the token budget stale even inside the recent-N window', () => {
    // Three mega turns, each alone larger than the keep budget.
    const mega = (id: string, at: number): ChatMessage => ({
      id,
      threadId: 't' as ThreadId,
      role: 'assistant',
      createdAt: at,
      text: '',
      toolExchanges: [
        { role: 'assistant', content: null, tool_calls: [{ id: `c-${id}`, type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: `c-${id}`, name: 'shell', content: 'x'.repeat(TOOL_RESULT_KEEP_RECENT_BUDGET_TOKENS * 4 + 4) }
      ]
    })
    const turns = [mega('old', 0), mega('mid', 1), mega('new', 2)]
    const stale = staleToolTurnIds(turns)
    // Only the newest survives — it is always kept whole; the older two blow the budget.
    expect(stale.has('new')).toBe(false)
    expect(stale.has('mid')).toBe(true)
    expect(stale.has('old')).toBe(true)
  })

  it('keeps the intact set contiguous from the newest turn once the budget boundary is hit', () => {
    const small = (id: string, at: number): ChatMessage => ({
      id,
      threadId: 't' as ThreadId,
      role: 'assistant',
      createdAt: at,
      text: '',
      toolExchanges: bigExchange(`c-${id}`)
    })
    const huge: ChatMessage = {
      id: 'huge',
      threadId: 't' as ThreadId,
      role: 'assistant',
      createdAt: 1,
      text: '',
      toolExchanges: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c-huge', type: 'function', function: { name: 'shell', arguments: '{}' } }] },
        { role: 'tool', tool_call_id: 'c-huge', name: 'shell', content: 'x'.repeat(TOOL_RESULT_KEEP_RECENT_BUDGET_TOKENS * 4 + 4) }
      ]
    }
    // Oldest small turn WOULD fit the leftover budget, but keeping it while pruning the newer huge
    // turn would make the intact set non-contiguous (and the decision unstable as turns age), so
    // everything older than the boundary goes stale with it.
    const stale = staleToolTurnIds([small('oldest', 0), huge, small('newest', 2)])
    expect(stale.has('newest')).toBe(false)
    expect(stale.has('huge')).toBe(true)
    expect(stale.has('oldest')).toBe(true)
  })
})

describe('pruneStaleExchanges', () => {
  it('replaces a large tool result body with a placeholder but keeps the pairing intact', () => {
    const pruned = pruneStaleExchanges(bigExchange('call_1'))
    // Assistant tool_calls message is untouched: the pairing the wire format requires survives.
    expect(pruned[0]).toEqual(bigExchange('call_1')[0])
    // The tool result keeps its id and name; only the heavy body is shed.
    expect(pruned[1]!.tool_call_id).toBe('call_1')
    expect(pruned[1]!.name).toBe('fs_read')
    expect(typeof pruned[1]!.content).toBe('string')
    expect(pruned[1]!.content as string).toContain('pruned to save context')
    expect((pruned[1]!.content as string).length).toBeLessThan(bigBody.length)
  })

  it('leaves small tool results alone', () => {
    const small: WireExchange[] = [
      { role: 'tool', tool_call_id: 'c', name: 'fs_read', content: JSON.stringify({ ok: true }) }
    ]
    expect(pruneStaleExchanges(small)).toEqual(small)
  })

  it('drops tool-returned images from the user carrier message', () => {
    const withImage: WireExchange[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Image returned by the tool call above:' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
        ]
      }
    ]
    const pruned = pruneStaleExchanges(withImage)
    const parts = pruned[0]!.content as Array<{ type: string }>
    expect(parts.some((p) => p.type === 'image_url')).toBe(false)
    expect(parts.some((p) => p.type === 'text')).toBe(true)
  })

  it('produces a byte-stable placeholder independent of position', () => {
    // Same content ⇒ identical placeholder, no matter how far back the turn is. This is what keeps
    // the cache prefix stable once a result is pruned.
    const a = prunedResultPlaceholder('fs_read', 1234)
    const b = prunedResultPlaceholder('fs_read', 1234)
    expect(a).toBe(b)
    expect(prunedResultPlaceholder(undefined, 10)).not.toContain('undefined')
  })
})

describe('buildWireMessages pruning integration', () => {
  it('prunes far-back tool results but keeps the recent working set in full', () => {
    const t = store.getThreadMeta(makeThread())!
    // Eight tool turns: with a keep window of 6, the two oldest are pruned.
    const ids = Array.from({ length: 8 }, (_, i) => insertToolTurn(t.id, `call_${i}`).id)

    const wire = buildWireMessages(t.id, t, t.model, t.effort)
    const toolMsgs = wire.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(8)
    // The two oldest are placeholders; the rest carry the full body.
    const prunedCount = toolMsgs.filter((m) => typeof m.content === 'string' && m.content.includes('pruned to save context')).length
    expect(prunedCount).toBe(8 - TOOL_RESULT_KEEP_RECENT_TURNS)
    const fullCount = toolMsgs.filter((m) => m.content === bigBody).length
    expect(fullCount).toBe(TOOL_RESULT_KEEP_RECENT_TURNS)
    expect(ids.length).toBe(8)
  })

  it('respects the pruneToolResults=false setting', () => {
    const t = store.getThreadMeta(makeThread())!
    for (let i = 0; i < 8; i++) insertToolTurn(t.id, `call_${i}`)
    store.setSettings({ pruneToolResults: false })

    const wire = buildWireMessages(t.id, t, t.model, t.effort)
    const toolMsgs = wire.filter((m) => m.role === 'tool')
    // Nothing pruned: every result is its full body.
    expect(toolMsgs.every((m) => m.content === bigBody)).toBe(true)
  })

  it('reports reclaimed tokens in the context budget when pruning bites', () => {
    const t = makeThread()
    for (let i = 0; i < 8; i++) insertToolTurn(t, `call_${i}`)
    const budget = getContextBudget(t, [])!
    expect(budget.prunedTokens).toBeGreaterThan(0)
  })

  it('reports no reclaimed tokens on a short thread within the keep window', () => {
    const t = makeThread()
    for (let i = 0; i < 3; i++) insertToolTurn(t, `call_${i}`)
    const budget = getContextBudget(t, [])!
    expect(budget.prunedTokens).toBeUndefined()
  })
})

describe('reclaimedByToolPruning memoization', () => {
  it('is stable across streaming text updates and invalidates when a new tool turn lands', () => {
    const t = makeThread()
    for (let i = 0; i < 8; i++) insertToolTurn(t, `call_${i}`)
    const first = reclaimedByToolPruning(t)
    expect(first).toBeGreaterThan(0)

    // A streaming text flush (the per-reply hot path) must not change the answer — this is what
    // the toolWireRevision-keyed memo serves without re-reading the thread.
    const streaming: ChatMessage = {
      id: ulid(),
      threadId: t,
      role: 'assistant',
      createdAt: Date.now(),
      text: ''
    }
    store.insertMessage(streaming)
    store.updateMessage(streaming.id, { text: 'partial…' })
    expect(reclaimedByToolPruning(t)).toBe(first)

    // A ninth tool turn pushes one more old turn past the keep window: the reclaimed figure grows,
    // proving the memo invalidated rather than serving the stale value.
    insertToolTurn(t, 'call_8')
    expect(reclaimedByToolPruning(t)).toBeGreaterThan(first)
  })

  it('returns zero the moment pruning is disabled, memo or not', () => {
    const t = makeThread()
    for (let i = 0; i < 8; i++) insertToolTurn(t, `call_${i}`)
    expect(reclaimedByToolPruning(t)).toBeGreaterThan(0)
    store.setSettings({ pruneToolResults: false })
    expect(reclaimedByToolPruning(t)).toBe(0)
  })
})
