import { describe, it, expect } from 'vitest'
import {
  FULL_CONTEXT_WINDOW,
  SMALL_CONTEXT_WINDOW,
  fmtContextWindow,
  isSmallContextWindow,
  scaleContextCap
} from './contextScale'

describe('fmtContextWindow', () => {
  it('reads local base-1024 windows as clean binary-k', () => {
    expect(fmtContextWindow(65536)).toBe('64k') // a llama.cpp 64k slot
    expect(fmtContextWindow(131072)).toBe('128k')
    expect(fmtContextWindow(262144)).toBe('256k')
    expect(fmtContextWindow(32768)).toBe('32k')
    expect(fmtContextWindow(4096)).toBe('4k')
  })

  it('reads cloud base-1000 windows as decimal-k', () => {
    expect(fmtContextWindow(128000)).toBe('128k') // integral in both bases; base-1000 wins
    expect(fmtContextWindow(200000)).toBe('200k')
    expect(fmtContextWindow(64000)).toBe('64k')
  })

  it('formats million-scale windows', () => {
    expect(fmtContextWindow(1_000_000)).toBe('1M')
    expect(fmtContextWindow(1_048_576)).toBe('1M')
    expect(fmtContextWindow(2_000_000)).toBe('2M')
  })

  it('falls back to a one-decimal figure when neither base is exact', () => {
    expect(fmtContextWindow(65535)).toBe('65.5k')
    expect(fmtContextWindow(999)).toBe('999')
  })

  it('handles missing / degenerate values', () => {
    expect(fmtContextWindow(0)).toBe('—')
    expect(fmtContextWindow(-1)).toBe('—')
    expect(fmtContextWindow(undefined)).toBe('—')
    expect(fmtContextWindow(Number.NaN)).toBe('—')
  })
})

describe('isSmallContextWindow', () => {
  it('flags real windows below the threshold', () => {
    expect(isSmallContextWindow(65536)).toBe(true)
    expect(isSmallContextWindow(32768)).toBe(true)
    expect(isSmallContextWindow(SMALL_CONTEXT_WINDOW - 1)).toBe(true)
  })

  it('does not flag full-size windows', () => {
    expect(isSmallContextWindow(SMALL_CONTEXT_WINDOW)).toBe(false)
    expect(isSmallContextWindow(128000)).toBe(false)
    expect(isSmallContextWindow(200000)).toBe(false)
  })

  it('does not flag unknown windows', () => {
    expect(isSmallContextWindow(undefined)).toBe(false)
    expect(isSmallContextWindow(0)).toBe(false)
    expect(isSmallContextWindow(Number.NaN)).toBe(false)
  })
})

describe('scaleContextCap', () => {
  const FULL = 48 * 1024
  const MIN = 8 * 1024

  it('keeps the baseline for full-size and unknown windows', () => {
    expect(scaleContextCap(FULL_CONTEXT_WINDOW, FULL, MIN)).toBe(FULL)
    expect(scaleContextCap(500_000, FULL, MIN)).toBe(FULL)
    expect(scaleContextCap(undefined, FULL, MIN)).toBe(FULL)
    expect(scaleContextCap(0, FULL, MIN)).toBe(FULL)
    expect(scaleContextCap(Number.NaN, FULL, MIN)).toBe(FULL)
  })

  it('scales down proportionally to the window', () => {
    // 64k of 200k ≈ 32% → ~15.7 KB, above the 8 KB floor.
    const at64k = scaleContextCap(65536, FULL, MIN)
    expect(at64k).toBe(Math.round(FULL * (65536 / FULL_CONTEXT_WINDOW)))
    expect(at64k).toBeGreaterThan(MIN)
    expect(at64k).toBeLessThan(FULL)
    // Halfway window → about half the cap.
    expect(scaleContextCap(100_000, FULL, MIN)).toBe(Math.round(FULL / 2))
  })

  it('never drops below the floor', () => {
    expect(scaleContextCap(8192, FULL, MIN)).toBe(MIN)
    expect(scaleContextCap(1, FULL, MIN)).toBe(MIN)
  })

  it('honors a custom full-context reference', () => {
    expect(scaleContextCap(64000, FULL, MIN, 64000)).toBe(FULL)
    expect(scaleContextCap(32000, FULL, MIN, 64000)).toBe(Math.round(FULL / 2))
  })
})
