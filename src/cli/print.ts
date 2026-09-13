import type { PushEvent } from '@shared/ipc'
import type { RunEvent, RunEventBody, TurnTelemetry } from '@shared/types'
import type { BoundSession } from './session'
import type { LatticeTransport } from './transport/types'
import type { CliOutputFormat } from './args'

export interface PrintOptions {
  format: CliOutputFormat
  quiet?: boolean
  timeoutMs?: number
  maxTurns?: number
  askAnswer?: string
  verbose?: boolean
}

export interface PrintResult {
  ok: boolean
  threadId: string
  runId: string
  messageId: string
  text: string
  stopReason: 'done' | 'canceled' | 'error' | 'length'
  model: string
  mode: string
  preset: string
  turns: number
  toolCalls: Array<{ callId: string; tool: string; ok?: boolean; durationMs?: number; summary?: string }>
  files: Array<{ path: string; kind: string }>
  todos: unknown[]
  usage: TurnTelemetry & { costEstimated?: boolean; wallMs?: number; tps?: number }
  error: string | null
}

function emit(value: unknown): void {
  const envelope = value && typeof value === 'object' && !Array.isArray(value)
    ? { protocol: 1, ...(value as Record<string, unknown>) }
    : { protocol: 1, value }
  process.stdout.write(`${JSON.stringify(envelope)}\n`)
}

function addUsage(target: TurnTelemetry, usage: TurnTelemetry): void {
  for (const key of ['tokensIn', 'tokensOut', 'tokensReasoning', 'cacheReadTokens', 'cacheWriteTokens', 'toolMs', 'costUsd'] as const) {
    const value = usage[key]
    if (typeof value === 'number') target[key] = (target[key] ?? 0) + value
  }
  if (usage.ttftMs !== undefined) target.ttftMs = usage.ttftMs
  if (usage.wallMs !== undefined) target.wallMs = usage.wallMs
  if (usage.tps !== undefined) target.tps = usage.tps
  if (usage.route !== undefined) target.route = usage.route
  if (usage.estimated !== undefined) target.estimated = usage.estimated
}

function eventBodyText(body: RunEventBody): string | undefined {
  return body.type === 'error' ? body.message : body.type === 'text.delta' ? body.text : undefined
}

