import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, statSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { MemoryItem, WorkspaceMeta } from '@shared/types'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-bridge-store-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import {
  parseFrontmatterFile,
  splitHermesFacts,
  claudeProjectSlug,
  importStoreOf,
  collectClaudeCode,
  collectHermes,
  exportToHermes,
  exportToClaudeCode,
  chunkMarkdown,
  isExportable,
  exportHash,
  EXPORT_MAX_ITEMS,
  exportPriority,
  EXPORT_DEBOUNCE_MS,
  syncExternalMemory,
  exportMemory,
  exportableMemories,
  runMemorySync,
  scheduleMemoryExport,
  resetBridgeCaches
} from './bridge'
import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

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

  it('appends Lattice facts to Hermes MEMORY.md without touching the user’s facts', async () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'user fact one\n§\nuser fact two\n')

    const wrote = await exportToHermes([mem('x1', 'lattice fact A'), mem('x2', 'lattice fact B')])
    expect(wrote).toBe(2)

    const facts = splitHermesFacts(readFileSync(join(dir, 'MEMORY.md'), 'utf8'))
    // user's facts preserved verbatim, ours appended and tagged
    expect(facts.filter((f) => !f.startsWith('⟦lattice⟧'))).toEqual(['user fact one', 'user fact two'])
    expect(facts.filter((f) => f.startsWith('⟦lattice⟧'))).toHaveLength(2)
  })

  it('does not create or rewrite Hermes if there is nothing of ours', async () => {
    // no ~/.hermes at all → no-op
    expect(await exportToHermes([])).toBe(0)
    expect(existsSync(join(home, '.hermes'))).toBe(false)
  })

  it('re-export replaces our old Lattice entries instead of duplicating them', async () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'keeper\n')
    await exportToHermes([mem('x1', 'first')])
    await exportToHermes([mem('x1', 'second')]) // same id, new content
    const facts = splitHermesFacts(readFileSync(join(dir, 'MEMORY.md'), 'utf8'))
    expect(facts.filter((f) => f.startsWith('⟦lattice⟧'))).toEqual(['⟦lattice⟧ second'])
    expect(facts).toContain('keeper')
  })

  it('leaves Hermes MEMORY.md untouched (same mtime) when our block is unchanged', async () => {
    const dir = join(home, '.hermes', 'memories')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'MEMORY.md'), 'keeper\n')
    await exportToHermes([mem('x1', 'first')])
    const path = join(dir, 'MEMORY.md')
    const old = new Date(Date.now() - 60_000)
    utimesSync(path, old, old)
    await exportToHermes([mem('x1', 'first')])
    expect(Math.round(statSync(path).mtimeMs)).toBe(old.getTime())
  })

  it('writes a Claude Code memory file with frontmatter and a MEMORY.md index block', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const root = '/Users/dylan/lattice'
    const wrote = await exportToClaudeCode(root, [mem('note1', 'a shared decision', 'decision')])
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

  it('writes only changed files and removes files for memories that stopped exporting', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const root = '/Users/dylan/lattice'
    await exportToClaudeCode(root, [mem('keep', 'stays the same'), mem('gone', 'will be removed')])
    const memDir = join(home, '.claude', 'projects', '-Users-dylan-lattice', 'memory')
    const keepPath = join(memDir, 'lattice-keep.md')
    const old = new Date(Date.now() - 60_000)
    utimesSync(keepPath, old, old)

    await exportToClaudeCode(root, [mem('keep', 'stays the same'), mem('new', 'a new one')])
    expect(Math.round(statSync(keepPath).mtimeMs)).toBe(old.getTime()) // untouched: content identical
    expect(existsSync(join(memDir, 'lattice-gone.md'))).toBe(false)
    expect(existsSync(join(memDir, 'lattice-new.md'))).toBe(true)
    const index = readFileSync(join(memDir, 'MEMORY.md'), 'utf8')
    expect(index).toContain('lattice-new.md')
    expect(index).not.toContain('lattice-gone.md')
  })

  it('skips Claude Code entirely when there are no items and no prior write-back', async () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    expect(await exportToClaudeCode('/Users/dylan/lattice', [])).toBe(0)
    expect(existsSync(join(home, '.claude', 'projects'))).toBe(false)
  })
})

