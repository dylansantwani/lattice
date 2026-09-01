import { describe, expect, it, vi } from 'vitest'
import type { AskRequest } from '@shared/types'
import { listPendingAsks, requestAsk, resolveAsk } from './asks'

let seq = 0
function makeRequest(over: Partial<AskRequest> = {}): AskRequest {
  seq += 1
  return {
    id: `ask_${seq}`,
    runId: `run_${seq}`,
    threadId: `thread_${seq}`,
    callId: `call_${seq}`,
    question: 'Which port should the server bind to?',
    kind: 'text',
    ...over
  }
}

describe('ask broker', () => {
  it('pushes the question and resolves with the answer the user gives', async () => {
    const push = vi.fn()
    const req = makeRequest()
    const p = requestAsk(req, push, new AbortController().signal)
    expect(push).toHaveBeenCalledWith({ kind: 'ask.request', request: req })
    expect(listPendingAsks().some((r) => r.id === req.id)).toBe(true)

    const ok = resolveAsk({ requestId: req.id, answer: '8080' }, push)
    expect(ok).toBe(true)
    const res = await p
    expect(res).toMatchObject({ answer: '8080' })
    expect(listPendingAsks().some((r) => r.id === req.id)).toBe(false)
    expect(push).toHaveBeenCalledWith({ kind: 'ask.resolved', requestId: req.id })
  })

  it('resolves as canceled when the run is aborted while waiting', async () => {
    const push = vi.fn()
    const ac = new AbortController()
    const req = makeRequest()
    const p = requestAsk(req, push, ac.signal)
    ac.abort()
    const res = await p
    expect(res.canceled).toBe(true)
    expect(res.answer).toBe('')
    expect(listPendingAsks().some((r) => r.id === req.id)).toBe(false)
  })

  it('resolves immediately as canceled if the signal is already aborted', async () => {
    const push = vi.fn()
    const ac = new AbortController()
    ac.abort()
    const req = makeRequest()
    const res = await requestAsk(req, push, ac.signal)
    expect(res.canceled).toBe(true)
    expect(listPendingAsks().some((r) => r.id === req.id)).toBe(false)
  })

  it('returns false when resolving an unknown question', () => {
    expect(resolveAsk({ requestId: 'nope', answer: 'x' }, vi.fn())).toBe(false)
  })
})
