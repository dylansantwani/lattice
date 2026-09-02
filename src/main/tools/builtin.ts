import { execFile } from 'node:child_process'
import { readdir, mkdir, stat, lstat, realpath, rename, rm, cp, open, readFile } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'
import type { AskOption } from '@shared/types'
import type { ToolContext, ToolDefinition } from './types'
import * as store from '../store/eventStore'
import { mcpTools } from '../mcp/manager'
import { runInShell } from './ptyShell'
import { startShellJob, listJobs, getJob, waitJobs, stopJob } from './bgJobs'
import { sessionMessagingTools } from './sessionTools'

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

/**
 * Loopback, private, link-local (which covers the 169.254.169.254 cloud-metadata address), and
 * CGNAT ranges — refused as fetch_image targets so a crafted URL can't use the app's network
 * access to probe the user's LAN or a cloud metadata endpoint. This is a best-effort check: it
 * validates the address(es) DNS resolves to *before* connecting, not the actual socket peer, so it
 * does not fully defeat DNS-rebinding — but it stops the overwhelmingly common case of a literal
 * private/loopback host or IP appearing in the URL.
 */
const PRIVATE_NETWORK_BLOCKLIST = new BlockList()
PRIVATE_NETWORK_BLOCKLIST.addRange('0.0.0.0', '0.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('10.0.0.0', '10.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('100.64.0.0', '100.127.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('127.0.0.0', '127.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('169.254.0.0', '169.254.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('172.16.0.0', '172.31.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('192.168.0.0', '192.168.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('::1', 128, 'ipv6')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6')
// No separate ::ffff:0:0/96 (IPv4-mapped) rule: Node's BlockList already treats an IPv4-mapped
// IPv6 literal (::ffff:127.0.0.1, or its canonical ::ffff:7f00:1 form) as covered by the plain
// ipv4 ranges above when checked with family 'ipv6' — adding that subnet ourselves does the
// opposite of what its name suggests: BlockList shares one address space under the hood, so an
// explicit ::ffff:0:0/96 *ipv6* rule also matches every *plain ipv4* address checked as 'ipv4'
// (verified: with it present, check('93.184.216.34', 'ipv4') came back true) — silently refusing
// every public IPv4 target.

async function assertPublicHost(hostname: string): Promise<void> {
  // `URL#hostname` keeps the brackets around an IPv6 literal (e.g. "[::1]"); strip them before
  // anything below, or isIP sees a non-IP string and it falls through to a doomed DNS lookup.
  const host = hostname.replace(/^\[(.+)\]$/, '$1')
  if (host.toLowerCase() === 'localhost') {
    throw new Error('Refusing to fetch from localhost.')
  }
  const literalFamily = isIP(host)
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await dnsLookup(host, { all: true })
  for (const { address, family } of addresses) {
    if (PRIVATE_NETWORK_BLOCKLIST.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error(`Refusing to fetch from a private/internal network address (${address}).`)
    }
  }
}

/**
 * Read a fetch `Response` body up to `maxBytes`, aborting the stream the moment it's exceeded —
 * doesn't trust a `Content-Length` header, which a server can omit or misreport.
 */
async function readBodyCapped(res: Response, maxBytes: number): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) return Buffer.from(await res.arrayBuffer())
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        throw new Error(`Image is too large to display (over ${maxBytes} bytes).`)
      }
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
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
  const r = resolve(path)
  return roots.some((root) => r === resolve(root) || r.startsWith(resolve(root) + '/'))
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
function runLoginShellOnce(
  command: string,
  cwd: string,
  timeout: number,
  signal: AbortSignal
): Promise<{ exitCode: number; stdout: string; stderr: string; cwd: string; timedOut: boolean }> {
  const shell = process.env.SHELL || '/bin/zsh'
  return new Promise((resolvePromise) => {
    execFile(
      shell,
      ['-lc', command],
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
      'Read a text file. Returns up to 256KB; use offset/limit (line numbers) for larger files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute or workspace-relative path' },
        offset: { type: 'number', description: '1-based first line to read' },
        limit: { type: 'number', description: 'Max lines to return' }
      },
      required: ['path']
    },
    resource: 'filesystem',
    action: 'read',
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Read ${a.path}`,
    async run(args, ctx) {
      const path = resolveToolPath(String(args.path), ctx)
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
      'Run a command in a persistent login shell (your $SHELL, e.g. zsh) rooted at the workspace. ' +
      'The session survives across calls: working directory, environment variables, and shell state ' +
      'persist, so `cd` sticks and your normal PATH (Homebrew, node, git, etc.) is available. ' +
      'stdout and stderr are combined. Default timeout 120s. For a long task (a download, a build, ' +
      'a big test run) pass `background: true`: it starts detached, keeps running after this turn, ' +
      'and returns a jobId immediately instead of blocking — then check it with job_status or stop ' +
      'it with stop_job. Never block a foreground shell on minutes-long work; background it.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Run from this directory (persists for later commands)' },
        timeout_ms: { type: 'number' },
        background: {
          type: 'boolean',
          description:
            'Run the command as a detached BACKGROUND job that keeps running after this turn ends, ' +
            'returning a jobId immediately instead of waiting for it to finish. Use it for long ' +
            'tasks (downloads, builds, long test runs) so you are freed to keep working or hand ' +
            'control back to the user. Collect it later with job_status; cancel it with stop_job. ' +
            'The persistent working directory / shell state is NOT shared with a background job.'
        }
      },
      required: ['command']
    },
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) =>
      `${a.background ? 'Run (background): ' : 'Run: '}${String(a.command).slice(0, 120)}`,
    async run(args, ctx) {
      const timeout = Math.min(Number(args.timeout_ms ?? 120000), 600000)
      const cwd = args.cwd
        ? resolveToolPath(String(args.cwd), ctx)
        : (ctx.workspace.roots[0] ?? homedir())
      if (args.background) {
        const job = startShellJob(ctx.threadMeta.id, String(args.command), { cwd })
        return {
          jobId: job.id,
          status: job.status,
          background: true,
          startedAt: job.startedAt,
          note:
            'Started in the background — it keeps running after this turn ends. Do NOT wait here for ' +
            'a long task; move on with other work, or hand control back to the user with ask_user. ' +
            'Use job_status to check on it or read its output, and stop_job to cancel it.'
        }
      }
      try {
        const r = await runInShell(ctx.threadMeta.id, String(args.command), {
          cwd: args.cwd ? cwd : undefined,
          timeoutMs: timeout,
          signal: ctx.signal
        })
        return {
          exitCode: r.exitCode,
          stdout: r.output,
          stderr: '',
          cwd: r.cwd,
          timedOut: r.timedOut,
          canceled: r.canceled
        }
      } catch {
        // node-pty unavailable (e.g. native module failed to build): fall back to a
        // one-shot login shell so PATH is still sourced correctly. No state persists.
        return runLoginShellOnce(String(args.command), cwd, timeout, ctx.signal)
      }
    }
  },
  {
    name: 'job_status',
    description:
      'Check on background jobs you started with shell(background:true). By default it WAITS until ' +
      'the targeted jobs finish and returns their status, exit code, and output; pass wait:false to ' +
      'peek right now without blocking. Omit `jobs` to target every background job on this thread. ' +
      'Use `tail` to get only the last N lines of each job\'s output. Poll or wait on your ' +
      'long-running downloads/builds and read their results here.',
    parameters: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job ids to target (from shell(background:true)). Omit to target all of this thread\'s jobs.'
        },
        wait: {
          type: 'boolean',
          description: 'Wait for the targeted jobs to finish before returning (default true). false = poll now.'
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
      const wait = args.wait !== false
      const views = wait
        ? await waitJobs(ids, ctx.signal)
        : ids.map((id) => getJob(id)).filter((v): v is NonNullable<typeof v> => !!v)
      const tail = Number(args.tail)
      const shaped = views.map((v) =>
        tail > 0 ? { ...v, output: v.output.split('\n').slice(-tail).join('\n') } : v
      )
      return { jobs: shaped, running: shaped.filter((j) => j.running).length }
    }
  },
  {
    name: 'stop_job',
    description:
      'Cancel background jobs you started with shell(background:true) — sends SIGTERM to each still ' +
      'running. Pass the job ids in `jobs`. Use it to kill a stuck or no-longer-needed download/build.',
    parameters: {
      type: 'object',
      properties: {
        jobs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Job ids to stop (from shell(background:true)).'
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
      'Case) that captures what it is about. Call this the moment the topic becomes clear, and again ' +
      'if the conversation clearly shifts to a new subject, so the sidebar stays scannable. Keep it ' +
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
      const meta = store.updateThread(ctx.threadMeta.id, { title })
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
        model: { type: 'string', description: 'Optional model id override (defaults to yours).' },
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
            '(agentId + name) instead of blocking until it finishes. You do NOT need to wait for it: ' +
            'its result is delivered back to you automatically as a new turn when it finishes, so you ' +
            'can keep working, ask the user a question with ask_user, or end your turn right away. ' +
            'Spawn several this way to run independent work in parallel — each reports back on its ' +
            'own. (Call agent_result only if you want to deliberately block until it is done.) ' +
            'Default false (blocks until the subagent is done, returning its answer directly).'
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
      const spec = {
        task,
        name: args.name ? String(args.name).slice(0, 60) : undefined,
        agentType: args.agent_type ? String(args.agent_type) : undefined,
        model: args.model ? String(args.model) : undefined,
        effort: args.effort ? String(args.effort) : undefined,
        tools
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
            'Started in the background. You do NOT need to wait — its result will be delivered back ' +
            'to you automatically as a new turn when it finishes. Keep working, ask the user a ' +
            'question, or end your turn. (Call agent_result only to deliberately block until it is done.)'
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
      "as a new turn when it finishes. Reach for this only to DELIBERATELY block until targeted agents " +
      "finish (default), returning each one's final result, or with wait:false to peek at their current " +
      'status (running/done/error) without blocking. Omit `agents` to target every background agent you ' +
      'have. Results you collect here are handed to you inline and will NOT also arrive as a separate turn.',
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
            'Wait for the targeted agents to finish before returning (default true). Pass false to ' +
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
      return { agents: results, pending: results.filter((r) => r.status === 'running').length }
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
// agent_result), manage the thread's background jobs (job_status, stop_job), block on the user
// (ask_user), or rename the user's thread (set_thread_title).
const NEVER_DELEGATABLE = new Set([
  'run_agent',
  'agent_result',
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
