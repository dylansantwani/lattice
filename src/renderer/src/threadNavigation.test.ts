import { describe, expect, it } from 'vitest'
import type { ChatMessage, RunEvent } from '@shared/types'
import { adjacentThreadId, shouldDiscardNewThread } from './threadNavigation'

const thread = (id: string, archived = false) => ({ id, archived })

const meta = (title = 'New thread', running = false) => ({ title, running })

let clock = 0
const userMsg = (runId?: string): ChatMessage =>
  ({ id: `u${clock}`, threadId: 't', role: 'user', text: 'hi', createdAt: clock++, runId }) as ChatMessage
const assistantMsg = (runId: string, status: ChatMessage['status'] = 'complete'): ChatMessage =>
  ({ id: `a${clock}`, threadId: 't', role: 'assistant', text: 'ok', createdAt: clock++, runId, status }) as ChatMessage

const errorEvent = (runId: string, agent?: string): RunEvent =>
  ({
    id: `e${clock}`,
    runId,
    threadId: 't',
    seq: clock++,
    ts: clock,
    agent,
    body: { type: 'error', category: 'unknown', message: 'boom', retryable: false }
  }) as RunEvent

describe('shouldDiscardNewThread', () => {
  it('keeps threads that are not new', () => {
    expect(shouldDiscardNewThread(meta('My chat'), [], [], false)).toBe(false)
  })

  it('discards an empty, idle new thread', () => {
    expect(shouldDiscardNewThread(meta(), [], [])).toBe(true)
  })

  it('keeps a new thread while its first turn is still live', () => {
    expect(shouldDiscardNewThread(meta('New thread', true), [userMsg('r1')], [])).toBe(false)
  })

  it('discards a new thread whose own first turn errored', () => {
    const user = userMsg('r1')
    const assistant = assistantMsg('r1', 'error')
    expect(shouldDiscardNewThread(meta(), [user, assistant], [errorEvent('r1')])).toBe(true)
  })

  it('keeps a new thread with a successful first turn even when a subagent errored', () => {
    // The subagent reuses the parent run id ('r1') and is tagged with an agent id. Its failure must
    // not delete the healthy parent thread.
    const user = userMsg('r1')
    const assistant = assistantMsg('r1', 'complete')
    const subagentError = errorEvent('r1', 'agent-xyz')
    expect(shouldDiscardNewThread(meta(), [user, assistant], [subagentError])).toBe(false)
  })

  it('still discards a new thread whose parent error shares the run id with a subagent error', () => {
    // Both a parent-turn error and a subagent error on the same run id: the parent's own failure
    // (untagged) still counts, so a genuinely-failed first turn is discarded.
    const user = userMsg('r1')
    expect(shouldDiscardNewThread(meta(), [user], [errorEvent('r1', 'agent-xyz'), errorEvent('r1')])).toBe(true)
  })
})

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
