import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { AgentProfile, AgentWorkingMemory, ThreadId } from '@shared/types'
import { agentForThread, getFleet } from '../store/agents'

/**
 * Fleet agent working memory: one markdown file per agent that the agent reads at the start of every
 * run and edits itself (the `working_memory` tool), so it improves its process over time instead of
 * relearning the same lessons.
 *
 * It is deliberately different from the memory store (`memory_save`/`memory_search`). Those are
 * atomic facts recalled on demand; working memory is the agent's own notebook — current focus, the
 * process it has settled on, lessons from mistakes, notes on each teammate, open threads, and the
 * fleet's change log — always in view, in one document a person can also open and edit.
 *
 * Where it lives: `<userData>/data/agent-memory/<agent id>.md` — one file per agent, keyed by the
 * stable agent id. Not in the agent's cwd: two leads can share a cwd (both live leads ran in
 * ~/lattice), which would have merged their notebooks and dropped them into a git repo, and a cwd
 * change would orphan it. The Fleet screen edits it (agent drawer → Working memory) and shows the
 * path; the file is the single source of truth, so edits made by hand are picked up on the next run.
 * A removed agent's notebook is archived under `removed/`, not deleted.
 *
 * How it reaches the model: {@link workingMemoryNote} is appended to the wire at the tail, after the
 * prompt-cache anchor (the same place the checklist rides), and read once per run. Editing it
 * mid-run never invalidates the cached prefix; the edit shows up on the next run.
 */

/** Past this the agent is told to condense. */
export const SOFT_LIMIT = 12_000
/** A write that would exceed this is refused (the model must condense first). */
export const HARD_LIMIT = 32_000
/** How many change-log bullets the file keeps (the full history stays in the fleet_changes table). */
const CHANGE_LOG_KEEP = 25

export const CHANGE_LOG_SECTION = 'Change log'
export const LESSONS_SECTION = 'Lessons learned'

// ---------- location ----------

function memoryDir(): string {
  return join(app.getPath('userData'), 'data', 'agent-memory')
}

/** The working-memory file for an agent (stable for the agent's lifetime, whatever its name or cwd). */
export function workingMemoryPath(profile: Pick<AgentProfile, 'id'>): string {
  return join(memoryDir(), `${profile.id}.md`)
}

// ---------- template ----------

/** The starter document for an agent that has not written its working memory yet. */
export function starterTemplate(profile: AgentProfile): string {
  const fleet = getFleet(profile.fleetId)?.name ?? 'fleet'
  if (profile.kind === 'orchestrator') {
    return (
      `# ${profile.name} — working memory (${fleet})\n\n` +
      `## Current focus\n\n` +
      `## Standing process\n` +
      `How jobs flow through the team, step by step. Refine it as you learn what works.\n\n` +
      `## ${LESSONS_SECTION}\n` +
      `Mistakes and what to do instead. One bullet each, dated.\n\n` +
      `## Agent notes\n` +
      `Per agent: what it is good at, where it slips, how to brief it.\n\n` +
      `## Open threads\n\n` +
      `## ${CHANGE_LOG_SECTION}\n`
    )
  }
  return (
    `# ${profile.name} — working memory (${fleet})\n\n` +
    `## Current focus\n\n` +
    `## How I do this job\n\n` +
    `## ${LESSONS_SECTION}\n\n` +
    `## Open threads\n`
  )
}

// ---------- read / write ----------

export function readWorkingMemory(profile: AgentProfile): AgentWorkingMemory {
  const path = workingMemoryPath(profile)
  let content: string | undefined
  let updatedAt: number | undefined
  try {
    content = readFileSync(path, 'utf8')
    updatedAt = statSync(path).mtimeMs
  } catch {
    content = undefined
  }
  const exists = content !== undefined
  const text = content ?? starterTemplate(profile)
  return { agentId: profile.id, path, content: text, exists, chars: text.length, softLimit: SOFT_LIMIT, ...(updatedAt ? { updatedAt } : {}) }
}

