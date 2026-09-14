/**
 * What the assistant is doing, in words a text message can carry.
 *
 * While a run works, the phone gets short updates instead of silence: the model's own heads-up
 * lines (text it writes before a tool call is sent the moment the call starts), and, when it goes
 * quiet for a while, a status line built here from its latest tool call ("still on it, reading
 * sellercentral.amazon.com"). Pure functions over run events; the router decides when to send.
 */
import type { RunEvent } from '@shared/types'
import { withoutSilentToken } from '@shared/view/silentReply'

function hostOf(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    return new URL(value).hostname.replace(/^www\./, '')
  } catch {
    return undefined
  }
}

function baseName(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined
  return value.split(/[\\/]/).filter(Boolean).pop()
}

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length <= max ? clean : `${clean.slice(0, max - 1).trimEnd()}…`
}

/** "Verify imports completed" → "verify imports completed" (keeps acronyms like "API" and names like "eBay"). */
function lowerFirst(text: string): string {
  if (/^[A-Z][a-z]/.test(text)) return text[0]!.toLowerCase() + text.slice(1)
  return text
}

function firstUrl(args: Record<string, unknown>): string | undefined {
  for (const key of ['url', 'href', 'link', 'target']) {
    const host = hostOf(args[key])
    if (host) return host
  }
  return undefined
}

/**
 * One short phrase for a tool call ("searching the web for deepseek pricing"), or undefined for
 * calls not worth mentioning (reading the checklist, peeking at its own jobs). Never includes
 * secrets-shaped arguments: only purposes, hosts, file names and search queries.
 */