describe('chunkMarkdown — imported documents become recallable pieces', () => {
  it('keeps a short document as one chunk', () => {
    expect(chunkMarkdown('Just one short paragraph.')).toEqual([{ heading: undefined, text: 'Just one short paragraph.' }])
  })

  it('opens a chunk at each heading, appends paragraphs up to max, and folds runts into the previous chunk', () => {
    const para = 'Sentence about something. '.repeat(12).trim() // ~300 chars
    const doc = ['# Alpha', para, para, '# Beta', para, 'tiny note', '## Gamma', para].join('\n\n')
    const chunks = chunkMarkdown(doc, { min: 240, max: 700 })
    expect(chunks.map((c) => c.heading)).toEqual(['Alpha', 'Beta', 'Gamma'])
    expect(chunks[0]!.text.startsWith('# Alpha')).toBe(true)
    expect(chunks[1]!.text).toContain('tiny note') // runt folded into Beta
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(700 * 1.25)
  })

  it('cuts a single oversized paragraph at sentence boundaries', () => {
    const doc = 'A sentence here. '.repeat(200).trim()
    const chunks = chunkMarkdown(doc, { min: 100, max: 500 })
    expect(chunks.length).toBeGreaterThan(3)
    for (const c of chunks) expect(c.text.length).toBeLessThanOrEqual(500)
    expect(chunks.map((c) => c.text).join(' ').replace(/\s+/g, ' ')).toBe(doc.replace(/\s+/g, ' '))
  })
})

describe('external collection — chunked imports', () => {
  let home: string
  const realHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lattice-mem-chunk-'))
    process.env.HOME = home
  })
  afterEach(() => {
    process.env.HOME = realHome
  })

  it('splits a long global CLAUDE.md into hash-keyed chunks and keeps the legacy id for a short one', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'be terse')
    expect(collectClaudeCode(root, 'w1').map((d) => d.id)).toEqual(['mem:cc:global'])

    const section = (n: number): string => `# Rule ${n}\n\n` + `Rule ${n} detail sentence. `.repeat(30)
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), [1, 2, 3, 4].map(section).join('\n\n'))
    const drafts = collectClaudeCode(root, 'w1')
    expect(drafts.length).toBeGreaterThanOrEqual(4)
    for (const d of drafts) {
      expect(d.id).toMatch(/^mem:cc:global:[0-9a-f]{12}$/)
      expect(d.content.length).toBeLessThan(2100)
      expect(d.content.startsWith('Claude Code global instructions (~/.claude/CLAUDE.md) › Rule')).toBe(true)
    }
    // Stable: the same file yields the same ids on a re-collect.
    expect(collectClaudeCode(root, 'w1').map((d) => d.id)).toEqual(drafts.map((d) => d.id))
  })
})

