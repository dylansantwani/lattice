import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { basename, dirname, resolve } from 'node:path'
import type { LatticeTransport } from './transport/types'
import type { ParsedCliArgs, ResolvedCliOptions } from './args'
import type { ThreadMeta, WorkspaceMeta } from '@shared/types'
import { parsePermissionSpecs } from './permissionSpec'

export interface BoundSession {
  workspace: WorkspaceMeta
  thread: ThreadMeta
  cwd: string
  projectRoot: string
  attachments: Awaited<ReturnType<LatticeTransport['api']['attachFile']>>[]
}

function hasProjectMarker(path: string): boolean {
  return existsSync(resolve(path, '.git'))
}

function hasInstructions(path: string): boolean {
  return existsSync(resolve(path, 'AGENTS.md')) || existsSync(resolve(path, 'CLAUDE.md'))
}

/** Find the nearest project boundary with the same precedence documented for the CLI. */
export function findProjectRoot(cwd: string): string {
  let current = resolve(cwd)
  let instructionRoot: string | undefined
  while (true) {
    if (hasProjectMarker(current)) return current
    if (!instructionRoot && hasInstructions(current)) instructionRoot = current
    const parent = dirname(current)
    if (parent === current) return instructionRoot ?? resolve(cwd)
    current = parent
  }
}

function matchThread(threads: ThreadMeta[], query: string): ThreadMeta | undefined {
  const exact = threads.find((thread) => thread.id === query || thread.title === query)
  if (exact) return exact
  const prefix = threads.filter((thread) => thread.id.startsWith(query) || thread.title.toLowerCase().startsWith(query.toLowerCase()))
  if (prefix.length === 1) return prefix[0]
  if (prefix.length > 1) throw new Error(`resume matched multiple threads: ${prefix.map((thread) => `${thread.id} (${thread.title})`).join(', ')}`)
  throw new Error(`thread not found: ${query}`)
}

async function instructionsValue(value: string | undefined): Promise<string | undefined> {
  if (!value) return undefined
  if (!value.startsWith('@')) return value
  return readFile(resolve(value.slice(1)), 'utf8')
}

export async function bindSession(
  transport: LatticeTransport,
  flags: ParsedCliArgs,
  options: ResolvedCliOptions,
  cwd = process.cwd()
): Promise<BoundSession> {
  const absoluteCwd = resolve(cwd)
  const projectRoot = findProjectRoot(absoluteCwd)
  let workspace = await transport.api.resolveWorkspace(projectRoot, { create: true })

  if (flags.addDir.length) {
    const roots = [...workspace.roots]
    for (const item of flags.addDir) {
      const root = resolve(item)
      if (!roots.includes(root)) roots.push(root)
    }
    if (roots.length !== workspace.roots.length && !flags.yes && !process.stdin.isTTY) {
      throw new Error('adding a directory in non-interactive mode requires --yes')
    }
      if (roots.length !== workspace.roots.length) workspace = await transport.api.updateWorkspace(workspace.id, { roots })
  }

  const allThreads = await transport.api.listThreads(workspace.id, true)
  let thread: ThreadMeta | undefined
  const resume = (flags as ParsedCliArgs & { resume?: string | true }).resume
  const shouldContinue = (flags as ParsedCliArgs & { continue?: boolean }).continue
  if (resume) {
    if (resume === true) {
      thread = allThreads.filter((item) => !item.archived)[0]
      if (!thread) throw new Error('no resumable thread found')
    } else {
      thread = matchThread(allThreads, resume)
    }
  }
  else if (shouldContinue) thread = allThreads.filter((item) => !item.archived).sort((a, b) => b.updatedAt - a.updatedAt)[0]

  if (!thread) {
    thread = await transport.api.createThread({
      workspaceId: workspace.id,
      cwd: absoluteCwd,
      model: options.model,
      effort: flags.effort,
      mode: options.mode,
      permissionPreset: options.preset,
      goal: flags.goal
    })
  } else {
    const patch: Partial<ThreadMeta> = {
      ...(options.model ? { model: options.model } : {}),
      ...(flags.effort ? { effort: flags.effort } : {}),
      ...(options.mode ? { mode: options.mode } : {}),
      ...(options.preset ? { permissionPreset: options.preset } : {}),
      ...(flags.goal !== undefined ? { goal: flags.goal } : {}),
      cwd: absoluteCwd
    }
    if (Object.keys(patch).length) thread = await transport.api.updateThread(thread.id, patch)
  }

  const rules = parsePermissionSpecs(flags.allowTool, flags.denyTool)
  if (rules.length) await transport.api.setPermissionRules(thread.id, rules)

  const instructions = await instructionsValue(flags.instructions)
  if (instructions !== undefined) await transport.api.setSettings({ customInstructions: instructions })
  const attachments = []
  for (const path of flags.image) attachments.push(await transport.api.attachFile(resolve(path)))
  return { workspace, thread, cwd: absoluteCwd, projectRoot, attachments }
}

export function sessionHeader(session: BoundSession): string {
  const relative = session.cwd === session.projectRoot ? '.' : session.cwd.slice(session.projectRoot.length + 1)
  return `${session.workspace.name} · ${relative || '.'} · ${session.thread.model} · ${session.thread.mode}/${session.thread.permissionPreset}`
}
