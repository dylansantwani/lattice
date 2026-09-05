import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-todos-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from './eventStore'
import { getDb, closeDb } from './db'

const WS = 'ws1'
const add = (over: Partial<Parameters<typeof store.upsertTodo>[0]> & { title: string; threadId?: string }) =>
  store.upsertTodo({ workspaceId: WS, threadId: 'A', ...over })

beforeEach(() => {
  getDb().exec('DELETE FROM todos')
})
afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('scoped ids', () => {
  it('namespaces bare tool keys per thread and strips them for the model', () => {
    expect(store.scopedTodoId('A', '1')).toBe('A:1')
    expect(store.scopedTodoId('A', 'A:1')).toBe('A:1')
    expect(store.publicTodoId('A', 'A:1')).toBe('1')
    expect(store.publicTodoId('A', 'B:1')).toBe('B:1')
    expect(store.publicTodoId(undefined, 'X')).toBe('X')
  })

  it('two threads numbering from 1 never clobber each other', () => {
    add({ id: store.scopedTodoId('A', '1'), title: 'A first', threadId: 'A' })
    add({ id: store.scopedTodoId('B', '1'), title: 'B first', threadId: 'B' })
    expect(store.listTodos('A').map((t) => t.title)).toEqual(['A first'])
    expect(store.listTodos('B').map((t) => t.title)).toEqual(['B first'])
  })
})

describe('upsertTodo', () => {
  it('keeps provenance and manual priority on an update that does not state them', () => {
    const t = add({ id: 'A:1', title: 'x', source: 'user', priority: 7 })
    expect(t.source).toBe('user')
    const again = store.upsertTodo({ id: 'A:1', title: 'x renamed', workspaceId: WS, threadId: 'A' })
    expect(again.source).toBe('user')
    expect(again.priority).toBe(7)
    expect(again.title).toBe('x renamed')
    expect(again.createdAt).toBe(t.createdAt)
  })
  it('defaults new items to agent provenance and status todo', () => {
    const t = add({ title: 'plain' })
    expect(t.source).toBe('agent')
    expect(t.status).toBe('todo')
  })
})

describe('updateTodo', () => {
  it('patches fields, ignores an empty title and unknown status, and returns null for unknown ids', () => {
    const t = add({ title: 'a' })
    expect(store.updateTodo(t.id, { status: 'in_progress', title: 'A!' })?.status).toBe('in_progress')
    expect(store.updateTodo(t.id, { title: '   ' })?.title).toBe('A!')
    expect(store.updateTodo(t.id, { status: 'bogus' as never })?.status).toBe('in_progress')
    expect(store.updateTodo('nope', { title: 'x' })).toBeNull()
  })
  it('refuses to parent an item under itself or its own descendant', () => {
    const p = add({ title: 'parent' })
    const c = add({ title: 'child', parentId: p.id })
    expect(store.updateTodo(p.id, { parentId: p.id })?.parentId).toBeUndefined()
    expect(store.updateTodo(p.id, { parentId: c.id })?.parentId).toBeUndefined()
    expect(store.updateTodo(c.id, { parentId: '' })?.parentId).toBeUndefined()
  })
})

describe('deleteTodo / clearTodos', () => {
  it('deletes a subtree', () => {
    const p = add({ title: 'p' })
    const c = add({ title: 'c', parentId: p.id })
    add({ title: 'gc', parentId: c.id })
    add({ title: 'other' })
    store.deleteTodo(p.id)
    expect(store.listTodos('A').map((t) => t.title)).toEqual(['other'])
  })
  it('clears finished items (with their subtasks) and reports the count; all empties the thread', () => {
    const p = add({ title: 'done parent', status: 'done' })
    add({ title: 'open child of done', parentId: p.id })
    add({ title: 'canceled', status: 'canceled' })
    add({ title: 'open' })
    add({ title: 'elsewhere', threadId: 'B' })
    expect(store.clearTodos('A', 'done')).toBe(3)
    expect(store.listTodos('A').map((t) => t.title)).toEqual(['open'])
    expect(store.clearTodos('A', 'all')).toBe(1)
    expect(store.listTodos('A')).toEqual([])
    expect(store.listTodos('B')).toHaveLength(1)
  })
})

describe('reorderTodos', () => {
  it('persists the given order ahead of unmentioned items and ignores foreign ids', () => {
    const a = add({ title: 'a' })
    const b = add({ title: 'b' })
    const c = add({ title: 'c' })
    const x = add({ title: 'x', threadId: 'B' })
    store.reorderTodos('A', [c.id, a.id, x.id])
    expect(store.listTodos('A').map((t) => t.title)).toEqual(['c', 'a', 'b'])
    expect(store.listTodos('B').map((t) => t.id)).toEqual([x.id])
  })
})
