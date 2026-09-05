import { describe, expect, it } from 'vitest'
import type { ToolDefinition } from '../tools/types'
import type { MemoryItem } from '@shared/types'
import { MEMORY_RECALL_NOTE, checkPathArgs, checklistWireNote, memoryPromptSection, pathArgsFor, selectMemoriesForPrompt } from './runManager'
import type { Todo } from '@shared/types'
import { builtinTools } from '../tools/builtin'

const tool = (over: Partial<ToolDefinition>): ToolDefinition =>
  ({
    name: 'x',
    description: '',
    parameters: {},
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: () => '',
    run: async () => ({}),
    ...over
  }) as ToolDefinition

describe('pathArgsFor', () => {
  it('infers ["path"] for a filesystem tool that declares a path parameter', () => {
    expect(pathArgsFor(tool({ parameters: { type: 'object', properties: { path: { type: 'string' } } } }))).toEqual([
      'path'
    ])
  })

  it('infers both forms for a filesystem tool that also reads a batch of paths', () => {
    expect(
      pathArgsFor(
        tool({
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' }, paths: { type: 'array', items: { type: 'string' } } }
          }
        })
      )
    ).toEqual(['path', 'paths'])
  })

  it('infers no path check for a filesystem tool with no path parameter (the memory_search bug)', () => {
    // Regression: memory_search / memory_save / todo_write are tagged `filesystem` but take
    // `query` / `content` / `items`, not `path`. They must not be rejected for a missing path.
    expect(pathArgsFor(tool({ name: 'memory_search', parameters: { type: 'object', properties: { query: {} } } }))).toEqual([])
    expect(
      pathArgsFor(tool({ name: 'memory_save', parameters: { type: 'object', properties: { content: {} } } }))
    ).toEqual([])
    expect(pathArgsFor(tool({ name: 'todo_write', parameters: { type: 'object', properties: { items: {} } } }))).toEqual([])
  })

  it('never adds a path check for a non-filesystem tool', () => {
    expect(pathArgsFor(tool({ resource: 'network', parameters: { properties: { path: {} } } }))).toEqual([])
  })

  it('honors an explicit pathArgs over inference', () => {
    expect(pathArgsFor(tool({ pathArgs: ['from', 'to'], parameters: { properties: {} } }))).toEqual(['from', 'to'])
  })

  it('holds for the real builtin tools: memory/todo take no path check, fs tools do', () => {
    const byName = new Map(builtinTools.map((t) => [t.name, t]))
    expect(pathArgsFor(byName.get('memory_search')!)).toEqual([])
    expect(pathArgsFor(byName.get('memory_save')!)).toEqual([])
    expect(pathArgsFor(byName.get('todo_write')!)).toEqual([])
    expect(pathArgsFor(byName.get('fs_read')!)).toEqual(['path', 'paths'])
    expect(pathArgsFor(byName.get('fs_write')!)).toEqual(['path'])
    expect(pathArgsFor(byName.get('grep_search')!)).toEqual(['path'])
    expect(pathArgsFor(byName.get('fs_move')!)).toEqual(['from', 'to'])
    expect(pathArgsFor(byName.get('show_image')!)).toEqual(['path'])
    expect(pathArgsFor(byName.get('show_image_data')!)).toEqual([])
    expect(pathArgsFor(byName.get('fetch_image')!)).toEqual([])
  })
})

const mem = (over: Partial<MemoryItem>): MemoryItem =>
  ({
    id: Math.random().toString(36).slice(2),
    scope: 'user',
    type: 'note',
    content: 'x',
    author: 'model',
    confidence: 1,
    sensitivity: 'normal',
    createdAt: 0,
    updatedAt: 0,
    version: 1,
    status: 'approved',
    pinned: false,
    ...over
  }) as MemoryItem

describe('selectMemoriesForPrompt', () => {
  it('caps the number of injected items', () => {
    const many = Array.from({ length: 100 }, (_, i) => mem({ content: `fact ${i}`, updatedAt: i }))
    expect(selectMemoriesForPrompt(many).length).toBe(40)
  })

  it('orders pinned first, then by recency', () => {
    const items = [
      mem({ content: 'old', updatedAt: 1 }),
      mem({ content: 'newest', updatedAt: 100 }),
      mem({ content: 'pinned-old', updatedAt: 2, pinned: true })
    ]
    const out = selectMemoriesForPrompt(items, 40, 6000).map((m) => m.content)
    expect(out[0]).toBe('pinned-old')
    expect(out[1]).toBe('newest')
    expect(out[2]).toBe('old')
  })

  it('prefers lastUsedAt over updatedAt for recency', () => {
    const items = [
      mem({ content: 'a', updatedAt: 100, lastUsedAt: 1 }),
      mem({ content: 'b', updatedAt: 1, lastUsedAt: 100 })
    ]
    expect(selectMemoriesForPrompt(items).map((m) => m.content)).toEqual(['b', 'a'])
  })

  it('stops at the character budget but always keeps at least the top item', () => {
    const big = mem({ content: 'z'.repeat(10000), updatedAt: 100 })
    const small = mem({ content: 'later', updatedAt: 1 })
    const out = selectMemoriesForPrompt([big, small], 40, 6000)
    expect(out).toHaveLength(1)
    expect(out[0]!.content.startsWith('z')).toBe(true)
  })

  it('fills up to the character budget with as many items as fit', () => {
    const items = Array.from({ length: 10 }, (_, i) => mem({ content: 'y'.repeat(100), updatedAt: 10 - i }))
    const out = selectMemoriesForPrompt(items, 40, 300) // ~108 chars each → 2 fit
    expect(out.length).toBe(2)
  })
})

