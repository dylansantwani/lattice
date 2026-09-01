import { ulid } from '@shared/id'
import type {
  ChatMessage,
  ContextBudget,
  ErrorCategory,
  ModelInfo,
  ProviderConfig,
  RunEventBody,
  RunId,
  SendOptions,
  ThreadId,
  ThreadMeta,
  TurnTelemetry
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import {
  appendEvent,
  getSettings,
  getThreadMeta,
  insertMessage,
  listMemory,
  listMessages,
  updateMessage,
  updateThread
} from '../store/eventStore'
import { fetchModels } from '../providers/registry'
import { ProviderHttpError, streamChat, type WireMessage } from '../providers/openaiCompat'

type PushFn = (event: PushEvent) => void

interface ActiveRun {
  runId: RunId
  threadId: ThreadId
  abort: AbortController
  /** messages waiting to be injected at the next safe boundary */
  steerQueue: SendOptions[]
  /** full turns queued to start after this run completes */
  turnQueue: SendOptions[]
  assistantMessageId: string
}

const active = new Map<ThreadId, ActiveRun>()

export function isRunning(threadId: ThreadId): boolean {
  return active.has(threadId)
}

export function cancelRun(runId: RunId): void {
  for (const run of active.values()) {
    if (run.runId === runId) {
      run.abort.abort()
      return
    }
  }
}

/** Entry point for the composer. Routes to start / steer / queue. */
export async function send(opts: SendOptions, push: PushFn): Promise<{ runId: RunId; messageId: string }> {
  const running = active.get(opts.threadId)
  if (running && opts.disposition === 'steer') {
    running.steerQueue.push(opts)
    const msg = persistUserMessage(opts, running.runId)
    push({ kind: 'message.updated', message: msg })
    appendEvent(running.runId, opts.threadId, { type: 'steer.injected', messageId: msg.id })
    return { runId: running.runId, messageId: msg.id }
  }
  if (running) {
    // queue (default while running)
    running.turnQueue.push(opts)
    const msg = persistUserMessage(opts)
    push({ kind: 'message.updated', message: msg })
    return { runId: running.runId, messageId: msg.id }
  }
  const msg = persistUserMessage(opts)
  push({ kind: 'message.updated', message: msg })
  const runId = await startRun(opts.threadId, opts, push)
  return { runId, messageId: msg.id }
}

function persistUserMessage(opts: SendOptions, runId?: RunId): ChatMessage {
  const msg: ChatMessage = {
    id: ulid(),
    threadId: opts.threadId,
    runId,
    role: 'user',
    createdAt: Date.now(),
    text: opts.text,
    attachments: opts.attachments
  }
  insertMessage(msg)
  return msg
}

async function startRun(threadId: ThreadId, opts: SendOptions, push: PushFn): Promise<RunId> {
  const meta = getThreadMeta(threadId)
  if (!meta) throw new Error(`thread not found: ${threadId}`)
  const runId = ulid()
  const abort = new AbortController()
  const assistantMessageId = ulid()
  const run: ActiveRun = { runId, threadId, abort, steerQueue: [], turnQueue: [], assistantMessageId }
  active.set(threadId, run)

  const model = opts.model ?? meta.model
  const effort = opts.effort ?? meta.effort

  push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  void executeRun(run, meta, model, effort, push).finally(() => {
    active.delete(threadId)
    const fresh = getThreadMeta(threadId)
    if (fresh) push({ kind: 'thread.updated', meta: { ...fresh, running: false } })
    // start next queued turn, if any
    const next = run.turnQueue.shift()
    if (next) {
      // queued message is already persisted; start a run that consumes existing history
      void startRunFromHistory(threadId, next, run.turnQueue, push)
    }
  })
  return runId
}

async function startRunFromHistory(
  threadId: ThreadId,
  opts: SendOptions,
  remainingQueue: SendOptions[],
  push: PushFn
): Promise<void> {
  const meta = getThreadMeta(threadId)
  if (!meta) return
  const runId = ulid()
  const run: ActiveRun = {
    runId,
    threadId,
    abort: new AbortController(),
    steerQueue: [],
    turnQueue: remainingQueue,
    assistantMessageId: ulid()
  }
  active.set(threadId, run)
  push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  void executeRun(run, meta, opts.model ?? meta.model, opts.effort ?? meta.effort, push).finally(() => {
    active.delete(threadId)
    const fresh = getThreadMeta(threadId)
    if (fresh) push({ kind: 'thread.updated', meta: { ...fresh, running: false } })
    const next = run.turnQueue.shift()
    if (next) void startRunFromHistory(threadId, next, run.turnQueue, push)
  })
}

async function executeRun(
  run: ActiveRun,
  meta: ThreadMeta,
  model: string,
  effort: string | undefined,
  push: PushFn
): Promise<void> {
  const { runId, threadId } = run
  const emit = (body: RunEventBody): void => {
    const ev = appendEvent(runId, threadId, body)
    push({ kind: 'run.event', event: ev })
  }

  emit({ type: 'run.started', model, effort, mode: meta.mode })

  const assistant: ChatMessage = {
    id: run.assistantMessageId,
    threadId,
    runId,
    role: 'assistant',
    createdAt: Date.now(),
    text: '',
    model,
    effort
  }
  insertMessage(assistant)
  push({ kind: 'message.updated', message: assistant })

  const provider = resolveProvider()
  if (!provider) {
    emit({
      type: 'error',
      category: 'auth',
      message: 'No provider configured. Add OmniRoute in Settings → Providers.',
      retryable: false
    })
    finalize(run, assistant, 'error', {}, push)
    emit({ type: 'run.completed', reason: 'error' })
    return
  }

  const start = Date.now()
  let firstTokenAt: number | undefined
  let text = ''
  let reasoning = ''
  let usage: Partial<TurnTelemetry> = {}
  let finishReason = 'stop'
  let errored = false
  let flushTimer: NodeJS.Timeout | null = null

  const flush = (): void => {
    const updated = updateMessage(assistant.id, { text })
    if (updated) push({ kind: 'message.updated', message: updated })
  }
  const scheduleFlush = (): void => {
    if (flushTimer) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      flush()
    }, 80)
  }

  try {
    // loop supports mid-run steering: after a completed response, if steer messages
    // arrived, append them and continue with another model call.
    let continueLoop = true
    while (continueLoop) {
      continueLoop = false
      const wire = buildWireMessages(threadId, meta)
      let reasoningDeltaBuf = ''
      let textDeltaBuf = ''
      let lastEventFlush = Date.now()

      for await (const chunk of streamChat(provider, {
        model,
        messages: wire,
        effort,
        signal: run.abort.signal
      })) {
        if (chunk.type === 'text') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          text += chunk.text
          textDeltaBuf += chunk.text
          scheduleFlush()
        } else if (chunk.type === 'reasoning') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          reasoning += chunk.text
          reasoningDeltaBuf += chunk.text
        } else if (chunk.type === 'usage') {
          usage = { ...usage, ...chunk.usage }
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason
        }
        // coalesce deltas into periodic persisted events (not per-token)
        if (Date.now() - lastEventFlush > 750 || textDeltaBuf.length + reasoningDeltaBuf.length > 4000) {
          if (reasoningDeltaBuf) {
            emit({ type: 'reasoning.delta', text: reasoningDeltaBuf, fidelity: 'raw' })
            reasoningDeltaBuf = ''
          }
          if (textDeltaBuf) {
            emit({ type: 'text.delta', text: textDeltaBuf })
            textDeltaBuf = ''
          }
          lastEventFlush = Date.now()
        }
      }
      if (reasoningDeltaBuf) emit({ type: 'reasoning.delta', text: reasoningDeltaBuf, fidelity: 'raw' })
      if (textDeltaBuf) emit({ type: 'text.delta', text: textDeltaBuf })
      if (reasoning) emit({ type: 'reasoning.done', fidelity: 'raw' })

      // safe boundary: model response completed. Inject pending steers and continue.
      if (run.steerQueue.length > 0 && !run.abort.signal.aborted) {
        run.steerQueue.length = 0 // steer messages are already in the persisted history
        // finalize current partial as its own assistant turn, then continue with new msg
        continueLoop = true
        flush()
      }
    }
  } catch (err) {
    if (run.abort.signal.aborted) {
      emit({ type: 'run.completed', reason: 'canceled' })
      finalize(run, assistant, 'interrupted', computeTelemetry(start, firstTokenAt, text, usage, model), push, text)
      return
    }
    errored = true
    const { category, message, retryable } = classifyError(err)
    emit({ type: 'error', category, message, retryable, detail: err instanceof Error ? (err.stack ?? '') : String(err) })
  }

  if (flushTimer) clearTimeout(flushTimer)
  const telemetry = computeTelemetry(start, firstTokenAt, text, usage, model)
  emit({ type: 'usage', usage: telemetry })
  emit({ type: 'run.completed', reason: errored ? 'error' : finishReason === 'length' ? 'length' : 'done' })
  finalize(run, assistant, errored ? 'error' : 'complete', telemetry, push, text)

  // auto-title new threads from the first user message
  const msgs = listMessages(threadId)
  if (meta.title === 'New thread') {
    const firstUser = msgs.find((m) => m.role === 'user')
    if (firstUser) {
      const title = firstUser.text.replace(/\s+/g, ' ').slice(0, 60) || 'New thread'
      const updated = updateThread(threadId, { title })
      push({ kind: 'thread.updated', meta: updated })
    }
  }
}

