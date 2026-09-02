import { ulid } from '@shared/id'
import type {
  AppSettings,
  ChatMessage,
  ContextBudget,
  ErrorCategory,
  ModelInfo,
  CompactResult,
  MemoryItem,
  ProviderConfig,
  RunEventBody,
  MessageId,
  RunId,
  SendOptions,
  ThreadId,
  ThreadMeta,
  TurnTelemetry,
  WireExchange
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
  listTodos,
  listWorkspaces,
  markMessagesCompacted,
  recordFileChange,
  releaseSeqCounter,
  updateMessage,
  updateThread
} from '../store/eventStore'
import { readFile } from 'node:fs/promises'
import { ProviderHttpError, streamChat, type WireContentPart, type WireMessage } from '../providers/openaiCompat'
import { countTokens } from './tokenizer'
import { providerForModel } from '../providers/registry'
import { builtinTools, isPathInsideRoots, resolveToolPath } from '../tools/builtin'
import { deferredTools, findToolsTool, loadedDeferredTools } from './toolCatalog'
import type { BackgroundAgentStatus, SubagentSpec, SubagentResult, ToolContext, ToolDefinition } from '../tools/types'
import { isGranted, requestApproval } from './approvals'
import { requestAsk } from './asks'
import { syncExternalMemory } from '../memory/bridge'
import { distillMemories } from './selfLearn'
import type { ApprovalRequest, AskRequest } from '@shared/types'
import type { AskSpec } from '../tools/types'

type PushFn = (event: PushEvent) => void

/** A turn composed while a run was active, waiting to start once the run(s) ahead of it finish. */
interface QueuedTurn {
  opts: SendOptions
  /** id of the already-persisted user message, so it can be edited or removed while it waits */
  messageId: MessageId
}

/** A steer that has been persisted but has not yet reached a safe model boundary. */
interface PendingSteer {
  opts: SendOptions
  messageId: MessageId
}

interface ActiveRun {
  runId: RunId
  threadId: ThreadId
  abort: AbortController
  /**
   * Per-response abort: cancels only the CURRENT provider streaming call, never the whole run.
   * A steer arriving mid-stream trips this so the in-flight reply is interrupted at once and the
   * steer folds in on the next round — instead of waiting for the entire response to finish
   * streaming (which made steering feel like a queued next turn). Recreated each round.
   */
  responseAbort?: AbortController
  /** messages waiting to be injected at the next safe boundary */
  steerQueue: PendingSteer[]
  /** full turns queued to start after this run completes */
  turnQueue: QueuedTurn[]
  /** false once the main model loop has ended; post-run cleanup must not accept steers */
  acceptingSteers: boolean
  /**
   * True once the model turn is genuinely finished and nothing is queued behind it — i.e. the
   * thread is idle to the user even though the run lingers in `active` for best-effort title
   * generation and memory distillation. Gates the "running" UI state so Stop/spinner clear the
   * instant generation stops, not seconds later when that housekeeping finishes.
   */
  settled: boolean
  assistantMessageId: string
  /**
   * One AbortController per subagent currently inside {@link runSubagentLoop}, keyed by agentId —
   * covers BOTH background (`run_agent(background:true)`) and synchronous/foreground subagents, so
   * every card the Agents tab can show is individually stoppable. Entries are added when the loop
   * starts and removed in its `finally`, so a stale id just means "already finished" to {@link cancelAgent}.
   */
  agentAborts: Map<string, AbortController>
}

/**
 * One background subagent. Tracked at THREAD scope (see {@link backgroundAgents}), not on the
 * spawning run, because a background agent deliberately OUTLIVES the turn that started it: the turn
 * returns immediately and the thread goes idle while the agent keeps working. `promise` settles when
 * the agent finishes.
 */
interface BgAgent {
  agentId: string
  threadId: ThreadId
  name?: string
  promise: Promise<SubagentResult>
  status: 'running' | 'done' | 'error'
  result?: SubagentResult
  error?: string
  /** This agent's own abort — what a per-card Stop ({@link cancelAgent}) and thread-clear trigger. */
  abort: AbortController
  /**
   * Set once its result has reached the model — either collected inline by `agent_result` or
   * auto-delivered as a turn when it finished. Guards against delivering the same result twice.
   */
  delivered: boolean
}

const active = new Map<ThreadId, ActiveRun>()

/**
 * Background subagents (`run_agent(background: true)`), keyed by agentId, tracked at THREAD scope so
 * they outlive the single turn that spawned them. The spawning turn returns a handle immediately and
 * the thread settles to idle — the user AND the orchestrator model are both freed — while the agent
 * keeps working on its own promise. When it settles, {@link deliverAgentCompletion} pushes its result
 * back into the thread (steer-injected into a live run, or a fresh turn that wakes an idle thread) —
 * the same push-based lane inter-session messages use. So the model is *notified* of the result
 * rather than parking a tool call on `agent_result` to wait for it.
 */
const backgroundAgents = new Map<string, BgAgent>()

/** The still-tracked background agents belonging to one thread. */
function threadBackgroundAgents(threadId: ThreadId): BgAgent[] {
  return [...backgroundAgents.values()].filter((a) => a.threadId === threadId)
}

export function isRunning(threadId: ThreadId): boolean {
  const run = active.get(threadId)
  return !!run && ownsThread(run)
}

/**
 * True while a run still owns its thread for routing: the model loop is live, or turns are queued
 * behind it. A *settled* run with an empty queue lingers in `active` only for best-effort post-turn
 * housekeeping (title generation, memory distillation) — the thread is already idle to the user, so
 * a freshly sent message must start a new run, NOT get captured into this run's queue behind that
 * housekeeping. This is the single predicate {@link isRunning} and {@link send} share so the UI's
 * "running" state and the routing decision can never disagree.
 */
function ownsThread(run: ActiveRun): boolean {
  return !run.settled || run.turnQueue.length > 0
}

export function cancelRun(runId: RunId): void {
  for (const run of active.values()) {
    if (run.runId === runId) {
      run.abort.abort()
      return
    }
  }
}

/**
 * Abort a single subagent (background or foreground) without touching the rest of the run — the
 * Agents tab's per-card Stop button. A miss (already finished, or a stale id from a prior run) is
 * silently a no-op: the caller only wanted the agent stopped, and it's already not running.
 */
export function cancelAgent(agentId: string): void {
  // A foreground subagent lives under whichever run currently owns its thread; a background one
  // in the thread-scoped registry, having outlived its spawning run. Aborting its own controller
  // both stops the in-flight loop and (via the aborted guard in the completion handler) suppresses
  // the result-delivery turn — a user who stopped an agent does not want it to wake the thread.
  for (const run of active.values()) run.agentAborts.get(agentId)?.abort()
  backgroundAgents.get(agentId)?.abort.abort()
}

/**
 * Abort whatever run (if any) is active on a thread, plus every background agent still running for
 * it. Used by /clear before wiping history: a detached background agent must not keep working — nor
 * deliver a result — into a thread whose history is being cleared out from under it.
 */
export function cancelRunForThread(threadId: ThreadId): void {
  active.get(threadId)?.abort.abort()
  for (const agent of threadBackgroundAgents(threadId)) agent.abort.abort()
}

/**
 * All models currently in the provider caches, assembled synchronously (no network). Used by the
 * auto-compaction check so it can read the thread model's real context window; falls back to the
 * getContextBudget default window when a model isn't cached yet.
 */
function cachedModelList(): ModelInfo[] {
  const out: ModelInfo[] = []
  for (const p of getSettings().providers) {
    const cached = getCachedModels(p.id)
    if (cached) out.push(...cached.models)
  }
  return out
}

/**
 * Before a turn runs, compact the thread's history if it has crossed the user's compaction
 * threshold — the automatic half of `/compact`. The just-sent user message (`preserveMessageId`) is
 * kept live and verbatim so only the history behind it is summarized; the summary and dimmed
 * originals are pushed to the transcript exactly as manual compaction does, so the user sees why the
 * conversation shrank. Best-effort: a refusal (too little to compact, no provider, summary failed)
 * is swallowed so it never blocks the turn — the blockThreshold guard is the hard stop.
 */
async function maybeAutoCompact(threadId: ThreadId, preserveMessageId: MessageId, push: PushFn): Promise<void> {
  const settings = getSettings()
  if (!settings.autoCompact) return
  const budget = getContextBudget(threadId, cachedModelList())
  if (!budget || budget.occupancy < settings.compactionThreshold) return
  // A run is about to start on top of this; keep the thread's running flag set through the
  // compaction so the composer shows a continuous working state rather than flickering idle.
  const meta = getThreadMeta(threadId)
  if (meta) push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  try {
    await compactThread(threadId, push, { preserveMessageId, keepRunning: true })
  } catch {
    // Never let auto-compaction failure sink the user's turn.
  }
}

