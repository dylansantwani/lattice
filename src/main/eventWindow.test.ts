import { describe, expect, it } from 'vitest'
import { windowEvents, windowLimit } from './eventWindow'

/** `runs` consecutive runs of `perRun` events each, in time order — the shape of a real thread log. */
function log(runs: number, perRun: number) {
  return Array.from({ length: runs }, (_, r) =>
    Array.from({ length: perRun }, (_, i) => ({ runId: `run-${r}`, seq: i, id: `run-${r}-${i}` }))
  ).flat()
}

describe('windowLimit', () => {
  it('passes a usable size through, floored', () => {
    expect(windowLimit(2000)).toBe(2000)
    expect(windowLimit(1500.9)).toBe(1500)
  })

  it('treats an unusable size as "no window" rather than an empty transcript', () => {
    for (const bad of [undefined, null, 0, -5, NaN, Infinity, '2000', {}, []]) {
      expect(windowLimit(bad)).toBeUndefined()
    }
  })

  it('clamps a window bigger than any log', () => {
    expect(windowLimit(1e9)).toBe(20_000)
  })
})

describe('windowEvents', () => {
  it('returns the log untouched when it already fits', () => {
    const events = log(3, 10)
    expect(windowEvents(events, 100)).toBe(events)
  })

  it('keeps the tail, including the newest event', () => {
    const events = log(10, 100)
    const kept = windowEvents(events, 250)
    expect(kept.at(-1)).toEqual(events.at(-1))
    expect(kept.length).toBeLessThan(events.length)
    expect(kept.length).toBeGreaterThanOrEqual(250)
  })

  it('never cuts a run in half at the old end', () => {
    const events = log(10, 100)
    const kept = windowEvents(events, 250)
    const oldestKept = kept[0]?.runId
    expect(oldestKept).toBeDefined()
    expect(kept.filter((e) => e.runId === oldestKept)).toEqual(
      events.filter((e) => e.runId === oldestKept)
    )
  })

  it('keeps a live run whole even when it alone is longer than the window', () => {
    const live = Array.from({ length: 4000 }, (_, i) => ({ runId: 'live', seq: i, id: `live-${i}` }))
    const events = [...log(5, 50), ...live]
    const kept = windowEvents(events, 2000)
    expect(kept.filter((e) => e.runId === 'live')).toHaveLength(4000)
    expect(kept[0]?.runId).toBe('live')
  })

  it('extends to whole runs rather than halving one, even with interleaved subagent runs', () => {
    // Two runs interleaved in time, as a thread with a subagent looks.
    const events = Array.from({ length: 400 }, (_, i) => ({
      runId: i % 2 === 0 ? 'main' : 'sub', seq: i, id: `e-${i}`
    }))
    const kept = windowEvents(events, 100)
    for (const runId of new Set(kept.map((e) => e.runId))) {
      const all = events.filter((e) => e.runId === runId)
      const got = kept.filter((e) => e.runId === runId)
      expect(got).toHaveLength(all.length)
    }
  })
})
