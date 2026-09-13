import { describe, expect, it } from 'vitest'
import { renderMarkdown } from './markdown'

describe('terminal markdown renderer', () => {
  it('styles headings, emphasis, and inline code while preserving plain output mode', () => {
    expect(renderMarkdown('# Title\n**bold** and `code`', { color: false })).toBe('Title\nbold and code')
    expect(renderMarkdown('# Title')).toContain('\u001b[1mTitle')
  })
})
