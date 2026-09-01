import { describe, expect, it } from 'vitest'
import type { RunEvent, RunEventBody } from '@shared/types'
import { summarizeAgents } from './agentView'

let seq = 0
const ev = (agent: string | undefined, body: RunEventBody): RunEvent => ({
  id: `e${seq}`,
  runId: 'r1',
  threadId: 't1',
  seq: seq++,
  ts: seq,
  agent,
  body
})

describe('summarizeAgents', () => {
  it('ignores main-run events (no agent id)', () => {
    const events = [ev(undefined, { type: 'text.delta', text: 'main model output' })]
    expect(summarizeAgents(events)).toEqual([])
  })

  it('folds a subagent stream into name, model, status, tools, text, and messages', () => {
    const events = [
      ev('a1', { type: 'run.started', model: 'gpt-luna', mode: 'act', parentAgent: 'r1', agentName: 'scout' }),
      ev('a1', { type: 'agent.status', status: 'running', name: 'scout' }),
      ev('a1', { type: 'text.delta', text: 'looking…' }),
      ev('a1', { type: 'tool.started', callId: 'c1', tool: 'grep_search', args: {} }),
      ev('a1', { type: 'agent.message', from: 'parent', text: 'also check tests' }),
      ev('a1', { type: 'text.delta', text: '\nfound it' }),
      ev('a1', { type: 'agent.status', status: 'idle', name: 'scout' })
    ]
    const a = summarizeAgents(events)[0]!
    expect(a.name).toBe('scout')
    expect(a.model).toBe('gpt-luna')
    expect(a.status).toBe('idle')
    expect(a.active).toBe(true) // idle is still live
    expect(a.toolCalls).toBe(1)
    expect(a.text).toBe('looking…\nfound it')
    expect(a.messages).toEqual(['also check tests'])
    expect(a.lastLine).toContain('found it')
    expect(a.timeline.length).toBeGreaterThan(0)
  })

  it('sorts active subagents ahead of finished ones, otherwise spawn order', () => {
    const events = [
      ev('done1', { type: 'run.started', model: 'm', mode: 'act', agentName: 'first' }),
      ev('done1', { type: 'agent.status', status: 'done', name: 'first' }),
      ev('live1', { type: 'run.started', model: 'm', mode: 'act', agentName: 'second' }),
      ev('live1', { type: 'agent.status', status: 'running', name: 'second' })
    ]
    const names = summarizeAgents(events).map((a) => a.name)
    expect(names).toEqual(['second', 'first'])
  })

  it('falls back to done when a run completed without agent.status events', () => {
    const events = [
      ev('old', { type: 'run.started', model: 'm', mode: 'act', agentName: 'legacy' }),
      ev('old', { type: 'run.completed', reason: 'done' })
    ]
    const a = summarizeAgents(events)[0]!
    expect(a.status).toBe('done')
    expect(a.active).toBe(false)
  })

  it('surfaces subagent error events for the expandable card', () => {
    const agents = summarizeAgents([
      ev('bad', { type: 'run.started', model: 'm', mode: 'act', agentName: 'broken' }),
      ev('bad', { type: 'error', category: 'unknown', message: 'provider failed', retryable: true }),
      ev('bad', { type: 'agent.status', status: 'error', name: 'broken' })
    ])
    expect(agents[0]).toMatchObject({ name: 'broken', status: 'error', error: 'provider failed' })
  })

  it('does not revive a persisted nonterminal agent after its parent thread stopped', () => {
    const agents = summarizeAgents([
      ev('orphan', { type: 'run.started', model: 'm', mode: 'act', agentName: 'orphan' }),
      ev('orphan', { type: 'agent.status', status: 'running', name: 'orphan' })
    ], null)
    expect(agents[0]).toMatchObject({ status: 'canceled', active: false })
  })

  it('does not reactivate stale agents when a newer run starts on the same thread', () => {
    const stale = ev('old-agent', { type: 'agent.status', status: 'running', name: 'old' })
    stale.runId = 'run_old'
    const current = ev('new-agent', { type: 'agent.status', status: 'running', name: 'new' })
    current.runId = 'run_new'
    const agents = summarizeAgents([stale, current], 'run_new')
    expect(agents.find((agent) => agent.name === 'old')).toMatchObject({ status: 'canceled', active: false })
    expect(agents.find((agent) => agent.name === 'new')).toMatchObject({ status: 'running', active: true })
  })
})
