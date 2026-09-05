import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import type { ApprovalRequest, AskRequest, RunEvent } from '@shared/types'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-sessionact-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from '../store/eventStore'
import { getDb, closeDb } from '../store/db'
import { requestApproval, resolveApproval } from './approvals'
import { requestAsk, resolveAsk } from './asks'
import * as sa from './sessionActivity'

let wsId: string
let pushed: PushEvent[]
let runningIds: Set<string>
let agentCounts: Record<string, number>
let jobCounts: Record<string, number>

const mk = (title: string, over: Record<string, unknown> = {}): string => {
  const t = store.createThread({ workspaceId: wsId, title, model: 'cc/opus' })
  if (Object.keys(over).length) store.updateThread(t.id, over)
  return t.id
}

/** Append an event to a thread, as the run manager does. */
const ev = (threadId: string, body: RunEvent['body'], runId = 'run1', agent?: string): RunEvent =>
  store.appendEvent(runId, threadId, body, agent)

const msg = (threadId: string, role: 'user' | 'assistant', text: string): void => {
  store.insertMessage({ id: `${threadId}-${role}-${Math.random()}`, threadId, role, createdAt: Date.now(), text })
}

/** Park a real approval on the broker so the snapshot reads live broker state, not a stub. */
function parkApproval(threadId: string, over: Partial<ApprovalRequest> = {}): ApprovalRequest {
  const request: ApprovalRequest = {
    id: `ap-${Math.random()}`,
    runId: 'run1',
    threadId,
    callId: 'c1',
    tool: 'shell',
    args: {},
    summary: 'rm -rf build',
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    ...over
  }
  void requestApproval(request, 'shell', () => {}, new AbortController().signal)
  return request
}

function parkAsk(threadId: string, question: string): AskRequest {
  const request: AskRequest = { id: `ask-${Math.random()}`, runId: 'run1', threadId, callId: 'c2', question, kind: 'text' }
  void requestAsk(request, () => {}, new AbortController().signal)
  return request
}

