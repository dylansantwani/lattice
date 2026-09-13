/**
 * The gateway's brain: turns inbound texts into turns on one long-lived assistant thread and turns
 * that thread's replies, approvals and questions back into texts.
 *
 * Design points:
 *  - One owner, one thread. Every paired handle (Telegram account, iMessage number) talks to the
 *    same thread, so the conversation and its memory follow the owner across apps. Replies go to
 *    wherever the owner last texted from.
 *  - Delivery is transcript-driven, not send-driven. A queued text starts its own run later, a
 *    background job's completion starts a run nobody "sent", and the gateway may restart mid-run —
 *    so on every `run.completed` (and on reconnect) the router reads the thread and texts any
 *    settled assistant message it has not delivered yet. Delivered ids are persisted, making this
 *    at-least-once without double-texting across restarts.
 *  - The phone is only texted while the conversation lives there: if the most recent message the
 *    owner typed came from the desktop app (no channel header), replies stay on the desktop.
 *  - Nobody but a paired owner reaches the model. Unknown senders are dropped silently — a reply
 *    would confirm the line is live — except for a `/pair <code>` issued by the owner.
 */
import { mkdirSync } from 'node:fs'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import type { ApprovalRequest, AskRequest, Attachment, ChatMessage, RunId, ThreadMeta } from '@shared/types'
import {
  APPROVAL_CALLBACK_PREFIX,
  ASK_CALLBACK_PREFIX,
  HELP_TEXT,
  approvalPrompt,
  askPrompt,
  assistantGoal,
  chunkMarkdown,
  extractLocalFileRefs,
  inboundHeader,
  isChannelMessage,
  markdownToPlain,
  markdownToTelegramHtml,
  parseApprovalReply,
  parseCommand,
  resolveAskAnswer,
  type ApprovalReply,
  type LocalFileRef
} from './format'
import { defaultOutboundPolicy, vetOutboundFile, type OutboundFilePolicy } from './files'
import { parsePermissionSpecs } from '../permissionSpec'
import { issuePairingCode, isOwner, updateConfig, type ChannelsConfig, type Route, type StateStore } from './config'
import { CHANNEL_LABELS, type ChannelAdapter, type ChannelId, type InboundAttachment, type InboundMessage, type Logger, type OutboundButton, type OutboundFile } from './types'

const OFFLINE_NOTICE_EVERY_MS = 10 * 60_000
const PROGRESS_NOTICE_EVERY_MS = 10 * 60_000
const VIEW_WINDOW = 40
/** Files uploaded per reply; a reply that links a whole folder's worth lists the rest instead. */
const MAX_FILES_PER_REPLY = 10
/** Wrong pairing codes tolerated from one sender, and in total, before the code is revoked. */
const PAIR_ATTEMPTS_PER_SENDER = 5
const PAIR_ATTEMPTS_TOTAL = 20

export type Transcriber = (attachment: InboundAttachment) => Promise<string>

export interface RouterOptions {
  dataDir: string
  store: StateStore
  config: ChannelsConfig
  adapters: Map<ChannelId, ChannelAdapter>
  log: Logger
  now?: () => number
  transcribe?: Transcriber
  /** Filesystem access for attachments only works when the runtime shares this machine. */
  runtimeIsLocal?: boolean
  /** Which local files replies may upload; defaults to home (minus hidden folders and ~/Library) plus temp. */
  outboundPolicy?: (maxBytes: number) => OutboundFilePolicy
}

interface RunTracker {
  typingTimer?: ReturnType<typeof setInterval>
  progressTimer?: ReturnType<typeof setTimeout>
  error?: string
}

/** Voice turns the phone line is (or was) speaking, so delivery does not text them twice. */
export type VoiceRunState = 'speaking' | 'spoken' | 'overflow'

export class ChannelRouter {
  private api: LatticeApi | null = null
  private chain: Promise<void> = Promise.resolve()
  private readonly approvals = new Map<string, ApprovalRequest>()
  private readonly asks = new Map<string, AskRequest>()
  private readonly runs = new Map<RunId, RunTracker>()
  private readonly voiceRuns = new Map<RunId, VoiceRunState>()
  /** Where the conversation currently lives: the phone, or the desktop app. */
  private surface: 'phone' | 'desktop' = 'phone'
  /** Thread id already checked on this connection (skips a view fetch per inbound text). */
  private verifiedThread?: string
  /** Effective model observed when the thread was verified. */
  private verifiedModel?: string
  private lastOfflineNotice = 0
  private lastProgressNotice = 0
  private readonly ignoredSenders = new Set<string>()
  /** True while a phone utterance is being sent: its run.started can arrive before send() returns. */
  private voiceTurnInFlight = false
  private readonly pairFailures = new Map<string, number>()
  private pairFailuresTotal = 0
  private readonly now: () => number

  constructor(private readonly options: RouterOptions) {
    this.now = options.now ?? Date.now
  }

