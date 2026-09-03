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

describe('cleanTitle — chatty and reasoning model output', () => {
  it('skips preamble lines before the actual title', () => {
    expect(cleanTitle("Sure! Here's a concise title:\nLattice Performance Tuning")).toBe(
      'Lattice Performance Tuning'
    )
    expect(cleanTitle('Here is a title for this conversation:\n"Merge Tooling Rewrite"')).toBe(
      'Merge Tooling Rewrite'
    )
  })

  it('strips a completed <think> block and titles from what follows', () => {
    expect(cleanTitle('<think>The user wants a title about caching.</think>\nPrompt Cache Overhaul')).toBe(
      'Prompt Cache Overhaul'
    )
  })

  it('returns null for an unterminated <think> block (no title was produced)', () => {
    expect(cleanTitle('<think>Let me consider what this conversation is about. The user')).toBeNull()
  })

  it('keeps only what follows a stray closing think tag', () => {
    expect(cleanTitle('leaked reasoning here</think>\nShell Startup Latency')).toBe('Shell Startup Latency')
  })

  it('returns null when only preamble lines exist', () => {
    expect(cleanTitle("Sure! Here's a title:")).toBeNull()
  })
})
