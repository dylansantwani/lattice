import { describe, expect, it } from 'vitest'
import { appendToolResults, extractToolResultImages } from './runManager'
import type { WireMessage } from '../providers/openaiCompat'

const PLACEHOLDER = '[image content extracted — shown in the following message]'

describe('extractToolResultImages', () => {
  it('pulls an MCP image content block into an image_url part and leaves a placeholder', () => {
    // Shape returned by a screenshot MCP tool, wrapped by executeToolCall's { ok, result }.
    const result = {
      ok: true,
      result: {
        content: [
          { type: 'text', text: 'Captured the page.' },
          { type: 'image', data: 'iVBORw0KGgoAAAANS', mimeType: 'image/png' }
        ]
      }
    }
    const { sanitized, images } = extractToolResultImages(result)

    expect(images).toEqual([
      { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANS' } }
    ])
    // The base64 blob must be gone from the text the model reads as the tool message.
    const serialized = JSON.stringify(sanitized)
    expect(serialized).not.toContain('iVBORw0KGgoAAAANS')
    expect(serialized).toContain('Captured the page.')
    expect(serialized).toContain(PLACEHOLDER)
  })

  it('defaults a missing mimeType to image/png', () => {
    const { images } = extractToolResultImages({ content: [{ type: 'image', data: 'AAAA' }] })
    expect(images[0]?.image_url?.url).toBe('data:image/png;base64,AAAA')
  })

  it('preserves an existing data: URL rather than double-wrapping it', () => {
    const url = 'data:image/jpeg;base64,/9j/4AAQSkZJRg'
    const { images } = extractToolResultImages({ content: [{ type: 'image', data: url }] })
    expect(images[0]?.image_url?.url).toBe(url)
  })

  it('extracts an image-bearing embedded resource blob', () => {
    const result = {
      content: [
        { type: 'resource', resource: { uri: 'ui://shot.png', mimeType: 'image/png', blob: 'BLOBDATA' } }
      ]
    }
    const { sanitized, images } = extractToolResultImages(result)
    expect(images[0]?.image_url?.url).toBe('data:image/png;base64,BLOBDATA')
    expect(JSON.stringify(sanitized)).not.toContain('BLOBDATA')
  })

  it('catches a raw data:image URL string anywhere in the result', () => {
    const url = 'data:image/webp;base64,UklGRh'
    const { sanitized, images } = extractToolResultImages({ ok: true, result: { screenshot: url } })
    expect(images).toEqual([{ type: 'image_url', image_url: { url } }])
    expect(JSON.stringify(sanitized)).not.toContain('UklGRh')
  })

  it('collects multiple images in document order', () => {
    const { images } = extractToolResultImages({
      content: [
        { type: 'image', data: 'ONE', mimeType: 'image/png' },
        { type: 'text', text: 'and' },
        { type: 'image', data: 'TWO', mimeType: 'image/gif' }
      ]
    })
    expect(images.map((i) => i.image_url?.url)).toEqual([
      'data:image/png;base64,ONE',
      'data:image/gif;base64,TWO'
    ])
  })

  it('ignores a non-image resource blob (leaves it untouched, yields no images)', () => {
    const result = { content: [{ type: 'resource', resource: { uri: 'f.pdf', mimeType: 'application/pdf', blob: 'PDF' } }] }
    const { sanitized, images } = extractToolResultImages(result)
    expect(images).toEqual([])
    expect(sanitized).toEqual(result)
  })

  it('returns a non-image result structurally unchanged with no images', () => {
    const result = { ok: true, result: { entries: [{ name: 'a.ts', size: 10 }], count: 1 } }
    const { sanitized, images } = extractToolResultImages(result)
    expect(images).toEqual([])
    expect(sanitized).toEqual(result)
    // Byte-identical serialization: non-image tools must be unaffected.
    expect(JSON.stringify(sanitized)).toBe(JSON.stringify(result))
  })

  it('does not treat a non-image data: URL as an image', () => {
    const result = { data: 'data:text/plain;base64,aGk=' }
    const { sanitized, images } = extractToolResultImages(result)
    expect(images).toEqual([])
    expect(sanitized).toEqual(result)
  })
})

describe('appendToolResults', () => {
  const call = (id: string, name: string): { id: string; function: { name: string } } => ({
    id,
    function: { name }
  })

  it('pairs each result with a tool message and re-attaches images as a following user message', () => {
    const wire: WireMessage[] = []
    appendToolResults(
      wire,
      [call('c1', 'browser__screenshot')],
      [{ ok: true, result: { content: [{ type: 'image', data: 'SHOT', mimeType: 'image/png' }] } }]
    )

    expect(wire).toHaveLength(2)
    const tool = wire[0]!
    expect(tool.role).toBe('tool')
    expect(tool.tool_call_id).toBe('c1')
    expect(typeof tool.content === 'string' && tool.content).not.toContain('SHOT')

    const injected = wire[1]!
    expect(injected.role).toBe('user')
    expect(Array.isArray(injected.content)).toBe(true)
    const parts = injected.content as { type: string; image_url?: { url: string } }[]
    expect(parts[0]).toMatchObject({ type: 'text' })
    expect(parts[1]).toEqual({ type: 'image_url', image_url: { url: 'data:image/png;base64,SHOT' } })
  })

  it('keeps tool_call_id pairing intact and injects no user message when no tool returned an image', () => {
    const wire: WireMessage[] = []
    appendToolResults(
      wire,
      [call('a', 'fs_read'), call('b', 'grep_search')],
      [{ ok: true, result: { text: 'hello' } }, { ok: true, result: { matches: [] } }]
    )
    // Exactly the two tool messages — nothing appended.
    expect(wire.map((m) => m.role)).toEqual(['tool', 'tool'])
    expect(wire.map((m) => m.tool_call_id)).toEqual(['a', 'b'])
  })

  it('gathers images across a parallel batch into a single trailing user message', () => {
    const wire: WireMessage[] = []
    appendToolResults(
      wire,
      [call('a', 'shot1'), call('b', 'noimg'), call('c', 'shot2')],
      [
        { content: [{ type: 'image', data: 'A', mimeType: 'image/png' }] },
        { ok: true, result: 'text only' },
        { content: [{ type: 'image', data: 'B', mimeType: 'image/jpeg' }] }
      ]
    )
    // Three tool messages, then one user message carrying both images in order.
    expect(wire.map((m) => m.role)).toEqual(['tool', 'tool', 'tool', 'user'])
    const parts = wire[3]!.content as { type: string; image_url?: { url: string } }[]
    expect(parts.filter((p) => p.type === 'image_url').map((p) => p.image_url?.url)).toEqual([
      'data:image/png;base64,A',
      'data:image/jpeg;base64,B'
    ])
  })
})
