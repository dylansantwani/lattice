import { describe, it, expect } from 'vitest'
import type { RunEvent, RunEventBody } from '@shared/types'
import {
  agentIdFromResult,
  indexSubagents,
  isBackgroundHandle,
  resultErrorOf,
  resultTextOf,
  subagentForCall,
  subagentPhase,
  titleCase,
  RECENT_TOOLS
} from './subagents'
import type { ToolCall } from './runTimeline'

let seq = 0
function ev(body: RunEventBody, ts: number, agent?: string): RunEvent {
  return { id: `e${seq}`, runId: 'r1', threadId: 't1', seq: seq++, ts, agent, body }
}

const started = (agent: string, ts: number, extra: Partial<Extract<RunEventBody, { type: 'run.started' }>> = {}) =>
  ev({ type: 'run.started', model: 'm', effort: 'high', mode: 'act', parentAgent: 'r1', tools: ['fs_read'], ...extra }, ts, agent)

describe('indexSubagents', () => {
  it('ignores the parent run and keys agents by id and by parent call', () => {
    seq = 0
    const events = [
      ev({ type: 'run.started', model: 'm', mode: 'act' }, 1),
      ev({ type: 'tool.started', callId: 'c1', tool: 'run_agent', args: { task: 'x' } }, 2),
      started('a1', 3, { name: 'Scout', agentType: 'researcher', parentCallId: 'c1' })
    ]
    const idx = indexSubagents(events)
    expect(idx.byId.size).toBe(1)
    const a = idx.byId.get('a1')!
    expect(a.name).toBe('Scout')
    expect(a.role).toBe('researcher')
    expect(a.model).toBe('m')
    expect(a.tools).toEqual(['fs_read'])
    expect(a.startedAt).toBe(3)
    expect(a.parentCallId).toBe('c1')
    expect(idx.byCallId.get('c1')).toBe(a)
    expect(a.activity).toEqual({ kind: 'starting', since: 3 })
    expect(a.running).toBe(true)
  })

  it('folds activity: thinking → tool (labelled from args) → back to thinking → writing → done', () => {
    seq = 0
    const events = [
      started('a1', 1, { parentCallId: 'c1' }),
      ev({ type: 'reasoning.delta', text: 'hmm', fidelity: 'raw', startedAt: 2 }, 5, 'a1'),
      ev({ type: 'reasoning.delta', text: ' more', fidelity: 'raw', startedAt: 2 }, 6, 'a1'),
      ev({ type: 'tool.drafting', callId: 't1', tool: 'fs_read', args: '{"pa' }, 7, 'a1'),
      ev({ type: 'tool.proposed', callId: 't1', tool: 'fs_read', args: { path: 'src/app.ts' }, riskTier: 'R0' }, 8, 'a1'),
      ev({ type: 'tool.started', callId: 't1', tool: 'fs_read', args: { path: 'src/app.ts' } }, 9, 'a1')
    ]
    let a = indexSubagents(events).byId.get('a1')!
    expect(a.thinkingBouts).toBe(1)
    expect(a.activity).toEqual({ kind: 'tool', tool: 'fs_read', label: 'Reading src/app.ts', since: 9 })
    expect(a.toolCalls).toBe(1)
    expect(a.recentTools).toEqual([{ callId: 't1', tool: 'fs_read', label: 'Reading src/app.ts', status: 'running' }])
    expect(a.toolsUsed).toEqual(['fs_read'])

    events.push(ev({ type: 'tool.result', callId: 't1', tool: 'fs_read', ok: true, result: 'x', durationMs: 12 }, 10, 'a1'))
    a = indexSubagents(events).byId.get('a1')!
    expect(a.toolsDone).toBe(1)
    expect(a.activity).toEqual({ kind: 'thinking', since: 10 })
    expect(a.recentTools[0]).toMatchObject({ status: 'complete', durationMs: 12 })

    events.push(ev({ type: 'text.delta', text: 'The answer' }, 11, 'a1'))
    a = indexSubagents(events).byId.get('a1')!
    expect(a.activity).toEqual({ kind: 'writing', since: 11 })
    expect(a.outputChars).toBe(10)

    events.push(
      ev({ type: 'usage', usage: { tokensOut: 40, wallMs: 1000 } }, 12, 'a1'),
      ev({ type: 'run.completed', reason: 'done' }, 13, 'a1')
    )
    a = indexSubagents(events).byId.get('a1')!
    expect(a.running).toBe(false)
    expect(a.endedAt).toBe(13)
    expect(a.completedReason).toBe('done')
    expect(a.telemetry).toEqual({ tokensOut: 40, wallMs: 1000 })
  })

  it('keeps the in-flight sibling as the current activity when a parallel batch partially settles', () => {
    seq = 0
    const events = [
      started('a1', 1),
      ev({ type: 'tool.started', callId: 't1', tool: 'shell', args: { command: 'npm test' } }, 2, 'a1'),
      ev({ type: 'tool.started', callId: 't2', tool: 'grep_search', args: { pattern: 'foo' } }, 3, 'a1'),
      ev({ type: 'tool.result', callId: 't2', tool: 'grep_search', ok: true, result: [], durationMs: 1 }, 4, 'a1')
    ]
    const a = indexSubagents(events).byId.get('a1')!
    expect(a.activity).toEqual({ kind: 'tool', tool: 'shell', label: 'Running npm test', since: 4 })
    expect(a.toolCalls).toBe(2)
    expect(a.toolsDone).toBe(1)
  })

  it('counts denied calls as failures and records errors and cancellation', () => {
    seq = 0
    const events = [
      started('a1', 1),
      ev({ type: 'tool.proposed', callId: 't1', tool: 'shell', args: { command: 'rm -rf /' }, riskTier: 'R3' }, 2, 'a1'),
      ev({ type: 'tool.denied', callId: 't1', reason: 'nope' }, 3, 'a1'),
      ev({ type: 'error', category: 'unknown', message: 'boom', retryable: false }, 4, 'a1'),
      ev({ type: 'run.completed', reason: 'error' }, 5, 'a1')
    ]
    const a = indexSubagents(events).byId.get('a1')!
    expect(a.toolsFailed).toBe(1)
    expect(a.recentTools[0]!.status).toBe('blocked')
    expect(a.error).toBe('boom')
    expect(a.completedReason).toBe('error')
    expect(a.running).toBe(false)
  })

  it('caps the recent-tools trail while still counting every call', () => {
    seq = 0
    const events = [started('a1', 1)]
    for (let i = 0; i < RECENT_TOOLS + 4; i++) {
      events.push(ev({ type: 'tool.started', callId: `t${i}`, tool: 'fs_read', args: { path: `f${i}` } }, 2 + i, 'a1'))
    }
    const a = indexSubagents(events).byId.get('a1')!
    expect(a.toolCalls).toBe(RECENT_TOOLS + 4)
    expect(a.recentTools.length).toBe(RECENT_TOOLS)
    expect(a.recentTools[0]!.callId).toBe('t4')
    expect(a.recentTools.at(-1)!.callId).toBe(`t${RECENT_TOOLS + 3}`)
  })

  it('returns a shared empty index for no events', () => {
    const idx = indexSubagents([])
    expect(idx.byId.size).toBe(0)
    expect(idx.byCallId.size).toBe(0)
  })
})

