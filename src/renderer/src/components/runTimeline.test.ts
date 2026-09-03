import { describe, it, expect } from 'vitest'
import type { RunEvent, RunEventBody } from '@shared/types'
import {
  buildTimeline,
  draftPreviewFor,
  draftStringField,
  eventsForSegment,
  findResultImages,
  groupTimeline,
  toolActivityLabel,
  type TimelineItem
} from './runTimeline'

let seq = 0
function ev(body: RunEventBody, ts: number): RunEvent {
  return { id: `e${seq}`, runId: 'r1', threadId: 't1', seq: seq++, ts, body }
}

function reset(): void {
  seq = 0
}

function asThink(item: TimelineItem): Extract<TimelineItem, { kind: 'think' }> {
  if (item.kind !== 'think') throw new Error(`expected think, got ${item.kind}`)
  return item
}

function asTool(item: TimelineItem): Extract<TimelineItem, { kind: 'tool' }> {
  if (item.kind !== 'tool') throw new Error(`expected tool, got ${item.kind}`)
  return item
}

function asOutput(item: TimelineItem): Extract<TimelineItem, { kind: 'output' }> {
  if (item.kind !== 'output') throw new Error(`expected output, got ${item.kind}`)
  return item
}

describe('buildTimeline', () => {
  it('orders a think → tools sequence with the thinking block first', () => {
    reset()
    const events = [
      ev({ type: 'reasoning.delta', text: 'let me ', fidelity: 'summary' }, 1000),
      ev({ type: 'reasoning.delta', text: 'check', fidelity: 'summary' }, 1200),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 1500),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: { path: 'a' } }, 1600),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: 'x', durationMs: 40 }, 1700)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool'])
    const think = asThink(items[0]!)
    expect(think.text).toBe('let me check')
    // Duration is the real thinking span (done − first delta), not the whole turn.
    expect(think.endTs! - think.startTs).toBe(500)
    const tool = asTool(items[1]!)
    expect(tool.call.status).toBe('complete')
    expect(tool.call.durationMs).toBe(40)
  })

  it('closes an unterminated thinking segment when a tool call begins', () => {
    reset()
    // No reasoning.done arrives — the tool.started must still close the segment.
    const events = [
      ev({ type: 'reasoning.delta', text: 'thinking', fidelity: 'raw' }, 2000),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: {} }, 2300)
    ]
    const items = buildTimeline(events)
    expect(items).toHaveLength(2)
    expect(asThink(items[0]!).endTs).toBe(2300)
  })

  it('keeps separate thinking bouts around interleaved tool calls', () => {
    reset()
    const events = [
      ev({ type: 'reasoning.delta', text: 'first', fidelity: 'summary' }, 0),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 100),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: {} }, 150),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: '', durationMs: 5 }, 200),
      ev({ type: 'reasoning.delta', text: 'second', fidelity: 'summary' }, 250),
      ev({ type: 'reasoning.done', fidelity: 'summary' }, 300)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool', 'think'])
    expect(asThink(items[0]!).text).toBe('first')
    expect(asThink(items[2]!).text).toBe('second')
  })

  it('dates a segment from startedAt, not the (coalesced) delta ts', () => {
    reset()
    // The delta is persisted at t=5000 but the model began thinking at t=2000.
    const events = [
      ev({ type: 'reasoning.delta', text: 'hmm', fidelity: 'raw', startedAt: 2000 }, 5000),
      ev({ type: 'reasoning.done', fidelity: 'raw', durationMs: 3000 }, 5000)
    ]
    const think = asThink(buildTimeline(events)[0]!)
    expect(think.startTs).toBe(2000)
  })

  it('reports the real thinking span even when reasoning is flushed as one delta at the tool call', () => {
    reset()
    // Regression for "THOUGHT FOR 0S": the model reasoned for ~6s, but the whole reasoning buffer is
    // only persisted at the instant the tool call begins, so every reasoning timestamp collapses onto
    // the tool-call moment. The authoritative durationMs from the run loop must win over endTs−startTs.
    const events = [
      ev({ type: 'reasoning.delta', text: 'I should snapshot the page', fidelity: 'raw', startedAt: 1000 }, 7000),
      ev({ type: 'reasoning.done', fidelity: 'raw', durationMs: 6000 }, 7000),
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'browser__snapshot' }, 7001),
      ev({ type: 'tool.started', callId: 'c1', tool: 'browser__snapshot', args: {} }, 7002),
      ev({ type: 'tool.result', callId: 'c1', tool: 'browser__snapshot', ok: true, result: '', durationMs: 79 }, 7100)
    ]
    const think = asThink(buildTimeline(events)[0]!)
    expect(think.durationMs).toBe(6000)

    // Without the fix (no startedAt, no durationMs) every reasoning timestamp is the tool-call
    // instant, so the renderer's endTs−startTs read 0 — the "THOUGHT FOR 0S" bug. Prove that shape
    // still collapses, and that durationMs is what saves it.
    reset()
    const legacy = asThink(
      buildTimeline([
        ev({ type: 'reasoning.delta', text: 'I should snapshot the page', fidelity: 'raw' }, 7000),
        ev({ type: 'reasoning.done', fidelity: 'raw' }, 7000),
        ev({ type: 'tool.started', callId: 'c1', tool: 'browser__snapshot', args: {} }, 7001)
      ])[0]!
    )
    expect(legacy.endTs! - legacy.startTs).toBe(0)
    expect(legacy.durationMs).toBeUndefined()
  })

  it('closes the reasoning bout on reasoning.done before a following tool row (no double-close drift)', () => {
    reset()
    const events = [
      ev({ type: 'reasoning.delta', text: 'think', fidelity: 'raw', startedAt: 100 }, 900),
      ev({ type: 'reasoning.done', fidelity: 'raw', durationMs: 800 }, 900),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: {} }, 950)
    ]
    const think = asThink(buildTimeline(events)[0]!)
    // reasoning.done set the end at 900; the later tool.started must NOT push it to 950.
    expect(think.endTs).toBe(900)
    expect(think.durationMs).toBe(800)
  })

  it('leaves a live segment open (no endTs) until it is closed', () => {
    reset()
    const items = buildTimeline([ev({ type: 'reasoning.delta', text: 'still going', fidelity: 'raw' }, 500)])
    expect(items).toHaveLength(1)
    expect(asThink(items[0]!).endTs).toBeUndefined()
  })

  it('groups multi-event tool calls into one row at its first position', () => {
    reset()
    const events = [
      ev({ type: 'tool.proposed', callId: 'c1', tool: 'shell', args: { cmd: 'ls' }, riskTier: 'R1' }, 0),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { cmd: 'ls' } }, 10),
      ev({ type: 'tool.denied', callId: 'c1', reason: 'blocked by policy' }, 20)
    ]
    const items = buildTimeline(events)
    expect(items).toHaveLength(1)
    const tool = asTool(items[0]!)
    expect(tool.call.status).toBe('blocked')
    expect(tool.call.reason).toBe('blocked by policy')
  })

  it('opens a drafting row from tool.drafting and folds the later proposal/result into it', () => {
    reset()
    // The model streams the call name first (tool.drafting), then the completed call is proposed,
    // started, and returns — all under the same callId. The transcript must show ONE row that
    // advances requested → running → complete, never a second row for the drafted phase.
    const events = [
      ev({ type: 'text.delta', text: 'Let me check.' }, 0),
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'shell' }, 10),
      ev({ type: 'tool.proposed', callId: 'c1', tool: 'shell', args: { cmd: 'ls' }, riskTier: 'R1' }, 20),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { cmd: 'ls' } }, 30),
      ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: 'x', durationMs: 7 }, 40)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['output', 'tool'])
    // The drafting event closed the output block at its timestamp, before the row opened.
    expect(asOutput(items[0]!).endTs).toBe(10)
    const tool = asTool(items[1]!)
    expect(tool.call.tool).toBe('shell')
    expect(tool.call.status).toBe('complete')
    expect(tool.call.durationMs).toBe(7)
  })

  it('leaves a drafted-only call as a requested row (the live "preparing" state)', () => {
    reset()
    // Mid-stream: only the drafting event has landed. The row exists and is requested, which the
    // renderer paints as the "preparing" pulse while the run is live.
    const items = buildTimeline([ev({ type: 'tool.drafting', callId: 'c1', tool: 'fs_read' }, 5)])
    expect(items).toHaveLength(1)
    const tool = asTool(items[0]!)
    expect(tool.call.tool).toBe('fs_read')
    expect(tool.call.status).toBe('requested')
  })

  it('folds successive draft argument snapshots and extracts the live write content', () => {
    reset()
    const events = [
      ev(
        {
          type: 'tool.drafting',
          callId: 'c1',
          tool: 'fs_write',
          args: '{"path":"src/App.tsx","content":"export const answer = 4'
        },
        5
      ),
      ev(
        {
          type: 'tool.drafting',
          callId: 'c1',
          tool: 'fs_write',
          args: '{"path":"src/App.tsx","content":"export const answer = 4\\nconsole.log(\\"ready\\")"}'
        },
        10
      )
    ]
    const tool = asTool(buildTimeline(events)[0]!)
    expect(tool.call.draftArgs).toBe(
      '{"path":"src/App.tsx","content":"export const answer = 4\\nconsole.log(\\"ready\\")"}'
    )
    expect(draftPreviewFor(tool.call)).toEqual({
      label: 'Writing',
      text: 'export const answer = 4\nconsole.log("ready")',
      target: 'src/App.tsx'
    })
  })

  it('weaves output between thinking and tools in true order (the reported bug)', () => {
    reset()
    // think → speak → tool → think → speak, exactly the alternation that used to collapse every
    // spoken passage into one block at the bottom. reasoning.done arrives after the text delta in a
    // round (as the runtime emits it) and must be a no-op once speaking already closed the segment.
    const events = [
      ev({ type: 'reasoning.delta', text: 'plan', fidelity: 'raw' }, 0),
      ev({ type: 'text.delta', text: 'First, ' }, 10),
      ev({ type: 'text.delta', text: 'let me look.' }, 20),
      ev({ type: 'reasoning.done', fidelity: 'raw' }, 25),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: {} }, 30),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: 'x', durationMs: 5 }, 40),
      ev({ type: 'reasoning.delta', text: 'now write', fidelity: 'raw' }, 50),
      ev({ type: 'text.delta', text: 'Done.' }, 60)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['think', 'output', 'tool', 'think', 'output'])
    expect(asOutput(items[1]!).text).toBe('First, let me look.')
    expect(asOutput(items[4]!).text).toBe('Done.')
    // Speaking closed the first thinking block at the first text delta, not at reasoning.done.
    expect(asThink(items[0]!).endTs).toBe(10)
  })

  it('merges consecutive output deltas and closes the block when a tool call begins', () => {
    reset()
    const events = [
      ev({ type: 'text.delta', text: 'one ' }, 0),
      ev({ type: 'text.delta', text: 'two' }, 10),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: {} }, 20)
    ]
    const items = buildTimeline(events)
    expect(items.map((i) => i.kind)).toEqual(['output', 'tool'])
    expect(asOutput(items[0]!).text).toBe('one two')
    expect(asOutput(items[0]!).endTs).toBe(20)
  })

  it('leaves the final output block open (no endTs) while it is still streaming', () => {
    reset()
    const items = buildTimeline([ev({ type: 'text.delta', text: 'streaming…' }, 5)])
    expect(items).toHaveLength(1)
    expect(asOutput(items[0]!).endTs).toBeUndefined()
  })

  it('sorts out-of-order events by seq before weaving', () => {
    reset()
    const a = ev({ type: 'reasoning.delta', text: 'x', fidelity: 'summary' }, 0)
    const b = ev({ type: 'reasoning.done', fidelity: 'summary' }, 50)
    const c = ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: {} }, 60)
    const items = buildTimeline([c, a, b])
    expect(items.map((i) => i.kind)).toEqual(['think', 'tool'])
  })

  it('rewinds a failed attempt: a rewound retry drops the partial output it streamed', () => {
    reset()
    const items = buildTimeline([
      ev({ type: 'reasoning.delta', text: 'thinking…', fidelity: 'raw' }, 10),
      ev({ type: 'text.delta', text: 'Here is the ans' }, 20), // partial reply, then the socket drops
      ev({ type: 'retry', attempt: 1, reason: 'endpoint dropped — retrying (1/4) in 0.5s…', rewound: true }, 30),
      ev({ type: 'text.delta', text: 'Here is the answer: 42.' }, 40) // the clean redo
    ])
    // The failed think + partial output are gone; only the retry notice and the successful reply remain.
    expect(items.map((i) => i.kind)).toEqual(['notice', 'output'])
    expect(asOutput(items[1]!).text).toBe('Here is the answer: 42.')
  })

  it('keeps output committed by a completed tool round when a later attempt is rewound', () => {
    reset()
    const items = buildTimeline([
      ev({ type: 'text.delta', text: 'Reading the file. ' }, 10),
      ev({ type: 'tool.started', callId: 'c1', tool: 'fs_read', args: { path: 'a' } }, 20),
      ev({ type: 'tool.result', callId: 'c1', tool: 'fs_read', ok: true, result: 'x', durationMs: 5 }, 30),
      ev({ type: 'text.delta', text: 'Now the half-writt' }, 40), // next round's stream drops mid-reply
      ev({ type: 'retry', attempt: 1, reason: 'endpoint error — retrying (1/4) in 0.5s…', rewound: true }, 50),
      ev({ type: 'text.delta', text: 'Now the file says foo.' }, 60)
    ])
    // The committed pre-tool output and the tool row survive; only the failed round's partial is dropped.
    expect(items.map((i) => i.kind)).toEqual(['output', 'tool', 'notice', 'output'])
    expect(asOutput(items[0]!).text).toBe('Reading the file. ')
    expect(asTool(items[1]!).call.status).toBe('complete')
    expect(asOutput(items[3]!).text).toBe('Now the file says foo.')
  })

  it('reissues a tool draft cleanly after a rewind (same callId does not orphan the row)', () => {
    reset()
    const items = buildTimeline([
      ev({ type: 'text.delta', text: 'Let me ' }, 10),
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'shell', args: '{"command":"ls' }, 20), // drafting, then drop
      ev({ type: 'retry', attempt: 1, reason: 'endpoint dropped — retrying (1/4) in 0.5s…', rewound: true }, 30),
      ev({ type: 'tool.drafting', callId: 'c1', tool: 'shell', args: '{"command":"ls -la"}' }, 40),
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { command: 'ls -la' } }, 50),
      ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: 'ok', durationMs: 3 }, 60)
    ])
    expect(items.map((i) => i.kind)).toEqual(['notice', 'tool'])
    const t = asTool(items[1]!)
    expect(t.call.status).toBe('complete')
    expect(t.call.tool).toBe('shell')
  })

  it('a non-rewound retry (stall/length) keeps the partial output it continues', () => {
    reset()
    const items = buildTimeline([
      ev({ type: 'text.delta', text: 'Let me write the file directly.' }, 10),
      ev({ type: 'retry', attempt: 1, reason: 'the route dropped the tool call — re-requesting.' }, 20),
      ev({ type: 'text.delta', text: ' Done.' }, 30)
    ])
    // No rewind: the earlier output stays, the notice sits between, and the continuation appends.
    expect(items.map((i) => i.kind)).toEqual(['output', 'notice', 'output'])
    expect(asOutput(items[0]!).text).toBe('Let me write the file directly.')
  })

  it('a rewound retry after a steer boundary cannot reach past the steer', () => {
    reset()
    const items = buildTimeline([
      ev({ type: 'text.delta', text: 'first answer' }, 10),
      ev({ type: 'steer.injected', messageId: 'm1' }, 20),
      ev({ type: 'text.delta', text: 'second, half-writt' }, 30), // post-steer round drops mid-stream
      ev({ type: 'retry', attempt: 1, reason: 'endpoint error — retrying (1/4) in 0.5s…', rewound: true }, 40),
      ev({ type: 'text.delta', text: 'second answer done.' }, 50)
    ])
    // The committed pre-steer output survives; only the post-steer failed partial is dropped.
    expect(items.map((i) => i.kind)).toEqual(['output', 'notice', 'output'])
    expect(asOutput(items[0]!).text).toBe('first answer')
    expect(asOutput(items[2]!).text).toBe('second answer done.')
  })
})

