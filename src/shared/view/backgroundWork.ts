import type { BgJobView, ChatMessage, RunEvent } from '../types'
import { indexSubagents } from './subagents'

/**
 * What a "running" thread is actually doing, for the composer. The thread's `running` flag covers
 * three different situations that deserve different chrome: a reply is streaming (Enter steers,
 * Stop cancels the run); only background work is in flight — subagents and/or jobs the model
 * spawned before ending its turn (Enter sends a normal message, Stop stops that work); or nothing.
 */
export interface BackgroundWork {
  /** the main model is mid-reply (an assistant message with no final status yet) */
  streaming: boolean
  /** ids of subagents still running */
  agentIds: string[]
  /** ids of background jobs still running */
  jobIds: string[]
  /** running work exists but no reply is streaming */
  backgroundOnly: boolean
}

export function summarizeBackgroundWork(
  events: RunEvent[],
  jobs: BgJobView[],
  messages: ChatMessage[],
  threadRunning: boolean
): BackgroundWork {
  const streaming = messages.some((m) => m.role === 'assistant' && m.status === undefined)
  const agentIds: string[] = []
  for (const agent of indexSubagents(events).byId.values()) if (agent.running) agentIds.push(agent.id)
  const jobIds = jobs.filter((j) => j.running).map((j) => j.id)
  const backgroundOnly = !streaming && threadRunning && (agentIds.length > 0 || jobIds.length > 0)
  return { streaming, agentIds, jobIds, backgroundOnly }
}

/** "2 subagents and 1 job" — the strip's noun phrase. */
export function describeBackgroundWork(work: Pick<BackgroundWork, 'agentIds' | 'jobIds'>): string {
  const parts: string[] = []
  const a = work.agentIds.length
  const j = work.jobIds.length
  if (a) parts.push(`${a} subagent${a === 1 ? '' : 's'}`)
  if (j) parts.push(`${j} job${j === 1 ? '' : 's'}`)
  return parts.join(' and ')
}