function finalize(
  run: ActiveRun,
  assistant: ChatMessage,
  status: 'complete' | 'interrupted' | 'error',
  telemetry: TurnTelemetry,
  push: PushFn,
  text?: string
): void {
  const updated = updateMessage(assistant.id, { text: text ?? assistant.text, status, telemetry })
  if (updated) push({ kind: 'message.updated', message: updated })
}

function computeTelemetry(
  start: number,
  firstTokenAt: number | undefined,
  text: string,
  usage: Partial<TurnTelemetry>,
  route: string
): TurnTelemetry {
  const wallMs = Date.now() - start
  const ttftMs = firstTokenAt ? firstTokenAt - start : undefined
  const tokensOut = usage.tokensOut ?? Math.round(text.length / 4)
  const genMs = firstTokenAt ? Date.now() - firstTokenAt : wallMs
  return {
    ...usage,
    wallMs,
    ttftMs,
    modelMs: genMs,
    tokensOut,
    tps: genMs > 200 ? +(tokensOut / (genMs / 1000)).toFixed(1) : undefined,
    estimated: usage.tokensOut === undefined,
    route
  }
}

function resolveProvider(): ProviderConfig | null {
  const settings = getSettings()
  return settings.providers.find((p) => p.enabled) ?? null
}

/** Assemble the request: stable system prefix → curated memory → history. */
function buildWireMessages(threadId: ThreadId, meta: ThreadMeta): WireMessage[] {
  const wire: WireMessage[] = []
  const memories = listMemory().filter(
    (m) => m.status === 'approved' && (m.scope === 'user' || m.scope === 'workspace')
  )
  let system = SYSTEM_PROMPT
  if (meta.mode === 'plan') system += '\n\n' + PLAN_MODE_SUFFIX
  if (meta.mode === 'review') system += '\n\n' + REVIEW_MODE_SUFFIX
  if (memories.length) {
    system +=
      '\n\n# Memory\n' + memories.map((m) => `- [${m.type}] ${m.content}`).join('\n')
  }
  wire.push({ role: 'system', content: system })

  for (const msg of listMessages(threadId)) {
    if (msg.role === 'user') {
      if (msg.attachments?.length) {
        const parts: WireMessage['content'] = [{ type: 'text', text: msg.text }]
        for (const att of msg.attachments) {
          if (att.kind === 'image' && att.content) {
            ;(parts as Exclude<WireMessage['content'], string | null>).push({
              type: 'image_url',
              image_url: { url: att.content }
            })
          } else if (att.kind === 'text' && att.content) {
            ;(parts as Exclude<WireMessage['content'], string | null>).push({
              type: 'text',
              text: `\n\n<attachment name="${att.name}">\n${att.content}\n</attachment>`
            })
          }
        }
        wire.push({ role: 'user', content: parts })
      } else {
        wire.push({ role: 'user', content: msg.text })
      }
    } else if (msg.role === 'assistant' && msg.text) {
      wire.push({ role: 'assistant', content: msg.text })
    }
  }
  return wire
}

