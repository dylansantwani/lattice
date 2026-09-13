import { describe, expect, it } from 'vitest'
import type { RunEvent, RunEventBody } from '../types'
import { summarizeTurn } from './turnSummary'

let seq = 0
const ev = (body: RunEventBody, ts: number, agent?: string): RunEvent => ({ id: `e${seq}`, runId: 'r1', threadId: 't1', seq: seq++, ts, agent, body })

describe('summarizeTurn', () => {
  it('folds a run into prose, one activity block with steps, and a terminal status', () => {
    seq = 0
    const events: RunEvent[] = [
      ev({ type: 'run.started', model: 'deepseek/deepseek-v4-flash', mode: 'act' } as RunEventBody, 1000),
      ev({ type: 'reasoning.delta', text: 'let me look', fidelity: 'raw' }, 1010),
      ev({ type: 'reasoning.done', fidelity: 'raw', durationMs: 2100 }, 3100),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: { path: 'src/app.ts' } }, 3200),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: { content: 'x' }, durationMs: 40 }, 3300),
      ev({ type: 'tool.started', callId: 'c2', tool: 'shell', args: { command: 'npm test', purpose: 'Run the tests' } }, 3400),
      ev({ type: 'tool.result', callId: 'c2', tool: 'shell', ok: false, result: { stdout: '', exitCode: 2 }, durationMs: 4200 }, 7600),
      ev({ type: 'text.delta', text: 'Two tests fail.' }, 7700),
      ev({ type: 'run.completed', reason: 'done' }, 7800)
    ]
    const s = summarizeTurn('r1', events, { model: 'deepseek/deepseek-v4-flash' })
    expect(s.status).toBe('complete')
    expect(s.eventCount).toBe(9)
    expect(s.flow.map((n) => n.kind)).toEqual(['activity', 'prose'])
    const act = s.flow[0]!
    if (act.kind !== 'activity') throw new Error('expected activity')
    expect(act.summary).toBe('Ran 1 command, read 1 file, thought 2s')
    expect(act.status).toBe('failed')
    expect(act.failed).toBe(1)
    expect(act.steps.map((st) => st.kind)).toEqual(['thought', 'tool', 'tool'])
    expect(act.steps[0]).toMatchObject({ verb: 'Thought for 2s', text: 'let me look' })
    expect(act.steps[1]).toMatchObject({ verb: 'Read', subject: 'src/app.ts', mono: true, status: 'complete' })
    expect(act.steps[2]).toMatchObject({ verb: 'Run the tests', subject: 'npm test', status: 'failed', side: 'exit 2' })
    expect(s.flow[1]).toEqual({ kind: 'prose', text: 'Two tests fail.' })
  })

  it('turns a delegation into an agent node with its report and keeps subagent events out of the flow', () => {
    seq = 0
    const events: RunEvent[] = [
      ev({ type: 'tool.started', callId: 'a1', tool: 'run_agent', args: { name: 'Scout', agent_type: 'explorer', task: 'find it' } }, 1000),
      ev({ type: 'reasoning.delta', text: 'agent thinking', fidelity: 'raw' }, 1100, 'agent-1'),
      ev({ type: 'tool.started', callId: 'x', tool: 'shell', args: { command: 'ls' } }, 1200, 'agent-1'),
      ev({ type: 'tool.result', callId: 'a1', tool: 'run_agent', ok: true, result: { result: 'Found it in src/x.ts' }, durationMs: 9000 }, 9000)
    ]
    const s = summarizeTurn('r1', events)
    expect(s.flow).toEqual([{ kind: 'agent', callId: 'a1', name: 'Scout', role: 'explorer', status: 'complete', report: 'Found it in src/x.ts' }])
  })

  it('marks a live run running with its trailing block still open, and an errored run failed', () => {
    seq = 0
    const live = summarizeTurn('r1', [ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { command: 'sleep 5' } }, 1000)], { live: true })
    expect(live.status).toBe('running')
    expect(live.flow[0]).toMatchObject({ kind: 'activity', status: 'running' })
    seq = 0
    const failed = summarizeTurn('r1', [ev({ type: 'error', category: 'rate_limit', message: 'slow down', retryable: true }, 1000)])
    expect(failed.status).toBe('failed')
    expect(failed.error).toEqual({ category: 'rate_limit', message: 'slow down' })
  })

  it('clips thoughts and reports and drops oversized images', () => {
    seq = 0
    const big = 'data:image/png;base64,' + 'A'.repeat(300_000)
    const events: RunEvent[] = [
      ev({ type: 'reasoning.delta', text: 'x'.repeat(5000), fidelity: 'raw' }, 1000),
      ev({ type: 'reasoning.done', fidelity: 'raw', durationMs: 5000 }, 6000),
      ev({ type: 'tool.started', callId: 'i1', tool: 'show_image', args: { path: 'a.png' } }, 6100),
      ev({ type: 'tool.result', callId: 'i1', tool: 'show_image', ok: true, result: { type: 'image', data: big }, durationMs: 5 }, 6200)
    ]
    const s = summarizeTurn('r1', events, { maxThoughtChars: 100 })
    const act = s.flow[0]!
    if (act.kind !== 'activity') throw new Error('expected activity')
    expect(act.steps[0]!.text!.length).toBe(101)
    expect(act.images).toBeUndefined()
    expect(act.summary).toBe('Showed 1 image, thought 5s')
  })
})
