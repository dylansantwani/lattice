import { ulid } from '@shared/id'
import type {
  ChatMessage,
  ContextBudget,
  ErrorCategory,
  ModelInfo,
  CompactResult,
  ProviderConfig,
  RunEventBody,
  MessageId,
  RunId,
  SendOptions,
  ThreadId,
  ThreadMeta,
  TurnTelemetry
} from '@shared/types'
import type { PushEvent } from '@shared/ipc'
import {
  appendEvent,
  createThread,
  getCachedModels,
  getSettings,
  getThreadMeta,
  deleteMessage,
  insertMessage,
  listEvents,
  listMemory,
  listMessages,
  listWorkspaces,
  markMessagesCompacted,
  updateMessage,
  updateThread
} from '../store/eventStore'
import { ProviderHttpError, streamChat, type WireMessage } from '../providers/openaiCompat'
import { builtinTools, isPathInsideRoots, resolveToolPath } from '../tools/builtin'
import { mcpTools } from '../mcp/manager'
import type { AgentsApi, SubagentSpec, ToolDefinition } from '../tools/types'
import {
  collect as collectSubagent,
  enqueueMessage,
  listForRun,
  nextMessage,
  registerSubagent,
  resolveRef,
  setStatus,
  stop as stopSubagent,
  stopAllForRun,
  suggestName,
  toView,
  type SubagentRecord
} from './subagents'
import { isGranted, requestApproval } from './approvals'
import { requestAsk } from './asks'
import type { ApprovalRequest, AskRequest } from '@shared/types'
import type { AskSpec } from '../tools/types'

type PushFn = (event: PushEvent) => void

/** A turn composed while a run was active, waiting to start once the run(s) ahead of it finish. */
interface QueuedTurn {
  opts: SendOptions
  /** id of the already-persisted user message, so it can be edited or removed while it waits */
  messageId: MessageId
}

interface ActiveRun {
  runId: RunId
  threadId: ThreadId
  abort: AbortController
  /** messages waiting to be injected at the next safe boundary */
  steerQueue: SendOptions[]
  /** full turns queued to start after this run completes */
  turnQueue: QueuedTurn[]
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

/** Abort whatever run (if any) is active on a thread. Used by /clear before wiping history. */
export function cancelRunForThread(threadId: ThreadId): void {
  active.get(threadId)?.abort.abort()
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
    // queue (default while running): persist now, marked queued, so it shows in the transcript
    // as a pending turn the user can still edit or remove until its run starts.
    const msg = persistUserMessage(opts, undefined, true)
    running.turnQueue.push({ opts, messageId: msg.id })
    push({ kind: 'message.updated', message: msg })
    return { runId: running.runId, messageId: msg.id }
  }
  const msg = persistUserMessage(opts)
  push({ kind: 'message.updated', message: msg })
  const runId = await startRun(opts.threadId, opts, push)
  return { runId, messageId: msg.id }
}

/**
 * Remove a turn that is still waiting in the queue. Returns false if it is not (or no longer) queued —
 * e.g. its run already started, or the run ahead of it completed between compose and this call.
 */
export function dequeueMessage(threadId: ThreadId, messageId: MessageId, push: PushFn): boolean {
  const run = active.get(threadId)
  if (!run) return false
  const idx = run.turnQueue.findIndex((t) => t.messageId === messageId)
  if (idx < 0) return false
  run.turnQueue.splice(idx, 1)
  deleteMessage(messageId)
  push({ kind: 'message.deleted', threadId, messageId })
  return true
}

/**
 * Edit the text of a turn still waiting in the queue. Returns the updated message, or null if it is
 * not (or no longer) queued. Both the pending run options and the persisted message are updated.
 */
export function editQueuedMessage(
  threadId: ThreadId,
  messageId: MessageId,
  text: string,
  push: PushFn
): ChatMessage | null {
  const run = active.get(threadId)
  if (!run) return null
  const entry = run.turnQueue.find((t) => t.messageId === messageId)
  if (!entry) return null
  entry.opts = { ...entry.opts, text }
  const msg = updateMessage(messageId, { text })
  if (msg) push({ kind: 'message.updated', message: msg })
  return msg
}

