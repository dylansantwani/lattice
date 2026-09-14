import { describe, expect, it } from 'vitest'
import { diffLines } from './diff'

describe('terminal live-region diff', () => {
  it('does not write when frames are identical', () => {
    expect(diffLines(['a', 'b'], ['a', 'b'])).toBe('')
  })

  it('clears and replaces only changed rows', () => {
    expect(diffLines(['a', 'b'], ['a', 'c'])).toContain('\u001b[2Kc')
    expect(diffLines(['a', 'b'], ['a', 'c'])).not.toContain('a')
  })
})
