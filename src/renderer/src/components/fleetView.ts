import type { FleetAgentView, ModelInfo, RunEvent } from '@shared/types'

/** Events for the newest run represented in a bounded thread-event window. */
export function latestFleetRun(events: RunEvent[]): RunEvent[] {
  if (events.length === 0) return []
  let runId = events[events.length - 1]!.runId
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]!
    const body = event.body
    // Ephemeral child agents also write events on this thread; anchor on the persistent agent's
    // primary run when the event carries the parent-agent marker.
    if (body.type === 'run.started' && !body.parentAgent && !event.agent) {
      runId = event.runId
      break
    }
  }
  return events.filter((event) => event.runId === runId)
}

/** Human reasoning contract for a Fleet card/drawer; never imply an unsupported fixed capability. */
export function fleetReasoningLabel(agent: Pick<FleetAgentView, 'model' | 'effort'>, model?: ModelInfo): string {
  const effort = agent.effort?.toLowerCase()
  if (effort === 'none' || effort === 'off') return 'Reasoning off'
  if (agent.model.toLowerCase() === 'openrouter/free') {
    return `Reasoning varies by routed model${effort ? ` · ${effort}` : ''}`
  }
  if (model?.capabilities.reasoning) return `Reasoning ${effort || 'provider default'}`
  if (effort) return `Reasoning requested · ${effort}`
  return 'No reasoning tier set'
}

export function fleetCounts(agents: FleetAgentView[]): { running: number; needsYou: number; failed: number; idle: number } {
  let running = 0
  let needsYou = 0
  let failed = 0
  for (const agent of agents) {
    if (agent.status === 'waiting-approval' || agent.status === 'waiting-answer') needsYou += 1
    else if (agent.status === 'error') failed += 1
    else if (agent.running || agent.status === 'running') running += 1
  }
  return { running, needsYou, failed, idle: Math.max(0, agents.length - running - needsYou - failed) }
}