  get connected(): boolean {
    return this.api !== null
  }

  threadId(): string | undefined {
    return this.options.store.read().threadId
  }

  /**
   * Change the model behind the shared messaging assistant. The gateway control socket uses this
   * for Settings, and `/model` uses the same path, so the live thread and the private channel
   * config can never drift. An omitted model means "follow Lattice's default model".
   */
  setAssistantModel(model?: string): Promise<{ model: string; configuredModel?: string }> {
    // A Settings change can arrive while an inbound message is starting. Put it on the same serial
    // lane as message routing so the turn cannot observe a half-applied thread/config change.
    const task = this.chain.then(() => this.applyAssistantModel(model))
    this.chain = task.then(() => undefined, (error: unknown) => {
      this.options.log(`router: ${(error as Error).stack || String(error)}`)
    })
    return task
  }

  private async applyAssistantModel(model?: string): Promise<{ model: string; configuredModel?: string }> {
    const api = this.requireApi()
    const chosen = model?.trim()
    if (chosen) {
      const models = await api.listModels()
      if (!models.some((candidate) => candidate.id === chosen)) throw new Error(`unknown model ${chosen}`)
    }
    const effective = chosen || (await api.getSettings()).defaultModel
    const threadId = await this.ensureThread(false)
    const view = await this.recentMessages(threadId, 1)
    if (view.meta.model !== effective) await api.updateThread(threadId, { model: effective })
    updateConfig(this.options.dataDir, (config) => {
      if (chosen) config.assistant.model = chosen
      else delete config.assistant.model
    })
    this.options.config.assistant.model = chosen
    return { model: effective, ...(chosen ? { configuredModel: chosen } : {}) }
  }

  /** Run `task` after everything already queued, so inbound order and delivery order are preserved. */
  private enqueue(task: () => Promise<void>): Promise<void> {
    const next = this.chain.then(task).catch((error: unknown) => {
      this.options.log(`router: ${(error as Error).stack || String(error)}`)
    })
    this.chain = next
    return next
  }

  /** Wait for queued work (tests and shutdown). */
  idle(): Promise<void> {
    return this.chain
  }

  // ---------- connection lifecycle ----------

  attach(api: LatticeApi): Promise<void> {
    return this.enqueue(async () => {
      this.api = api
      this.verifiedThread = undefined
      this.verifiedModel = undefined
      const threadId = await this.ensureThread(false)
      await this.applyToolRules(threadId)
      await this.refreshPending()
      await this.catchUp()
      await this.flushPendingInbound()
    })
  }

  detach(): void {
    this.api = null
    this.verifiedThread = undefined
    this.verifiedModel = undefined
    for (const [runId] of this.runs) this.stopRun(runId)
    this.approvals.clear()
    this.asks.clear()
  }

  // ---------- thread ----------

  private async ensureThread(forceNew: boolean): Promise<string> {
    const api = this.requireApi()
    const { assistant } = this.options.config
    const goal = assistantGoal(assistant.ownerName, assistant.persona)
    const existing = this.options.store.read().threadId
    if (existing && !forceNew) {
      // An explicit messaging model is stable for this connection. Following Lattice's default is
      // dynamic, so re-read that cheap local setting before each new inbound turn.
      const desiredModel = assistant.model?.trim() || (await api.getSettings()).defaultModel
      if (this.verifiedThread === existing && this.verifiedModel === desiredModel) return existing
      try {
        const view = await this.recentMessages(existing, 1)
        if (!view.meta.archived) {
          const patch: { goal?: string; model?: string } = {}
          if (view.meta.goal !== goal) patch.goal = goal
          if (view.meta.model !== desiredModel) patch.model = desiredModel
          if (Object.keys(patch).length) await api.updateThread(existing, patch)
          this.verifiedThread = existing
          this.verifiedModel = desiredModel
          return existing
        }
      } catch (error) {
        this.options.log(`router: assistant thread ${existing} unavailable (${(error as Error).message}); creating a new one`)
      }
    }
    mkdirSync(assistant.workspaceRoot, { recursive: true })
    const workspace = await api.resolveWorkspace(assistant.workspaceRoot, { create: true })
    const meta = await api.createThread({
      workspaceId: workspace.id,
      title: 'Assistant',
      mode: 'act',
      permissionPreset: assistant.preset,
      goal,
      cwd: assistant.workspaceRoot,
      ...(assistant.model ? { model: assistant.model } : {}),
      ...(assistant.effort ? { effort: assistant.effort } : {})
    })
    await api.updateThread(meta.id, { pinned: true }).catch(() => undefined)
    await this.applyToolRules(meta.id)
    this.verifiedThread = meta.id
    this.verifiedModel = meta.model
    this.options.store.update((state) => {
      state.threadId = meta.id
      state.workspaceId = workspace.id
      // Never text out anything that predates this thread.
      state.deliveryCursor = Math.min(state.deliveryCursor, meta.createdAt)
    })
    this.options.log(`router: assistant thread ${meta.id} in workspace ${workspace.name}`)
    return meta.id
  }

