import { execFile } from 'node:child_process'
import { readdir, mkdir, stat, lstat, realpath, rename, rm, cp, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { oneShotShell } from '../platform/shell'
import type { AskOption } from '@shared/types'
import { bufferedByPipe } from '@shared/commandHints'
import type { ToolContext, ToolDefinition } from './types'
import * as store from '../store/eventStore'
import { mcpTools } from '../mcp/manager'
import { runInShell, runInShellPromotable } from './ptyShell'
import { startShellJob, adoptShellJob, listJobs, getJob, waitJobs, stopJob } from './bgJobs'
import { sessionMessagingTools } from './sessionTools'
import { assertPublicHost, readBodyCapped } from './network'
import { webTools } from './webTools'

const MAX_READ_BYTES = 256 * 1024
const MAX_TOOL_OUTPUT = 48 * 1024
/** Plenty for a screenshot, chart, or diagram; keeps the thread's stored history and the model's
 * own re-attached copy of the image (see extractToolResultImages) from ballooning unboundedly. */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** Extension → canonical MIME, for guessing an image's type from a path or URL. */
const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  avif: 'image/avif',
  ico: 'image/x-icon'
}

/** Every MIME spelling we accept (including sloppy/alternate ones a server or model might use),
 * normalized to the canonical form above so the renderer only ever has to handle one per format. */
const IMAGE_MIME_ALIASES: Record<string, string> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp',
  'image/svg+xml': 'image/svg+xml',
  'image/bmp': 'image/bmp',
  'image/x-ms-bmp': 'image/bmp',
  'image/avif': 'image/avif',
  'image/x-icon': 'image/x-icon',
  'image/vnd.microsoft.icon': 'image/x-icon'
}

const SUPPORTED_IMAGE_TYPES_TEXT = 'PNG, JPEG, GIF, WEBP, SVG, BMP, AVIF, and ICO'

function normalizeImageMime(raw: string): string | undefined {
  return IMAGE_MIME_ALIASES[raw.trim().toLowerCase()]
}

function extOf(pathOrUrl: string): string {
  return (pathOrUrl.split(/[?#]/)[0]!.split('.').pop() ?? '').toLowerCase()
}

/**
 * Resolve `data` for show_image_data: either a base64 payload paired with an explicit `mime_type`,
 * or a full `data:image/…;base64,…` URL a model pasted verbatim (tolerated so a value copied
 * straight out of another tool's output — or its own memory of one — just works).
 */
function parseInlineImageData(
  raw: string,
  explicitMime: string | undefined
): { mimeType: string; base64: string } {
  const asDataUrl = raw.match(/^data:([^;,]+)(;base64)?,([\s\S]*)$/)
  if (asDataUrl) {
    if (!asDataUrl[2]) {
      throw new Error('data: URLs must be base64-encoded, e.g. "data:image/png;base64,…".')
    }
    const mimeType = normalizeImageMime(explicitMime ?? asDataUrl[1]!)
    if (!mimeType) {
      throw new Error(`Unsupported image type "${explicitMime ?? asDataUrl[1]}". Supported: ${SUPPORTED_IMAGE_TYPES_TEXT}.`)
    }
    return { mimeType, base64: asDataUrl[3]! }
  }
  if (!explicitMime) {
    throw new Error(`mime_type is required and must be one of: ${SUPPORTED_IMAGE_TYPES_TEXT}.`)
  }
  const mimeType = normalizeImageMime(explicitMime)
  if (!mimeType) {
    throw new Error(`Unsupported image type "${explicitMime}". Supported: ${SUPPORTED_IMAGE_TYPES_TEXT}.`)
  }
  return { mimeType, base64: raw }
}

/** Common words that carry no search signal; dropped so they don't inflate every item's score. */
const SEARCH_STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'of', 'for', 'to', 'in', 'on', 'at', 'by', 'with', 'without',
  'is', 'are', 'be', 'it', 'this', 'that', 'these', 'those', 'under', 'over', 'results', 'result'
])

/** Split a free-text query into distinct, lowercased, meaningful tokens (≥2 chars, no stopwords). */
export function tokenizeQuery(query: string): string[] {
  return Array.from(
    new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9]+/)
        .filter((t) => t.length >= 2 && !SEARCH_STOPWORDS.has(t))
    )
  )
}

/**
 * Rank memories against a free-text query by how many distinct query tokens appear in the content —
 * a real keyword search, not the old whole-query substring match (which required the entire query
 * string to appear verbatim and so returned nothing for any multi-word query). Returns only items
 * matching at least one token, highest score first, ties broken by recency. An all-stopword or empty
 * query yields [] rather than the whole store.
 */
export function rankMemorySearch<T extends { content: string; updatedAt?: number; lastUsedAt?: number }>(
  items: T[],
  query: string
): T[] {
  const tokens = tokenizeQuery(query)
  if (tokens.length === 0) return []
  const recency = (m: T): number => m.lastUsedAt ?? m.updatedAt ?? 0
  return items
    .map((m) => {
      const hay = m.content.toLowerCase()
      return { m, score: tokens.reduce((n, t) => (hay.includes(t) ? n + 1 : n), 0) }
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || recency(b.m) - recency(a.m))
    .map((s) => s.m)
}

export function resolveToolPath(p: string, ctx: ToolContext): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p
  return isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.workspace.roots[0] ?? homedir(), expanded)
}

export function isInsideRoots(path: string, roots: string[]): boolean {
  // Platform separator (not '/') so containment works on Windows paths too; case-insensitive
  // there, matching NTFS semantics, so C:\Work and c:\work don't read as different trees.
  const fold = (p: string): string => (process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p))
  const r = fold(path)
  return roots.some((root) => r === fold(root) || r.startsWith(fold(root) + sep))
}

/** Resolve symlinks in the target or its nearest existing parent before checking containment. */
export async function isPathInsideRoots(path: string, roots: string[]): Promise<boolean> {
  const canonicalPath = await canonicalizeWithMissingTail(path)
  const canonicalRoots = await Promise.all(roots.map((root) => canonicalizeWithMissingTail(root)))
  return isInsideRoots(canonicalPath, canonicalRoots)
}

async function canonicalizeWithMissingTail(path: string): Promise<string> {
  let probe = resolve(path)
  const tail: string[] = []
  while (true) {
    try {
      return resolve(await realpath(probe), ...tail)
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      const parent = dirname(probe)
      if (parent === probe) return resolve(path)
      tail.unshift(basename(probe))
      probe = parent
    }
  }
}

function clip(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw err
  }
}

/** One-shot login shell used only when the persistent PTY session can't be created. */
/**
 * Background-job helpers shared by `shell(background:true)` and `start_job`.
 *
 * Why two entry points for one thing: weaker tool-callers (DeepSeek V4 Flash in particular) pick
 * tools by NAME and routinely drop optional boolean flags — across dozens of long-running commands
 * it never once set `background: true`, then blocked or timed out on them. A dedicated `start_job`
 * tool makes "run this in the background" a first-class choice in the tool list, while `shell`'s
 * flag stays for models that use it.
 */

/**
 * The longest a top-level run's foreground `shell` command may block the model. A command still
 * running past this is moved to the background (it keeps running as a job, its output is delivered
 * on completion, and it can be peeked at live) — no matter how large a `timeout_ms` the model asked
 * for. Seven-minute foreground waits ("timeout_ms: 420000" on a benchmark) were the single most
 * hated behaviour in the app: the model sat idle, the user sat idle, nothing could be steered.
 */
export const FOREGROUND_GRACE_MS = 20_000

/**
 * How long a `shell` call waits in the foreground before promotion. A run that can be pinged on
 * completion (top-level) never waits past {@link FOREGROUND_GRACE_MS}; a shorter `timeout_ms` is
 * honoured (the model may ask for a quick check). A subagent cannot be pinged, so it keeps the
 * classic hard timeout and the result is `undefined` (no promotion). Exported for tests.
 */
export function foregroundGraceMs(requestedTimeoutMs: number, promotable: boolean): number | undefined {
  if (!promotable) return undefined
  return Math.max(1000, Math.min(requestedTimeoutMs, FOREGROUND_GRACE_MS))
}

/** A foreground command that ran at least this long earns a "next time use a job" hint. */
export const SLOW_COMMAND_HINT_MS = 30_000
/** A leading `sleep N` of at least this many seconds is treated as job-polling, not a real wait. */
export const SLEEP_POLL_MIN_S = 15
/** How long `job_status` waits by default before returning the current state (subagents; a top-level
 *  run is capped by {@link JOB_WAIT_MAX_MS}). */
