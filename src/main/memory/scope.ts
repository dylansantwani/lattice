import type { MemoryItem } from '@shared/types'

/**
 * The ONE scope predicate for memory recall. Both lanes that put memory in front of the model —
 * the pinned block in the system prompt and the `memory_search` tool — must agree on what a
 * thread may see: user-scope everywhere, workspace/project-scope only inside that workspace (an
 * unscoped workspace item is global), thread-scope only inside that thread. Anything else (run,
 * agent) is never surfaced. Factored out so the two call sites cannot drift.
 */
export function isMemoryInScope(
  m: Pick<MemoryItem, 'scope' | 'scopeId'>,
  threadId: string | undefined,
  workspaceId: string | undefined
): boolean {
  switch (m.scope) {
    case 'user':
      return true
    case 'workspace':
    case 'project':
      return !m.scopeId || m.scopeId === workspaceId
    case 'thread':
      return !!threadId && m.scopeId === threadId
    default:
      return false
  }
}

/** Approved, unexpired, and visible from (threadId, workspaceId): the prompt-injection predicate. */
export function isMemoryLive(m: Pick<MemoryItem, 'status' | 'expiresAt'>, now = Date.now()): boolean {
  return m.status === 'approved' && (!m.expiresAt || m.expiresAt > now)
}