function persistUserMessage(opts: SendOptions, runId?: RunId, queued = false): ChatMessage {
  const msg: ChatMessage = {
    id: ulid(),
    threadId: opts.threadId,
    runId,
    role: 'user',
    createdAt: Date.now(),
    text: opts.text,
    attachments: opts.attachments,
    queued
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
    stopAllForRun(run.runId) // tear down any subagents this run spawned
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
  turn: QueuedTurn,
  remainingQueue: QueuedTurn[],
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
  // The turn is starting now: clear its queued flag and bind it to this run so the transcript
  // renders it as a normal sent message (no longer editable/removable).
  const started = updateMessage(turn.messageId, { queued: false, runId })
  if (started) push({ kind: 'message.updated', message: started })
  push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  void executeRun(run, meta, turn.opts.model ?? meta.model, turn.opts.effort ?? meta.effort, push).finally(() => {
    stopAllForRun(run.runId) // tear down any subagents this run spawned
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
  let toolMs = 0
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
    // Send whatever tools the current mode/preset permits. We intentionally do NOT
    // gate on provider-reported capability metadata: gateways frequently omit or
    // misreport `tools`, which silently disabled tool calls. Capable models pick them
    // up; models that genuinely can't will just never emit a tool call.
    const tools = availableTools(meta)
    // One line per run so "did the model actually get run_agent / ask_user?" is an
    // observable fact in the main-process log, not a guess. If a tool you expect is
    // missing here, the main process is serving stale code (electron-vite only HMRs
    // the renderer — restart `npm run dev` to reload main) or the mode/preset denied it.
    console.error(
      `[run ${runId}] ${meta.mode}/${meta.permissionPreset} → ${tools.length} tools: ${tools
        .map((t) => t.name)
        .join(', ')}`
    )
    const wire = buildWireMessages(threadId, meta, model, effort)
    // Runaway-loop guard. 0 (or negative) disables the cap entirely — a legitimate
    // multi-step task (e.g. a tool sequence that ends in sending an email) is not
    // artificially cut short. Set a positive value in Settings to re-impose a ceiling.
    const maxToolRounds = getSettings().maxToolRounds ?? 0
    const sampling = samplingParams()
    let toolRounds = 0

    // A run can span multiple provider calls: tool results and steers are appended
    // to the in-memory wire transcript, then the model continues from that state.
    let continueLoop = true
    while (continueLoop) {
      continueLoop = false
      let reasoningDeltaBuf = ''
      let textDeltaBuf = ''
      let responseText = ''
      let lastEventFlush = Date.now()
      const pendingCalls = new Map<number, { id: string; name: string; args: string }>()

      for await (const chunk of streamChat(provider, {
        model,
        messages: wire,
        tools: tools.map(toWireTool),
        effort,
        ...sampling,
        cache: provider.promptCaching ?? false,
        signal: run.abort.signal
      })) {
        if (chunk.type === 'text') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          text += chunk.text
          responseText += chunk.text
          textDeltaBuf += chunk.text
          scheduleFlush()
        } else if (chunk.type === 'reasoning') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          reasoning += chunk.text
          reasoningDeltaBuf += chunk.text
        } else if (chunk.type === 'usage') {
          usage = mergeUsage(usage, chunk.usage)
        } else if (chunk.type === 'tool_call_delta') {
          const call = pendingCalls.get(chunk.index) ?? { id: '', name: '', args: '' }
          if (chunk.id) call.id = chunk.id
          if (chunk.name) call.name += chunk.name
          if (chunk.argsDelta) call.args += chunk.argsDelta
          pendingCalls.set(chunk.index, call)
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

      if (pendingCalls.size > 0 && !run.abort.signal.aborted) {
        toolRounds += 1
        if (maxToolRounds > 0 && toolRounds > maxToolRounds)
          throw new Error(`Tool loop stopped after ${maxToolRounds} rounds.`)
        const calls = [...pendingCalls.entries()]
          .sort(([a], [b]) => a - b)
          .map(([, call], index) => ({
            id: call.id || `call_${runId}_${toolRounds}_${index}`,
            type: 'function' as const,
            function: { name: call.name, arguments: call.args || '{}' }
          }))
        wire.push({ role: 'assistant', content: responseText || null, tool_calls: calls })

        // Execute the batch concurrently — a model that asks for several reads/searches at
        // once shouldn't pay for them serially. Results are appended in call order so the
        // wire transcript stays deterministic regardless of completion order.
        const batchStart = Date.now()
        const agents = makeAgentsApi(run, meta, push)
        const results = await Promise.all(
          calls.map((call) =>
            executeToolCall(call.id, call.function.name, call.function.arguments, run, meta, emit, push, agents)
          )
        )
        toolMs += Date.now() - batchStart
        calls.forEach((call, i) => {
          wire.push({
            role: 'tool',
            tool_call_id: call.id,
            name: call.function.name,
            content: JSON.stringify(results[i])
          })
        })
        continueLoop = true
        continue
      }

      // safe boundary: model response completed. Inject pending steers and continue.
      if (run.steerQueue.length > 0 && !run.abort.signal.aborted) {
        run.steerQueue.length = 0 // steer messages are already in the persisted history
        wire.splice(0, wire.length, ...buildWireMessages(threadId, meta, model, effort))
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
  const telemetry = { ...computeTelemetry(start, firstTokenAt, text, usage, model), toolMs: toolMs || undefined }
  emit({ type: 'usage', usage: telemetry })
  emit({ type: 'run.completed', reason: errored ? 'error' : finishReason === 'length' ? 'length' : 'done' })
  finalize(run, assistant, errored ? 'error' : 'complete', telemetry, push, text)

  // auto-title new threads with a model-written summary of the first exchange,
  // falling back to the trimmed first user message if the summary call fails.
  const msgs = listMessages(threadId)
  if (meta.title === 'New thread' && !errored) {
    const firstUser = msgs.find((m) => m.role === 'user')
    if (firstUser) {
      const fallback = firstUser.text.replace(/\s+/g, ' ').slice(0, 60) || 'New thread'
      const summary = await generateTitle(model, effort, firstUser.text, text)
      const title = summary || fallback
      if (title !== 'New thread' && getThreadMeta(threadId)?.title === 'New thread') {
        const updated = updateThread(threadId, { title })
        push({ kind: 'thread.updated', meta: updated })
      }
    }
  }
}

/**
 * Ask the model for a short, human-readable title summarizing the opening exchange.
 * Reuses the run's own `effort` rather than forcing a reasoning tier: a non-reasoning
 * model (e.g. qwen3-coder) rejects any `reasoning_effort` with an HTTP 400, which would
 * make this call throw and silently fall back to the raw first message. The run we just
 * finished already succeeded with this exact (model, effort) pair, so it is safe here.
 */
async function generateTitle(
  model: string,
  effort: string | undefined,
  userText: string,
  assistantText: string
): Promise<string | null> {
  const provider = resolveProvider()
  if (!provider) return null
  const prompt =
    'Write a short, specific title (3–6 words, Title Case) summarizing this conversation. ' +
    'Reply with only the title — no quotes, no trailing punctuation, no preamble.\n\n' +
    `User: ${userText.slice(0, 2000)}\n\n` +
    `Assistant: ${assistantText.slice(0, 1500)}\n\nTitle:`
  let out = ''
  try {
    for await (const chunk of streamChat(provider, {
      model,
      messages: [{ role: 'user', content: prompt }],
      tools: [],
      effort,
      cache: false,
      signal: AbortSignal.timeout(15000)
    })) {
      if (chunk.type === 'text') out += chunk.text
      if (out.length > 160) break
    }
  } catch {
    return null
  }
  return cleanTitle(out)
}

/** Normalize model output into a single clean title line. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.length > 0)
  if (!line) return null
  const cleaned = line
    .replace(/^title\s*[:\-–]\s*/i, '') // drop a leading "Title:" the model sometimes emits
    .replace(/^["'`*]+|["'`*]+$/g, '') // surrounding quotes/backticks/asterisks
    .replace(/[.]+$/, '') // trailing period(s)
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned ? cleaned.slice(0, 70) : null
}

/** The concurrent-subagent control surface handed to a top-level run's tools. */
function makeAgentsApi(parent: ActiveRun, meta: ThreadMeta, push: PushFn): AgentsApi {
  return {
    spawn: (spec) => spawnSubagentConcurrent(parent, meta, spec, push),
    message: (ref, text) => enqueueMessage(parent.runId, ref, text),
    collect: (ref, wait) => collectSubagent(parent.runId, ref, wait),
    list: () => listForRun(parent.runId).map(toView),
    stop: (ref) => stopSubagent(parent.runId, ref)
  }
}

/**
 * Spawn a subagent in the BACKGROUND and return its handle immediately. The agentic loop runs
 * concurrently (tracked via the registry, torn down with the parent run), so the parent model
 * keeps working and can later message/collect/stop it. The subagent's abort is a child of the
 * parent's, so cancelling the run cancels the fleet.
 */
function spawnSubagentConcurrent(
  parent: ActiveRun,
  meta: ThreadMeta,
  spec: SubagentSpec,
  push: PushFn
): { agentId: string; name: string; status: string } {
  const agentId = ulid()
  const name = suggestName(parent.runId, spec.name ?? spec.agentType)
  const abort = new AbortController()
  if (parent.abort.signal.aborted) abort.abort()
  else parent.abort.signal.addEventListener('abort', () => abort.abort(), { once: true })
  const record = registerSubagent({
    agentId,
    name,
    parentRunId: parent.runId,
    threadId: parent.threadId,
    task: spec.task,
    model: spec.model ?? meta.model,
    abort
  })
  void runSubagentLoop(parent, meta, spec, push, record).catch((err) => {
    console.error(`[subagent ${name}] loop crashed:`, err)
  })
  return { agentId, name, status: 'running' }
}

/**
 * The concurrent subagent loop. Runs as a background task inside the parent run: it emits its own
 * events (tagged with the subagent's agentId) into the same transcript, starts from a clean
 * context (only its task), and — crucially — does NOT return its answer to a blocked caller.
 * Instead it settles to `idle` at each safe boundary and parks, waiting for the parent to
 * `message_agent` it (which appends a new user turn and resumes) or `stop_agent`/end the run
 * (which aborts it). Its accumulated output lives on the registry record for `collect_agent`.
 */
async function runSubagentLoop(
  parent: ActiveRun,
  meta: ThreadMeta,
  spec: SubagentSpec,
  push: PushFn,
  record: SubagentRecord
): Promise<void> {
  const agentId = record.agentId
  const { runId, threadId } = parent
  const signal = record.abort.signal
  const emit = (body: RunEventBody): void => {
    const ev = appendEvent(runId, threadId, body, agentId)
    push({ kind: 'run.event', event: ev })
  }
  // Update the record's status and mirror it into the event stream for the UI.
  const status = (s: SubagentRecord['status']): void => {
    setStatus(record, s)
    emit({ type: 'agent.status', status: s, name: record.name })
  }

  const provider = resolveProvider()
  const model = spec.model ?? meta.model
  const effort = spec.effort ?? meta.effort

  // Subagents cannot manage other agents, and run headless so they cannot ask the user; those
  // tools are stripped. When the parent passed a `tools` allowlist, the set is narrowed to it.
  const tools = subagentTools(meta, spec.tools)
  const toolNames = tools.map((t) => t.name)
  emit({
    type: 'run.started',
    model,
    effort,
    mode: meta.mode,
    parentAgent: parent.runId,
    tools: toolNames,
    agentName: record.name
  })
  console.error(
    `[subagent ${record.name} ${agentId.slice(0, 8)}] ${meta.mode}/${meta.permissionPreset} → ${toolNames.length} tools: ${toolNames.join(', ')}`
  )

  if (!provider) {
    emit({ type: 'error', category: 'auth', message: 'No provider configured for the subagent.', retryable: false })
    emit({ type: 'run.completed', reason: 'error' })
    status('error')
    return
  }

  const role = spec.agentType
    ? `You are acting as the "${spec.agentType}" subagent named "${record.name}".`
    : `You are a subagent named "${record.name}".`
  const identity = describeActiveModel(model, effort)
  const system = `${SUBAGENT_PROMPT}\n\n${role}${identity ? '\n\n' + identity : ''}`
  const wire: WireMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: spec.task }
  ]
  // Give the subagent's tool calls the subagent's OWN abort (so stop_agent stops just this one),
  // while keeping the parent run's id/thread for event tagging and workspace resolution.
  const subRun: ActiveRun = { ...parent, abort: record.abort }

  const start = Date.now()
  let firstTokenAt: number | undefined
  let text = ''
  let usage: Partial<TurnTelemetry> = {}
  const maxSubagentToolRounds = getSettings().maxSubagentToolRounds ?? 0
  const sampling = samplingParams()
  let rounds = 0
  let settledOnce = false

  try {
    status('running')
    let alive = true
    while (alive && !signal.aborted) {
      // ---- inner agentic loop: stream → tools → repeat until the model settles ----
      let continueLoop = true
      while (continueLoop && !signal.aborted) {
        continueLoop = false
        let responseText = ''
        let textBuf = ''
        let reasoningBuf = ''
        let lastFlush = Date.now()
        const pendingCalls = new Map<number, { id: string; name: string; args: string }>()

        for await (const chunk of streamChat(provider, {
          model,
          messages: wire,
          tools: tools.map(toWireTool),
          effort,
          ...sampling,
          cache: provider.promptCaching ?? false,
          signal
        })) {
          if (chunk.type === 'text') {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            text += chunk.text
            responseText += chunk.text
            textBuf += chunk.text
          } else if (chunk.type === 'reasoning') {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            reasoningBuf += chunk.text
          } else if (chunk.type === 'usage') {
            usage = mergeUsage(usage, chunk.usage)
          } else if (chunk.type === 'tool_call_delta') {
            const call = pendingCalls.get(chunk.index) ?? { id: '', name: '', args: '' }
            if (chunk.id) call.id = chunk.id
            if (chunk.name) call.name += chunk.name
            if (chunk.argsDelta) call.args += chunk.argsDelta
            pendingCalls.set(chunk.index, call)
          }
          if (Date.now() - lastFlush > 750 || textBuf.length + reasoningBuf.length > 4000) {
            if (reasoningBuf) {
              emit({ type: 'reasoning.delta', text: reasoningBuf, fidelity: 'raw' })
              reasoningBuf = ''
            }
            if (textBuf) {
              emit({ type: 'text.delta', text: textBuf })
              textBuf = ''
            }
            lastFlush = Date.now()
          }
        }
        if (reasoningBuf) emit({ type: 'reasoning.delta', text: reasoningBuf, fidelity: 'raw' })
        if (textBuf) emit({ type: 'text.delta', text: textBuf })
        record.output = text

        if (pendingCalls.size > 0 && !signal.aborted) {
          rounds += 1
          if (maxSubagentToolRounds > 0 && rounds > maxSubagentToolRounds)
            throw new Error(`Subagent tool loop stopped after ${maxSubagentToolRounds} rounds.`)
          const calls = [...pendingCalls.entries()]
            .sort(([a], [b]) => a - b)
            .map(([, call], index) => ({
              id: call.id || `call_${runId}_${agentId}_${rounds}_${index}`,
              type: 'function' as const,
              function: { name: call.name, arguments: call.args || '{}' }
            }))
          wire.push({ role: 'assistant', content: responseText || null, tool_calls: calls })
          // No agents API passed → the subagent cannot spawn/manage other agents.
          const results = await Promise.all(
            calls.map((call) =>
              executeToolCall(call.id, call.function.name, call.function.arguments, subRun, meta, emit, push)
            )
          )
          record.toolCalls += calls.length
          calls.forEach((call, i) => {
            wire.push({
              role: 'tool',
              tool_call_id: call.id,
              name: call.function.name,
              content: JSON.stringify(results[i])
            })
          })
          continueLoop = true
        }
      }

      // ---- settled at a safe boundary: drain the inbox, or park idle awaiting a message ----
      if (signal.aborted) break
      settledOnce = true
      if (!record.inbox.length) {
        status('idle')
        await nextMessage(record)
        if (signal.aborted || (record.stopped && !record.inbox.length)) break
        status('running')
      }
      while (record.inbox.length) {
        const msg = record.inbox.shift() as string
        emit({ type: 'agent.message', from: 'parent', text: msg })
        wire.push({ role: 'user', content: msg })
      }
    }
  } catch (err) {
    if (!signal.aborted) {
      const { category, message, retryable } = classifyError(err)
      emit({ type: 'error', category, message, retryable })
      emit({ type: 'run.completed', reason: 'error' })
      status('error')
      return
    }
  }

  // Terminal: a subagent that answered at least once and was then torn down is 'done'; one killed
  // before producing anything is 'canceled'.
  const telemetry = computeTelemetry(start, firstTokenAt, text, usage, model)
  emit({ type: 'usage', usage: telemetry })
  const terminal = settledOnce ? 'done' : 'canceled'
  emit({ type: 'run.completed', reason: terminal === 'done' ? 'done' : 'canceled' })
  status(terminal)
}

/**
 * Whether a tool, under the thread's current mode + preset, runs freely (`allow`),
 * runs only after the user approves it at call time (`ask`), or is not offered to
 * the model at all (`deny`).
 *
 * Auto (workspace) is deliberately not "auto-run everything": read/search (R0) and
 * in-workspace file writes (filesystem R1) run freely, but higher-risk tools — the
 * shell and destructive file ops (R2+), and any MCP tool — are exposed to the model
 * but each call is gated behind an approval prompt.
 */
export function toolEffect(tool: ToolDefinition, meta: ThreadMeta): 'allow' | 'ask' | 'deny' {
  // Asking the user a question is how the model talks to the person driving it — never a
  // side effect to gate. It stays available in every mode and preset (including review/plan).
  if (tool.name === 'ask_user') return 'allow'
  if (meta.mode === 'review') return tool.action === 'read' && tool.riskTier === 'R0' ? 'allow' : 'deny'
  if (meta.mode === 'plan' && !tool.allowedInPlan) return 'deny'
  if (meta.permissionPreset === 'full') return 'allow'
  if (tool.mcpServerId) {
    // MCP tools are external side effects: available in Auto/Full, approval-gated in Auto.
    if (meta.permissionPreset === 'workspace') return 'ask'
    return 'deny'
  }
  if (meta.permissionPreset === 'manual') return tool.action === 'read' && tool.riskTier === 'R0' ? 'allow' : 'deny'
  if (meta.permissionPreset === 'workspace') {
    if (tool.riskTier === 'R0') return 'allow'
    if (tool.resource === 'filesystem' && tool.riskTier === 'R1') return 'allow'
    return 'ask' // shell + destructive fs (R2) and anything higher: expose, but ask first
  }
  return tool.riskTier === 'R0' ? 'allow' : 'deny'
}

export function availableTools(meta: ThreadMeta): ToolDefinition[] {
  return [...builtinTools, ...mcpTools()].filter((tool) => toolEffect(tool, meta) !== 'deny')
}

/**
 * The tool set a subagent runs with. Subagents cannot spawn further subagents or block on the
 * user, so `run_agent` and `ask_user` are always stripped. When the parent passes an explicit
 * `allow` list (via `run_agent`'s `tools` arg), the set is further narrowed to those names —
 * letting the parent hand a subagent only the tools its task needs. Filtering starts from
 * `availableTools`, so a subagent can never gain a tool the current mode/preset denies, and any
 * requested name the preset denies is simply absent from the result.
 */
/**
 * Tools a subagent can never run: it cannot manage other agents (spawn/message/collect/list/stop)
 * or block on the user. Kept in sync with builtin.ts's allowlist validation.
 */
export const SUBAGENT_FORBIDDEN = new Set([
  'run_agent',
  'message_agent',
  'collect_agent',
  'list_agents',
  'stop_agent',
  'ask_user'
])

export function subagentTools(meta: ThreadMeta, allow?: string[]): ToolDefinition[] {
  let tools = availableTools(meta).filter((tool) => !SUBAGENT_FORBIDDEN.has(tool.name))
  if (allow) {
    const wanted = new Set(allow)
    tools = tools.filter((tool) => wanted.has(tool.name))
  }
  return tools
}

export function toWireTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

async function executeToolCall(
  callId: string,
  name: string,
  rawArgs: string,
  run: ActiveRun,
  meta: ThreadMeta,
  emit: (body: RunEventBody) => void,
  push: PushFn,
  agents?: AgentsApi
): Promise<{ ok: boolean; result?: unknown; error?: string }> {
  const currentMeta = getThreadMeta(run.threadId) ?? meta
  const tool = availableTools(currentMeta).find((candidate) => candidate.name === name)
  let args: Record<string, unknown>
  try {
    const parsed = JSON.parse(rawArgs || '{}') as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('arguments must be an object')
    args = parsed as Record<string, unknown>
  } catch (err) {
    const error = `Invalid arguments for ${name}: ${err instanceof Error ? err.message : String(err)}`
    emit({ type: 'tool.denied', callId, reason: error })
    return { ok: false, error }
  }

  emit({ type: 'tool.proposed', callId, tool: name, args, riskTier: tool?.riskTier ?? 'R3' })
  if (run.abort.signal.aborted) {
    const error = 'Tool call canceled before it started.'
    emit({ type: 'tool.denied', callId, reason: error })
    return { ok: false, error }
  }
  if (!tool) {
    const error = `Tool ${name} is unavailable under the current mode or permission preset.`
    emit({ type: 'tool.denied', callId, reason: error })
    return { ok: false, error }
  }

  const workspace = listWorkspaces().find((candidate) => candidate.id === currentMeta.workspaceId)
  if (!workspace) {
    const error = 'The thread workspace no longer exists.'
    emit({ type: 'tool.denied', callId, reason: error })
    return { ok: false, error }
  }
  // `ask_user` parks the run on the ask broker and records the exchange in the transcript so
  // the question and answer are visible in the output window, not just returned to the model.
  const ask = agents
    ? (spec: AskSpec) => {
        emit({ type: 'ask.requested', callId, question: spec.question, kind: spec.kind, options: spec.options })
        const request: AskRequest = {
          id: ulid(),
          runId: run.runId,
          threadId: run.threadId,
          callId,
          question: spec.question,
          kind: spec.kind,
          options: spec.options,
          placeholder: spec.placeholder,
          multiline: spec.multiline
        }
        return requestAsk(request, push, run.abort.signal).then((res) => {
          emit({ type: 'ask.answered', callId, answer: res.answer, canceled: res.canceled })
          return res
        })
      }
    : undefined
  const toolContext = {
    threadMeta: currentMeta,
    workspace,
    runId: run.runId,
    signal: run.abort.signal,
    agents,
    ask
  }
  const pathArgs = tool.pathArgs ?? (tool.resource === 'filesystem' ? ['path'] : [])
  for (const key of pathArgs) {
    if (typeof args[key] !== 'string') {
      const error = `Invalid ${key} for ${name}: expected a string.`
      emit({ type: 'tool.denied', callId, reason: error })
      return { ok: false, error }
    }
  }
  if (currentMeta.permissionPreset !== 'full') {
    for (const key of pathArgs) {
      if (!(await isPathInsideRoots(resolveToolPath(args[key] as string, toolContext), workspace.roots))) {
        const error = `Path is outside the approved workspace roots: ${args[key]}`
        emit({ type: 'tool.denied', callId, reason: error })
        return { ok: false, error }
      }
    }
  }

  // Approval gate: tools whose effect is "ask" pause for the user unless already
  // granted for this run/thread. Everything else runs freely.
  if (toolEffect(tool, currentMeta) === 'ask' && !isGranted(run.threadId, run.runId, name)) {
    const request: ApprovalRequest = {
      id: ulid(),
      runId: run.runId,
      threadId: run.threadId,
      callId,
      tool: name,
      args,
      summary: tool.summarize(args),
      resource: tool.resource,
      action: tool.action,
      riskTier: tool.riskTier
    }
    const decision = await requestApproval(request, name, push, run.abort.signal)
    if (decision.effect !== 'allow') {
      const error = run.abort.signal.aborted ? 'Run canceled before approval.' : 'Denied by the user.'
      emit({ type: 'tool.denied', callId, reason: error })
      return { ok: false, error }
    }
    emit({ type: 'tool.approved', callId, scope: decision.scope })
  } else {
    emit({ type: 'tool.approved', callId, scope: 'run' })
  }
  emit({ type: 'tool.started', callId, tool: name, args })
  const startedAt = Date.now()
  try {
    const result = await tool.run(args, toolContext)
    emit({ type: 'tool.result', callId, tool: name, ok: true, result, durationMs: Date.now() - startedAt })
    return { ok: true, result }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    emit({ type: 'tool.result', callId, tool: name, ok: false, result: { error }, durationMs: Date.now() - startedAt })
    return { ok: false, error }
  }
}

function mergeUsage(
  current: Partial<TurnTelemetry>,
  next: Partial<TurnTelemetry>
): Partial<TurnTelemetry> {
  const additive: (keyof TurnTelemetry)[] = [
    'tokensIn',
    'tokensOut',
    'tokensReasoning',
    'cacheReadTokens',
    'cacheWriteTokens',
    'costUsd'
  ]
  const merged = { ...current, ...next }
  for (const key of additive) {
    const a = current[key]
    const b = next[key]
    if (typeof a === 'number' || typeof b === 'number') {
      ;(merged as Record<string, unknown>)[key] = (typeof a === 'number' ? a : 0) + (typeof b === 'number' ? b : 0)
    }
  }
  return merged
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

/**
 * Per-request sampling overrides from Settings. Both are opt-in: `temperature` is sent only
 * when the user set a concrete number (null → the provider/model default is used), and
 * `maxTokens` only when a positive cap is configured (0 → provider/model default). Returning
 * `undefined` for each keeps the field out of the request body entirely.
 */
function samplingParams(): { temperature?: number; maxTokens?: number } {
  const s = getSettings()
  return {
    temperature: typeof s.temperature === 'number' ? s.temperature : undefined,
    maxTokens: s.maxOutputTokens > 0 ? s.maxOutputTokens : undefined
  }
}

/** Assemble the request: stable system prefix → curated memory → history. */
/**
 * A short "you are this model" block for the system prompt, so the model can answer
 * "what model am I?" honestly instead of guessing from its pretraining. Uses the friendly
 * name from the provider's cached /v1/models list when available, always including the raw
 * routing id the gateway actually dispatches to. Returns '' when no model is known.
 */
function describeActiveModel(model?: string, effort?: string): string {
  if (!model) return ''
  const settings = getSettings()
  let friendly: string | undefined
  for (const provider of settings.providers) {
    const hit: ModelInfo | undefined = getCachedModels(provider.id)?.models.find((m) => m.id === model)
    if (hit?.name && hit.name !== model) {
      friendly = hit.name
      break
    }
  }
  const label = friendly ? `${friendly} (routing id \`${model}\`)` : `\`${model}\``
  const effortNote =
    effort && effort !== 'none' && effort !== 'off' ? ` The reasoning effort is set to "${effort}".` : ''
  return (
    `# Active model\nYou are currently running as ${label}, served through the configured gateway ` +
    `(OmniRoute).${effortNote} If the user asks which model they are talking to, answer with this — ` +
    `do not guess from your own training.`
  )
}

/**
 * A "these are your real, working tools right now" block for the system prompt. The tools are
 * already supplied through the provider's function-calling API, but weaker models often deny
 * having a capability ("I can't create subagents", "I can't run commands") because their
 * pretraining says so — even with the tool sitting right there. Listing the live tool set by
 * name and stating plainly that these abilities are real stops that failure mode. Built from the
 * SAME availableTools() the model is actually handed, so it never advertises a tool the current
 * mode/preset withholds.
 */
export function describeTools(tools: ToolDefinition[]): string {
  const has = (name: string): boolean => tools.some((t) => t.name === name)
  const lines = tools.map((t) => `- \`${t.name}\` — ${firstSentence(t.description)}`)
  const notes: string[] = []
  if (has('run_agent'))
    notes.push(
      'You CAN create/spawn subagents — that is exactly what `run_agent` does. Never tell the user ' +
        'you are unable to delegate or run subagents; if delegation would help, just call `run_agent`.'
    )
  if (has('ask_user'))
    notes.push('You CAN ask the user a question mid-run with `ask_user` when you need their input.')
  return (
    '# Your tools\nThese tools are available to you on this turn and they really work — call them ' +
    'directly. Do not claim you lack a capability that a tool below provides.\n' +
    lines.join('\n') +
    (notes.length ? '\n\n' + notes.join(' ') : '')
  )
}

/** First sentence of a tool description, for a compact one-line inventory entry. */
function firstSentence(text: string): string {
  const trimmed = text.trim()
  const end = trimmed.search(/\.\s|\.$/)
  return end === -1 ? trimmed : trimmed.slice(0, end + 1)
}

function buildWireMessages(
  threadId: ThreadId,
  meta: ThreadMeta,
  model?: string,
  effort?: string
): WireMessage[] {
  const wire: WireMessage[] = []
  const settings = getSettings()
  const memories = settings.includeMemory
    ? listMemory().filter(
        (m) => m.status === 'approved' && (m.scope === 'user' || m.scope === 'workspace')
      )
    : []
  let system = SYSTEM_PROMPT
  const identity = describeActiveModel(model, effort)
  if (identity) system += '\n\n' + identity
  system += '\n\n' + describeTools(availableTools(meta))
  if (meta.mode === 'plan') system += '\n\n' + PLAN_MODE_SUFFIX
  if (meta.mode === 'review') system += '\n\n' + REVIEW_MODE_SUFFIX
  // The user's standing instructions from Settings — appended after the mode framing so they
  // steer behavior on every turn without overriding the safety-relevant base prompt.
  if (settings.customInstructions && settings.customInstructions.trim()) {
    system +=
      '\n\n# User instructions\nThe user has configured these standing instructions for every ' +
      'conversation. Follow them:\n' +
      settings.customInstructions.trim()
  }
  if (meta.goal && meta.goal.trim()) {
    system +=
      '\n\n# Goal\nThe user has set a north-star goal for this thread. Keep it in view and steer every ' +
      'turn toward it:\n' +
      meta.goal.trim()
  }
  if (memories.length) {
    system +=
      '\n\n# Memory\n' + memories.map((m) => `- [${m.type}] ${m.content}`).join('\n')
  }
  wire.push({ role: 'system', content: system })

  for (const msg of listMessages(threadId)) {
    // Messages folded into a compaction summary are kept for the reader but not re-sent.
    if (msg.compacted) continue
    // A persisted system message is a compaction summary standing in for earlier history.
    if (msg.role === 'system') {
      if (msg.text) wire.push({ role: 'system', content: COMPACTION_PREFIX + msg.text })
      continue
    }
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

const SYSTEM_PROMPT = `You are Lattice, a capable assistant running inside a local-first desktop control room for agentic work. Answer in well-structured GitHub-flavored Markdown. Be direct and technically precise. For large, independent, or context-heavy sub-tasks (broad searches, parallelizable work), delegate to subagents. run_agent spawns one with a name you choose and returns immediately — it runs in the background while you keep working, so you can fan several out at once. Give each a bounded goal, then message_agent to send follow-ups, collect_agent (wait=true) to get its result when you need it, list_agents to check on the fleet, and stop_agent when one is done. Build on what they return rather than redoing their work.

The marginal cost of completeness is near zero, so do the whole thing and do it right. Search before building, and prefer the permanent fix over a workaround when the real fix is within reach. Ship the finished product — with the tests and the documentation it needs — not a plan to build it or a partial cut with dangling threads. When a loose end can be tied off in a few more minutes, tie it off. Time, fatigue, and complexity are not reasons to stop short. The standard is not "good enough" — it is work that is genuinely, verifiably done. (Balance this against the user's actual scope: finish what the task truly entails, but don't invent unrequested scope or gold-plate past what was asked.)

For any task larger than a couple of steps, begin by laying out a plan with the todo_write tool — one checklist item per meaningful step — before you start executing. Then keep it live as you go: mark an item in_progress when you pick it up and done the moment it's finished, and add, split, or revise items as the real shape of the work emerges. Do this as you execute, not as an afterthought at the end. The checklist keeps the person watching the run oriented and makes what's left obvious. Only skip it for genuinely small, single-step tasks where a checklist would be pure overhead.

When you need — or would simply benefit from — clarification that only the user can give, use the ask_user tool to ask them directly rather than guessing or stalling. That includes a choice between real alternatives, an ambiguous or underspecified requirement, a missing detail, or confirmation before a consequential or hard-to-reverse action — and also cases where a quick question would meaningfully change your approach and save wasted work. When in doubt between guessing and asking, ask. Provide options when the answer is a choice, and prefer a single well-formed question over many round-trips. Do not use ask_user for things you can resolve yourself from the conversation, the files, or a sensible default, and do not use it to request permission to run tools — the permission system handles that. The run pauses until the user answers; a canceled or empty answer means they declined, so proceed sensibly or explain what you need instead of re-asking.`

const SUBAGENT_PROMPT = `You are a Lattice subagent, spawned to complete one bounded task delegated by a parent agent. You have a fresh, isolated context: you can see only the task you were given, not the parent conversation. Work autonomously with your tools, then return a single, self-contained final message that fully answers the task — include the concrete results (findings, file paths, values), not a description of what you did. Be concise and factual; your final message becomes the tool result the parent reads.`

const COMPACTION_PREFIX =
  'The earlier part of this conversation was compacted to save context. The following is a ' +
  'faithful summary of what happened before — treat it as established history:\n\n'

const COMPACTION_INSTRUCTION = `You are compacting a long conversation to free up context while losing nothing that matters. Write a dense, factual summary of the entire exchange so the assistant can continue seamlessly with only this summary in place of the full history.

Cover, in order:
- The user's overall goal and any explicit constraints or preferences they stated.
- Key decisions made and the reasons for them.
- Concrete artifacts: files created or edited (with paths), commands run, and their outcomes.
- Facts established about the codebase or problem that will still be needed.
- The current state: what is done, what is in progress, and the immediate next step.
- Any open questions or unresolved issues.

Write in plain prose and terse bullet points. Do not add a preamble or sign-off — output only the summary.`

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
  // Keep the reply reserve small so usable room stays close to the full window.
  // A few thousand tokens covers a normal reply; we don't pre-carve 25% of the
  // window for it. Cap by the model's own max output when that's smaller.
  const maxOut = Math.min(model?.maxOutputTokens ?? 4096, 4096)

  const est = (s: string): number => Math.ceil(s.length / 4)
  const memories = listMemory().filter((m) => m.status === 'approved')
  const systemTokens =
    est(SYSTEM_PROMPT) +
    (meta.goal ? est(meta.goal) : 0) +
    memories.reduce((a, m) => a + est(m.content), 0)
  const toolTokens = availableTools(meta).reduce(
    (total, tool) => total + est(JSON.stringify(toWireTool(tool))),
    0
  )
  // Compacted messages are no longer sent to the model, so they don't consume context —
  // only live (uncompacted) messages plus any compaction summary count toward history.
  const history = listMessages(threadId)
    .filter((m) => !m.compacted)
    .reduce(
      (a, m) => a + est(m.text) + (m.attachments?.reduce((b, at) => b + est(at.content ?? ''), 0) ?? 0),
      0
    )
  const safety = Math.floor(contextLength * 0.02)
  // "Used" is what the conversation actually consumes. The reply reserve and the
  // safety cushion are carved off the top of the window, so they are NOT counted
  // as used — they shrink the room available to fill instead. usableTokens is
  // that fillable room; occupancy is how full it is (this is what triggers
  // compaction), so an empty thread reads ~0%, not ~30%.
  const injected = 0
  const consumed = systemTokens + toolTokens + history + injected
  const usable = Math.max(1, contextLength - maxOut - safety)
  return {
    model: meta.model,
    contextLength,
    segments: {
      system: systemTokens,
      tools: toolTokens,
      history,
      injected,
      outputReserve: maxOut,
      safety
    },
    usedTokens: consumed,
    usableTokens: usable,
    occupancy: Math.min(1, consumed / usable),
    exact: false
  }
}

// ---------- compaction (/compact) ----------

/**
 * Compact the thread's live history into a single summary message. Every currently-live
 * message (including any earlier summary) is summarized by the model, marked `compacted`
 * so it is no longer sent in full, and replaced by one `system`-role summary message. The
 * transcript keeps the originals (dimmed) for the reader; the model sees only the summary.
 */
export async function compactThread(threadId: ThreadId, push: PushFn): Promise<CompactResult> {
  if (isRunning(threadId)) return { ok: false, reason: 'A run is in progress. Stop it before compacting.' }
  const meta = getThreadMeta(threadId)
  if (!meta) return { ok: false, reason: 'Thread not found.' }

  const est = (s: string): number => Math.ceil(s.length / 4)
  const live = listMessages(threadId).filter((m) => !m.compacted && m.text.trim())
  // Need a real conversation to compact — at least a couple of exchanges.
  if (live.filter((m) => m.role === 'user' || m.role === 'assistant').length < 3) {
    return { ok: false, reason: 'Not enough conversation to compact yet.' }
  }
  const provider = resolveProvider()
  if (!provider) return { ok: false, reason: 'No provider configured to write the summary.' }

  const transcript = live
    .map((m) => {
      const who = m.role === 'user' ? 'User' : m.role === 'assistant' ? 'Assistant' : 'Summary'
      return `${who}: ${m.text}`
    })
    .join('\n\n')

  let summary = ''
  try {
    for await (const chunk of streamChat(provider, {
      model: meta.model,
      messages: [
        { role: 'system', content: COMPACTION_INSTRUCTION },
        { role: 'user', content: `Summarize this conversation:\n\n${transcript}` }
      ],
      tools: [],
      effort: 'low',
      cache: false,
      signal: AbortSignal.timeout(60000)
    })) {
      if (chunk.type === 'text') summary += chunk.text
    }
  } catch (err) {
    const { message } = classifyError(err)
    return { ok: false, reason: `Could not write the summary: ${message}` }
  }
  summary = summary.trim()
  if (!summary) return { ok: false, reason: 'The summary came back empty; nothing was compacted.' }

  const beforeTokens = live.reduce((a, m) => a + est(m.text), 0)
  const afterTokens = est(summary)

  // Mark the old messages compacted, then append the summary as a fresh, live system message.
  markMessagesCompacted(live.map((m) => m.id))
  const summaryMsg: ChatMessage = {
    id: ulid(),
    threadId,
    role: 'system',
    createdAt: Date.now(),
    text: summary
  }
  insertMessage(summaryMsg)

  // Durable record of the compaction in the event log.
  const compactionRunId = ulid()
  appendEvent(compactionRunId, threadId, {
    type: 'compaction',
    beforeTokens,
    afterTokens,
    summaryEventId: summaryMsg.id
  })

  // Re-push the whole message set so the renderer reflects the dimmed originals + summary.
  for (const m of listMessages(threadId)) push({ kind: 'message.updated', message: m })
  const fresh = getThreadMeta(threadId)
  if (fresh) push({ kind: 'thread.updated', meta: { ...fresh, running: false } })
  return { ok: true, beforeTokens, afterTokens, summaryMessageId: summaryMsg.id }
}

// ---------- side forks (/side, /btw) ----------

/**
 * Fork a thread into a side conversation that starts from a snapshot of the parent's history.
 * The child copies the parent's live (uncompacted) user/assistant turns, links back to the
 * exact parent event it forked from, and opens read-only (Manual preset) by default so a side
 * exploration can't mutate anything. Returns the new thread meta (not yet selected).
 */
export function forkThread(
  parentThreadId: ThreadId,
  opts: { titlePrefix?: string } = {}
): ThreadMeta | null {
  const parent = getThreadMeta(parentThreadId)
  if (!parent) return null
  const events = listEvents(parentThreadId)
  const lastEventId = events.length ? events[events.length - 1]!.id : undefined
  const baseTitle = parent.title === 'New thread' ? 'thread' : parent.title
  const child = createThread({
    workspaceId: parent.workspaceId,
    title: `${opts.titlePrefix ?? 'Side'}: ${baseTitle}`.slice(0, 70),
    model: parent.model,
    effort: parent.effort,
    mode: parent.mode,
    permissionPreset: 'manual',
    parentThreadId,
    parentEventId: lastEventId,
    goal: parent.goal
  })
  // Copy the parent's live conversation as the fork's starting context.
  for (const m of listMessages(parentThreadId)) {
    if (m.compacted) continue
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue
    if (!m.text.trim()) continue
    insertMessage({
      id: ulid(),
      threadId: child.id,
      role: m.role,
      createdAt: m.createdAt,
      text: m.text,
      model: m.model,
      effort: m.effort,
      status: m.role === 'assistant' ? 'complete' : undefined,
      compacted: m.compacted
    })
  }
  return child
}