  /** Thread rules live in the runtime's memory, so they are (re)seeded on every connect and new thread. */
  private async applyToolRules(threadId: string): Promise<void> {
    const specs = this.options.config.assistant.allowTools ?? []
    if (specs.length === 0) return
    try {
      await this.requireApi().setPermissionRules(threadId, parsePermissionSpecs(specs, []))
    } catch (error) {
      this.options.log(`router: could not pre-approve ${specs.join(', ')}: ${(error as Error).message}`)
    }
  }

  /** `getThreadView` when the runtime has it, else the older windowed `getThread`. */
  private async recentMessages(threadId: string, limit: number): Promise<{ meta: ThreadMeta; messages: ChatMessage[]; liveRunId?: string }> {
    const api = this.requireApi()
    try {
      const view = await api.getThreadView(threadId, { messageLimit: limit })
      return { meta: view.meta, messages: view.messages, liveRunId: view.meta.running ? view.events[0]?.runId : undefined }
    } catch (error) {
      if (!/unknown method|not callable/i.test((error as Error).message)) throw error
      const thread = await api.getThread(threadId, { messageLimit: limit, eventLimit: 50 })
      const live = thread.meta.running ? thread.events.at(-1)?.runId : undefined
      return { meta: thread.meta, messages: thread.messages, liveRunId: live }
    }
  }

  private requireApi(): LatticeApi {
    if (!this.api) throw new Error('Lattice runtime is not connected')
    return this.api
  }

  private async refreshPending(): Promise<void> {
    const api = this.requireApi()
    const threadId = this.threadId()
    this.approvals.clear()
    this.asks.clear()
    for (const request of await api.pendingApprovals()) if (request.threadId === threadId) this.approvals.set(request.id, request)
    for (const request of await api.pendingAsks()) if (request.threadId === threadId) this.asks.set(request.id, request)
  }

  // ---------- inbound ----------

  handleInbound(message: InboundMessage): Promise<void> {
    return this.enqueue(() => this.processInbound(message))
  }

  private async processInbound(message: InboundMessage): Promise<void> {
    const { store, log } = this.options
    const key = `${message.channel}:${message.messageId}`
    if (store.read().seenInbound.includes(key)) return
    store.update((state) => {
      state.seenInbound.push(key)
    })

    if (!isOwner(store.read(), message.channel, message.senderId)) {
      await this.tryPair(message)
      return
    }

    const route: Route = { channel: message.channel, conversationId: message.conversationId, at: this.now() }
    store.update((state) => {
      state.lastRoute = route
    })
    this.surface = 'phone'

    if (message.callback) {
      await this.handleCallback(route, message.callback.data)
      return
    }

    const command = parseCommand(message.text)
    if (command && message.attachments.length === 0 && (await this.handleCommand(route, command.name, command.arg))) return

    if (message.attachments.length === 0 && (await this.answerPending(route, message.text))) return

    if (!this.api) {
      store.update((state) => {
        state.pendingInbound.push({
          channel: message.channel,
          conversationId: message.conversationId,
          senderId: message.senderId,
          messageId: message.messageId,
          // Files are not held across an outage (the runtime attaches them by path at send time).
          text: [message.text, message.attachments.length ? `(${message.attachments.length} attachment(s) sent while offline were not kept; ask for them again)` : '']
            .filter(Boolean)
            .join('\n'),
          receivedAt: message.receivedAt
        })
      })
      if (this.now() - this.lastOfflineNotice > OFFLINE_NOTICE_EVERY_MS) {
        this.lastOfflineNotice = this.now()
        await this.sendText(route, "Lattice isn't reachable right now (the Mac may be asleep or restarting). I saved your message and will pick it up as soon as it's back.")
      }
      log(`router: runtime offline; queued ${key}`)
      return
    }

    const adapter = this.options.adapters.get(message.channel)
    if (adapter?.react) void adapter.react(message.conversationId, message.messageId, '👀').catch(() => undefined)

    const body = await this.composeBody(route, message)
    if (body === undefined) return
    await this.sendToThread(body.text, body.attachments)
    const waiting = [...this.approvals.values()][0]
    if (waiting) await this.sendText(route, `(Still waiting on a yes or no for: ${waiting.summary || waiting.tool})`)
  }