/** Build a bare tool timeline item for grouping tests. */
function tool(callId: string, name = 'fs_read'): TimelineItem {
  return { kind: 'tool', seq: 0, callId, call: { tool: name, status: 'complete' } }
}
function think(text = 'x'): TimelineItem {
  return { kind: 'think', seq: 0, text, startTs: 0 }
}
function output(text = 'hi'): TimelineItem {
  return { kind: 'output', seq: 0, text, startTs: 0 }
}

describe('groupTimeline', () => {
  it('collapses a run of consecutive tool calls into one group', () => {
    const nodes = groupTimeline([tool('a'), tool('b'), tool('c')])
    expect(nodes).toHaveLength(1)
    const g = nodes[0]!
    expect(g.kind).toBe('tool-group')
    if (g.kind !== 'tool-group') throw new Error('expected group')
    expect(g.calls.map((c) => c.callId)).toEqual(['a', 'b', 'c'])
  })

  it('leaves a lone tool call as a plain tool item', () => {
    const nodes = groupTimeline([think(), tool('a'), output()])
    expect(nodes.map((n) => n.kind)).toEqual(['think', 'tool', 'output'])
  })

  it('breaks runs on interleaved thinking or output', () => {
    const nodes = groupTimeline([
      tool('a'),
      tool('b'),
      think('mid'),
      tool('c'),
      output('done'),
      tool('d'),
      tool('e')
    ])
    expect(nodes.map((n) => n.kind)).toEqual(['tool-group', 'think', 'tool', 'output', 'tool-group'])
    const first = nodes[0]!
    const last = nodes[4]!
    if (first.kind !== 'tool-group' || last.kind !== 'tool-group') throw new Error('expected groups')
    expect(first.calls).toHaveLength(2)
    expect(last.calls.map((c) => c.callId)).toEqual(['d', 'e'])
  })

  it('positions a group at the seq of its first call', () => {
    const a: TimelineItem = { kind: 'tool', seq: 7, callId: 'a', call: { tool: 'shell', status: 'complete' } }
    const b: TimelineItem = { kind: 'tool', seq: 9, callId: 'b', call: { tool: 'shell', status: 'complete' } }
    const nodes = groupTimeline([a, b])
    expect(nodes[0]!.seq).toBe(7)
  })

  it('returns an empty list unchanged', () => {
    expect(groupTimeline([])).toEqual([])
  })
})