/** Atomically replace an agent's working memory. Refuses content past {@link HARD_LIMIT}. */
export function writeWorkingMemory(profile: AgentProfile, content: string): { ok: true; path: string; chars: number } | { ok: false; error: string } {
  const text = normalize(content)
  if (text.length > HARD_LIMIT) {
    return {
      ok: false,
      error: `Working memory would be ${text.length} characters; the limit is ${HARD_LIMIT}. Condense it first (merge duplicate lessons, drop finished open threads) with action "rewrite".`
    }
  }
  const path = workingMemoryPath(profile)
  try {
    mkdirSync(dirname(path), { recursive: true })
    const tmp = `${path}.${process.pid}.tmp`
    writeFileSync(tmp, text, 'utf8')
    renameSync(tmp, path)
  } catch (err) {
    return { ok: false, error: `Could not write ${path}: ${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, path, chars: text.length }
}

/**
 * Archive a removed agent's notebook to `agent-memory/removed/<slug>-<id>.md` (lessons are the most
 * expensive thing a fleet owns; removing an agent must not silently destroy them). Returns the
 * notebook's content so the caller can hand it to whoever absorbs the agent's duty, or undefined when
 * the agent never wrote one.
 */
export function archiveWorkingMemory(profile: Pick<AgentProfile, 'id' | 'name'>): { content: string; archivedTo: string } | undefined {
  const from = workingMemoryPath(profile)
  if (!existsSync(from)) return undefined
  let content: string
  try {
    content = readFileSync(from, 'utf8')
  } catch {
    return undefined
  }
  const slugged = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'agent'
  const to = join(memoryDir(), 'removed', `${slugged}-${profile.id}.md`)
  try {
    mkdirSync(dirname(to), { recursive: true })
    renameSync(from, to)
  } catch {
    return { content, archivedTo: from }
  }
  return { content, archivedTo: to }
}

function normalize(text: string): string {
  const trimmed = text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  return `${trimmed}\n`
}

// ---------- sections ----------

interface Section {
  /** heading text without the `## ` */
  name: string
  /** index of the heading line */
  start: number
  /** index one past the last line of the section's body */
  end: number
}

const HEADING = /^##\s+(.+?)\s*$/

function sections(lines: string[]): Section[] {
  const out: Section[] = []
  lines.forEach((line, i) => {
    const m = HEADING.exec(line)
    if (!m) return
    if (out.length) out[out.length - 1]!.end = i
    out.push({ name: m[1]!, start: i, end: lines.length })
  })
  return out
}

/** Find a section by exact (case-insensitive) name, then by unique prefix. */
function findSection(all: Section[], query: string): Section | { error: string } | null {
  const q = query.trim().replace(/^#+\s*/, '').toLowerCase()
  if (!q) return { error: 'Name the section (e.g. "Lessons learned").' }
  const exact = all.filter((s) => s.name.toLowerCase() === q)
  if (exact.length) return exact[0]!
  const prefix = all.filter((s) => s.name.toLowerCase().startsWith(q))
  if (prefix.length === 1) return prefix[0]!
  if (prefix.length > 1) return { error: `"${query}" matches several sections: ${prefix.map((s) => `"${s.name}"`).join(', ')}.` }
  return null
}

export type WorkingMemoryEdit =
  | { action: 'append'; section: string; text: string }
  | { action: 'replace_section'; section: string; text: string }
  | { action: 'remove_section'; section: string }
  | { action: 'str_replace'; old: string; new: string }
  | { action: 'rewrite'; text: string }

/**
 * Apply one edit to a working-memory document (pure). `append` and `replace_section` create the
 * section at the end when it does not exist yet — a model should never have to set up headings
 * before it can write down a lesson.
 */
export function applyWorkingMemoryEdit(content: string, edit: WorkingMemoryEdit): { content: string } | { error: string } {
  if (edit.action === 'rewrite') {
    if (!edit.text.trim()) return { error: 'rewrite needs the full new document in `text`.' }
    return { content: normalize(edit.text) }
  }
  if (edit.action === 'str_replace') {
    if (!edit.old) return { error: 'str_replace needs `old` (the exact text to replace).' }
    const first = content.indexOf(edit.old)
    if (first === -1) return { error: 'The `old` text was not found. Read the memory (action "read") and copy it exactly.' }
    if (content.indexOf(edit.old, first + edit.old.length) !== -1) {
      return { error: 'The `old` text appears more than once; include more surrounding text so it is unique.' }
    }
    return { content: normalize(content.slice(0, first) + edit.new + content.slice(first + edit.old.length)) }
  }

  const lines = content.replace(/\s+$/, '').split('\n')
  const found = findSection(sections(lines), edit.section)
  if (found && 'error' in found) return found

  if (edit.action === 'remove_section') {
    if (!found) return { error: `No section named "${edit.section}".` }
    lines.splice(found.start, found.end - found.start)
    return { content: normalize(lines.join('\n')) }
  }

  const body = edit.text.replace(/\s+$/, '')
  if (!body.trim()) return { error: `${edit.action} needs \`text\`.` }
  if (!found) {
    const name = edit.section.trim().replace(/^#+\s*/, '')
    return { content: normalize(`${lines.join('\n')}\n\n## ${name}\n${body}`) }
  }
  if (edit.action === 'replace_section') {
    const tail = lines.slice(found.end)
    const next = [...lines.slice(0, found.start + 1), body, ...(tail.length ? [''] : []), ...tail]
    return { content: normalize(next.join('\n')) }
  }
  // append: after the section's last non-blank line
  let at = found.end
  while (at > found.start + 1 && !lines[at - 1]!.trim()) at--
  const tail = lines.slice(at)
  // Keep a blank line between this section's new last line and the next heading.
  const gap = tail.length && tail[0]!.trim() ? [''] : []
  return { content: normalize([...lines.slice(0, at), body, ...gap, ...tail].join('\n')) }
}

/** Local "YYYY-MM-DD HH:MM" — the stamp lessons and change-log lines carry. */
export function stamp(at = Date.now()): string {
  const d = new Date(at)
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

/**
 * Add a bullet to an orchestrator's change log (creating the file from its template when needed),
 * keeping only the newest {@link CHANGE_LOG_KEEP} bullets — `fleet_history` has the full record.
 */
export function appendChangeLogLine(orchestrator: AgentProfile, line: string): void {
  const mem = readWorkingMemory(orchestrator)
  const lines = mem.content.replace(/\s+$/, '').split('\n')
  const found = findSection(sections(lines), CHANGE_LOG_SECTION)
  const bullet = `- ${stamp()} · ${line.replace(/\s+/g, ' ').trim()}`
  let next: string
  if (!found || 'error' in found) {
    next = `${lines.join('\n')}\n\n## ${CHANGE_LOG_SECTION}\n${bullet}`
  } else {
    const bodyLines = lines.slice(found.start + 1, found.end)
    const bullets = bodyLines.filter((l) => l.startsWith('- '))
    const prose = bodyLines.filter((l) => !l.startsWith('- ') && l.trim())
    const kept = [...bullets, bullet].slice(-CHANGE_LOG_KEEP)
    const tail = lines.slice(found.end)
    next = [...lines.slice(0, found.start + 1), ...prose, ...kept, ...(tail.length ? [''] : []), ...tail].join('\n')
  }
  // A change log line must never be the thing that fails a fleet edit: past the hard limit, drop it.
  writeWorkingMemory(orchestrator, next)
}

// ---------- the per-run note ----------

/**
 * The working-memory note appended to a fleet agent's wire for this run, or null for a thread that is
 * not a fleet agent. An orchestrator always gets it (with the template when the file does not exist
 * yet, so it knows the shape to fill in); a worker gets its file when it has one, and a one-line
 * pointer otherwise, to keep a lean worker's context small.
 */
export function workingMemoryNote(threadId: ThreadId): string | null {
  const self = agentForThread(threadId)
  if (!self) return null
  const mem = readWorkingMemory(self)
  if (!mem.exists && self.kind === 'worker') {
    return (
      `# Working memory\nYou have not started your working memory yet (${mem.path}). When you learn how ` +
      `to do this job better — a site that blocks plain fetches, a filter that matters, a mistake not to ` +
      `repeat — write it down with working_memory(action:"append", section:"Lessons learned", text:"- …"). ` +
      `It is shown to you at the start of every run.`
    )
  }
  const body = mem.content.length > HARD_LIMIT ? `${mem.content.slice(0, HARD_LIMIT)}\n… (clipped — condense this file)` : mem.content
  const size =
    mem.chars > SOFT_LIMIT
      ? `\nIt is ${mem.chars} characters, past the ${SOFT_LIMIT} soft limit: condense it this run (action "rewrite") — merge duplicate lessons, drop finished open threads.`
      : ''
  const state = mem.exists ? `as of the start of this run` : `not written yet — this is the starter layout`
  return (
    `# Working memory\nYour own notebook (${mem.path}, ${state}). Keep it current with the working_memory ` +
    `tool; edits show here from your next run.${size}\n\n<working_memory>\n${body.replace(/\s+$/, '')}\n</working_memory>`
  )
}
