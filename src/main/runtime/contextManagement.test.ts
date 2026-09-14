/**
 * Context management for long-lived agent threads (2026-09-14 fleet audit follow-up): orphaned queued
 * rows, fresh-per-task worker context, slimming the assistant side of stale rounds, and the in-flight
 * guard following each thread's own policy. Store-backed, like inFlightFit.test.ts.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { ChatMessage, ContextPolicy, WireExchange } from '@shared/types'
import type { WireMessage } from '../providers/openaiCompat'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-context-mgmt-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn() }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import {
  budgetForWire,
  buildWireMessages,
  clearOrphanedQueuedMessages,
  clipToolArguments,
  fitWireToWindow,
  inFlightBudgetFor,
  IN_FLIGHT_WIRE_BUDGET_TOKENS,
  IN_FLIGHT_WIRE_RECLAIM_FLOOR_TOKENS,
  pruneStaleExchanges,
  STALE_ARGUMENT_KEEP_CHARS,
  STALE_REASONING_PLACEHOLDER,
  startFreshTaskContext
} from './runManager'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

let clock = Date.UTC(2026, 8, 14, 19, 0)
function thread(contextPolicy?: ContextPolicy) {
  const workspace = store.ensureDefaultWorkspace()
  const meta = store.createThread({ workspaceId: workspace.id, title: 'Agent', model: 'deepseek/deepseek-v4-flash', mode: 'act', permissionPreset: 'full', ...(contextPolicy ? { contextPolicy } : {}) })
  return store.getThreadMeta(meta.id)!
}
function add(threadId: string, role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  clock += 60_000
  const message: ChatMessage = { id: `m${clock}`, threadId, role, createdAt: clock, text, ...extra }
  store.insertMessage(message)
  return message
}
const prose = (words: number): string => 'the seller listed a black horse stand with dated sold entries '.repeat(Math.ceil(words / 11))

describe('clearOrphanedQueuedMessages', () => {
  it('clears queued rows the history moved past, keeps what a queue still holds and anything newer than the last reply', () => {
    const meta = thread()
    add(meta.id, 'user', 'task')
    const orphanA = add(meta.id, 'user', 'STOP STOP', { queued: true })
    const held = add(meta.id, 'user', 'requeued steer', { queued: true })
    add(meta.id, 'assistant', 'later reply', { runId: 'r1' })
    const tail = add(meta.id, 'user', 'sent while running', { queued: true })
    const pushed: PushEvent[] = []
    expect(clearOrphanedQueuedMessages(meta.id, new Set([held.id]), (event) => pushed.push(event))).toBe(1)
    const byId = new Map(store.listLiveMessages(meta.id).map((m) => [m.id, m]))
    expect(byId.get(orphanA.id)!.queued).toBe(false)
    expect(byId.get(held.id)!.queued).toBe(true)
    expect(byId.get(tail.id)!.queued).toBe(true)
    expect(pushed).toHaveLength(1)
  })
})

describe('startFreshTaskContext', () => {
  const fresh: ContextPolicy = { mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000, freshPerTask: true }

  it('sets an idle worker\'s earlier tasks aside behind one content-free marker', () => {
    const meta = thread(fresh)
    add(meta.id, 'user', 'Pull photos for the iPhone listing')
    add(meta.id, 'assistant', 'Geometry ≈120×120 mm base, ~150 mm post', {
      toolExchanges: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://www.ebay.com/itm/1"}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'web_fetch', content: prose(2_000) }
      ]
    })
    const pushed: PushEvent[] = []
    expect(startFreshTaskContext(meta.id, (event) => pushed.push(event))).toBe(2)
    const live = store.listLiveMessages(meta.id)
    expect(live).toHaveLength(1)
    expect(live[0]!.role).toBe('system')
    expect(live[0]!.text).not.toMatch(/120|iPhone/)
    // The wire the next task is built from carries none of the earlier job.
    const wire = JSON.stringify(buildWireMessages(meta.id, store.getThreadMeta(meta.id)!, meta.model))
    expect(wire).not.toContain('150 mm post')
    expect(wire).not.toContain('ebay.com/itm/1')
    expect(pushed.some((event) => event.kind === 'message.updated')).toBe(true)
    // Doing it again with nothing new is a no-op (only the marker is live).
    expect(startFreshTaskContext(meta.id, () => {})).toBe(0)
  })

  it('does nothing for a thread without the fresh-per-task policy', () => {
    const meta = thread({ mode: 'rolling', triggerTokens: 60_000, keepTokens: 20_000 })
    add(meta.id, 'user', 'q')
    add(meta.id, 'assistant', 'a')
    expect(startFreshTaskContext(meta.id, () => {})).toBe(0)
    expect(store.listLiveMessages(meta.id)).toHaveLength(2)
  })
})

describe('stale rounds shed their assistant side too', () => {
  it('clips long argument strings but keeps every key and valid JSON', () => {
    const brief = 'x'.repeat(4_000)
    const clipped = clipToolArguments(JSON.stringify({ agent: 'Photo Puller', task: brief, urls: ['a', brief] }))
    const parsed = JSON.parse(clipped) as { agent: string; task: string; urls: string[] }
    expect(parsed.agent).toBe('Photo Puller')
    expect(parsed.task.startsWith('x'.repeat(STALE_ARGUMENT_KEEP_CHARS))).toBe(true)
    expect(parsed.task).toContain('chars omitted')
    expect(parsed.urls[0]).toBe('a')
    expect(clipped.length).toBeLessThan(1_500)
    // Short, or non-JSON, arguments are untouched; the output is deterministic (cache-stable).
    expect(clipToolArguments('{"q":"short"}')).toBe('{"q":"short"}')
    expect(clipToolArguments('not json '.repeat(400))).toBe('not json '.repeat(400))
    expect(clipToolArguments(JSON.stringify({ task: brief }))).toBe(clipToolArguments(JSON.stringify({ task: brief })))
  })

  it('replaces stale reasoning with a placeholder (the field stays for DeepSeek) and pairs every call with its result', () => {
    const exchanges: WireExchange[] = [
      { role: 'assistant', content: null, reasoning_content: prose(1_500), tool_calls: [{ id: 'c1', type: 'function', function: { name: 'delegate_to_agent', arguments: JSON.stringify({ agent: 'W', task: prose(800) }) } }] },
      { role: 'tool', tool_call_id: 'c1', name: 'delegate_to_agent', content: '{"ok":true}' }
    ]
    const [assistant, tool] = pruneStaleExchanges(exchanges)
    expect(assistant!.reasoning_content).toBe(STALE_REASONING_PLACEHOLDER)
    expect(assistant!.tool_calls![0]!.id).toBe('c1')
    expect(assistant!.tool_calls![0]!.function.arguments.length).toBeLessThan(exchanges[0]!.tool_calls![0]!.function.arguments.length)
    expect(tool).toEqual(exchanges[1])
  })
})

describe('in-flight guard follows the thread policy', () => {
  it('uses the policy trigger as the working-set budget, with a floor at about half of it', () => {
    expect(inFlightBudgetFor({})).toEqual({ budget: IN_FLIGHT_WIRE_BUDGET_TOKENS, floor: IN_FLIGHT_WIRE_RECLAIM_FLOOR_TOKENS })
    expect(inFlightBudgetFor({ contextPolicy: { mode: 'rolling', triggerTokens: 60_000, keepTokens: 20_000 } })).toEqual({ budget: 60_000, floor: 30_000 })
    expect(inFlightBudgetFor({ contextPolicy: { mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000 } })).toEqual({ budget: 80_000, floor: 40_000 })
    // A huge policy never loosens the default guard.
    expect(inFlightBudgetFor({ contextPolicy: { mode: 'rolling', triggerTokens: 400_000, keepTokens: 100_000 } })).toEqual({ budget: 100_000, floor: 50_000 })
  })

  it('slims old assistant rounds when pruning results alone cannot reach the floor', () => {
    const meta = thread({ mode: 'rolling', triggerTokens: 20_000, keepTokens: 6_000 })
    const wire: WireMessage[] = [{ role: 'system', content: 'system' }]
    // Rounds whose mass is on the assistant side (long briefs + reasoning), with tiny results.
    for (let i = 0; i < 12; i++) {
      wire.push({ role: 'assistant', content: null, reasoning_content: prose(600), tool_calls: [{ id: `c${i}`, type: 'function', function: { name: 'delegate_to_agent', arguments: JSON.stringify({ agent: 'W', task: prose(500) }) } }] } as WireMessage)
      wire.push({ role: 'tool', tool_call_id: `c${i}`, name: 'delegate_to_agent', content: '{"ok":true}' })
    }
    const before = budgetForWire(meta.id, meta, [], wire).usedTokens
    expect(before).toBeGreaterThan(20_000)
    expect(fitWireToWindow(meta.id, meta, wire)).toBeGreaterThan(0)
    const after = budgetForWire(meta.id, meta, [], wire).usedTokens
    expect(after).toBeLessThan(before * 0.75)
    // Every round outside the 4-result working set was slimmed (results were too small to prune).
    const assistants = wire.filter((m) => m.role === 'assistant') as (WireMessage & { reasoning_content?: string })[]
    expect(assistants.slice(0, 8).every((m) => m.reasoning_content === STALE_REASONING_PLACEHOLDER)).toBe(true)
    expect(assistants.slice(8).every((m) => m.reasoning_content !== STALE_REASONING_PLACEHOLDER)).toBe(true)
    // The newest rounds (the working set) are untouched.
    const last = wire[wire.length - 2] as WireMessage & { reasoning_content?: string }
    expect(last.reasoning_content).not.toBe(STALE_REASONING_PLACEHOLDER)
    // Wire stays valid: every tool result still follows its call.
    const ids = new Set<string>()
    for (const m of wire) {
      for (const call of m.tool_calls ?? []) ids.add(call.id)
      if (m.role === 'tool') expect(ids.has(m.tool_call_id!)).toBe(true)
    }
  })
})
