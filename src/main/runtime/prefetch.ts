import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, relative, resolve } from 'node:path'
import { ulid } from '@shared/id'
import type { Attachment } from '@shared/types'
import { isPathInsideRoots } from '../tools/builtin'

/**
 * Mentioned-file prefetch — read the files a user's message explicitly names and attach their
 * contents to that message, so the model's FIRST round already holds what it would otherwise
 * spend its opening rounds fetching one fs_read at a time.
 *
 * Why the attachment lane: an attachment is persisted with the message, so the injected bytes are
 * byte-stable for the life of the thread — later rounds and later turns replay them verbatim and
 * provider prefix caches absorb them after the one cold start they were always going to cost.
 * Content a model fetches mid-run instead lands AFTER round one and is re-billed in every
 * subsequent round's context. (Measured 2026-09: parent runs averaged 18 rounds, and 96.8% of all
 * input tokens were context re-sent because of those extra rounds.)
 *
 * Deliberately conservative: only tokens that look like file paths, only files that actually exist
 * under the workspace roots, capped in count and bytes, binaries skipped, and nothing the user
 * already attached. A wrong guess costs a small one-time cold-start block; a right one saves whole
 * rounds.
 */

/** Ceilings that keep a prefetch a head start, not a dump. */
export const PREFETCH_MAX_FILES = 5
export const PREFETCH_MAX_FILE_BYTES = 32 * 1024
export const PREFETCH_MAX_TOTAL_BYTES = 96 * 1024
/** Most path-looking tokens examined per message — a pasted log can contain hundreds. */
const MAX_CANDIDATES = 40

/**
 * Path-looking tokens in a message: something with a slash, or a bare `name.ext` filename, with
 * an optional `:line` / `:line-line` suffix (how users and stack traces cite locations). Kept
 * deliberately loose — a false positive simply fails the stat below — but URLs are cut first so
 * `example.com/index.html` never resolves against the workspace.
 */
export function extractPathCandidates(text: string): string[] {
  const withoutUrls = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, ' ')
  const matches = withoutUrls.match(/(?:~|\.{1,2})?\/?[\w.@+-]+(?:\/[\w.@+-]+)*\.[A-Za-z0-9]{1,8}(?::\d+(?:[-:]\d+)?)?/g) ?? []
  const out: string[] = []
  for (const raw of matches) {
    // Trim the location suffix and any trailing sentence punctuation that rode along.
    const cleaned = raw.replace(/:\d+(?:[-:]\d+)?$/, '').replace(/[.,;!?)\]}]+$/, '')
    if (!cleaned || cleaned.length > 300) continue
    if (cleaned.endsWith('.') || cleaned.endsWith('/')) continue
    // A bare word with one dot and no slash is as likely prose ("e.g.", "i.e.") as a file — the
    // stat below filters false positives, but prose abbreviations would eat candidate slots, so a
    // slash-less token must at least look like a filename: 2+ char stem and 2+ char extension.
    if (!cleaned.includes('/')) {
      const dot = cleaned.lastIndexOf('.')
      if (dot < 2 || cleaned.length - dot - 1 < 2) continue
    }
    if (!out.includes(cleaned)) out.push(cleaned)
    if (out.length >= MAX_CANDIDATES) break
  }
  return out
}

/** True when the buffer smells binary (NUL byte in the head) — images/archives are not prefetched. */
function looksBinary(buf: Buffer): boolean {
  const head = buf.subarray(0, Math.min(buf.length, 8192))
  return head.includes(0)
}

/**
 * Resolve a message's mentioned paths to real, workspace-contained text files and package each as
 * a persisted text attachment. `already` (the user's own attachments) suppresses duplicates.
 * Never throws — an unreadable candidate is simply skipped.
 */
export async function prefetchMentionedFiles(
  text: string,
  cwd: string,
  roots: string[],
  already?: Attachment[]
): Promise<Attachment[]> {
  const out: Attachment[] = []
  const seen = new Set<string>()
  const attachedNames = new Set((already ?? []).flatMap((a) => [a.name, a.path ?? '']))
  let totalBytes = 0
  for (const candidate of extractPathCandidates(text)) {
    if (out.length >= PREFETCH_MAX_FILES || totalBytes >= PREFETCH_MAX_TOTAL_BYTES) break
    try {
      const expanded = candidate.startsWith('~/') ? resolve(homedir(), candidate.slice(2)) : candidate
      const abs = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded)
      if (seen.has(abs)) continue
      seen.add(abs)
      if (attachedNames.has(abs)) continue
      const info = await stat(abs)
      if (!info.isFile() || info.size === 0) continue
      // Containment mirrors the tool broker: prefetch never reads outside the workspace roots.
      if (!(await isPathInsideRoots(abs, roots))) continue
      const buf = await readFile(abs)
      if (looksBinary(buf)) continue
      const clipped = buf.length > PREFETCH_MAX_FILE_BYTES
      let content = buf.toString('utf8', 0, Math.min(buf.length, PREFETCH_MAX_FILE_BYTES))
      if (clipped) {
        content += `\n… [auto-attached head only: file is ${info.size} bytes — fs_read it with offset/limit for the rest]`
      }
      const rel = relative(cwd, abs)
      const name = rel && !rel.startsWith('..') ? rel : abs
      out.push({
        id: ulid(),
        name: `${name} (auto-attached)`,
        path: abs,
        mime: 'text/plain',
        bytes: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        kind: 'text',
        content
      })
      totalBytes += Math.min(buf.length, PREFETCH_MAX_FILE_BYTES)
    } catch {
      // Not a real file (or unreadable) — exactly the false positives the stat is here to drop.
    }
  }
  return out
}
