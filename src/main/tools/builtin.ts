import { exec } from 'node:child_process'
import { readFile, writeFile, readdir, mkdir, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { homedir } from 'node:os'
import type { ToolContext, ToolDefinition } from './types'
import * as store from '../store/eventStore'

const MAX_READ_BYTES = 256 * 1024
const MAX_TOOL_OUTPUT = 48 * 1024

function resolvePath(p: string, ctx: ToolContext): string {
  const expanded = p.startsWith('~') ? join(homedir(), p.slice(1)) : p
  return isAbsolute(expanded) ? resolve(expanded) : resolve(ctx.workspace.roots[0] ?? homedir(), expanded)
}

export function isInsideRoots(path: string, roots: string[]): boolean {
  const r = resolve(path)
  return roots.some((root) => r === resolve(root) || r.startsWith(resolve(root) + '/'))
}

function clip(s: string, max = MAX_TOOL_OUTPUT): string {
  return s.length > max ? s.slice(0, max) + `\n… [truncated ${s.length - max} chars]` : s
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
      const path = resolvePath(String(args.path), ctx)
      const raw = await readFile(path, 'utf8')
      let text = raw
      if (args.offset || args.limit) {
        const lines = raw.split('\n')
        const start = Math.max(0, Number(args.offset ?? 1) - 1)
        const count = Number(args.limit ?? 2000)
        text = lines.slice(start, start + count).join('\n')
      }
      if (Buffer.byteLength(text) > MAX_READ_BYTES) text = text.slice(0, MAX_READ_BYTES) + '\n… [truncated]'
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
      const path = resolvePath(String(args.path), ctx)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, String(args.content), 'utf8')
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
      const path = resolvePath(String(args.path), ctx)
      const content = await readFile(path, 'utf8')
      const oldStr = String(args.old_string)
      const count = content.split(oldStr).length - 1
      if (count === 0) throw new Error('old_string not found in file')
      if (count > 1 && !args.replace_all) throw new Error(`old_string appears ${count} times; pass replace_all or add context`)
      const next = args.replace_all
        ? content.split(oldStr).join(String(args.new_string))
        : content.replace(oldStr, String(args.new_string))
      await writeFile(path, next, 'utf8')
      return { path, replacements: args.replace_all ? count : 1 }
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
      const path = resolvePath(String(args.path), ctx)
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
    name: 'shell',
    description:
      'Run a shell command with zsh. Returns stdout/stderr/exit code. Default timeout 120s.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string' },
        cwd: { type: 'string' },
        timeout_ms: { type: 'number' }
      },
      required: ['command']
    },
    resource: 'shell',
    action: 'execute',
    riskTier: 'R2',
    allowedInPlan: false,
    summarize: (a) => `Run: ${String(a.command).slice(0, 120)}`,
    run(args, ctx) {
      const cwd = args.cwd ? resolvePath(String(args.cwd), ctx) : (ctx.workspace.roots[0] ?? homedir())
      const timeout = Math.min(Number(args.timeout_ms ?? 120000), 600000)
      return new Promise((resolvePromise) => {
        const child = exec(
          String(args.command),
          { cwd, shell: '/bin/zsh', timeout, maxBuffer: 8 * 1024 * 1024, signal: ctx.signal },
          (err, stdout, stderr) => {
            resolvePromise({
              exitCode: err && typeof (err as NodeJS.ErrnoException & { code?: number }).code === 'number' ? (err as { code?: number }).code : err ? 1 : 0,
              stdout: clip(stdout),
              stderr: clip(stderr),
              timedOut: !!err && /ETIMEDOUT|SIGTERM/.test(String((err as Error).message))
            })
          }
        )
        ctx.signal.addEventListener('abort', () => child.kill('SIGTERM'), { once: true })
      })
    }
  },
  {
    name: 'grep_search',
    description: 'Search file contents with a regex (ripgrep if available, else grep -rE).',
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
      const path = resolvePath(String(args.path), ctx)
      const globFlag = args.glob ? ` -g '${String(args.glob).replace(/'/g, '')}'` : ''
      const pat = String(args.pattern).replace(/'/g, "'\\''")
      const cmd = `(command -v rg >/dev/null && rg -n --max-count 200 -e '${pat}'${globFlag} '${path}') || grep -rEn --include='${args.glob ?? '*'}' '${pat}' '${path}' | head -200`
      return new Promise((resolvePromise) => {
        exec(cmd, { shell: '/bin/zsh', timeout: 30000, maxBuffer: 4 * 1024 * 1024 }, (_err, stdout) => {
          resolvePromise({ matches: clip(stdout || '(no matches)') })
        })
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