describe('isExportable — the review gate for model-authored memory', () => {
  const now = 1_000_000_000_000
  const base = (over: Partial<MemoryItem>): MemoryItem =>
    ({ ...mem('id', 'c'), author: 'model', createdAt: now, useCount: 0, ...over }) as MemoryItem

  it('exports what a human wrote, reviewed, or pinned', () => {
    expect(isExportable(base({ author: 'user' }), now)).toBe(true)
    expect(isExportable(base({ reviewedAt: now }), now)).toBe(true)
    expect(isExportable(base({ pinned: true }), now)).toBe(true)
  })
  it('holds an auto-approved learning back until recall has actually surfaced it — age alone is not evidence', () => {
    expect(isExportable(base({}), now)).toBe(false)
    expect(isExportable(base({}), now + 30 * 24 * 3600_000)).toBe(false)
    expect(isExportable(base({ useCount: 1 }), now)).toBe(true)
  })
  it('ranks by evidence so the cap keeps what people and models relied on', () => {
    const pinned = base({ pinned: true })
    const user = base({ author: 'user' })
    const reviewed = base({ reviewedAt: now })
    const used = base({ useCount: 5 })
    const usedLess = base({ useCount: 1 })
    const order = [usedLess, used, reviewed, user, pinned].sort((a, b) => exportPriority(b) - exportPriority(a))
    expect(order).toEqual([pinned, user, reviewed, used, usedLess])
    expect(EXPORT_MAX_ITEMS).toBeGreaterThan(0)
  })
  it('never exports proposals, imports, or expired items', () => {
    expect(isExportable(base({ status: 'proposed', reviewedAt: now }), now)).toBe(false)
    expect(isExportable(base({ id: 'mem:cc:global', author: 'import' }), now)).toBe(false)
    expect(isExportable(base({ author: 'user', expiresAt: now - 1 }), now)).toBe(false)
  })
  it('hashes the exportable set by id + type + content', () => {
    const a = [mem('1', 'x'), mem('2', 'y')]
    expect(exportHash(a)).toBe(exportHash([mem('1', 'x'), mem('2', 'y')]))
    expect(exportHash(a)).not.toBe(exportHash([mem('1', 'x'), mem('2', 'z')]))
  })
})

