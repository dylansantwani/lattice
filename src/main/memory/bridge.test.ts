import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryItem } from '@shared/types'
import {
  parseFrontmatterFile,
  splitHermesFacts,
  claudeProjectSlug,
  importStoreOf,
  collectClaudeCode,
  collectHermes,
  exportToHermes,
  exportToClaudeCode
} from './bridge'

const mem = (id: string, content: string, type: MemoryItem['type'] = 'note'): MemoryItem =>
  ({ id, content, type, scope: 'user', author: 'user', status: 'approved' }) as MemoryItem

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

describe('external collection', () => {
  let home: string
  const realHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lattice-mem-import-'))
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = realHome
  })

  it('collects global and workspace-scoped Claude Code memory without re-importing Lattice files', () => {
    const root = join(home, 'project')
    const dir = join(home, '.claude', 'projects', claudeProjectSlug(root), 'memory')
    mkdirSync(dir, { recursive: true })
    mkdirSync(root, { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'global preference')
    writeFileSync(join(root, 'CLAUDE.md'), 'project preference')
    writeFileSync(join(dir, 'real-fact.md'), '---\nmetadata:\n  type: user\n---\nremember this')
    writeFileSync(join(dir, 'lattice-own.md'), 'do not loop this back')

    const drafts = collectClaudeCode(root, 'workspace-1')
    expect(drafts.map((d) => d.id)).toEqual([
      'mem:cc:global',
      'mem:cc:project-md:workspace-1',
      'mem:cc:file:workspace-1:real-fact'
    ])
    expect(drafts.at(-1)?.type).toBe('fact')
  })

  it('collects both Hermes stores and ignores Lattice sentinel entries', () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'environment fact\n§\n⟦lattice⟧ already exported')
    writeFileSync(join(dir, 'USER.md'), 'user preference')

    const drafts = collectHermes()
    expect(drafts.map((d) => d.content)).toEqual(['user preference', 'environment fact'])
  })
})

describe('write-back (export)', () => {
  let home: string
  const realHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lattice-mem-'))
    process.env.HOME = home // Node's os.homedir() honors $HOME on POSIX
  })
  afterEach(() => {
    process.env.HOME = realHome
  })

  it('appends Lattice facts to Hermes MEMORY.md without touching the user’s facts', () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'user fact one\n§\nuser fact two\n')

    const wrote = exportToHermes([mem('x1', 'lattice fact A'), mem('x2', 'lattice fact B')])
    expect(wrote).toBe(2)

    const facts = splitHermesFacts(readFileSync(join(dir, 'MEMORY.md'), 'utf8'))
    // user's facts preserved verbatim, ours appended and tagged
    expect(facts.filter((f) => !f.startsWith('⟦lattice⟧'))).toEqual(['user fact one', 'user fact two'])
    expect(facts.filter((f) => f.startsWith('⟦lattice⟧'))).toHaveLength(2)
  })

  it('does not create or rewrite Hermes if there is nothing of ours', () => {
    // no ~/.hermes at all → no-op
    expect(exportToHermes([])).toBe(0)
    expect(existsSync(join(home, '.hermes'))).toBe(false)
  })

  it('re-export replaces our old Lattice entries instead of duplicating them', () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'keeper\n')
    exportToHermes([mem('x1', 'first')])
    exportToHermes([mem('x1', 'second')]) // same id, new content
    const facts = splitHermesFacts(readFileSync(join(dir, 'MEMORY.md'), 'utf8'))
    expect(facts.filter((f) => f.startsWith('⟦lattice⟧'))).toEqual(['⟦lattice⟧ second'])
    expect(facts).toContain('keeper')
  })

  it('writes a Claude Code memory file with frontmatter and a MEMORY.md index block', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const root = '/Users/dylan/lattice'
    const wrote = exportToClaudeCode(root, [mem('note1', 'a shared decision', 'decision')])
    expect(wrote).toBe(1)

    const memDir = join(home, '.claude', 'projects', '-Users-dylan-lattice', 'memory')
    const files = readdirSync(memDir).filter((f) => f.startsWith('lattice-'))
    expect(files).toHaveLength(1)
    const body = readFileSync(join(memDir, files[0]!), 'utf8')
    expect(body).toContain('type: project') // decision → CC "project"
    expect(body).toContain('source: lattice')
    expect(body).toContain('a shared decision')

    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf8')
    expect(index).toContain('lattice:begin')
    expect(index).toContain(files[0]!)
  })

  it('skips Claude Code entirely when there are no items and no prior write-back', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    expect(exportToClaudeCode('/Users/dylan/lattice', [])).toBe(0)
    expect(existsSync(join(home, '.claude', 'projects'))).toBe(false)
  })
})
