import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { describeRecoveredWork, recoveredWork, recoveryPlan } from './retryView'

const msg = (over: Partial<ChatMessage>): ChatMessage =>
  ({ id: 'm1', threadId: 't1', role: 'assistant', createdAt: 0, text: '', ...over }) as ChatMessage

/** `n` completed tool rounds, in the wire shape the message persists them in. */
const exchanges = (n: number): ChatMessage['toolExchanges'] =>
  Array.from({ length: n }, (_, i) => [
    { role: 'assistant' as const, content: null, tool_calls: [{ id: `c${i}`, type: 'function' as const, function: { name: 't', arguments: '{}' } }] },
    { role: 'tool' as const, content: 'done', tool_call_id: `c${i}` }
  ]).flat()

describe('recoveredWork', () => {
  it('counts the visible characters and the tool calls behind the reply', () => {
    expect(recoveredWork(msg({ text: '  hello  ', toolExchanges: exchanges(2) }))).toEqual({ chars: 5, tools: 2 })
  })

  it('is zero for a reply that produced nothing', () => {
    expect(recoveredWork(msg({ text: '   ' }))).toEqual({ chars: 0, tools: 0 })
  })

  it('ignores a tool the model was still drafting when the reply died', () => {
    // Only completed rounds persist as `toolExchanges`; a half-issued call leaves a timeline row but
    // nothing to resume from, and the card must not promise to keep it.
    expect(recoveredWork(msg({ text: '', toolExchanges: [] }))).toEqual({ chars: 0, tools: 0 })
  })
})

describe('describeRecoveredWork', () => {
  it('names only the parts that exist, and gets the plurals right', () => {
    expect(describeRecoveredWork({ chars: 1240, tools: 3 })).toBe('1,240 characters and 3 tool calls')
    expect(describeRecoveredWork({ chars: 0, tools: 1 })).toBe('1 tool call')
    expect(describeRecoveredWork({ chars: 1, tools: 0 })).toBe('1 character')
    expect(describeRecoveredWork({ chars: 0, tools: 0 })).toBe('')
  })
})

describe('recoveryPlan', () => {
  it('leads with Resume, and says what is being kept, when there is work behind the reply', () => {
    const plan = recoveryPlan(msg({ status: 'interrupted', text: 'a'.repeat(1240), toolExchanges: exchanges(3) }))
    expect(plan.canResume).toBe(true)
    expect(plan.primaryLabel).toBe('Resume')
    expect(plan.title).toBe('This reply was interrupted. 1,240 characters and 3 tool calls kept.')
    expect(plan.detail).toMatch(/nothing already written or already run is repeated/)
  })

  it('resumes a reply that only ran tools — those calls are exactly what must not be repeated', () => {
    const plan = recoveryPlan(msg({ status: 'error', text: '', toolExchanges: exchanges(1) }))
    expect(plan.canResume).toBe(true)
    expect(plan.title).toBe('This reply failed. 1 tool call kept.')
  })

  it('offers a plain retry when the reply produced nothing — resuming would be the same thing', () => {
    const plan = recoveryPlan(msg({ status: 'error', text: '' }))
    expect(plan.canResume).toBe(false)
    expect(plan.primaryLabel).toBe('Try again')
    expect(plan.title).toBe('This reply failed.')
    expect(plan.detail).toMatch(/nothing to pick up from/)
  })

  it('distinguishes an interruption from a failure', () => {
    expect(recoveryPlan(msg({ status: 'interrupted', text: '' })).title).toBe('This reply was interrupted.')
    expect(recoveryPlan(msg({ status: 'error', text: '' })).title).toBe('This reply failed.')
  })
})
