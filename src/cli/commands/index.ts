import { mkdir, readFile, symlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { ThreadMeta } from '@shared/types'
import type { ParsedCliArgs } from '../args'
import { CLI_COMMANDS } from '../args'
import { readCliConfig, writeCliConfig, type CliProfile } from '../config'
import type { BoundSession } from '../session'
import type { LatticeTransport } from '../transport/types'

export interface CommandContext {
  transport: LatticeTransport
  flags: ParsedCliArgs
  session?: BoundSession
}

function jsonMode(flags: ParsedCliArgs): boolean {
  return flags.outputFormat === 'json'
}

function output(value: unknown, flags: ParsedCliArgs, text?: string): void {
  if (jsonMode(flags)) process.stdout.write(`${JSON.stringify(value)}\n`)
  else if (text !== undefined) process.stdout.write(`${text}\n`)
  else if (typeof value === 'string') process.stdout.write(`${value}\n`)
  else process.stdout.write(`${JSON.stringify(value, null, 2)}\n`)
}

function argFlag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}

function targetId(args: string[]): string {
  const value = args.find((item) => !item.startsWith('-'))
  if (!value) throw new Error('a thread/session id is required')
  return value
}

async function findThread(transport: LatticeTransport, query: string): Promise<ThreadMeta> {
  const threads = await transport.api.listThreads(undefined, true)
  const exact = threads.find((thread) => thread.id === query || thread.title === query)
  if (exact) return exact
  const matches = threads.filter((thread) => thread.id.startsWith(query) || thread.title.toLowerCase().startsWith(query.toLowerCase()))
  if (matches.length === 1) return matches[0]!
  if (matches.length > 1) throw new Error(`thread target is ambiguous: ${matches.map((thread) => thread.id).join(', ')}`)
  throw new Error(`thread not found: ${query}`)
}

function printAttachedEvent(event: import('@shared/types').RunEvent, flags: ParsedCliArgs): void {
  if (flags.outputFormat === 'stream-json') {
    process.stdout.write(`${JSON.stringify({ type: 'event', seq: event.seq, event })}\n`)
    return
  }
  if (event.body.type === 'text.delta') process.stdout.write(event.body.text)
  else if (event.body.type === 'tool.result') process.stdout.write(`\n→ ${event.body.tool} ${event.body.ok ? '✓' : '✗'}\n`)
  else if (event.body.type === 'run.completed') process.stdout.write('\n')
}

async function threadAction(ctx: CommandContext, args: string[]): Promise<number> {
  const { transport, flags } = ctx
  const action = args[0] ?? 'list'
  if (action === 'list') {
    const workspace = argFlag(args, '--workspace')
    const rows = await transport.api.listThreads(workspace, args.includes('--all'))
    output(rows, flags, rows.map((row) => `${row.id}  ${row.running ? '●' : '○'}  ${row.title}`).join('\n'))
    return 0
  }
  if (action === 'show') {
    const thread = await transport.api.getThread(targetId(args.slice(1)))
    output(args.includes('--events') ? thread : thread.meta, flags)
    return 0
  }
  if (action === 'new') {
    const thread = await transport.api.createThread({ title: argFlag(args, '--title') })
    output(thread, flags, thread.id)
    return 0
  }
  if (action === 'rm') { await transport.api.deleteThread(targetId(args.slice(1))); return 0 }
  if (action === 'clear') { await transport.api.clearThread(targetId(args.slice(1))); return 0 }
  if (action === 'fork') {
    const thread = await transport.api.forkThread(targetId(args.slice(1)), { titlePrefix: argFlag(args, '--title') })
    output(thread, flags, thread.title)
    return 0
  }
  if (action === 'compact') { output(await transport.api.compactThread(targetId(args.slice(1))), flags); return 0 }
  if (['archive', 'unarchive', 'pin', 'unpin'].includes(action)) {
    const id = targetId(args.slice(1))
    const thread = await transport.api.updateThread(id, { [action === 'archive' || action === 'unarchive' ? 'archived' : 'pinned']: action === 'archive' || action === 'pin' })
    output(thread, flags, `${thread.id} ${thread.title}`)
    return 0
  }
  if (action === 'title') {
    const id = targetId(args.slice(1))
    const title = args.slice(2).filter((item) => !item.startsWith('--')).join(' ')
    output(await transport.api.updateThread(id, { title }), flags, title)
    return 0
  }
  if (action === 'search') {
    const query = args.slice(1).filter((item) => !item.startsWith('--')).join(' ')
    output(await transport.api.searchThreads(query, Number(argFlag(args, '--limit') ?? 20)), flags)
    return 0
  }
  throw new Error(`unknown threads action: ${action}`)
}

