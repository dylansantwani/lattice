import { describe, expect, it } from 'vitest'
import type { MemoryItem } from '@shared/types'
import { filterMemories, memoryOrigin, preferKeep, untilTime } from './MemoryTab'

const mem = (over: Partial<MemoryItem>): MemoryItem =>
  ({
    id: 'x',
    scope: 'user',
    type: 'fact',
    content: 'c',
    author: 'model',
    confidence: 1,
    sensitivity: 'normal',
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
    version: 1,
    status: 'approved',
    pinned: false,
    ...over
  }) as MemoryItem

describe('memoryOrigin', () => {
  it('reads the bridge id scheme', () => {
    expect(memoryOrigin('mem:cc:global')).toBe('Claude Code')
    expect(memoryOrigin('mem:hermes:user:abc')).toBe('Hermes')
    expect(memoryOrigin('01ULID')).toBeNull()
  })
})

describe('filterMemories', () => {
  const items = [
    mem({ id: 'a', status: 'proposed' }),
    mem({ id: 'b', pinned: true }),
    mem({ id: 'mem:cc:global', author: 'import' }),
    mem({ id: 'd', author: 'user', scope: 'workspace', scopeId: 'w' }),
    mem({ id: 'e', sourceEventId: 'ev', scope: 'thread', scopeId: 't' }),
    mem({ id: 'f', status: 'expired' })
  ]
  const all = { status: 'all', origin: 'all', scope: 'all' } as const

  it('passes everything through with no filters', () => {
    expect(filterMemories(items, all)).toHaveLength(6)
  })
  it('filters by status, with pinned as its own lane', () => {
    expect(filterMemories(items, { ...all, status: 'proposed' }).map((m) => m.id)).toEqual(['a'])
    expect(filterMemories(items, { ...all, status: 'pinned' }).map((m) => m.id)).toEqual(['b'])
    expect(filterMemories(items, { ...all, status: 'expired' }).map((m) => m.id)).toEqual(['f'])
  })
  it('filters by origin: learned vs saved-by-model vs you vs imports', () => {
    expect(filterMemories(items, { ...all, origin: 'claude-code' }).map((m) => m.id)).toEqual(['mem:cc:global'])
    expect(filterMemories(items, { ...all, origin: 'user' }).map((m) => m.id)).toEqual(['d'])
    expect(filterMemories(items, { ...all, origin: 'saved' }).map((m) => m.id)).toEqual(['e'])
    expect(filterMemories(items, { ...all, origin: 'learned' }).map((m) => m.id)).toEqual(['a', 'b', 'f'])
  })
  it('filters by scope', () => {
    expect(filterMemories(items, { ...all, scope: 'thread' }).map((m) => m.id)).toEqual(['e'])
    expect(filterMemories(items, { ...all, scope: 'workspace' }).map((m) => m.id)).toEqual(['d'])
  })
})

describe('preferKeep — which duplicate survives a merge', () => {
  it('prefers pinned, then user-written, then reviewed, then the longer, then the older', () => {
    expect(preferKeep(mem({ pinned: true }), mem({ author: 'user' }))).toBeLessThan(0)
    expect(preferKeep(mem({ author: 'user' }), mem({ reviewedAt: 5 }))).toBeLessThan(0)
    expect(preferKeep(mem({ reviewedAt: 5 }), mem({ content: 'much longer content here' }))).toBeLessThan(0)
    expect(preferKeep(mem({ content: 'short' }), mem({ content: 'much longer content here' }))).toBeGreaterThan(0)
    expect(preferKeep(mem({ createdAt: 1 }), mem({ createdAt: 2 }))).toBeLessThan(0)
  })
})

describe('untilTime', () => {
  it('formats a future horizon', () => {
    expect(untilTime(1000 + 12 * 86400_000, 1000)).toBe('in 12d')
    expect(untilTime(1000 + 3 * 3600_000, 1000)).toBe('in 3h')
    expect(untilTime(1000 + 5 * 60_000, 1000)).toBe('in 5m')
    expect(untilTime(500, 1000)).toBe('now')
  })
})