  private async tryPair(message: InboundMessage): Promise<void> {
    const { store, log } = this.options
    const command = parseCommand(message.text)
    const code = command && (command.name === 'pair' || command.name === 'start') ? command.arg.replace(/\s+/g, '') : ''
    const pairing = store.read().pairing
    const senderKey = `${message.channel}:${message.senderId}`
    const live = !!pairing && pairing.expiresAt > this.now()
    if (code && live && (this.pairFailures.get(senderKey) ?? 0) >= PAIR_ATTEMPTS_PER_SENDER) return
    if (code && live && code === pairing!.code) {
      store.update((state) => {
        state.owners.push({ channel: message.channel, senderId: message.senderId, name: message.senderName, pairedAt: this.now() })
        state.pairing = undefined
        state.lastRoute = { channel: message.channel, conversationId: message.conversationId, at: this.now() }
      })
      log(`router: paired ${message.channel} sender ${message.senderId}${message.senderName ? ` (${message.senderName})` : ''}`)
      this.pairFailures.clear()
      this.pairFailuresTotal = 0
      await this.sendText(
        { channel: message.channel, conversationId: message.conversationId, at: this.now() },
        `Paired. This ${CHANNEL_LABELS[message.channel]} chat now reaches your Lattice assistant.\n\n${HELP_TEXT}`
      )
      return
    }
    if (code && live) {
      // Six digits are only safe with a cap: a bot username is public, so guessing must stop early.
      this.pairFailures.set(senderKey, (this.pairFailures.get(senderKey) ?? 0) + 1)
      this.pairFailuresTotal += 1
      if (this.pairFailuresTotal >= PAIR_ATTEMPTS_TOTAL) {
        store.update((state) => {
          state.pairing = undefined
        })
        this.pairFailures.clear()
        this.pairFailuresTotal = 0
        log('router: pairing code revoked after too many wrong attempts; issue a new one with `lattice channels pair`')
      }
    }
    if (!this.ignoredSenders.has(senderKey)) {
      // Only de-duplicates a log line; bounded so a flood of numbers cannot grow it forever.
      if (this.ignoredSenders.size >= 1_000) this.ignoredSenders.clear()
      this.ignoredSenders.add(senderKey)
      log(`router: ignoring message from unpaired ${message.channel} sender ${message.senderId}${message.senderName ? ` (${message.senderName})` : ''}. Run \`lattice channels pair\` to link a new handle.`)
    }
  }

  private async composeBody(route: Route, message: InboundMessage): Promise<{ text: string; attachments: Attachment[] } | undefined> {
    const { config, transcribe, runtimeIsLocal = true, log } = this.options
    const api = this.requireApi()
    const lines = [inboundHeader(message.channel, message.receivedAt, config.assistant.timeZone)]
    const attachments: Attachment[] = []
    for (const item of message.attachments) {
      if (item.kind === 'audio') {
        if (!transcribe) {
          await this.sendText(route, "I can't listen to voice notes yet. Type it out, or set up transcription with `lattice channels setup transcription`.")
          continue
        }
        try {
          const transcript = (await transcribe(item)).trim()
          if (transcript) lines.push(`(voice note) ${transcript}`)
        } catch (error) {
          log(`router: transcription failed: ${(error as Error).message}`)
          await this.sendText(route, "I couldn't transcribe that voice note. Mind typing it?")
        }
        continue
      }
      if (!runtimeIsLocal) {
        lines.push(`(${message.channel} sent a ${item.kind} "${item.name}" the remote runtime cannot open)`)
        continue
      }
      if (item.kind === 'image') {
        try {
          attachments.push(await api.attachFile(item.path))
          continue
        } catch (error) {
          // HEIC, an oversized original, … — the model can still open it by path.
          log(`router: attachFile ${item.path} failed: ${(error as Error).message}`)
        }
      }
      // Documents are not model attachments; the saved copy sits in the assistant's workspace.
      lines.push(`(sent ${item.kind === 'image' ? 'an image' : 'a file'} "${item.name}", saved at ${item.path})`)
    }
    if (message.text.trim()) lines.push(message.text.trim())
    if (lines.length === 1 && attachments.length === 0) return undefined
    return { text: lines.join('\n'), attachments }
  }

  private async sendToThread(text: string, attachments: Attachment[] = []): Promise<{ runId: string; messageId: string }> {
    const api = this.requireApi()
    const disposition = this.options.config.assistant.busyDisposition
    const threadId = await this.ensureThread(false)
    try {
      return await api.send({ threadId, text, attachments: attachments.length ? attachments : undefined, disposition })
    } catch (error) {
      if (!/thread not found/i.test((error as Error).message)) throw error
      const fresh = await this.ensureThread(true)
      return api.send({ threadId: fresh, text, attachments: attachments.length ? attachments : undefined, disposition })
    }
  }

  private async flushPendingInbound(): Promise<void> {
    const pending = this.options.store.read().pendingInbound
    if (pending.length === 0) return
    this.options.store.update((state) => {
      state.pendingInbound = []
    })
    for (const item of pending) {
      const text = `${inboundHeader(item.channel, item.receivedAt, this.options.config.assistant.timeZone)}\n(sent while Lattice was offline)\n${item.text}`
      await this.sendToThread(text)
    }
    this.options.log(`router: replayed ${pending.length} message(s) queued while offline`)
  }