async function todoAction(ctx: CommandContext, args: string[]): Promise<number> {
  const { transport, flags, session } = ctx
  const action = args[0] ?? 'list'
  const threadId = argFlag(args, '--thread') ?? session?.thread.id
  if (action === 'list') { output(await transport.api.listTodos(threadId), flags); return 0 }
  if (!threadId && action !== 'add') throw new Error('--thread or an active session is required')
  if (action === 'add') {
    const title = args.slice(1).filter((item) => !item.startsWith('--')).join(' ')
    const todo = await transport.api.upsertTodo({ title, threadId })
    output(todo, flags, todo.title)
    return 0
  }
  if (action === 'done') { output(await transport.api.updateTodo(targetId(args.slice(1)), { status: 'done' }), flags); return 0 }
  if (action === 'rm') { await transport.api.deleteTodo(targetId(args.slice(1))); return 0 }
  if (action === 'clear') { output(await transport.api.clearTodos(threadId!, args.includes('--all') ? 'all' : 'done'), flags); return 0 }
  throw new Error(`unknown todos action: ${action}`)
}

export async function runCommand(ctx: CommandContext): Promise<number> {
  const { transport, flags } = ctx
  const command = flags.command
  if (!command) throw new Error('missing command')
  const args = flags.commandArgs
  if (command === 'threads') return threadAction(ctx, args)
  if (command === 'todos') return todoAction(ctx, args)
  if (command === 'models') {
    if (args[0] === 'check') { output(await transport.api.checkModelHealth(args.slice(1)), flags); return 0 }
    const models = await transport.api.listModels(args.includes('--refresh'))
    if (args.includes('--health')) {
      output(await transport.api.checkModelHealth(models.map((model) => model.id), args.includes('--refresh')), flags)
      return 0
    }
    output(models, flags, models.map((model) => model.id).join('\n'))
    return 0
  }
  if (command === 'providers') {
    const settings = await transport.api.getSettings()
    if (args[0] === '--check' && args[1]) output(await transport.api.checkProvider(args[1]), flags)
    else output(settings.providers.map(({ apiKey: _key, headers: _headers, ...provider }) => provider), flags)
    return 0
  }
  if (command === 'send') {
    const id = targetId(args)
    const text = args.slice(1).filter((item) => !item.startsWith('--')).join(' ')
    const attachments = []
    for (const path of flags.image) attachments.push(await transport.api.attachFile(resolve(path)))
    const result = await transport.api.send({ threadId: id, text, attachments: attachments.length ? attachments : undefined, disposition: args.includes('--steer') ? 'steer' : args.includes('--queue') ? 'queue' : 'send' })
    output(result, flags)
    return 0
  }
  if (command === 'attach') {
    const thread = await findThread(transport, targetId(args))
    const detail = await transport.api.getThread(thread.id)
    if (flags.outputFormat === 'json') output(detail, flags)
    else if (!flags.follow) {
      for (const message of detail.messages) if (message.text) process.stdout.write(`${message.role === 'user' ? '› ' : ''}${message.text}\n`)
      for (const event of detail.events.filter((item) => item.seq > (flags.since ?? -1))) printAttachedEvent(event, flags)
    }
    if (flags.follow) {
      for (const event of detail.events.filter((item) => item.seq > (flags.since ?? -1))) printAttachedEvent(event, flags)
      for await (const push of transport.events) {
        if (push.kind === 'run.event' && push.event.threadId === thread.id && push.event.seq > (flags.since ?? -1)) printAttachedEvent(push.event, flags)
      }
    }
    return 0
  }
  if (command === 'stop') { await transport.api.stopThreadWork(targetId(args)); return 0 }
  if (command === 'retry') {
    const thread = await transport.api.getThread(targetId(args))
    const message = [...thread.messages].reverse().find((item) => item.role === 'assistant')
    if (!message) throw new Error('thread has no assistant turn to retry')
    const mode = (args.find((item) => ['auto', 'resume', 'restart'].includes(item)) ?? 'auto') as 'auto' | 'resume' | 'restart'
    output({ ok: await transport.api.retryTurn(thread.meta.id, message.id, mode) }, flags)
    return 0
  }
  if (command === 'mcp') {
    const action = args[0] ?? 'list'
    if (action === 'list') { output(await transport.api.listMcpServers(), flags); return 0 }
    if (action === 'remove') { await transport.api.deleteMcpServer(targetId(args.slice(1))); return 0 }
    if (action === 'add') {
      const raw = argFlag(args, '--config') ?? args.slice(1).find((item) => !item.startsWith('--'))
      if (!raw) throw new Error('mcp add requires a config JSON object or --config')
      const configText = raw.startsWith('@') ? await readFile(resolve(raw.slice(1)), 'utf8') : raw
      const parsed = JSON.parse(configText) as Record<string, unknown>
      if (typeof parsed.id !== 'string' || typeof parsed.label !== 'string' || (parsed.transport !== 'stdio' && parsed.transport !== 'http')) {
        throw new Error('mcp config needs string id, label, and transport (stdio or http)')
      }
      await transport.api.upsertMcpServer({ ...parsed, enabled: parsed.enabled !== false } as never)
      output({ id: parsed.id, ok: true }, flags)
      return 0
    }
    throw new Error(`unknown mcp action: ${action}`)
  }
  if (command === 'memory') {
    const action = args[0] ?? 'list'
    if (action === 'list') { output(await transport.api.listMemory(), flags); return 0 }
    if (action === 'search') { output(await transport.api.searchMemory(args.slice(1).filter((item) => !item.startsWith('--')).join(' ')), flags); return 0 }
    if (action === 'sync') { output(await transport.api.syncMemory(), flags); return 0 }
    if (action === 'rm') { await transport.api.deleteMemory(targetId(args.slice(1))); return 0 }
    if (action === 'add') { output(await transport.api.upsertMemory({ content: args.slice(1).join(' ') }), flags); return 0 }
    throw new Error(`unknown memory action: ${action}`)
  }
  if (command === 'jobs') {
    const id = argFlag(args, '--thread') ?? ctx.session?.thread.id
    if (!id) throw new Error('--thread or an active session is required')
    if (args[0] === 'stop') { output({ stopped: await transport.api.stopJob(targetId(args.slice(1))) }, flags); return 0 }
    output(await transport.api.listJobs(id), flags)
    return 0
  }
  if (command === 'usage') { output(await transport.api.getStatsSnapshot(), flags); return 0 }
  if (command === 'sessions') {
    const read = async (): Promise<unknown> => args.includes('--activity') ? transport.api.listSessionActivity() : transport.api.listSessions()
    output(await read(), flags)
    if (args.includes('--watch') || flags.follow) {
      for await (const push of transport.events) if (push.kind === 'session.activity' || push.kind === 'thread.updated' || push.kind === 'notice') output(push, flags)
    }
    return 0
  }
  if (command === 'message') {
    const to = targetId(args)
    const body = args.slice(1).filter((item) => !item.startsWith('--')).join(' ')
    output(await transport.api.sendSessionMessage({ fromThreadId: ctx.session?.thread.id ?? '', to, body }), flags)
    return 0
  }
  if (command === 'inbox') {
    const positional = args.find((item, index) => !item.startsWith('-') && args[index - 1] !== '--read')
    const id = positional ?? ctx.session?.thread.id
    if (!id) throw new Error('inbox needs a thread id or an active session')
    const readId = argFlag(args, '--read')
    if (readId) { output({ ok: await transport.api.markSessionMessageRead(readId) }, flags); return 0 }
    output(await transport.api.listInbox(id), flags)
    return 0
  }
  if (command === 'config') {
    if (args[0] === 'profile') {
      const config = await readCliConfig()
      const profiles = Array.isArray(config.profiles)
        ? Object.fromEntries(config.profiles.map((profile) => [String((profile as CliProfile & { name?: string }).name ?? ''), profile]))
        : { ...(config.profiles ?? {}) }
      const action = args[1] ?? 'list'
      if (action === 'list') { output(profiles, flags); return 0 }
      const name = args[2]
      if (!name) throw new Error(`config profile ${action} requires a profile name`)
      if (action === 'rm' || action === 'remove') {
        delete profiles[name]
        await writeCliConfig({ ...config, profiles })
        return 0
      }
      if (action === 'set') {
        const raw = args.slice(3).join(' ')
        if (!raw) throw new Error('config profile set requires a JSON profile object')
        const profile = JSON.parse(raw) as CliProfile
        profiles[name] = profile
        await writeCliConfig({ ...config, profiles })
        output({ name, profile }, flags)
        return 0
      }
      throw new Error(`unknown config profile action: ${action}`)
    }
    const settings = await transport.api.getSettings()
    if (args[0] === 'get') output((settings as unknown as Record<string, unknown>)[args[1] ?? ''], flags)
    else if (args[0] === 'set') {
      const key = args[1]
      if (!key) throw new Error('config set requires a key')
      const raw = args.slice(2).join(' ')
      let value: unknown = raw
      try { value = JSON.parse(raw) } catch { /* strings stay strings */ }
      output(await transport.api.setSettings({ [key]: value } as never), flags)
    } else output(settings, flags)
    return 0
  }
  if (command === 'doctor') {
    const report = { node: process.version, platform: process.platform, dataDir: process.env.LATTICE_DATA_DIR ?? join(process.env.HOME ?? '', '.lattice'), transport: transport.mode, native: {} }
    output(report, flags, `node ${report.node}\nplatform ${report.platform}\ndata ${report.dataDir}\ntransport ${report.transport}`)
    return 0
  }
  if (command === 'completion') {
    const shell = args[0] ?? 'zsh'
    const words = CLI_COMMANDS.join(' ')
    const completion = shell === 'fish'
      ? `complete -c lattice -f -a '${words}'`
      : shell === 'bash'
        ? `_lattice_complete() { COMPREPLY=( $(compgen -W '${words}' -- "${'${COMP_WORDS[COMP_CWORD]}'}") ); }\ncomplete -F _lattice_complete lattice lat`
        : `#compdef lattice lat\n_lattice() { _arguments '1:command:(${words})'; }\n_lattice "$@"`
    output(completion, flags, completion)
    return 0
  }
  if (command === 'install') {
    const dir = argFlag(args, '--dir') ?? join(process.env.HOME ?? '', '.local/bin')
    const alias = argFlag(args, '--alias') ?? 'lat'
    const source = resolve(process.argv[1] ?? '')
    const target = join(dir, 'lattice')
    await mkdir(dir, { recursive: true })
    await symlink(source, target).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    if (alias && alias !== 'lattice') await symlink(source, join(dir, alias)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    })
    output({ path: target, alias: alias && alias !== 'lattice' ? join(dir, alias) : undefined }, flags, `installed ${target}${alias && alias !== 'lattice' ? ` and ${join(dir, alias)}` : ''}`)
    return 0
  }
  throw new Error(`unknown command: ${command}`)
}
