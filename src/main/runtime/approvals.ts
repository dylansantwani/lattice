import type { ApprovalDecision, ApprovalRequest, ApprovalScope, PermissionAction, PermissionEffect, PermissionResource, PermissionRule } from '@shared/types'
import type { PushEvent } from '@shared/ipc'

/**
 * The approval broker. When a tool's effect under the current preset is "ask", the
 * run manager parks the call here: a request is pushed to the renderer, and the
 * returned promise resolves once the user responds (or the run is canceled).
 *
 * Grants are remembered in-memory for `run`/`thread` scope so the user isn't asked
 * again for the same tool within that scope. (Durable, cross-session `profile`
 * rules would live in the event store; here `profile` is treated as thread-wide.)
 */

type PushFn = (event: PushEvent) => void

interface Pending {
  request: ApprovalRequest
  settle: (decision: ApprovalDecision) => void
}

const pending = new Map<string, Pending>()
const grants = new Set<string>()
const threadRules = new Map<string, PermissionRule[]>()

const grantKey = (scope: 'run' | 'thread', scopeId: string, toolKey: string): string =>
  `${scope}:${scopeId}:${toolKey}`

export function listPendingApprovals(): ApprovalRequest[] {
  return [...pending.values()].map((p) => p.request)
}

/** Has the user already granted this tool for the current run or thread? */
export function isGranted(threadId: string, runId: string, toolKey: string): boolean {
  return grants.has(grantKey('run', runId, toolKey)) || grants.has(grantKey('thread', threadId, toolKey))
}

/** Replace the ephemeral rules supplied by a CLI session for one thread. Denies win on overlap. */
export function setThreadRules(threadId: string, rules: PermissionRule[]): void {
  threadRules.set(threadId, [...rules])
}

export function clearThreadRules(threadId: string): void {
  threadRules.delete(threadId)
}

function globMatches(pattern: string, value: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')
  return new RegExp(`^${escaped}$`, 'i').test(value)
}

/** Return a CLI rule decision for a tool call, if one was seeded for this thread. */
export function threadRuleEffect(
  threadId: string,
  resource: PermissionResource,
  action: PermissionAction,
  scopeText: string
): PermissionEffect | undefined {
  const rules = threadRules.get(threadId) ?? []
  const matches = rules.filter((rule) => {
    if (rule.resource !== resource || rule.action !== action) return false
    return !rule.scope || globMatches(rule.scope, scopeText)
  })
  if (matches.some((rule) => rule.effect === 'deny')) return 'deny'
  if (matches.some((rule) => rule.effect === 'allow')) return 'allow'
  return undefined
}

function recordGrant(
  scope: ApprovalScope,
  threadId: string,
  runId: string,
  toolKey: string
): void {
  if (scope === 'run') grants.add(grantKey('run', runId, toolKey))
  else if (scope === 'thread' || scope === 'profile') grants.add(grantKey('thread', threadId, toolKey))
  // 'once' → no memory
}

/**
 * Park a tool call awaiting the user's decision. Resolves with the decision, or a
 * synthetic deny if the run is aborted while waiting.
 */
export function requestApproval(
  request: ApprovalRequest,
  toolKey: string,
  push: PushFn,
  signal: AbortSignal
): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    let done = false
    const settle = (decision: ApprovalDecision): void => {
      if (done) return
      done = true
      pending.delete(request.id)
      signal.removeEventListener('abort', onAbort)
      if (decision.effect === 'allow') recordGrant(decision.scope, request.threadId, request.runId, toolKey)
      resolve(decision)
    }
    const onAbort = (): void => settle({ requestId: request.id, effect: 'deny', scope: 'once' })

    pending.set(request.id, { request, settle })
    push({ kind: 'approval.request', request })
    if (signal.aborted) return onAbort()
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** Called by the IPC layer when the user answers. Returns false if unknown/stale. */
export function resolveApproval(decision: ApprovalDecision, push: PushFn): boolean {
  const entry = pending.get(decision.requestId)
  if (!entry) return false
  push({ kind: 'approval.resolved', requestId: decision.requestId })
  entry.settle(decision)
  return true
}