describe('eventsForSegment', () => {
  // Model a steered run: one runId, events streamed continuously, split into two assistant
  // segments. The second segment was stamped at the steer boundary (createdAt 200); the model's
  // pre-steer work is ts < 200, the continuation is ts >= 200. ids double as ordering markers.
  const mk = (id: string, ts: number): RunEvent => ({
    id,
    runId: 'r1',
    threadId: 't1',
    seq: 0,
    ts,
    body: { type: 'text.delta', text: id }
  })
  const run = [mk('a', 100), mk('b', 150), mk('steer', 199), mk('c', 250), mk('d', 300)]

  it('gives an unsplit run (single segment) all of its events', () => {
    // The common case: no steer, one assistant message. Nothing is scoped away.
    expect(eventsForSegment(run, [100], 100).map((e) => e.id)).toEqual(['a', 'b', 'steer', 'c', 'd'])
  })

  it('scopes each segment of a steered run to its own slice, with no overlap', () => {
    const first = eventsForSegment(run, [100, 200], 100)
    const second = eventsForSegment(run, [100, 200], 200)
    // The first segment owns everything up to (not including) the next segment's boundary…
    expect(first.map((e) => e.id)).toEqual(['a', 'b', 'steer'])
    // …and the continuation owns the rest. Together they partition the run exactly once — the
    // duplication/misordering bug was every segment getting the whole list.
    expect(second.map((e) => e.id)).toEqual(['c', 'd'])
    expect([...first, ...second].map((e) => e.id)).toEqual(run.map((e) => e.id))
  })

  it('lets the earliest segment claim events stamped before its own createdAt', () => {
    // run.started / an early reasoning delta can land a few ms before the first assistant message
    // is inserted. The first segment's lower bound is −∞ so those are never dropped.
    const early = [mk('pre', 90), ...run]
    expect(eventsForSegment(early, [100, 200], 100).map((e) => e.id)).toEqual(['pre', 'a', 'b', 'steer'])
  })

  it('handles three segments (two steers) as contiguous non-overlapping windows', () => {
    const starts = [100, 200, 280]
    expect(eventsForSegment(run, starts, 100).map((e) => e.id)).toEqual(['a', 'b', 'steer'])
    expect(eventsForSegment(run, starts, 200).map((e) => e.id)).toEqual(['c'])
    expect(eventsForSegment(run, starts, 280).map((e) => e.id)).toEqual(['d'])
  })

  it('does not require segmentStarts to be pre-sorted', () => {
    expect(eventsForSegment(run, [200, 100], 200).map((e) => e.id)).toEqual(['c', 'd'])
  })
})

