import { describe, expect, it } from 'vitest'
import { normalizeToolOutcome } from './toolOutcome'

describe('tool outcome normalization', () => {
  it('turns MCP isError into failure while preserving fields', () => {
    const value = { isError: true, content: [{ type: 'text', text: 'bad' }] }
    expect(normalizeToolOutcome(value)).toMatchObject({ ok: false, status: 'error', content: value.content, result: value })
  })
  it('keeps no-match and partial states distinct from failures', () => {
    expect(normalizeToolOutcome({ noMatch: true })).toMatchObject({ ok: true, status: 'no_match' })
    expect(normalizeToolOutcome({ partial: true })).toMatchObject({ ok: true, status: 'partial' })
  })
})
