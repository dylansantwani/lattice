import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { readFile, writeFile, readdir, mkdir, unlink, rename } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import type { MemoryItem, MemorySyncReport, MemoryType, WorkspaceMeta } from '@shared/types'
import { listMemory, upsertMemory, deleteMemory } from '../store/eventStore'

/**
 * Memory bridge: import the user's Claude Code and Hermes memory into Lattice's store so the
 * model shares one memory across all three agents. Imported items are marked
 * `author: 'import'` with a stable `mem:<store>:…` id so re-syncing updates in place, and items
 * that vanished upstream are pruned. Everything is best-effort per source: a missing or malformed
 * store degrades to "found 0", never a thrown sync.
 *
 * Cost discipline on both lanes:
 *  - the IMPORT lane fingerprints the source files (path + mtime + size) and skips the whole
 *    parse-and-upsert when nothing on disk changed since the last sync in this process;
 *  - the EXPORT lane hashes the exportable set and skips entirely when it is unchanged, otherwise
 *    writes only the files whose content differs (never delete-all-then-rewrite, so a crash
 *    mid-sync can no longer leave the external store empty), on async fs so the main process is
 *    not blocked, and IPC-triggered exports are debounced so a burst of approvals is one export.
 */

const IMPORT_PREFIX = 'mem:'
/** Imported files are split into paragraph-sized chunks (see chunkMarkdown) rather than one clipped
 *  blob: a blob dominated every keyword search and swallowed new learnings in the dedupe check. */
export const IMPORT_CHUNK = { min: 240, max: 1500 } as const
/** Absolute cap per imported chunk, for a single paragraph longer than IMPORT_CHUNK.max. */
const MAX_ITEM_CHARS = 2000
/** Marks Lattice-written entries in the external stores, so we skip them on import (no loop). */
const HERMES_SENTINEL = '⟦lattice⟧'
const CC_FILE_PREFIX = 'lattice-'
const CC_INDEX_BEGIN = '<!-- lattice:begin — synced from Lattice, do not edit by hand -->'
const CC_INDEX_END = '<!-- lattice:end -->'
/**
 * How many Lattice memories may live in the other agents' stores at once. Claude Code loads its
 * MEMORY.md index into every session and Hermes reads its whole MEMORY.md; both are paid in context
 * tokens on every start. Measured on 2026-09-11 before this cap existed: 525 exported files, a 102 KB
 * Claude Code index and a 116 KB Hermes file — roughly 25k tokens of standing context per session,
 * most of it never-recalled rule captures. The export is the *best* of the store, not all of it.
 */
export const EXPORT_MAX_ITEMS = 80

/** True for memory items this bridge owns (so we can prune our own stale imports safely). */
export function isImported(m: Pick<MemoryItem, 'id' | 'author'>): boolean {
  return m.author === 'import' && m.id.startsWith(IMPORT_PREFIX)
}

/** Which external store an imported item came from, for UI badges. */
export function importStoreOf(id: string): 'claude-code' | 'hermes' | null {
  if (id.startsWith('mem:cc:')) return 'claude-code'
  if (id.startsWith('mem:hermes:')) return 'hermes'
  return null
}

function sha12(s: string): string {
  return createHash('sha1').update(s).digest('hex').slice(0, 12)
}

