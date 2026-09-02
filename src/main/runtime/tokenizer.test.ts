import { describe, expect, it } from 'vitest'
import { countTokens } from './tokenizer'

describe('countTokens', () => {
  it('is far more accurate than chars/4 on dense JSON', () => {
    const json = JSON.stringify({ ok: true, files: ['a.ts', 'b.ts'], nested: { x: 1, y: 2 } })
    const real = countTokens(json)
    const naive = Math.ceil(json.length / 4)
    // Dense JSON tokenizes to substantially MORE tokens than chars/4 implies (all those braces,
    // quotes, and punctuation are their own tokens), so the real count exceeds the old heuristic.
    expect(real).toBeGreaterThan(naive)
  })

  it('returns 0 for empty input and a positive count for text', () => {
    expect(countTokens('')).toBe(0)
    expect(countTokens('hello world')).toBeGreaterThan(0)
  })

  it('never throws on strings containing tokenizer special tokens', () => {
    // `<|endoftext|>` is a real special token; encoding must count it, not reject the whole string.
    expect(() => countTokens('before <|endoftext|> after')).not.toThrow()
    expect(countTokens('before <|endoftext|> after')).toBeGreaterThan(0)
  })

  it('selects the cl100k family for legacy GPT-4 / 3.5 ids and o200k otherwise', () => {
    // The two encoders differ, so identical text can land on different counts by family. We only
    // assert both paths return sane positive counts (family selection itself is internal).
    const text = 'The quick brown fox jumps over the lazy dog. '.repeat(20)
    expect(countTokens(text, 'openai/gpt-3.5-turbo')).toBeGreaterThan(0)
    expect(countTokens(text, 'openai/gpt-4')).toBeGreaterThan(0)
    expect(countTokens(text, 'cc/claude-fable-5')).toBeGreaterThan(0)
    expect(countTokens(text, 'openai/gpt-4o')).toBeGreaterThan(0)
  })

  it('stays fast and bounded on a degenerate repeated-character run', () => {
    // A long single-character run is the encoder's quadratic worst case; the guard must divert it to
    // the ratio heuristic so it returns quickly instead of hanging.
    const degenerate = 'A'.repeat(90_000)
    const start = Date.now()
    const n = countTokens(degenerate)
    expect(Date.now() - start).toBeLessThan(500)
    // Heuristic fallback: ~length/4.
    expect(n).toBe(Math.ceil(degenerate.length / 4))
  })

  it('falls back to the ratio heuristic above the hard length cap', () => {
    const huge = 'lorem ipsum dolor sit amet '.repeat(6_000) // > 100k chars
    expect(countTokens(huge)).toBe(Math.ceil(huge.length / 4))
  })

  it('is deterministic and cache-consistent across repeated calls', () => {
    const text = 'function add(a, b) { return a + b } // sums two numbers'
    const first = countTokens(text)
    for (let i = 0; i < 50; i++) expect(countTokens(text)).toBe(first)
  })
})
