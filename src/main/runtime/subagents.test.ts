import { describe, expect, it } from 'vitest'
import {
  collect,
  enqueueMessage,
  listForRun,
  MAX_ACTIVE_SUBAGENTS_PER_RUN,
  MAX_TOTAL_SUBAGENTS_PER_RUN,
  nextMessage,
  registerSubagent,
  resolveRef,
  setStatus,
  spawnCapacityError,
  stop,
  stopAllForRun,
  suggestName,
  toView
} from './subagents'

const reg = (runId: string, name: string): ReturnType<typeof registerSubagent> =>
  registerSubagent({
    agentId: `${runId}:${name}:${Math.random().toString(36).slice(2)}`,
    name,
    parentRunId: runId,
    threadId: 't1',
    task: 'do a thing',
    abort: new AbortController()
  })

describe('subagent registry', () => {
  it('scopes names to a run and dedupes collisions', () => {
    const run = 'run-names'
    const a = reg(run, 'scout')
    expect(a.name).toBe('scout')
    // suggestName sees the already-registered "scout" and picks the next free handle
    expect(suggestName(run, 'scout')).toBe('scout-2')
    // a different run is independent
    expect(suggestName('other-run', 'scout')).toBe('scout')
    stopAllForRun(run)
    stopAllForRun('other-run')
  })

  it('assigns agent-1 as the first unnamed fallback and increments from there', () => {
    const run = 'run-fallback-names'
    expect(suggestName(run, undefined)).toBe('agent-1')
    reg(run, 'agent-1')
    expect(suggestName(run, undefined)).toBe('agent-2')
    stopAllForRun(run)
  })

  it('resolves a ref by name or id, preferring a live match', () => {
    const run = 'run-resolve'
    const a = reg(run, 'alpha')
    setStatus(a, 'done')
    const b = registerSubagent({
      agentId: 'fixed-id-b',
      name: 'alpha',
      parentRunId: run,
      threadId: 't1',
      task: 't',
      abort: new AbortController()
    })
    setStatus(b, 'running')
    // two "alpha"s: the live (running) one wins over the finished one
    expect(resolveRef(run, 'alpha')?.agentId).toBe(b.agentId)
    // exact id still resolves the specific record
    expect(resolveRef(run, 'fixed-id-b')?.agentId).toBe(b.agentId)
    expect(resolveRef(run, 'nope')).toBeNull()
    stopAllForRun(run)
  })

  it('delivers messages and wakes a parked loop', async () => {
    const run = 'run-msg'
    const a = reg(run, 'worker')
    setStatus(a, 'idle')
    const parked = nextMessage(a) // idle, empty inbox → pending
    let woke = false
    void parked.then(() => {
      woke = true
    })
    const res = enqueueMessage(run, 'worker', 'next step please')
    expect(res.ok).toBe(true)
    await parked
    expect(woke).toBe(true)
    expect(a.inbox).toEqual(['next step please'])
    expect(a.status).toBe('running')
    stopAllForRun(run)
  })

  it('makes collect(wait) wait for the answer to a newly queued message', async () => {
    const run = 'run-message-then-collect'
    const a = reg(run, 'worker')
    a.output = 'old answer'
    setStatus(a, 'idle')

    enqueueMessage(run, 'worker', 'please revise')
    expect(a.status).toBe('running')
    const pending = collect(run, 'worker', true)
    let resolved = false
    void pending.then(() => {
      resolved = true
    })
    await Promise.resolve()
    expect(resolved).toBe(false)

    a.output = 'revised answer'
    setStatus(a, 'idle')
    const result = await pending
    expect(result.result).toBe('revised answer')
    stopAllForRun(run)
  })

  it('refuses messaging a finished subagent', () => {
    const run = 'run-finished'
    const a = reg(run, 'done-one')
    setStatus(a, 'done')
    const res = enqueueMessage(run, 'done-one', 'hi')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/already done/i)
    stopAllForRun(run)
  })

  it('refuses messaging immediately after stop, before the loop posts terminal status', () => {
    const run = 'run-stopped-message'
    reg(run, 'stopped-one')
    stop(run, 'stopped-one')
    const res = enqueueMessage(run, 'stopped-one', 'too late')
    expect(res.ok).toBe(false)
    expect(res.error).toMatch(/already/i)
    stopAllForRun(run)
  })

  it('collect(wait) resolves once the subagent settles', async () => {
    const run = 'run-collect'
    const a = reg(run, 'thinker')
    setStatus(a, 'running')
    a.output = 'partial'
    const pending = collect(run, 'thinker', true)
    a.output = 'final answer'
    setStatus(a, 'idle') // settling wakes the waiter
    const res = await pending
    expect(res.ok).toBe(true)
    expect(res.result).toBe('final answer')
    expect(res.status).toBe('idle')
    stopAllForRun(run)
  })

  it('stop aborts the subagent and stopAllForRun clears the run', () => {
    const run = 'run-stop'
    const a = reg(run, 'x')
    const b = reg(run, 'y')
    const stopped = stop(run, 'x')
    expect(stopped.ok).toBe(true)
    expect(a.abort.signal.aborted).toBe(true)
    expect(listForRun(run).length).toBe(2)
    stopAllForRun(run)
    expect(listForRun(run).length).toBe(0)
    expect(b.abort.signal.aborted).toBe(true)
  })

  it('toView surfaces name, status, and a last-line snippet', () => {
    const run = 'run-view'
    const a = reg(run, 'viewer')
    a.output = 'line one\nline two is the latest'
    a.toolCalls = 3
    setStatus(a, 'running')
    const v = toView(a)
    expect(v).toMatchObject({ name: 'viewer', status: 'running', toolCalls: 3 })
    expect(v.lastLine).toContain('latest')
    stopAllForRun(run)
  })

  it('surfaces terminal failures through collect and list views', async () => {
    const run = 'run-error-view'
    const a = reg(run, 'broken')
    a.output = 'partial output'
    a.error = 'provider failed'
    setStatus(a, 'error')
    expect(toView(a)).toMatchObject({ status: 'error', error: 'provider failed' })
    expect(await collect(run, 'broken', false)).toMatchObject({
      ok: false,
      status: 'error',
      result: 'partial output',
      error: 'provider failed'
    })
    stopAllForRun(run)
  })

  it('caps active fan-out and releases a slot when an agent becomes terminal', () => {
    const run = 'run-active-cap'
    const agents = Array.from({ length: MAX_ACTIVE_SUBAGENTS_PER_RUN }, (_, i) => reg(run, `a-${i}`))
    expect(spawnCapacityError(run)).toMatch(/active subagents/)
    stop(run, agents[0]!.name)
    expect(spawnCapacityError(run)).toBeNull()
    stopAllForRun(run)
  })

  it('caps total subagents spawned within one parent run', () => {
    const run = 'run-total-cap'
    for (let i = 0; i < MAX_TOTAL_SUBAGENTS_PER_RUN; i++) {
      const a = reg(run, `a-${i}`)
      setStatus(a, 'done')
    }
    expect(spawnCapacityError(run)).toMatch(/already spawned/)
    stopAllForRun(run)
  })
})