describe('findResultImages', () => {
  it('extracts an MCP image content block (the show_image tool shape)', () => {
    const found = findResultImages({ type: 'image', mimeType: 'image/png', data: 'QQ==', path: '/a.png' })
    expect(found).toEqual([{ url: 'data:image/png;base64,QQ==', caption: undefined }])
  })

  it('carries a caption through when present', () => {
    const found = findResultImages({ type: 'image', mimeType: 'image/png', data: 'QQ==', caption: 'Q3 revenue' })
    expect(found).toEqual([{ url: 'data:image/png;base64,QQ==', caption: 'Q3 revenue' }])
  })

  it('defaults to image/png when an MCP image block omits mimeType', () => {
    const found = findResultImages({ type: 'image', data: 'QQ==' })
    expect(found[0]!.url).toBe('data:image/png;base64,QQ==')
  })

  it('extracts an image-bearing embedded resource', () => {
    const found = findResultImages({
      type: 'resource',
      resource: { uri: 'file:///x.png', mimeType: 'image/jpeg', blob: 'QQ==' }
    })
    expect(found).toEqual([{ url: 'data:image/jpeg;base64,QQ==', caption: undefined }])
  })

  it('ignores a non-image embedded resource (e.g. a PDF or text file)', () => {
    expect(findResultImages({ type: 'resource', resource: { uri: 'file:///x.pdf', mimeType: 'application/pdf', blob: 'QQ==' } })).toEqual([])
  })

  it('finds a raw data:image/* string nested anywhere in the result tree', () => {
    const found = findResultImages({ ok: true, nested: { screenshot: 'data:image/png;base64,QQ==' } })
    expect(found).toEqual([{ url: 'data:image/png;base64,QQ==' }])
  })

  it('ignores a non-image data: URL string', () => {
    expect(findResultImages('data:text/plain;base64,QQ==')).toEqual([])
  })

  it('finds every image inside an array of MCP content blocks', () => {
    const found = findResultImages({
      content: [
        { type: 'text', text: 'here is the chart' },
        { type: 'image', mimeType: 'image/png', data: 'QQ==' },
        { type: 'image', mimeType: 'image/jpeg', data: 'Qg==' }
      ]
    })
    expect(found.map((f) => f.url)).toEqual(['data:image/png;base64,QQ==', 'data:image/jpeg;base64,Qg=='])
  })

  it('caps at 4 images even when the result carries more', () => {
    const content = Array.from({ length: 10 }, (_, i) => ({ type: 'image', mimeType: 'image/png', data: `img${i}` }))
    expect(findResultImages({ content })).toHaveLength(4)
  })

  it('returns nothing for a plain text/object result with no image content', () => {
    expect(findResultImages({ path: '/a.txt', content: 'hello world' })).toEqual([])
    expect(findResultImages('just a string')).toEqual([])
    expect(findResultImages(null)).toEqual([])
    expect(findResultImages(undefined)).toEqual([])
  })
})

