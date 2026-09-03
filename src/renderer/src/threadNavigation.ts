import type { ChatMessage, RunEvent, ThreadMeta } from '@shared/types'

export type ThreadNavigationDirection = 'next' | 'previous'

/**
 * Whether leaving a fresh thread should discard it instead of leaving an empty/failed entry in the
 * sidebar. Successful first turns are protected even while their auto-title is still being written.
 */
export function shouldDiscardNewThread(
  meta: Pick<ThreadMeta, 'title' | 'running'> | null | undefined,
  messages: ChatMessage[],
  events: RunEvent[],
  isNewThread = meta?.title === 'New thread'
): boolean {
  if (!meta || !isNewThread) return false

  const firstUser = messages.find((message) => message.role === 'user' && !message.queued)
  const firstAssistant = firstUser
    ? messages.find((message) => message.role === 'assistant' && message.createdAt >= firstUser.createdAt)
    : undefined
  const firstRunId = firstAssistant?.runId ?? events.find((event) => event.body.type === 'run.started')?.runId

  const firstTurnErrored =
    firstAssistant?.status === 'error' ||
    events.some(
      (event) =>
        event.body.type === 'error' && (firstRunId === undefined || event.runId === firstRunId)
    )
  if (firstTurnErrored) return true

  // A run may have persisted the user message but not reached the assistant placeholder yet. Keep
  // that thread while it is live; once idle, it is an incomplete first send and safe to discard.
  return (!meta.running && messages.length === 0) || (!meta.running && !!firstUser && !firstAssistant)
}

/**
 * Return the adjacent visible thread in the store/sidebar order.
 * Archived threads are intentionally excluded because they are not part of the active chat list.
 */
export function adjacentThreadId(
  threads: Pick<ThreadMeta, 'id' | 'archived'>[],
  activeThreadId: string | null,
  direction: ThreadNavigationDirection
): string | null {
  const visible = threads.filter((thread) => !thread.archived)
  if (visible.length === 0) return null

  const currentIndex = visible.findIndex((thread) => thread.id === activeThreadId)
  if (currentIndex < 0) {
    return direction === 'next' ? visible[0]?.id ?? null : visible[visible.length - 1]?.id ?? null
  }
  if (visible.length === 1) return null

  const step = direction === 'next' ? 1 : -1
  return visible[(currentIndex + step + visible.length) % visible.length]?.id ?? null
}