beforeEach(() => {
  const db = getDb()
  db.exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM session_messages')
  store.setSettings({ sessionObservation: 'allow' })
  wsId = store.ensureDefaultWorkspace().id
  pushed = []
  runningIds = new Set()
  agentCounts = {}
  jobCounts = {}
  sa.resetSessionActivity()
  sa.configureSessionActivity({
    push: (e) => pushed.push(e),
    isRunning: (id) => runningIds.has(id),
    runningAgents: (id) => agentCounts[id] ?? 0,
    runningJobs: (id) => jobCounts[id] ?? 0
  })
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

describe('redaction — what must never cross a session boundary', () => {
  it('strips credential-shaped strings, in the shapes they actually appear in', () => {
    expect(sa.redactSecrets('curl -H "Authorization: Bearer sk-abc123def456ghi789"')).not.toContain('sk-abc123def456')
    expect(sa.redactSecrets('export OPENAI_API_KEY=sk-proj-Ab3xYz9kLmNoPqRs')).toContain('[redacted')
    expect(sa.redactSecrets('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')).toContain('[redacted')
    expect(sa.redactSecrets('slack xoxb-1234567890-abcdefghij')).toContain('[redacted-key]')
    expect(sa.redactSecrets('aws AKIAIOSFODNN7EXAMPLE key')).toContain('[redacted-key]')
    expect(sa.redactSecrets('password = "hunter2hunter2"')).toBe('password = "[redacted]"')
    expect(sa.redactSecrets('api_key: abcdef123456')).toBe('api_key: [redacted]')
  })

  it('leaves ordinary prose and code alone — an over-eager redactor makes the view useless', () => {
    const prose = 'Refactored the token parser in src/lex.ts; the secret sauce is the lookahead.'
    expect(sa.redactSecrets(prose)).toBe(prose)
    expect(sa.redactSecrets('const password = getPassword()')).toBe('const password = getPassword()')
    expect(sa.redactSecrets('sk-')).toBe('sk-')
  })

  it('is idempotent', () => {
    const once = sa.redactSecrets('key: sk-abcdefghijklmnop')
    expect(sa.redactSecrets(once)).toBe(once)
  })

  it('clips long text and says it clipped it', () => {
    const long = 'x'.repeat(sa.ACTIVITY_TEXT_CAP + 50)
    const out = sa.clean(long)
    expect(out.truncated).toBe(true)
    expect(out.text).toHaveLength(sa.ACTIVITY_TEXT_CAP + 1) // + the ellipsis
    expect(sa.clean('short').truncated).toBeUndefined()
  })
})

describe('status', () => {
  it('puts waiting-on-a-human ahead of running — that is the session you need to see', () => {
    expect(sa.deriveStatus({ running: true, awaitingApproval: true, awaitingAsk: false })).toBe('waiting-approval')
    expect(sa.deriveStatus({ running: true, awaitingApproval: false, awaitingAsk: true })).toBe('waiting-answer')
    expect(sa.deriveStatus({ running: true, awaitingApproval: false, awaitingAsk: false })).toBe('running')
    expect(sa.deriveStatus({ running: false, awaitingApproval: false, awaitingAsk: false, lastError: 'boom' })).toBe('error')
    expect(sa.deriveStatus({ running: false, awaitingApproval: false, awaitingAsk: false })).toBe('idle')
    expect(sa.deriveStatus({ running: true, awaitingApproval: true, awaitingAsk: true, hiddenFromObserver: true })).toBe('private')
  })

  it('reads like a status line', () => {
    expect(sa.statusText('running', { activity: 'shell' })).toBe('running · shell')
    expect(sa.statusText('running', {})).toBe('running')
    expect(sa.statusText('waiting-approval', {})).toBe('waiting on you — approval')
    expect(sa.statusText('idle', { idleForMs: 12 * 60_000 })).toBe('idle 12m')
    expect(sa.statusText('error', { lastError: 'HTTP 500' })).toBe('failed · HTTP 500')
  })

  it('describes ages compactly', () => {
    expect(sa.ago(3_000)).toBe('3s')
    expect(sa.ago(90_000)).toBe('2m')
    expect(sa.ago(3 * 3_600_000)).toBe('3h')
    expect(sa.ago(4 * 86_400_000)).toBe('4d')
  })
})

describe('summarizeActivity', () => {
  const events = (bodies: RunEvent['body'][]): RunEvent[] =>
    bodies.map((body, i) => ({ id: `e${i}`, runId: 'r', threadId: 't', seq: i, ts: 1000 + i, body }))

  it('names the tool a session is running right now', () => {
    expect(
      summarize([
        { type: 'run.started', model: 'm', mode: 'act' },
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} }
      ])
    ).toBe('shell')
  })

  it('counts concurrent tools rather than picking one arbitrarily', () => {
    expect(
      summarize([
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} },
        { type: 'tool.started', callId: 'b', tool: 'fs_read', args: {} }
      ])
    ).toBe('2 tools')
  })

  it('forgets a tool once it has finished, or been denied', () => {
    expect(
      summarize([
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} },
        { type: 'tool.result', callId: 'a', tool: 'shell', ok: true, result: {}, durationMs: 5 }
      ])
    ).toBeUndefined()
    expect(
      summarize([
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} },
        { type: 'tool.denied', callId: 'a', reason: 'no' }
      ])
    ).toBeUndefined()
  })

  it('falls back to "writing a reply" while text is streaming', () => {
    expect(summarize([{ type: 'text.delta', text: 'hel' }])).toBe('writing a reply')
  })

  it('does not report a finished run as busy, nor carry work across runs', () => {
    expect(
      summarize([
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} },
        { type: 'run.completed', reason: 'done' }
      ])
    ).toBeUndefined()
    expect(
      summarize([
        { type: 'tool.started', callId: 'a', tool: 'shell', args: {} },
        { type: 'run.started', model: 'm', mode: 'act' },
        { type: 'tool.started', callId: 'b', tool: 'grep_search', args: {} }
      ])
    ).toBe('grep_search')
  })

  function summarize(bodies: RunEvent['body'][]): string | undefined {
    return sa.summarizeActivity(events(bodies))
  }
})

describe('toolCallsFrom', () => {
  it('folds a call’s phases into one row with its outcome and duration', () => {
    const evs: RunEvent[] = [
      { id: '1', runId: 'r', threadId: 't', seq: 1, ts: 100, body: { type: 'tool.started', callId: 'a', tool: 'shell', args: { command: 'ls' } } },
      { id: '2', runId: 'r', threadId: 't', seq: 2, ts: 150, body: { type: 'tool.result', callId: 'a', tool: 'shell', ok: false, result: {}, durationMs: 42 } }
    ]
    expect(sa.toolCallsFrom(evs)).toEqual([{ callId: 'a', tool: 'shell', status: 'failed', startedAt: 100, durationMs: 42 }])
  })

  it('never carries the call’s arguments — that is where paths and payloads live', () => {
    const evs: RunEvent[] = [
      {
        id: '1',
        runId: 'r',
        threadId: 't',
        seq: 1,
        ts: 100,
        body: { type: 'tool.started', callId: 'a', tool: 'shell', args: { command: 'curl -H "Authorization: Bearer sk-secret123456"' } }
      }
    ]
    expect(JSON.stringify(sa.toolCallsFrom(evs))).not.toContain('sk-secret')
  })

  it('keeps only the most recent calls, and tags a subagent’s work', () => {
    const evs: RunEvent[] = Array.from({ length: 20 }, (_, i) => ({
      id: `e${i}`,
      runId: 'r',
      threadId: 't',
      seq: i,
      ts: 100 + i,
      agent: i === 19 ? 'agent_7' : undefined,
      body: { type: 'tool.started', callId: `c${i}`, tool: `tool${i}`, args: {} }
    }))
    const calls = sa.toolCallsFrom(evs)
    expect(calls).toHaveLength(sa.ACTIVITY_TOOLS)
    expect(calls[calls.length - 1]).toMatchObject({ tool: 'tool19', agent: 'agent_7' })
  })
})

