import { describe, expect, it } from 'vitest'
import type { TimelineItem, ToolCall } from './runTimeline'
import {
  activityOutcome,
  editCounts,
  flowOf,
  isThoughtBlip,
  shortModel,
  stepLabel,
  stepStatus,
  summarizeActivity,
  turnStats,
  type ActivityItem
} from './turnFlow'

let seq = 0
const think = (over: Partial<Extract<TimelineItem, { kind: 'think' }>> = {}): Extract<TimelineItem, { kind: 'think' }> => ({
  kind: 'think',
  seq: seq++,
  text: '',
  startTs: 1000,
  ...over
})
const tool = (call: Partial<ToolCall> & { tool: string }): Extract<TimelineItem, { kind: 'tool' }> => ({
  kind: 'tool',
  seq: seq++,
  callId: `c${seq}`,
  call: { status: 'complete', ok: true, ...call }
})
const output = (text: string, endTs?: number): Extract<TimelineItem, { kind: 'output' }> => ({
  kind: 'output',
  seq: seq++,
  text,
  startTs: 1000,
  endTs
})

describe('flowOf', () => {
  it('folds every stretch of work between passages into one activity block', () => {
    const flow = flowOf([
      think({ text: 'plan', endTs: 3000 }),
      tool({ tool: 'fs_read', args: { path: 'a.ts' } }),
      tool({ tool: 'shell', args: { command: 'ls' } }),
      output('Here is what I found.', 5000),
      tool({ tool: 'fs_edit', args: { path: 'a.ts', old_string: 'x', new_string: 'y' } }),
      output('Done.', 6000)
    ])
    expect(flow.map((n) => n.kind)).toEqual(['activity', 'prose', 'activity', 'prose'])
    expect(flow[0]!.kind === 'activity' && flow[0]!.items.length).toBe(3)
  })

  it('gives a delegation its own node instead of burying it in a block', () => {
    const flow = flowOf([tool({ tool: 'fs_read', args: { path: 'a' } }), tool({ tool: 'run_agent', args: { task: 'x' } }), tool({ tool: 'shell', args: { command: 'ls' } })])
    expect(flow.map((n) => n.kind)).toEqual(['activity', 'agent', 'activity'])
  })

  it('drops silent sub-second reasoning blips so hosted reasoners do not get an empty line per call', () => {
    const flow = flowOf([think({ endTs: 1400, silent: true }), tool({ tool: 'fs_read', args: { path: 'a' } })])
    expect(flow).toHaveLength(1)
    expect(flow[0]!.kind === 'activity' && flow[0]!.items.map((i) => i.kind)).toEqual(['tool'])
  })

  it('keeps a reasoning bout that has text, tokens, or real duration', () => {
    expect(isThoughtBlip(think({ text: 'hmm', endTs: 1100 }))).toBe(false)
    expect(isThoughtBlip(think({ tokenCount: 67, endTs: 1100, silent: true }))).toBe(false)
    expect(isThoughtBlip(think({ durationMs: 21000 }))).toBe(false)
    // Still open: it may still grow, so it is not a blip yet.
    expect(isThoughtBlip(think())).toBe(false)
    expect(isThoughtBlip(think({ endTs: 1200 }))).toBe(true)
  })
})

describe('stepLabel', () => {
  it('leads a command with its purpose and keeps the command as the subject', () => {
    expect(stepLabel({ tool: 'shell', status: 'complete', args: { command: 'npm test', purpose: 'Run the unit tests' } })).toMatchObject({
      verb: 'Run the unit tests',
      subject: 'npm test',
      mono: true
    })
  })

  it('uses a plain verb for a command without a purpose', () => {
    expect(stepLabel({ tool: 'shell', status: 'complete', args: { command: 'ls -la' } })).toMatchObject({ verb: 'Ran', subject: 'ls -la' })
  })

  it('names file tools by what they did to the path', () => {
    expect(stepLabel({ tool: 'fs_read', status: 'complete', args: { path: 'src/app.ts' } })).toMatchObject({ verb: 'Read', subject: 'src/app.ts' })
    expect(stepLabel({ tool: 'fs_edit', status: 'complete', args: { path: 'a.ts', old_string: '', new_string: '' } })).toMatchObject({ verb: 'Edited', subject: 'a.ts' })
    expect(stepLabel({ tool: 'fs_move', status: 'complete', args: { from: 'a', to: 'b' } })).toMatchObject({ verb: 'Moved', subject: 'a → b' })
  })

  it('tags an MCP tool with its server and shows its first short argument', () => {
    expect(stepLabel({ tool: 'mcp__bambu__get_status', status: 'complete', args: { printer: 'X1C' } })).toMatchObject({
      verb: 'get_status',
      subject: 'X1C',
      server: 'bambu'
    })
  })

  it('reads the primary argument out of a still-streaming draft', () => {
    expect(stepLabel({ tool: 'fs_write', status: 'requested', draftArgs: '{"path":"out.txt","content":"hel' })).toMatchObject({
      verb: 'Writing',
      subject: 'out.txt'
    })
  })

  it('humanizes an unknown builtin and squashes whitespace in a long subject', () => {
    const label = stepLabel({ tool: 'abrowser_session_close', status: 'complete', args: { session: '  main\n  window ' } })
    expect(label.verb).toBe('Abrowser session close')
    expect(label.subject).toBe('main window')
  })
})

