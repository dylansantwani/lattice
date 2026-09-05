import { describe, it, expect } from 'vitest'
import type { BgJobView, RunEvent, RunEventBody } from '@shared/types'
import { indexSubagents } from './subagents'
import {
  agentOutcome,
  agentSpanMs,
  agentStatus,
  buildWorkItems,
  firstLine,
  indexBriefs,
  jobStatus,
  lastOutputLine,
  outputLineCount,
  shortModel,
  summarize,
  toolsSummary,
  type WorkItem
} from './agentsWork'

let seq = 0
function ev(body: RunEventBody, ts: number, agent?: string): RunEvent {
  return { id: `e${seq}`, runId: 'r1', threadId: 't1', seq: seq++, ts, agent, body }
}
const started = (agent: string, ts: number, extra: Partial<Extract<RunEventBody, { type: 'run.started' }>> = {}) =>
  ev({ type: 'run.started', model: 'm', mode: 'act', parentAgent: 'r1', tools: ['fs_read'], ...extra }, ts, agent)
const completed = (agent: string, ts: number, reason: 'done' | 'canceled' | 'error' | 'length' = 'done') =>
  ev({ type: 'run.completed', reason }, ts, agent)
const tool = (agent: string, callId: string, ts: number, ok = true) => [
  ev({ type: 'tool.started', callId, tool: 'fs_read', args: { path: 'a.ts' } }, ts, agent),
  ev({ type: 'tool.result', callId, tool: 'fs_read', ok, result: '', durationMs: 5 }, ts + 1, agent)
]

function job(over: Partial<BgJobView> = {}): BgJobView {
  return {
    id: 'j1',
    threadId: 't1',
    command: 'pnpm test',
    status: 'running',
    startedAt: 1000,
    output: '',
    running: true,
    ...over
  }
}

describe('indexBriefs', () => {
  it('reads the task and background flag off the parent run_agent call, ignoring subagent calls', () => {
    seq = 0
    const events = [
      ev({ type: 'tool.proposed', callId: 'c1', tool: 'run_agent', args: { task: 'Find the bug', background: true }, riskTier: 'R0' }, 1),
      ev({ type: 'tool.started', callId: 'c1', tool: 'run_agent', args: { task: 'Find the bug', background: true } }, 2),
      ev({ type: 'tool.started', callId: 'c2', tool: 'run_agent', args: { task: 'Nested' } }, 3, 'a1'),
      ev({ type: 'tool.started', callId: 'c3', tool: 'shell', args: { command: 'ls' } }, 4)
    ]
    const briefs = indexBriefs(events)
    expect(briefs.size).toBe(1)
    expect(briefs.get('c1')).toEqual({ task: 'Find the bug', background: true })
  })

  it('learns background from a spawn handle result when the args did not say', () => {
    seq = 0
    const events = [
      ev({ type: 'tool.started', callId: 'c1', tool: 'run_agent', args: { task: 'Go' } }, 1),
      ev({ type: 'tool.result', callId: 'c1', tool: 'run_agent', ok: true, result: { background: true, agentId: 'a1' }, durationMs: 3 }, 2)
    ]
    expect(indexBriefs(events).get('c1')).toEqual({ task: 'Go', background: true })
  })
})

describe('agentOutcome / agentStatus', () => {
  it('maps completion reasons to outcomes and status lines', () => {
    seq = 0
    const mk = (reason?: 'done' | 'canceled' | 'error' | 'length', error?: string) => {
      const events = [started('a1', 1000), ...tool('a1', 't1', 2000)]
      if (error) events.push(ev({ type: 'error', category: 'unknown', message: error, retryable: false }, 2500, 'a1'))
      if (reason) events.push(completed('a1', 65_000, reason))
      return indexSubagents(events).byId.get('a1')!
    }
    expect(agentOutcome(mk())).toBe('running')
    expect(agentOutcome(mk('done'))).toBe('done')
    expect(agentOutcome(mk('canceled'))).toBe('stopped')
    expect(agentOutcome(mk('length'))).toBe('truncated')
    expect(agentOutcome(mk('error'))).toBe('failed')
    expect(agentOutcome(mk('done', 'boom'))).toBe('failed')

    expect(agentStatus(mk('done'))).toEqual({ icon: 'check', tone: 'ok', text: 'Done · 1 tool call' })
    expect(agentStatus(mk('canceled'))).toEqual({ icon: 'block', tone: 'muted', text: 'Stopped · 1 tool call' })
    expect(agentStatus(mk('length')).tone).toBe('warn')
    expect(agentStatus(mk('error', 'ECONNRESET\nstack…'))).toEqual({
      icon: 'error',
      tone: 'bad',
      text: 'Failed · ECONNRESET'
    })
  })

  it('narrates a running agent from its live activity', () => {
    seq = 0
    const base = [started('a1', 1)]
    expect(agentStatus(indexSubagents(base).byId.get('a1')!).text).toBe('Starting up…')
    const thinking = [...base, ev({ type: 'reasoning.delta', text: 'x', fidelity: 'raw' }, 2, 'a1')]
    expect(agentStatus(indexSubagents(thinking).byId.get('a1')!).text).toBe('Thinking…')
    const reading = [...thinking, ev({ type: 'tool.started', callId: 't1', tool: 'fs_read', args: { path: 'src/app.ts' } }, 3, 'a1')]
    const s = agentStatus(indexSubagents(reading).byId.get('a1')!)
    expect(s).toMatchObject({ icon: 'build', tone: 'live', text: 'Reading src/app.ts' })
    const writing = [...reading, ev({ type: 'tool.result', callId: 't1', tool: 'fs_read', ok: true, result: '', durationMs: 1 }, 4, 'a1'), ev({ type: 'text.delta', text: 'Report' }, 5, 'a1')]
    expect(agentStatus(indexSubagents(writing).byId.get('a1')!).text).toBe('Writing its report…')
  })

  it('summarises tool calls with failures and spans', () => {
    seq = 0
    const events = [started('a1', 1000), ...tool('a1', 't1', 2000), ...tool('a1', 't2', 3000, false), ...tool('a1', 't3', 4000)]
    const v = indexSubagents(events).byId.get('a1')!
    expect(toolsSummary(v)).toBe('3 tool calls · 1 failed')
    // still running: span reaches to the last event seen
    expect(agentSpanMs(v)).toBe(3001)
    const none = indexSubagents([started('a2', 1), completed('a2', 2)]).byId.get('a2')!
    expect(toolsSummary(none)).toBe('no tool calls')
  })
})