  // ---------- commands, approvals, questions ----------

  /** Returns true when the text was a gateway command (and has been answered). */
  private async handleCommand(route: Route, name: string, arg: string): Promise<boolean> {
    const { store } = this.options
    if (name === 'help' || name === 'start') {
      await this.sendText(route, HELP_TEXT)
      return true
    }
    if (name === 'pair') {
      const { code } = issuePairingCode(store, this.now())
      await this.sendText(route, `Pairing code: ${code} (valid 15 minutes). From the other app, text: /pair ${code}`)
      return true
    }
    if (!['new', 'stop', 'status', 'model', 'remember'].includes(name)) return false
    if (!this.api) {
      await this.sendText(route, "Lattice isn't reachable right now, so I can't do that yet.")
      return true
    }
    const api = this.api
    if (name === 'new') {
      await this.ensureThread(true)
      await this.sendText(route, 'Started a fresh conversation. The previous one is still in Lattice.')
      return true
    }
    if (name === 'stop') {
      const threadId = this.threadId()
      if (threadId) await api.stopThreadWork(threadId)
      await this.sendText(route, 'Stopped.')
      return true
    }
    if (name === 'status') {
      const threadId = await this.ensureThread(false)
      const view = await this.recentMessages(threadId, 1)
      const channels = [...this.options.adapters.values()]
        .map((adapter) => {
          const status = adapter.status()
          return `${CHANNEL_LABELS[adapter.id]}: ${status.connected ? 'connected' : 'down'}${status.lastError ? ` (${status.lastError})` : ''}`
        })
        .join('\n')
      const lines = [
        view.meta.running ? 'Working on something right now.' : 'Idle.',
        `Model: ${view.meta.model}`,
        `Permissions: ${view.meta.permissionPreset}`,
        this.approvals.size ? `Waiting on ${this.approvals.size} approval(s).` : '',
        channels
      ].filter(Boolean)
      await this.sendText(route, lines.join('\n'))
      return true
    }
    if (name === 'model') {
      const threadId = await this.ensureThread(false)
      if (!arg) {
        const view = await this.recentMessages(threadId, 1)
        await this.sendText(route, `Model: ${view.meta.model}\nSwitch with /model <name>.`)
        return true
      }
      const models = await api.listModels()
      const needle = arg.toLowerCase()
      const exact = models.find((model) => model.id.toLowerCase() === needle)
      const matches = exact ? [exact] : models.filter((model) => model.id.toLowerCase().includes(needle))
      if (matches.length !== 1) {
        const sample = matches.slice(0, 8).map((model) => model.id).join('\n')
        await this.sendText(route, matches.length === 0 ? `No model matches "${arg}".` : `"${arg}" matches ${matches.length} models:\n${sample}`)
        return true
      }
      const chosen = matches[0]!.id
      // This command is already running on the router's serial lane; calling the public queued
      // method from here would wait behind itself.
      await this.applyAssistantModel(chosen)
      await this.sendText(route, `Switched to ${chosen}.`)
      return true
    }
    if (name === 'remember') {
      if (!arg) {
        await this.sendText(route, 'Usage: /remember <fact>')
        return true
      }
      await api.upsertMemory({ content: arg, type: 'fact', scope: 'user', author: 'user', confidence: 1, status: 'approved', sensitivity: 'normal' })
      await this.sendText(route, 'Saved to long-term memory.')
      return true
    }
    return false
  }

  /** A bare yes/no answers the oldest pending approval; any text answers the oldest pending question. */
  private async answerPending(route: Route, text: string): Promise<boolean> {
    if (!this.api) return false
    const approval = [...this.approvals.values()][0]
    if (approval) {
      const reply = parseApprovalReply(text)
      if (reply) {
        await this.respondApproval(route, approval.id, reply)
        return true
      }
    }
    const ask = [...this.asks.values()][0]
    if (ask && text.trim()) {
      await this.api.respondAsk({ requestId: ask.id, answer: resolveAskAnswer(ask, text) })
      this.asks.delete(ask.id)
      return true
    }
    return false
  }

  private async respondApproval(route: Route, requestId: string, reply: ApprovalReply): Promise<void> {
    const api = this.requireApi()
    await api.respondApproval({
      requestId,
      effect: reply === 'deny' ? 'deny' : 'allow',
      scope: reply === 'always' ? 'thread' : 'once',
      ...(reply === 'always' ? { saveRule: true } : {})
    })
    this.approvals.delete(requestId)
    await this.sendText(route, reply === 'deny' ? 'Denied.' : reply === 'always' ? 'Approved, and I won\'t ask again for this in this conversation.' : 'Approved.')
  }