export const JOB_WAIT_DEFAULT_MS = 120_000
/**
 * The longest a top-level run may block in `job_status` waiting on jobs, whatever `timeout_ms` asks
 * for. A finished job is delivered as a new message anyway, so a long wait only ever parks the
 * model — the observed case was `job_status({wait:true, timeout_ms:590000})` right after starting a
 * ten-minute sweep, ten minutes of nothing with the prose in the tool notes ignored. Same shape as
 * the shell grace window: the cap is structural, not advisory.
 */
export const JOB_WAIT_MAX_MS = 20_000
/** Effective `job_status` wait: capped for a run that will be pinged, classic for a subagent. */
export function jobWaitMs(requestedMs: number, pinged: boolean): number {
  const requested = Math.min(Math.max(requestedMs || JOB_WAIT_DEFAULT_MS, 1000), 600_000)
  return pinged ? Math.min(requested, JOB_WAIT_MAX_MS) : requested
}

/**
 * Seconds a command would spend in a leading `sleep N` (`sleep 115; echo tick`, `sleep 60 && ls`),
 * or null when the command does not start with a sleep. Models with a job running poll like this,
 * hitting the tool timeout every time.
 */
export function leadingSleepSeconds(command: string): number | null {
  const m = /^\s*sleep\s+(\d+(?:\.\d+)?)\s*(?:[;&|]|$)/.exec(command)
  return m ? Number(m[1]) : null
}

/**
 * The teaching hint appended to a slow foreground command's result. Feedback right where the cost
 * was paid is what actually moves a model toward `background: true` next time — far more than a
 * sentence in the system prompt.
 */
export function slowCommandHint(durationMs: number): string | undefined {
  if (durationMs < SLOW_COMMAND_HINT_MS) return undefined
  return (
    `This command blocked you for ${Math.round(durationMs / 1000)}s. Next time run work like this as ` +
    'a background job (start_job, or shell with background: true): you get a jobId immediately, ' +
    'keep working, and its output is delivered to you automatically when it finishes.'
  )
}

/** The model's short label for a command, trimmed and bounded, or undefined when absent/blank. */
function purposeOf(args: Record<string, unknown>): string | undefined {
  const raw = typeof args.purpose === 'string' ? args.purpose.replace(/\s+/g, ' ').trim() : ''
  return raw ? raw.slice(0, 80) : undefined
}

/** How often a running foreground command reports its live output to the transcript. */
export const SHELL_PROGRESS_INTERVAL_MS = 350
/** Only the tail of a live buffer is shipped per report; the full output arrives with the result. */
export const SHELL_PROGRESS_TAIL_CHARS = 6_000

/**
 * Wrap a tool context's `progress` reporter so a chatty command (thousands of chunks a second) turns
 * into at most one persisted snapshot per interval, always ending on the latest buffer. Exported
 * for tests.
 */
export function throttledProgress(
  report: ((output: string) => void) | undefined,
  intervalMs = SHELL_PROGRESS_INTERVAL_MS
): ((soFar: string) => void) | undefined {
  if (!report) return undefined
  let last = 0
  let pending: NodeJS.Timeout | null = null
  let latest = ''
  const flush = (): void => {
    pending = null
    last = Date.now()
    report(latest.length > SHELL_PROGRESS_TAIL_CHARS ? latest.slice(-SHELL_PROGRESS_TAIL_CHARS) : latest)
  }
  return (soFar) => {
    latest = soFar
    if (pending) return
    const wait = intervalMs - (Date.now() - last)
    if (wait <= 0) flush()
    else pending = setTimeout(flush, wait)
  }
}

/** The directory a shell/job runs from: an explicit cwd (contained), else the workspace root. */
function shellCwd(args: Record<string, unknown>, ctx: ToolContext): string {
  return args.cwd ? resolveToolPath(String(args.cwd), ctx) : (ctx.workspace.roots[0] ?? homedir())
}

/**
 * Start `command` as a detached background job on the caller's thread and register it for the
 * notify-on-completion ping (top-level runs only). A subagent is refused: it has no `job_status`
 * and can never be pinged, so a job it started would be work nobody could ever read.
 */
function startBackgroundJob(
  command: string,
  cwd: string,
  ctx: ToolContext,
  purpose?: string
): Record<string, unknown> {
  if (ctx.agentIdentity) {
    throw new Error(
      'Background jobs are not available to a subagent (nothing could deliver the result back to ' +
        'you). Run the command in the foreground instead — raise timeout_ms (up to 600000) if it is slow.'
    )
  }
  const job = startShellJob(ctx.threadMeta.id, command, { cwd, purpose })
  const pinged = !!ctx.promoteShellToBackground
  ctx.promoteShellToBackground?.({ jobId: job.id, command, kind: 'background', purpose })
  const buffered = bufferedByPipe(command)
  return {
    jobId: job.id,
    status: job.status,
    background: true,
    startedAt: job.startedAt,
    ...(purpose ? { purpose } : {}),
    ...(buffered
      ? {
          liveOutputNote:
            `This command pipes through \`${buffered}\`, which holds all output until the command ends — ` +
            'so there will be NO live output to peek at until it finishes. Next time run the command ' +
            'without that final pipe and use job_status with `tail` to read the last lines instead.'
        }
      : {}),
    note: pinged
      ? `Started as background job ${job.id}. It keeps running after this turn ends, and its output ` +
        'will be delivered to you automatically as a new message when it finishes. CONTINUE WORKING ' +
        'on the next thing that does not depend on it (or find a faster way to get what you need); ' +
        `peek at its live output any time with job_status({"jobs":["${job.id}"],"wait":false,"tail":40}). ` +
        'Block on it (job_status wait:true) only if the rest of the task truly cannot proceed without ' +
        'its result. Never poll with sleep. stop_job cancels it.'
      : `Started as background job ${job.id}. It keeps running after this turn ends. Read its output ` +
        'with job_status (which waits for it by default); cancel it with stop_job.'
  }
}

function runLoginShellOnce(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string; cwd: string; timedOut: boolean }> {
  const shell = oneShotShell(command)
  return new Promise((resolvePromise) => {
    execFile(
      shell.file,
      shell.args,
      { cwd, timeout, maxBuffer: 8 * 1024 * 1024, signal },
      (err, stdout, stderr) => {
        const code = err as (NodeJS.ErrnoException & { code?: number }) | null
        resolvePromise({
          exitCode: code && typeof code.code === 'number' ? code.code : err ? 1 : 0,
          stdout: clip(stdout),
          stderr: clip(stderr),
          cwd,
          timedOut: !!err && /ETIMEDOUT|SIGTERM/.test(String((err as Error).message))
        })
      }
    )
  })
}

/** Refuse to move or delete a workspace root itself, even under the `full` preset. */
function assertNotRoot(path: string, ctx: ToolContext, verb: string): void {
  const target = resolve(path)
  if (ctx.workspace.roots.some((root) => resolve(root) === target)) {
    throw new Error(`Refusing to ${verb} a workspace root: ${path}`)
  }
}