describe('getSessionActivity', () => {
  it('reports what a running session is doing, with its recent turns and tool calls', () => {
    const t = mk('Refactor the parser')
    runningIds.add(t)
    agentCounts[t] = 2
    jobCounts[t] = 1
    msg(t, 'user', 'refactor the lexer')
    msg(t, 'assistant', 'on it')
    ev(t, { type: 'run.started', model: 'cc/opus', mode: 'act' })
    ev(t, { type: 'tool.started', callId: 'a', tool: 'shell', args: { command: 'npm test' } })

    const activity = sa.getSessionActivity(t)!
    expect(activity).toMatchObject({
      threadId: t,
      title: 'Refactor the parser',
      status: 'running',
      statusText: 'running · shell',
      activity: 'shell',
      agents: 2,
      jobs: 1
    })
    expect(activity.messages.map((m) => m.text)).toEqual(['refactor the lexer', 'on it'])
    expect(activity.tools.map((x) => x.tool)).toEqual(['shell'])
    expect(activity.withheld).toBeUndefined()
  })

  it('never includes hidden reasoning, in any form', () => {
    const t = mk('Thinking hard')
    ev(t, { type: 'reasoning.delta', text: 'the user probably means X, but I suspect Y', fidelity: 'raw' })
    ev(t, { type: 'reasoning.done', fidelity: 'raw', tokenCount: 40 })
    ev(t, { type: 'text.delta', text: 'Here is the answer' })
    const json = JSON.stringify(sa.getSessionActivity(t))
    expect(json).not.toContain('I suspect Y')
    expect(json).not.toContain('reasoning')
  })

  it('redacts secrets out of the transcript it shows', () => {
    const t = mk('Deploy')
    msg(t, 'user', 'use OPENAI_API_KEY=sk-proj-AbCdEfGhIjKlMnOp for the smoke test')
    const activity = sa.getSessionActivity(t)!
    expect(activity.messages[0]!.text).not.toContain('sk-proj-AbCdEfGhIjKlMnOp')
    expect(activity.messages[0]!.text).toContain('[redacted')
  })

  it('surfaces what a session is parked on, so you can go answer it', () => {
    const t = mk('Blocked')
    runningIds.add(t)
    const approval = parkApproval(t)
    const ask = parkAsk(t, 'Which database should I migrate first?')

    const activity = sa.getSessionActivity(t)!
    // Waiting on a human outranks "running" — that is the whole point of the view.
    expect(activity.status).toBe('waiting-approval')
    expect(activity.pending.approvals).toEqual([{ id: approval.id, tool: 'shell', summary: 'rm -rf build', riskTier: 'R2' }])
    expect(activity.pending.asks[0]).toMatchObject({ question: 'Which database should I migrate first?' })

    resolveApproval({ requestId: approval.id, effect: 'deny', scope: 'once' }, () => {})
    resolveAsk({ requestId: ask.id, answer: 'the small one' }, () => {})
    expect(sa.getSessionActivity(t)!.status).toBe('running')
  })

  it('reports a failed run, and stops reporting it once a new run starts', () => {
    const t = mk('Broken')
    ev(t, { type: 'run.started', model: 'm', mode: 'act' })
    ev(t, { type: 'error', category: 'provider_unavailable', message: 'HTTP 503 from the gateway', retryable: true })
    expect(sa.getSessionActivity(t)).toMatchObject({ status: 'error', statusText: 'failed · HTTP 503 from the gateway' })
    ev(t, { type: 'run.started', model: 'm', mode: 'act' }, 'run2')
    expect(sa.getSessionActivity(t)!.status).toBe('idle')
  })

  it('returns null for a thread that does not exist', () => {
    expect(sa.getSessionActivity('nope')).toBeNull()
  })
})