describe('groupTimeline — delegation calls stay standalone', () => {
  const tool = (callId: string, name: string): TimelineItem => ({
    kind: 'tool',
    seq: seq++,
    callId,
    call: { tool: name, status: 'complete', ok: true }
  })

  it('never folds a run_agent call into a tool group, and splits the run around it', () => {
    reset()
    const items = [tool('a', 'fs_read'), tool('b', 'fs_read'), tool('c', 'run_agent'), tool('d', 'shell'), tool('e', 'grep_search')]
    const nodes = groupTimeline(items)
    expect(nodes.map((n) => n.kind)).toEqual(['tool-group', 'tool', 'tool-group'])
    const mid = nodes[1]!
    expect(mid.kind === 'tool' ? mid.callId : undefined).toBe('c')
  })

  it('leaves a lone run_agent between single calls as three plain rows', () => {
    reset()
    const nodes = groupTimeline([tool('a', 'fs_read'), tool('b', 'run_agent'), tool('c', 'fs_read')])
    expect(nodes.map((n) => n.kind)).toEqual(['tool', 'tool', 'tool'])
  })

  it('accepts a custom standalone predicate', () => {
    reset()
    const nodes = groupTimeline([tool('a', 'run_agent'), tool('b', 'run_agent')], () => false)
    expect(nodes.map((n) => n.kind)).toEqual(['tool-group'])
  })
})