describe('buildWorkItems / summarize', () => {
  it('interleaves agents and jobs: working oldest-first, finished newest-first, with briefs attached', () => {
    seq = 0
    const events = [
      ev({ type: 'tool.started', callId: 'c1', tool: 'run_agent', args: { task: 'Old one' } }, 1),
      started('a1', 10, { parentCallId: 'c1', name: 'Old' }),
      completed('a1', 500),
      ev({ type: 'tool.started', callId: 'c2', tool: 'run_agent', args: { task: 'Live one' } }, 600),
      started('a2', 700, { parentCallId: 'c2', name: 'Live' }),
      started('a3', 800, { name: 'Broken' }),
      completed('a3', 900, 'error')
    ]
    const index = indexSubagents(events)
    const jobs = [
      job({ id: 'j-run', startedAt: 650 }),
      job({ id: 'j-done', startedAt: 100, endedAt: 950, running: false, status: 'done', exitCode: 0 }),
      job({ id: 'j-stop', startedAt: 100, endedAt: 300, running: false, status: 'canceled' })
    ]
    const lists = buildWorkItems(index, indexBriefs(events), jobs)
    expect(lists.working.map((i) => i.id)).toEqual(['job:j-run', 'agent:a2'])
    expect(lists.finished.map((i) => i.id)).toEqual(['job:j-done', 'agent:a3', 'agent:a1', 'job:j-stop'])
    const agentAt = (item: WorkItem | undefined) => (item?.kind === 'agent' ? item : undefined)
    expect(agentAt(lists.working[1])?.brief?.task).toBe('Live one')
    expect(agentAt(lists.finished[1])?.view.name).toBe('Broken')
    expect(agentAt(lists.finished[1])?.brief).toBeUndefined()

    expect(summarize(lists)).toEqual({ working: 2, done: 2, failed: 1, stopped: 1, truncated: 0 })
  })

  it('is empty for a thread with no delegations or jobs', () => {
    const lists = buildWorkItems(indexSubagents([]), new Map(), [])
    expect(lists).toEqual({ working: [], finished: [] })
    expect(summarize(lists)).toEqual({ working: 0, done: 0, failed: 0, stopped: 0, truncated: 0 })
  })
})

describe('jobStatus', () => {
  it('shows the last output line while running and the exit outcome plus output size once done', () => {
    expect(jobStatus(job({ output: 'compiling\n\n  42 passed  \n' })).text).toBe('42 passed')
    expect(jobStatus(job()).text).toBe('Running · no output yet')
    expect(jobStatus(job({ running: false, status: 'done', exitCode: 0, endedAt: 4000, output: 'ok\n' }))).toEqual({
      icon: 'check',
      tone: 'ok',
      text: 'Finished · exit 0 · 1 line'
    })
    expect(jobStatus(job({ running: false, status: 'failed', exitCode: 2, endedAt: 1500 })).text).toBe('Failed · exit 2 · no output')
    expect(jobStatus(job({ running: false, status: 'canceled', endedAt: 61_000, output: 'a\nb\n' })).text).toBe('Stopped · 2 lines')
  })
})

describe('small helpers', () => {
  it('lastOutputLine / outputLineCount / shortModel / firstLine', () => {
    expect(lastOutputLine('a\nb\n\n  \n')).toBe('b')
    expect(lastOutputLine('')).toBe('')
    expect(outputLineCount('a\n\nb\n')).toBe(2)
    expect(outputLineCount('')).toBe(0)
    expect(shortModel('openrouter/minimax/minimax-m3:free')).toBe('minimax-m3:free')
    expect(shortModel('claude-sonnet-5')).toBe('claude-sonnet-5')
    expect(shortModel('weird/')).toBe('weird/')
    expect(firstLine('\n\n first \nsecond')).toBe('first')
    expect(firstLine(undefined)).toBeUndefined()
    expect(firstLine('   ')).toBeUndefined()
  })
})
