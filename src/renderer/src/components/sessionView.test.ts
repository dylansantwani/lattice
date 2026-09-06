import { describe, expect, it } from 'vitest'
import type { SessionActivitySummary, SessionStatus } from '@shared/types'
import { needsYouCount, relTime, sessionBadges, sortSessions, statusRank, STATUS_LOOK, toolDuration } from './sessionView'

function session(over: Partial<SessionActivitySummary> & { threadId: string }): SessionActivitySummary {
  return {
    title: over.threadId,
    model: 'cc/opus',
    mode: 'act',
    permissionPreset: 'workspace',
    status: 'idle',
    statusText: 'idle',
    running: false,
    updatedAt: 1000,
    unread: 0,
    agents: 0,
    jobs: 0,
    ...over
  }
}

describe('ordering', () => {
  it('leads with the sessions that are stuck waiting on a human', () => {
    const list = [
      session({ threadId: 'idle', updatedAt: 9000 }),
      session({ threadId: 'running', status: 'running', updatedAt: 8000 }),
      session({ threadId: 'ask', status: 'waiting-answer', updatedAt: 100 }),
      session({ threadId: 'approval', status: 'waiting-approval', updatedAt: 50 }),
      session({ threadId: 'failed', status: 'error', updatedAt: 8500 })
    ]
    expect(sortSessions(list).map((s) => s.threadId)).toEqual(['approval', 'ask', 'running', 'failed', 'idle'])
  })

  it('breaks ties by recency, then by title', () => {
    const list = [
      session({ threadId: 'b', title: 'B', updatedAt: 500 }),
      session({ threadId: 'a', title: 'A', updatedAt: 500 }),
      session({ threadId: 'c', title: 'C', updatedAt: 900 })
    ]
    expect(sortSessions(list).map((s) => s.title)).toEqual(['C', 'A', 'B'])
  })

  it('does not mutate the list it was given', () => {
    const list = [session({ threadId: 'a' }), session({ threadId: 'b', status: 'waiting-approval' })]
    sortSessions(list)
    expect(list.map((s) => s.threadId)).toEqual(['a', 'b'])
  })

  it('counts only the sessions actually blocked on the user', () => {
    expect(
      needsYouCount([
        session({ threadId: 'a', status: 'waiting-approval' }),
        session({ threadId: 'b', status: 'waiting-answer' }),
        session({ threadId: 'c', status: 'running' }),
        session({ threadId: 'd', status: 'error' })
      ])
    ).toBe(2)
  })

  it('ranks every status, so an unexpected one still sorts last rather than crashing', () => {
    const statuses: SessionStatus[] = ['waiting-approval', 'waiting-answer', 'running', 'error', 'idle', 'private']
    for (const s of statuses) expect(typeof statusRank(s)).toBe('number')
    expect(statusRank('private')).toBeGreaterThan(statusRank('running'))
  })

  it('has a look for every status', () => {
    const statuses: SessionStatus[] = ['waiting-approval', 'waiting-answer', 'running', 'error', 'idle', 'private']
    for (const s of statuses) expect(STATUS_LOOK[s]).toBeTruthy()
  })
})

describe('labels', () => {
  it('reads relative time the way a person would say it', () => {
    const now = 10_000_000
    expect(relTime(now - 3_000, now)).toBe('just now')
    expect(relTime(now - 4 * 60_000, now)).toBe('4m ago')
    expect(relTime(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(relTime(now - 3 * 86_400_000, now)).toBe('3d ago')
    // A clock skew must not produce "-2m ago".
    expect(relTime(now + 5_000, now)).toBe('just now')
  })

  it('formats a tool call’s duration, and says nothing while it is still running', () => {
    expect(toolDuration({ callId: 'a', tool: 'shell', status: 'ok', startedAt: 0, durationMs: 340 })).toBe('340ms')
    expect(toolDuration({ callId: 'a', tool: 'shell', status: 'ok', startedAt: 0, durationMs: 1500 })).toBe('1.5s')
    expect(toolDuration({ callId: 'a', tool: 'shell', status: 'running', startedAt: 0 })).toBe('')
  })

  it('badges only what is actually true of a session', () => {
    expect(sessionBadges(session({ threadId: 'a' }))).toEqual([])
    expect(sessionBadges(session({ threadId: 'a', agents: 1, jobs: 2, unread: 3, isPrivate: true }))).toEqual([
      '1 subagent',
      '2 jobs',
      '3 unread',
      'private'
    ])
  })
})
