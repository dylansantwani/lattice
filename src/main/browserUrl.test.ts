import { describe, expect, it, vi } from 'vitest'

// browserView imports `electron` at module load; stub it so the pure helper can be imported in node.
vi.mock('electron', () => ({ WebContentsView: class {}, BrowserWindow: { getAllWindows: () => [] } }))

import { normalizeUrl } from './browserView'

describe('normalizeUrl', () => {
  it('passes through explicit http(s) URLs', () => {
    expect(normalizeUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(normalizeUrl('http://localhost:3000')).toBe('http://localhost:3000')
  })

  it('adds https:// to a bare host', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com')
    expect(normalizeUrl('example.com/docs')).toBe('https://example.com/docs')
  })

  it('treats free text (or spaces) as a search query', () => {
    expect(normalizeUrl('how to center a div')).toBe(
      'https://duckduckgo.com/?q=how%20to%20center%20a%20div'
    )
    expect(normalizeUrl('electron webcontentsview')).toMatch(/^https:\/\/duckduckgo\.com\/\?q=/)
  })

  it('returns null for empty input', () => {
    expect(normalizeUrl('')).toBeNull()
    expect(normalizeUrl('   ')).toBeNull()
  })

  it('allows about:blank', () => {
    expect(normalizeUrl('about:blank')).toBe('about:blank')
  })
})
