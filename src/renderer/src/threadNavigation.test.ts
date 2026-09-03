import { describe, expect, it } from 'vitest'
import { adjacentThreadId } from './threadNavigation'

const thread = (id: string, archived = false) => ({ id, archived })

describe('adjacentThreadId', () => {
  const threads = [thread('pinned'), thread('recent'), thread('older')]

  it('advances to the next thread and wraps at the end', () => {
    expect(adjacentThreadId(threads, 'pinned', 'next')).toBe('recent')
    expect(adjacentThreadId(threads, 'older', 'next')).toBe('pinned')
  })

  it('moves to the previous thread and wraps at the beginning', () => {
    expect(adjacentThreadId(threads, 'older', 'previous')).toBe('recent')
    expect(adjacentThreadId(threads, 'pinned', 'previous')).toBe('older')
  })

  it('skips archived threads', () => {
    expect(adjacentThreadId([thread('first'), thread('archived', true), thread('last')], 'first', 'next')).toBe('last')
    expect(adjacentThreadId([thread('first'), thread('archived', true), thread('last')], 'last', 'previous')).toBe('first')
  })

  it('selects the first or last visible thread when the active thread is unavailable', () => {
    const available = [thread('first'), thread('last')]
    expect(adjacentThreadId(available, 'missing', 'next')).toBe('first')
    expect(adjacentThreadId(available, 'missing', 'previous')).toBe('last')
  })

  it('returns null when there is nothing else to switch to', () => {
    expect(adjacentThreadId([], null, 'next')).toBeNull()
    expect(adjacentThreadId([thread('only')], 'only', 'previous')).toBeNull()
    expect(adjacentThreadId([thread('archived', true)], null, 'next')).toBeNull()
  })
})
