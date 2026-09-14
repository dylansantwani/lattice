import { createInterface } from 'node:readline'
import type { ApprovalRequest, AskRequest, ApprovalScope } from '@shared/types'
import { SLASH_CATALOG } from '@shared/view/slashCatalog'
import type { BoundSession } from '../session'
import type { LatticeTransport } from '../transport/types'
import { sessionHeader } from '../session'

export interface InteractiveOptions {
  showThinking?: boolean
  plain?: boolean
  noSpinner?: boolean
  bell?: boolean
  force?: boolean
}

function question(rl: ReturnType<typeof createInterface>, prompt: string): Promise<string> {
  return new Promise((resolve) => rl.question(prompt, resolve))
}

function approvalPrompt(request: ApprovalRequest): string {
  const args = request.args && typeof request.args === 'object' ? request.args as Record<string, unknown> : {}
  const detail = typeof args.command === 'string'
    ? args.command
    : typeof args.path === 'string' ? args.path : request.summary
  return `\n⚠ ${request.tool} wants to ${request.action}: ${detail}\n[y] once  [a] run  [t] thread  [!] always  [n] deny: `
}

async function answerApproval(
  transport: LatticeTransport,
  request: ApprovalRequest,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  const answer = (await question(rl, approvalPrompt(request))).trim().toLowerCase()
  const scopes: Record<string, ApprovalScope> = { y: 'once', a: 'run', r: 'run', t: 'thread', '!': 'profile' }
  const effect = scopes[answer] ? 'allow' : 'deny'
  await transport.api.respondApproval({
    requestId: request.id,
    effect,
    scope: effect === 'allow' ? scopes[answer]! : 'once',
    ...(answer === '!' ? { saveRule: true } : {})
  })
}

async function answerAsk(
  transport: LatticeTransport,
  request: AskRequest,
  rl: ReturnType<typeof createInterface>
): Promise<void> {
  process.stdout.write(`\n? ${request.question}\n`)
  for (const [index, option] of (request.options ?? []).entries()) {
    process.stdout.write(`  ${index + 1}) ${option.label}${option.description ? ` — ${option.description}` : ''}\n`)
  }
  const answer = (await question(rl, request.options?.length ? 'answer (number or text): ' : 'answer: ')).trim()
  const numeric = Number.parseInt(answer, 10)
  const chosen = Number.isInteger(numeric) && numeric > 0 ? request.options?.[numeric - 1]?.label : undefined
  await transport.api.respondAsk({ requestId: request.id, answer: chosen ?? answer, canceled: !answer })
}

function closestSlashCommand(name: string): string | undefined {
  const candidate = SLASH_CATALOG
    .map((command) => command.name)
    .filter((command) => command.startsWith(name) || name.startsWith(command))
    .sort((a, b) => Math.abs(a.length - name.length) - Math.abs(b.length - name.length))[0]
  return candidate
}

async function handleSlashCommand(
  transport: LatticeTransport,
  session: BoundSession,
  text: string,
  rl: ReturnType<typeof createInterface>
): Promise<boolean> {
  const [, rawName = '', ...rest] = text.trim().split(/\s+/)
  const name = rawName.toLowerCase()
  const arg = rest.join(' ').trim()
  const command = SLASH_CATALOG.find((item) => item.name === name || item.aliases?.includes(name))
  if (!command) {
    const suggestion = closestSlashCommand(name)
    process.stdout.write(`Unknown command: /${name}${suggestion ? ` (try /${suggestion})` : ''}\n`)
    return true
  }
  const threadId = session.thread.id
  const update = async (patch: Parameters<LatticeTransport['api']['updateThread']>[1]): Promise<void> => {
    session.thread = await transport.api.updateThread(threadId, patch)
    rl.setPrompt(`${sessionHeader(session)}\n› `)
  }
  switch (command.name) {
    case 'new':
      session.thread = await transport.api.createThread({
        workspaceId: session.workspace.id,
        cwd: session.cwd,
        model: session.thread.model,
        effort: session.thread.effort,
        mode: session.thread.mode,
        permissionPreset: session.thread.permissionPreset
      })
      rl.setPrompt(`${sessionHeader(session)}\n› `)
      return true
    case 'clear': await transport.api.clearThread(threadId); return true
    case 'compact': await transport.api.compactThread(threadId); return true
    case 'goal':
      await update({ goal: arg || undefined })
      if (arg) await transport.api.send({ threadId, text: arg, disposition: 'send' }).then((result) => waitForRun(transport, threadId, result.runId, rl, {}))
      return true
    case 'system': await transport.api.setSettings({ customInstructions: arg }); return true
    case 'plan': await update({ mode: 'plan' }); return true
    case 'act': await update({ mode: 'act' }); return true
    case 'review': await update({ mode: 'review' }); return true
    case 'manual': await update({ permissionPreset: 'manual' }); return true
    case 'auto': await update({ permissionPreset: 'workspace' }); return true
    case 'full': await update({ permissionPreset: 'full' }); return true
    case 'model':
      if (!arg) { process.stdout.write(`${(await transport.api.listModels()).map((model) => model.id).join('\n')}\n`); return true }
      await update({ model: arg }); return true
    case 'think': if (arg) await update({ effort: arg }); return true
    case 'task': if (arg) await transport.api.upsertTodo({ threadId, title: arg }); return true
    case 'rename': if (arg) await update({ title: arg }); return true
    case 'pin': await update({ pinned: true }); return true
    case 'unpin': await update({ pinned: false }); return true
    case 'archive': await update({ archived: true }); return true
    case 'context': process.stdout.write(`${JSON.stringify(await transport.api.getContextBudget(threadId), null, 2)}\n`); return true
    case 'run': {
      const thread = await transport.api.getThread(threadId)
      for (const event of thread.events) if (event.body.type === 'text.delta') process.stdout.write(event.body.text)
      process.stdout.write('\n')
      return true
    }
    case 'tasks': process.stdout.write(`${JSON.stringify(await transport.api.listTodos(threadId), null, 2)}\n`); return true
    case 'memory': process.stdout.write(`${JSON.stringify(await transport.api.listMemory(), null, 2)}\n`); return true
    case 'mcp': process.stdout.write(`${JSON.stringify(await transport.api.listMcpServers(), null, 2)}\n`); return true
    case 'agents': process.stdout.write(`${JSON.stringify(await transport.api.listSessions(threadId), null, 2)}\n`); return true
    case 'settings': process.stdout.write(`${JSON.stringify(await transport.api.getSettings(), null, 2)}\n`); return true
    case 'side': {
      const child = await transport.api.forkThread(threadId, { titlePrefix: 'Side' })
      process.stdout.write(`forked ${child.id}\n`)
      if (arg) await transport.api.send({ threadId: child.id, text: arg, disposition: 'send' })
      return true
    }
    default:
      process.stdout.write(`/${command.name} is available in the desktop client; use a subcommand for its terminal view.\n`)
      return true
  }
}