const SYSTEM_PROMPT = `You are Lattice, a capable assistant running inside a local-first desktop control room for agentic work. Answer in well-structured GitHub-flavored Markdown. Be direct and technically precise.`

const PLAN_MODE_SUFFIX = `The user has Plan mode active: investigate and propose a plan, but do not perform mutating actions. Present a concrete plan for approval.`
const REVIEW_MODE_SUFFIX = `The user has Review mode active: inspect and assess changes, tests, and risks. Do not make new edits.`

function classifyError(err: unknown): { category: ErrorCategory; message: string; retryable: boolean } {
  if (err instanceof ProviderHttpError) {
    if (err.status === 401 || err.status === 403)
      return { category: 'auth', message: 'Authentication failed for the provider.', retryable: false }
    if (err.status === 429)
      return { category: 'rate_limit', message: 'Rate limited by the provider.', retryable: true }
    if (err.status === 400 && /context|token|length/i.test(err.body))
      return { category: 'context_overflow', message: 'The request exceeded the model context window.', retryable: false }
    if (err.status >= 500)
      return { category: 'provider_unavailable', message: `Provider error (HTTP ${err.status}).`, retryable: true }
    return { category: 'unknown', message: `Provider rejected the request (HTTP ${err.status}).`, retryable: false }
  }
  if (err instanceof Error && err.name === 'AbortError')
    return { category: 'canceled', message: 'Run canceled.', retryable: false }
  if (err instanceof Error && /fetch failed|ECONNREFUSED|ENOTFOUND/i.test(err.message))
    return { category: 'provider_unavailable', message: 'Could not reach the provider endpoint.', retryable: true }
  return { category: 'unknown', message: err instanceof Error ? err.message : String(err), retryable: true }
}