  private async handleCallback(route: Route, data: string): Promise<void> {
    if (!this.api) {
      await this.sendText(route, "Lattice isn't reachable right now.")
      return
    }
    if (data.startsWith(APPROVAL_CALLBACK_PREFIX)) {
      const [reply, ...rest] = data.slice(APPROVAL_CALLBACK_PREFIX.length).split(':')
      const requestId = rest.join(':')
      if (!this.approvals.has(requestId)) {
        await this.sendText(route, 'That approval was already handled.')
        return
      }
      if (reply === 'allow' || reply === 'deny' || reply === 'always') await this.respondApproval(route, requestId, reply)
      return
    }
    if (data.startsWith(ASK_CALLBACK_PREFIX)) {
      const body = data.slice(ASK_CALLBACK_PREFIX.length)
      const cut = body.lastIndexOf(':')
      const requestId = body.slice(0, cut)
      const answer = body.slice(cut + 1)
      const ask = this.asks.get(requestId)
      if (!ask) {
        await this.sendText(route, 'That question was already answered.')
        return
      }
      await this.api.respondAsk({ requestId, answer: resolveAskAnswer(ask, answer) })
      this.asks.delete(requestId)
    }
  }

  // ---------- runtime events ----------

  handlePush(event: PushEvent): void {
    const threadId = this.threadId()
    if (!threadId) return
    switch (event.kind) {
      case 'run.event': {
        const run = event.event
        if (run.threadId !== threadId || run.agent) return
        const body = run.body
        if (body.type === 'run.started') this.startRun(run.runId)
        else if (body.type === 'error') this.tracker(run.runId).error = body.message
        else if (body.type === 'run.completed') {
          const error = this.runs.get(run.runId)?.error
          this.stopRun(run.runId)
          void this.enqueue(() => this.deliverRun(run.runId, body.reason, error))
        }
        return
      }
      case 'message.updated': {
        const message = event.message
        if (message.threadId !== threadId || message.role !== 'user' || message.origin) return
        this.surface = isChannelMessage(message.text) ? 'phone' : 'desktop'
        return
      }
      case 'approval.request':
        if (event.request.threadId !== threadId) return
        this.approvals.set(event.request.id, event.request)
        void this.enqueue(async () => {
          const route = this.phoneRoute()
          if (!route) return
          const prompt = approvalPrompt(event.request)
          await this.sendText(route, prompt.text, prompt.buttons)
        })
        return
      case 'approval.resolved':
        this.approvals.delete(event.requestId)
        return
      case 'ask.request':
        if (event.request.threadId !== threadId) return
        this.asks.set(event.request.id, event.request)
        void this.enqueue(async () => {
          const route = this.phoneRoute()
          if (!route) return
          const prompt = askPrompt(event.request)
          await this.sendText(route, prompt.text, prompt.buttons)
        })
        return
      case 'ask.resolved':
        this.asks.delete(event.requestId)
        return
      case 'thread.deleted':
        if (event.id === threadId) {
          this.verifiedThread = undefined
          this.verifiedModel = undefined
          this.options.store.update((state) => {
            state.threadId = undefined
          })
        }
        return
      default:
    }
  }

  private phoneRoute(): Route | undefined {
    if (this.surface !== 'phone') return undefined
    return this.options.store.read().lastRoute
  }

  private tracker(runId: RunId): RunTracker {
    let tracker = this.runs.get(runId)
    if (!tracker) {
      tracker = {}
      this.runs.set(runId, tracker)
    }
    return tracker
  }

  private startRun(runId: RunId): void {
    const tracker = this.tracker(runId)
    // The runtime pushes run.started before answering send(), so a phone call's run is claimed here
    // rather than after sendVoiceTurn's await — otherwise it would get a Telegram typing loop.
    if (this.voiceTurnInFlight && !this.voiceRuns.has(runId)) this.voiceRuns.set(runId, 'speaking')
    const route = this.phoneRoute()
    if (!route || this.voiceRuns.has(runId)) return
    const adapter = this.options.adapters.get(route.channel)
    if (adapter?.typing) {
      void adapter.typing(route.conversationId, true).catch(() => undefined)
      if (adapter.typingTtlMs) {
        tracker.typingTimer = setInterval(() => {
          void adapter.typing?.(route.conversationId, true).catch(() => undefined)
        }, Math.max(1_000, adapter.typingTtlMs - 500))
        tracker.typingTimer.unref?.()
      }
    }
    const delay = this.options.config.assistant.progressNoticeMs
    if (delay > 0) {
      tracker.progressTimer = setTimeout(() => {
        if (!this.runs.has(runId) || this.voiceRuns.has(runId)) return
        if (this.now() - this.lastProgressNotice < PROGRESS_NOTICE_EVERY_MS) return
        this.lastProgressNotice = this.now()
        void this.enqueue(async () => {
          const current = this.phoneRoute()
          if (current && this.runs.has(runId)) await this.sendText(current, "Still working on it. I'll text you when it's done.")
        })
      }, delay)
      tracker.progressTimer.unref?.()
    }
  }

