import { execFile } from 'node:child_process'
import { readdir, mkdir, stat, lstat, realpath, rename, rm, cp, open } from 'node:fs/promises'
import { constants } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ToolContext, ToolDefinition } from './types'
import * as store from '../store/eventStore'
import { runInShell } from './ptyShell'

const MAX_READ_BYTES = 256 * 1024
const MAX_TOOL_OUTPUT = 48 * 1024

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
      'stdout and stderr are combined. Default timeout 120s. Do not launch long-running foreground ' +
      'processes (servers, watchers) — background them or they will time out.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string', description: 'Run from this directory (persists for later commands)' },
        timeout_ms: { type: 'number' }
      },
      required: ['command']
    },
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) => `Run: ${String(a.command).slice(0, 120)}`,
    async run(args, ctx) {
      const timeout = Math.min(Number(args.timeout_ms ?? 120000), 600000)
      const cwd = args.cwd
        ? resolveToolPath(String(args.cwd), ctx)
        : (ctx.workspace.roots[0] ?? homedir())
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
      'Create or update items on the run checklist. Pass full list state each time: [{id?, title, status}]. Statuses: todo|in_progress|blocked|review|done|canceled.',
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
              details: { type: 'string' }
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
      const items = args.items as { id?: string; title: string; status: string; details?: string }[]
      const saved = items.map((it) =>
        store.upsertTodo({
          id: it.id,
          title: it.title,
          status: (['todo', 'in_progress', 'blocked', 'review', 'done', 'canceled'].includes(it.status)
            ? it.status
            : 'todo') as 'todo',
          details: it.details,
          threadId: ctx.threadMeta.id,
          workspaceId: ctx.workspace.id,
          durable: false
        })
      )
      return { items: saved.map((s) => ({ id: s.id, title: s.title, status: s.status })) }
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
    name: 'run_agent',
    description:
      'Delegate a self-contained sub-task to an isolated subagent. The subagent starts with a ' +
      'clean context (only the task you give it — it cannot see this conversation), works ' +
      'autonomously with the same tools you have, and returns its final answer as the result. ' +
      'Use it to parallelize independent work or to keep a large search/investigation out of ' +
      'your own context. Give it one bounded goal and say exactly what to return. A subagent ' +
      'cannot spawn further subagents.',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'The complete, self-contained instruction for the subagent.'
        },
        agent_type: {
          type: 'string',
          description: 'Optional role label for the subagent, e.g. "researcher" or "reviewer".'
        },
        model: { type: 'string', description: 'Optional model id override (defaults to yours).' },
        effort: { type: 'string', description: 'Optional reasoning effort override.' }
      },
      required: ['task']
    },
    resource: 'network',
    action: 'execute',
    // R0 so it's available under the default preset; the subagent's own tool calls are gated
    // by the same mode/preset as the parent, so aggregate risk stays bounded.
    riskTier: 'R0',
    allowedInPlan: true,
    summarize: (a) => `Delegate to subagent: ${String(a.task ?? '').slice(0, 80)}`,
    async run(args, ctx) {
      if (!ctx.runSubagent) {
        throw new Error('Subagents are not available here (a subagent cannot spawn subagents).')
      }
      const task = String(args.task ?? '').trim()
      if (!task) throw new Error('task is required and must be a non-empty string.')
      const res = await ctx.runSubagent({
        task,
        agentType: args.agent_type ? String(args.agent_type) : undefined,
        model: args.model ? String(args.model) : undefined,
        effort: args.effort ? String(args.effort) : undefined
      })
      return { agentId: res.agentId, toolCalls: res.toolCalls, result: res.text }
    }
  },
  {
    name: 'ask_user',
    description:
      'Pause and ask the user a question, then continue with their answer. Use this when you ' +
      'genuinely need information or a decision only the user can provide — a missing detail, ' +
      'a choice between real alternatives, or confirmation before a consequential step — and you ' +
      'cannot get it from the conversation, the files, or a sensible default. Do NOT use it to ' +
      'narrate options you could just pick, to ask permission for tool calls (the permission ' +
      'system handles that), or for anything you can determine yourself. Prefer one well-formed ' +
      'question over several round-trips. The tool blocks until the user responds; the result is ' +
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
          items: { type: 'string' },
          description: 'The selectable answers for kind:"choice" (2–8 short, distinct options).'
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
      const options = Array.isArray(args.options)
        ? args.options.map((o) => String(o)).filter((o) => o.length > 0).slice(0, 8)
        : undefined
      const requested = ['text', 'choice', 'confirm'].includes(String(args.kind))
        ? (String(args.kind) as 'text' | 'choice' | 'confirm')
        : options && options.length
          ? 'choice'
          : 'text'
      // A 'choice' with no usable options would strand the user — fall back to text.
      const kind = requested === 'choice' && (!options || options.length < 1) ? 'text' : requested
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
    description: 'Full-text search over saved memory items.',
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
      const q = String(args.query).toLowerCase()
      const items = store
        .listMemory()
        .filter((m) => m.status === 'approved' && m.content.toLowerCase().includes(q))
        .slice(0, 20)
      return { items: items.map((m) => ({ id: m.id, scope: m.scope, type: m.type, content: m.content })) }
    }
  }
]
