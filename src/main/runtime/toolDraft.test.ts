import { describe, expect, it } from 'vitest'
import { shouldReemitToolDraft } from './runManager'

// Drafting events persist the FULL argument prefix each time, so the re-emit gate is what keeps
// the event store's write volume linear in the argument size instead of quadratic. These tests pin
// the two regimes: small prefixes keep the original snappy time-or-text cadence; large prefixes
// require BOTH the time gate and proportional (1/8th) growth.

const T = 1_000_000 // arbitrary "now" base

describe('shouldReemitToolDraft — small prefixes (original cadence)', () => {
  it('always allows the first emit', () => {
    expect(shouldReemitToolDraft(0, 0, 10, T)).toBe(true)
  })

  it('re-emits when the time gate passes, even with little new text', () => {
    expect(shouldReemitToolDraft(500, T - 200, 510, T)).toBe(true)
  })

  it('re-emits when enough new text arrived, even inside the time gate', () => {
    expect(shouldReemitToolDraft(500, T - 10, 700, T)).toBe(true)
  })

  it('holds when neither the time nor the text gate passes', () => {
    expect(shouldReemitToolDraft(500, T - 10, 510, T)).toBe(false)
  })
})

describe('shouldReemitToolDraft — large prefixes (proportional growth)', () => {
  it('holds on time alone: a big prefix is not re-persisted every interval', () => {
    // 16 KB persisted; only 200 new chars — time gate long since passed.
    expect(shouldReemitToolDraft(16_000, T - 5_000, 16_200, T)).toBe(false)
  })

  it('re-emits once the prefix has grown by ~1/8th and the time gate passed', () => {
    const last = 16_000
    const grown = last + (last >> 3)
    expect(shouldReemitToolDraft(last, T - 5_000, grown, T)).toBe(true)
  })

  it('holds inside the time gate even with enough growth', () => {
    const last = 16_000
    const grown = last + (last >> 3)
    expect(shouldReemitToolDraft(last, T - 10, grown, T)).toBe(false)
  })

  it('bounds the events for a maximal draft to a small count', () => {
    // Simulate a 24 KB argument stream arriving 160 chars at a time with generous elapsed time —
    // the worst case for write volume. Count how many prefixes the gate lets through.
    let last = 0
    let lastAt = 0
    let emits = 0
    let persistedBytes = 0
    for (let visible = 160; visible <= 24_000; visible += 160) {
      const now = lastAt + 1_000 // every gate's time condition passes
      if (last === 0 || shouldReemitToolDraft(last, lastAt, visible, now)) {
        emits += 1
        persistedBytes += visible
        last = visible
        lastAt = now
      }
    }
    // Before the adaptive gate this was ~150 emits / ~1.8 MB persisted. Now the tail grows
    // geometrically: a handful of dozen emits and linear-order bytes.
    expect(emits).toBeLessThan(60)
    expect(persistedBytes).toBeLessThan(400_000)
  })
})
