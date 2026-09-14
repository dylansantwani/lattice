import { describe, expect, it } from 'vitest'
import { stripAnsi, truncate, visibleWidth } from './ansi'

describe('terminal ANSI helpers', () => {
  it('measures and truncates styled text by visible width', () => {
    const styled = '\u001b[1mhello\u001b[0m'
    expect(stripAnsi(styled)).toBe('hello')
    expect(visibleWidth(styled)).toBe(5)
    expect(truncate(styled, 4)).toBe('hel…')
  })
})
