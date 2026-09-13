import { readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Workspace primer — a compact, byte-stable orientation brief injected into every subagent's
 * system prompt.
 *
 * Why: measured on a real 27-agent build, ~31% of all tool calls (860 of 2,813) were fresh
 * subagents re-discovering the repo from a blank context — ls/grep/cat rounds that each re-billed
 * a full transcript. A few KB of layout handed to the agent at spawn removes most of that, and
 * because the primer is memoized for the process lifetime, every subagent in a session shares a
 * byte-identical system-prompt prefix — so a provider with automatic prefix caching (DeepSeek
 * et al.) serves each spawn's cold start largely from cache instead of re-billing it at the
 * uncached rate.
 *
 * The snapshot is deliberately allowed to go stale within a session (agents create files
 * constantly; regenerating per spawn would change the bytes each time and defeat both the cache
 * sharing and the point). The header says so, and agents are told to verify before relying on
 * details.
 */

/** Directories that add noise, not orientation. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'build',
  'out',
  'coverage',
  '.next',
  '.turbo',
  '.cache',
  '.pnpm',
  '.venv',
  '__pycache__'
])

/**
 * Folders macOS guards with a per-app permission prompt (Desktop, Documents, Downloads, and the
 * media libraries) plus the home-level system folders. Opening one of these from an app that has
 * not been granted access does not fail — the `open()` syscall BLOCKS until the user answers the
 * prompt, and this walker runs synchronously on the main thread. Measured 2026-09-11: a freshly
 * re-signed build hung at launch for good inside `opendir("/Users/dylan/Desktop")`, bridge and
 * window dead, because the workspace root was the home directory. Never descend into these.
 */
export const PROTECTED_HOME_DIRS = new Set([
  'Desktop',
  'Documents',
  'Downloads',
  'Library',
  'Movies',
  'Music',
  'Pictures',
  'Public',
  'Applications'
])

/** Ceilings that keep the primer a brief, not a dump. */
export const PRIMER_MAX_CHARS = 6000
const MAX_TOP_ENTRIES = 40
const MAX_CHILD_ENTRIES = 14
const MAX_MANIFESTS = 12
const MAX_README_CHARS = 700
/** Hard budget of filesystem operations (directory reads + manifest reads) per primer build. A
 *  workspace root that is a huge tree must cost a bounded number of syscalls, not "all of them". */
export const PRIMER_MAX_FS_OPS = 160

/**
 * A root that is the user's home directory (or above it) is not a project: it has no shape worth
 * priming, and everything one level down is either protected or enormous. Such a root gets only
 * its top-level listing and its own orientation doc — no descent, no manifest hunt.
 */
export function isHomeLikeRoot(root: string): boolean {
  const r = resolve(root)
  const home = resolve(homedir())
  return r === '/' || r === home || home.startsWith(r + '/')
}

/** Whether a directory under `root` may be listed: protected home folders are never opened. */
function mayDescend(root: string, name: string): boolean {
  if (SKIP_DIRS.has(name)) return false
  if (isHomeLikeRoot(root) && PROTECTED_HOME_DIRS.has(name)) return false
  // A project root that IS the parent of the home dir (e.g. "/Users") must not open home dirs.
  if (resolve(homedir()).startsWith(resolve(join(root, name)) + '/') || resolve(join(root, name)) === resolve(homedir())) return false
  return true
}

class OpBudget {
  used = 0
  constructor(readonly max: number) {}
  take(): boolean {
    if (this.used >= this.max) return false
    this.used += 1
    return true
  }
}

function listEntries(dir: string, root: string, budget: OpBudget): { dirs: string[]; files: string[] } {
  if (!budget.take()) return { dirs: [], files: [] }
  try {
    const dirs: string[] = []
    const files: string[] = []
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.') && e.name !== '.claude') continue
      if (e.isDirectory()) {
        if (mayDescend(root, e.name)) dirs.push(e.name)
      } else {
        files.push(e.name)
      }
    }
    dirs.sort()
    files.sort()
    return { dirs, files }
  } catch {
    return { dirs: [], files: [] }
  }
}

