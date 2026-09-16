import { describe, expect, it, vi } from 'vitest'
import type { ApprovalRequest } from '@shared/types'
import { isGranted, listPendingApprovals, requestApproval, resolveApproval } from './approvals'

let seq = 0
function makeRequest(over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  seq += 1
  return {
    id: `req_${seq}`,
    runId: `run_${seq}`,
    threadId: `thread_${seq}`,
    callId: `call_${seq}`,
    tool: 'shell',
    args: { command: 'ls' },
    summary: 'Run: ls',
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    ...over
  }
}

describe('approval broker', () => {
  it('pushes a request and resolves the promise when the user allows', async () => {
    const push = vi.fn()
    const req = makeRequest()
    const p = requestApproval(req, req.tool, push, new AbortController().signal)
    expect(push).toHaveBeenCalledWith({ kind: 'approval.request', request: req })
    expect(listPendingApprovals().some((r) => r.id === req.id)).toBe(true)

    const ok = resolveApproval({ requestId: req.id, effect: 'allow', scope: 'once' }, push)
    expect(ok).toBe(true)
    const decision = await p
    expect(decision.effect).toBe('allow')
    expect(listPendingApprovals().some((r) => r.id === req.id)).toBe(false)
    expect(push).toHaveBeenCalledWith({ kind: 'approval.resolved', requestId: req.id })
  })

  it('denies automatically when the run is aborted while waiting', async () => {
    const push = vi.fn()
    const ac = new AbortController()
    const req = makeRequest()
    const p = requestApproval(req, req.tool, push, ac.signal)
    ac.abort()
    const decision = await p
    expect(decision.effect).toBe('deny')
    expect(listPendingApprovals().some((r) => r.id === req.id)).toBe(false)
    expect(push).toHaveBeenCalledWith({ kind: 'approval.resolved', requestId: req.id })
  })

  it('remembers a run-scoped grant so the same tool is not asked again', async () => {
    const push = vi.fn()
    const req = makeRequest({ runId: 'run_X', threadId: 'thread_X', tool: 'shell' })
    expect(isGranted('thread_X', 'run_X', 'shell')).toBe(false)
    const p = requestApproval(req, 'shell', push, new AbortController().signal)
    resolveApproval({ requestId: req.id, effect: 'allow', scope: 'run' }, push)
    await p
    expect(isGranted('thread_X', 'run_X', 'shell')).toBe(true)
    // a different run in the same thread is NOT covered by a run-scoped grant
    expect(isGranted('thread_X', 'run_OTHER', 'shell')).toBe(false)
  })

  it('isolates run-scoped grants between the main run and each subagent', async () => {
    const push = vi.fn()
    const req = makeRequest({
      runId: 'run_shared',
      threadId: 'thread_shared',
      principal: { kind: 'subagent', id: 'agent_A', name: 'Scout' }
    })
    const p = requestApproval(req, 'shell', push, new AbortController().signal)
    resolveApproval({ requestId: req.id, effect: 'allow', scope: 'run' }, push)
    await p

    expect(isGranted('thread_shared', 'run_shared', 'shell', 'agent:agent_A')).toBe(true)
    expect(isGranted('thread_shared', 'run_shared', 'shell', 'agent:agent_B')).toBe(false)
    expect(isGranted('thread_shared', 'run_shared', 'shell')).toBe(false)
  })

  it('remembers a thread-scoped grant across runs', async () => {
    const push = vi.fn()
    const req = makeRequest({ runId: 'run_A', threadId: 'thread_T', tool: 'fs_delete' })
    const p = requestApproval(req, 'fs_delete', push, new AbortController().signal)
    resolveApproval({ requestId: req.id, effect: 'allow', scope: 'thread' }, push)
    await p
    expect(isGranted('thread_T', 'run_A', 'fs_delete')).toBe(true)
    expect(isGranted('thread_T', 'run_LATER', 'fs_delete')).toBe(true)
    expect(isGranted('thread_T', 'run_LATER', 'fs_delete', 'agent:agent_A')).toBe(true)
  })

  it('does not remember a once-scoped grant', async () => {
    const push = vi.fn()
    const req = makeRequest({ runId: 'run_O', threadId: 'thread_O', tool: 'shell' })
    const p = requestApproval(req, 'shell', push, new AbortController().signal)
    resolveApproval({ requestId: req.id, effect: 'allow', scope: 'once' }, push)
    await p
    expect(isGranted('thread_O', 'run_O', 'shell')).toBe(false)
  })

  it('returns false when resolving an unknown request', () => {
    expect(resolveApproval({ requestId: 'nope', effect: 'allow', scope: 'once' }, vi.fn())).toBe(false)
  })
})
