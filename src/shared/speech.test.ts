import { describe, expect, it } from 'vitest'
import { DEFAULT_SPEECH_SETTINGS, resolveSpeechSettings, speechTextFromMarkdown, splitForSpeech } from './speech'

describe('speechTextFromMarkdown', () => {
  it('reads prose and drops markdown syntax', () => {
    const text = speechTextFromMarkdown('## Result\n**Done**: the build is _green_ and `pnpm test` passes.\n- first item\n1. numbered\n> quoted')
    expect(text).toBe('Result\nDone: the build is green and pnpm test passes.\nfirst item\nnumbered\nquoted')
  })

  it('announces a skipped code block once instead of reading it', () => {
    expect(speechTextFromMarkdown('Run this:\n\n```bash\nrm -rf node_modules\npnpm install\n```\n\nThen retry.')).toBe('Run this:\n\n(code block)\n\nThen retry.')
  })

  it('can read code when asked', () => {
    expect(speechTextFromMarkdown('```\nconst a = 1\n```', { skipCode: false })).toBe('const a = 1')
  })

  it('reads link labels and shortens bare URLs to their host', () => {
    expect(speechTextFromMarkdown('See [the docs](https://x.dev/a) or https://www.github.com/org/repo/pull/12?tab=files.')).toBe('See the docs or github.com.')
  })

  it('drops tables and horizontal rules', () => {
    expect(speechTextFromMarkdown('Summary below.\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n---\n\nEnd.')).toBe('Summary below.\n\nEnd.')
  })

  it('keeps snake_case identifiers and arithmetic intact', () => {
    expect(speechTextFromMarkdown('set max_output_tokens to 2*4*8')).toBe('set max_output_tokens to 2*4*8')
  })
})

describe('splitForSpeech', () => {
  it('groups sentences up to the limit and never splits a short sentence', () => {
    const chunks = splitForSpeech('One. Two is here! Three? Four ends it.', 18)
    expect(chunks).toEqual(['One. Two is here!', 'Three?', 'Four ends it.'])
  })

  it('starts a new chunk at each paragraph', () => {
    expect(splitForSpeech('First paragraph.\n\nSecond paragraph.', 500)).toEqual(['First paragraph.', 'Second paragraph.'])
  })

  it('breaks a run-on sentence at commas or words, within the limit', () => {
    const long = Array.from({ length: 40 }, (_, i) => `clause number ${i}`).join(', ')
    const chunks = splitForSpeech(long, 100)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(100)
    expect(chunks.join(' ').replace(/\s+/g, ' ')).toBe(long)
  })

  it('returns nothing for blank text', () => {
    expect(splitForSpeech('  \n\n ')).toEqual([])
  })
})

describe('resolveSpeechSettings', () => {
  it('fills defaults and clamps the rate', () => {
    expect(resolveSpeechSettings(undefined)).toEqual(DEFAULT_SPEECH_SETTINGS)
    expect(resolveSpeechSettings({ rate: 9, engine: 'openai' })).toMatchObject({ rate: 2, engine: 'openai', voice: 'af_heart' })
    expect(resolveSpeechSettings({ rate: Number.NaN }).rate).toBe(1)
  })
})
