import type { RunId, SubagentStatus, ThreadId } from '@shared/types'
import type { SubagentCollect, SubagentView } from '../tools/types'

/**
 * Registry and message channel for concurrent subagents.
 *
 * A subagent is spawned by the parent run's `run_agent` tool and then runs in the BACKGROUND —
 * the tool returns a handle immediately instead of blocking until the subagent finishes. This
 * module owns the shared state that lets the parent keep talking to a live subagent: an inbox the
 * parent fills with `message_agent`, a status the UI renders, and the accumulated output that
 * `collect_agent` reads. The agentic loop itself lives in runManager; it drives a record through
 * this module's helpers (nextMessage / setStatus / finish).
 *
 * Records are keyed by agentId and scoped to a parent run, so name lookups ("scout") never collide
 * across concurrent runs, and `stopAllForRun` can tear a run's whole fleet down when it ends.
 */
export interface SubagentRecord {
  agentId: string
  name: string
  parentRunId: RunId
  threadId: ThreadId
  task: string
  model?: string
  status: SubagentStatus
  createdAt: number
  /** accumulated assistant output across every turn — what collect() returns */
  output: string
  /** terminal failure detail surfaced by list_agents / collect_agent */
  error?: string
  toolCalls: number
  /** messages from the parent waiting to be injected at the subagent's next safe boundary */
  inbox: string[]
  /** its own abort (a child of the parent run's abort); stop() and run-end trip this */
  abort: AbortController
  stopped: boolean
  /** resolver that wakes a parked (idle) loop when a message arrives or it is stopped */
  wake: (() => void) | null
  /** resolvers waiting for the subagent to reach a settled (idle/terminal) status */
  settleWaiters: (() => void)[]
}

const SETTLED = new Set<SubagentStatus>(['idle', 'done', 'error', 'canceled'])
const TERMINAL = new Set<SubagentStatus>(['done', 'error', 'canceled'])

/** agentId → record, across all runs. */
const records = new Map<string, SubagentRecord>()

export const MAX_ACTIVE_SUBAGENTS_PER_RUN = 8
export const MAX_TOTAL_SUBAGENTS_PER_RUN = 32

export function registerSubagent(init: {
  agentId: string
  name: string
  parentRunId: RunId
  threadId: ThreadId
  task: string
  model?: string
  abort: AbortController
}): SubagentRecord {
  const record: SubagentRecord = {
    ...init,
    status: 'starting',
    createdAt: Date.now(),
    output: '',
    toolCalls: 0,
    inbox: [],
    stopped: false,
    wake: null,
    settleWaiters: []
  }
  records.set(init.agentId, record)
  return record
}

