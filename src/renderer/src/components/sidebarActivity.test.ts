import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { activeThreads, describeActivity } from './sidebarActivity'

const t = (id: string, over: Partial<ThreadMeta> = {}): ThreadMeta =>
  ({ id, title: `T ${id}`, running: false, archived: false, ...over }) as ThreadMeta

describe('activeThreads', () => {
  it('orders waiting before running before failed and skips idle/archived threads', () => {
    const list = activeThreads(
      [t('a', { running: true }), t('b'), t('c', { running: true }), t('d'), t('e', { running: true, archived: true })],
      new Set(['c']),
      new Set(['d'])
    )
    expect(list.map((e) => [e.threadId, e.state])).toEqual([
      ['c', 'waiting'],
      ['a', 'running'],
      ['d', 'failed']
    ])
  })
  it('is empty when nothing is going on', () => {
    expect(activeThreads([t('a'), t('b')], new Set(), new Set())).toEqual([])
  })
})

describe('describeActivity', () => {
  it('summarises the counts', () => {
    expect(
      describeActivity([
        { threadId: 'a', title: '', state: 'running' },
        { threadId: 'b', title: '', state: 'running' },
        { threadId: 'c', title: '', state: 'waiting' }
      ])
    ).toBe('1 waiting on you · 2 running')
    expect(describeActivity([])).toBe('')
  })
})