  private stopRun(runId: RunId): void {
    const tracker = this.runs.get(runId)
    if (!tracker) return
    if (tracker.typingTimer) clearInterval(tracker.typingTimer)
    if (tracker.progressTimer) clearTimeout(tracker.progressTimer)
    this.runs.delete(runId)
    const route = this.options.store.read().lastRoute
    const adapter = route ? this.options.adapters.get(route.channel) : undefined
    if (route && adapter?.typing && !adapter.typingTtlMs) void adapter.typing(route.conversationId, false).catch(() => undefined)
  }

  // ---------- delivery ----------

  /**
   * Text out the settled assistant messages of `runId` that have not been delivered, if the
   * conversation lives on the phone. Messages for a run the phone line already spoke are marked
   * delivered without texting.
   */
  private async deliverRun(runId: RunId, reason: string, error?: string): Promise<void> {
    if (!this.api) return
    const threadId = this.threadId()
    if (!threadId) return
    const { messages } = await this.recentMessages(threadId, VIEW_WINDOW)
    await this.deliverMessages(messages, runId, reason, error)
  }

  private async deliverMessages(messages: ChatMessage[], runId: RunId, reason: string, error?: string): Promise<void> {
    const { store } = this.options
    const delivered = new Set(store.read().delivered)
    const firstIndex = messages.findIndex((message) => message.role === 'assistant' && message.runId === runId)
    const replies = messages.filter((message) => message.role === 'assistant' && message.runId === runId && !delivered.has(message.id))
    const voice = this.voiceRuns.get(runId)
    this.voiceRuns.delete(runId)
    if (voice === 'spoken') {
      this.markDelivered(replies.map((message) => message.id))
      return
    }

    // Who started this conversation turn: the last message a human typed before the run's reply.
    const before = firstIndex >= 0 ? messages.slice(0, firstIndex) : messages
    const human = [...before].reverse().find((message) => message.role === 'user' && !message.origin)
    const fromPhone = human ? isChannelMessage(human.text) : this.surface === 'phone'
    const text = replies.map((message) => message.text.trim()).filter(Boolean).join('\n\n')
    const route = store.read().lastRoute

    // A voice turn whose call ended before the answer (or that the call handed off) is texted like
    // any other phone-originated reply; only a fully spoken answer is skipped above.
    if (!fromPhone || !route) {
      this.markDelivered(replies.map((message) => message.id))
      return
    }

    if (text) {
      await this.sendReply(route, text)
    } else if (reason === 'error' && !replies.some((message) => delivered.has(message.id))) {
      await this.sendText(route, `That didn't work: ${error ?? 'the run failed'}. Text me again to retry.`)
    }
    this.markDelivered(replies.map((message) => message.id))
  }

  private markDelivered(ids: string[]): void {
    if (ids.length === 0) return
    this.options.store.update((state) => {
      for (const id of ids) if (!state.delivered.includes(id)) state.delivered.push(id)
    })
  }

  /** After a (re)connect: deliver replies that settled while the gateway was away. */
  private async catchUp(): Promise<void> {
    const threadId = this.threadId()
    if (!threadId) return
    const { store } = this.options
    const view = await this.recentMessages(threadId, VIEW_WINDOW)
    const human = [...view.messages].reverse().find((message) => message.role === 'user' && !message.origin)
    this.surface = human && !isChannelMessage(human.text) ? 'desktop' : 'phone'
    const state = store.read()
    const delivered = new Set(state.delivered)
    const runIds = new Set<string>()
    for (const message of view.messages) {
      if (message.role !== 'assistant' || !message.runId || delivered.has(message.id)) continue
      if (message.runId === view.liveRunId || message.createdAt < state.deliveryCursor) continue
      runIds.add(message.runId)
    }
    for (const runId of runIds) await this.deliverMessages(view.messages, runId, 'done')
  }

  // ---------- outbound ----------