describe('draftStringField / toolActivityLabel', () => {
  it('reads a string field out of streaming args, complete or not', () => {
    expect(draftStringField('{"task":"find the bug","name":"Bug Hu', 'name')).toBe('Bug Hu')
    expect(draftStringField('{"task":"find the bug","name":"Bug Hunt"}', 'name')).toBe('Bug Hunt')
    expect(draftStringField('{"task":"find', 'name')).toBeUndefined()
    expect(draftStringField(undefined, 'name')).toBeUndefined()
  })

  it('labels a call by its primary argument, preferring the target for write-like tools', () => {
    expect(toolActivityLabel('fs_read', { path: 'src/app.ts' })).toBe('Reading src/app.ts')
    expect(toolActivityLabel('fs_write', { path: 'out.md', content: 'lots' })).toBe('Writing out.md')
    expect(toolActivityLabel('fs_move', { from: 'a', to: 'b' })).toBe('Moving b')
    expect(toolActivityLabel('shell', { command: 'npm   test\n' })).toBe('Running npm test')
    expect(toolActivityLabel('grep_search', { pattern: 'TODO', path: 'src' })).toBe('Searching TODO')
    expect(toolActivityLabel('shell', {})).toBe('Running')
    expect(toolActivityLabel('mcp__github__list_prs', { repo: 'x' })).toBe('list_prs')
    expect(toolActivityLabel('fs_read', { path: 'x'.repeat(100) })).toBe(`Reading ${'x'.repeat(71)}…`)
  })
})