describe('subagentForCall', () => {
  it('prefers the live parentCallId link and falls back to the agentId in the result', () => {
    seq = 0
    const idx = indexSubagents([started('a1', 1, { parentCallId: 'c1' }), started('a2', 2)])
    const live: ToolCall = { tool: 'run_agent', status: 'running' }
    expect(subagentForCall(idx, 'c1', live)?.id).toBe('a1')
    const legacy: ToolCall = { tool: 'run_agent', status: 'complete', ok: true, result: { agentId: 'a2', result: 'x' } }
    expect(subagentForCall(idx, 'c2', legacy)?.id).toBe('a2')
    expect(subagentForCall(idx, 'c3', { tool: 'run_agent', status: 'running' })).toBeUndefined()
  })
})

describe('subagentPhase', () => {
  const running = (): ToolCall => ({ tool: 'run_agent', status: 'running' })
  const doneCall = (result: unknown): ToolCall => ({ tool: 'run_agent', status: 'complete', ok: true, result })

  it('reads the parent call alone before the agent has reported in', () => {
    expect(subagentPhase({ tool: 'run_agent', status: 'requested' }, undefined, true)).toBe('starting')
    expect(subagentPhase({ tool: 'run_agent', status: 'requested' }, undefined, false)).toBe('interrupted')
    expect(subagentPhase(running(), undefined, true)).toBe('running')
    expect(subagentPhase(running(), undefined, false)).toBe('interrupted')
    expect(subagentPhase(doneCall({ agentId: 'a', result: 'ok' }), undefined, false)).toBe('done')
  })

  it('a blocked or failed call is failed regardless of the agent', () => {
    expect(subagentPhase({ tool: 'run_agent', status: 'blocked', reason: 'no' }, undefined, true)).toBe('failed')
    expect(subagentPhase({ tool: 'run_agent', status: 'failed', ok: false, result: { error: 'x' } }, undefined, false)).toBe('failed')
  })

  it("follows the agent's own lifecycle once it exists", () => {
    seq = 0
    const events = [started('a1', 1, { parentCallId: 'c1' })]
    const idx = () => indexSubagents(events).byId.get('a1')!
    expect(subagentPhase(running(), idx(), true)).toBe('running')
    // A foreground agent still "running" after its parent settled was cut off…
    expect(subagentPhase(running(), idx(), false)).toBe('interrupted')
    // …but a background agent legitimately outlives the spawning turn.
    expect(subagentPhase(doneCall({ agentId: 'a1', background: true, status: 'running' }), idx(), false)).toBe('running')

    events.push(ev({ type: 'run.completed', reason: 'canceled' }, 2, 'a1'))
    expect(subagentPhase(running(), idx(), true)).toBe('stopped')
    events.pop()
    events.push(ev({ type: 'error', category: 'unknown', message: 'x', retryable: false }, 2, 'a1'))
    events.push(ev({ type: 'run.completed', reason: 'error' }, 3, 'a1'))
    expect(subagentPhase(doneCall({ agentId: 'a1', result: '' }), idx(), false)).toBe('failed')
    events.splice(1)
    events.push(ev({ type: 'run.completed', reason: 'done' }, 2, 'a1'))
    expect(subagentPhase(doneCall({ agentId: 'a1', result: 'answer' }), idx(), false)).toBe('done')
  })
})

describe('result helpers', () => {
  it('read the agent id, background flag, answer text, and error out of a run_agent result', () => {
    expect(agentIdFromResult({ agentId: 'a1' })).toBe('a1')
    expect(agentIdFromResult({ agentId: '' })).toBeUndefined()
    expect(agentIdFromResult('nope')).toBeUndefined()
    expect(isBackgroundHandle({ background: true })).toBe(true)
    expect(isBackgroundHandle({ result: 'x' })).toBe(false)
    expect(resultTextOf({ result: 'the answer' })).toBe('the answer')
    expect(resultTextOf({ background: true })).toBeUndefined()
    expect(resultErrorOf({ error: 'Subagent failed: boom' })).toBe('Subagent failed: boom')
    expect(resultErrorOf({})).toBeUndefined()
  })

  it('titleCase turns a role slug into a display name', () => {
    expect(titleCase('docs_researcher')).toBe('Docs Researcher')
    expect(titleCase('reviewer')).toBe('Reviewer')
  })
})
