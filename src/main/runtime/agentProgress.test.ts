import { describe, it, expect } from 'vitest'
import { applyEvent, describeActivity, initialProgress, PREVIEW_MAX } from './agentProgress'
import type { AgentProgress } from './agentProgress'
import type { RunEventBody } from '../../shared/types'

// Fold a sequence of events over a fresh snapshot, advancing the clock one ms per step so idle/
// elapsed math is deterministic. Returns the final progress.
function fold(events: RunEventBody[], start = 1000): AgentProgress {
  let p = initialProgress(start)
  events.forEach((body, i) => {
    p = applyEvent(p, body, start + i + 1)
  })
  return p
}

describe('agentProgress reducer', () => {
  it('starts in the starting phase with a zero tool count', () => {
    const p = initialProgress(500)
    expect(p).toMatchObject({ phase: 'starting', toolCalls: 0, preview: '', startedAt: 500, updatedAt: 500 })
  })

  it('run.started resets startedAt to when the sub-run actually began', () => {
    const p = applyEvent(initialProgress(100), { type: 'run.started', model: 'm', mode: 'act' }, 900)
    expect(p.startedAt).toBe(900)
    expect(p.phase).toBe('starting')
  })

  it('tracks thinking, then responding while accumulating a preview tail', () => {
    const p = fold([
      { type: 'reasoning.delta', text: 'hmm', fidelity: 'raw' },
      { type: 'text.delta', text: 'Hello ' },
      { type: 'text.delta', text: 'world' }
    ])
    expect(p.phase).toBe('responding')
    expect(p.preview).toBe('Hello world')
  })

  it('caps the preview to the last PREVIEW_MAX characters', () => {
    const long = 'x'.repeat(PREVIEW_MAX + 50)
    const p = fold([{ type: 'text.delta', text: long }])
    expect(p.preview).toHaveLength(PREVIEW_MAX)
    expect(p.preview).toBe(long.slice(-PREVIEW_MAX))
  })

  it('marks the current tool while running and clears it after the result, counting completions', () => {
    let p = fold([
      { type: 'tool.started', callId: 'c1', tool: 'grep', args: {} }
    ])
    expect(p.phase).toBe('tool')
    expect(p.currentTool).toBe('grep')
    expect(p.toolCalls).toBe(0) // not counted until it completes

    p = applyEvent(p, { type: 'tool.result', callId: 'c1', tool: 'grep', ok: true, result: {}, durationMs: 5 }, 2000)
    expect(p.toolCalls).toBe(1)
    expect(p.currentTool).toBeUndefined()
    expect(p.phase).toBe('thinking') // reasoning over the result comes next
  })

  it('treats a drafting call as already being on a tool', () => {
    const p = fold([{ type: 'tool.drafting', callId: 'c1', tool: 'fs_read' }])
    expect(p.phase).toBe('tool')
    expect(p.currentTool).toBe('fs_read')
  })

  it('lands in done on a clean completion and error on a failed one', () => {
    expect(fold([{ type: 'run.completed', reason: 'done' }]).phase).toBe('done')
    expect(fold([{ type: 'run.completed', reason: 'error' }]).phase).toBe('error')
    expect(fold([{ type: 'error', category: 'unknown', message: 'boom', retryable: false }]).phase).toBe('error')
  })

  it('advances updatedAt on every event so idle time stays honest', () => {
    const p = fold([
      { type: 'reasoning.delta', text: 'a', fidelity: 'raw' },
      { type: 'usage', usage: {} }
    ])
    expect(p.updatedAt).toBe(1002) // start 1000, +1 per event
  })
})

describe('describeActivity', () => {
  it('prefers terminal status over the folded phase', () => {
    const p = initialProgress()
    expect(describeActivity(p, 'done')).toBe('finished')
    expect(describeActivity(p, 'error')).toBe('failed')
  })

  it('names the running tool, or falls back to a generic phrase', () => {
    expect(describeActivity({ ...initialProgress(), phase: 'tool', currentTool: 'grep' }, 'running')).toBe('running grep')
    expect(describeActivity({ ...initialProgress(), phase: 'tool' }, 'running')).toBe('running a tool')
  })

  it('describes thinking, responding, and startup', () => {
    expect(describeActivity({ ...initialProgress(), phase: 'thinking' }, 'running')).toBe('thinking')
    expect(describeActivity({ ...initialProgress(), phase: 'responding' }, 'running')).toBe('writing its response')
    expect(describeActivity(initialProgress(), 'running')).toBe('starting up')
  })
})
