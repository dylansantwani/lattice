import { describe, expect, it } from 'vitest'
import { cleanTitle } from './runManager'

describe('cleanTitle', () => {
  it('passes a clean title through', () => {
    expect(cleanTitle('Fix Login Redirect Bug')).toBe('Fix Login Redirect Bug')
  })

  it('takes the first non-empty line', () => {
    expect(cleanTitle('\n\nDatabase Migration Plan\nextra chatter')).toBe('Database Migration Plan')
  })

  it('strips a leading "Title:" label', () => {
    expect(cleanTitle('Title: Refactor Auth Module')).toBe('Refactor Auth Module')
  })

  it('strips surrounding quotes, backticks, and asterisks', () => {
    expect(cleanTitle('"Add Dark Mode"')).toBe('Add Dark Mode')
    expect(cleanTitle('**Set Up CI Pipeline**')).toBe('Set Up CI Pipeline')
    expect(cleanTitle('`Parse CSV Export`')).toBe('Parse CSV Export')
  })

  it('drops trailing punctuation', () => {
    expect(cleanTitle('Optimize Render Loop.')).toBe('Optimize Render Loop')
  })

  it('collapses whitespace and caps length', () => {
    expect(cleanTitle('A   spaced    out   title')).toBe('A spaced out title')
    expect(cleanTitle('x'.repeat(200))!.length).toBe(70)
  })

  it('returns null for empty or whitespace-only output', () => {
    expect(cleanTitle('')).toBeNull()
    expect(cleanTitle('   \n  ')).toBeNull()
  })
})