// ---------- context budget ----------

export function getContextBudget(threadId: ThreadId, models: ModelInfo[]): ContextBudget | null {
  const meta = getThreadMeta(threadId)
  if (!meta) return null
  const model = models.find((m) => m.id === meta.model)
  const contextLength = model?.contextLength ?? 128000
  const maxOut = Math.min(model?.maxOutputTokens ?? 16384, Math.floor(contextLength * 0.25))

  const est = (s: string): number => Math.ceil(s.length / 4)
  const memories = listMemory().filter((m) => m.status === 'approved')
  const systemTokens = est(SYSTEM_PROMPT) + memories.reduce((a, m) => a + est(m.content), 0)
  const history = listMessages(threadId).reduce(
    (a, m) => a + est(m.text) + (m.attachments?.reduce((b, at) => b + est(at.content ?? ''), 0) ?? 0),
    0
  )
  const safety = Math.floor(contextLength * 0.02)
  const used = systemTokens + history + maxOut + safety
  const usable = contextLength
  return {
    model: meta.model,
    contextLength,
    segments: {
      system: systemTokens,
      tools: 0,
      history,
      injected: 0,
      outputReserve: maxOut,
      safety
    },
    usedTokens: used,
    usableTokens: usable,
    occupancy: Math.min(1, used / usable),
    exact: false
  }
}