describe('stepStatus', () => {
  it('reads a still-open call as interrupted once the run is no longer live', () => {
    expect(stepStatus({ tool: 'shell', status: 'running' }, true)).toBe('running')
    expect(stepStatus({ tool: 'shell', status: 'running' }, false)).toBe('interrupted')
    expect(stepStatus({ tool: 'shell', status: 'requested' }, true)).toBe('drafting')
    expect(stepStatus({ tool: 'shell', status: 'complete', ok: false }, false)).toBe('failed')
    expect(stepStatus({ tool: 'shell', status: 'blocked' }, false)).toBe('blocked')
  })
})

describe('summarizeActivity', () => {
  it('says what happened, changes first, reasoning last', () => {
    const items: ActivityItem[] = [
      think({ durationMs: 21000, text: 'x' }),
      tool({ tool: 'shell', args: { command: 'a' } }),
      tool({ tool: 'shell', args: { command: 'b' } }),
      tool({ tool: 'fs_read', args: { path: 'a' } }),
      tool({ tool: 'fs_edit', args: { path: 'src/Transcript.tsx', old_string: '', new_string: '' } }),
      tool({ tool: 'grep_search', args: { pattern: 'x' } })
    ]
    expect(summarizeActivity(items)).toBe('Edited Transcript.tsx, ran 2 commands, read 1 file, searched once, thought 21s')
  })

  it('counts distinct files edited and leaves out sub-second reasoning', () => {
    const items: ActivityItem[] = [
      think({ durationMs: 400 }),
      tool({ tool: 'fs_edit', args: { path: 'a.ts', old_string: '', new_string: '' } }),
      tool({ tool: 'fs_edit', args: { path: 'a.ts', old_string: '', new_string: '' } }),
      tool({ tool: 'fs_write', args: { path: 'b.ts', content: '' } })
    ]
    expect(summarizeActivity(items)).toBe('Edited 2 files')
  })

  it('names other tools in words and falls back to "Worked" for nothing', () => {
    expect(summarizeActivity([tool({ tool: 'job_status' }), tool({ tool: 'mcp__bambu__get_status' })])).toBe('Checked on jobs, get status')
    expect(summarizeActivity([])).toBe('Worked')
  })
})

describe('activityOutcome', () => {
  it('stays running while any call is open or the block is the pending tail of a live turn', () => {
    const live = [tool({ tool: 'shell', status: 'running' })]
    expect(activityOutcome(live, true, false).status).toBe('running')
    const settled = [tool({ tool: 'shell', durationMs: 500 })]
    expect(activityOutcome(settled, true, true).status).toBe('running')
    expect(activityOutcome(settled, true, false)).toMatchObject({ status: 'complete', done: 1, calls: 1, durationMs: 500 })
  })

  it('reports failures and interruption, and adds reasoning time to the span', () => {
    const failed = [think({ durationMs: 2000, text: 'x' }), tool({ tool: 'shell', ok: false, status: 'failed', durationMs: 100 }), tool({ tool: 'shell', status: 'blocked' })]
    expect(activityOutcome(failed, false, false)).toMatchObject({ status: 'failed', failed: 2, done: 2, calls: 2, durationMs: 2100 })
    expect(activityOutcome([tool({ tool: 'shell', status: 'running' })], false, false).status).toBe('interrupted')
  })
})

describe('editCounts', () => {
  it('counts added and removed lines for an edit and only added for a write', () => {
    expect(editCounts({ tool: 'fs_edit', status: 'complete', args: { path: 'a', old_string: 'a\nb\nc', new_string: 'a\nx\nc\nd' } })).toEqual({ added: 2, removed: 1 })
    expect(editCounts({ tool: 'fs_write', status: 'complete', args: { path: 'a', content: 'one\ntwo' } })).toEqual({ added: 2, removed: 0 })
    expect(editCounts({ tool: 'fs_read', status: 'complete', args: { path: 'a' } })).toBeNull()
  })
})

describe('turnStats', () => {
  it('shows only the glanceable numbers and keeps the rest for the hover text', () => {
    const { text, title } = turnStats({ wallMs: 86000, tokensOut: 2800, tokensIn: 50000, cacheReadTokens: 44500, tps: 23.1, ttftMs: 800, tokensReasoning: 7 }, { usd: 0.0031, estimated: true })
    expect(text).toBe('1m 26s · 2.8k out · 89% cached · ~$0.0031')
    expect(title).toContain('23.1 tokens/s')
    expect(title).toContain('0.8s to first token')
    expect(title).toContain('7 reasoning tokens')
  })

  it('uses the provider cost when it reported one', () => {
    expect(turnStats({ wallMs: 1200, costUsd: 0.12 }).text).toBe('1.2s · $0.120')
  })
})

describe('shortModel', () => {
  it('drops the provider prefix', () => {
    expect(shortModel('deepseek/deepseek-v4-flash')).toBe('deepseek-v4-flash')
    expect(shortModel('openrouter/z-ai/glm-5.3-flash')).toBe('glm-5.3-flash')
    expect(shortModel(undefined)).toBe('')
  })
})
