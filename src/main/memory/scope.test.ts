import { describe, expect, it } from 'vitest'
import { isMemoryInScope, isMemoryLive } from './scope'

describe('isMemoryInScope — the one predicate both the prompt lane and recall use', () => {
  it('user scope is visible everywhere', () => {
    expect(isMemoryInScope({ scope: 'user' }, 't1', 'w1')).toBe(true)
    expect(isMemoryInScope({ scope: 'user' }, undefined, undefined)).toBe(true)
  })

  it('workspace/project scope is visible only inside that workspace (unscoped = global)', () => {
    expect(isMemoryInScope({ scope: 'workspace', scopeId: 'w1' }, 't1', 'w1')).toBe(true)
    expect(isMemoryInScope({ scope: 'workspace', scopeId: 'w2' }, 't1', 'w1')).toBe(false)
    expect(isMemoryInScope({ scope: 'project', scopeId: 'w2' }, 't1', 'w1')).toBe(false)
    expect(isMemoryInScope({ scope: 'workspace' }, 't1', 'w1')).toBe(true)
  })

  it('thread scope is visible only from that thread', () => {
    expect(isMemoryInScope({ scope: 'thread', scopeId: 't1' }, 't1', 'w1')).toBe(true)
    expect(isMemoryInScope({ scope: 'thread', scopeId: 't1' }, 't2', 'w1')).toBe(false)
    expect(isMemoryInScope({ scope: 'thread', scopeId: 't1' }, undefined, 'w1')).toBe(false)
  })

  it('run/agent scopes are never surfaced', () => {
    expect(isMemoryInScope({ scope: 'run', scopeId: 'r1' }, 't1', 'w1')).toBe(false)
    expect(isMemoryInScope({ scope: 'agent', scopeId: 'a1' }, 't1', 'w1')).toBe(false)
  })
})

describe('isMemoryLive', () => {
  it('requires approved and unexpired', () => {
    expect(isMemoryLive({ status: 'approved' })).toBe(true)
    expect(isMemoryLive({ status: 'approved', expiresAt: 10 }, 20)).toBe(false)
    expect(isMemoryLive({ status: 'approved', expiresAt: 30 }, 20)).toBe(true)
    expect(isMemoryLive({ status: 'proposed' })).toBe(false)
    expect(isMemoryLive({ status: 'expired' })).toBe(false)
  })
})