/** The directory-name Claude Code uses for a project: the absolute path with every "/" → "-". */
export function claudeProjectSlug(absPath: string): string {
  return absPath.replace(/\//g, '-')
}

interface Draft {
  id: string
  content: string
  type: MemoryType
  scope: MemoryItem['scope']
  scopeId?: string
}

/**
 * Parse a Claude Code / Hermes memory file's YAML-ish frontmatter. Returns the `type` under
 * `metadata:` (if any) and the body after the closing `---`. Tolerant of missing frontmatter.
 */
export function parseFrontmatterFile(text: string): { type?: string; body: string } {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!m) return { body: text.trim() }
  const front = m[1]!
  const body = m[2]!.trim()
  const typeMatch = front.match(/^\s*type:\s*(.+?)\s*$/m)
  return { type: typeMatch?.[1]?.replace(/['"]/g, ''), body }
}

/** Split a Hermes `§`-delimited memory file into individual, trimmed facts. */
export function splitHermesFacts(text: string): string[] {
  return text
    .split(/\n?§\n?/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

/** Map a Claude Code memory `type` (user|feedback|project|reference) to a Lattice MemoryType. */
function ccTypeToMemoryType(t?: string): MemoryType {
  switch ((t ?? '').toLowerCase()) {
    case 'feedback':
      return 'preference'
    case 'user':
      return 'fact'
    case 'project':
      return 'decision'
    case 'reference':
      return 'note'
    default:
      return 'note'
  }
}

function clip(s: string): string {
  return s.length > MAX_ITEM_CHARS ? s.slice(0, MAX_ITEM_CHARS) + '\n… [truncated]' : s
}

export interface MarkdownChunk {
  /** the nearest heading above the chunk, without its `#` marks */
  heading?: string
  text: string
}

/**
 * Split a markdown document into paragraph-sized chunks: a heading always opens a chunk, paragraphs
 * append until the chunk would exceed `max`, and chunks under `min` are folded into their
 * predecessor. A lone paragraph longer than `max` is cut at line/sentence boundaries. Chunk text is
 * what gets indexed and compared, so the pieces are sized to be one recallable idea each.
 */
export function chunkMarkdown(text: string, opts: { min: number; max: number } = IMPORT_CHUNK): MarkdownChunk[] {
  const { min, max } = opts
  const paragraphs = text
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
  const chunks: MarkdownChunk[] = []
  let heading: string | undefined
  let current: MarkdownChunk | null = null
  const flush = (): void => {
    if (current && current.text.trim()) chunks.push(current)
    current = null
  }
  for (const para of paragraphs) {
    const headingMatch = para.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/m)
    const startsWithHeading = /^#{1,6}\s/.test(para)
    if (startsWithHeading && headingMatch) {
      flush()
      heading = headingMatch[2]!.trim()
    }
    for (const piece of splitOversized(para, max)) {
      if (current && !startsWithHeading && current.text.length + 2 + piece.length <= max) {
        current.text += '\n\n' + piece
      } else {
        flush()
        current = { heading, text: piece }
      }
    }
  }
  flush()
  // Fold runts into their predecessor (a heading line by itself, a one-line footnote).
  const folded: MarkdownChunk[] = []
  for (const c of chunks) {
    const prev = folded.at(-1)
    if (prev && c.text.length < min && prev.text.length + 2 + c.text.length <= max * 1.25) {
      prev.text += '\n\n' + c.text
    } else folded.push({ ...c })
  }
  return folded
}

/** Cut one oversized paragraph at newline, then sentence, boundaries so no piece exceeds `max`. */
function splitOversized(para: string, max: number): string[] {
  if (para.length <= max) return [para]
  const out: string[] = []
  let buf = ''
  const units = para.split(/(?<=\n)|(?<=[.!?]\s)(?=[A-Z0-9"'(])/)
  for (const u of units) {
    if (buf && buf.length + u.length > max) {
      out.push(buf.trim())
      buf = ''
    }
    if (u.length > max) {
      // A single run with no boundaries at all: hard-cut.
      for (let i = 0; i < u.length; i += max) out.push(u.slice(i, i + max).trim())
      continue
    }
    buf += u
  }
  if (buf.trim()) out.push(buf.trim())
  return out.filter(Boolean)
}

/**
 * Turn one imported document into drafts. A document that fits in a single chunk keeps the legacy
 * whole-file id (so existing rows and their usage stats survive); a multi-chunk document gets one
 * row per chunk keyed by a content hash, so an unchanged chunk keeps its id across re-syncs and an
 * edited one is replaced rather than duplicated.
 */
function documentDrafts(
  baseId: string,
  label: string,
  body: string,
  type: MemoryType,
  scope: MemoryItem['scope'],
  scopeId?: string
): Draft[] {
  const chunks = chunkMarkdown(body)
  if (chunks.length <= 1) {
    return [{ id: baseId, content: clip(`${label}:\n\n${body}`), type, scope, scopeId }]
  }
  return chunks.map((c) => ({
    id: `${baseId}:${sha12(c.text)}`,
    content: clip(`${label}${c.heading ? ` › ${c.heading}` : ''}:\n\n${c.text}`),
    type,
    scope,
    scopeId
  }))
}

/** Collect Claude Code memory drafts: global CLAUDE.md, this project's CLAUDE.md, and the
 *  per-project memory files under ~/.claude/projects/<slug>/memory. */
export function collectClaudeCode(root: string, workspaceId: string): Draft[] {
  const out: Draft[] = []
  const home = homedir()

  const globalMd = join(home, '.claude', 'CLAUDE.md')
  if (existsSync(globalMd)) {
    const body = readFileSync(globalMd, 'utf8').trim()
    if (body)
      out.push(
        ...documentDrafts('mem:cc:global', 'Claude Code global instructions (~/.claude/CLAUDE.md)', body, 'preference', 'user')
      )
  }

  const projectMd = join(root, 'CLAUDE.md')
  if (existsSync(projectMd)) {
    const body = readFileSync(projectMd, 'utf8').trim()
    if (body)
      out.push(
        ...documentDrafts(
          `mem:cc:project-md:${workspaceId}`,
          `Claude Code project instructions (${root}/CLAUDE.md)`,
          body,
          'preference',
          'workspace',
          workspaceId
        )
      )
  }

  const memDir = join(home, '.claude', 'projects', claudeProjectSlug(root), 'memory')
  if (existsSync(memDir)) {
    for (const name of readdirSync(memDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue
      if (name.startsWith(CC_FILE_PREFIX)) continue // our own write-back — don't re-import
      const { type, body } = parseFrontmatterFile(readFileSync(join(memDir, name), 'utf8'))
      if (!body) continue
      const stem = basename(name, '.md')
      const chunks = chunkMarkdown(body)
      if (chunks.length <= 1) {
        out.push({
          id: `mem:cc:file:${workspaceId}:${stem}`,
          content: clip(body),
          type: ccTypeToMemoryType(type),
          scope: 'workspace',
          scopeId: workspaceId
        })
      } else {
        for (const c of chunks) {
          out.push({
            id: `mem:cc:file:${workspaceId}:${stem}:${sha12(c.text)}`,
            content: clip(`${stem}${c.heading ? ` › ${c.heading}` : ''}:\n\n${c.text}`),
            type: ccTypeToMemoryType(type),
            scope: 'workspace',
            scopeId: workspaceId
          })
        }
      }
    }
  }
  return out
}

/** Collect Hermes memory drafts from ~/.hermes/memories/{MEMORY.md,USER.md}. */
export function collectHermes(): Draft[] {
  const out: Draft[] = []
  const dir = join(homedir(), '.hermes', 'memories')
  const files: { file: string; type: MemoryType }[] = [
    { file: 'USER.md', type: 'fact' },
    { file: 'MEMORY.md', type: 'note' }
  ]
  for (const { file, type } of files) {
    const path = join(dir, file)
    if (!existsSync(path)) continue
    const tag = file === 'USER.md' ? 'user' : 'mem'
    for (const fact of splitHermesFacts(readFileSync(path, 'utf8'))) {
      if (fact.startsWith(HERMES_SENTINEL)) continue // our own write-back — don't re-import
      out.push({
        id: `mem:hermes:${tag}:${sha12(fact)}`,
        content: clip(fact),
        type,
        scope: 'user'
      })
    }
  }
  return out
}

/**
 * A cheap fingerprint of every file the import lane would read (path + mtime + size, plus the
 * memory dir's listing). Unchanged fingerprint ⇒ the parse-and-upsert pass is skipped entirely.
 */
export function importFingerprint(root: string): string {
  const home = homedir()
  const h = createHash('sha1')
  const stamp = (path: string): void => {
    try {
      const st = statSync(path)
      h.update(`${path}|${st.mtimeMs}|${st.size}\n`)
    } catch {
      h.update(`${path}|missing\n`)
    }
  }
  stamp(join(home, '.claude', 'CLAUDE.md'))
  stamp(join(root, 'CLAUDE.md'))
  const memDir = join(home, '.claude', 'projects', claudeProjectSlug(root), 'memory')
  try {
    for (const name of readdirSync(memDir).sort()) {
      if (name.endsWith('.md') && name !== 'MEMORY.md' && !name.startsWith(CC_FILE_PREFIX)) stamp(join(memDir, name))
    }
  } catch {
    h.update(`${memDir}|missing\n`)
  }
  stamp(join(home, '.hermes', 'memories', 'USER.md'))
  stamp(join(home, '.hermes', 'memories', 'MEMORY.md'))
  return h.digest('hex')
}

/** Per-workspace import fingerprints + reports from the last sync in this process. */
const lastImport = new Map<string, { fingerprint: string; report: MemorySyncReport }>()
/** Per-root hash of the exportable set as of the last export in this process. */
const lastExportHash = new Map<string, string>()
/** The deduped exportable set from the last computation, keyed by the hash of its inputs. */
let lastExportable: { hash: string; kept: MemoryItem[] } | null = null

/** Forget the skip caches (tests, or after an external store was edited by hand mid-session). */
export function resetBridgeCaches(): void {
  lastImport.clear()
  lastExportHash.clear()
  lastExportable = null
}

/**
 * Import Claude Code + Hermes memory into Lattice's store and prune imports that no longer exist
 * upstream. Idempotent: safe to run on every launch and on demand. Never throws — a failing source
 * is reported as found: 0 with the error surfaced in the report. When no source file changed since
 * the last sync in this process, returns the previous report flagged `skipped` without touching
 * the store (pass `force` to bypass).
 */
export function syncExternalMemory(workspace: WorkspaceMeta, opts: { force?: boolean } = {}): MemorySyncReport {
  const root = workspace.roots[0] ?? homedir()
  const fingerprint = importFingerprint(root)
  const prev = lastImport.get(workspace.id)
  if (!opts.force && prev && prev.fingerprint === fingerprint) {
    return { ...prev.report, added: 0, updated: 0, removed: 0, skipped: true }
  }

  const sources: MemorySyncReport['sources'] = []
  const drafts: Draft[] = []
  const collectedStores = new Set<'claude-code' | 'hermes'>()

  for (const src of [
    { store: 'claude-code' as const, label: 'Claude Code', collect: () => collectClaudeCode(root, workspace.id) },
    { store: 'hermes' as const, label: 'Hermes', collect: collectHermes }
  ]) {
    try {
      const found = src.collect()
      drafts.push(...found)
      collectedStores.add(src.store)
      sources.push({ store: src.store, label: src.label, found: found.length })
    } catch (err) {
      sources.push({
        store: src.store,
        label: src.label,
        found: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }

  // De-dup by id (a fact could theoretically collide across files); last write wins.
  const byId = new Map<string, Draft>()
  for (const d of drafts) byId.set(d.id, d)

  const existing = new Map(listMemory().filter(isImported).map((m) => [m.id, m]))
  let added = 0
  let updated = 0
  for (const d of byId.values()) {
    const prevRow = existing.get(d.id)
    if (prevRow && prevRow.content === d.content && prevRow.type === d.type && prevRow.scope === d.scope) continue
    upsertMemory({
      id: d.id,
      content: d.content,
      type: d.type,
      scope: d.scope,
      scopeId: d.scopeId,
      author: 'import',
      status: 'approved'
    })
    if (prevRow) updated += 1
    else added += 1
  }

  // Prune imports that vanished upstream, but only for stores we actually read. A transient
  // permission/read error in one external store must never erase its last good imported snapshot.
  let removed = 0
  for (const [id, previous] of existing) {
    const store = importStoreOf(id)
    const belongsToThisSync =
      store !== 'claude-code' || previous.scope !== 'workspace' || previous.scopeId === workspace.id
    if (store && collectedStores.has(store) && belongsToThisSync && !byId.has(id)) {
      deleteMemory(id)
      removed += 1
    }
  }

  const report: MemorySyncReport = {
    ok: sources.every((s) => !s.error),
    sources,
    added,
    updated,
    removed,
    total: byId.size,
    exported: []
  }
  // Only a fully successful read is a trustworthy fingerprint; a failed source is retried next time.
  if (report.ok) lastImport.set(workspace.id, { fingerprint, report })
  return report
}

// ---------- write-back: export Lattice-authored memory into the external stores ----------

/**
 * Lattice memories worth sharing outward: approved, authored here (not themselves imports), and
 * backed by EVIDENCE of value — written by the user, explicitly reviewed, pinned, or actually
 * recalled into a turn at least once. There is no longer an "aged a day without rejection" path:
 * nobody reviews 300 auto-approved rule captures a day, so age proved nothing and every capture
 * reached Claude Code and Hermes by the next morning. Exported for tests and the Memory tab.
 */
export function isExportable(m: MemoryItem, now = Date.now()): boolean {
  if (m.status !== 'approved' || isImported(m)) return false
  if (m.expiresAt && m.expiresAt <= now) return false
  return m.author === 'user' || !!m.reviewedAt || m.pinned || m.useCount > 0
}

/**
 * Rank exportable memories by how much evidence stands behind them, so the {@link EXPORT_MAX_ITEMS}
 * cap keeps the ones a person or a model has actually relied on: pinned, then user-written, then
 * reviewed, then by how often recall surfaced them, then by recency. Higher sorts first.
 */
export function exportPriority(m: MemoryItem): number {
  let p = 0
  if (m.pinned) p += 1_000_000
  if (m.author === 'user') p += 500_000
  if (m.reviewedAt) p += 250_000
  p += Math.min(m.useCount, 999) * 100
  // recency tiebreak inside a day-sized bucket so equal-evidence rows keep a stable order
  if (Number.isFinite(m.updatedAt)) p += Math.floor(m.updatedAt / 3600_000) % 100
  return p
}

/** Two captures are the same fact when they share most of their content words. */
export const EXPORT_DUPLICATE_THRESHOLD = 0.78

const STOPWORDS = new Set(
  ('the a an and or of to in for with on at by from as is are was were be been being it its this that these those ' +
    'user users project projects use used using make makes made can could should would will may might must also into ' +
    'out over under about more most other others such same new old get got set add adds added only just very here ' +
    'there when where which while then than them they your my me our we he she his her not but if so no yes do does ' +
    'did done have has had one two three first second next last still even now today file files run runs running work works'
  ).split(' ')
)

/** Per-content token memo. Export dedupe scores every pair, so each string was tokenized once per
 *  pair (four times per score) — ~1.1 s of main-thread CPU per export on a 540-row set. Now once. */
const tokenMemo = new Map<string, { content: Set<string>; distinctive: Set<string> }>()
const TOKEN_MEMO_MAX = 4000
function tokensOf(s: string): { content: Set<string>; distinctive: Set<string> } {
  const hit = tokenMemo.get(s)
  if (hit) return hit
  if (tokenMemo.size >= TOKEN_MEMO_MAX) tokenMemo.clear()
  const entry = { content: contentTokens(s), distinctive: distinctiveTokens(s) }
  tokenMemo.set(s, entry)
  return entry
}

function contentTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (let w of s.toLowerCase().split(/[^a-z0-9/._:-]+/)) {
    w = w.replace(/^[-._:]+|[-._:]+$/g, '')
    if (w.length < 3 || STOPWORDS.has(w)) continue
    out.add(w)
  }
  return out
}

/** Paths, ports, numbers and ids: agreeing on these is near-proof that two captures are one fact. */
function distinctiveTokens(s: string): Set<string> {
  const out = new Set<string>()
  for (const m of s.matchAll(/[A-Za-z0-9_.-]*\d[A-Za-z0-9_.-]*|\/[A-Za-z0-9_./-]+/g)) {
    const t = m[0].toLowerCase()
    if (t.length >= 3) out.add(t)
  }
  return out
}

export function duplicateScore(a: string, b: string): number {
  const ma = tokensOf(a)
  const mb = tokensOf(b)
  const ta = ma.content
  const tb = mb.content
  if (!ta.size || !tb.size) return 0
  let inter = 0
  for (const t of ta) if (tb.has(t)) inter++
  const jaccard = inter / (ta.size + tb.size - inter)
  // A short restatement is fully contained in a longer one, so plain Jaccard (which punishes the
  // length mismatch) would miss exactly the pairs we care about. Overlap coefficient fixes that;
  // it needs at least 4 content words on the short side to avoid generic-fragment false hits.
  const minSize = Math.min(ta.size, tb.size)
  const containment = minSize >= 4 ? inter / minSize : 0
  const db = mb.distinctive
  let shared = 0
  for (const t of ma.distinctive) if (db.has(t)) shared++
  const boost = shared >= 2 ? 0.12 : shared === 1 ? 0.05 : 0
  return Math.min(1, Math.max(jaccard, containment * 0.92) + boost)
}

/**
 * One fact, one file. Captures arrive in id order (ULIDs are chronological), so restatements of a
 * fact already in the set are dropped, and a longer restatement replaces the shorter one it
 * duplicates. Dropped rows stay in Lattice and remain usable in its own prompts — they simply
 * stop becoming new files in the shared store, which is what used to bury the curated entries.
 */
export function dedupeExportable(memories: MemoryItem[]): { kept: MemoryItem[]; dropped: MemoryItem[] } {
  const kept: MemoryItem[] = []
  const dropped: MemoryItem[] = []
  for (const m of memories) {
    const idx = kept.findIndex((k) => duplicateScore(k.content, m.content) >= EXPORT_DUPLICATE_THRESHOLD)
    if (idx === -1) {
      kept.push(m)
      continue
    }
    const cur = kept[idx] as MemoryItem
    if (m.content.length > cur.content.length) {
      dropped.push(cur)
      kept[idx] = m
    } else {
      dropped.push(m)
    }
  }
  return { kept, dropped }
}

/**
 * The set to export: every exportable row, ranked by evidence, capped at {@link EXPORT_MAX_ITEMS},
 * then deduped so one fact is one entry. The O(n²) dedupe is memoized on the hash of its INPUT (ids
 * + content + type), so an export whose candidate set is unchanged — the common case, since exports
 * are scheduled after every run that stored anything — costs one indexed read and one hash, not a
 * pairwise pass. Cheap enough not to matter at the cap; it mattered at 540 rows (1.1 s per export).
 */
export function exportableMemories(now = Date.now()): MemoryItem[] {
  const candidates = listMemory()
    .filter((m) => isExportable(m, now))
    .sort((a, b) => exportPriority(b) - exportPriority(a) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .slice(0, EXPORT_MAX_ITEMS)
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  const hash = exportHash(candidates)
  if (lastExportable && lastExportable.hash === hash) return lastExportable.kept
  const kept = dedupeExportable(candidates).kept
  lastExportable = { hash, kept }
  return kept
}

/** Stable digest of the exportable set: same ids + content + type ⇒ same external files. */
export function exportHash(memories: MemoryItem[]): string {
  const h = createHash('sha1')
  for (const m of memories) h.update(`${m.id} ${m.type} ${m.content}`)
  return h.digest('hex')
}

function oneLine(s: string): string {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 500 ? line.slice(0, 500) + '…' : line
}

/** Atomically write text (best-effort): write a temp file then rename over the target. */
async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.lattice.tmp`
  await writeFile(tmp, text, 'utf8')
  try {
    await rename(tmp, path)
  } catch {
    // rename can fail across odd filesystems; fall back to a direct write.
    await writeFile(path, text, 'utf8')
    try {
      await unlink(tmp)
    } catch {
      /* ignore */
    }
  }
}

async function readIfExists(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    return null
  }
}

/** Write only when the file's current content differs. Returns whether a write happened. */
async function writeIfChanged(path: string, text: string): Promise<boolean> {
  if ((await readIfExists(path)) === text) return false
  await atomicWrite(path, text)
  return true
}

/**
 * Maintain a Lattice-owned block of `§`-delimited entries at the end of Hermes' MEMORY.md,
 * preserving every entry the user (or Hermes) wrote. Only entries tagged with our sentinel are
 * touched, and the file is rewritten only when our block actually changed. Skips entirely if Hermes
 * isn't installed (we never create another agent's store).
 */
export async function exportToHermes(memories: MemoryItem[]): Promise<number> {
  const dir = join(homedir(), '.hermes', 'memories')
  if (!existsSync(dir)) return 0
  const path = join(dir, 'MEMORY.md')
  const current = (await readIfExists(path)) ?? ''
  // Nothing of ours to add and nothing of ours already there → don't touch the user's file.
  if (memories.length === 0 && !current.includes(HERMES_SENTINEL)) return 0
  const kept = current
    .split(/\n?§\n?/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith(HERMES_SENTINEL))
  const mine = memories.map((m) => `${HERMES_SENTINEL} ${oneLine(m.content)}`)
  const body = [...kept, ...mine].join('\n§\n') + '\n'
  await writeIfChanged(path, body)
  return mine.length
}

/** Map a Lattice MemoryType back to a Claude Code memory `type`. */
function memoryTypeToCc(t: MemoryType): string {
  switch (t) {
    case 'preference':
      return 'feedback'
    case 'fact':
      return 'user'
    case 'decision':
      return 'project'
    default:
      return 'reference'
  }
}

function safeSlug(id: string): string {
  return id.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 60)
}

/** The Claude Code memory file for one Lattice memory (frontmatter CC understands + the content). */
function ccMemoryFile(m: MemoryItem): { file: string; text: string; indexLine: string } {
  const slug = safeSlug(m.id)
  const file = `${CC_FILE_PREFIX}${slug}.md`
  const title = oneLine(m.content).slice(0, 60)
  const desc = oneLine(m.content).slice(0, 120).replace(/"/g, "'")
  const text = [
    '---',
    `name: ${CC_FILE_PREFIX}${slug}`,
    `description: "${desc}"`,
    'metadata:',
    '  node_type: memory',
    `  type: ${memoryTypeToCc(m.type)}`,
    '  source: lattice',
    '---',
    '',
    m.content.trim(),
    ''
  ].join('\n')
  return { file, text, indexLine: `- [${title}](${file}) — shared from Lattice` }
}

/**
 * Write each Lattice-authored memory as its own Claude Code memory file (`lattice-<id>.md`, with
 * frontmatter CC understands) under this project's memory dir, and maintain a sentinel-bracketed
 * block of index lines in that dir's MEMORY.md. Files whose content is unchanged are left alone;
 * `lattice-*.md` files for memories that no longer export are removed. Skips if Claude Code isn't
 * installed.
 */
export async function exportToClaudeCode(root: string, memories: MemoryItem[]): Promise<number> {
  const claudeHome = join(homedir(), '.claude')
  if (!existsSync(claudeHome)) return 0
  const memDir = join(claudeHome, 'projects', claudeProjectSlug(root), 'memory')
  // Don't create a memory dir just to write nothing; only act if we have items or prior write-back.
  if (memories.length === 0 && !existsSync(memDir)) return 0
  await mkdir(memDir, { recursive: true })

  const desired = new Map<string, { text: string; indexLine: string }>()
  for (const m of memories) {
    const { file, text, indexLine } = ccMemoryFile(m)
    desired.set(file, { text, indexLine })
  }
  // Remove stale write-back files (deletions propagate) and write only the changed ones.
  for (const name of await readdir(memDir)) {
    if (name.startsWith(CC_FILE_PREFIX) && name.endsWith('.md') && !desired.has(name)) {
      try {
        await unlink(join(memDir, name))
      } catch {
        /* ignore */
      }
    }
  }
  for (const [file, { text }] of desired) await writeIfChanged(join(memDir, file), text)

  // Rewrite only our sentinel block in MEMORY.md, preserving the rest, and only if it changed.
  const indexPath = join(memDir, 'MEMORY.md')
  const existing = (await readIfExists(indexPath)) ?? ''
  const hadBlock = existing.includes(CC_INDEX_BEGIN)
  if (memories.length > 0 || hadBlock) {
    const stripped = existing
      .replace(new RegExp(`${escapeRe(CC_INDEX_BEGIN)}[\\s\\S]*?${escapeRe(CC_INDEX_END)}\\n?`, 'g'), '')
      .trimEnd()
    const indexLines = [...desired.values()].map((d) => d.indexLine)
    const block = memories.length ? [CC_INDEX_BEGIN, ...indexLines, CC_INDEX_END].join('\n') : ''
    const next = [stripped, block].filter(Boolean).join('\n\n')
    if (next.trim()) await writeIfChanged(indexPath, next + '\n')
    else if (existsSync(indexPath)) await unlink(indexPath) // we created it and now it's empty
  }
  return memories.length
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Export Lattice-authored memory into both external stores. Skips entirely (no disk reads, no
 * writes) when the exportable set hashes the same as the last export from this process; otherwise
 * each destination is best-effort and reports what it wrote.
 */
export async function exportMemory(
  workspace: WorkspaceMeta,
  opts: { force?: boolean } = {}
): Promise<MemorySyncReport['exported']> {
  const root = workspace.roots[0] ?? homedir()
  const mine = exportableMemories()
  // A scratch runtime (a benchmark, an isolated test data dir) must never write its memory into the
  // user's real Claude Code and Hermes stores.
  if (process.env.LATTICE_NO_MEMORY_EXPORT === '1') {
    return [
      { store: 'claude-code', label: 'Claude Code', wrote: 0, skipped: true },
      { store: 'hermes', label: 'Hermes', wrote: 0, skipped: true }
    ]
  }
  const hash = exportHash(mine)
  if (!opts.force && lastExportHash.get(root) === hash) {
    return [
      { store: 'claude-code', label: 'Claude Code', wrote: mine.length, skipped: true },
      { store: 'hermes', label: 'Hermes', wrote: mine.length, skipped: true }
    ]
  }
  const exported: MemorySyncReport['exported'] = []
  let allOk = true
  for (const dest of [
    { store: 'claude-code' as const, label: 'Claude Code', write: () => exportToClaudeCode(root, mine) },
    { store: 'hermes' as const, label: 'Hermes', write: () => exportToHermes(mine) }
  ]) {
    try {
      exported.push({ store: dest.store, label: dest.label, wrote: await dest.write() })
    } catch (err) {
      allOk = false
      exported.push({
        store: dest.store,
        label: dest.label,
        wrote: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  if (allOk) lastExportHash.set(root, hash)
  return exported
}

/** Debounce window for IPC/self-learning-triggered exports: a burst of approvals is one export. */
export const EXPORT_DEBOUNCE_MS = 1500
const pendingExports = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * Schedule an export for `workspace`, coalescing every request inside the debounce window into a
 * single run. Fire-and-forget: the caller (an IPC handler, the self-learning pass) must never wait
 * on disk I/O to the other agents' stores.
 */
export function scheduleMemoryExport(workspace: WorkspaceMeta, delayMs = EXPORT_DEBOUNCE_MS): void {
  const prev = pendingExports.get(workspace.id)
  if (prev) clearTimeout(prev)
  const timer = setTimeout(() => {
    pendingExports.delete(workspace.id)
    void exportMemory(workspace).catch(() => {
      /* best-effort; every failure is already per-destination inside exportMemory */
    })
  }, delayMs)
  // Never keep the process alive for a pending export; the next launch's full sync covers it.
  timer.unref?.()
  pendingExports.set(workspace.id, timer)
}

/** Run any pending scheduled exports now (quit path, tests). */
export async function flushScheduledExports(workspaces: WorkspaceMeta[]): Promise<void> {
  for (const ws of workspaces) {
    const timer = pendingExports.get(ws.id)
    if (!timer) continue
    clearTimeout(timer)
    pendingExports.delete(ws.id)
    await exportMemory(ws).catch(() => {})
  }
}

/**
 * Full bidirectional sync: import Claude Code + Hermes memory into Lattice, then export
 * Lattice-authored memory back out into both stores. The import step runs synchronously (so a
 * launch-time call has the store populated before the first turn); the export is async and
 * diff-only. `force` bypasses both skip caches (the Memory tab's Sync button).
 */
export async function runMemorySync(
  workspace: WorkspaceMeta,
  opts: { force?: boolean } = {}
): Promise<MemorySyncReport> {
  const report = syncExternalMemory(workspace, opts)
  const exported = await exportMemory(workspace, opts)
  return { ...report, exported, ok: report.ok && exported.every((e) => !e.error) }
}