function readJson(path: string, budget: OpBudget): Record<string, unknown> | null {
  if (!budget.take()) return null
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

/** One line per package manifest: name plus its script names (what the repo can run). */
function manifestLine(dir: string, rel: string, budget: OpBudget): string | null {
  const pkg = readJson(join(dir, 'package.json'), budget)
  if (!pkg) return null
  const name = typeof pkg.name === 'string' ? pkg.name : rel || '(unnamed)'
  const scripts = pkg.scripts && typeof pkg.scripts === 'object' ? Object.keys(pkg.scripts as object).slice(0, 12) : []
  const where = rel ? `${rel}/` : './'
  return `- ${where}package.json — ${name}${scripts.length ? ` (scripts: ${scripts.join(', ')})` : ''}`
}

/**
 * Build the primer text for a set of workspace roots. Pure over the filesystem: same tree in,
 * same bytes out. Never throws — unreadable pieces are simply omitted.
 */
export function buildWorkspacePrimer(roots: string[]): string {
  const sections: string[] = []
  const budget = new OpBudget(PRIMER_MAX_FS_OPS)
  for (const root of roots.slice(0, 2)) {
    let ok = false
    try {
      ok = statSync(root).isDirectory()
    } catch {
      ok = false
    }
    if (!ok) continue

    const lines: string[] = [`Root: ${root}`]
    const homeLike = isHomeLikeRoot(root)
    const { dirs, files } = listEntries(root, root, budget)
    const top = [...dirs.map((d) => d + '/'), ...files].slice(0, MAX_TOP_ENTRIES)
    if (top.length > 0) lines.push(`Top level: ${top.join('  ')}`)
    if (homeLike) lines.push('(This root is a home directory, not a project: only its top level is listed.)')

    // One level of tree under each top-level directory — enough to see the shape of a monorepo
    // (apps/x, packages/y) without dumping it. A home-like root is never descended into.
    const childOf = new Map<string, { dirs: string[]; files: string[] }>()
    if (!homeLike) {
      for (const d of dirs.slice(0, 12)) {
        const child = listEntries(join(root, d), root, budget)
        childOf.set(d, child)
        const entries = [...child.dirs.map((c) => c + '/'), ...child.files].slice(0, MAX_CHILD_ENTRIES)
        if (entries.length > 0) lines.push(`  ${d}/: ${entries.join('  ')}`)
      }
    }

    // Package manifests: the root's, then any one level down inside workspace-shaped dirs. The
    // child listings above are reused rather than read twice.
    const manifests: string[] = []
    const rootLine = manifestLine(root, '', budget)
    if (rootLine) manifests.push(rootLine)
    if (!homeLike) {
      for (const d of dirs) {
        const child = childOf.get(d) ?? listEntries(join(root, d), root, budget)
        for (const c of child.dirs) {
          if (manifests.length >= MAX_MANIFESTS || budget.used >= budget.max) break
          const line = manifestLine(join(root, d, c), `${d}/${c}`, budget)
          if (line) manifests.push(line)
        }
        if (manifests.length >= MAX_MANIFESTS || budget.used >= budget.max) break
      }
    }
    if (manifests.length > 0) lines.push('Packages:', ...manifests)

    for (const doc of ['README.md', 'CLAUDE.md', 'AGENTS.md']) {
      try {
        const text = readFileSync(join(root, doc), 'utf8').trim()
        if (text) {
          lines.push(`${doc} (excerpt):`, text.slice(0, MAX_README_CHARS))
          break // one orientation doc is enough
        }
      } catch {
        /* absent — fine */
      }
    }

    sections.push(lines.join('\n'))
  }
  if (sections.length === 0) return ''
  const body = sections.join('\n\n')
  return (
    '## Workspace primer\n\n' +
    'A snapshot of the workspace taken when this session first needed it — it may be stale ' +
    'in the details (files are created and moved as work progresses), so verify with a targeted ' +
    'read before relying on a specific path, but use it instead of exploratory ls/grep rounds to ' +
    'orient yourself.\n\n' +
    (body.length > PRIMER_MAX_CHARS ? body.slice(0, PRIMER_MAX_CHARS) + '\n[primer truncated]' : body)
  )
}

/**
 * Memoized-for-the-process primer per root set. The memo IS the feature: it keeps the bytes
 * identical across every spawn in a session (shared provider cache prefix), at the cost of a
 * snapshot that ages — which the primer's own header discloses.
 */
const primerMemo = new Map<string, string>()

export function workspacePrimerFor(roots: string[]): string {
  const key = [...roots].sort().join(' ')
  const hit = primerMemo.get(key)
  if (hit !== undefined) return hit
  const built = buildWorkspacePrimer(roots)
  primerMemo.set(key, built)
  return built
}

export function resetWorkspacePrimerCache(): void {
  primerMemo.clear()
}
