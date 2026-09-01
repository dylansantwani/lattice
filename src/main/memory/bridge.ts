import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync, renameSync } from 'node:fs'
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
 */

const IMPORT_PREFIX = 'mem:'
const MAX_ITEM_CHARS = 8000
/** Marks Lattice-written entries in the external stores, so we skip them on import (no loop). */
const HERMES_SENTINEL = '⟦lattice⟧'
const CC_FILE_PREFIX = 'lattice-'
const CC_INDEX_BEGIN = '<!-- lattice:begin — synced from Lattice, do not edit by hand -->'
const CC_INDEX_END = '<!-- lattice:end -->'

/** True for memory items this bridge owns (so we can prune our own stale imports safely). */
export function isImported(m: MemoryItem): boolean {
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

/** Collect Claude Code memory drafts: global CLAUDE.md, this project's CLAUDE.md, and the
 *  per-project memory files under ~/.claude/projects/<slug>/memory. */
export function collectClaudeCode(root: string, workspaceId: string): Draft[] {
  const out: Draft[] = []
  const home = homedir()

  const globalMd = join(home, '.claude', 'CLAUDE.md')
  if (existsSync(globalMd)) {
    const body = readFileSync(globalMd, 'utf8').trim()
    if (body)
      out.push({
        id: 'mem:cc:global',
        content: clip(`Claude Code global instructions (~/.claude/CLAUDE.md):\n\n${body}`),
        type: 'preference',
        scope: 'user'
      })
  }

  const projectMd = join(root, 'CLAUDE.md')
  if (existsSync(projectMd)) {
    const body = readFileSync(projectMd, 'utf8').trim()
    if (body)
      out.push({
        id: `mem:cc:project-md:${workspaceId}`,
        content: clip(`Claude Code project instructions (${root}/CLAUDE.md):\n\n${body}`),
        type: 'preference',
        scope: 'workspace',
        scopeId: workspaceId
      })
  }

  const memDir = join(home, '.claude', 'projects', claudeProjectSlug(root), 'memory')
  if (existsSync(memDir)) {
    for (const name of readdirSync(memDir)) {
      if (!name.endsWith('.md') || name === 'MEMORY.md') continue
      if (name.startsWith(CC_FILE_PREFIX)) continue // our own write-back — don't re-import
      const { type, body } = parseFrontmatterFile(readFileSync(join(memDir, name), 'utf8'))
      if (!body) continue
      out.push({
        id: `mem:cc:file:${workspaceId}:${basename(name, '.md')}`,
        content: clip(body),
        type: ccTypeToMemoryType(type),
        scope: 'workspace',
        scopeId: workspaceId
      })
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
 * Import Claude Code + Hermes memory into Lattice's store and prune imports that no longer exist
 * upstream. Idempotent: safe to run on every launch and on demand. Never throws — a failing source
 * is reported as found: 0 with the error surfaced in the report.
 */
export function syncExternalMemory(workspace: WorkspaceMeta): MemorySyncReport {
  const root = workspace.roots[0] ?? homedir()
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
    const prev = existing.get(d.id)
    if (prev && prev.content === d.content && prev.type === d.type && prev.scope === d.scope) continue
    upsertMemory({
      id: d.id,
      content: d.content,
      type: d.type,
      scope: d.scope,
      scopeId: d.scopeId,
      author: 'import',
      status: 'approved'
    })
    if (prev) updated += 1
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

  return {
    ok: sources.every((s) => !s.error),
    sources,
    added,
    updated,
    removed,
    total: byId.size,
    exported: []
  }
}

// ---------- write-back: export Lattice-authored memory into the external stores ----------

/** Lattice memories worth sharing outward: approved, and authored here (not themselves imports). */
function exportableMemories(): MemoryItem[] {
  return listMemory().filter((m) => m.status === 'approved' && !isImported(m))
}

function oneLine(s: string): string {
  const line = s.replace(/\s+/g, ' ').trim()
  return line.length > 500 ? line.slice(0, 500) + '…' : line
}

/** Atomically write text (best-effort): write a temp file then rename over the target. */
function atomicWrite(path: string, text: string): void {
  const tmp = `${path}.lattice.tmp`
  writeFileSync(tmp, text, 'utf8')
  try {
    renameSync(tmp, path)
  } catch {
    // rename can fail across odd filesystems; fall back to a direct write.
    writeFileSync(path, text, 'utf8')
    try {
      unlinkSync(tmp)
    } catch {
      /* ignore */
    }
  }
}

/**
 * Maintain a Lattice-owned block of `§`-delimited entries at the end of Hermes' MEMORY.md,
 * preserving every entry the user (or Hermes) wrote. Only entries tagged with our sentinel are
 * touched. Skips entirely if Hermes isn't installed (we never create another agent's store).
 */
export function exportToHermes(memories: MemoryItem[]): number {
  const dir = join(homedir(), '.hermes', 'memories')
  if (!existsSync(dir)) return 0
  const path = join(dir, 'MEMORY.md')
  const current = existsSync(path) ? readFileSync(path, 'utf8') : ''
  // Nothing of ours to add and nothing of ours already there → don't touch the user's file.
  if (memories.length === 0 && !current.includes(HERMES_SENTINEL)) return 0
  const kept = current
    .split(/\n?§\n?/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0 && !s.startsWith(HERMES_SENTINEL))
  const mine = memories.map((m) => `${HERMES_SENTINEL} ${oneLine(m.content)}`)
  const body = [...kept, ...mine].join('\n§\n') + '\n'
  atomicWrite(path, body)
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

/**
 * Write each Lattice-authored memory as its own Claude Code memory file (`lattice-<id>.md`, with
 * frontmatter CC understands) under this project's memory dir, and maintain a sentinel-bracketed
 * block of index lines in that dir's MEMORY.md. Removes stale `lattice-*.md` files first. Skips if
 * Claude Code isn't installed.
 */
export function exportToClaudeCode(root: string, memories: MemoryItem[]): number {
  const claudeHome = join(homedir(), '.claude')
  if (!existsSync(claudeHome)) return 0
  const memDir = join(claudeHome, 'projects', claudeProjectSlug(root), 'memory')
  // Don't create a memory dir just to write nothing; only act if we have items or prior write-back.
  if (memories.length === 0 && !existsSync(memDir)) return 0
  mkdirSync(memDir, { recursive: true })

  // Clear our previous write-back files so deletions propagate.
  for (const name of readdirSync(memDir)) {
    if (name.startsWith(CC_FILE_PREFIX) && name.endsWith('.md')) {
      try {
        unlinkSync(join(memDir, name))
      } catch {
        /* ignore */
      }
    }
  }

  const indexLines: string[] = []
  for (const m of memories) {
    const slug = safeSlug(m.id)
    const file = `${CC_FILE_PREFIX}${slug}.md`
    const title = oneLine(m.content).slice(0, 60)
    const desc = oneLine(m.content).slice(0, 120).replace(/"/g, "'")
    const front = [
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
    writeFileSync(join(memDir, file), front, 'utf8')
    indexLines.push(`- [${title}](${file}) — shared from Lattice`)
  }

  // Rewrite only our sentinel block in MEMORY.md, preserving the rest.
  const indexPath = join(memDir, 'MEMORY.md')
  const existing = existsSync(indexPath) ? readFileSync(indexPath, 'utf8') : ''
  const hadBlock = existing.includes(CC_INDEX_BEGIN)
  if (memories.length > 0 || hadBlock) {
    const stripped = existing
      .replace(new RegExp(`${escapeRe(CC_INDEX_BEGIN)}[\\s\\S]*?${escapeRe(CC_INDEX_END)}\\n?`, 'g'), '')
      .trimEnd()
    const block = memories.length ? [CC_INDEX_BEGIN, ...indexLines, CC_INDEX_END].join('\n') : ''
    const next = [stripped, block].filter(Boolean).join('\n\n')
    if (next.trim()) atomicWrite(indexPath, next + '\n')
    else if (existsSync(indexPath)) unlinkSync(indexPath) // we created it and now it's empty
  }
  return memories.length
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Full bidirectional sync: import Claude Code + Hermes memory into Lattice, then export
 * Lattice-authored memory back out into both stores. Each direction is best-effort per source.
 */
export function runMemorySync(workspace: WorkspaceMeta): MemorySyncReport {
  const report = syncExternalMemory(workspace)
  const root = workspace.roots[0] ?? homedir()
  const mine = exportableMemories()
  const exported: MemorySyncReport['exported'] = []
  for (const dest of [
    { store: 'claude-code' as const, label: 'Claude Code', write: () => exportToClaudeCode(root, mine) },
    { store: 'hermes' as const, label: 'Hermes', write: () => exportToHermes(mine) }
  ]) {
    try {
      exported.push({ store: dest.store, label: dest.label, wrote: dest.write() })
    } catch (err) {
      exported.push({
        store: dest.store,
        label: dest.label,
        wrote: 0,
        error: err instanceof Error ? err.message : String(err)
      })
    }
  }
  return { ...report, exported, ok: report.ok && exported.every((e) => !e.error) }
}
