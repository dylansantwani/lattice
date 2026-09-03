/**
 * How a tool row's expanded detail shows its arguments and result. The raw JSON was the same
 * information in the worst form: a shell result as `{"stdout": "line\\nline"}` with escaped newlines,
 * a job handle followed by a paragraph of instructions addressed to the model, an agent list as
 * nested objects. Each known tool gets a shape a person can scan — a command line, an output block,
 * a status line per job/agent — and the model-facing prose (`note`, `hint`, `liveOutputNote`) is kept
 * but folded behind a "note to the model" disclosure. Unknown tools fall back to pretty JSON.
 */
export interface ResultSection {
  label: string
  /** `code` is monospace preformatted; `text` is plain prose; `json` is pretty-printed */
  kind: 'code' | 'text' | 'json'
  text: string
}

export interface ToolDetailView {
  /** one line said about the arguments, or null to show the generic JSON */
  argsSummary: string | null
  /** the argument to show as a code line (a command, a path), when one thing says it all */
  argsCode?: string
  sections: ResultSection[]
  /** the model-facing instruction prose, folded */
  modelNotes: string[]
  /** short status chip text, e.g. "exit 0" */
  status?: string
}

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined)
const pretty = (v: unknown): string => {
  try {
    return JSON.stringify(v, null, 2)
  } catch {
    return String(v)
  }
}
const NOTE_KEYS = ['note', 'hint', 'liveOutputNote']

function pullNotes(r: Record<string, unknown>): { rest: Record<string, unknown>; notes: string[] } {
  const rest: Record<string, unknown> = {}
  const notes: string[] = []
  for (const [k, v] of Object.entries(r)) {
    if (NOTE_KEYS.includes(k) && typeof v === 'string') notes.push(v)
    else rest[k] = v
  }
  return { rest, notes }
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  return `${m}m ${String(s % 60).padStart(2, '0')}s`
}

export function toolDetailView(tool: string, args: unknown, result: unknown, reason?: string): ToolDetailView {
  const a = rec(args) ?? {}
  const r = rec(result)
  const view: ToolDetailView = { argsSummary: null, sections: [], modelNotes: [] }
  if (reason) {
    view.sections.push({ label: 'Reason', kind: 'text', text: reason })
  }

  // ---- arguments ----
  const command = str(a.command)
  const path = str(a.path)
  if ((tool === 'shell' || tool === 'start_job') && command) {
    view.argsSummary = str(a.cwd) ? `in ${a.cwd}` : ''
    view.argsCode = command
  } else if (tool === 'fs_read' && path) {
    view.argsSummary = ''
    view.argsCode = path
  } else if (tool === 'grep_search' && str(a.pattern)) {
    view.argsSummary = ''
    view.argsCode = `${a.pattern}${path ? `  in ${path}` : ''}${str(a.glob) ? `  (${a.glob})` : ''}`
  } else if ((tool === 'job_status' || tool === 'stop_job') && Array.isArray(a.jobs)) {
    view.argsSummary = `${(a.jobs as unknown[]).length} job${(a.jobs as unknown[]).length === 1 ? '' : 's'}${a.wait === true ? ' · wait' : ''}`
  } else if ((tool === 'agent_result' || tool === 'peek_agents') && !Array.isArray(a.agents)) {
    view.argsSummary = 'all background agents'
  }

  if (reason || r === undefined) {
    if (result !== undefined && r === undefined) view.sections.push({ label: 'Result', kind: typeof result === 'string' ? 'text' : 'json', text: typeof result === 'string' ? result : pretty(result) })
    return view
  }
  const { rest, notes } = pullNotes(r)
  view.modelNotes = notes

  // ---- results by tool ----
  if (tool === 'shell' && (typeof rest.stdout === 'string' || typeof rest.exitCode === 'number') && !rest.jobId) {
    const out = [str(rest.stdout) ?? '', str(rest.stderr) ?? ''].filter((s) => s.trim()).join('\n')
    view.status = typeof rest.exitCode === 'number' ? `exit ${rest.exitCode}` : undefined
    if (rest.timedOut) view.status = `${view.status ?? ''} · timed out`.trim()
    if (rest.canceled) view.status = `${view.status ?? ''} · canceled`.trim()
    view.sections.push({ label: 'Output', kind: 'code', text: out.trim() || '(no output)' })
    return view
  }
  if ((tool === 'shell' || tool === 'start_job') && typeof rest.jobId === 'string') {
    view.status = rest.autoBackgrounded ? 'moved to background' : 'running in background'
    const partial = str(rest.partialOutput)
    view.sections.push({ label: 'Job', kind: 'text', text: `${rest.jobId}${str(rest.purpose) ? ` — ${rest.purpose}` : ''}` })
    if (partial && partial.trim()) view.sections.push({ label: 'Output so far', kind: 'code', text: partial })
    return view
  }
  if (tool === 'job_status' && Array.isArray(rest.jobs)) {
    for (const j of rest.jobs as Record<string, unknown>[]) {
      const jobStatus = str(j.status) ?? '?'
      const how = jobStatus === 'running' ? 'running' : jobStatus === 'done' ? 'finished (exit 0)' : jobStatus === 'failed' ? `failed (exit ${j.exitCode ?? 1})` : jobStatus
      const elapsed = typeof j.elapsedMs === 'number' ? ` · ${fmtMs(j.elapsedMs)}` : ''
      const label = `${str(j.purpose) ?? str(j.id) ?? 'job'} — ${how}${elapsed}`
      const out = str(j.output) ?? ''
      view.sections.push({ label, kind: 'code', text: out.trim() || (str(j.liveOutputNote) ?? '(no output)') })
    }
    if (rest.timedOut) view.status = 'wait expired'
    return view
  }
  if ((tool === 'agent_result' || tool === 'peek_agents') && Array.isArray(rest.agents)) {
    for (const ag of rest.agents as Record<string, unknown>[]) {
      const name = str(ag.name) ?? str(ag.agentId) ?? 'agent'
      const st = str(ag.status) ?? '?'
      const extra = str(ag.activity) ? ` · ${ag.activity}` : typeof ag.elapsedMs === 'number' ? ` · ${fmtMs(ag.elapsedMs)}` : ''
      const body = str(ag.result) ?? str(ag.error) ?? str(ag.preview) ?? ''
      view.sections.push({ label: `${name} — ${st}${extra}`, kind: 'text', text: body.trim() || (st === 'running' ? '(still working)' : '(no result text)') })
    }
    if (rest.timedOut) view.status = 'wait expired'
    return view
  }
  if (tool === 'fs_read' && typeof rest.content === 'string') {
    view.sections.push({ label: 'Content', kind: 'code', text: rest.content })
    return view
  }
  if (tool === 'run_agent' && typeof rest.result === 'string') {
    view.sections.push({ label: 'Report', kind: 'text', text: rest.result })
    return view
  }
  // Generic: pretty JSON of whatever is left after the notes came out.
  if (Object.keys(rest).length) view.sections.push({ label: 'Result', kind: 'json', text: pretty(rest) })
  return view
}
