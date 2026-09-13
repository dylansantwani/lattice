import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadId } from '@shared/types'
import type { WireMessage } from '../providers/openaiCompat'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-inflight-fit-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn() }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import {
  budgetForWire,
  fitWireToWindow,
  IN_FLIGHT_KEEP_RECENT_TOOL_MSGS,
  IN_FLIGHT_WIRE_BUDGET_TOKENS,
  IN_FLIGHT_WIRE_RECLAIM_FLOOR_TOKENS
} from './runManager'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

// ~6k-token tool body — comfortably over the 512-token prune floor, and small enough that a handful
// tokenizes fast. Varied prose so the tokenizer counts it normally, not via the repeated-char path.
const heavyBody = JSON.stringify({ text: 'lorem ipsum dolor sit amet consectetur adipiscing elit '.repeat(450) })

function makeThreadMeta() {
  const workspace = store.ensureDefaultWorkspace()
  const id = store.createThread({
    workspaceId: workspace.id,
    title: 'In-flight fit thread',
    // No provider is cached in the test, so budgetForWire falls back to the 128k default window.
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace'
  }).id
  return store.getThreadMeta(id)!
}

/** A run's in-flight wire: a system message plus `rounds` single-call tool rounds carrying heavy bodies. */
function inFlightWire(rounds: number): WireMessage[] {
  const wire: WireMessage[] = [{ role: 'system', content: 'system prompt' }]
  for (let i = 0; i < rounds; i++) {
    const callId = `call_${i}`
    wire.push({ role: 'assistant', content: null, tool_calls: [{ id: callId, type: 'function', function: { name: 'fs_read', arguments: '{}' } }] })
    wire.push({ role: 'tool', tool_call_id: callId, name: 'fs_read', content: heavyBody })
  }
  return wire
}

const isPlaceholder = (c: unknown): boolean => typeof c === 'string' && c.includes('pruned to save context')

describe('fitWireToWindow', () => {
  it('leaves a wire that already fits untouched', () => {
    const meta = makeThreadMeta()
    const wire = inFlightWire(3) // ~18k tokens, well under the 128k default window
    const before = JSON.stringify(wire)
    expect(fitWireToWindow(meta.id, meta, wire)).toBe(0)
    expect(JSON.stringify(wire)).toBe(before)
  })

  it('sheds the oldest in-flight tool bodies so an overflowing wire fits the window', () => {
    const meta = makeThreadMeta()
    // ~45 heavy rounds tokens — over the ~121k usable room of the 128k default window.
    const wire = inFlightWire(45)
    expect(budgetForWire(meta.id, meta, [], wire).occupancy).toBe(1) // saturated before the guard

    const pruned = fitWireToWindow(meta.id, meta, wire)
    expect(pruned).toBeGreaterThan(0)

    // The wire now fits: used is back under usable room, so the provider request won't overflow.
    const after = budgetForWire(meta.id, meta, [], wire)
    expect(after.usedTokens).toBeLessThanOrEqual(after.usableTokens)
  })

  it('preserves the most recent working set and prunes from the oldest end', () => {
    const meta = makeThreadMeta()
    const wire = inFlightWire(45)
    fitWireToWindow(meta.id, meta, wire)

    const toolMsgs = wire.filter((m) => m.role === 'tool')
    expect(toolMsgs.length).toBe(45) // pruning replaces bodies, never drops the message
    // The last N tool results keep their full body...
    const recent = toolMsgs.slice(-IN_FLIGHT_KEEP_RECENT_TOOL_MSGS)
    expect(recent.every((m) => m.content === heavyBody)).toBe(true)
    // ...and pruning came off the oldest end (the very first result is a placeholder).
    expect(isPlaceholder(toolMsgs[0]!.content)).toBe(true)
  })

  it('replaces slots rather than mutating them, so captured references keep the full body', () => {
    const meta = makeThreadMeta()
    const wire = inFlightWire(45)
    // Mimic segmentToolWire capturing the object reference before the guard runs (see the run loop).
    const captured = wire[2] // first tool result
    fitWireToWindow(meta.id, meta, wire)
    expect(captured!.content).toBe(heavyBody) // capture untouched — persistence keeps full fidelity
    expect(wire[2]).not.toBe(captured) // the wire slot was replaced, not mutated
    expect(isPlaceholder(wire[2]!.content)).toBe(true)
  })

  it('prunes to survive even when pruneToolResults is disabled — a dead run is worse', () => {
    const meta = makeThreadMeta()
    store.setSettings({ pruneToolResults: false })
    const wire = inFlightWire(45)
    expect(fitWireToWindow(meta.id, meta, wire)).toBeGreaterThan(0)
    const after = budgetForWire(meta.id, meta, [], wire)
    expect(after.usedTokens).toBeLessThanOrEqual(after.usableTokens)
  })

  it('trips the working-set budget long before the window and prunes down to the reclaim floor', () => {
    const meta = makeThreadMeta()
    // 27 heavy rounds ≈ 108k tokens: comfortably inside the 128k default window (no overflow) but
    // over the 100k working-set budget.
    const wire = inFlightWire(27)
    const before = budgetForWire(meta.id, meta, [], wire)
    expect(before.usedTokens).toBeLessThanOrEqual(before.usableTokens)
    expect(before.usedTokens).toBeGreaterThan(IN_FLIGHT_WIRE_BUDGET_TOKENS)

    const pruned = fitWireToWindow(meta.id, meta, wire)
    expect(pruned).toBeGreaterThan(0)
    // Hysteresis: the pass prunes deep — down to the floor, not merely back under the trigger.
    const after = budgetForWire(meta.id, meta, [], wire)
    expect(after.usedTokens).toBeLessThanOrEqual(IN_FLIGHT_WIRE_RECLAIM_FLOOR_TOKENS)
    // The working set the model is reasoning over right now is never touched.
    const toolMsgs = wire.filter((m) => m.role === 'tool')
    const recent = toolMsgs.slice(-IN_FLIGHT_KEEP_RECENT_TOOL_MSGS)
    expect(recent.every((m) => m.content === heavyBody)).toBe(true)
  })

  it('does not re-prune on the next round after a budget trip (one bust per reclaim, not per round)', () => {
    const meta = makeThreadMeta()
    const wire = inFlightWire(27)
    expect(fitWireToWindow(meta.id, meta, wire)).toBeGreaterThan(0)
    // Simulate the next few rounds appending fresh results: still under the trigger, so no action —
    // pruning a sliver every round would bust the prompt cache every round.
    wire.push({ role: 'assistant', content: null, tool_calls: [{ id: 'call_next', type: 'function', function: { name: 'fs_read', arguments: '{}' } }] })
    wire.push({ role: 'tool', tool_call_id: 'call_next', name: 'fs_read', content: heavyBody })
    expect(fitWireToWindow(meta.id, meta, wire)).toBe(0)
  })

  it('leaves a within-window wire alone when pruneToolResults is off — the budget is opt-out', () => {
    const meta = makeThreadMeta()
    store.setSettings({ pruneToolResults: false })
    const wire = inFlightWire(27) // over budget, under window
    const before = JSON.stringify(wire)
    expect(fitWireToWindow(meta.id, meta, wire)).toBe(0)
    expect(JSON.stringify(wire)).toBe(before)
  })
})
