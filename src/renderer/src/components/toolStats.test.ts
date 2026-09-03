import { describe, expect, it } from 'vitest'
import type { RunEvent, RunEventBody } from '@shared/types'
import { summarizeToolCalls } from './toolStats'

const ev = (body: RunEventBody, seq: number, agent?: string): RunEvent =>
  ({ id: `e${seq}`, runId: 'r', threadId: 't', seq, ts: seq * 10, agent, body }) as RunEvent

describe('summarizeToolCalls', () => {
  it('counts calls, failures, and mean duration per tool, across main and subagent events', () => {
    const stats = summarizeToolCalls([
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: {} }, 1),
      ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: {}, durationMs: 100 }, 2),
      ev({ type: 'tool.started', callId: 'c2', tool: 'shell', args: {} }, 3, 'a1'),
      ev({ type: 'tool.result', callId: 'c2', tool: 'shell', ok: false, result: {}, durationMs: 300 }, 4, 'a1'),
      ev({ type: 'tool.proposed', callId: 'c3', tool: 'fs_delete', args: {}, riskTier: 'R2' }, 5),
      ev({ type: 'tool.denied', callId: 'c3', reason: 'no' }, 6)
    ])
    expect(stats.get('shell')).toEqual({ calls: 2, failed: 1, avgMs: 200, lastAt: 40 })
    expect(stats.get('fs_delete')).toEqual({ calls: 1, failed: 1, avgMs: null, lastAt: 60 })
    expect(stats.has('fs_read')).toBe(false)
  })
})