export async function runPrint(
  transport: LatticeTransport,
  session: BoundSession,
  prompt: string,
  options: PrintOptions
): Promise<{ result: PrintResult; exitCode: number }> {
  const toolCalls = new Map<string, { callId: string; tool: string; ok?: boolean; durationMs?: number; summary?: string }>()
  const usage: TurnTelemetry = {}
  let denial = false
  let errorText: string | null = null
  let stopReason: PrintResult['stopReason'] = 'error'
  let turns = 0
  let textDeltas = ''
  let completed = false

  // A run may have been parked before this client attached. Print mode cannot leave a promise
  // waiting for a human, so resolve any requests already in the broker before sending the new turn.
  for (const request of await transport.api.pendingApprovals()) {
    if (request.threadId !== session.thread.id) continue
    denial = true
    await transport.api.respondApproval({ requestId: request.id, effect: 'deny', scope: 'once' })
    if (options.format === 'stream-json') emit({ type: 'approval', request, decision: 'denied', reason: 'non-interactive print mode' })
  }
  for (const request of await transport.api.pendingAsks()) {
    if (request.threadId !== session.thread.id) continue
    const answer = options.askAnswer ?? ''
    await transport.api.respondAsk({ requestId: request.id, answer, canceled: !options.askAnswer })
    if (options.format === 'stream-json') emit({ type: 'ask', request, answered: !!options.askAnswer })
  }

  const send = await transport.api.send({
    threadId: session.thread.id,
    text: prompt,
    attachments: session.attachments.length ? session.attachments : undefined,
    model: session.thread.model,
    effort: session.thread.effort,
    disposition: 'send'
  })

  if (options.format === 'stream-json') {
    emit({
      type: 'session',
      protocol: 1,
      threadId: session.thread.id,
      runId: send.runId,
      model: session.thread.model,
      mode: session.thread.mode,
      preset: session.thread.permissionPreset,
      cwd: session.cwd
    })
  }

  const started = Date.now()
  const completion = (async (): Promise<void> => {
    for await (const push of transport.events) {
      if (push.kind === 'approval.request' && push.request.threadId === session.thread.id) {
        denial = true
        await transport.api.respondApproval({ requestId: push.request.id, effect: 'deny', scope: 'once' })
        if (options.format === 'stream-json') emit({ type: 'approval', request: push.request, decision: 'denied', reason: 'non-interactive print mode' })
        continue
      }
      if (push.kind === 'ask.request' && push.request.threadId === session.thread.id) {
        const answer = options.askAnswer ?? ''
        await transport.api.respondAsk({ requestId: push.request.id, answer, canceled: !options.askAnswer })
        if (options.format === 'stream-json') emit({ type: 'ask', request: push.request, answered: !!options.askAnswer })
        continue
      }
      if (push.kind !== 'run.event') continue
      const event = push.event
      if (event.threadId !== session.thread.id || event.runId !== send.runId || event.agent) continue
      if (options.format === 'stream-json') emit({ type: 'event', seq: event.seq, event })
      const body = event.body
      if (body.type === 'run.started') {
        // `run.started` identifies the durable run. Provider rounds are counted from the
        // round-marked usage events below, which is what --max-turns limits.
      } else if (body.type === 'text.delta') {
        textDeltas += body.text
      } else if (body.type === 'tool.proposed') {
        toolCalls.set(body.callId, { callId: body.callId, tool: body.tool })
      } else if (body.type === 'tool.started') {
        const row = toolCalls.get(body.callId) ?? { callId: body.callId, tool: body.tool }
        row.tool = body.tool
        toolCalls.set(body.callId, row)
      } else if (body.type === 'tool.result') {
        const row = toolCalls.get(body.callId) ?? { callId: body.callId, tool: body.tool }
        row.tool = body.tool
        row.ok = body.ok
        row.durationMs = body.durationMs
        if (typeof body.result === 'string') row.summary = body.result.replace(/\s+/g, ' ').slice(0, 160)
        toolCalls.set(body.callId, row)
        if (options.format === 'text' && !options.quiet) {
          process.stdout.write(`→ ${body.tool} ${body.ok ? '✓' : '✗'}${body.durationMs ? ` (${body.durationMs}ms)` : ''}\n`)
        }
      } else if (body.type === 'usage') {
        addUsage(usage, body.usage)
        if (body.usage.round) {
          turns += 1
          if (options.maxTurns !== undefined && turns >= options.maxTurns) {
            await transport.api.cancelRun(send.runId)
            stopReason = 'canceled'
          }
        }
      } else if (body.type === 'error') {
        errorText = body.message
      } else if (body.type === 'run.completed') {
        completed = true
        stopReason = body.reason
        break
      }
    }
  })()

  let timedOut = false
  const timer = options.timeoutMs === undefined
    ? undefined
    : setTimeout(() => { timedOut = true; void transport.api.cancelRun(send.runId) }, options.timeoutMs)
  if (timer) timer.unref?.()
  await Promise.race([
    completion,
    new Promise<void>((resolve) => {
      if (options.timeoutMs === undefined) return
      setTimeout(resolve, options.timeoutMs + 2_000).unref?.()
    })
  ])
  if (timer) clearTimeout(timer)
  if (timedOut && !completed) stopReason = 'canceled'
  if (!completed && !timedOut) {
    await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 2_000))])
    if (!completed) stopReason = 'canceled'
  }

  const thread = await transport.api.getThread(session.thread.id)
  const last = [...thread.messages].reverse().find((message) => message.role === 'assistant' && message.runId === send.runId)
  const text = last?.text ?? textDeltas
  const files = await transport.api.fileChanges(session.thread.id)
  const todos = await transport.api.listTodos(session.thread.id)
  const finalStopReason = stopReason as PrintResult['stopReason']
  const result: PrintResult = {
    ok: finalStopReason === 'done' && !denial && !errorText,
    threadId: session.thread.id,
    runId: send.runId,
    messageId: send.messageId,
    text,
    stopReason: finalStopReason,
    model: session.thread.model,
    mode: session.thread.mode,
    preset: session.thread.permissionPreset,
    turns,
    toolCalls: [...toolCalls.values()],
    files: files.map((file) => ({ path: file.path, kind: file.kind })),
    todos,
    usage: { ...usage, wallMs: Date.now() - started, costEstimated: usage.estimated ?? true },
    error: errorText
  }
  if (options.format === 'stream-json') emit({ type: 'result', ...result })
  else if (options.format === 'json') emit(result)
  else if (text) process.stdout.write(`${text.replace(/\s+$/, '')}\n`)
  return { result, exitCode: result.ok ? 0 : denial ? 5 : stopReason === 'canceled' ? 4 : 1 }
}