/** A short, unique, model-friendly fallback name for a run's subagents ("agent-1", "agent-2", …). */
export function suggestName(parentRunId: RunId, requested: string | undefined): string {
  const clean = (requested ?? '').trim().replace(/\s+/g, '-').slice(0, 40)
  const taken = new Set(listForRun(parentRunId).map((r) => r.name.toLowerCase()))
  if (clean && !taken.has(clean.toLowerCase())) return clean
  const base = clean || 'agent'
  for (let i = clean ? 2 : 1; ; i++) {
    const candidate = `${base}-${i}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
}

export function listForRun(parentRunId: RunId): SubagentRecord[] {
  return [...records.values()]
    .filter((r) => r.parentRunId === parentRunId)
    .sort((a, b) => a.createdAt - b.createdAt)
}

/** Resolve a `message_agent`/`collect_agent` ref (a name or an agentId) within one run. */
export function resolveRef(parentRunId: RunId, ref: string): SubagentRecord | null {
  const needle = ref.trim().toLowerCase()
  const mine = listForRun(parentRunId)
  const byId = mine.find((r) => r.agentId.toLowerCase() === needle)
  if (byId) return byId
  // Prefer a live (non-terminal) match, then fall back to the most recent by name.
  const byName = mine.filter((r) => r.name.toLowerCase() === needle)
  return byName.find((r) => !TERMINAL.has(r.status)) ?? byName[byName.length - 1] ?? null
}

export function toView(r: SubagentRecord): SubagentView {
  const lastLine = r.output.trim().split('\n').filter(Boolean).pop()?.slice(-120)
  return { agentId: r.agentId, name: r.name, status: r.status, toolCalls: r.toolCalls, lastLine, error: r.error }
}

/** A model-readable refusal when a run's fleet reaches a safe concurrency or total ceiling. */
export function spawnCapacityError(parentRunId: RunId): string | null {
  const mine = listForRun(parentRunId)
  const active = mine.filter(
    (record) => !record.stopped && !record.abort.signal.aborted && !TERMINAL.has(record.status)
  ).length
  if (active >= MAX_ACTIVE_SUBAGENTS_PER_RUN)
    return `This run already has ${active} active subagents (limit ${MAX_ACTIVE_SUBAGENTS_PER_RUN}). Collect or stop one before spawning another.`
  if (mine.length >= MAX_TOTAL_SUBAGENTS_PER_RUN)
    return `This run has already spawned ${mine.length} subagents (limit ${MAX_TOTAL_SUBAGENTS_PER_RUN}). Reuse an existing agent instead.`
  return null
}

/** Move a record to a new status and wake anything waiting on it to settle. */
export function setStatus(record: SubagentRecord, status: SubagentStatus): void {
  record.status = status
  if (SETTLED.has(status)) {
    const waiters = record.settleWaiters
    record.settleWaiters = []
    for (const w of waiters) w()
  }
}

/** Queue a message for a subagent and wake it if it is parked idle. */
export function enqueueMessage(
  parentRunId: RunId,
  ref: string,
  text: string
): { ok: boolean; agentId?: string; name?: string; status?: string; error?: string } {
  const record = resolveRef(parentRunId, ref)
  if (!record) return { ok: false, error: `No subagent named "${ref}" in this run.` }
  if (record.stopped || record.abort.signal.aborted || TERMINAL.has(record.status))
    return { ok: false, agentId: record.agentId, name: record.name, status: record.status, error: `Subagent "${record.name}" has already ${record.status}; spawn a new one.` }
  record.inbox.push(text)
  // Claim the next turn synchronously before waking the parked loop. Top-level tool calls in one
  // model response execute concurrently, so `message_agent` and `collect_agent(wait=true)` may
  // start in the same Promise.all batch. Leaving the record `idle` here would let collect return
  // the stale pre-message answer before the loop gets its microtask and emits `running`.
  if (record.status === 'idle') setStatus(record, 'running')
  const wake = record.wake
  record.wake = null
  wake?.()
  return { ok: true, agentId: record.agentId, name: record.name, status: record.status }
}

/**
 * Await the next message for a parked subagent. Resolves as soon as the inbox is non-empty, or the
 * subagent is stopped / aborted (in which case the caller should exit). Does not dequeue — the loop
 * drains `record.inbox` itself.
 */
export function nextMessage(record: SubagentRecord): Promise<void> {
  if (record.inbox.length || record.stopped || record.abort.signal.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let done = false
    const settle = (): void => {
      if (done) return
      done = true
      if (record.wake === settle) record.wake = null
      record.abort.signal.removeEventListener('abort', settle)
      resolve()
    }
    record.wake = settle
    record.abort.signal.addEventListener('abort', settle, { once: true })
  })
}

/** Read a subagent's output; when `wait`, resolve once it settles (idle or terminal). */
export async function collect(parentRunId: RunId, ref: string, wait: boolean): Promise<SubagentCollect> {
  const record = resolveRef(parentRunId, ref)
  if (!record) return { ok: false, error: `No subagent named "${ref}" in this run.` }
  if (wait && !SETTLED.has(record.status)) {
    await new Promise<void>((resolve) => record.settleWaiters.push(resolve))
  }
  return {
    ok: record.status !== 'error',
    agentId: record.agentId,
    name: record.name,
    status: record.status,
    result: record.output,
    toolCalls: record.toolCalls,
    error: record.error
  }
}

/** Stop one subagent (aborts its in-flight work). */
export function stop(parentRunId: RunId, ref: string): { ok: boolean; name?: string; error?: string } {
  const record = resolveRef(parentRunId, ref)
  if (!record) return { ok: false, error: `No subagent named "${ref}" in this run.` }
  record.stopped = true
  record.abort.abort()
  const wake = record.wake
  record.wake = null
  wake?.()
  return { ok: true, name: record.name }
}

/** Tear down every subagent belonging to a run (called when the parent run ends). */
export function stopAllForRun(parentRunId: RunId): void {
  for (const record of listForRun(parentRunId)) {
    record.stopped = true
    record.abort.abort()
    const wake = record.wake
    record.wake = null
    wake?.()
    records.delete(record.agentId)
  }
}

/** Test/inspection helper: how many records are live. */
export function activeCount(): number {
  return records.size
}
