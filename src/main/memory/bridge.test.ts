import { describe, expect, it } from 'vitest'
import { parseFrontmatterFile, splitHermesFacts, claudeProjectSlug, importStoreOf } from './bridge'

describe('parseFrontmatterFile', () => {
  it('extracts the metadata type and the body after the frontmatter', () => {
    const text = [
      '---',
      'name: amazon-gold',
      'description: "where the research lives"',
      'metadata:',
      '  node_type: memory',
      '  type: reference',
      '---',
      '',
      'The actual fact goes here.',
      'Second line.'
    ].join('\n')
    const { type, body } = parseFrontmatterFile(text)
    expect(type).toBe('reference')
    expect(body).toBe('The actual fact goes here.\nSecond line.')
  })

  it('treats a file with no frontmatter as all body', () => {
    const { type, body } = parseFrontmatterFile('just a plain note')
    expect(type).toBeUndefined()
    expect(body).toBe('just a plain note')
  })
})

describe('splitHermesFacts', () => {
  it('splits on § separator lines and trims, dropping empties', () => {
    const text = 'first fact\n§\nsecond fact\n§\n\n§\n  third  \n'
    expect(splitHermesFacts(text)).toEqual(['first fact', 'second fact', 'third'])
  })

  it('returns a single fact when there is no separator', () => {
    expect(splitHermesFacts('lonely fact')).toEqual(['lonely fact'])
  })
})

describe('claudeProjectSlug', () => {
  it('encodes an absolute path the way Claude Code names its project dir', () => {
    expect(claudeProjectSlug('/Users/dylan/lattice')).toBe('-Users-dylan-lattice')
  })
})

describe('importStoreOf', () => {
  it('identifies the source store from the id prefix', () => {
    expect(importStoreOf('mem:cc:global')).toBe('claude-code')
    expect(importStoreOf('mem:cc:file:foo')).toBe('claude-code')
    expect(importStoreOf('mem:hermes:user:abc123')).toBe('hermes')
    expect(importStoreOf('some-ulid')).toBeNull()
  })
})