export const builtinTools: ToolDefinition[] = [
  {
    name: 'fs_read',
    description:
      'Read a text file — or SEVERAL at once with `paths` (every model round costs a full ' +
      'round-trip, so read all the files you need in one call, not one per round). Returns up to ' +
      '256KB per file; use offset/limit (line numbers) for larger files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path' },
        paths: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Read these files in one call (up to 20). Each comes back as its own {path, content} (or ' +
            '{path, error}); offset/limit apply to every file. Use this instead of one fs_read per file.'
        },
        offset: { type: 'number', description: '1-based first line to read' },
        limit: { type: 'number', description: 'Max lines to return' }
      }
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    pathArgs: ['path'],
    summarize: (a) =>
      Array.isArray(a.paths) && (a.paths as unknown[]).length
        ? `Read ${(a.paths as unknown[]).length} files: ${(a.paths as unknown[]).slice(0, 3).map(String).join(', ')}${(a.paths as unknown[]).length > 3 ? '…' : ''}`
        : `Read ${a.path}`,
    async run(args, ctx) {
      const readOne = async (requested: string): Promise<{ path: string; content: string }> => {
        const path = resolveToolPath(requested, ctx)
        const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
        let raw: string
        try {
          const size = (await handle.stat()).size
          const bytesToRead = Math.min(size, MAX_READ_BYTES)
          const buffer = Buffer.allocUnsafe(bytesToRead)
          const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0)
          raw = buffer.toString('utf8', 0, bytesRead)
          if (size > MAX_READ_BYTES) raw += '\n… [truncated]'
        } finally {
          await handle.close()
        }
        let text = raw
        if (args.offset || args.limit) {
          const lines = raw.split('\n')
          const start = Math.max(0, Number(args.offset ?? 1) - 1)
          const count = Number(args.limit ?? 2000)
          text = lines.slice(start, start + count).join('\n')
        }
        return { path, content: text }
      }
      const many = Array.isArray(args.paths) ? args.paths.map((x) => String(x)).filter((x) => x.trim()) : []
      if (many.length) {
        if (many.length > 20) throw new Error('fs_read reads at most 20 files per call.')
        const files = await Promise.all(
          many.map(async (requested) => {
            try {
              return await readOne(requested)
            } catch (err) {
              return { path: requested, error: err instanceof Error ? err.message : String(err) }
            }
          })
        )
        return { files }
      }
      if (typeof args.path !== 'string' || !args.path) throw new Error('fs_read needs `path` or `paths`.')
      return readOne(args.path)
    }
  },
  {
    name: 'show_image',
    description:
      'Display an image inline in the chat, for the user to look at — a screenshot, a chart, a ' +
      'diagram, a generated or downloaded picture. Pass the path to an image file already on disk ' +
      '(create it first with your other tools, e.g. shell, if it does not exist yet). For image ' +
      'bytes you already have in hand (no file), use show_image_data instead; for a remote URL, ' +
      `use fetch_image. Supports ${SUPPORTED_IMAGE_TYPES_TEXT}, up to 8MB.`,
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path to the image file.' },
        caption: { type: 'string', description: 'Optional short caption shown under the image.' }
      },
      required: ['path']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Show image ${a.path}${a.caption ? `: ${String(a.caption).slice(0, 60)}` : ''}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      const mimeType = IMAGE_MIME_BY_EXT[extOf(path)]
      if (!mimeType) {
        throw new Error(`Unsupported image type "${extOf(path)}". Supported: ${SUPPORTED_IMAGE_TYPES_TEXT}.`)
      }
      const info = await stat(path)
      if (!info.isFile()) throw new Error(`Not a file: ${path}`)
      if (info.size > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large to display (${info.size} bytes; max ${MAX_IMAGE_BYTES}).`)
      }
      const data = (await readFile(path)).toString('base64')
      const caption = args.caption ? String(args.caption).trim().slice(0, 300) : undefined
      // Shaped like an MCP image content block on purpose: extractToolResultImages already knows
      // to lift this out and re-attach it as a real image the model can see, the same way a
      // screenshot from a browser/computer-use MCP server does — so the model gets vision on what
      // it just showed the user, and the transcript renders it inline for the same reason.
      return { type: 'image', mimeType, data, path, ...(caption ? { caption } : {}) }
    }
  },
  {
    name: 'show_image_data',
    description:
      'Display an image inline in the chat from raw image bytes you already have — e.g. base64 ' +
      'image data returned by another tool or one you generated yourself. For a file already on ' +
      'disk, use show_image instead; for a remote URL, use fetch_image. Pass `data` as base64 (a ' +
      "full \"data:image/...;base64,...\" URL is also accepted, in which case you can omit " +
      `mime_type). Supports ${SUPPORTED_IMAGE_TYPES_TEXT}, up to 8MB.`,
    parameters: {
      type: 'object',
      properties: {
        data: {
          type: 'string',
          description: 'Base64-encoded image bytes, or a full "data:image/...;base64,..." URL.'
        },
        mime_type: {
          type: 'string',
          description:
            'The image MIME type, e.g. "image/png". Required unless `data` is a data: URL that already carries one.'
        },
        caption: { type: 'string', description: 'Optional short caption shown under the image.' }
      },
      required: ['data']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Show image (inline data)${a.caption ? `: ${String(a.caption).slice(0, 60)}` : ''}`,
    async run(args) {
      const raw = String(args.data ?? '').trim()
      if (!raw) throw new Error('data is required and must be non-empty.')
      const { mimeType, base64 } = parseInlineImageData(raw, args.mime_type ? String(args.mime_type) : undefined)
      const byteLength = Buffer.byteLength(base64, 'base64')
      if (byteLength > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large to display (${byteLength} bytes; max ${MAX_IMAGE_BYTES}).`)
      }
      const caption = args.caption ? String(args.caption).trim().slice(0, 300) : undefined
      return { type: 'image', mimeType, data: base64, ...(caption ? { caption } : {}) }
    }
  },
  {
    name: 'fetch_image',
    description:
      'Fetch an image from a public http(s) URL and display it inline in the chat, for the user to ' +
      'look at. For a local file you already have, use show_image instead; for bytes you already ' +
      `have in hand, use show_image_data. Supports ${SUPPORTED_IMAGE_TYPES_TEXT}, up to 8MB. ` +
      'Refuses non-http(s) URLs and requests to localhost or a private/internal network address.',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'A public http:// or https:// URL to an image.' },
        caption: { type: 'string', description: 'Optional short caption shown under the image.' }
      },
      required: ['url']
    },
    resource: 'network',
    action: 'read',
    riskTier: 'R1',
    allowedInPlan: false,
    summarize: (a) => `Fetch image ${a.url}${a.caption ? `: ${String(a.caption).slice(0, 60)}` : ''}`,
    async run(args) {
      const raw = String(args.url ?? '').trim()
      if (!raw) throw new Error('url is required and must be non-empty.')
      let url: URL
      try {
        url = new URL(raw)
      } catch {
        throw new Error(`Invalid URL: ${raw}`)
      }
      if (url.protocol !== 'http:' && url.protocol !== 'https:') {
        throw new Error(`Unsupported URL scheme "${url.protocol}" — only http(s) URLs are allowed.`)
      }
      await assertPublicHost(url.hostname)
      let res: Response
      try {
        // redirect:'error' rather than following: a redirect could otherwise be used to bounce past
        // the public-host check above onto an internal address.
        res = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15000) })
      } catch (err) {
        throw new Error(`Could not fetch ${url}: ${err instanceof Error ? err.message : String(err)}`)
      }
      if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`)
      const declaredLen = Number(res.headers.get('content-length') ?? NaN)
      if (Number.isFinite(declaredLen) && declaredLen > MAX_IMAGE_BYTES) {
        throw new Error(`Image is too large to display (${declaredLen} bytes; max ${MAX_IMAGE_BYTES}).`)
      }
      const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      const mimeType = normalizeImageMime(contentType) ?? IMAGE_MIME_BY_EXT[extOf(url.pathname)]
      if (!mimeType) {
        throw new Error(
          `URL did not return a supported image type (got "${contentType || 'unknown'}"). Supported: ${SUPPORTED_IMAGE_TYPES_TEXT}.`
        )
      }
      const buffer = await readBodyCapped(res, MAX_IMAGE_BYTES)
      const caption = args.caption ? String(args.caption).trim().slice(0, 300) : undefined
      return { type: 'image', mimeType, data: buffer.toString('base64'), url: url.toString(), ...(caption ? { caption } : {}) }
    }
  },
  ...webTools,
  {
    name: 'fs_write',
    description: 'Write (create or overwrite) a text file. Creates parent directories.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        content: { type: 'string' }
      },
      required: ['path', 'content']
    },
    resource: 'filesystem',
    action: 'create',
    riskTier: 'R1',
    allowedInPlan: false,
    summarize: (a) => `Write ${a.path} (${String(a.content ?? '').length} chars)`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      await mkdir(dirname(path), { recursive: true })
      const handle = await open(
        path,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o644
      )
      try {
        await handle.writeFile(String(args.content), 'utf8')
      } finally {
        await handle.close()
      }
      return { path, bytes: Buffer.byteLength(String(args.content)) }
    }
  },
  {
    name: 'fs_edit',
    description:
      'Replace an exact string in a file. old_string must appear exactly once unless replace_all is true.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        old_string: { type: 'string' },
        new_string: { type: 'string' },
        replace_all: { type: 'boolean' }
      },
      required: ['path', 'old_string', 'new_string']
    },
    resource: 'filesystem',
    action: 'edit',
    riskTier: 'R1',
    allowedInPlan: false,
    summarize: (a) => `Edit ${a.path}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      const handle = await open(path, constants.O_RDWR | constants.O_NOFOLLOW)
      try {
        const fileStat = await handle.stat()
        if (fileStat.size > MAX_READ_BYTES) {
          throw new Error(`File is too large to edit safely (${fileStat.size} bytes; max ${MAX_READ_BYTES}).`)
        }
        const content = await handle.readFile('utf8')
        const oldStr = String(args.old_string)
        const count = content.split(oldStr).length - 1
        if (count === 0) throw new Error('old_string not found in file')
        if (count > 1 && !args.replace_all)
          throw new Error(`old_string appears ${count} times; pass replace_all or add context`)
        const next = args.replace_all
          ? content.split(oldStr).join(String(args.new_string))
          : content.replace(oldStr, String(args.new_string))
        await handle.truncate(0)
        await handle.write(next, 0, 'utf8')
        return { path, replacements: args.replace_all ? count : 1 }
      } finally {
        await handle.close()
      }
    }
  },
  {
    name: 'fs_list',
    description: 'List a directory: names, kinds, and sizes.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `List ${a.path}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      const entries = await readdir(path, { withFileTypes: true })
      const rows = await Promise.all(
        entries.slice(0, 500).map(async (e) => {
          let size: number | undefined
          if (e.isFile()) {
            try {
              size = (await stat(join(path, e.name))).size
            } catch {
              /* ignore */
            }
          }
          return { name: e.name, kind: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'link' : 'file', size }
        })
      )
      return { path, entries: rows }
    }
  },
  {
    name: 'fs_mkdir',
    description: 'Create a directory, including any missing parent directories. No-op if it already exists.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string' } },
      required: ['path']
    },
    resource: 'filesystem',
    action: 'create',
    riskTier: 'R1',
    allowedInPlan: false,
    summarize: (a) => `Create directory ${a.path}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      await mkdir(path, { recursive: true })
      return { path, created: true }
    }
  },
  {
    name: 'fs_move',
    description:
      'Move or rename a file or directory. Fails if the destination exists unless overwrite is true. Creates missing parent directories.',
    parameters: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Source path' },
        to: { type: 'string', description: 'Destination path' },
        overwrite: { type: 'boolean', description: 'Replace an existing destination' }
      },
      required: ['from', 'to']
    },
    resource: 'filesystem',
    action: 'edit',
    riskTier: 'R1',
    allowedInPlan: false,
    pathArgs: ['from', 'to'],
    summarize: (a) => `Move ${a.from} → ${a.to}`,
    async run(args, ctx) {
      const from = resolveToolPath(String(args.from), ctx)
      const to = resolveToolPath(String(args.to), ctx)
      assertNotRoot(from, ctx, 'move')
      await lstat(from) // surfaces a clear ENOENT if the source is missing
      if (!args.overwrite && (await pathExists(to))) {
        throw new Error(`Destination already exists; pass overwrite: true to replace it: ${to}`)
      }
      await mkdir(dirname(to), { recursive: true })
      try {
        await rename(from, to)
      } catch (err) {
        // rename can't cross filesystems; fall back to copy + remove.
        if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err
        await cp(from, to, { recursive: true, force: !!args.overwrite, errorOnExist: !args.overwrite })
        await rm(from, { recursive: true, force: true })
      }
      return { from, to, moved: true }
    }
  },
  {
    name: 'fs_delete',
    description:
      'Delete a file or directory. Deleting a directory requires recursive: true. This is irreversible — it does not use the system trash.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string' },
        recursive: { type: 'boolean', description: 'Required to remove a non-empty or any directory' }
      },
      required: ['path']
    },
    resource: 'filesystem',
    action: 'delete',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) => `Delete ${a.path}${a.recursive ? ' (recursive)' : ''}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      assertNotRoot(path, ctx, 'delete')
      const info = await lstat(path) // no-follow: removes a symlink itself, not its target
      const isDir = info.isDirectory()
      if (isDir && !args.recursive) {
        throw new Error('Path is a directory; pass recursive: true to remove it.')
      }
      await rm(path, { recursive: isDir, force: false })
      return { path, removed: true, kind: isDir ? 'dir' : info.isSymbolicLink() ? 'link' : 'file' }
    }
  },
  {
    name: 'shell',
    description:
      'Run a command in a persistent login shell (your $SHELL, e.g. zsh) rooted at the workspace ' +
      'and return its output. Working directory, environment variables, and shell state persist ' +
      'across calls, so `cd` sticks and your normal PATH (Homebrew, node, git, etc.) is available. ' +
      'stdout and stderr are combined. A foreground command may block you for at most 20 seconds: ' +
      'anything still running then is moved to the background automatically (it keeps running as a ' +
      'job, you get its jobId and output-so-far, and its full output is delivered to you as a new ' +
      'message when it finishes). Anything you already know is long (a download, a build, an ' +
      'install, a test suite, a scan, a benchmark, a server) should start that way: pass ' +
      '`background: true` — or call `start_job`. Either way, CONTINUE WORKING on what does not ' +
      'depend on it, or find a faster way; never wait by running `sleep`. Example: ' +
      '{"command": "npm test", "background": true, "purpose": "Run the unit tests"}. Always give a ' +
      'short `purpose` — it is the label the user sees for this command. Do NOT explain a command ' +
      'with comment lines inside it (`# run the benchmark`, docstrings, echo banners): the command ' +
      'should be just the command, and the explanation goes in `purpose`. Do NOT pipe a long ' +
      'command through `tail`/`head` to shorten its output — that hides ALL output until it ends; ' +
      'let it stream and read the last lines with job_status `tail`.',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description:
            'The shell command to run — just the command, no explanatory comment lines (put the ' +
            'explanation in `purpose`).'
        },
        purpose: {
          type: 'string',
          description:
            'A short human label for what this command is for (3–8 words, e.g. "Run the unit tests", ' +
            '"Benchmark tokens/sec on the 3 hosts"). Shown to the user as the label of this command ' +
            'in the transcript and in the background-jobs panel. Always provide one.'
        },
        cwd: { type: 'string', description: 'Run from this directory (persists for later commands)' },
        timeout_ms: {
          type: 'number',
          description:
            'How long to wait in the foreground before the command is moved to the background, in ' +
            'ms. Capped at 20000 for you — asking for more does not make you wait longer; the ' +
            'command simply continues as a background job and reports back when it finishes. Pass ' +
            'a smaller value for a quick check. (Inside a subagent, which cannot background work, ' +
            'this is a hard timeout of up to 600000.)'
        },
        background: {
          type: 'boolean',
          description:
            'true = start the command as a detached BACKGROUND job and return a jobId immediately ' +
            'instead of waiting. The job keeps running after this turn ends and its output is ' +
            'delivered to you automatically when it finishes. Use it for anything that takes more ' +
            'than a few seconds (downloads, builds, installs, test suites, scans, servers). ' +
            'job_status shows or waits on it; stop_job cancels it. The persistent working ' +
            'directory / shell state is NOT shared with a background job.'
        }
      },
      required: ['command']
    },
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) => {
      const purpose = purposeOf(a)
      const head = a.background ? 'Run (background)' : 'Run'
      return purpose
        ? `${head}: ${purpose} — ${String(a.command).slice(0, 80)}`
        : `${head}: ${String(a.command).slice(0, 120)}`
    },
    async run(args, ctx) {
      const timeout = Math.min(Math.max(Number(args.timeout_ms) || 120000, 1000), 600000)
      const cwd = shellCwd(args, ctx)
      const command = String(args.command)
      const purpose = purposeOf(args)
      if (args.background) return startBackgroundJob(command, cwd, ctx, purpose)
      // `sleep 115; echo tick` is a model polling for a background job — the one thing a background
      // job exists to make unnecessary (it reports back on its own). Refuse the wait with a pointer
      // to the right mechanism instead of burning the timeout (and, with auto-background, turning
      // the sleep itself into a job that pings back later).
      const sleepSecs = leadingSleepSeconds(command)
      if (sleepSecs !== null && sleepSecs >= SLEEP_POLL_MIN_S) {
        const running = listJobs(ctx.threadMeta.id).filter((j) => j.running)
        if (running.length > 0) {
          const list = running.map((j) => `${j.id} (\`${j.command.slice(0, 80)}\`)`).join(', ')
          throw new Error(
            `Refused: do not wait with \`sleep ${sleepSecs}\`. Your background job(s) — ${list} — ` +
              'report back to you AUTOMATICALLY as a new message when they finish, so keep working ' +
              'on something else or end your turn now. To block until one is done, call job_status ' +
              '(it waits, bounded by timeout_ms) instead of sleeping.'
          )
        }
        if (sleepSecs * 1000 >= timeout) {
          throw new Error(
            `Refused: \`sleep ${sleepSecs}\` is longer than this call's ${Math.round(timeout / 1000)}s ` +
              'timeout, so it could never finish. If you are waiting on a background job, call ' +
              'job_status (it waits, bounded by timeout_ms) — or simply end your turn: the job ' +
              'reports back automatically when it finishes. Otherwise poll with a short command.'
          )
        }
      }
      // Only a top-level run can be pinged on completion, so only there do we auto-background a
      // command — and there it never blocks past the grace window, whatever timeout_ms asked for.
      // Inside a subagent (no promoteShellToBackground) the timeout keeps its original "kill and
      // report timedOut" behaviour.
      const promote = ctx.promoteShellToBackground
      const graceMs = foregroundGraceMs(timeout, !!promote)
      const startedAt = Date.now()
      try {
        const outcome = await runInShellPromotable(ctx.threadMeta.id, command, {
          cwd: args.cwd ? cwd : undefined,
          timeoutMs: timeout,
          signal: ctx.signal,
          backgroundAfterMs: graceMs,
          // Live output to the transcript's tool row while the command runs in the foreground.
          onOutput: throttledProgress(ctx.progress)
        })
        if (outcome.backgrounded) {
          // Register the still-running command as a background job (with a live peek at its output)
          // and arrange the completion ping.
          const job = adoptShellJob(ctx.threadMeta.id, command, {
            startedAt: outcome.startedAt,
            outputSoFar: outcome.outputSoFar,
            done: outcome.done.then((r) => ({ exitCode: r.exitCode, output: r.output })),
            stop: outcome.stop,
            peek: outcome.peek,
            purpose
          })
          promote!({ jobId: job.id, command, kind: 'timeout', purpose })
          const waited = Math.round((graceMs ?? timeout) / 1000)
          return {
            jobId: job.id,
            status: 'running',
            background: true,
            autoBackgrounded: true,
            startedAt: outcome.startedAt,
            ...(purpose ? { purpose } : {}),
            partialOutput: outcome.outputSoFar,
            note:
              `Still running after ${waited}s, so it was moved to the background as job ${job.id} and ` +
              'keeps running — you are NOT stuck waiting. CONTINUE WORKING: do the next thing that ' +
              'does not depend on its output, or find a faster way to get what you needed (a smaller ' +
              'sample, a narrower query, a quicker check). Its full output will be delivered to you ' +
              'automatically as a new message when it finishes. Peek at its live output any time ' +
              `with job_status({"jobs":["${job.id}"],"wait":false,"tail":40}); block on it ` +
              '(job_status wait:true) only if the rest of the task truly cannot proceed without it. ' +
              'Never poll with sleep. stop_job cancels it. Next time, start work like this with ' +
              'background: true (or start_job) up front.'
          }
        }
        const r = outcome.result
        const hint = r.timedOut || r.canceled ? undefined : slowCommandHint(Date.now() - startedAt)
        return {
          exitCode: r.exitCode,
          stdout: r.output,
          stderr: '',
          cwd: r.cwd,
          timedOut: r.timedOut,
          canceled: r.canceled,
          ...(hint ? { hint } : {})
        }
      } catch (err) {
        // A deliberate refusal above must reach the model as-is, not be swallowed by the fallback.
        if (err instanceof Error && err.message.startsWith('Refused:')) throw err
        // node-pty unavailable (e.g. native module failed to build): fall back to a
        // one-shot login shell so PATH is still sourced correctly. No state persists.
        return runLoginShellOnce(command, cwd, timeout, ctx.signal)
      }
    }
  },
  {
    name: 'start_job',
    description:
      'Start a long-running shell command as a BACKGROUND job and return immediately with a jobId. ' +
      'Use it for anything that takes more than a few seconds: downloads, builds, installs, test ' +
      'suites, scans, servers. The job keeps running after this turn ends, and when it finishes its ' +
      'output is delivered to you automatically as a new message — so keep working on other things ' +
      'or end your turn; do NOT poll with sleep. Check on it any time with job_status (which can ' +
      'also wait for it), or cancel it with stop_job. Example: {"command": "npm test", "purpose": ' +
      '"Run the unit tests"}. Equivalent to shell with background: true. Always give a short ' +
      '`purpose` — it is the label the user sees for this job; never explain a command with comment ' +
      'lines inside it, and never pipe it through `tail`/`head` (that hides all live output until the ' +
      'end — read the last lines with job_status `tail` instead).',
    parameters: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to run (login shell, your normal PATH) — just the command, no comment lines.'
        },
        purpose: {
          type: 'string',
          description:
            'A short human label for what this job is for (3–8 words, e.g. "Build the release bundle"). ' +
            'Shown to the user as the job\'s name in the transcript and the background-jobs panel. Always provide one.'
        },
        cwd: { type: 'string', description: 'Directory to run it from (defaults to the workspace root).' }
      },
      required: ['command']
    },
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) => {
      const purpose = purposeOf(a)
      return purpose
        ? `Run (background): ${purpose} — ${String(a.command).slice(0, 80)}`
        : `Run (background): ${String(a.command).slice(0, 120)}`
    },
    async run(args, ctx) {
      return startBackgroundJob(String(args.command), shellCwd(args, ctx), ctx, purposeOf(args))
    }
  },
  {
    name: 'job_status',
    description:
      'Check on background jobs (started with start_job, shell background:true, or a foreground ' +
      'command that was moved to the background): status, exit code, elapsed time, and the output ' +
      'captured so far — LIVE while the job runs. You do not normally need this: a finished job is ' +
      'delivered to you automatically as a new message. By default it PEEKS (wait:false) — pass a ' +
      '`tail` to read the last lines — so you can see how a job is getting on while you keep working. ' +
      'wait:true blocks until the job finishes but is CAPPED at 20 seconds whatever `timeout_ms` ' +
      'says (a longer wait would only park you; the result arrives on its own): use it only when the ' +
      'rest of the task truly cannot proceed without the result. Omit `jobs` to target every job on ' +
      'this thread. Never wait on a job by running sleep.',
    parameters: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job ids to target (from start_job / shell background:true). Omit to target all of this thread\'s jobs.'
        },
        wait: {
          type: 'boolean',
          description:
            'false (default) = peek at the current status and output now. true = block until the ' +
            'targeted jobs finish, capped at 20 seconds; the jobs keep running and still report back ' +
            'automatically when they finish.'
        },
        timeout_ms: {
          type: 'number',
          description:
            'When waiting, how long to block before returning the current status. Capped at 20000 for ' +
            'you (a subagent may wait up to 600000). Asking for more never makes you wait longer.'
        },
        tail: {
          type: 'number',
          description: 'Return only the last N lines of each job\'s output (omit for the full captured output).'
        }
      }
    },
    // Read-only inspection of your own background work — R0 read so you can always check on jobs,
    // even in review/manual (where you could not start one).
    resource: 'shell',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => {
      const scope = Array.isArray(a.jobs) ? ` [${(a.jobs as unknown[]).length}]` : ' [all]'
      return `Check background jobs${scope}`
    },
    async run(args, ctx) {
      const all = listJobs(ctx.threadMeta.id)
      const ids =
        Array.isArray(args.jobs) && args.jobs.length
          ? args.jobs.map((j) => String(j))
          : all.map((j) => j.id)
      const wait = args.wait === true
      const timeoutMs = jobWaitMs(Number(args.timeout_ms), !!ctx.promoteShellToBackground)
      const views = wait
        ? await waitJobs(ids, ctx.signal, timeoutMs)
        : ids.map((id) => getJob(id)).filter((v): v is NonNullable<typeof v> => !!v)
      // The model is reading these results itself right now — claim any finished background jobs
      // so their completion is not ALSO pushed back as a separate ping turn.
      const finished = views.filter((v) => !v.running).map((v) => v.id)
      if (finished.length) ctx.claimShellJobsDelivery?.(finished)
      const tail = Number(args.tail)
      const now = Date.now()
      const shaped = views.map((v) => {
        const buffered = v.running && !v.output.trim() ? bufferedByPipe(v.command) : null
        return {
          ...(tail > 0 ? { ...v, output: v.output.split('\n').slice(-tail).join('\n') } : v),
          elapsedMs: (v.endedAt ?? now) - v.startedAt,
          ...(buffered
            ? { liveOutputNote: `No output yet because the command pipes through \`${buffered}\`, which holds everything until it ends.` }
            : {})
        }
      })
      const running = shaped.filter((j) => j.running).length
      // A bounded wait that expired with work still running: say so, and say what to do instead of
      // calling back in a loop — the completion arrives on its own.
      const waitExpired = wait && running > 0 && !ctx.signal.aborted
      return {
        jobs: shaped,
        running,
        ...(waitExpired
          ? {
              timedOut: true,
              note:
                `${running} job(s) still running after waiting ${Math.round(timeoutMs / 1000)}s` +
                (timeoutMs === JOB_WAIT_MAX_MS ? ' (the maximum — a longer wait is never granted)' : '') +
                '. They keep running, and their output will be delivered to you automatically as a new ' +
                'message when they finish — CONTINUE WORKING on something that does not depend on ' +
                'them, or find a faster way, or end your turn. Do NOT call job_status wait:true again ' +
                'for the same jobs, and never poll with sleep.'
            }
          : {})
      }
    }
  },
  {
    name: 'stop_job',
    description:
      'Cancel background jobs (started with start_job or shell background:true) — sends SIGTERM to ' +
      'each still running. Pass the job ids in `jobs`. Use it to kill a stuck or no-longer-needed ' +
      'download/build/server.',
    parameters: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job ids to stop (from start_job / shell background:true).'
        }
      },
      required: ['jobs']
    },
    // Terminating your own background job is low-risk self-management — R0 execute so it is gated
    // like run_agent/agent_result (available in workspace/full without a prompt, absent in review/manual).
    resource: 'shell',
    action: 'execute',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Stop background job(s)${Array.isArray(a.jobs) ? ` [${(a.jobs as unknown[]).length}]` : ''}`,
    async run(args) {
      const ids = Array.isArray(args.jobs) ? args.jobs.map((j) => String(j)) : []
      if (!ids.length) throw new Error('jobs is required: pass the job id(s) to stop.')
      const stopped = ids.filter((id) => stopJob(id))
      return { stopped, notRunning: ids.filter((id) => !stopped.includes(id)) }
    }
  },
  {
    name: 'grep_search',
    description: 'Search file contents with a regex using ripgrep.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string' },
        path: { type: 'string' },
        glob: { type: 'string', description: 'optional filename filter, e.g. *.ts' }
      },
      required: ['pattern', 'path']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Search /${a.pattern}/ in ${a.path}`,
    run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
      const commandArgs = ['-n', '--max-count', '200', '-e', String(args.pattern)]
      if (args.glob) commandArgs.push('-g', String(args.glob))
      commandArgs.push(path)
      return new Promise((resolvePromise) => {
        execFile(
          'rg',
          commandArgs,
          { timeout: 30000, maxBuffer: 4 * 1024 * 1024, signal: ctx.signal },
          (err, stdout, stderr) => {
            if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
              resolvePromise({ matches: '(ripgrep is not installed)' })
              return
            }
            resolvePromise({ matches: clip(stdout || stderr || '(no matches)') })
          }
        )
      })
    }
  },
  {
    name: 'todo_write',
    description:
      'Create or update items on the run checklist. Pass the full list state each time: [{id?, title, status, parentId?}]. ' +
      'Statuses: todo|in_progress|blocked|review|done|canceled. The panel renders each item as a checkbox — set status ' +
      '"done" to check an item off the moment it is finished. To nest a subtask under a parent, set its `parentId` to the ' +
      "parent item's id (send the parent first, or reuse an id it already has). Keep ids stable across calls so updates land " +
      'on the same rows instead of creating duplicates.',
    parameters: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              title: { type: 'string' },
              status: { type: 'string' },
              details: { type: 'string' },
              parentId: {
                type: 'string',
                description: 'id of the parent item this is a subtask of; omit for a top-level task'
              }
            },
            required: ['title', 'status']
          }
        }
      },
      required: ['items']
    },
    resource: 'filesystem',
    action: 'edit',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Update checklist (${Array.isArray(a.items) ? (a.items as unknown[]).length : 0} items)`,
    async run(args, ctx) {
      const items = args.items as {
        id?: string
        title: string
        status: string
        details?: string
        parentId?: string
      }[]
      const saved = items.map((it) =>
        store.upsertTodo({
          id: it.id,
          title: it.title,
          status: (['todo', 'in_progress', 'blocked', 'review', 'done', 'canceled'].includes(it.status)
            ? it.status
            : 'todo') as 'todo',
          details: it.details,
          parentId: it.parentId,
          threadId: ctx.threadMeta.id,
          workspaceId: ctx.workspace.id,
          durable: false
        })
      )
      return { items: saved.map((s) => ({ id: s.id, title: s.title, status: s.status, parentId: s.parentId })) }
    }
  },
  {
    name: 'memory_save',
    description:
      'Propose a durable memory item (a preference, fact, decision, environment note, or warning). The user reviews proposals.',
    parameters: {
      type: 'object',
      properties: {
        content: { type: 'string' },
        type: { type: 'string', enum: ['preference', 'fact', 'decision', 'environment', 'warning', 'note'] },
        scope: { type: 'string', enum: ['user', 'workspace', 'thread'] }
      },
      required: ['content']
    },
    resource: 'filesystem',
    action: 'create',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Save memory: ${String(a.content).slice(0, 80)}`,
    async run(args, ctx) {
      const item = store.upsertMemory({
        content: String(args.content),
        type: (args.type as 'note') ?? 'note',
        scope: (args.scope as 'user') ?? 'user',
        scopeId: args.scope === 'thread' ? ctx.threadMeta.id : undefined,
        author: 'model',
        status: 'proposed'
      })
      return { id: item.id, status: item.status }
    }
  },
  {
    name: 'set_thread_title',
    description:
      'Rename the current conversation. Give the thread a short, specific title (2–6 words, Title ' +
      'Case) that captures what it is about. In a brand-new conversation, call this as your very ' +
      'FIRST tool call — alone in that round, before any other tool or work — with a title for what ' +
      'the user just asked for. You MUST call it again whenever the conversation\'s goal shifts ' +
      'significantly — a new task, a different problem, a pivot in scope — so the sidebar describes ' +
      'what the chat is about NOW. (Not for refinements or debugging of the same task.) Keep it ' +
      'terse and human-readable — no quotes, no trailing punctuation.',
    parameters: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The new thread title (2–6 words, Title Case).' }
      },
      required: ['title']
    },
    // Store-backed self-management, like todo_write: tagged filesystem but takes no path, so the
    // broker's path check is skipped. Always allowed (see toolEffect) — renaming the chat is
    // cosmetic and safe in every mode/preset.
    resource: 'filesystem',
    action: 'edit',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Rename thread → ${String(a.title ?? '').slice(0, 60)}`,
    async run(args, ctx) {
      const title = String(args.title ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80)
      if (!title) throw new Error('title must be a non-empty string')
      // 'agent' provenance: the model deliberately named this chat, so auto-titling leaves it
      // alone from here on (the model can still rename it again itself on a topic shift).
      const meta = store.updateThread(ctx.threadMeta.id, { title, titleSource: 'agent' })
      return { id: meta.id, title: meta.title }
    }
  },
  {
    name: 'run_agent',
    description:
      'Delegate a self-contained sub-task to an isolated subagent. The subagent starts with a ' +
      'clean context (only the task you give it — it cannot see this conversation), works ' +
      'autonomously, and returns its final answer as the result. Use it to parallelize ' +
      'independent work or to keep a large search/investigation out of your own context. Give ' +
      'it one bounded goal and say exactly what to return. A subagent cannot spawn further ' +
      'subagents. By default it inherits your full tool set; pass `tools` to hand it only the ' +
      'tools its task needs (e.g. ["fs_read","grep_search"] for a read-only investigation). ' +
      'Always give it a short `name` — it is shown to the user in the live agents panel.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The complete, self-contained instruction for the subagent.'
        },
        name: {
          type: 'string',
          description:
            'A short, human-readable name for this subagent (2–4 words, Title Case) that says what ' +
            'it is doing, e.g. "Auth Bug Hunt", "Docs Researcher", "Test Writer". Shown to the user ' +
            'in the live agents panel instead of a random id. Always provide one.'
        },
        agent_type: {
          type: 'string',
          description: 'Optional role label for the subagent, e.g. "researcher" or "reviewer".'
        },
        model: {
          type: 'string',
          description:
            'Optional model id to run the subagent on (defaults to yours). Must be your own model or ' +
            'one of the subagent models listed under "# Subagent models" in your system prompt — ' +
            'the user designates those in Settings; any other id is refused.'
        },
        effort: { type: 'string', description: 'Optional reasoning effort override.' },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional allowlist of tool names to grant the subagent (from the tools available to ' +
            'you, e.g. "fs_read", "grep_search", "shell"). Omit to give it everything you have. ' +
            'Pass a subset to scope it tightly, or [] for a text-only subagent. You cannot grant ' +
            '"run_agent" or "ask_user" — subagents never get those. Names your current ' +
            'mode/permission preset denies are silently dropped; the result echoes what it got.'
        },
        background: {
          type: 'boolean',
          description:
            'When true, start the subagent in the BACKGROUND and return immediately with a handle ' +
            '(agentId + name) instead of blocking until it finishes. Its result is delivered back to ' +
            'you automatically as a new turn when it finishes, so never wait for it, poll it, or ' +
            'promise to act on it later. Spawning it is not the end of your job: continue right away ' +
            'with every part of the task that does not depend on its result (spawn several this way ' +
            'to run independent work in parallel — each reports back on its own). End your turn only ' +
            'when nothing remains that you can do without those results, and then say in one line ' +
            'what you are waiting on. (Call agent_result only if you want to deliberately wait; it ' +
            'returns as soon as the first targeted agent finishes.) Default false (blocks until the ' +
            'subagent is done, returning its answer directly).'
        }
      },
      required: ['task']
    },
    resource: 'network',
    action: 'execute',
    // R0 so it's available under the default preset; the subagent's own tool calls are gated
    // by the same mode/preset as the parent, so aggregate risk stays bounded.
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => {
      const scope = Array.isArray(a.tools) ? ` [${(a.tools as unknown[]).length} tools]` : ''
      return `Delegate to subagent${scope}: ${String(a.task ?? '').slice(0, 80)}`
    },
    async run(args, ctx) {
      if (!ctx.runSubagent) {
        throw new Error('Subagents are not available here (a subagent cannot spawn subagents).')
      }
      const task = String(args.task ?? '').trim()
      if (!task) throw new Error('task is required and must be a non-empty string.')
      const tools = validateSubagentToolAllowlist(args.tools)
      // The user controls which models a subagent may run on (Settings → Subagent models). Refuse an
      // off-list id here, naming the choices, rather than letting the subagent fail at the gateway
      // minutes later — and never let a model quietly "upgrade" its delegates past the allowed set.
      const model = args.model ? String(args.model).trim() : undefined
      if (model && ctx.subagentModels && !ctx.subagentModels.includes(model)) {
        throw new Error(
          `Model "${model}" is not available for subagents. Use one of: ` +
            ctx.subagentModels.map((m) => `"${m}"`).join(', ') +
            ' (your own model, or a model the user designated as a subagent model in Settings) — or omit `model` to use your own.'
        )
      }
      const spec = {
        task,
        name: args.name ? String(args.name).slice(0, 60) : undefined,
        agentType: args.agent_type ? String(args.agent_type) : undefined,
        model: model || undefined,
        effort: args.effort ? String(args.effort) : undefined,
        tools,
        parentCallId: ctx.callId
      }
      if (args.background) {
        if (!ctx.spawnBackgroundAgent) throw new Error('Background subagents are not available here.')
        const handle = ctx.spawnBackgroundAgent(spec)
        return {
          agentId: handle.agentId,
          name: handle.name,
          status: 'running',
          background: true,
          note:
            'Started in the background. Its result will be delivered back to you automatically as a ' +
            'new turn when it finishes — do not wait for it, poll it, or promise to act on it later. ' +
            'Continue now with everything that does not depend on it. If nothing remains that you ' +
            'can do without its result, end your turn with one line saying what you are waiting on. ' +
            '(Call agent_result only to deliberately block until it is done.)'
        }
      }
      const res = await ctx.runSubagent(spec)
      return { agentId: res.agentId, toolCalls: res.toolCalls, tools: res.toolNames, result: res.text }
    }
  },
  {
    name: 'agent_result',
    description:
      'OPTIONALLY check on or wait for background subagents you started with run_agent(background:true). ' +
      'You do not normally need this: a background agent delivers its result back to you automatically ' +
      'as a new turn when it finishes. Reach for this only to DELIBERATELY wait — but it returns as soon ' +
      'as the FIRST targeted agent finishes (with any already-finished ones), NOT once they all do: you ' +
      'get the earliest result to act on right away, and any still-running agents keep going and deliver ' +
      'their own result as a new turn when THEY finish. The wait is CAPPED at 20 seconds: if nothing ' +
      'has finished by then you get their running status back and must CONTINUE WORKING (or end your ' +
      'turn) — the results arrive on their own. Pass wait:false to peek at current status ' +
      '(running/done/error) without blocking. Omit `agents` to target every background agent you have. ' +
      'A finished result you collect here is handed to you inline and will NOT also arrive as a separate turn.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Agent ids or names to target (as returned by run_agent). Omit to target every ' +
            'background agent you started this run.'
        },
        wait: {
          type: 'boolean',
          description:
            'Wait for a targeted agent to finish before returning (default true) — returns as soon as ' +
            'the first one does, leaving any others to finish and deliver on their own. Pass false to ' +
            'poll their status right now without blocking.'
        }
      }
    },
    // Part of the delegation machinery — mirror run_agent's profile (network/execute/R0) so the two
    // are offered together: where the preset forbids spawning a subagent, collecting one has nothing
    // to gather, so agent_result is withheld too (review/manual) rather than advertised uselessly.
    resource: 'network',
    action: 'execute',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => {
      const scope = Array.isArray(a.agents) ? ` [${(a.agents as unknown[]).length}]` : ' [all]'
      return `Collect background subagents${scope}`
    },
    async run(args, ctx) {
      if (!ctx.collectAgents) {
        throw new Error('Background subagents are not available here (only the main agent tracks them).')
      }
      const agents = Array.isArray(args.agents)
        ? args.agents.map((n) => String(n)).filter((n) => n.length > 0)
        : undefined
      const wait = args.wait !== false
      const results = await ctx.collectAgents({ agents, wait })
      const pending = results.filter((r) => r.status === 'running').length
      // wait:true and nothing finished: the capped wait expired. Say so, once, in the model's face.
      const capped = wait && results.length > 0 && pending === results.length
      return {
        agents: results,
        pending,
        ...(capped
          ? {
              timedOut: true,
              note:
                `None of the ${pending} targeted agent(s) finished within the 20 s wait cap. They keep ` +
                'working and each delivers its result to you automatically as a new turn when it finishes. ' +
                'CONTINUE WORKING on what does not depend on them, or end your turn — do not call ' +
                'agent_result wait:true again for the same agents, and never wait with sleep.'
            }
          : {})
      }
    }
  },
  {
    name: 'peek_agents',
    description:
      'Check IN on background subagents you started with run_agent(background:true) — a live, ' +
      'read-only glance at what each one is doing RIGHT NOW: its current activity, the tool it is ' +
      'running this instant, how many tool calls it has completed, how long it has been going (and ' +
      'how long since it last did anything), and a tail of its latest output. It never blocks and, ' +
      'unlike agent_result, never consumes an agent — a still-running agent keeps going and a ' +
      "finished one's result still arrives on its own as a new turn. Reach for it to decide whether " +
      'to keep waiting, steer an agent, or move on. Omit `agents` to peek at every background agent.',
    parameters: {
      type: 'object',
      properties: {
        agents: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Agent ids or names to peek at (as returned by run_agent). Omit to peek at every ' +
            'background agent you started this run.'
        }
      }
    },
    // Read-only, but mirror run_agent/agent_result's profile (network/execute/R0) so the delegation
    // trio is offered together: where the preset forbids spawning a subagent there is nothing to
    // peek at, so peek_agents is withheld too (review/manual) rather than advertised uselessly.
    resource: 'network',
    action: 'execute',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => {
      const scope = Array.isArray(a.agents) ? ` [${(a.agents as unknown[]).length}]` : ' [all]'
      return `Peek at background subagents${scope}`
    },
    async run(args, ctx) {
      if (!ctx.peekAgents) {
        throw new Error('Background subagents are not available here (only the main agent tracks them).')
      }
      const agents = Array.isArray(args.agents)
        ? args.agents.map((n) => String(n).trim()).filter((n) => n.length > 0)
        : undefined
      const peeks = ctx.peekAgents({ agents })
      return { agents: peeks, running: peeks.filter((p) => p.status === 'running').length }
    }
  },
  {
    name: 'ask_user',
    description:
      'Pause and ask the user a question, then continue with their answer. Use this when you ' +
      'genuinely need information or a decision only the user can provide — a missing detail, ' +
      'a choice between real alternatives, or confirmation before a consequential step — and you ' +
      'cannot get it from the conversation, the files, or a sensible default. Do NOT use it to ' +
      'ask permission for tool calls (the permission system handles that) or for anything you can ' +
      'determine yourself. Prefer one well-formed question over several round-trips. ' +
      'WHENEVER the answer is a choice, pass `options`: give your single recommended pick plus a ' +
      'few real alternatives (aim for 4 total) and mark the best one with recommended:true — the ' +
      'user always also gets a free-form "Other" field to write their own answer, so never add an ' +
      '"Other" option yourself. The tool blocks until the user responds; the result is ' +
      '{ answer } (or { canceled: true } if they dismiss it), so handle a canceled/empty answer ' +
      'gracefully rather than asking again.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to put to the user. Be specific and self-contained.' },
        kind: {
          type: 'string',
          enum: ['text', 'choice', 'confirm'],
          description:
            "'text' for a free-form answer, 'choice' to pick one of `options`, 'confirm' for yes/no. " +
            'Defaults to choice when options are given, otherwise text.'
        },
        options: {
          type: 'array',
          items: {
            oneOf: [
              { type: 'string' },
              {
                type: 'object',
                properties: {
                  label: { type: 'string', description: 'The answer text (kept short and distinct).' },
                  description: { type: 'string', description: 'Optional one-line rationale shown under the label.' },
                  recommended: { type: 'boolean', description: 'Set true on the single option you suggest.' }
                },
                required: ['label']
              }
            ]
          },
          description:
            'The selectable answers for kind:"choice" (2–8 short, distinct options; 4 is the sweet spot — ' +
            'your recommended pick plus three alternatives). Each may be a plain string, or an object ' +
            '{ label, description?, recommended? } — mark the one you suggest with recommended:true (at ' +
            'most one; if you omit it, the first option is treated as recommended). Do NOT add an "Other" ' +
            'or "Something else" option yourself: a free-form "Other" field is always offered to the user ' +
            'automatically so they can write their own answer.'
        },
        placeholder: { type: 'string', description: 'Optional hint text for the input field (kind:"text").' },
        multiline: { type: 'boolean', description: 'Set true when a long, multi-line answer is expected.' }
      },
      required: ['question']
    },
    resource: 'external_action',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Ask the user: ${String(a.question ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      if (!ctx.ask) {
        throw new Error('Asking the user is not available here (a subagent cannot ask the user directly).')
      }
      const question = String(args.question ?? '').trim()
      if (!question) throw new Error('question is required and must be a non-empty string.')
      // Options may arrive as plain strings or as { label, description?, recommended? } objects.
      // Normalize both to AskOption, drop blanks and duplicate labels, and cap at 8. Only the
      // first option flagged recommended keeps the flag, so the UI never highlights two.
      let sawRecommended = false
      const options = Array.isArray(args.options)
        ? args.options
            .map((raw): AskOption | null => {
              const o: Record<string, unknown> =
                raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : { label: raw }
              const label = String(o.label ?? '').trim()
              if (!label) return null
              const opt: AskOption = { label }
              if (o.description) opt.description = String(o.description).trim()
              if (o.recommended && !sawRecommended) {
                sawRecommended = true
                opt.recommended = true
              }
              return opt
            })
            .filter((o): o is AskOption => o !== null)
            .filter((o, i, arr) => arr.findIndex((x) => x.label === o.label) === i)
            .slice(0, 8)
        : undefined
      const requested = ['text', 'choice', 'confirm'].includes(String(args.kind))
        ? (String(args.kind) as 'text' | 'choice' | 'confirm')
        : options && options.length
          ? 'choice'
          : 'text'
      // A 'choice' with no usable options would strand the user — fall back to text.
      const kind = requested === 'choice' && (!options || options.length < 1) ? 'text' : requested
      // Guarantee every choice surfaces a recommended pick: if the model marked none, treat the
      // first option as the suggestion so the user always gets a clear default to lean on.
      if (kind === 'choice' && options && options.length && !options.some((o) => o.recommended)) {
        options[0]!.recommended = true
      }
      const res = await ctx.ask({
        question,
        kind,
        options: kind === 'choice' ? options : undefined,
        placeholder: args.placeholder ? String(args.placeholder) : undefined,
        multiline: !!args.multiline
      })
      if (res.canceled) return { canceled: true, answer: null }
      return { answer: res.answer }
    }
  },
  {
    name: 'memory_search',
    description:
      'Keyword search over saved memory. Matches any word in the query (not an exact-phrase match), ' +
      'ranked by how many query words a memory contains. Searches both approved and proposed (not-yet-' +
      'reviewed) items; each result includes its status.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string' } },
      required: ['query']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Search memory: ${a.query}`,
    async run(args) {
      // Search approved + proposed so freshly self-learned / model-proposed facts are findable
      // before a human has reviewed them; rejected and expired items are excluded.
      const now = Date.now()
      const searchable = store
        .listMemory()
        .filter(
          (m) => (m.status === 'approved' || m.status === 'proposed') && (!m.expiresAt || m.expiresAt > now)
        )
      const items = rankMemorySearch(searchable, String(args.query)).slice(0, 20)
      return {
        items: items.map((m) => ({ id: m.id, scope: m.scope, type: m.type, status: m.status, content: m.content }))
      }
    }
  },
  // Inter-session messaging (Slice 9): list_sessions, send_message, check_inbox.
  ...sessionMessagingTools
]

