import type { RunEvent } from '@shared/types'

export interface ToolCallStats {
  calls: number
  failed: number
  /** mean duration of completed calls, ms; null with none */
  avgMs: number | null
  /** ts of the most recent call */
  lastAt: number
}

/**
 * Per-tool call history for this thread, from its events (main run and subagents alike — a tool
 * that only subagents use still counts as "used here"). Denied calls count as failed.
 */
export function summarizeToolCalls(events: RunEvent[]): Map<string, ToolCallStats> {
  const out = new Map<string, ToolCallStats>()
  const durations = new Map<string, number[]>()
  const bump = (tool: string, ts: number): ToolCallStats => {
    let s = out.get(tool)
    if (!s) {
      s = { calls: 0, failed: 0, avgMs: null, lastAt: ts }
      out.set(tool, s)
    }
    s.lastAt = Math.max(s.lastAt, ts)
    return s
  }
  for (const ev of events) {
    const b = ev.body
    if (b.type === 'tool.started') bump(b.tool, ev.ts).calls += 1
    else if (b.type === 'tool.result') {
      const s = bump(b.tool, ev.ts)
      if (!b.ok) s.failed += 1
      const d = durations.get(b.tool) ?? []
      d.push(b.durationMs)
      durations.set(b.tool, d)
    } else if (b.type === 'tool.denied') {
      // A denied call never started; count it as a failed attempt under whatever tool it named.
      const proposed = events.find((e) => e.body.type === 'tool.proposed' && e.body.callId === b.callId)
      if (proposed && proposed.body.type === 'tool.proposed') {
        const s = bump(proposed.body.tool, ev.ts)
        s.calls += 1
        s.failed += 1
      }
    }
  }
  for (const [tool, d] of durations) {
    const s = out.get(tool)
    if (s && d.length) s.avgMs = Math.round(d.reduce((a, b) => a + b, 0) / d.length)
  }
  return out
}
