import { describe, expect, it } from 'vitest'
import {
  buildTodoTree,
  flattenTree,
  moveId,
  orderedIds,
  partitionFinished,
  todoProgress,
  toggledStatus,
  isFinished
} from './todoTree'
import type { TodoStatus } from '@shared/types'

const t = (id: string, status: TodoStatus = 'todo', parentId?: string) => ({ id, status, parentId })

describe('buildTodoTree', () => {
  it('nests children under parents in input order and keeps orphans at the root', () => {
    const tree = buildTodoTree([t('1'), t('1a', 'todo', '1'), t('2'), t('x', 'todo', 'missing'), t('1b', 'todo', '1')])
    expect(tree.map((n) => n.item.id)).toEqual(['1', '2', 'x'])
    expect(tree[0]!.children.map((n) => n.item.id)).toEqual(['1a', '1b'])
    expect(tree[0]!.children[0]!.depth).toBe(1)
  })

  it('breaks cycles and self-parents instead of losing items', () => {
    const tree = buildTodoTree([t('a', 'todo', 'b'), t('b', 'todo', 'a'), t('c', 'todo', 'c')])
    expect(flattenTree(tree).map((n) => n.item.id).sort()).toEqual(['a', 'b', 'c'])
  })

  it('flattens depth-first so subtasks render right under their parent', () => {
    const tree = buildTodoTree([t('1'), t('2'), t('1a', 'todo', '1'), t('1a-i', 'todo', '1a')])
    expect(flattenTree(tree).map((n) => `${n.item.id}@${n.depth}`)).toEqual(['1@0', '1a@1', '1a-i@2', '2@0'])
  })
})

describe('todoProgress', () => {
  it('counts done over non-canceled items', () => {
    const p = todoProgress([t('1', 'done'), t('2', 'in_progress'), t('3', 'blocked'), t('4', 'canceled'), t('5')])
    expect(p).toEqual({ done: 1, total: 4, inProgress: 1, blocked: 1, fraction: 0.25 })
  })
  it('is zero, not NaN, for an empty list', () => {
    expect(todoProgress([]).fraction).toBe(0)
  })
})

describe('status transitions', () => {
  it('toggles open ↔ done and revives a canceled item as to-do', () => {
    expect(toggledStatus('todo')).toBe('done')
    expect(toggledStatus('in_progress')).toBe('done')
    expect(toggledStatus('done')).toBe('todo')
    expect(toggledStatus('canceled')).toBe('todo')
  })
  it('treats done and canceled as finished', () => {
    expect(isFinished('done')).toBe(true)
    expect(isFinished('canceled')).toBe(true)
    expect(isFinished('review')).toBe(false)
  })
})

describe('moveId (drag reorder)', () => {
  const ids = ['a', 'b', 'c', 'd']
  it('moves before / after a target', () => {
    expect(moveId(ids, 'd', 'b', 'before')).toEqual(['a', 'd', 'b', 'c'])
    expect(moveId(ids, 'a', 'c', 'after')).toEqual(['b', 'c', 'a', 'd'])
  })
  it('is a no-op for the same item or unknown ids', () => {
    expect(moveId(ids, 'a', 'a', 'before')).toBe(ids)
    expect(moveId(ids, 'zz', 'a', 'before')).toBe(ids)
  })
})

describe('orderedIds / partitionFinished', () => {
  it('persists roots with their subtrees adjacent', () => {
    const tree = buildTodoTree([t('2'), t('1'), t('1a', 'todo', '1')])
    const reordered = [tree[1]!, tree[0]!]
    expect(orderedIds(reordered)).toEqual(['1', '1a', '2'])
  })
  it('keeps a finished parent together with its open subtasks', () => {
    const tree = buildTodoTree([t('1', 'done'), t('1a', 'todo', '1'), t('2')])
    const { open, finished } = partitionFinished(tree)
    expect(open.map((n) => n.item.id)).toEqual(['2'])
    expect(finished.map((n) => n.item.id)).toEqual(['1'])
    expect(finished[0]!.children).toHaveLength(1)
  })
})