/** Tools a subagent can never be granted — it cannot recurse or block on the user. */
// Tools a subagent can never be granted: it cannot spawn or track further agents (run_agent,
// agent_result, peek_agents), manage the thread's background jobs (start_job, job_status,
// stop_job — a subagent could never be pinged with, nor read back, a job's result), block on the
// user (ask_user), or rename the user's thread (set_thread_title).
const NEVER_DELEGATABLE = new Set([
  'run_agent',
  'agent_result',
  'peek_agents',
  'start_job',
  'job_status',
  'stop_job',
  'ask_user',
  'set_thread_title'
])

/**
 * Validate the `tools` allowlist a parent passes to `run_agent`. Returns `undefined` when the
 * caller omitted it (the subagent inherits the full set), or a cleaned, de-duplicated list of
 * requested names. Throws a model-readable error for a non-array, an unknown tool name, or a
 * request for a tool subagents can never have — so the model self-corrects rather than silently
 * spawning a mis-scoped subagent. An empty array is valid and means a text-only subagent.
 */
export function validateSubagentToolAllowlist(raw: unknown): string[] | undefined {
  if (raw === undefined || raw === null) return undefined
  if (!Array.isArray(raw)) throw new Error('tools must be an array of tool names.')
  const requested = [...new Set(raw.map((n) => String(n).trim()).filter((n) => n.length > 0))]
  const catalog = new Set([...builtinTools, ...mcpTools()].map((t) => t.name))
  const forbidden = requested.filter((n) => NEVER_DELEGATABLE.has(n))
  if (forbidden.length)
    throw new Error(
      `A subagent cannot be granted: ${forbidden.join(', ')}. Remove them from tools — subagents ` +
        'never get run_agent or ask_user.'
    )
  const unknown = requested.filter((n) => !catalog.has(n))
  if (unknown.length) {
    const valid = [...catalog].filter((n) => !NEVER_DELEGATABLE.has(n)).sort()
    throw new Error(`Unknown tool name(s): ${unknown.join(', ')}. Valid tools: ${valid.join(', ')}.`)
  }
  return requested
}
