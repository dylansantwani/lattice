/**
 * Pure checklist helpers for the Tasks panel: flat rows → parent/child tree, progress, the
 * status transitions the UI offers, and the id arithmetic for drag-reorder. Framework-free so
 * the panel's logic has one tested definition.
 */
import type { Todo, TodoStatus } from '@shared/types'

export type TodoLike = Pick<Todo, 'id' | 'parentId' | 'status'>

export interface TodoNode<T extends TodoLike = Todo> {
  item: T
  children: TodoNode<T>[]
  depth: number
}

/** Every status, in the order the status menu lists them. */
export const TODO_STATUSES: readonly TodoStatus[] = ['todo', 'in_progress', 'blocked', 'review', 'done', 'canceled']

export const TODO_STATUS_LABEL: Record<TodoStatus, string> = {
  todo: 'To do',
  in_progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  done: 'Done',
  canceled: 'Canceled'
}

/** Finished items: checked off, or dropped. */
export function isFinished(status: TodoStatus): boolean {
  return status === 'done' || status === 'canceled'
}

/**
 * Flat list → tree, preserving the input order (the store already orders by manual priority
 * then creation). An orphan — a parentId pointing outside the list — becomes a root so nothing
 * silently disappears; a cycle is broken the same way.
 */
export function buildTodoTree<T extends TodoLike>(todos: T[]): TodoNode<T>[] {
  const byId = new Map(todos.map((t) => [t.id, t]))
  const childrenOf = new Map<string, T[]>()
  const roots: T[] = []
  for (const t of todos) {
    if (t.parentId && t.parentId !== t.id && byId.has(t.parentId) && !reachesSelf(t, byId)) {
      const bucket = childrenOf.get(t.parentId)
      if (bucket) bucket.push(t)
      else childrenOf.set(t.parentId, [t])
    } else {
      roots.push(t)
    }
  }
  const build = (item: T, depth: number, seen: Set<string>): TodoNode<T> => {
    seen.add(item.id)
    const kids = (childrenOf.get(item.id) ?? []).filter((c) => !seen.has(c.id))
    return { item, depth, children: kids.map((c) => build(c, depth + 1, seen)) }
  }
  const seen = new Set<string>()
  return roots.map((r) => build(r, 0, seen))
}

/** True when following parent links from `t` loops back to `t` (a cycle). */
function reachesSelf<T extends TodoLike>(t: T, byId: Map<string, T>): boolean {
  let cur = t.parentId ? byId.get(t.parentId) : undefined
  let hops = 0
  while (cur && hops++ < byId.size) {
    if (cur.id === t.id) return true
    cur = cur.parentId ? byId.get(cur.parentId) : undefined
  }
  return false
}

/** Depth-first flattening — what the panel renders, one row per node. */
export function flattenTree<T extends TodoLike>(nodes: TodoNode<T>[]): TodoNode<T>[] {
  const out: TodoNode<T>[] = []
  const walk = (n: TodoNode<T>): void => {
    out.push(n)
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return out
}

export interface TodoProgress {
  /** items checked off */
  done: number
  /** items that count toward completion (everything not canceled) */
  total: number
  inProgress: number
  blocked: number
  /** 0–1 share of `total` that is done; 0 when the list is empty */
  fraction: number
}

export function todoProgress(todos: TodoLike[]): TodoProgress {
  let done = 0
  let total = 0
  let inProgress = 0
  let blocked = 0
  for (const t of todos) {
    if (t.status === 'canceled') continue
    total++
    if (t.status === 'done') done++
    else if (t.status === 'in_progress') inProgress++
    else if (t.status === 'blocked') blocked++
  }
  return { done, total, inProgress, blocked, fraction: total ? done / total : 0 }
}

/** The checkbox click: finished ↔ open. A canceled item comes back as plain to-do. */
export function toggledStatus(status: TodoStatus): TodoStatus {
  return isFinished(status) ? 'todo' : 'done'
}

/**
 * Move `id` so it lands immediately before/after `target` in `ids`. Returns a new array; the
 * input is returned untouched when either id is missing or they are the same item.
 */
export function moveId(ids: string[], id: string, target: string, place: 'before' | 'after'): string[] {
  if (id === target || !ids.includes(id) || !ids.includes(target)) return ids
  const without = ids.filter((x) => x !== id)
  const at = without.indexOf(target) + (place === 'after' ? 1 : 0)
  return [...without.slice(0, at), id, ...without.slice(at)]
}

/**
 * The ids a manual reorder persists: roots in their new order, each followed by its subtree in
 * display order. The store ranks by position, so children stay adjacent to their parent.
 */
export function orderedIds<T extends TodoLike>(roots: TodoNode<T>[]): string[] {
  return flattenTree(roots).map((n) => n.item.id)
}

/**
 * Split rows for display: open items first, finished ones after (optionally hidden). A finished
 * parent keeps its subtree with it so the tree never splits.
 */
export function partitionFinished<T extends TodoLike>(roots: TodoNode<T>[]): { open: TodoNode<T>[]; finished: TodoNode<T>[] } {
  const open: TodoNode<T>[] = []
  const finished: TodoNode<T>[] = []
  for (const r of roots) (isFinished(r.item.status) ? finished : open).push(r)
  return { open, finished }
}
