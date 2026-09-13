import type { ChatMessage } from '@shared/types'

/**
 * Which assistant replies just finished in the open thread: ids that were running (no status) in
 * `previous` and are complete in `next`. Replies that were already settled when the thread was
 * opened never count, so opening an old thread does not start reading its history aloud, and an
 * interrupted or failed reply is not read either.
 */
export function newlyFinishedReplies(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  const running = new Set(previous.filter((message) => message.role === 'assistant' && message.status === undefined).map((message) => message.id))
  if (running.size === 0) return []
  return next.filter((message) => message.role === 'assistant' && running.has(message.id) && message.status === 'complete' && message.text.trim())
}