describe('privacy boundaries for an observing session', () => {
  it('withholds a private thread’s contents from another session, but not whether it is busy', () => {
    const t = mk('Personal', { isPrivate: true })
    runningIds.add(t)
    msg(t, 'user', 'something private')
    ev(t, { type: 'tool.started', callId: 'a', tool: 'fs_read', args: {} })

    const observed = sa.getSessionActivity(t, { forObserver: true })!
    expect(observed.status).toBe('private')
    expect(observed.statusText).toBe('private · running')
    expect(observed.running).toBe(true)
    expect(observed.messages).toEqual([])
    expect(observed.tools).toEqual([])
    expect(observed.activity).toBeUndefined()
    expect(observed.withheld).toMatch(/private/i)

    // The user's own window is not an observer: it is their thread either way.
    const own = sa.getSessionActivity(t)!
    expect(own.messages.map((m) => m.text)).toEqual(['something private'])
    expect(own.withheld).toBeUndefined()
  })

  it('honors the global off switch for the agent lane only', () => {
    const t = mk('Ordinary')
    msg(t, 'user', 'hello')
    store.setSettings({ sessionObservation: 'deny' })
    expect(sa.getSessionActivity(t, { forObserver: true })!.withheld).toMatch(/turned off/i)
    expect(sa.getSessionActivity(t)!.messages).toHaveLength(1)
  })

  it('lists every session with live status, excluding the caller', () => {
    const a = mk('Alpha')
    const b = mk('Beta')
    runningIds.add(b)
    ev(b, { type: 'tool.started', callId: 'x', tool: 'web_search', args: {} })
    const list = sa.listSessionActivity(a)
    expect(list.map((s) => s.threadId)).toEqual([b])
    expect(list[0]).toMatchObject({ status: 'running', activity: 'web_search' })
  })
})

describe('the live stream', () => {
  it('pushes a fresh snapshot for a watched session, coalesced', async () => {
    vi.useFakeTimers()
    try {
      const t = mk('Watched')
      sa.setWatchedSessions([t])
      runningIds.add(t)
      ev(t, { type: 'tool.started', callId: 'a', tool: 'shell', args: {} })
      // A streaming run emits constantly; the view must not redraw per event.
      sa.noteSessionChange(t)
      sa.noteSessionChange(t)
      sa.noteSessionChange(t)
      expect(pushed).toHaveLength(0)
      vi.advanceTimersByTime(sa.ACTIVITY_PUSH_MS + 10)
      expect(pushed).toHaveLength(1)
      expect(pushed[0]).toMatchObject({ kind: 'session.activity', activity: { threadId: t, activity: 'shell' } })
    } finally {
      vi.useRealTimers()
    }
  })

  it('ignores changes on sessions nobody is watching', () => {
    vi.useFakeTimers()
    try {
      const t = mk('Unwatched')
      sa.noteSessionChange(t)
      vi.advanceTimersByTime(sa.ACTIVITY_PUSH_MS + 10)
      expect(pushed).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('takes the whole watch set each time, so a reloaded renderer can never leak a watch', () => {
    const a = mk('A')
    const b = mk('B')
    sa.setWatchedSessions([a, b])
    expect(sa.watchedSessions().sort()).toEqual([a, b].sort())
    sa.setWatchedSessions([b]) // renderer re-declares after a reload
    expect(sa.watchedSessions()).toEqual([b])
    sa.setWatchedSessions([])
    expect(sa.watchedSessions()).toEqual([])
  })

  it('drops a pending push when its session stops being watched', () => {
    vi.useFakeTimers()
    try {
      const t = mk('Dropped')
      sa.setWatchedSessions([t])
      sa.noteSessionChange(t)
      sa.setWatchedSessions([])
      vi.advanceTimersByTime(sa.ACTIVITY_PUSH_MS + 10)
      expect(pushed).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('maps a push event to the thread it concerns', () => {
    expect(sa.threadOfEvent({ kind: 'jobs.updated', threadId: 't1' })).toBe('t1')
    expect(sa.threadOfEvent({ kind: 'files.changed', threadId: 't2' })).toBe('t2')
    expect(
      sa.threadOfEvent({
        kind: 'run.event',
        event: { id: 'e', runId: 'r', threadId: 't3', seq: 1, ts: 1, body: { type: 'text.delta', text: 'x' } }
      })
    ).toBe('t3')
    expect(sa.threadOfEvent({ kind: 'models.updated' })).toBeUndefined()
  })
})
