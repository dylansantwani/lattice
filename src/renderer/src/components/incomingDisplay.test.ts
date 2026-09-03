import { describe, expect, it } from 'vitest'
import { incomingDisplayText } from './incomingDisplay'

describe('incomingDisplayText', () => {
  it('drops the model-facing lead-in of a successful subagent completion', () => {
    const text =
      '🤖 Background agent "Lattice Config Survey" finished. Its result is below — fold it into what you are doing, or, if you were waiting on it to answer the user, do so now.\n\n# Report\n\nbody'
    expect(incomingDisplayText(text)).toBe('# Report\n\nbody')
  })

  it('drops the lead-in for an unnamed agent too', () => {
    expect(incomingDisplayText('🤖 Background agent (id 01J) finished. Its result is below — x.\n\nresult')).toBe('result')
  })

  it('keeps a failure lead-in: the reason is the content', () => {
    const text = '🤖 Background agent "Scout" failed: provider timed out'
    expect(incomingDisplayText(text)).toBe(text)
  })

  it('drops the sender + reply-hint sentence of an inter-session message', () => {
    expect(
      incomingDisplayText('📨 Message from session "Ops" (id thr_1). To reply, use send_message with to:"thr_1".\n\nping')
    ).toBe('ping')
    expect(
      incomingDisplayText(
        '📨 Message from subagent "Scout" (working under session id thr_9). To reply, use send_message with to:"ag_1".\n\nfound it'
      )
    ).toBe('found it')
  })

  it('keeps shell completions intact: the exit status and command are information', () => {
    const text = '⏳ Background job j1 has failed (exit 2) — `make`. Its full output is below\n\nerr'
    expect(incomingDisplayText(text)).toBe(text)
  })

  it('never blanks a card whose only content is the lead-in', () => {
    const text = '🤖 Background agent "Empty" finished. Its result is below — x.\n\n   '
    expect(incomingDisplayText(text)).toBe(text)
  })

  it('leaves ordinary text alone', () => {
    expect(incomingDisplayText('hello\n\nworld')).toBe('hello\n\nworld')
  })
})

import { incomingCollapsedByDefault, incomingPreview, incomingSizeHint } from './incomingDisplay'

describe('incomingCollapsedByDefault', () => {
  it('keeps a short note open', () => {
    expect(incomingCollapsedByDefault('ping — are you done?')).toBe(false)
    expect(incomingCollapsedByDefault('one\ntwo\nthree\nfour')).toBe(false)
  })
  it('folds a long report by length', () => {
    expect(incomingCollapsedByDefault('x'.repeat(321))).toBe(true)
  })
  it('folds a many-line result even when each line is short', () => {
    expect(incomingCollapsedByDefault('a\nb\nc\nd\ne')).toBe(true)
  })
  it('ignores blank lines when counting', () => {
    expect(incomingCollapsedByDefault('a\n\n\nb\n\n\nc\n\n')).toBe(false)
  })
})

describe('incomingPreview', () => {
  it('uses the first non-empty line and strips heading marks and emphasis', () => {
    expect(incomingPreview('\n\n# Lattice **Provider** _Architecture_ Report\n\nbody')).toBe(
      'Lattice Provider Architecture Report'
    )
  })
  it('strips list bullets, code ticks and link syntax', () => {
    expect(incomingPreview('- see `foo.ts` and [the docs](http://x)')).toBe('see foo.ts and the docs')
  })
  it('skips rules, fences and table rows', () => {
    expect(incomingPreview('---\n```ts\n| a | b |\nreal line')).toBe('real line')
  })
  it('clips on a word boundary with an ellipsis', () => {
    const p = incomingPreview('alpha beta gamma delta epsilon zeta eta theta', 20)
    expect(p).toBe('alpha beta gamma…')
    expect(p.length).toBeLessThanOrEqual(21)
  })
  it('returns an empty string for blank text', () => {
    expect(incomingPreview('  \n\n ')).toBe('')
  })
})

describe('incomingSizeHint', () => {
  it('counts non-blank lines with correct pluralisation', () => {
    expect(incomingSizeHint('only')).toBe('1 line')
    expect(incomingSizeHint('a\n\nb\nc\n')).toBe('3 lines')
  })
})

describe('incomingDisplayText — model instructions inside an informative lead-in', () => {
  it('keeps a job completion\'s status but drops the "fold it in" sentence', () => {
    const text =
      '⏳ Background job job_1 has failed (exit 2) — "Run the sweep" (`python sweep.py`). Its full output is below; fold it into what you are doing, or, if you were waiting on it to answer the user, do so now.\n\nTraceback…'
    expect(incomingDisplayText(text)).toBe('⏳ Background job job_1 has failed (exit 2) — "Run the sweep" (`python sweep.py`).\n\nTraceback…')
  })
  it('keeps a failed-agent lead-in intact (it carries the reason)', () => {
    const text = '🤖 Background agent "X" failed: boom'
    expect(incomingDisplayText(text)).toBe(text)
  })
})
