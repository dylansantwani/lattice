import { describe, expect, it } from 'vitest'
import { countTokens } from './tokenizer'

// The memo behind countTokens keys short strings by content and long strings by hash (so caching a
// large tool result costs bytes of key, not the whole string). These tests pin the properties that
// matter: repeated counts are identical (cache correctness), distinct content is distinguished
// (no false hits), and the guards for degenerate input still apply.

const prose = (seed: string, chars: number): string => {
  let out = ''
  let i = 0
  while (out.length < chars) out += `${seed} word${i++} lorem ipsum dolor sit amet `
  return out.slice(0, chars)
}

describe('countTokens memoization', () => {
  it('returns identical counts on repeated calls for short strings', () => {
    const s = 'const x = 42 // a short line of code'
    const first = countTokens(s)
    expect(countTokens(s)).toBe(first)
    expect(first).toBeGreaterThan(0)
  })

  it('returns identical counts on repeated calls for long (hash-keyed) strings', () => {
    const s = prose('alpha', 30_000) // above the hash-key threshold, below the encode cap
    const first = countTokens(s)
    expect(countTokens(s)).toBe(first)
    expect(countTokens(s)).toBe(first)
    expect(first).toBeGreaterThan(1000)
  })

  it('distinguishes two long strings of identical length but different content', () => {
    // Same length forces the hash portion of the key to do the discriminating.
    const a = prose('alpha', 10_000)
    const b = prose('bravo', 10_000)
    expect(a.length).toBe(b.length)
    expect(countTokens(a)).not.toBe(countTokens(b))
  })

  it('keeps counts separate per tokenizer family', () => {
    // Mixed-script content, where o200k and cl100k genuinely disagree (plain ASCII prose often
    // counts identically in both, which would make this test vacuous).
    const s = 'const αβγ = «tokenizer» → 你好世界 🦙🚀; '.repeat(100)
    const modern = countTokens(s) // o200k default
    const legacy = countTokens(s, 'gpt-4-turbo') // cl100k family
    // Different vocabularies virtually never agree on a 5k-char text; equality would suggest the
    // cache served one family's count for the other.
    expect(modern).not.toBe(legacy)
    // And repeated per-family calls are stable.
    expect(countTokens(s)).toBe(modern)
    expect(countTokens(s, 'gpt-4-turbo')).toBe(legacy)
  })

  it('still routes oversized and degenerate inputs to the ratio heuristic', () => {
    const huge = prose('delta', 100_001)
    expect(countTokens(huge)).toBe(Math.ceil(huge.length / 4))
    const pathological = 'x'.repeat(10_000)
    expect(countTokens(pathological)).toBe(Math.ceil(pathological.length / 4))
  })

  it('counts the empty string as zero', () => {
    expect(countTokens('')).toBe(0)
  })
})
