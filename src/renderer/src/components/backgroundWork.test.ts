import { describe, expect, it } from 'vitest'
import type { BgJobView, ChatMessage, RunEvent, RunEventBody } from '@shared/types'
import { describeBackgroundWork, summarizeBackgroundWork } from './backgroundWork'

const ev = (body: RunEventBody, seq: number, agent?: string): RunEvent =>
  ({ id: `e${seq}`, runId: 'r1', threadId: 't1', seq, ts: seq, agent, body }) as RunEvent
const job = (id: string, running: boolean): BgJobView =>
  ({ id, threadId: 't1', command: 'x', status: running ? 'running' : 'done', startedAt: 0, output: '', running }) as BgJobView
const msg = (status?: ChatMessage['status']): ChatMessage =>
  ({ id: 'm', threadId: 't1', role: 'assistant', createdAt: 0, text: '', status }) as ChatMessage

describe('summarizeBackgroundWork', () => {
  it('reports a streaming reply as streaming, never background-only', () => {
    const w = summarizeBackgroundWork([], [job('j1', true)], [msg(undefined)], true)
    expect(w.streaming).toBe(true)
    expect(w.backgroundOnly).toBe(false)
    expect(w.jobIds).toEqual(['j1'])
  })

  it('reports background-only when the reply is done but agents/jobs still run', () => {
    const events = [
      ev({ type: 'run.started', model: 'm', mode: 'act', name: 'Coder' } as RunEventBody, 1, 'a1'),
      ev({ type: 'run.started', model: 'm', mode: 'act', name: 'Runner' } as RunEventBody, 2, 'a2'),
      ev({ type: 'run.completed', reason: 'done' }, 3, 'a2')
    ]
    const w = summarizeBackgroundWork(events, [job('j1', true), job('j2', false)], [msg('complete')], true)
    expect(w.streaming).toBe(false)
    expect(w.agentIds).toEqual(['a1'])
    expect(w.jobIds).toEqual(['j1'])
    expect(w.backgroundOnly).toBe(true)
  })

  it('is nothing when the thread is idle', () => {
    const w = summarizeBackgroundWork([], [], [msg('complete')], false)
    expect(w).toEqual({ streaming: false, agentIds: [], jobIds: [], backgroundOnly: false })
  })
})

describe('describeBackgroundWork', () => {
  it('pluralises and joins', () => {
    expect(describeBackgroundWork({ agentIds: ['a'], jobIds: [] })).toBe('1 subagent')
    expect(describeBackgroundWork({ agentIds: ['a', 'b'], jobIds: ['j'] })).toBe('2 subagents and 1 job')
    expect(describeBackgroundWork({ agentIds: [], jobIds: ['j', 'k'] })).toBe('2 jobs')
  })
})