/** Entry point for the composer. Routes to start / steer / queue. */
export async function send(opts: SendOptions, push: PushFn): Promise<{ runId: RunId; messageId: string }> {
  const running = active.get(opts.threadId)
  // The active map intentionally outlives the model loop while post-run work (title generation
  // and memory distillation) finishes. Only steer while that loop can still reach a safe boundary;
  // otherwise this message must become the next turn instead of being stranded on a finished run.
  if (
    running &&
    opts.disposition === 'steer' &&
    running.acceptingSteers &&
    !running.abort.signal.aborted
  ) {
    const msg = persistUserMessage(opts, running.runId)
    running.steerQueue.push({ opts, messageId: msg.id })
    // Interrupt the in-flight response so the steer lands now, not at end-of-reply. Aborts only
    // the current provider stream (not the run); the loop catches it and injects at the boundary.
    running.responseAbort?.abort()
    push({ kind: 'message.updated', message: msg })
    appendEvent(running.runId, opts.threadId, { type: 'steer.injected', messageId: msg.id })
    return { runId: running.runId, messageId: msg.id }
  }
  if (running && ownsThread(running)) {
    // queue (default while running): persist now, marked queued, so it shows in the transcript
    // as a pending turn the user can still edit or remove until its run starts.
    const msg = persistUserMessage(opts, undefined, true)
    running.turnQueue.push({ opts, messageId: msg.id })
    push({ kind: 'message.updated', message: msg })
    return { runId: running.runId, messageId: msg.id }
  }
  // Either no run at all, or a settled run lingering only for post-turn housekeeping. The thread is
  // idle to the user (the UI already dropped its spinner at settle), so start a fresh run now rather
  // than stranding this message behind titling/distillation. startRun overwrites `active` for the
  // thread; the lingering run's own finally detects it no longer owns the thread and bows out.
  const msg = persistUserMessage(opts)
  push({ kind: 'message.updated', message: msg })
  // The message is persisted (so it shows instantly); now fold away stale history if the context is
  // over threshold, keeping this turn live, before the run reads the wire.
  await maybeAutoCompact(opts.threadId, msg.id, push)
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
  const run: ActiveRun = {
    runId,
    threadId,
    abort,
    steerQueue: [],
    turnQueue: [],
    acceptingSteers: true,
    settled: false,
    assistantMessageId,
    agentAborts: new Map()
  }
  active.set(threadId, run)

  const model = opts.model ?? meta.model
  const effort = opts.effort ?? meta.effort

  push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  void executeRun(run, meta, model, effort, push).finally(() => {
    run.acceptingSteers = false
    requeuePendingSteers(run, push)
    releaseSeqCounter(runId)
    // A fresh run may have taken over this thread while we lingered doing post-turn housekeeping
    // (a message the user sent after we settled). If the map no longer points to us, that newer run
    // owns the thread now — don't delete its entry or hand off our (empty) queue over the top of it.
    if (active.get(threadId) !== run) return
    active.delete(threadId)
    // start next queued turn, if any
    const next = run.turnQueue.shift()
    if (next) {
      // queued message is already persisted; start a run that consumes existing history.
      // startRunFromHistory pushes running:true itself, so we deliberately do NOT settle here —
      // that would flip the thread false→true and flicker the composer between turns.
      void startRunFromHistory(threadId, next, run.turnQueue, push)
    } else {
      // Nothing follows: ensure the thread is marked idle (usually already settled at completion).
      settleThreadRunning(run, push)
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
    acceptingSteers: true,
    settled: false,
    assistantMessageId: ulid(),
    agentAborts: new Map()
  }
  active.set(threadId, run)
  // The turn is starting now: clear its queued flag and bind it to this run so the transcript
  // renders it as a normal sent message (no longer editable/removable).
  const started = updateMessage(turn.messageId, { queued: false, runId })
  if (started) push({ kind: 'message.updated', message: started })
  push({ kind: 'thread.updated', meta: { ...meta, running: true } })
  void executeRun(run, meta, turn.opts.model ?? meta.model, turn.opts.effort ?? meta.effort, push).finally(() => {
    run.acceptingSteers = false
    requeuePendingSteers(run, push)
    releaseSeqCounter(runId)
    if (active.get(threadId) !== run) return
    active.delete(threadId)
    const next = run.turnQueue.shift()
    if (next) void startRunFromHistory(threadId, next, run.turnQueue, push)
    else settleThreadRunning(run, push)
  })
}

/**
 * Flip the thread out of its "running" UI state the instant the model turn is genuinely done.
 * The run object deliberately lingers in `active` afterwards while best-effort title generation
 * and memory distillation finish; without this, the composer's Stop button and spinner would keep
 * showing "running" for the seconds that housekeeping takes. Idempotent — safe to call from both
 * the completion path and the finally block.
 */
function settleThreadRunning(run: ActiveRun, push: PushFn): void {
  if (run.settled) return
  run.settled = true
  const fresh = getThreadMeta(run.threadId)
  if (fresh) push({ kind: 'thread.updated', meta: { ...fresh, running: false } })
  // The thread just went idle: hand off any background agents that finished while this run was busy.
  // Deferred to here (not the moment each agent settled) so a completion never interrupts an
  // in-flight turn or races an explicit agent_result — it wakes the thread cleanly instead.
  flushThreadCompletions(run.threadId, push)
}

/** Render a finished background agent's result as the turn text the thread's model reads next. */
function formatAgentCompletion(agent: BgAgent): string {
  const who = agent.name ? `"${agent.name}"` : `(id ${agent.agentId})`
  if (agent.status === 'error' || !agent.result) {
    return `🤖 Background agent ${who} failed: ${agent.error ?? 'unknown error'}`
  }
  const body = agent.result.text.trim() || '(the agent returned no text)'
  return (
    `🤖 Background agent ${who} finished. Its result is below — fold it into what you are doing, ` +
    `or, if you were waiting on it to answer the user, do so now.\n\n${body}`
  )
}

/**
 * Push a settled background agent's result back into its thread — the moment that actually frees the
 * orchestrator, because it means the model never had to block on `agent_result` to see it. Delivery
 * goes through `send` with a steer disposition, so an idle thread starts a fresh run (the agent
 * *wakes* it) and — in the rare race where a run took the thread in between — the result folds into
 * that run instead. This is the same push-based lane inter-session messaging uses.
 *
 * Crucially, we deliver ONLY when the thread is idle. While a run owns the thread the model can
 * still collect the agent itself with `agent_result`, so auto-delivering then would both duplicate
 * the result and disrupt the in-flight turn; instead the agent stays parked and {@link
 * flushThreadCompletions} delivers it the instant the thread goes idle (or {@link
 * maybeDeliverAgentCompletion} does, if it finished after the thread was already idle).
 *
 * `delivered` makes this exactly-once: if `agent_result` collected the result inline it claimed the
 * agent (set `delivered`) and nothing is pushed. An aborted agent (a per-card Stop, or /clear)
 * delivers nothing — a stopped agent must not wake the thread.
 */
function deliverAgentResult(agent: BgAgent, push: PushFn): void {
  agent.delivered = true
  backgroundAgents.delete(agent.agentId)
  void send({ threadId: agent.threadId, text: formatAgentCompletion(agent), disposition: 'steer' }, push)
}

/** True when no run currently owns the thread for routing (idle to the user). */
function threadIsIdle(threadId: ThreadId): boolean {
  const run = active.get(threadId)
  return !run || !ownsThread(run)
}

/** Whether an agent is settled and still owed a delivery (not collected, not stopped). */
function awaitingDelivery(agent: BgAgent): boolean {
  return agent.status !== 'running' && !agent.delivered && !agent.abort.signal.aborted
}

/**
 * Called when a background agent settles (its promise's `finally`). Delivers immediately if the
 * thread is already idle; otherwise the owning run will flush it via {@link flushThreadCompletions}
 * when it goes idle. A collected or stopped agent is dropped from tracking here so the registry
 * never leaks finished agents.
 */
function maybeDeliverAgentCompletion(agent: BgAgent, push: PushFn): void {
  if (agent.delivered || agent.abort.signal.aborted) {
    backgroundAgents.delete(agent.agentId)
    return
  }
  if (threadIsIdle(agent.threadId)) deliverAgentResult(agent, push)
}

/**
 * Deliver every background agent that has finished for a thread but not yet been collected — invoked
 * the instant the thread goes idle ({@link settleThreadRunning}), so results a run was too busy to
 * carry are handed off (waking the thread) rather than stranded. Still-running agents stay parked
 * and deliver themselves when they finish.
 */
function flushThreadCompletions(threadId: ThreadId, push: PushFn): void {
  for (const agent of threadBackgroundAgents(threadId)) {
    if (awaitingDelivery(agent)) deliverAgentResult(agent, push)
  }
}

/** Move steers that could not reach a model boundary into the normal next-turn queue. */
function requeuePendingSteers(run: ActiveRun, push: PushFn): void {
  if (run.steerQueue.length === 0) return
  const queued: QueuedTurn[] = []
  for (const steer of run.steerQueue) {
    const message = updateMessage(steer.messageId, { runId: undefined, queued: true })
    if (!message) continue
    push({ kind: 'message.updated', message })
    queued.push({
      opts: { ...steer.opts, disposition: 'send' },
      messageId: steer.messageId
    })
  }
  run.steerQueue.length = 0
  // A steer represents the user's next instruction, so it runs before turns explicitly queued
  // behind it while the run was active.
  run.turnQueue = [...queued, ...run.turnQueue]
}

/**
 * Pull image content out of a tool result so the model can actually SEE it.
 *
 * OpenAI-compatible `role:'tool'` messages carry text only, so an image returned by a tool — most
 * importantly a screenshot from a browser/computer-use/simulator MCP server — is invisible if we
 * merely `JSON.stringify` the result: it lands as a giant base64 blob buried in text, which the
 * model reads as gibberish (or the gateway rejects). The fix is to (a) stringify a lightweight,
 * image-free version of the result for the tool message and (b) hand the images back so the caller
 * can re-attach them as a following `user` message — the one form every vision-capable
 * OpenAI-compatible backend renders.
 *
 * Recognizes the MCP content shapes (`{type:'image',data,mimeType}` and an image-bearing
 * `{type:'resource',resource:{blob,mimeType}}`) plus any raw `data:image/*` URL string. A result
 * with no image content is returned structurally unchanged with an empty image list, so non-image
 * tools serialize byte-for-byte as before.
 */
export function extractToolResultImages(result: unknown): {
  sanitized: unknown
  images: WireContentPart[]
} {
  const images: WireContentPart[] = []
  const PLACEHOLDER = '[image content extracted — shown in the following message]'

  // `defaultImage` picks the fallback when the mimeType is missing or non-image: an MCP `image`
  // block is an image by its very type, so it defaults to png; an embedded `resource` may hold
  // anything (a PDF, a text file), so it qualifies only when its mimeType is explicitly an image.
  const toDataUrl = (data: unknown, mime: unknown, defaultImage: boolean): string | null => {
    if (typeof data !== 'string' || data.length === 0) return null
    if (data.startsWith('data:')) return data.startsWith('data:image/') ? data : null
    const isImageMime = typeof mime === 'string' && mime.startsWith('image/')
    if (!isImageMime && !defaultImage) return null
    return `data:${isImageMime ? mime : 'image/png'};base64,${data}`
  }

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      if (node.startsWith('data:image/')) {
        images.push({ type: 'image_url', image_url: { url: node } })
        return PLACEHOLDER
      }
      return node
    }
    if (Array.isArray(node)) return node.map(walk)
    if (!node || typeof node !== 'object') return node
    const obj = node as Record<string, unknown>
    // MCP image content block.
    if (obj.type === 'image') {
      const url = toDataUrl(obj.data, obj.mimeType, true)
      if (url) {
        images.push({ type: 'image_url', image_url: { url } })
        return { type: 'image', mimeType: obj.mimeType ?? 'image/png', note: PLACEHOLDER }
      }
    }
    // MCP embedded resource carrying an inline image blob.
    if (obj.type === 'resource' && obj.resource && typeof obj.resource === 'object') {
      const r = obj.resource as Record<string, unknown>
      const url = toDataUrl(r.blob, r.mimeType, false)
      if (url) {
        images.push({ type: 'image_url', image_url: { url } })
        return { type: 'resource', resource: { uri: r.uri, mimeType: r.mimeType, note: PLACEHOLDER } }
      }
    }
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v)
    return out
  }

  return { sanitized: walk(result), images }
}