export async function runInteractive(
  transport: LatticeTransport,
  session: BoundSession,
  initialPrompt?: string,
  options: InteractiveOptions = {}
): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true, prompt: `${sessionHeader(session)}\n› ` })
  const answerPending = async (): Promise<void> => {
    for (const request of await transport.api.pendingApprovals()) {
      if (request.threadId === session.thread.id) await answerApproval(transport, request, rl)
    }
    for (const request of await transport.api.pendingAsks()) {
      if (request.threadId === session.thread.id) await answerAsk(transport, request, rl)
    }
  }
  if (initialPrompt?.trim()) {
    await answerPending()
    const response = await transport.api.send({ threadId: session.thread.id, text: initialPrompt, disposition: 'send' })
    await waitForRun(transport, session.thread.id, response.runId, rl, options)
  }
  await answerPending()
  rl.prompt()
  for await (const line of rl) {
    const text = line.trimEnd()
    if (text === '/quit' || text === '/exit') {
      if (!options.force) {
        const runningJobs = (await transport.api.listJobs(session.thread.id)).filter((job) => job.running)
        if (runningJobs.length) {
          const action = transport.mode === 'embedded' ? 'Exit and stop them' : 'Exit and leave them running in the runtime'
          const answer = (await question(rl, `\n${runningJobs.length} background job(s) are still running. ${action}? [y/N] `)).trim().toLowerCase()
          if (answer !== 'y' && answer !== 'yes') { rl.prompt(); continue }
        }
      }
      break
    }
    if (!text) { rl.prompt(); continue }
    if (text.startsWith('#')) {
      const content = text.slice(1).trim()
      if (content) {
        await transport.api.upsertMemory({
          content,
          scope: 'workspace',
          scopeId: session.workspace.id,
          type: 'note',
          author: 'user',
          confidence: 1,
          sensitivity: 'normal',
          status: 'approved',
          pinned: false
        })
        process.stdout.write('saved to workspace memory\n')
      }
      rl.prompt()
      continue
    }
    if (text.startsWith('/')) {
      await handleSlashCommand(transport, session, text, rl)
      rl.prompt()
      continue
    }
    await answerPending()
    const response = await transport.api.send({ threadId: session.thread.id, text, disposition: 'send' })
    const streamed = await waitForRun(transport, session.thread.id, response.runId, rl, options)
    if (!streamed) {
      const thread = await transport.api.getThread(session.thread.id)
      const answer = [...thread.messages].reverse().find((message) => message.role === 'assistant' && message.runId === response.runId)
      if (answer?.text) process.stdout.write(`${answer.text}\n`)
    }
    rl.prompt()
  }
  rl.close()
  return 0
}

async function waitForRun(
  transport: LatticeTransport,
  threadId: string,
  runId: string,
  rl: ReturnType<typeof createInterface>,
  options: InteractiveOptions
): Promise<boolean> {
  let streamed = false
  for await (const event of transport.events) {
    if (event.kind === 'approval.request' && event.request.threadId === threadId) {
      await answerApproval(transport, event.request, rl)
      continue
    }
    if (event.kind === 'ask.request' && event.request.threadId === threadId) {
      await answerAsk(transport, event.request, rl)
      continue
    }
    if (event.kind !== 'run.event' || event.event.threadId !== threadId || event.event.runId !== runId || event.event.agent) continue
    const body = event.event.body
    if (body.type === 'text.delta') {
      streamed = true
      process.stdout.write(body.text)
    } else if (body.type === 'reasoning.delta' && options.showThinking) {
      process.stdout.write(options.plain ? `thinking: ${body.text}` : `\u001b[2m${body.text}\u001b[0m`)
    } else if (body.type === 'tool.drafting') {
      process.stdout.write(`\n… preparing ${body.tool ?? 'tool'}\n`)
    } else if (body.type === 'tool.progress' && !options.plain) {
      const tail = body.output.split('\n').slice(-1)[0]?.trim()
      if (tail) process.stdout.write(`\n→ ${body.callId.slice(-6)} ${tail}\n`)
    } else if (body.type === 'tool.result') {
      process.stdout.write(`\n→ ${body.tool} ${body.ok ? '✓' : '✗'}\n`)
    } else if (body.type === 'run.completed') {
      if (streamed) process.stdout.write('\n')
      if (options.bell) process.stdout.write('\u0007')
      return streamed
    }
  }
  return streamed
}

export * from './ansi'
export * from './diff'
export * from './frame'
export * from './markdown'
export * from './transcript'
