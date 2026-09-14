import { describe, expect, it } from 'vitest'
import type { RunEvent, RunEventBody } from '../types'
import { compactRunEvents } from './compactEvents'

let seq = 0
const ev = (body: RunEventBody, run = 'r1', agent?: string): RunEvent => ({ id: `e${seq}`, runId: run, threadId: 't1', seq: seq++, ts: 1000 + seq, agent, body })

describe('compactRunEvents', () => {
  it('merges consecutive deltas, keeps the first chunk identity, and never merges across runs or lanes', () => {
    seq = 0
    const out = compactRunEvents([
      ev({ type: 'reasoning.delta', text: 'a', fidelity: 'raw', startedAt: 5 }),
      ev({ type: 'reasoning.delta', text: 'b', fidelity: 'summary' }),
      ev({ type: 'reasoning.delta', text: 'c', fidelity: 'summary' }, 'r1', 'agent-1'),
      ev({ type: 'text.delta', text: 'x' }),
      ev({ type: 'text.delta', text: 'y' }),
      ev({ type: 'text.delta', text: 'z' }, 'r2')
    ])
    expect(out.map((e) => [e.id, e.body.type, (e.body as { text: string }).text])).toEqual([
      ['e0', 'reasoning.delta', 'ab'],
      ['e2', 'reasoning.delta', 'c'],
      ['e3', 'text.delta', 'xy'],
      ['e5', 'text.delta', 'z']
    ])
    expect(out[0]!.body).toMatchObject({ startedAt: 5, fidelity: 'summary' })
  })

  it('drops drafts and progress that a settled call superseded, keeping only the last of an open call', () => {
    seq = 0
    const out = compactRunEvents([
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'shell', args: '{"com' }),
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'shell', args: '{"command":"ls"}' }),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { command: 'ls' } }),
      ev({ type: 'tool.progress', callId: 'c1', output: 'a' }),
      ev({ type: 'tool.progress', callId: 'c1', output: 'ab' }),
      ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: { stdout: 'ab' }, durationMs: 10 }),
      ev({ type: 'tool.drafting', callId: 'c2', tool: 'fs_write', args: '{"pa' }),
      ev({ type: 'tool.drafting', callId: 'c2', tool: 'fs_write', args: '{"path":"x"' }),
      ev({ type: 'tool.started', callId: 'c3', tool: 'shell', args: { command: 'sleep' } }),
      ev({ type: 'tool.progress', callId: 'c3', output: '1' }),
      ev({ type: 'tool.progress', callId: 'c3', output: '12' })
    ])
    expect(out.map((e) => `${e.body.type}:${(e.body as { callId: string }).callId}`)).toEqual([
      'tool.started:c1',
      'tool.result:c1',
      'tool.drafting:c2',
      'tool.started:c3',
      'tool.progress:c3'
    ])
    expect((out[2]!.body as { args: string }).args).toBe('{"path":"x"')
    expect((out[4]!.body as { output: string }).output).toBe('12')
  })

  it('clips an oversized result and flags it, leaving small ones untouched', () => {
    seq = 0
    const out = compactRunEvents(
      [
        ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: { stdout: 'x'.repeat(50) }, durationMs: 1 }),
        ev({ type: 'tool.result', callId: 'c2', tool: 'shell', ok: true, result: 'small', durationMs: 1 })
      ],
      { maxResultChars: 20 }
    )
    const big = out[0]!.body as { result: string; truncated?: boolean; fullChars?: number }
    expect(big.truncated).toBe(true)
    expect(big.fullChars).toBe(JSON.stringify({ stdout: 'x'.repeat(50) }).length)
    expect(big.result.startsWith('{"stdout":"xxxxxxxxx')).toBe(true)
    expect(out[1]!.body).toMatchObject({ result: 'small' })
    expect((out[1]!.body as { truncated?: boolean }).truncated).toBeUndefined()
  })

  it('keeps every other event kind in order', () => {
    seq = 0
    const kinds: RunEventBody[] = [
      { type: 'run.started', model: 'm', mode: 'act' } as RunEventBody,
      { type: 'usage', usage: { tokensIn: 1 } },
      { type: 'retry', attempt: 1, reason: 'x' },
      { type: 'error', category: 'unknown', message: 'boom', retryable: false },
      { type: 'run.completed', reason: 'done' }
    ]
    const out = compactRunEvents(kinds.map((k) => ev(k)))
    expect(out.map((e) => e.body.type)).toEqual(kinds.map((k) => k.type))
  })
})
