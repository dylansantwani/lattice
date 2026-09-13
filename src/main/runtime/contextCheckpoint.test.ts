import { describe, expect, it } from 'vitest'
import { acceptCompactionSummary, buildCompactionInput, selectLiveMessages } from './contextCheckpoint'

describe('context checkpoint', () => {
  const messages = [
    { id: 'u1', threadId: 't', role: 'user', createdAt: 1, text: 'Keep the API backward compatible.\n[ ] run tests' },
    { id: 'a1', threadId: 't', role: 'assistant', createdAt: 2, text: '', toolExchanges: [
      { role: 'tool', tool_call_id: 'call-1', name: 'fs_read', content: 'found authoritative fact' }
    ] },
    { id: 'old', threadId: 't', role: 'assistant', createdAt: 3, text: 'folded', compacted: true }
  ] as any

  it('keeps tool-only turns and excludes compacted/preserved messages', () => {
    expect(selectLiveMessages(messages)).toHaveLength(2)
    expect(selectLiveMessages(messages, 'a1')).toHaveLength(1)
  })

  it('puts tool evidence and deterministic checkpoint references in the input', () => {
    const input = buildCompactionInput(messages)
    expect(input.transcript).toContain('found authoritative fact')
    expect(input.transcript).toContain('callId=call-1')
    expect(input.transcript).toContain('Keep the API backward compatible.')
    expect(input.transcript).toContain('OPEN CHECKLIST')
  })

  it('rejects empty and non-reducing summaries', () => {
    expect(acceptCompactionSummary({ summary: ' ', beforeChars: 100 }).accepted).toBe(false)
    expect(acceptCompactionSummary({ summary: 'x'.repeat(100), beforeChars: 100 }).accepted).toBe(false)
    expect(acceptCompactionSummary({ summary: 'short', beforeChars: 100 }).accepted).toBe(true)
  })
})
