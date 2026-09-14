import { describe, expect, it } from 'vitest'
import type { FleetAgentView, ModelInfo, RunEvent } from '@shared/types'
import { fleetCounts, fleetReasoningLabel, latestFleetRun } from './fleetView'

const event = (runId: string, seq: number, type: RunEvent['body']['type']): RunEvent => ({
  id: `${runId}-${seq}`,
  runId,
  threadId: 't',
  seq,
  ts: seq,
  body: type === 'run.started'
    ? { type, model: 'openrouter/free', mode: 'act' }
    : type === 'run.completed'
      ? { type, reason: 'done' }
      : { type: 'text.delta', text: 'x' }
})

describe('latestFleetRun', () => {
  it('keeps only the newest run from a bounded event window', () => {
    expect(latestFleetRun([
      event('old', 0, 'run.started'),
      event('old', 1, 'run.completed'),
      event('new', 0, 'run.started'),
      event('new', 1, 'text.delta')
    ]).map((e) => e.runId)).toEqual(['new', 'new'])
  })

})

describe('Fleet model state', () => {
  it('explains that the free router has route-dependent reasoning', () => {
    expect(fleetReasoningLabel({ model: 'openrouter/free', effort: 'high' })).toBe(
      'Reasoning varies by routed model · high'
    )
  })

  it('reports a known reasoning capability and effort', () => {
    const model = { capabilities: { reasoning: true } } as ModelInfo
    expect(fleetReasoningLabel({ model: 'm', effort: 'low' }, model)).toBe('Reasoning low')
  })

  it('summarizes mutually exclusive fleet states', () => {
    const agents = [
      { running: true, status: 'running' },
      { running: true, status: 'waiting-answer' },
      { running: false, status: 'error' },
      { running: false, status: 'idle' }
    ] as FleetAgentView[]
    expect(fleetCounts(agents)).toEqual({ running: 1, needsYou: 1, failed: 1, idle: 1 })
  })
})