export function describeToolActivity(tool: string, rawArgs: unknown): string | undefined {
  const args = rawArgs && typeof rawArgs === 'object' ? (rawArgs as Record<string, unknown>) : {}
  const purpose = typeof args.purpose === 'string' && args.purpose.trim() ? lowerFirst(clip(args.purpose, 70)) : undefined
  const name = tool.toLowerCase()
  if (name === 'batch' && Array.isArray(args.calls) && args.calls.length) {
    const first = args.calls[0] as { tool?: unknown; name?: unknown; args?: unknown; arguments?: unknown }
    const inner = typeof first.tool === 'string' ? first.tool : typeof first.name === 'string' ? first.name : ''
    return inner ? describeToolActivity(inner, first.args ?? first.arguments) : undefined
  }
  if (name === 'shell' || name === 'start_job') {
    if (purpose) return purpose
    const command = typeof args.command === 'string' ? args.command.trim() : ''
    const program = command.split(/\s+/)[0]?.split('/').pop()
    if (program === 'ssh') return 'working on a remote machine'
    return program ? `running ${clip(program, 30)}` : 'running a command'
  }
  if (name === 'web_search') {
    // Search syntax ("with ads" "Standard" site:x) reads as noise in a text; keep the words.
    const words = typeof args.query === 'string' ? args.query.replace(/["“”]|\b\w+:\S+/g, ' ').replace(/\s+/g, ' ').trim() : ''
    return words ? `searching the web for ${clip(words, 48)}` : 'searching the web'
  }
  if (name === 'web_fetch' || name === 'fetch_image') return firstUrl(args) ? `reading ${firstUrl(args)}` : 'reading a page'
  if (name === 'fs_read' || name === 'grep_search' || name === 'fs_list') {
    const file = baseName(args.path) ?? (Array.isArray(args.paths) ? baseName(args.paths[0]) : undefined)
    return file ? `looking through ${clip(file, 40)}` : 'looking through files'
  }
  if (name === 'fs_write' || name === 'fs_edit') return baseName(args.path) ? `writing ${clip(baseName(args.path)!, 40)}` : 'writing a file'
  if (name === 'memory_search') return 'checking my notes'
  if (name === 'memory_save') return undefined
  if (name === 'run_agent') return typeof args.name === 'string' ? `a helper (${clip(args.name, 40)}) is on part of it` : 'a helper is on part of it'
  if (['todo_write', 'job_status', 'peek_agents', 'agent_result', 'stop_job', 'read_tool_result', 'search_tool_results', 'show_image', 'show_image_data', 'ask_user', 'find_mcp'].includes(name)) {
    return undefined
  }
  // MCP and browser tools: a URL means a site; otherwise say what kind of thing it is.
  const host = firstUrl(args) ?? (Array.isArray(args.calls) ? firstUrl(((args.calls[0] as { args?: Record<string, unknown> })?.args ?? {}) as Record<string, unknown>) : undefined)
  if (/navigate|open|goto|visit/.test(name) && host) return `opening ${host}`
  if (/screenshot|snapshot|capture/.test(name)) return 'looking at the screen'
  if (/click|type|input|fill|press|act/.test(name)) return host ? `clicking around on ${host}` : 'clicking around in the browser'
  if (host) return `on ${host}`
  if (purpose) return purpose
  const server = name.includes('__') ? name.split('__')[1] : undefined
  if (server) return `using ${server.replace(/[-_]/g, ' ')}`
  return `using ${name.replace(/_/g, ' ')}`
}

function formatElapsed(ms: number): string {
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 1) return `${Math.max(1, Math.round(ms / 1000))}s`
  return `${minutes} min`
}

/**
 * The deterministic "still working" text for the `count`-th update (0-based) of a run: varied so a
 * long task does not send the same line five times, and naming the current activity when known.
 */
export function progressUpdateText(activity: string | undefined, elapsedMs: number, count: number): string {
  const doing = activity ? `, ${activity}` : ''
  switch (count) {
    case 0:
      return `still on it${doing}`
    case 1:
      return `still going${doing}`
    case 2:
      return `${formatElapsed(elapsedMs)} in and still working${doing}`
    default:
      return activity ? `still at it (${formatElapsed(elapsedMs)}), ${activity}` : `still at it, ${formatElapsed(elapsedMs)} in`
  }
}

/**
 * A run's visible text split where the model paused to call tools, in order: the stretches a tool
 * call (or an interjection) has closed, and the one still streaming. `msg.text` is the same words
 * glued together with no separator ("…click through it now.**Update — eBay state:**"), so
 * segmenting from events is what lets a heads-up line and the final answer arrive as separate texts.
 * A `rewound` retry discards the failed attempt's uncommitted text.
 */
export function splitRunText(events: RunEvent[]): { closed: string[]; open: string } {
  const closed: string[] = []
  let current = ''
  for (const event of events) {
    if (event.agent) continue
    const body = event.body
    if (body.type === 'text.delta') current += body.text
    else if (body.type === 'tool.proposed' || body.type === 'tool.started' || body.type === 'steer.injected') {
      if (current.trim()) closed.push(current)
      current = ''
    } else if (body.type === 'retry' && body.rewound) current = ''
  }
  return { closed, open: current.trim() ? current : '' }
}

/** Every non-empty segment of a run, closed and open alike. */
export function segmentsFromEvents(events: RunEvent[]): string[] {
  const { closed, open } = splitRunText(events)
  return open ? [...closed, open] : closed
}

/** A segment as it should be texted: the silent token removed, whitespace trimmed. */
export function cleanSegment(text: string): string {
  return withoutSilentToken(text).trim()
}

/** Normalized for "did we already text this?" comparisons. */
export function segmentKey(text: string): string {
  return text.toLowerCase().replace(/[*_`~#>|]/g, '').replace(/\s+/g, ' ').trim()
}

export interface ShownImage {
  mime: string
  /** base64 bytes */
  data: string
  path?: string
  caption?: string
}

/** Tools whose whole point is putting an image in front of the person. */
export const SHOW_IMAGE_TOOLS: ReadonlySet<string> = new Set(['show_image', 'show_image_data', 'fetch_image'])

/** The image(s) a show_image / show_image_data / fetch_image result carries. */
export function imagesFromToolResult(tool: string, result: unknown): ShownImage[] {
  if (!SHOW_IMAGE_TOOLS.has(tool) || !result || typeof result !== 'object') return []
  const found: ShownImage[] = []
  const visit = (node: unknown, depth: number): void => {
    if (!node || typeof node !== 'object' || depth > 4) return
    if (Array.isArray(node)) {
      for (const item of node) visit(item, depth + 1)
      return
    }
    const record = node as Record<string, unknown>
    if (record.type === 'image' && typeof record.data === 'string' && record.data.length > 0) {
      const mime = typeof record.mimeType === 'string' && record.mimeType.startsWith('image/') ? record.mimeType : 'image/png'
      found.push({
        mime,
        data: record.data.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, ''),
        ...(typeof record.path === 'string' ? { path: record.path } : {}),
        ...(typeof record.caption === 'string' && record.caption.trim() ? { caption: record.caption.trim() } : {})
      })
      return
    }
    for (const value of Object.values(record)) visit(value, depth + 1)
  }
  visit(result, 0)
  return found
}
