import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-todo-tool-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import { builtinTools } from './builtin'
import * as store from '../store/eventStore'
import { getDb, closeDb } from '../store/db'
import type { ToolContext } from './types'

const tool = builtinTools.find((t) => t.name === 'todo_write')!
const ctxFor = (threadId: string): ToolContext =>
  ({
    threadMeta: { id: threadId, workspaceId: 'w1' } as ToolContext['threadMeta'],
    workspace: { id: 'w1', name: 'test', roots: [] } as unknown as ToolContext['workspace'],
    runId: 'r1',
    signal: new AbortController().signal
  }) as ToolContext

beforeEach(() => getDb().exec('DELETE FROM todos'))
afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('todo_write', () => {
  it('stores thread-scoped ids but returns the bare keys, and keeps threads apart', async () => {
    const out = (await tool.run({ items: [{ id: '1', title: 'first', status: 'in_progress' }] }, ctxFor('A'))) as { items: { id: string }[] }
    expect(out.items.map((i) => i.id)).toEqual(['1'])
    await tool.run({ items: [{ id: '1', title: 'other thread', status: 'todo' }] }, ctxFor('B'))
    expect(store.listTodos('A').map((t) => [t.id, t.title])).toEqual([['A:1', 'first']])
    expect(store.listTodos('B').map((t) => [t.id, t.title])).toEqual([['B:1', 'other thread']])
  })

  it('merges by id, nests by parentId, removes subtrees, and coerces a bad status', async () => {
    await tool.run(
      { items: [{ id: '1', title: 'plan', status: 'todo' }, { id: '1a', title: 'sub', status: 'weird', parentId: '1' }, { id: '2', title: 'two', status: 'todo' }] },
      ctxFor('A')
    )
    expect(store.getTodo('A:1a')?.parentId).toBe('A:1')
    expect(store.getTodo('A:1a')?.status).toBe('todo')
    const out = (await tool.run({ items: [{ id: '2', title: 'two', status: 'done' }], remove: ['1'] }, ctxFor('A'))) as {
      items: { id: string; status: string; parentId?: string }[]
    }
    expect(out.items).toEqual([{ id: '2', title: 'two', status: 'done' }])
  })

  it('echoes user-added items with addedBy so the model can tell them apart', async () => {
    store.upsertTodo({ title: 'from the panel', workspaceId: 'w1', threadId: 'A', source: 'user' })
    const out = (await tool.run({ items: [{ id: '1', title: 'mine', status: 'todo' }] }, ctxFor('A'))) as { items: Record<string, unknown>[] }
    expect(out.items.find((i) => i.title === 'from the panel')?.addedBy).toBe('user')
    expect(out.items.find((i) => i.title === 'mine')?.addedBy).toBeUndefined()
  })

  it('rejects an empty call', async () => {
    await expect(tool.run({}, ctxFor('A'))).rejects.toThrow(/items/)
  })

  it('summarizes counts for the transcript row', () => {
    expect(tool.summarize?.({ items: [{}, {}], remove: ['x'] })).toBe('Update checklist (2 items, remove 1)')
  })
})
