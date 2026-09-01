import { describe, it, expect } from 'vitest'
import type { RunEvent, RunEventBody } from '@shared/types'
import { buildTimeline, type TimelineItem } from './runTimeline'

let seq = 0
function ev(body: RunEventBody, ts: number): RunEvent {
  return { id: `e${seq}`, runId: 'r1', threadId: 't1', seq: seq++, ts, body }
}

function reset(): void {
  seq = 0
}

function asThink(item: TimelineItem): Extract<TimelineItem, { kind: 'think' }> {
  if (item.kind !== 'think') throw new Error(`expected think, got ${item.kind}`)
  return item
}

function asTool(item: TimelineItem): Extract<TimelineItem, { kind: 'tool' }> {
  if (item.kind !== 'tool') throw new Error(`expected tool, got ${item.kind}`)
  return item
}

describe('buildTimeline', () => {
  it('orders a think → tools sequence with the thinking block first', () => {
    reset()
    const events = [
      ev({ type: 'reasoning.delta', text: 'let me ', fidelity: 'summary' }, 1000),
      ev({ type: 'reasoning.delta', text: 'check', fidelity: 'summary' }, 1200),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 1500),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: { path: 'a' } }, 1600),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: 'x', durationMs: 40 }, 1700)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool'])
    const think = asThink(items[0]!)
    expect(think.text).toBe('let me check')
    // Duration is the real thinking span (done − first delta), not the whole turn.
    expect(think.endTs! - think.startTs).toBe(500)
    const tool = asTool(items[1]!)
    expect(tool.call.status).toBe('complete')
    expect(tool.call.durationMs).toBe(40)
  })

  it('closes an unterminated thinking segment when a tool call begins', () => {
    reset()
    // No reasoning.done arrives — the tool.started must still close the segment.
    const events = [
      ev({ type: 'reasoning.delta', text: 'thinking', fidelity: 'raw' }, 2000),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: {} }, 2300)
    ]
    const items = buildTimeline(events)
    expect(items).toHaveLength(2)
    expect(asThink(items[0]!).endTs).toBe(2300)
  })

  it('keeps separate thinking bouts around interleaved tool calls', () => {
    reset()
    const events = [
      ev({ type: 'reasoning.delta', text: 'first', fidelity: 'summary' }, 0),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 100),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: {} }, 150),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: '', durationMs: 5 }, 200),
      ev({ type: 'reasoning.delta', text: 'second', fidelity: 'summary' }, 250),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 300)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool', 'think'])
    expect(asThink(items[0]!).text).toBe('first')
    expect(asThink(items[2]!).text).toBe('second')
  })

  it('leaves a live segment open (no endTs) until it is closed', () => {
    reset()
    const items = buildTimeline([ev({ type: 'reasoning.delta', text: 'still going', fidelity: 'raw' }, 500)])
    expect(items).toHaveLength(1)
    expect(asThink(items[0]!).endTs).toBeUndefined()
  })

  it('groups multi-event tool calls into one row at its first position', () => {
    reset()
    const events = [
      ev({ type: 'tool.proposed', callId: 'c1', tool: 'shell', args: { cmd: 'ls' }, riskTier: 'R1' }, 0),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { cmd: 'ls' } }, 10),
      ev({ type: 'tool.denied', callId: 'c1', reason: 'blocked by policy' }, 20)
    ]
    const items = buildTimeline(events)
    expect(items).toHaveLength(1)
    const tool = asTool(items[0]!)
    expect(tool.call.status).toBe('blocked')
    expect(tool.call.reason).toBe('blocked by policy')
  })

  it('sorts out-of-order events by seq before weaving', () => {
    reset()
    const a = ev({ type: 'reasoning.delta', text: 'x', fidelity: 'summary' }, 0)
    const b = ev({ type: 'reasoning.done', fidelity: 'summary' }, 50)
    const c = ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: {} }, 60)
    const items = buildTimeline([c, a, b])
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool'])
  })
})