  async sendText(route: Route, markdown: string, buttons?: OutboundButton[][]): Promise<void> {
    const adapter = this.options.adapters.get(route.channel)
    if (!adapter) {
      this.options.log(`router: no ${route.channel} adapter to deliver to; dropping ${markdown.length} chars`)
      return
    }
    const chunks = chunkMarkdown(markdown, adapter.maxMessageChars)
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!
      const rendered = adapter.format === 'telegram-html' ? markdownToTelegramHtml(chunk) : markdownToPlain(chunk)
      const last = index === chunks.length - 1
      await adapter.send(route.conversationId, rendered, last && buttons?.length ? { buttons } : undefined)
    }
  }

  /**
   * An assistant reply: the words, then any local files it links to (`![chart](/abs/chart.png)`).
   * A file that may not or cannot be sent is named in the text instead, so nothing vanishes.
   */
  async sendReply(route: Route, markdown: string, extraFiles: string[] = []): Promise<void> {
    const adapter = this.options.adapters.get(route.channel)
    const { text, refs } = extractLocalFileRefs(markdown)
    const all: LocalFileRef[] = [...refs, ...extraFiles.map((path) => ({ path, label: '', image: false }))]
    if (all.length === 0) {
      await this.sendText(route, markdown)
      return
    }
    const maxBytes = adapter?.maxUploadBytes ?? 50 * 1024 * 1024
    const policy = (this.options.outboundPolicy ?? defaultOutboundPolicy)(maxBytes)
    policy.extraRoots = [...policy.extraRoots, this.options.config.assistant.workspaceRoot]
    const notes: string[] = []
    const files: OutboundFile[] = []
    let overflow = 0
    for (const ref of all) {
      const shown = ref.label || ref.path.split('/').pop() || ref.path
      // One image with alt text reads best as a captioned photo.
      const caption = ref.image && ref.label && all.length === 1 && !text ? ref.label : undefined
      // Vet first on every channel: a path the policy refuses is not even named.
      const verdict = vetOutboundFile(ref.path, policy, caption)
      if (!verdict.ok) {
        this.options.log(`router: not sending ${ref.path}: ${verdict.reason}`)
        notes.push(`(couldn't send ${shown}: ${verdict.reason})`)
        continue
      }
      if (files.some((file) => file.path === verdict.file.path)) continue
      if (!adapter?.sendFile) {
        notes.push(`(file on the computer: ${verdict.file.path})`)
        continue
      }
      if (files.length >= MAX_FILES_PER_REPLY) overflow += 1
      else files.push(verdict.file)
    }
    if (overflow) notes.push(`(${overflow} more file${overflow === 1 ? '' : 's'} not sent; ask for them by name)`)
    const body = [text, ...notes].filter(Boolean).join('\n\n')
    if (body) await this.sendText(route, body)
    for (const file of files) {
      try {
        await adapter!.sendFile!(route.conversationId, file)
      } catch (error) {
        this.options.log(`router: upload of ${file.path} failed: ${(error as Error).message}`)
        await this.sendText(route, `(couldn't send ${file.name}: ${(error as Error).message})`)
      }
    }
  }

  /** Proactive message to wherever the owner last texted from (`lattice channels notify`). */
  notify(text: string, files: string[] = []): Promise<void> {
    let failure: unknown
    return this.enqueue(async () => {
      try {
        const route = this.options.store.read().lastRoute
        if (!route) throw new Error('no conversation yet: text the assistant once so it knows where to reach you')
        await this.sendReply(route, text, files)
      } catch (error) {
        failure = error
        throw error
      }
    }).then(() => {
      // The queue logs and swallows task errors; the caller (`channels notify`) must still hear "not sent".
      if (failure) throw failure
    })
  }

  // ---------- voice ----------

  /**
   * Put a phone-call utterance into the assistant thread. Resolves once the runtime accepted it;
   * the caller then streams that run's text deltas.
   */
  async sendVoiceTurn(utterance: string, at = this.now()): Promise<{ threadId: string; runId: string; busy: boolean } | undefined> {
    let result: { threadId: string; runId: string; busy: boolean } | undefined
    await this.enqueue(async () => {
      if (!this.api) return
      this.surface = 'phone'
      const threadId = await this.ensureThread(false)
      // A busy thread folds the utterance into (or queues it behind) work already running, so its
      // answer arrives on a run this call cannot follow. Say so on the line; the answer is texted.
      const busy = !!(await this.recentMessages(threadId, 1)).meta.running
      const text = `${inboundHeader('voice', at, this.options.config.assistant.timeZone)}\n${utterance.trim()}`
      this.voiceTurnInFlight = !busy
      let sent: { runId: string }
      try {
        sent = await this.sendToThread(text)
      } finally {
        this.voiceTurnInFlight = false
      }
      if (!busy) this.voiceRuns.set(sent.runId, 'speaking')
      result = { threadId: this.threadId() ?? threadId, runId: sent.runId, busy }
    })
    return result
  }

  setVoiceRunState(runId: RunId, state: VoiceRunState): void {
    if (this.voiceRuns.has(runId) || state === 'speaking') this.voiceRuns.set(runId, state)
  }

  statusSnapshot(): Record<string, unknown> {
    const state = this.options.store.read()
    return {
      runtime: this.api ? 'connected' : 'disconnected',
      threadId: state.threadId,
      surface: this.surface,
      owners: state.owners.map((owner) => `${owner.channel}:${owner.senderId}${owner.name ? ` (${owner.name})` : ''}`),
      lastRoute: state.lastRoute ? `${state.lastRoute.channel}:${state.lastRoute.conversationId}` : undefined,
      pendingApprovals: this.approvals.size,
      pendingAsks: this.asks.size,
      queuedWhileOffline: state.pendingInbound.length,
      channels: Object.fromEntries([...this.options.adapters.values()].map((adapter) => [adapter.id, adapter.status()]))
    }
  }
}
