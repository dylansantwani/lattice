import { describe, expect, it } from 'vitest'
import { clipHeadTail, shapeMcpResult } from './resultShape'

/** A real latchkey batch payload shape: one text block holding pretty-printed JSON. */
function latchkeyBatch(): { content: { type: 'text'; text: string }[] } {
  const payload = {
    ok: true,
    ran: 2,
    failed: 0,
    results: [
      { tool: 'latchkey_open', ok: true, result: { url: 'https://example.com/', title: 'Example Domain', verdict: 'logged-out', text_chars: 1256 } },
      { tool: 'latchkey_snapshot', ok: true, result: { text: '- heading "Example Domain" [ref=e1]\n- link "More information..." [ref=e2]' } }
    ]
  }
  return { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] }
}

/** The tool message body as runManager's appendToolResults builds it: the call outcome, JSON-stringified. */
function wireContent(result: unknown): string {
  return JSON.stringify({ ok: true, result })
}

describe('shapeMcpResult', () => {
  it('parses a JSON text block into data so it serializes once, compactly', () => {
    const raw = latchkeyBatch()
    const shaped = shapeMcpResult(raw, 48_000)
    expect(shaped.text).toBeUndefined()
    expect((shaped.data as { ran: number }).ran).toBe(2)

    const before = wireContent(raw) // what the manager used to return: the raw MCP result
    const after = wireContent(shaped)
    expect(after.length).toBeLessThan(raw.content[0]!.text.length) // smaller than even the raw text
    expect(after.length).toBeLessThan(before.length * 0.75)
    expect(after).not.toContain('\\"ok\\"') // no escaped JSON document inside the JSON wire
    expect(before).toContain('\\"ok\\"') // (which is exactly what the raw result sent)
  })

  it('keeps plain text as text', () => {
    expect(shapeMcpResult({ content: [{ type: 'text', text: 'Saved 3 files.' }] }, 1000)).toEqual({ text: 'Saved 3 files.' })
  })

  it('joins multiple text blocks and passes images through for vision extraction', () => {
    const img = { type: 'image', data: 'iVBORw0KGgo=', mimeType: 'image/png' }
    const shaped = shapeMcpResult({ content: [{ type: 'text', text: 'a' }, img, { type: 'text', text: 'b' }] }, 1000)
    expect(shaped.text).toBe('a\nb')
    expect(shaped.content).toEqual([img])
  })

  it('prefers structuredContent over its mirrored text', () => {
    expect(shapeMcpResult({ content: [{ type: 'text', text: '{"n":1}' }], structuredContent: { n: 1 } }, 1000)).toEqual({ data: { n: 1 } })
  })

  it('reports tool errors with the tool message', () => {
    const shaped = shapeMcpResult({ isError: true, content: [{ type: 'text', text: 'mode must be one of interactive, full, text' }] }, 1000)
    expect(shaped.isError).toBe(true)
    expect(shaped.error).toBe('mode must be one of interactive, full, text')
  })

  it('clips oversized payloads head+tail with an actionable marker', () => {
    const big = 'H'.repeat(30_000) + 'T'.repeat(30_000)
    const shaped = shapeMcpResult({ content: [{ type: 'text', text: big }] }, 10_000)
    expect(shaped.text!.length).toBeLessThanOrEqual(10_000)
    expect(shaped.text!.startsWith('HHHH')).toBe(true)
    expect(shaped.text!.endsWith('TTTT')).toBe(true)
    expect(shaped.text).toContain('chars omitted')
    expect(shaped.truncated).toEqual({ originalChars: 60_000, keptChars: shaped.text!.length })
  })

  it('clips oversized JSON as text rather than dropping it', () => {
    const rows = Array.from({ length: 2000 }, (_, i) => ({ name: `cookie-${i}`, domain: '.example.com', value: 'x'.repeat(20) }))
    const shaped = shapeMcpResult({ content: [{ type: 'text', text: JSON.stringify(rows) }] }, 8_000)
    expect(shaped.data).toBeUndefined()
    expect(shaped.text!.length).toBeLessThanOrEqual(8_000)
    expect(shaped.truncated!.originalChars).toBeGreaterThan(8_000)
  })

  it('handles non-object results defensively', () => {
    expect(shapeMcpResult('plain', 100)).toEqual({ text: 'plain' })
    expect(shapeMcpResult(undefined, 100)).toEqual({ text: '' })
  })
})

describe('clipHeadTail', () => {
  it('is a no-op under the cap', () => {
    expect(clipHeadTail('short', 100)).toEqual({ text: 'short', clipped: false })
  })
})