describe('memoryPromptSection — on-demand recall, cache-stable prefix', () => {
  it('always carries the static recall note and never an item count', () => {
    const section = memoryPromptSection([mem({ content: 'a' }), mem({ content: 'b' })])
    expect(section).toContain('# Memory')
    expect(section).toContain(MEMORY_RECALL_NOTE)
    expect(section).toContain('memory_search')
    expect(section).not.toMatch(/\b\d+ (memor|item)/i)
  })

  it('inlines only pinned memories; unpinned ones stay recall-only', () => {
    const section = memoryPromptSection([
      mem({ content: 'pinned-fact', pinned: true }),
      mem({ content: 'loose-fact', pinned: false })
    ])
    expect(section).toContain('pinned-fact')
    expect(section).not.toContain('loose-fact')
  })

  it('is byte-identical when only recency metadata changes (no cache busting)', () => {
    const a = [
      mem({ id: 'A', content: 'one', pinned: true, lastUsedAt: 1, updatedAt: 5 }),
      mem({ id: 'B', content: 'two', pinned: true, lastUsedAt: 9, updatedAt: 2 })
    ]
    const b = [
      mem({ id: 'B', content: 'two', pinned: true, lastUsedAt: 1, updatedAt: 99 }),
      mem({ id: 'A', content: 'one', pinned: true, lastUsedAt: 50, updatedAt: 1 })
    ]
    expect(memoryPromptSection(a)).toBe(memoryPromptSection(b))
  })

  it('renders no pinned block when nothing is pinned', () => {
    const section = memoryPromptSection([mem({ content: 'loose' })])
    expect(section).not.toContain('Pinned memories')
    expect(section).toContain(MEMORY_RECALL_NOTE)
  })
})

describe('checkPathArgs', () => {
  const byName = new Map(builtinTools.map((t) => [t.name, t]))
  const fsRead = (): ToolDefinition => byName.get('fs_read')!

  it('collects the singular path', () => {
    expect(checkPathArgs(fsRead(), { path: '/a/b.ts' })).toEqual({ ok: true, paths: ['/a/b.ts'] })
  })

  // The bug this fixes: `fs_read` has always supported `paths: string[]`, but validation demanded a
  // string `path` from every filesystem tool — so every legitimate multi-file read was denied with
  // "Invalid path for fs_read: expected a string" before the tool ever ran.
  it('accepts a batch read and containment-checks every requested path', () => {
    expect(checkPathArgs(fsRead(), { paths: ['/a/b.ts', '/a/c.ts'] })).toEqual({
      ok: true,
      paths: ['/a/b.ts', '/a/c.ts']
    })
  })

  it('accepts both forms in one call, in the order they will be read', () => {
    expect(checkPathArgs(fsRead(), { path: '/a/x.ts', paths: ['/a/y.ts'] })).toEqual({
      ok: true,
      paths: ['/a/x.ts', '/a/y.ts']
    })
  })

  it('accepts a lone string for the array form, as the tool itself does', () => {
    expect(checkPathArgs(fsRead(), { paths: '/a/only.ts' })).toEqual({ ok: true, paths: ['/a/only.ts'] })
  })

  it('lets a call with neither form through, so the tool raises its own domain error', () => {
    // Neither `path` nor `paths` is schema-required on fs_read; "needs `path` or `paths`" is the
    // tool's message to give, not a permission denial.
    expect(checkPathArgs(fsRead(), {})).toEqual({ ok: true, paths: [] })
  })

  it('still rejects a non-string path, an empty path, and a junk entry in a batch', () => {
    expect(checkPathArgs(fsRead(), { path: 42 })).toEqual({
      ok: false,
      error: 'Invalid path for fs_read: expected a string.'
    })
    expect(checkPathArgs(fsRead(), { path: '   ' })).toMatchObject({ ok: false })
    expect(checkPathArgs(fsRead(), { paths: ['/a/ok.ts', 7] })).toMatchObject({
      ok: false,
      error: expect.stringContaining('every entry must be a non-empty path string')
    })
  })

  it('still demands the paths a schema marks required (fs_move takes both endpoints)', () => {
    const move = byName.get('fs_move')!
    expect(checkPathArgs(move, { from: '/a', to: '/b' })).toEqual({ ok: true, paths: ['/a', '/b'] })
    expect(checkPathArgs(move, { from: '/a' })).toEqual({
      ok: false,
      error: 'Invalid to for fs_move: expected a string.'
    })
  })

  it('checks nothing for a tool that carries no paths', () => {
    expect(checkPathArgs(byName.get('memory_search')!, { query: 'x' })).toEqual({ ok: true, paths: [] })
  })
})

describe('checklistWireNote — the tail-of-wire checklist echo', () => {
  const todo = (id: string, title: string, over: Partial<Todo> = {}): Todo => ({
    id,
    threadId: 'T',
    workspaceId: 'w',
    title,
    status: 'todo',
    priority: 0,
    createdAt: 1,
    updatedAt: 1,
    durable: false,
    ...over
  })

  it('is empty for a thread without a checklist', () => {
    expect(checklistWireNote('T', [])).toBe('')
  })

  it('lists items with bare ids, nesting, status, progress, and user provenance', () => {
    const note = checklistWireNote('T', [
      todo('T:1', 'Plan', { status: 'done' }),
      todo('T:1a', 'Sub', { parentId: 'T:1', status: 'in_progress' }),
      todo('01ULID', 'Added by hand', { source: 'user' })
    ])
    expect(note.startsWith('# Checklist (1/3 done)')).toBe(true)
    expect(note).toContain('- [1] done — Plan')
    expect(note).toContain('  - [1a] in_progress — Sub')
    expect(note).toContain('- [01ULID] todo — Added by hand (added by user)')
    expect(note).toMatch(/user can add, rename, reorder, check off, or delete/)
  })
})
