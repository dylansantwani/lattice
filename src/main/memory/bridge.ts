import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync, unlinkSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { basename, dirname, join } from 'node:path'
import type { MemoryItem, MemorySyncReport, MemoryType, WorkspaceMeta } from '@shared/types'
import { listMemory, upsertMemory, deleteMemory } from '../store/eventStore'

/**
 * Memory bridge: import the user's Claude Code and Hermes memory into Lattice's store so the
 * model shares one memory across all three agents. Read-only against the external stores — we
 * never write back into another agent's files (single-writer rule). Imported items are marked
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
function collectClaudeCode(root: string, workspaceId: string): Draft[] {
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
        id: 'mem:cc:project-md',
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
        id: `mem:cc:file:${basename(name, '.md')}`,
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
function collectHermes(): Draft[] {
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

  for (const src of [
    { store: 'claude-code' as const, label: 'Claude Code', collect: () => collectClaudeCode(root, workspace.id) },
    { store: 'hermes' as const, label: 'Hermes', collect: collectHermes }
  ]) {
    try {
      const found = src.collect()
      drafts.push(...found)
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

  // Prune imports that vanished upstream.
  let removed = 0
  for (const id of existing.keys()) {
    if (!byId.has(id)) {
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
    // This snapshot imports only. Write-back is a separate phase; keep the report shape explicit
    // so callers can render a stable sync summary while that phase is disabled.
    exported: []
  }
}
