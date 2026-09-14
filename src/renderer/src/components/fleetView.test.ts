import { describe, expect, it } from 'vitest'
import type { FleetAgentView, ModelInfo, RunEvent } from '@shared/types'
import { fleetCounts, fleetReasoningLabel, fleetTreeRoutes, latestFleetRun, plainPreview, roundedPath } from './fleetView'

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

/** Every coordinate an SVG path visits (endpoints of L segments and Q control/end points). */
const coords = (d: string): { x: number; y: number }[] => {
  const nums = d.match(/-?\d+(\.\d+)?/g)!.map(Number)
  const out: { x: number; y: number }[] = []
  for (let i = 0; i < nums.length; i += 2) out.push({ x: nums[i]!, y: nums[i + 1]! })
  return out
}

describe('roundedPath', () => {
  it('draws a straight line when there is no bend', () => {
    expect(roundedPath([{ x: 10, y: 0 }, { x: 10, y: 40 }, { x: 10, y: 90 }])).toBe('M 10 0 L 10 90')
  })

  it('rounds each bend and clamps the radius to half the shorter segment', () => {
    expect(roundedPath([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 50, y: 6 }], 10)).toBe('M 0 0 L 0 3 Q 0 6 3 6 L 50 6')
  })

  it('drops duplicate points instead of emitting NaN', () => {
    const d = roundedPath([{ x: 5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: 20 }])
    expect(d).toBe('M 5 5 L 5 20')
    expect(d).not.toContain('NaN')
  })
})

describe('fleetTreeRoutes', () => {
  const hub = { x: 590, y: 0, w: 20, h: 20 }
  const card = (x: number, y: number) => ({ x, y, w: 260, h: 200 })

  it('returns nothing for an empty roster', () => {
    expect(fleetTreeRoutes(hub, [])).toEqual([])
  })

  it('hangs the first row off one rail and ends every line on its card top-center', () => {
    const routes = fleetTreeRoutes(hub, [
      { id: 'a', box: card(0, 60) },
      { id: 'b', box: card(280, 60) },
      { id: 'c', box: card(560, 60) }
    ], { rail: 20 })
    expect(routes.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    for (const [i, r] of routes.entries()) {
      const pts = coords(r.d)
      expect(pts[0]).toEqual({ x: 600, y: 20 })
      expect(pts[pts.length - 1]).toEqual({ x: 130 + i * 280, y: 60 })
      // Horizontal travel happens only on the rail, above the cards.
      expect(pts.every((p) => p.y <= 60)).toBe(true)
    }
  })

  it('routes a wrapped row down a column gutter so no line crosses a first-row card', () => {
    const first = [card(0, 60), card(280, 60), card(560, 60), card(840, 60)]
    const routes = fleetTreeRoutes(hub, [
      ...first.map((box, i) => ({ id: `r0-${i}`, box })),
      { id: 'left', box: card(0, 320) },
      { id: 'right', box: card(840, 320) }
    ])
    for (const id of ['left', 'right']) {
      const pts = coords(routes.find((r) => r.id === id)!.d)
      expect(pts[pts.length - 1]!.y).toBe(320)
      for (let i = 1; i < pts.length; i += 1) {
        const a = pts[i - 1]!
        const b = pts[i]!
        // Any vertical run through the first row's band must sit in a gutter, not over a card.
        if (Math.abs(a.x - b.x) < 0.5 && Math.min(a.y, b.y) < 260 && Math.max(a.y, b.y) > 60) {
          expect(first.some((c) => a.x > c.x && a.x < c.x + c.w)).toBe(false)
        }
      }
    }
    // A left-of-hub card uses the gutter on its right (toward the hub); a right-of-hub card, its left.
    expect(coords(routes.find((r) => r.id === 'left')!.d).some((p) => p.x === 270)).toBe(true)
    expect(coords(routes.find((r) => r.id === 'right')!.d).some((p) => p.x === 830)).toBe(true)
  })
})

describe('plainPreview', () => {
  it('flattens markdown into one readable line', () => {
    expect(plainPreview('## Pass 3a — Draft 5187\n**Changed:** - ✅ **Returns** — set `30 days`')).toBe('Pass 3a — Draft 5187 Changed: - ✅ Returns — set 30 days')
  })
  it('drops links, list markers and tool-call tags', () => {
    expect(plainPreview('1. [thing:3628114](https://x.y/z)\n- <tool_call>batch</tool_call> done')).toBe('thing:3628114 batch done')
  })
  it('keeps snake_case and lone asterisks intact', () => {
    expect(plainPreview('run web_fetch on 5 * 3 items')).toBe('run web_fetch on 5 * 3 items')
    expect(plainPreview(undefined)).toBe('')
  })
})
