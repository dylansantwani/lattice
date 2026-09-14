import { describe, expect, it } from 'vitest'
import { BATCH_NUDGE_AFTER_ROUNDS, BATCH_NUDGE_TEXT, nextSingleCallStreak } from './runManager'

describe('nextSingleCallStreak — when the batch-adoption nudge arms', () => {
  it('counts consecutive rounds of exactly one foldable call', () => {
    let s = 0
    s = nextSingleCallStreak(s, ['fs_read'])
    s = nextSingleCallStreak(s, ['shell'])
    s = nextSingleCallStreak(s, ['grep_search'])
    expect(s).toBe(3)
    expect(s).toBeGreaterThanOrEqual(BATCH_NUDGE_AFTER_ROUNDS)
  })

  it('resets on a multi-call round — that IS the wanted behavior', () => {
    expect(nextSingleCallStreak(2, ['fs_read', 'shell'])).toBe(0)
  })

  it('treats legitimately-solo tools as neutral: no increment, no reset', () => {
    expect(nextSingleCallStreak(2, ['batch'])).toBe(2)
    expect(nextSingleCallStreak(2, ['ask_user'])).toBe(2)
    expect(nextSingleCallStreak(2, ['run_agent'])).toBe(2)
    expect(nextSingleCallStreak(2, ['job_status'])).toBe(2)
  })

  it('a lone MCP or ordinary tool counts toward the streak', () => {
    expect(nextSingleCallStreak(0, ['mcp__openbrowser__browser_act'])).toBe(1)
  })

  it('the nudge text names the fix, not just the problem', () => {
    expect(BATCH_NUDGE_TEXT).toContain('batch')
    expect(BATCH_NUDGE_TEXT).toContain('parallel:true')
  })
})
