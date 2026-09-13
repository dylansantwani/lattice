import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { newlyFinishedReplies } from './autoRead'

const msg = (id: string, patch: Partial<ChatMessage> = {}): ChatMessage => ({ id, threadId: 't', role: 'assistant', createdAt: 0, text: 'Done.', ...patch })

describe('newlyFinishedReplies', () => {
  it('returns a reply that went from running to complete', () => {
    const before = [msg('u', { role: 'user', text: 'hi' }), msg('a', { status: undefined, text: 'Do' })]
    const after = [before[0]!, msg('a', { status: 'complete', text: 'Done.' })]
    expect(newlyFinishedReplies(before, after).map((m) => m.id)).toEqual(['a'])
  })

  it('ignores replies that were already settled, failed, interrupted, or empty', () => {
    const settled = [msg('old', { status: 'complete' })]
    expect(newlyFinishedReplies(settled, settled)).toEqual([])
    const running = [msg('e', { status: undefined }), msg('i', { status: undefined }), msg('z', { status: undefined })]
    const ended = [msg('e', { status: 'error' }), msg('i', { status: 'interrupted' }), msg('z', { status: 'complete', text: '  ' })]
    expect(newlyFinishedReplies(running, ended)).toEqual([])
  })

  it('does not read a thread opened with settled history', () => {
    expect(newlyFinishedReplies([], [msg('a', { status: 'complete' }), msg('b', { status: 'complete' })])).toEqual([])
  })
})