describe('sync lanes — skip caches, diff-only writes, debounce (store-backed)', () => {
  let home: string
  let ws: WorkspaceMeta
  const realHome = process.env.HOME
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'lattice-mem-sync-'))
    process.env.HOME = home
    getDb().exec('DELETE FROM memory; DELETE FROM workspaces')
    store.resetStoreMemos()
    resetBridgeCaches()
    const root = join(home, 'proj')
    mkdirSync(root, { recursive: true })
    ws = { id: 'ws-sync', name: 'sync', roots: [root], createdAt: 0 } as WorkspaceMeta
    mkdirSync(join(home, '.claude'), { recursive: true })
  })
  afterEach(() => {
    process.env.HOME = realHome
    vi.useRealTimers()
  })

  it('imports once per source fingerprint and re-imports when a file changes', () => {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'be terse')
    const first = syncExternalMemory(ws)
    expect(first.added).toBe(1)
    expect(first.skipped).toBeUndefined()
    const second = syncExternalMemory(ws)
    expect(second.skipped).toBe(true)
    expect(second.added).toBe(0)

    // A changed file (different mtime + size) invalidates the fingerprint.
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'be terse, always')
    const third = syncExternalMemory(ws)
    expect(third.skipped).toBeUndefined()
    expect(third.updated).toBe(1)
    expect(store.getMemory('mem:cc:global')?.content).toContain('be terse, always')
    // `force` bypasses the cache even with nothing changed.
    expect(syncExternalMemory(ws, { force: true }).skipped).toBeUndefined()
  })

  it('replaces a legacy whole-file import with chunks when the file grows past one chunk', () => {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'be terse')
    syncExternalMemory(ws)
    expect(store.getMemory('mem:cc:global')).not.toBeNull()
    const section = (n: number): string => `# Rule ${n}\n\n` + `Rule ${n} detail sentence. `.repeat(30)
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), [1, 2, 3].map(section).join('\n\n'))
    const r = syncExternalMemory(ws)
    expect(r.removed).toBe(1) // the blob row is pruned
    expect(store.getMemory('mem:cc:global')).toBeNull()
    expect(store.listMemory().filter((m) => m.id.startsWith('mem:cc:global:')).length).toBeGreaterThanOrEqual(3)
  })

  it('exports once per exportable-set hash and writes only what changed', async () => {
    store.upsertMemory({ id: 'u1', content: 'user fact', author: 'user', status: 'approved' })
    store.upsertMemory({ content: 'fresh auto-approved learning', author: 'model', status: 'approved' })
    const first = await exportMemory(ws)
    expect(first.find((e) => e.store === 'claude-code')?.wrote).toBe(1) // the unreviewed learning is gated
    const memDir = join(home, '.claude', 'projects', claudeProjectSlug(ws.roots[0]!), 'memory')
    expect(readdirSync(memDir).filter((f) => f.startsWith('lattice-'))).toEqual(['lattice-u1.md'])

    const second = await exportMemory(ws)
    expect(second.every((e) => e.skipped)).toBe(true)

    // A review flips the gate: the learning now exports, and the unchanged file is not rewritten.
    const learned = store.listMemory().find((m) => m.author === 'model')!
    const keepPath = join(memDir, 'lattice-u1.md')
    const old = new Date(Date.now() - 60_000)
    utimesSync(keepPath, old, old)
    store.upsertMemory({ ...learned, reviewedAt: Date.now() })
    const third = await exportMemory(ws)
    expect(third.find((e) => e.store === 'claude-code')?.wrote).toBe(2)
    expect(Math.round(statSync(keepPath).mtimeMs)).toBe(old.getTime())
  })

  it('exports at most EXPORT_MAX_ITEMS, keeping the best-evidenced rows', async () => {
    for (let i = 0; i < EXPORT_MAX_ITEMS + 20; i += 1) {
      // Distinct content words per row, or the export dedupe would (correctly) fold them into one fact.
      store.upsertMemory({ id: `used-${String(i).padStart(3, '0')}`, content: `memory ${i} ${'z'.repeat(i + 3)}`, author: 'model', status: 'approved', useCount: 1 })
    }
    store.upsertMemory({ id: 'pinned-one', content: 'the one pinned fact', author: 'model', status: 'approved', pinned: true })
    const report = await exportMemory(ws)
    expect(report.find((e) => e.store === 'claude-code')?.wrote).toBe(EXPORT_MAX_ITEMS)
    const memDir = join(home, '.claude', 'projects', claudeProjectSlug(ws.roots[0]!), 'memory')
    const files = readdirSync(memDir).filter((f) => f.startsWith('lattice-'))
    expect(files).toHaveLength(EXPORT_MAX_ITEMS)
    expect(files).toContain('lattice-pinned-one.md')
  })

  it('does not re-run the pairwise dedupe when the candidate set is unchanged', () => {
    store.upsertMemory({ id: 'u1', content: 'the printer lives at 10.0.0.108', author: 'user', status: 'approved' })
    store.upsertMemory({ id: 'u2', content: 'the gateway listens on 20128', author: 'user', status: 'approved' })
    const first = exportableMemories()
    const second = exportableMemories()
    expect(second).toBe(first) // same array: served from the memo, no pairwise pass
    store.upsertMemory({ id: 'u3', content: 'commits never carry emoji', author: 'user', status: 'approved' })
    const third = exportableMemories()
    expect(third).not.toBe(first)
    expect(third).toHaveLength(3)
  })

  it('coalesces a burst of scheduled exports into one', async () => {
    vi.useFakeTimers()
    store.upsertMemory({ id: 'u1', content: 'user fact', author: 'user', status: 'approved' })
    scheduleMemoryExport(ws)
    scheduleMemoryExport(ws)
    scheduleMemoryExport(ws)
    const memDir = join(home, '.claude', 'projects', claudeProjectSlug(ws.roots[0]!), 'memory')
    expect(existsSync(memDir)).toBe(false)
    await vi.advanceTimersByTimeAsync(EXPORT_DEBOUNCE_MS + 5)
    await vi.runAllTimersAsync()
    vi.useRealTimers()
    // Let the async fs work settle.
    await new Promise((r) => setTimeout(r, 30))
    expect(readdirSync(memDir).filter((f) => f.startsWith('lattice-'))).toEqual(['lattice-u1.md'])
  })

  it('runMemorySync imports synchronously and reports the export', async () => {
    writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'be terse')
    store.upsertMemory({ id: 'u1', content: 'user fact', author: 'user', status: 'approved' })
    const report = await runMemorySync(ws)
    expect(report.ok).toBe(true)
    expect(report.added).toBe(1)
    expect(report.exported.find((e) => e.store === 'claude-code')?.wrote).toBe(1)
  })
})