/**
 * Append a batch of tool results to a wire transcript. Each result becomes its paired
 * `role:'tool'` message with image content stripped to a small placeholder, and any images the
 * tools returned are re-attached as one following `user` message so a vision-capable model can
 * actually see them (see {@link extractToolResultImages}). Shared by the main run and subagent
 * loops so screenshots work identically in both.
 */
export function appendToolResults(
  wire: WireMessage[],
  calls: { id: string; function: { name: string } }[],
  results: unknown[]
): void {
  const images: WireContentPart[] = []
  calls.forEach((call, i) => {
    const { sanitized, images: found } = extractToolResultImages(results[i])
    wire.push({
      role: 'tool',
      tool_call_id: call.id,
      name: call.function.name,
      content: JSON.stringify(sanitized)
    })
    images.push(...found)
  })
  if (images.length === 0) return
  wire.push({
    role: 'user',
    content: [
      {
        type: 'text',
        text:
          images.length === 1
            ? 'Image returned by the tool call above:'
            : `Images returned by the tool calls above (${images.length}):`
      },
      ...images
    ]
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

  // The assistant reply is streamed into one persisted "segment" bubble. A steer injected at a
  // safe boundary closes the current segment and opens a fresh one (see the boundary handler
  // below), so an interjected instruction sits chronologically BETWEEN the reply it interrupted
  // and the continuation instead of after a single bubble that already answered it. With no steer
  // there is exactly one segment and this is identical to the previous single-message path.
  let currentAssistant = assistant
  let segmentText = ''
  // Tool-call/result exchanges for the CURRENT segment, captured verbatim so a later turn can
  // replay them (the model would otherwise forget everything its tools returned). Reset each time
  // a steer splits the segment, so each persisted assistant bubble owns exactly its own exchanges.
  let segmentToolWire: WireExchange[] = []

  const provider = resolveProvider(model)
  if (!provider) {
    run.acceptingSteers = false
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
    const updated = updateMessage(currentAssistant.id, { text: segmentText })
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
    // Pull fresh CC/Hermes facts at the turn boundary. This keeps the prompt snapshot current
    // without mutating either external store during a model run.
    const workspace = listWorkspaces().find((candidate) => candidate.id === meta.workspaceId)
    if (workspace) syncExternalMemory(workspace)
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
    const sampling = samplingParams(getSettings())
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
      const pendingCalls = new Map<number, { id: string; name: string; args: string; drafted: boolean }>()

      // Real wall-clock start of the current reasoning bout (the moment its first token arrived),
      // undefined when no bout is open. `flushReasoning` persists buffered reasoning while a bout is
      // still going; `closeReasoning` ends the bout, emitting a `reasoning.done` carrying the true
      // span. Both are called at the transitions where reasoning ends — the model starts speaking,
      // drafts a tool call, or the stream finishes — so the persisted timing reflects when the model
      // actually thought rather than the 750ms coalescing cadence.
      let reasoningStartAt: number | undefined
      const flushReasoning = (): void => {
        if (reasoningDeltaBuf) {
          emit({ type: 'reasoning.delta', text: reasoningDeltaBuf, fidelity: 'raw', startedAt: reasoningStartAt })
          reasoningDeltaBuf = ''
        }
      }
      const closeReasoning = (): void => {
        flushReasoning()
        if (reasoningStartAt !== undefined) {
          emit({ type: 'reasoning.done', fidelity: 'raw', durationMs: Math.max(0, Date.now() - reasoningStartAt) })
          reasoningStartAt = undefined
        }
      }

      // Recomputed each round so a find_tools call in the previous round takes effect
      // immediately: the freshly-loaded deferred tools join this request's tool array.
      const roundTools = availableTools(getThreadMeta(threadId) ?? meta)

      // Fresh per-response abort each round so a steer can interrupt THIS reply (see send()'s steer
      // branch) without cancelling the whole run. Combined with run.abort so a real cancel still stops.
      const responseAbort = new AbortController()
      run.responseAbort = responseAbort
      let steerInterrupted = false
      try {
      for await (const chunk of streamChat(provider, {
        model,
        messages: wire,
        tools: roundTools.map(toWireTool),
        effort,
        ...sampling,
        cache: provider.promptCaching ?? true, // opt-OUT: configs saved before the toggle existed still cache
        signal: AbortSignal.any([run.abort.signal, responseAbort.signal])
      })) {
        if (chunk.type === 'text') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          // The model started speaking — end the reasoning bout at its true boundary (now), before
          // the spoken text, so its duration reflects real thinking time.
          closeReasoning()
          text += chunk.text
          responseText += chunk.text
          segmentText += chunk.text
          textDeltaBuf += chunk.text
          scheduleFlush()
        } else if (chunk.type === 'reasoning') {
          if (firstTokenAt === undefined) firstTokenAt = Date.now()
          if (reasoningStartAt === undefined) reasoningStartAt = Date.now() // open a fresh bout
          reasoning += chunk.text
          reasoningDeltaBuf += chunk.text
        } else if (chunk.type === 'usage') {
          usage = mergeUsage(usage, chunk.usage)
        } else if (chunk.type === 'tool_call_delta') {
          const call = pendingCalls.get(chunk.index) ?? { id: '', name: '', args: '', drafted: false }
          if (chunk.id && !call.drafted) call.id = chunk.id // freeze the id once drafted so proposal/execution fold into the same row
          if (chunk.name) call.name = chunk.id ? chunk.name : call.name + chunk.name // id marks a fresh call: assign, so backends that resend the full name per delta don't duplicate it
          if (chunk.argsDelta) call.args += chunk.argsDelta
          pendingCalls.set(chunk.index, call)
          // The moment the model names the tool it's calling, surface a live "drafting" row so the
          // pre-submit phase reads as active thought. Flush any open text/reasoning first so the row
          // lands after them in order. The id is frozen here and reused by the eventual
          // proposal/execution, so all three fold into a single transcript row.
          if (!call.drafted && call.name) {
            if (!call.id) call.id = `call_${runId}_${toolRounds}_${chunk.index}`
            call.drafted = true
            // Close the reasoning bout (flush + done with real span) BEFORE the drafting row so the
            // segment is dated by the model's actual thinking window, not the tool-call instant.
            closeReasoning()
            if (textDeltaBuf) {
              emit({ type: 'text.delta', text: textDeltaBuf })
              textDeltaBuf = ''
            }
            emit({ type: 'tool.drafting', callId: call.id, tool: call.name })
          }
        } else if (chunk.type === 'finish') {
          finishReason = chunk.reason
        }
        // coalesce deltas into periodic persisted events (not per-token)
        if (Date.now() - lastEventFlush > 750 || textDeltaBuf.length + reasoningDeltaBuf.length > 4000) {
          // Persist progress mid-bout WITHOUT closing it: the reasoning is still going, only its
          // accumulated text is flushed (carrying the bout's real start so the segment dates right).
          flushReasoning()
          if (textDeltaBuf) {
            emit({ type: 'text.delta', text: textDeltaBuf })
            textDeltaBuf = ''
          }
          lastEventFlush = Date.now()
        }
      }
      } catch (streamErr) {
        // A steer tripped responseAbort (not the run's abort): stop reading this reply, keep the
        // partial text streamed so far, and fall through to the steer-injection boundary below. A
        // real cancel (run.abort) or any other stream error propagates to the run-level handler.
        if (run.abort.signal.aborted || !responseAbort.signal.aborted) throw streamErr
      }
      // Whether the SSE parser threw on abort or ended cleanly, a tripped responseAbort means a
      // steer preempted this round — set the flag so the tool branch is skipped (a half-parsed
      // tool call is dropped in favour of the steer) and the boundary injects it immediately.
      if (responseAbort.signal.aborted && !run.abort.signal.aborted) steerInterrupted = true
      // Stream ended (or was interrupted): close any open reasoning bout with its true span, then
      // flush trailing spoken text. If the model reasoned and stopped without speaking or calling a
      // tool, this is the only place the bout is closed.
      closeReasoning()
      if (textDeltaBuf) emit({ type: 'text.delta', text: textDeltaBuf })

      if (!steerInterrupted && pendingCalls.size > 0 && !run.abort.signal.aborted) {
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
        const roundStart = wire.length
        // content is nulled — NOT set to responseText — even though the model just streamed that
        // text. It has to be byte-identical to how this same message is persisted and replayed on
        // the next turn (see the segmentToolWire capture below, which stores content:null): the
        // gateway hashes the serialized prefix to find a cache hit, so if the live request carried
        // the pre-tool narration here but the replay dropped it, every turn after a tool call would
        // fail the prefix match and re-process the whole tool transcript uncached. The narration
        // isn't lost — it lives in segmentText (the visible bubble) and is replayed as the trailing
        // assistant message. This also makes a fresh run's later rounds see the exact same transcript
        // a reloaded thread would, instead of the model's view depending on whether it was restarted.
        wire.push({ role: 'assistant', content: null, tool_calls: calls })

        // Execute the batch concurrently — a model that asks for several reads/searches at
        // once shouldn't pay for them serially. Results are appended in call order so the
        // wire transcript stays deterministic regardless of completion order.
        const batchStart = Date.now()
        const spawnSubagent = (spec: SubagentSpec): Promise<SubagentResult> =>
          runSubagentLoop(run, getThreadMeta(threadId) ?? meta, spec, push)
        const results = await Promise.all(
          calls.map((call) =>
            executeToolCall(call.id, call.function.name, call.function.arguments, run, meta, emit, push, spawnSubagent)
          )
        )
        toolMs += Date.now() - batchStart
        appendToolResults(wire, calls, results)
        // Capture this round for cross-turn replay, exactly as sent above so the replayed prefix is
        // byte-identical and stays cacheable: the assistant's tool_calls (content already null — its
        // text lives in the segment's own message and is replayed as the trailing assistant bubble,
        // so keeping it here too would duplicate it), the tool results, and any user-role image
        // carrier appendToolResults added.
        wire.slice(roundStart).forEach((m, i) => {
          segmentToolWire.push(
            i === 0 ? { role: 'assistant', content: null, tool_calls: m.tool_calls } : (m as WireExchange)
          )
        })
        continueLoop = true
        continue
      }

      // safe boundary: model response completed. Inject pending steers and continue.
      if (run.steerQueue.length > 0 && !run.abort.signal.aborted) {
        // Append in place instead of rebuilding from persisted history: a rebuild THREW AWAY the
        // run's in-memory tool exchanges (tool_calls + results live only in `wire`) and re-read
        // the partially-flushed assistant message as a completed turn — so a steer after tool
        // rounds made the model lose its own tool results and re-see its half-finished reply.
        if (responseText) wire.push({ role: 'assistant', content: responseText })
        for (const steer of run.steerQueue) wire.push({ role: 'user', content: steer.opts.text })
        run.steerQueue.length = 0 // the steer messages themselves are already persisted
        continueLoop = true
        // Close this assistant segment and open a fresh one for the post-steer continuation. Each
        // steer's user message was persisted the instant it was typed (an earlier createdAt), so
        // ending the current bubble here and starting a new one keeps transcript order truthful:
        // reply-so-far → steer → continuation. Without the split, the continuation streams into a
        // bubble timestamped before the steer, rendering the model's answer above the interjection.
        currentAssistant = splitAssistantSegment(currentAssistant, segmentText, segmentToolWire, run, model, effort, push)
        segmentText = ''
        segmentToolWire = []
      }
    }
    // An abort landing exactly as a stream finishes (with tool calls or steers pending) exits
    // the loop without throwing — the checks above just skip the work. Without this, that run
    // would finalize as complete/done despite the model's requested tool calls never running.
    run.acceptingSteers = false
    if (run.abort.signal.aborted) {
      if (flushTimer) clearTimeout(flushTimer)
      emit({ type: 'run.completed', reason: 'canceled' })
      finalize(run, currentAssistant, 'interrupted', computeTelemetry(start, firstTokenAt, text, usage, model), push, segmentText, segmentToolWire)
      return
    }
  } catch (err) {
    if (run.abort.signal.aborted) {
      run.acceptingSteers = false
      if (flushTimer) clearTimeout(flushTimer)
      emit({ type: 'run.completed', reason: 'canceled' })
      finalize(run, currentAssistant, 'interrupted', computeTelemetry(start, firstTokenAt, text, usage, model), push, segmentText, segmentToolWire)
      return
    }
    errored = true
    const { category, message, retryable } = classifyError(err)
    emit({ type: 'error', category, message, retryable, detail: err instanceof Error ? (err.stack ?? '') : String(err) })
  }

  // The run remains in `active` while title generation and memory distillation finish. From here
  // on there is no model boundary left to receive a steer, so `send` must queue it as a new turn.
  run.acceptingSteers = false

  // Background subagents (run_agent background:true) deliberately OUTLIVE this turn: they are tracked
  // at thread scope (see backgroundAgents), keep running on their own promises, and deliver their
  // results back into the thread when they finish (deliverAgentCompletion). So — unlike foreground
  // subagents — we do NOT block finalize on them here. Blocking here was the whole reason
  // "background" agents behaved like foreground ones: the thread stayed "running" and the model sat
  // idle until the agent finished. Freeing the turn now is exactly what makes them background.

  if (flushTimer) clearTimeout(flushTimer)
  // A run that "succeeds" with zero visible output reads as broken streaming in the UI (an empty
  // bubble marked complete). The loop only reaches here once the model returned WITHOUT a tool call,
  // so an empty `text` means the turn ended with no user-facing reply at all. This must be surfaced
  // whether or not tools ran earlier: a common local-reasoning-model failure is to reason through
  // the whole turn — even ending mid-intent, "let me call browser_screenshot:" — and then finish
  // (reason "stop") without emitting the tool call OR any content, which used to complete silently as
  // a blank bubble because the old guard only fired when NO tool had run in the turn (toolMs === 0).
  if (!errored && !run.abort.signal.aborted && !text.trim()) {
    const message =
      finishReason === 'length'
        ? 'The model produced no visible text: its output limit was reached during hidden reasoning. Raise max output tokens in Settings → Model, or lower the thinking effort.'
        : reasoning.trim()
          ? 'The model ended its turn inside reasoning without sending a reply — reasoning models sometimes trail off intending to call a tool they never emit. Retry, or try a different model/route.'
          : 'The model returned an empty response. Retry, or try a different model/route.'
    emit({ type: 'error', category: 'malformed_stream', message, retryable: true })
  }
  const telemetry = { ...computeTelemetry(start, firstTokenAt, text, usage, model), toolMs: toolMs || undefined }
  emit({ type: 'usage', usage: telemetry })
  emit({ type: 'run.completed', reason: errored ? 'error' : finishReason === 'length' ? 'length' : 'done' })
  finalize(run, currentAssistant, errored ? 'error' : 'complete', telemetry, push, segmentText, segmentToolWire)

  // The model turn is done. Unless a turn is queued behind it, drop the thread out of "running"
  // NOW — the title generation and memory distillation below are best-effort housekeeping that can
  // take several seconds, and holding "running" through them is what left the Stop button and
  // spinner stuck after the model had visibly finished. A queued turn keeps running:true; the
  // finally hands off to it.
  if (run.turnQueue.length === 0) settleThreadRunning(run, push)

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

  // Self-learning: distill durable memories from the finished exchange and let approved ones flow
  // out to Claude Code + Hermes via the memory bridge. Runs after run.completed so it never delays
  // the user's turn; fully best-effort and gated by the selfLearning setting inside distillMemories.
  if (!errored) {
    try {
      await distillMemories({ meta, model, effort, messages: msgs, provider, push })
    } catch {
      /* self-learning is a convenience; never let it surface as a run failure */
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
  const provider = resolveProvider(model)
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

/**
 * Run an isolated subagent as a nested agentic loop inside the parent run. It shares the
 * parent's abort signal and emits its own events (tagged with a fresh agentId) into the same
 * transcript, but starts from a clean context — only the task, not the thread history. Its
 * final text is returned to the caller as the `run_agent` tool result.
 */
async function runSubagentLoop(
  parent: ActiveRun,
  meta: ThreadMeta,
  spec: SubagentSpec,
  push: PushFn,
  // Callers that track the subagent (background spawns) pass a pre-generated id so they can hold a
  // handle to it before the loop starts; the synchronous path lets it default.
  agentId: string = ulid()
): Promise<SubagentResult> {
  const { runId, threadId } = parent
  const emit = (body: RunEventBody): void => {
    const ev = appendEvent(runId, threadId, body, agentId)
    push({ kind: 'run.event', event: ev })
  }

  // This subagent's own abort, independent of its siblings, so a per-card Stop in the Agents tab
  // can end just this one. It still stops when the whole run is canceled (`onParentAbort` mirrors
  // that in) — parent cancel always wins. Registered on `parent` for `cancelAgent` to find, and
  // torn down in `finally` so a finished/errored agent's id can't be mistaken for a live one.
  const agentAbort = new AbortController()
  if (parent.abort.signal.aborted) agentAbort.abort()
  const onParentAbort = (): void => agentAbort.abort()
  parent.abort.signal.addEventListener('abort', onParentAbort)
  parent.agentAborts.set(agentId, agentAbort)
  // Tool calls this subagent makes need to observe ITS abort, not just the parent's — swap in a
  // thin view of `parent` with `abort` replaced so `executeToolCall` (which only ever reads
  // `run.abort.signal`) naturally stops the subagent's own in-flight tool calls on a per-agent stop.
  const asRun: ActiveRun = { ...parent, abort: agentAbort }

  try {
    const model = spec.model ?? meta.model
    const effort = spec.effort ?? meta.effort

    const provider = resolveProvider(model)
    if (!provider) throw new Error('No provider configured for the subagent.')

    // Subagents cannot spawn further subagents, and run headless so they cannot ask the user;
    // both are stripped. When the parent passed a `tools` allowlist, the set is narrowed to it.
    const tools = subagentTools(meta, spec.tools)
    const toolNames = tools.map((t) => t.name)
    emit({
      type: 'run.started',
      model,
      effort,
      mode: meta.mode,
      parentAgent: parent.runId,
      tools: toolNames,
      name: spec.name,
      agentType: spec.agentType
    })
    console.error(
      `[subagent ${agentId}] ${meta.mode}/${meta.permissionPreset} → ${toolNames.length} tools: ${toolNames.join(', ')}`
    )

    const role = spec.agentType
      ? `You are acting as the "${spec.agentType}" subagent.`
      : 'You are a subagent.'
    const identity = describeActiveModel(model, effort)
    const system = `${SUBAGENT_PROMPT}\n\n${role}${identity ? '\n\n' + identity : ''}`
    const wire: WireMessage[] = [
      { role: 'system', content: system },
      { role: 'user', content: spec.task }
    ]

    const start = Date.now()
    let firstTokenAt: number | undefined
    let text = ''
    let toolCalls = 0
    let usage: Partial<TurnTelemetry> = {}
    // Runaway-loop guard for subagents; 0 (or negative) disables the cap. See maxToolRounds.
    const maxSubagentToolRounds = getSettings().maxSubagentToolRounds ?? 0
    const sampling = samplingParams(getSettings())
    let rounds = 0

    try {
      let continueLoop = true
      while (continueLoop) {
        continueLoop = false
        let responseText = ''
        let textBuf = ''
        let reasoningBuf = ''
        let lastFlush = Date.now()
        const pendingCalls = new Map<number, { id: string; name: string; args: string; drafted: boolean }>()

        // See the main loop: measure each reasoning bout's real span so the transcript's "Thought for
        // …" reflects thinking time, not the coalescing cadence.
        let reasoningStartAt: number | undefined
        const flushReasoning = (): void => {
          if (reasoningBuf) {
            emit({ type: 'reasoning.delta', text: reasoningBuf, fidelity: 'raw', startedAt: reasoningStartAt })
            reasoningBuf = ''
          }
        }
        const closeReasoning = (): void => {
          flushReasoning()
          if (reasoningStartAt !== undefined) {
            emit({ type: 'reasoning.done', fidelity: 'raw', durationMs: Math.max(0, Date.now() - reasoningStartAt) })
            reasoningStartAt = undefined
          }
        }

        // Recomputed each round: a find_tools call last round makes its loads callable now.
        const roundTools = subagentTools(getThreadMeta(threadId) ?? meta, spec.tools)

        for await (const chunk of streamChat(provider, {
          model,
          messages: wire,
          tools: roundTools.map(toWireTool),
          effort,
          ...sampling,
          cache: provider.promptCaching ?? true, // opt-OUT: configs saved before the toggle existed still cache
          signal: agentAbort.signal
        })) {
          if (chunk.type === 'text') {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            closeReasoning() // the model started speaking — end the reasoning bout at its true boundary
            text += chunk.text
            responseText += chunk.text
            textBuf += chunk.text
          } else if (chunk.type === 'reasoning') {
            if (firstTokenAt === undefined) firstTokenAt = Date.now()
            if (reasoningStartAt === undefined) reasoningStartAt = Date.now() // open a fresh bout
            reasoningBuf += chunk.text
          } else if (chunk.type === 'usage') {
            usage = mergeUsage(usage, chunk.usage)
          } else if (chunk.type === 'tool_call_delta') {
            const call = pendingCalls.get(chunk.index) ?? { id: '', name: '', args: '', drafted: false }
            if (chunk.id && !call.drafted) call.id = chunk.id // freeze the id once drafted so proposal/execution fold into the same row
            if (chunk.name) call.name = chunk.id ? chunk.name : call.name + chunk.name // id marks a fresh call: assign, so backends that resend the full name per delta don't duplicate it
            if (chunk.argsDelta) call.args += chunk.argsDelta
            pendingCalls.set(chunk.index, call)
            // Surface the drafted call live (see the main loop for the rationale), flushing open
            // text/reasoning first so the row lands in order.
            if (!call.drafted && call.name) {
              if (!call.id) call.id = `call_${runId}_${agentId}_${rounds}_${chunk.index}`
              call.drafted = true
              closeReasoning() // close the bout with its real span before the drafting row
              if (textBuf) {
                emit({ type: 'text.delta', text: textBuf })
                textBuf = ''
              }
              emit({ type: 'tool.drafting', callId: call.id, tool: call.name })
            }
          }
          if (Date.now() - lastFlush > 750 || textBuf.length + reasoningBuf.length > 4000) {
            flushReasoning() // persist mid-bout progress without ending the bout
            if (textBuf) {
              emit({ type: 'text.delta', text: textBuf })
              textBuf = ''
            }
            lastFlush = Date.now()
          }
        }
        closeReasoning() // stream ended: close any open bout with its true span
        if (textBuf) emit({ type: 'text.delta', text: textBuf })

        if (pendingCalls.size > 0 && !agentAbort.signal.aborted) {
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
          // No runSubagent passed → nested run_agent calls are refused, not recursed. `asRun` (not
          // `parent`) so a per-agent stop also aborts this subagent's own in-flight tool calls.
          const results = await Promise.all(
            calls.map((call) =>
              executeToolCall(call.id, call.function.name, call.function.arguments, asRun, meta, emit, push)
            )
          )
          toolCalls += calls.length
          appendToolResults(wire, calls, results)
          continueLoop = true
        }
      }
    } catch (err) {
      if (agentAbort.signal.aborted) {
        emit({ type: 'run.completed', reason: 'canceled' })
        throw err
      }
      const { category, message, retryable } = classifyError(err)
      emit({ type: 'error', category, message, retryable })
      emit({ type: 'run.completed', reason: 'error' })
      throw new Error(`Subagent failed: ${message}`)
    }

    const telemetry = computeTelemetry(start, firstTokenAt, text, usage, model)
    emit({ type: 'usage', usage: telemetry })
    emit({ type: 'run.completed', reason: 'done' })
    return { text, agentId, toolCalls, toolNames, telemetry }
  } finally {
    parent.abort.signal.removeEventListener('abort', onParentAbort)
    parent.agentAborts.delete(agentId)
  }
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
  // Renaming the current chat is cosmetic self-management — always allowed, never prompts.
  if (tool.name === 'set_thread_title') return 'allow'
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

/**
 * The tools actually sent to the model: the builtin core, plus `find_tools` when any deferred
 * (MCP) tool could run under the current mode/preset, plus whatever deferred tools this thread
 * has already discovered and loaded. Deferred schemas are NOT sent until loaded — that keeps the
 * standing context small (a few connected MCP servers otherwise add tens of thousands of tokens
 * of schema to every request) and lets the model pull capabilities in as a task needs them.
 * Loaded tools append at the end in load order, so the request prefix stays cache-stable.
 */
export function availableTools(meta: ThreadMeta): ToolDefinition[] {
  const core = builtinTools.filter((tool) => toolEffect(tool, meta) !== 'deny')
  const discoverable = deferredTools().some((tool) => toolEffect(tool, meta) !== 'deny')
  const loaded = loadedDeferredTools(meta.id).filter((tool) => toolEffect(tool, meta) !== 'deny')
  return [...core, ...(discoverable ? [findToolsTool] : []), ...loaded]
}

/**
 * The tool set a subagent runs with. Subagents cannot spawn further subagents or block on the
 * user, so `run_agent` and `ask_user` are always stripped. When the parent passes an explicit
 * `allow` list (via `run_agent`'s `tools` arg), the set is further narrowed to those names —
 * letting the parent hand a subagent only the tools its task needs. Filtering starts from
 * `availableTools`, so a subagent can never gain a tool the current mode/preset denies, and any
 * requested name the preset denies is simply absent from the result.
 */
const NOT_FOR_SUBAGENTS = new Set([
  'run_agent',
  'agent_result',
  'job_status',
  'stop_job',
  'ask_user',
  'set_thread_title'
])
export function subagentTools(meta: ThreadMeta, allow?: string[]): ToolDefinition[] {
  let tools = availableTools(meta).filter((tool) => !NOT_FOR_SUBAGENTS.has(tool.name))
  if (allow) {
    const wanted = new Set(allow)
    tools = tools.filter((tool) => wanted.has(tool.name))
  }
  return tools
}

/**
 * Which argument names carry filesystem paths that must be containment-checked before the tool
 * runs. An explicit `pathArgs` always wins. Otherwise we infer `['path']` ONLY for a filesystem
 * tool that actually declares a `path` parameter — so store-backed tools that happen to be tagged
 * `filesystem` (`memory_save`, `memory_search`, `todo_write`) are not falsely rejected for a
 * missing path they never take. A filesystem tool with differently-named paths must declare them
 * (as `fs_move` does with `['from','to']`).
 */
export function pathArgsFor(tool: ToolDefinition): string[] {
  if (tool.pathArgs) return tool.pathArgs
  const props = ((tool.parameters as { properties?: Record<string, unknown> })?.properties) ?? {}
  return tool.resource === 'filesystem' && 'path' in props ? ['path'] : []
}

export function toWireTool(tool: ToolDefinition) {
  return {
    type: 'function' as const,
    function: { name: tool.name, description: tool.description, parameters: tool.parameters }
  }
}

/** The mutating filesystem tools whose effect we snapshot for the Files inspector's session diff. */
const FS_DIFF_TOOLS = new Set(['fs_write', 'fs_edit', 'fs_delete', 'fs_move'])
/** Content beyond this is clipped when captured for a diff (matches the fs read cap). */
const FS_DIFF_CAP = 256 * 1024

/** Read a file as diff text, or null if it is missing or binary (a NUL byte ⇒ not diffable text). */
async function readTextForDiff(path: string): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const buf = await readFile(path)
    if (buf.includes(0)) return null
    if (buf.length > FS_DIFF_CAP) return { text: buf.toString('utf8', 0, FS_DIFF_CAP), truncated: true }
    return { text: buf.toString('utf8'), truncated: false }
  } catch {
    return null
  }
}

/** The path(s) a mutating fs tool affects — a move touches both endpoints. */
function fsDiffPaths(name: string, args: Record<string, unknown>, ctx: ToolContext): string[] {
  try {
    if (name === 'fs_move') return [resolveToolPath(String(args.from), ctx), resolveToolPath(String(args.to), ctx)]
    if (typeof args.path === 'string') return [resolveToolPath(args.path, ctx)]
  } catch {
    // resolveToolPath can throw on a malformed path; nothing to snapshot then.
  }
  return []
}

/**
 * Snapshot the before/after content of the file(s) a mutating fs tool touched and persist the change
 * for the Files inspector. Best-effort: any capture failure is swallowed so it never affects the run.
 */
async function captureFileDiff(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
  threadId: ThreadId,
  before: Map<string, { text: string; truncated: boolean } | null>,
  push: PushFn
): Promise<void> {
  try {
    const paths = fsDiffPaths(name, args, ctx)
    if (paths.length === 0) return
    let changed = false
    for (const path of paths) {
      const b = before.get(path) ?? null
      const a = await readTextForDiff(path)
      // Nothing to record if the file was and remains absent/binary (e.g. a no-op or a binary write).
      if (b === null && a === null) continue
      recordFileChange({
        threadId,
        path,
        before: b?.text ?? null,
        after: a?.text ?? null,
        beforeTruncated: b?.truncated,
        afterTruncated: a?.truncated
      })
      changed = true
    }
    if (changed) push({ kind: 'files.changed', threadId })
  } catch {
    // never let diff capture disturb the run
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
  runSubagent?: (spec: SubagentSpec) => Promise<SubagentResult>
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
  const ask = runSubagent
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
  // Background subagents: only the top-level run (the one holding `runSubagent`) may spawn or
  // collect them — a subagent can neither spawn nor track further agents.
  const spawnBackgroundAgent = runSubagent
    ? (spec: SubagentSpec): { agentId: string; name?: string } => {
        const agentId = ulid()
        const threadId = run.threadId
        // A background agent outlives the run that spawned it, so it cannot borrow that run's abort.
        // Give it its own controller (what cancelAgent / thread-clear abort) and a standalone carrier
        // — a run-shaped context that is NOT in `active` — so runSubagentLoop's event tagging and
        // per-call abort chaining keep working without tying the agent's life to the spawning turn.
        // Parent cancel is wired in explicitly: aborting the spawning run also aborts this agent.
        const agentAbort = new AbortController()
        if (run.abort.signal.aborted) agentAbort.abort()
        else run.abort.signal.addEventListener('abort', () => agentAbort.abort(), { once: true })
        const carrier: ActiveRun = {
          runId: run.runId,
          threadId,
          abort: agentAbort,
          steerQueue: [],
          turnQueue: [],
          acceptingSteers: false,
          settled: true,
          assistantMessageId: '',
          agentAborts: new Map()
        }
        const entry: BgAgent = {
          agentId,
          threadId,
          name: spec.name,
          status: 'running',
          abort: agentAbort,
          delivered: false,
          promise: undefined as never
        }
        const p = runSubagentLoop(carrier, getThreadMeta(threadId) ?? currentMeta, spec, push, agentId).then(
          (res) => {
            entry.status = 'done'
            entry.result = res
            return res
          },
          (err) => {
            entry.status = 'error'
            entry.error = err instanceof Error ? err.message : String(err)
            throw err
          }
        )
        // Mark the rejection handled so an uncollected failure never surfaces as an unhandled
        // rejection; collectAgents and the completion handler observe status/result off `entry`.
        p.catch(() => {})
        entry.promise = p
        backgroundAgents.set(agentId, entry)
        // Push the result back into the thread when it settles — the notify-on-completion lane that
        // lets the orchestrator end its turn instead of blocking. Runs whether it resolved or
        // rejected (finally); delivers now only if the thread is already idle, otherwise the owning
        // run flushes it on settle. A no-op if agent_result already collected it inline. The trailing
        // catch swallows the rejection that `finally` re-raises for a failed agent (its error is
        // already captured on `entry` above and delivered as an error completion) — without it that
        // passthrough rejection would surface as an unhandledRejection.
        void p.finally(() => maybeDeliverAgentCompletion(entry, push)).catch(() => {})
        return { agentId, name: spec.name }
      }
    : undefined
  const collectAgents = runSubagent
    ? async (opts: { agents?: string[]; wait: boolean }): Promise<BackgroundAgentStatus[]> => {
        const want = opts.agents && opts.agents.length ? new Set(opts.agents) : null
        const targets = threadBackgroundAgents(run.threadId).filter(
          (a) => !want || want.has(a.agentId) || (a.name !== undefined && want.has(a.name))
        )
        // Waiting means the model is reading these results inline right now, so claim them: the
        // auto-delivery handler must not ALSO push them back as a turn. (A wait:false peek only
        // claims the ones already terminal — a still-running agent it merely glimpsed will still be
        // delivered when it finishes.) Claiming before the await closes the race with `finally`.
        for (const a of targets) if (opts.wait || a.status !== 'running') a.delivered = true
        if (opts.wait) await Promise.allSettled(targets.map((a) => a.promise))
        return targets.map((a) => ({
          agentId: a.agentId,
          name: a.name,
          status: a.status,
          ...(a.result
            ? { result: a.result.text, toolCalls: a.result.toolCalls, tools: a.result.toolNames }
            : {}),
          ...(a.error ? { error: a.error } : {})
        }))
      }
    : undefined
  const toolContext = {
    threadMeta: currentMeta,
    workspace,
    runId: run.runId,
    signal: run.abort.signal,
    runSubagent,
    ask,
    spawnBackgroundAgent,
    collectAgents
  }
  const pathArgs = pathArgsFor(tool)
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
  // Snapshot the pre-edit content of any file this tool is about to change, so the Files inspector
  // can show a real before→after diff once it completes.
  const fsBefore = new Map<string, { text: string; truncated: boolean } | null>()
  if (FS_DIFF_TOOLS.has(name)) {
    for (const path of fsDiffPaths(name, args, toolContext)) fsBefore.set(path, await readTextForDiff(path))
  }
  try {
    const result = await tool.run(args, toolContext)
    if (FS_DIFF_TOOLS.has(name)) await captureFileDiff(name, args, toolContext, run.threadId, fsBefore, push)
    if (name === 'memory_save') push({ kind: 'memory.updated' })
    if (name === 'set_thread_title') {
      // The model renamed the chat — refresh the sidebar/header live (mirrors the auto-title push).
      const fresh = getThreadMeta(run.threadId)
      if (fresh) push({ kind: 'thread.updated', meta: { ...fresh, running: true } })
    }
    if (name === 'todo_write')
      push({ kind: 'todos.updated', threadId: run.threadId, todos: listTodos(run.threadId) })
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
  text?: string,
  toolExchanges?: WireExchange[]
): void {
  const updated = updateMessage(assistant.id, {
    text: text ?? assistant.text,
    status,
    telemetry,
    // Persist the turn's tool exchanges on the producing message so later turns replay them.
    ...(toolExchanges && toolExchanges.length ? { toolExchanges } : {})
  })
  if (updated) push({ kind: 'message.updated', message: updated })
}

/**
 * Close the current assistant bubble at a steer boundary and return a fresh one for the
 * continuation. A segment with visible text is finalized as a complete message; an empty one
 * (the model produced nothing before the steer landed) is removed so the transcript shows no
 * blank bubble. The replacement is timestamped now — after the steer's already-persisted user
 * message — so chronological ordering places the interjection between the two assistant turns
 * instead of after a bubble that would otherwise absorb the model's answer to it.
 */
function splitAssistantSegment(
  closing: ChatMessage,
  segmentText: string,
  toolExchanges: WireExchange[],
  run: ActiveRun,
  model: string,
  effort: string | undefined,
  push: PushFn
): ChatMessage {
  // Keep the bubble if it has visible text OR tool exchanges to carry — a segment that only ran
  // tools before the steer landed has no text but still must persist its exchanges for replay.
  if (segmentText.trim() || toolExchanges.length) {
    const done = updateMessage(closing.id, {
      text: segmentText,
      status: 'complete',
      ...(toolExchanges.length ? { toolExchanges } : {})
    })
    if (done) push({ kind: 'message.updated', message: done })
  } else {
    deleteMessage(closing.id)
    push({ kind: 'message.deleted', threadId: run.threadId, messageId: closing.id })
  }
  const next: ChatMessage = {
    id: ulid(),
    threadId: run.threadId,
    runId: run.runId,
    role: 'assistant',
    createdAt: Date.now(),
    text: '',
    model,
    effort
  }
  insertMessage(next)
  push({ kind: 'message.updated', message: next })
  return next
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
  const tokensOut = usage.tokensOut ?? estTokens(text)
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

/**
 * The provider that should serve `model`: with several providers enabled, the one whose cached
 * model listing includes the id; otherwise the first enabled one (the single-provider case).
 */
function resolveProvider(model?: string): ProviderConfig | null {
  return providerForModel(model, getSettings().providers)
}

/**
 * Per-request sampling overrides from Settings. Both are opt-in: `temperature` is sent only
 * when the user set a concrete number (null → the provider/model default is used), and
 * `maxTokens` only when a positive cap is configured (0 → provider/model default). Returning
 * `undefined` for each keeps the field out of the request body entirely. Pure in its argument
 * so it can be unit-tested without the settings store.
 */
export function samplingParams(
  s: Pick<AppSettings, 'temperature' | 'maxOutputTokens'>
): { temperature?: number; maxTokens?: number } {
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
  if (has('send_message'))
    notes.push(
      'You CAN message other sessions: `list_sessions` shows the other threads you can reach, ' +
        '`send_message` sends one a message (delivered live if it is running, else to its inbox), and ' +
        '`check_inbox` reads messages other sessions sent you. Use them to coordinate with, hand off ' +
        'to, or ask another session — not to talk to the current user (use `ask_user` for that).'
    )
  if (has('agent_result'))
    notes.push(
      'You can run subagents in the BACKGROUND: call `run_agent` with `background: true` to launch ' +
        'one without waiting and get a handle back immediately. You do NOT have to sit and wait for ' +
        'it — its result is delivered back to you automatically when it finishes, as a new turn, so ' +
        'you are free to keep working, hand control to the person with `ask_user`, or simply end ' +
        'your turn. Spawn several this way to run independent work in parallel; each reports back on ' +
        'its own. Use `agent_result` only when you deliberately want to block until specific agents ' +
        'finish (or `agent_result` with wait:false to peek at their status) — it is never required.'
    )
  if (has('job_status') && has('shell'))
    notes.push(
      'A long task (a download, a build, a big test run) must NOT block you: run `shell` with ' +
        '`background: true` to start it detached and get a jobId back immediately. It keeps running ' +
        'after this turn, so move on with other work or hand control to the person. Read its output ' +
        'or wait for it with `job_status`, and cancel it with `stop_job`.'
    )
  if (has('find_tools'))
    notes.push(
      'This list is NOT everything: connected integrations provide more tools that load on ' +
        'demand. When a task needs a capability you do not see here, call `find_tools` with task ' +
        'keywords instead of saying you lack the capability.'
    )
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

/** Ceilings on the injected `# Memory` block so it can't grow without bound as self-learning and
 *  imports accumulate. Only PINNED memories ride in the standing prompt (everything else is
 *  recalled on demand via `memory_search`), so these ceilings bound the pinned set. */
export const MEMORY_PROMPT_MAX_ITEMS = 40
export const MEMORY_PROMPT_MAX_CHARS = 6000

/**
 * Static "how to recall memory" instruction. Deliberately contains no counts, no item list, and
 * no dynamic text: it is byte-identical every turn, so it never invalidates the cached prompt
 * prefix the way the old inline memory dump (recency-ordered, re-sorted whenever any memory was
 * touched) did on nearly every turn.
 */
export const MEMORY_RECALL_NOTE =
  'You have a persistent memory store of the user’s saved preferences, facts, decisions, ' +
  'environment notes, and warnings. It is NOT preloaded into this conversation. Before answering ' +
  'anything that could plausibly depend on stored context — the user’s preferences, past ' +
  'decisions, project facts, prior warnings — call `memory_search` with a few keywords and use ' +
  'what comes back. Skip the lookup for questions that clearly cannot depend on stored context. ' +
  'Save new durable facts with `memory_save`.'

/**
 * The `# Memory` system-prompt section: the static recall instruction, plus the pinned memories
 * (the ones the user explicitly wants in every prompt) inlined in STABLE id order. Stable order
 * matters: sorting by recency — the old behavior — reshuffled the block whenever any memory was
 * used or updated, busting the prompt cache. Returns '' when memory injection is off entirely.
 */
export function memoryPromptSection(memories: MemoryItem[]): string {
  let section = '# Memory\n' + MEMORY_RECALL_NOTE
  const pinned = selectMemoriesForPrompt(memories.filter((m) => m.pinned)).sort((a, b) =>
    a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  )
  if (pinned.length) {
    section +=
      '\n\nPinned memories (always in effect):\n' +
      pinned.map((m) => `- [${m.type}] ${m.content}`).join('\n')
  }
  return section
}

/**
 * Curate the memories to inject into the prompt: pinned first, then most-recently used/updated,
 * stopping at the item and character ceilings. Keeps the standing memory context bounded even when
 * the store holds hundreds of learned/imported facts. Pure and order-stable for a given store.
 */
export function selectMemoriesForPrompt(
  memories: MemoryItem[],
  maxItems = MEMORY_PROMPT_MAX_ITEMS,
  maxChars = MEMORY_PROMPT_MAX_CHARS
): MemoryItem[] {
  const recency = (m: MemoryItem): number => m.lastUsedAt ?? m.updatedAt ?? m.createdAt ?? 0
  const ordered = [...memories].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1
    return recency(b) - recency(a)
  })
  const out: MemoryItem[] = []
  let chars = 0
  for (const m of ordered) {
    if (out.length >= maxItems) break
    const cost = m.content.length + 8 // "- [type] " framing
    if (out.length > 0 && chars + cost > maxChars) continue // always keep at least the top item
    out.push(m)
    chars += cost
  }
  return out
}

// ---------- stale tool-result pruning ----------

/**
 * How many of the most-recent tool-bearing assistant turns keep their tool results in full. Older
 * turns' result bodies are pruned to a placeholder. Kept generous so pruning only bites on genuinely
 * long threads — the recent working set (what the model is actively reasoning over) is never touched.
 */
export const TOOL_RESULT_KEEP_RECENT_TURNS = 6
/**
 * Only prune a tool result whose body is larger than this. Small results (a status object, a short
 * confirmation) cost almost nothing to keep and are more useful intact, so pruning them would just
 * churn the cache for no real saving.
 */
export const TOOL_RESULT_PRUNE_MIN_TOKENS = 512

const EMPTY_ID_SET: ReadonlySet<MessageId> = new Set<MessageId>()

/**
 * A byte-stable placeholder for a pruned tool result. It encodes ONLY the tool name and the result's
 * original token size — never anything that changes turn to turn (like how far back the turn is) —
 * so once a result crosses the staleness boundary its pruned form is identical on every subsequent
 * request. That keeps the cache prefix stable: pruning invalidates the cache the one turn it happens,
 * not repeatedly. The text tells the model the result is recoverable so it re-runs the tool if needed.
 */
export function prunedResultPlaceholder(name: string | undefined, originalTokens: number): string {
  const which = name ? `\`${name}\` ` : ''
  return `[Stale ${which}result pruned to save context — it returned ~${originalTokens} tokens earlier in this conversation. Re-run the tool if you need its output again.]`
}

const STALE_IMAGE_PLACEHOLDER = '[Stale tool-returned image pruned to save context.]'

/**
 * Identify the tool-bearing assistant turns that are old enough to prune: everything except the most
 * recent {@link TOOL_RESULT_KEEP_RECENT_TURNS}. Compacted turns are ignored (they are not re-sent at
 * all). Pure over the message list so it is trivially testable and shared by the budget estimator.
 */
export function staleToolTurnIds(
  msgs: ChatMessage[],
  keepRecent = TOOL_RESULT_KEEP_RECENT_TURNS
): ReadonlySet<MessageId> {
  const toolTurns = msgs.filter(
    (m) => !m.compacted && m.role === 'assistant' && m.toolExchanges && m.toolExchanges.length > 0
  )
  const staleCount = Math.max(0, toolTurns.length - keepRecent)
  if (staleCount === 0) return EMPTY_ID_SET
  return new Set(toolTurns.slice(0, staleCount).map((m) => m.id))
}

/**
 * Return a copy of one turn's exchanges with large tool-result bodies (and any tool-returned images)
 * replaced by compact placeholders. The assistant `tool_calls` message and every result's
 * `tool_call_id`/`name` are preserved, so the assistant↔tool pairing the wire format requires stays
 * valid — only the heavy content is shed.
 */
export function pruneStaleExchanges(exchanges: WireExchange[]): WireExchange[] {
  return exchanges.map((ex) => {
    if (ex.role === 'tool' && typeof ex.content === 'string') {
      // Counted with the default encoding (no model), never the thread's current model, so the
      // placeholder is identical no matter which model is active — a mid-thread model switch must
      // not rewrite already-pruned history and bust the cache.
      const original = countTokens(ex.content)
      if (original > TOOL_RESULT_PRUNE_MIN_TOKENS)
        return { ...ex, content: prunedResultPlaceholder(ex.name, original) }
      return ex
    }
    // The user-role carrier that re-attaches images a tool returned: drop the heavy image parts,
    // keep any text so the message stays non-empty and validly shaped.
    if (ex.role === 'user' && Array.isArray(ex.content) && ex.content.some((p) => p.type === 'image_url')) {
      const kept = ex.content.filter((p) => p.type !== 'image_url')
      const parts = kept.length > 0 ? kept : [{ type: 'text' as const, text: STALE_IMAGE_PLACEHOLDER }]
      return { ...ex, content: parts }
    }
    return ex
  })
}

/**
 * Tokens reclaimed from the current thread's wire by stale tool-result pruning — the difference
 * between the full result bodies and their placeholders, summed over the stale turns. Surfaced in the
 * context budget for the inspector; returns 0 when pruning is off or nothing is stale.
 */
export function reclaimedByToolPruning(threadId: ThreadId): number {
  if (getSettings().pruneToolResults === false) return 0
  const msgs = listMessages(threadId)
  const stale = staleToolTurnIds(msgs)
  if (stale.size === 0) return 0
  let reclaimed = 0
  for (const m of msgs) {
    if (!stale.has(m.id) || !m.toolExchanges) continue
    // Mirror pruneStaleExchanges exactly (same default encoding, same threshold) so this reports the
    // real saving rather than a differently-counted estimate.
    for (const ex of m.toolExchanges) {
      if (ex.role === 'tool' && typeof ex.content === 'string') {
        const original = countTokens(ex.content)
        if (original > TOOL_RESULT_PRUNE_MIN_TOKENS)
          reclaimed += original - countTokens(prunedResultPlaceholder(ex.name, original))
      } else if (ex.role === 'user' && Array.isArray(ex.content)) {
        for (const p of ex.content)
          if (p.type === 'image_url')
            reclaimed += IMAGE_TOKEN_ESTIMATE - countTokens(STALE_IMAGE_PLACEHOLDER)
      }
    }
  }
  return Math.max(0, reclaimed)
}

export function buildWireMessages(
  threadId: ThreadId,
  meta: ThreadMeta,
  model?: string,
  effort?: string
): WireMessage[] {
  const wire: WireMessage[] = []
  const settings = getSettings()
  const memories = settings.includeMemory
    ? listMemory().filter(
        (m) =>
          m.status === 'approved' &&
          (!m.expiresAt || m.expiresAt > Date.now()) &&
          (m.scope === 'user' ||
            ((m.scope === 'workspace' || m.scope === 'project') &&
              (!m.scopeId || m.scopeId === meta.workspaceId)) ||
            (m.scope === 'thread' && m.scopeId === threadId))
      )
    : null
  let system = SYSTEM_PROMPT
  const identity = describeActiveModel(model, effort)
  if (identity) system += '\n\n' + identity
  // The inventory lists only the stable core (builtins + find_tools) — never the deferred tools
  // a thread has loaded. Loaded schemas ride in the request's tools array; keeping them out of
  // the system prompt keeps it byte-identical across loads, so loading a tool costs one cache
  // write in the tools section instead of invalidating the whole prompt every turn after.
  system += '\n\n' + describeTools(availableTools(meta).filter((t) => !t.mcpServerId))
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
  // Memory rides as a static recall instruction + pinned items only — the rest is pulled on
  // demand with memory_search. Keeps the first-message context small and the prefix cacheable.
  if (memories) system += '\n\n' + memoryPromptSection(memories)
  wire.push({ role: 'system', content: system })

  const msgs = listMessages(threadId)
  // Tool results from turns well in the past are the largest, least-useful bulk in a long thread's
  // context (a 50 KB file read the model consumed ten turns ago rarely needs to sit in the window
  // verbatim). Identify those stale tool-bearing turns so their result bodies can be replaced with a
  // compact, byte-stable placeholder while the recent ones stay intact. Disabled → empty set.
  const staleTurns = getSettings().pruneToolResults === false ? EMPTY_ID_SET : staleToolTurnIds(msgs)

  for (const msg of msgs) {
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
    } else if (msg.role === 'assistant') {
      // Replay the tool exchanges this turn produced (assistant tool_calls → results → any tool
      // images) BEFORE its visible text, so the model re-sees what its own tools returned on
      // earlier turns instead of losing it. The stored exchanges are complete rounds (every
      // tool_call has its result), so the wire stays valid.
      if (msg.toolExchanges?.length) {
        const exchanges = staleTurns.has(msg.id)
          ? pruneStaleExchanges(msg.toolExchanges)
          : msg.toolExchanges
        for (const ex of exchanges) wire.push(ex as WireMessage)
      }
      if (msg.text) wire.push({ role: 'assistant', content: msg.text })
    }
  }
  return wire
}

/**
 * A concrete execution contract for the model. General reminders to "be thorough" are easy to
 * satisfy with a single plausible attempt; this protocol makes recovery and verification explicit.
 * Keep it static so it remains part of the cacheable system-prompt prefix.
 */
export const AGENTIC_EXECUTION_PROTOCOL = `## Execution contract

Treat every request as a set of outcomes to achieve, not as a request to make one attempt. Work through this loop:

1. Define the deliverables, constraints, and acceptance checks. For a multi-part task, create a checklist with todo_write and keep one item per real outcome.
2. Inspect before acting. Look at the current state, identify the relevant tools and integrations, and use find_tools when it is available and a needed capability is not in the loaded tool list. Delegate independent work with run_agent when that improves coverage or speed.
3. Execute the work. Do not stop after making a plan, performing one tool call, or obtaining the first plausible result.
4. Recover deliberately after every tool result. Check whether it succeeded, is complete, and is supported by evidence. A failed, denied, empty, partial, stale, or ambiguous result is not completion. Diagnose the cause and try the next reasonable distinct route: a different tool, query or command, path or argument, narrower or broader scope, or another available integration. Never repeat an identical failed attempt without changing something relevant. Before retrying a consequential or potentially duplicate external action after an ambiguous result, inspect the current state or receipt so you do not perform it twice. If ask_user is available, use it only when a user-owned decision or missing information/credential genuinely blocks progress; never use it to request tool permission or approval. Otherwise continue autonomously.
5. Verify each deliverable with an independent check: re-read or inspect the resulting artifact, run the relevant test or sanity check, confirm an external action's resulting state or receipt, and cross-check research when accuracy depends on it.
6. Run a completion audit before replying. Revisit every deliverable and mark it done only when the acceptance check has evidence. Continue working if anything is missing or verification failed. Stop only when all outcomes are complete or a real external blocker remains. Never claim success based only on an intention, plan, tool invocation, or assumption. If blocked, state the exact blocker, evidence, routes already attempted, and the smallest next action or user input needed.

Try reasonable distinct approaches until the task succeeds; do not perform pointless retries or keep changing a solution that has already been verified. Do not invent extra scope beyond the user's goal.`

const SYSTEM_PROMPT = `You are Lattice, a capable assistant running inside a local-first desktop control room for agentic work. Answer in well-structured GitHub-flavored Markdown. Be direct and technically precise. For large, independent, or context-heavy sub-tasks (broad searches, parallelizable work), delegate to a subagent with the run_agent tool and build on what it returns.

${AGENTIC_EXECUTION_PROTOCOL}

The marginal cost of completeness is near zero, so do the whole thing and do it right. Search before building, and prefer the permanent fix over a workaround when the real fix is within reach. Ship the finished product — with the tests and the documentation it needs — not a plan to build it or a partial cut with dangling threads. When a loose end can be tied off in a few more minutes, tie it off. Time, fatigue, and complexity are not reasons to stop short. The standard is not "good enough" — it is work that is genuinely, verifiably done. (Balance this against the user's actual scope: finish what the task truly entails, but don't invent unrequested scope or gold-plate past what was asked.)

For any task larger than a couple of steps, begin by laying out a plan with the todo_write tool — one checklist item per meaningful step — before you start executing. Then keep it live as you go: mark an item in_progress when you pick it up and done the moment it's finished, and add, split, or revise items as the real shape of the work emerges. Do this as you execute, not as an afterthought at the end. The checklist keeps the person watching the run oriented and makes what's left obvious. Only skip it for genuinely small, single-step tasks where a checklist would be pure overhead.

When you need — or would simply benefit from — clarification that only the user can give, use the ask_user tool to ask them directly rather than guessing or stalling. That includes a choice between real alternatives, an ambiguous or underspecified requirement, a missing detail, or confirmation before a consequential or hard-to-reverse action — and also cases where a quick question would meaningfully change your approach and save wasted work. When in doubt between guessing and asking, ask. When the answer is a choice, always provide options: your single recommended pick plus a few real alternatives (four total is ideal), and mark the best one recommended — the user is always additionally offered a free-form field to write their own answer, so never add an "Other" option yourself. Prefer a single well-formed question over many round-trips. Do not use ask_user for things you can resolve yourself from the conversation, the files, or a sensible default, and do not use it to request permission to run tools — the permission system handles that. The run pauses until the user answers; a canceled or empty answer means they declined, so proceed sensibly or explain what you need instead of re-asking.

The person can interject while you are still working. A new message from them mid-task is almost always a steer — a course correction — not a request to throw away what you have done and start over. Read it against the work in flight: if it refines or redirects the current goal, fold it in and re-plan from where you are, keeping results you have already produced and verified; if it is a small correction, apply it and continue; if it genuinely replaces the task, switch. When it conflicts with an earlier instruction, the newer message wins. Acknowledge what changed and keep going — do not restart from scratch or silently ignore the interjection.`

const SUBAGENT_PROMPT = `You are a Lattice subagent, spawned to complete one bounded task delegated by a parent agent. You have a fresh, isolated context: you can see only the task you were given, not the parent conversation. Work autonomously with your tools, then return a single, self-contained final message that fully answers the task — include the concrete results (findings, file paths, values), not a description of what you did. Be concise and factual; your final message becomes the tool result the parent reads.

${AGENTIC_EXECUTION_PROTOCOL}

You cannot spawn another subagent or ask the user. If the task is genuinely blocked by missing information or access, report that precisely to the parent along with the attempts and evidence; do not guess.`

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

/**
 * Token count for a text run, backed by a real BPE tokenizer (see {@link countTokens}) rather than
 * the old ~4-chars/token heuristic. Model-agnostic here (o200k_base default); callers that know the
 * thread's model pass it through {@link countTokens} directly for family-correct counting.
 */
export const estTokens = (s: string): number => countTokens(s)

/**
 * A vision model tokenizes an image from its resolution to a small, fixed cost — it does NOT
 * charge for the length of the base64 data URL that carries it. Counting the data URL as text
 * (a "small" image is still hundreds of KB) inflated the history estimate by tens of thousands
 * of phantom tokens per attached image. This flat per-image figure is a deliberately rough stand-in
 * (one high-detail tile lands in this ballpark); we don't have the decoded dimensions here to do better.
 */
export const IMAGE_TOKEN_ESTIMATE = 1_200

/** Estimated tokens for one assembled wire message, pricing image parts flat and text by length. */
function wireMessageTokens(m: WireMessage, model?: string): number {
  const content = m.content
  if (typeof content === 'string') return countTokens(content, model)
  if (Array.isArray(content))
    return content.reduce(
      (n, part) => n + (part.type === 'image_url' ? IMAGE_TOKEN_ESTIMATE : countTokens(part.text ?? '', model)),
      0
    )
  return 0
}

export function getContextBudget(threadId: ThreadId, models: ModelInfo[]): ContextBudget | null {
  const meta = getThreadMeta(threadId)
  if (!meta) return null
  const model = models.find((m) => m.id === meta.model)
  const contextLength = model?.contextLength ?? 128000
  // Keep the reply reserve small so usable room stays close to the full window.
  // A few thousand tokens covers a normal reply; we don't pre-carve 25% of the
  // window for it. Cap by the model's own max output when that's smaller.
  const maxOut = Math.min(model?.maxOutputTokens ?? 4096, 4096)

  // Estimate from the ACTUAL request a fresh turn would send, not a re-derivation that drifts
  // from it. buildWireMessages is the single source of truth: the system message it assembles
  // carries the model-identity block, the full tool inventory, the execution protocol, the mode
  // framing, custom instructions, the goal, and memory — none of which a hand-rolled
  // `est(SYSTEM_PROMPT)` accounted for, which is why totals read absurdly low. Measuring the wire
  // also prices image attachments correctly (flat, not by data-URL length) and counts exactly the
  // history that is re-sent: live messages plus any compaction summary, never the folded-away ones.
  const wire = buildWireMessages(threadId, meta, meta.model, meta.effort)
  let systemTokens = 0
  let history = 0
  let seenBaseSystem = false
  for (const m of wire) {
    // The first system message is the assembled system prompt; any later system message is a
    // compaction summary standing in for folded-away history, so it counts toward history.
    if (m.role === 'system' && !seenBaseSystem) {
      systemTokens += wireMessageTokens(m, meta.model)
      seenBaseSystem = true
    } else {
      history += wireMessageTokens(m, meta.model)
    }
  }
  // Tool JSON schemas ride in the request's `tools` array, separate from the messages.
  const toolTokens = availableTools(meta).reduce(
    (total, tool) => total + countTokens(JSON.stringify(toWireTool(tool)), meta.model),
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
  // How much room stale tool-result pruning has already reclaimed from the wire measured above —
  // surfaced so the Context inspector can show it, not re-subtracted (the `history` count already
  // reflects the pruned bodies, since it measures the same wire `buildWireMessages` returns).
  const prunedTokens = reclaimedByToolPruning(threadId)
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
    exact: false,
    ...(prunedTokens > 0 ? { prunedTokens } : {})
  }
}

// ---------- compaction (/compact) ----------

/**
 * Compact the thread's live history into a single summary message. Every currently-live
 * message (including any earlier summary) is summarized by the model, marked `compacted`
 * so it is no longer sent in full, and replaced by one `system`-role summary message. The
 * transcript keeps the originals (dimmed) for the reader; the model sees only the summary.
 */
export async function compactThread(
  threadId: ThreadId,
  push: PushFn,
  opts: { preserveMessageId?: MessageId; keepRunning?: boolean } = {}
): Promise<CompactResult> {
  if (isRunning(threadId)) return { ok: false, reason: 'A run is in progress. Stop it before compacting.' }
  const meta = getThreadMeta(threadId)
  if (!meta) return { ok: false, reason: 'Thread not found.' }

  const est = (s: string): number => countTokens(s, meta.model)
  // `preserveMessageId` keeps the current turn (the just-sent user message auto-compaction runs
  // ahead of) live and verbatim, so only the history behind it is folded into the summary.
  const live = listMessages(threadId).filter(
    (m) => !m.compacted && m.text.trim() && m.id !== opts.preserveMessageId
  )
  // Need a real conversation to compact — at least a couple of exchanges.
  if (live.filter((m) => m.role === 'user' || m.role === 'assistant').length < 3) {
    return { ok: false, reason: 'Not enough conversation to compact yet.' }
  }
  const provider = resolveProvider(meta.model)
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
  releaseSeqCounter(compactionRunId) // one-shot run id; its counter would otherwise leak

  // Re-push the whole message set so the renderer reflects the dimmed originals + summary.
  for (const m of listMessages(threadId)) push({ kind: 'message.updated', message: m })
  // Mark the thread idle again — unless a run is about to start on top of this compaction (auto-
  // compaction), in which case leaving `running` true avoids a spinner flicker between the two.
  const fresh = getThreadMeta(threadId)
  if (fresh && !opts.keepRunning) push({ kind: 'thread.updated', meta: { ...fresh, running: false } })
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
  // Copy the parent's live conversation as the fork's starting context. A message carries forward
  // if it has visible text OR tool exchanges — an assistant segment that only ran tools before a
  // steer split it (see splitAssistantSegment) has empty text but must still replay its exchanges,
  // otherwise the fork's model loses everything the parent's tools returned up to this point.
  for (const m of listMessages(parentThreadId)) {
    if (m.compacted) continue
    if (m.role !== 'user' && m.role !== 'assistant' && m.role !== 'system') continue
    if (!m.text.trim() && !m.toolExchanges?.length) continue
    insertMessage({
      id: ulid(),
      threadId: child.id,
      role: m.role,
      createdAt: m.createdAt,
      text: m.text,
      model: m.model,
      effort: m.effort,
      status: m.role === 'assistant' ? 'complete' : undefined,
      compacted: m.compacted,
      ...(m.toolExchanges?.length ? { toolExchanges: m.toolExchanges } : {})
    })
  }
  return child
}