describe('draftPreviewFor — live drafting for shell and grep', () => {
  it('previews a shell command while its arguments stream (the argument is `command`, not `cmd`)', () => {
    const call = { tool: 'shell', status: 'requested', draftArgs: '{"command":"npm test -- --watch=fa' }
    expect(draftPreviewFor(call)).toMatchObject({ label: 'Running', text: 'npm test -- --watch=fa' })
    expect(draftPreviewFor({ tool: 'start_job', status: 'requested', draftArgs: '{"command":"pnpm build' })).toMatchObject({
      label: 'Starting job',
      text: 'pnpm build'
    })
  })

  it('previews a grep pattern (the argument is `pattern`, not `query`)', () => {
    const call = { tool: 'grep_search', status: 'requested', draftArgs: '{"pattern":"TODO","path":"src/ma' }
    expect(draftPreviewFor(call)).toMatchObject({ label: 'Searching', text: 'TODO' })
  })

  it('still previews an fs_edit replacement as it streams', () => {
    const call = { tool: 'fs_edit', status: 'requested', draftArgs: '{"path":"a.ts","old_string":"x","new_string":"const y = 4' }
    expect(draftPreviewFor(call)).toEqual({ label: 'Editing', text: 'const y = 4', target: 'a.ts' })
  })
})

describe('tool.progress and purpose', () => {
  it('folds live output into the running call and drops it once the result lands', () => {
    const events = [
      ev({ type: 'tool.started', callId: 'c1', tool: 'shell', args: { command: 'npm test', purpose: 'Run the tests' } }, 1),
      ev({ type: 'tool.progress', callId: 'c1', output: 'PASS a.test.ts' }, 2),
      ev({ type: 'tool.progress', callId: 'c1', output: 'PASS a.test.ts\nPASS b.test.ts' }, 3)
    ]
    const running = buildTimeline(events).find((i) => i.kind === 'tool')!
    expect(running.kind === 'tool' && running.call.liveOutput).toBe('PASS a.test.ts\nPASS b.test.ts')
    expect(running.kind === 'tool' && running.call.status).toBe('running')
    const done = buildTimeline([
      ...events,
      ev({ type: 'tool.result', callId: 'c1', tool: 'shell', ok: true, result: { stdout: 'all good' }, durationMs: 5 }, 4)
    ]).find((i) => i.kind === 'tool')!
    expect(done.kind === 'tool' && done.call.status).toBe('complete')
  })

  it('labels a command by its purpose when one is given', () => {
    expect(toolActivityLabel('shell', { command: 'python bench.py', purpose: 'Benchmark the 3 hosts' })).toBe(
      'Running Benchmark the 3 hosts'
    )
    expect(toolActivityLabel('start_job', { command: 'pnpm build', purpose: 'Build the bundle' })).toBe(
      'Starting job Build the bundle'
    )
  })
})
