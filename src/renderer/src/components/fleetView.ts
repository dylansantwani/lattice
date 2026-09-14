import type { FleetChange, FleetAgentView, ModelInfo, RunEvent } from '@shared/types'

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

const FIELD_LABELS: Record<string, string> = {
  name: 'name',
  role: 'role',
  model: 'model',
  cwd: 'working directory',
  tools: 'tools',
  permissions: 'permissions',
  mode: 'mode',
  rolling: 'rolling context',
  chars: 'size'
}

/** A change-log value as short display text. */
function showValue(value: unknown): string {
  if (Array.isArray(value)) return value.length ? value.join(', ') : '(all)'
  if (typeof value === 'boolean') return value ? 'on' : 'off'
  if (value === undefined || value === null || value === '') return '(none)'
  return String(value)
}

export interface FleetChangeView {
  /** "Print Desk Lead updated Product Sourcer — role, model" */
  headline: string
  reason?: string
  /** true when the change came from an agent (the fleet improving itself) rather than the user */
  byAgent: boolean
  fields: { label: string; before?: string; after?: string }[]
}

/** Render one change-log entry for the Fleet screen's "How the fleet has changed" feed. */
export function describeFleetChange(change: FleetChange): FleetChangeView {
  const who = change.actor === 'user' ? 'You' : change.actor
  const keys =
    change.action === 'update' || change.action === 'memory'
      ? Object.keys(change.after ?? change.before ?? {})
      : []
  const labels = keys.map((k) => FIELD_LABELS[k] ?? k)
  const headline =
    change.action === 'add'
      ? `${who} added ${change.agentName}`
      : change.action === 'remove'
        ? `${who} removed ${change.agentName}`
        : change.action === 'memory'
          ? `${who} edited ${change.agentName}'s working memory`
          : `${who} updated ${change.agentName}${labels.length ? ` — ${labels.join(', ')}` : ''}`
  const fields =
    change.action === 'update'
      ? keys.map((k) => ({ label: FIELD_LABELS[k] ?? k, before: showValue(change.before?.[k]), after: showValue(change.after?.[k]) }))
      : change.action === 'add' && change.after?.role
        ? [{ label: 'role', after: showValue(change.after.role) }]
        : change.action === 'remove' && change.before?.role
          ? [{ label: 'role', before: showValue(change.before.role) }]
          : []
  return {
    headline,
    ...(change.reason ? { reason: change.reason } : {}),
    byAgent: change.actor !== 'user' && change.action !== 'memory',
    fields
  }
}

/** A laid-out element in the Fleet tree's own coordinate space (px, origin at the tree's top-left). */
export interface FleetBox {
  x: number
  y: number
  w: number
  h: number
}

export interface FleetRoute {
  id: string
  d: string
}

/**
 * SVG path through orthogonal waypoints, with each bend rounded to `radius` (clamped so a short
 * segment never overshoots). Duplicate and collinear points are dropped first.
 */
export function roundedPath(points: { x: number; y: number }[], radius = 10): string {
  const pts: { x: number; y: number }[] = []
  for (const p of points) {
    const prev = pts[pts.length - 1]
    if (prev && Math.abs(prev.x - p.x) < 0.5 && Math.abs(prev.y - p.y) < 0.5) continue
    const before = pts[pts.length - 2]
    // Drop the middle of three collinear points (same x or same y throughout).
    if (prev && before && ((before.x === prev.x && prev.x === p.x) || (before.y === prev.y && prev.y === p.y))) pts.pop()
    pts.push({ x: p.x, y: p.y })
  }
  if (pts.length === 0) return ''
  const r1 = (n: number): number => Math.round(n * 10) / 10
  let d = `M ${r1(pts[0]!.x)} ${r1(pts[0]!.y)}`
  for (let i = 1; i < pts.length; i += 1) {
    const cur = pts[i]!
    const next = pts[i + 1]
    if (!next) {
      d += ` L ${r1(cur.x)} ${r1(cur.y)}`
      break
    }
    const prev = pts[i - 1]!
    const inLen = Math.hypot(cur.x - prev.x, cur.y - prev.y)
    const outLen = Math.hypot(next.x - cur.x, next.y - cur.y)
    const r = Math.max(0, Math.min(radius, inLen / 2, outLen / 2))
    const ax = cur.x - ((cur.x - prev.x) / inLen) * r
    const ay = cur.y - ((cur.y - prev.y) / inLen) * r
    const bx = cur.x + ((next.x - cur.x) / outLen) * r
    const by = cur.y + ((next.y - cur.y) / outLen) * r
    d += ` L ${r1(ax)} ${r1(ay)} Q ${r1(cur.x)} ${r1(cur.y)} ${r1(bx)} ${r1(by)}`
  }
  return d
}

/**
 * Routes for the Fleet tree: one line from the hub (under the orchestrator) into the top of every
 * agent card. Cards wrap into rows, so a line never cuts through a card: the first row hangs off a
 * rail just above it; a later row's line runs down the column gutter on the hub's side of its card,
 * then along that row's own rail. Each card gets its own full path so a live agent's line can be
 * lit end-to-end while the rest stay quiet (overlapping trunk segments simply coincide).
 */
export function fleetTreeRoutes(
  hub: FleetBox,
  targets: { id: string; box: FleetBox }[],
  opts: { rail?: number; radius?: number } = {}
): FleetRoute[] {
  if (targets.length === 0) return []
  const rail = opts.rail ?? 20
  const radius = opts.radius ?? 10
  const hubX = hub.x + hub.w / 2
  const hubY = hub.y + hub.h
  // Group into rows by top edge (grid rows share a top; tolerate sub-pixel drift).
  const rows: { top: number; items: { id: string; box: FleetBox }[] }[] = []
  for (const t of [...targets].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x)) {
    const row = rows.find((r) => Math.abs(r.top - t.box.y) < 6)
    if (row) row.items.push(t)
    else rows.push({ top: t.box.y, items: [t] })
  }
  const first = rows[0]!.items.slice().sort((a, b) => a.box.x - b.box.x)
  // Half the column gap, measured from the first row (falls back to a sane default for one column).
  let half = 9
  for (let i = 1; i < first.length; i += 1) {
    const gap = first[i]!.box.x - (first[i - 1]!.box.x + first[i - 1]!.box.w)
    if (gap > 0) {
      half = gap / 2
      break
    }
  }
  const rail0 = rows[0]!.top - rail
  const out: FleetRoute[] = []
  rows.forEach((row, index) => {
    for (const t of row.items) {
      const cx = t.box.x + t.box.w / 2
      const top = t.box.y
      const points = [{ x: hubX, y: hubY }, { x: hubX, y: rail0 }]
      if (index === 0) {
        points.push({ x: cx, y: rail0 }, { x: cx, y: top })
      } else {
        const railY = row.top - rail
        const gutter = cx < hubX ? t.box.x + t.box.w + half : t.box.x - half
        points.push({ x: gutter, y: rail0 }, { x: gutter, y: railY }, { x: cx, y: railY }, { x: cx, y: top })
      }
      out.push({ id: t.id, d: roundedPath(points, radius) })
    }
  })
  return out
}

/** An agent's latest output as one plain line for its card: markdown syntax, tool-call XML and extra whitespace removed. */
export function plainPreview(text: string | undefined): string {
  if (!text) return ''
  return text
    .replace(/<\/?[a-z_][\w-]*(\s[^>]*)?>/gi, ' ')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+\.)\s+/gm, '')
    .replace(/(\*\*|__|\*|_|`|~~)(?=\S)([^\n]*?\S)\1/g, '$2')
    .replace(/[*`]{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}
