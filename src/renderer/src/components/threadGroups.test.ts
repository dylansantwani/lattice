import { describe, expect, it } from 'vitest'
import type { ThreadMeta } from '@shared/types'
import { autoBucket, modelLabel, resolveThreadDrop, runningFirst } from './threadGroups'

const DAY = 86_400_000
const NOON = new Date('2026-09-01T12:00:00').getTime() // a fixed "now" (local)

let n = 0
function thread(over: Partial<ThreadMeta> = {}): ThreadMeta {
  n += 1
  return {
    id: `t${n}`,
    workspaceId: 'w',
    title: `Thread ${n}`,
    createdAt: NOON,
    updatedAt: NOON,
    pinned: false,
    archived: false,
    model: 'cc/claude-fable-5',
    mode: 'act',
    permissionPreset: 'workspace',
    ...over
  }
}

describe('autoBucket — by date', () => {
  it('sorts threads into calendar buckets and omits empty ones', () => {
    const threads = [
      thread({ id: 'now', updatedAt: NOON }),
      thread({ id: 'early-today', updatedAt: new Date('2026-09-01T01:00:00').getTime() }),
      thread({ id: 'yest', updatedAt: NOON - DAY }),
      thread({ id: 'four-days', updatedAt: NOON - 4 * DAY }),
      thread({ id: 'twenty-days', updatedAt: NOON - 20 * DAY }),
      thread({ id: 'ancient', updatedAt: NOON - 400 * DAY })
    ]
    const buckets = autoBucket(threads, 'date', NOON)
    expect(buckets.map((b) => b.label)).toEqual([
      'Today',
      'Yesterday',
      'Previous 7 days',
      'Previous 30 days',
      'Older'
    ])
    expect(buckets[0]!.threads.map((t) => t.id)).toEqual(['now', 'early-today'])
    expect(buckets[1]!.threads.map((t) => t.id)).toEqual(['yest'])
    expect(buckets[4]!.threads.map((t) => t.id)).toEqual(['ancient'])
  })

  it('drops buckets with no threads (only Today present)', () => {
    const buckets = autoBucket([thread({ updatedAt: NOON })], 'date', NOON)
    expect(buckets).toHaveLength(1)
    expect(buckets[0]!.label).toBe('Today')
  })

  it('uses a calendar-day boundary, not a rolling 24h window', () => {
    // 1am today is still "Today" even though it is >2h before... no, it's within the same day.
    // A timestamp at 11pm yesterday is "Yesterday" even if <13h ago.
    const lateYesterday = new Date('2026-08-31T23:00:00').getTime()
    const buckets = autoBucket([thread({ id: 'ly', updatedAt: lateYesterday })], 'date', NOON)
    expect(buckets[0]!.label).toBe('Yesterday')
  })

  it('promotes running threads within each bucket while preserving their relative order', () => {
    const buckets = autoBucket(
      [
        thread({ id: 'idle', updatedAt: NOON }),
        thread({ id: 'running-a', updatedAt: NOON - 1_000, running: true }),
        thread({ id: 'running-b', updatedAt: NOON - 2_000, running: true })
      ],
      'date',
      NOON
    )
    expect(buckets[0]!.threads.map((t) => t.id)).toEqual(['running-a', 'running-b', 'idle'])
  })
})

describe('runningFirst', () => {
  it('does not mutate the incoming list', () => {
    const threads = [thread({ id: 'idle' }), thread({ id: 'running', running: true })]
    expect(runningFirst(threads).map((t) => t.id)).toEqual(['running', 'idle'])
    expect(threads.map((t) => t.id)).toEqual(['idle', 'running'])
  })
})

describe('autoBucket — by mode', () => {
  it('groups by mode in fixed Plan/Act/Review order, skipping absent modes', () => {
    const threads = [thread({ mode: 'act' }), thread({ mode: 'plan' }), thread({ mode: 'act' })]
    const buckets = autoBucket(threads, 'mode', NOON)
    expect(buckets.map((b) => b.label)).toEqual(['Plan', 'Act'])
    expect(buckets.find((b) => b.label === 'Act')!.threads).toHaveLength(2)
  })
})

describe('autoBucket — by model', () => {
  it('groups by model, ordered by first appearance, with prefixes stripped in labels', () => {
    const threads = [
      thread({ model: 'cc/claude-fable-5' }),
      thread({ model: 'openrouter/gpt-5' }),
      thread({ model: 'cc/claude-fable-5' })
    ]
    const buckets = autoBucket(threads, 'model', NOON)
    expect(buckets.map((b) => b.label)).toEqual(['claude-fable-5', 'gpt-5'])
    expect(buckets[0]!.threads).toHaveLength(2)
  })
})

describe('modelLabel', () => {
  it('strips a leading provider prefix', () => {
    expect(modelLabel('cc/claude-fable-5')).toBe('claude-fable-5')
    expect(modelLabel('bare-model')).toBe('bare-model')
  })
})

describe('resolveThreadDrop — drag-to-file decision', () => {
  it('files an ungrouped thread into the dropped-on group', () => {
    expect(resolveThreadDrop(undefined, 'g1')).toEqual({ groupId: 'g1' })
    expect(resolveThreadDrop(null, 'g1')).toEqual({ groupId: 'g1' })
  })

  it('moves a thread from one group to another', () => {
    expect(resolveThreadDrop('g1', 'g2')).toEqual({ groupId: 'g2' })
  })

  it('un-files a grouped thread dropped on the Ungrouped zone', () => {
    expect(resolveThreadDrop('g1', null)).toEqual({ groupId: null })
  })

  it('is a no-op when dropped on the group it already belongs to', () => {
    expect(resolveThreadDrop('g1', 'g1')).toBeNull()
  })

  it('is a no-op when an already-ungrouped thread is dropped on Ungrouped', () => {
    expect(resolveThreadDrop(undefined, null)).toBeNull()
    expect(resolveThreadDrop(null, null)).toBeNull()
  })
})
