import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import type { ApprovalRequest, AskRequest, ChatMessage, RunEvent, SendOptions, ThreadMeta } from '@shared/types'
import { defaultConfig, issuePairingCode, loadConfig, StateStore, type ChannelsConfig } from './config'
import { ChannelRouter } from './router'
import type { ChannelAdapter, ChannelId, ChannelStatus, InboundMessage, OutboundFile, SendOptions as OutboundOptions } from './types'

class FakeAdapter implements ChannelAdapter {
  readonly maxMessageChars = 2000
  readonly sent: Array<{ conversationId: string; text: string; options?: OutboundOptions }> = []
  readonly reactions: Array<{ messageId: string; emoji: string }> = []
  readonly typingCalls: Array<{ conversationId: string; on: boolean }> = []
  readonly files: Array<{ conversationId: string; file: OutboundFile }> = []
  readonly maxUploadBytes = 1024
  failUpload = false

  constructor(readonly id: ChannelId, readonly format: 'telegram' | 'plain' = 'plain') {}

  async sendFile(conversationId: string, file: OutboundFile): Promise<void> {
    if (this.failUpload) throw new Error('Request Entity Too Large')
    this.files.push({ conversationId, file })
  }

  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  async send(conversationId: string, text: string, options?: OutboundOptions): Promise<void> {
    this.sent.push({ conversationId, text, options })
  }
  async typing(conversationId: string, on: boolean): Promise<void> {
    this.typingCalls.push({ conversationId, on })
  }
  async react(_conversationId: string, messageId: string, emoji: string): Promise<void> {
    this.reactions.push({ messageId, emoji })
  }
  status(): ChannelStatus {
    return { connected: true }
  }
  texts(): string[] {
    return this.sent.map((item) => item.text)
  }
}

/** A scripted runtime: threads, messages, runs and the approval/ask brokers, all in memory. */
class FakeRuntime {
  threads = new Map<string, ThreadMeta>()
  messages = new Map<string, ChatMessage[]>()
  sends: SendOptions[] = []
  approvalsAnswered: unknown[] = []
  asksAnswered: unknown[] = []
  pendingApprovals: ApprovalRequest[] = []
  pendingAsks: AskRequest[] = []
  memories: unknown[] = []
  stopped: string[] = []
  rules = new Map<string, unknown[]>()
  running = new Set<string>()
  failNextSendWithMissingThread = false
  defaultModel = 'default-model'
  supportsTexting = true
  supportsRolling = true
  rolls: Array<{ id: string; keepTokens?: number }> = []
  rollResult: { ok: boolean; reason?: string; memories?: number } = { ok: true, memories: 3 }
  threadUpdates: Array<{ id: string; patch: Partial<ThreadMeta> }> = []
  runEvents = new Map<string, RunEvent[]>()
  /** Runs inside send() before it resolves, like the runtime pushing run.started ahead of the reply. */
  beforeSendResolves?: (threadId: string, runId: string) => void
  private seq = 0
  private clock = 1_000_000

  tick(): number {
    this.clock += 1_000
    return this.clock
  }

  id(prefix: string): string {
    this.seq += 1
    return `${prefix}${this.seq}`
  }

  api(): LatticeApi {
    const runtime = this
    const impl: Partial<LatticeApi> = {
      async resolveWorkspace(path: string) {
        return { id: 'ws1', name: 'LatticeAssistant', roots: [path], createdAt: 0, updatedAt: 0 } as never
      },
      async createThread(opts) {
        const meta = { id: runtime.id('thread'), workspaceId: opts?.workspaceId ?? 'ws1', title: opts?.title ?? 'New thread', createdAt: runtime.tick(), updatedAt: runtime.clock, pinned: false, archived: false, model: opts?.model ?? 'default-model', mode: opts?.mode ?? 'act', permissionPreset: opts?.permissionPreset ?? 'workspace', goal: opts?.goal, cwd: opts?.cwd, ...(runtime.supportsTexting ? { replyStyle: opts?.replyStyle, contextPolicy: opts?.contextPolicy } : {}) } as ThreadMeta
        runtime.threads.set(meta.id, meta)
        runtime.messages.set(meta.id, [])
        return meta
      },
      async updateThread(id, patch) {
        const meta = runtime.threads.get(id)
        if (!meta) throw new Error(`thread not found: ${id}`)
        const { replyStyle, contextPolicy, ...rest } = patch
        Object.assign(meta, rest, runtime.supportsTexting ? { ...(replyStyle ? { replyStyle } : {}), ...(contextPolicy ? { contextPolicy } : {}) } : {})
        runtime.threadUpdates.push({ id, patch })
        return { ...meta }
      },
      async rollThread(id, opts) {
        if (!runtime.supportsRolling) throw new Error('unknown method rollThread')
        runtime.rolls.push({ id, keepTokens: opts?.keepTokens })
        return runtime.rollResult
      },
      async getRunEvents(_threadId, runId) {
        const events = runtime.runEvents.get(runId)
        if (!events) throw new Error('unknown run')
        return events
      },
      async getThreadView(id, opts) {
        const meta = runtime.threads.get(id)
        if (!meta) throw new Error(`thread not found: ${id}`)
        const all = runtime.messages.get(id) ?? []
        return { meta: { ...meta, running: runtime.running.has(id) }, messages: all.slice(-(opts?.messageLimit ?? 40)), turns: {}, events: [], hasMore: false }
      },
      async send(opts) {
        if (runtime.failNextSendWithMissingThread) {
          runtime.failNextSendWithMissingThread = false
          throw new Error(`thread not found: ${opts.threadId}`)
        }
        runtime.sends.push(opts)
        const runId = runtime.id('run')
        runtime.messages.get(opts.threadId)!.push({ id: runtime.id('msg'), threadId: opts.threadId, role: 'user', createdAt: runtime.tick(), text: opts.text, attachments: opts.attachments })
        runtime.beforeSendResolves?.(opts.threadId, runId)
        return { runId, messageId: 'm' }
      },
      async pendingApprovals() {
        return runtime.pendingApprovals
      },
      async pendingAsks() {
        return runtime.pendingAsks
      },
      async respondApproval(decision) {
        runtime.approvalsAnswered.push(decision)
      },
      async respondAsk(response) {
        runtime.asksAnswered.push(response)
      },
      async setPermissionRules(threadId, rules) {
        runtime.rules.set(threadId, rules)
      },
      async stopThreadWork(threadId) {
        runtime.stopped.push(threadId)
      },
      async listModels() {
        return [{ id: 'deepseek/deepseek-v4-flash' }, { id: 'deepseek/deepseek-v4-pro' }, { id: 'openai/gpt-5.5' }] as never
      },
      async getSettings() {
        return { defaultModel: runtime.defaultModel } as never
      },
      async upsertMemory(item) {
        runtime.memories.push(item)
        return item as never
      },
      async attachFile(path) {
        return { id: 'att', name: path, path, mime: 'image/png', bytes: 1, sha256: 'x', kind: 'image' }
      }
    }
    return impl as LatticeApi
  }

  /** Append an assistant reply for `runId` (optionally from the desktop or an origin message). */
  reply(threadId: string, runId: string, text: string): ChatMessage {
    const message: ChatMessage = { id: this.id('msg'), threadId, runId, role: 'assistant', createdAt: this.tick(), text, status: 'complete' }
    this.messages.get(threadId)!.push(message)
    return message
  }

  userMessage(threadId: string, text: string, origin?: ChatMessage['origin']): void {
    this.messages.get(threadId)!.push({ id: this.id('msg'), threadId, role: 'user', createdAt: this.tick(), text, ...(origin ? { origin } : {}) })
  }
}

function runEvent(threadId: string, runId: string, body: RunEvent['body']): PushEvent {
  return { kind: 'run.event', event: { id: 'e', runId, threadId, seq: 1, ts: 0, body } as RunEvent }
}

let dir: string
let store: StateStore
let config: ChannelsConfig
let runtime: FakeRuntime
let telegram: FakeAdapter
let imessage: FakeAdapter
let router: ChannelRouter
let logs: string[]
let msgSeq = 0

function inbound(text: string, overrides: Partial<InboundMessage> = {}): InboundMessage {
  msgSeq += 1
  return { channel: 'telegram', conversationId: 'chat-1', senderId: 'user-1', senderName: 'Dylan', messageId: `in-${msgSeq}`, text, attachments: [], receivedAt: Date.UTC(2026, 8, 12, 21, 0), ...overrides }
}

function makeRouter(): ChannelRouter {
  return new ChannelRouter({
    dataDir: dir,
    store,
    config,
    adapters: new Map<ChannelId, ChannelAdapter>([['telegram', telegram], ['imessage', imessage]]),
    log: (line) => logs.push(line),
    bubbleGapMs: 0
  })
}

async function pairOwner(channel: ChannelId = 'telegram', senderId = 'user-1'): Promise<void> {
  store.update((state) => {
    state.owners.push({ channel, senderId, pairedAt: 1 })
  })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-channels-'))
  store = new StateStore(join(dir, 'channels', 'state.json'), () => 0)
  store.update(() => undefined)
  config = defaultConfig()
  config.assistant.workspaceRoot = join(dir, 'assistant')
  config.assistant.ownerName = 'Dylan'
  config.assistant.timeZone = 'America/Chicago'
  config.assistant.progressNoticeMs = 0
  runtime = new FakeRuntime()
  telegram = new FakeAdapter('telegram', 'telegram')
  imessage = new FakeAdapter('imessage')
  logs = []
  router = makeRouter()
})

afterEach(() => {
  router.detach()
  rmSync(dir, { recursive: true, force: true })
})

describe('assistant model', () => {
  it('updates the live thread and persists the exact model selected in Settings', async () => {
    await router.attach(runtime.api())
    const result = await router.setAssistantModel('openai/gpt-5.5')
    const thread = runtime.threads.get(store.read().threadId!)
    expect(result).toEqual({ model: 'openai/gpt-5.5', configuredModel: 'openai/gpt-5.5' })
    expect(thread?.model).toBe('openai/gpt-5.5')
    expect(loadConfig(dir).assistant.model).toBe('openai/gpt-5.5')
  })

  it('can follow the Lattice default again and refuses unknown models', async () => {
    await router.attach(runtime.api())
    await router.setAssistantModel('openai/gpt-5.5')
    await expect(router.setAssistantModel('missing/model')).rejects.toThrow(/unknown model/)
    expect(loadConfig(dir).assistant.model).toBe('openai/gpt-5.5')

    expect(await router.setAssistantModel()).toEqual({ model: 'default-model' })
    expect(runtime.threads.get(store.read().threadId!)?.model).toBe('default-model')
    expect(loadConfig(dir).assistant.model).toBeUndefined()
  })

  it('reconciles a model selected while the gateway was offline when it reconnects', async () => {
    await router.attach(runtime.api())
    const threadId = store.read().threadId!
    router.detach()
    config.assistant.model = 'openai/gpt-5.5'

    await router.attach(runtime.api())
    expect(runtime.threads.get(threadId)?.model).toBe('openai/gpt-5.5')
    expect(store.read().threadId).toBe(threadId)
  })

  it('keeps a follow-default assistant in sync when Lattice default changes', async () => {
    await pairOwner()
    await router.attach(runtime.api())
    const threadId = store.read().threadId!
    runtime.defaultModel = 'openai/gpt-5.5'

    await router.handleInbound(inbound('hello after changing the default'))
    expect(runtime.threads.get(threadId)?.model).toBe('openai/gpt-5.5')
  })
})

describe('pairing and the owner allowlist', () => {
  it('drops messages from unpaired senders without replying or reaching the model', async () => {
    await router.attach(runtime.api())
    await router.handleInbound(inbound('hello?'))
    await router.handleInbound(inbound('anyone?'))
    expect(runtime.sends).toHaveLength(0)
    expect(telegram.sent).toHaveLength(0)
    expect(logs.filter((line) => line.includes('ignoring message from unpaired'))).toHaveLength(1)
  })

  it('pairs a sender who texts the current code, and only that code', async () => {
    await router.attach(runtime.api())
    const { code } = issuePairingCode(store)
    await router.handleInbound(inbound(`/pair 000000${code === '000000' ? '1' : ''}`))
    expect(store.read().owners).toHaveLength(0)
    await router.handleInbound(inbound(`/start ${code}`))
    const state = store.read()
    expect(state.owners).toEqual([expect.objectContaining({ channel: 'telegram', senderId: 'user-1', name: 'Dylan' })])
    expect(state.pairing).toBeUndefined()
    expect(telegram.texts()[0]).toContain('Paired.')
  })

  it('stops accepting guesses from a sender after five wrong codes, and revokes the code after twenty', async () => {
    await router.attach(runtime.api())
    const { code } = issuePairingCode(store)
    const wrong = code === '999999' ? '999998' : '999999'
    for (let attempt = 0; attempt < 5; attempt += 1) await router.handleInbound(inbound(`/pair ${wrong}`))
    await router.handleInbound(inbound(`/pair ${code}`))
    expect(store.read().owners).toHaveLength(0)
    for (let sender = 0; sender < 15; sender += 1) await router.handleInbound(inbound(`/pair ${wrong}`, { senderId: `guesser-${sender}` }))
    expect(store.read().pairing).toBeUndefined()
    await router.handleInbound(inbound(`/pair ${code}`, { senderId: 'late' }))
    expect(store.read().owners).toHaveLength(0)
    expect(logs.some((line) => line.includes('pairing code revoked'))).toBe(true)
  })

  it('refuses an expired code', async () => {
    const expiredStore = new StateStore(join(dir, 'channels', 'state.json'), () => 0)
    expiredStore.update((state) => {
      state.pairing = { code: '123456', expiresAt: -1 }
    })
    await router.attach(runtime.api())
    await router.handleInbound(inbound('/pair 123456'))
    expect(store.read().owners).toHaveLength(0)
  })

  it('handles each platform message once even if it is redelivered', async () => {
    await pairOwner()
    await router.attach(runtime.api())
    const message = inbound('what time is it')
    await router.handleInbound(message)
    await router.handleInbound(message)
    expect(runtime.sends).toHaveLength(1)
  })
})

describe('turns on the assistant thread', () => {
  beforeEach(async () => {
    await pairOwner()
    await router.attach(runtime.api())
  })

  it('creates one pinned texting thread with a rolling context and the owner in its goal', async () => {
    const [thread] = [...runtime.threads.values()]
    expect(runtime.threads.size).toBe(1)
    expect(thread).toMatchObject({
      title: 'Assistant',
      mode: 'act',
      permissionPreset: 'workspace',
      pinned: true,
      cwd: config.assistant.workspaceRoot,
      replyStyle: 'texting',
      contextPolicy: { mode: 'rolling', triggerTokens: 64_000, keepTokens: 24_000 }
    })
    expect(thread!.goal).toContain("You are Dylan's personal assistant")
    expect(thread!.goal).not.toContain('NO_REPLY')
    expect(store.read().threadId).toBe(thread!.id)
  })

  it('upgrades an existing thread in place instead of starting a new conversation', async () => {
    const threadId = store.read().threadId!
    const thread = runtime.threads.get(threadId)!
    delete thread.replyStyle
    delete thread.contextPolicy
    router.detach()
    await router.attach(runtime.api())
    expect(store.read().threadId).toBe(threadId)
    expect(runtime.threads.size).toBe(1)
    expect(runtime.threads.get(threadId)).toMatchObject({ replyStyle: 'texting', contextPolicy: { mode: 'rolling' } })
  })

  it('pre-approves read-only web tools on the thread, and again on every reconnect', async () => {
    const threadId = store.read().threadId!
    expect(runtime.rules.get(threadId)).toEqual([
      expect.objectContaining({ resource: 'network', action: 'read', effect: 'allow' }),
      expect.objectContaining({ resource: 'network', action: 'read', effect: 'allow' }),
      expect.objectContaining({ resource: 'network', action: 'read', effect: 'allow' })
    ])
    runtime.rules.clear() // the runtime restarted and forgot them
    router.detach()
    await router.attach(runtime.api())
    expect(runtime.rules.get(threadId)).toHaveLength(3)
  })

  it('stamps each text with the channel header, steers a busy thread, and acknowledges it', async () => {
    await router.handleInbound(inbound('book the 8am'))
    expect(runtime.sends[0]).toMatchObject({ threadId: store.read().threadId, disposition: 'steer' })
    expect(runtime.sends[0]!.text).toBe('[Texted via Telegram · Sat, Sep 12, 4:00 PM CDT · text back short and plain]\nbook the 8am')
    expect(telegram.reactions).toEqual([expect.objectContaining({ emoji: '👀' })])
    expect(store.read().lastRoute).toMatchObject({ channel: 'telegram', conversationId: 'chat-1' })
  })

  it('texts the reply when the run completes, rendered for the channel, exactly once', async () => {
    await router.handleInbound(inbound('summarize my day'))
    const threadId = store.read().threadId!
    router.handlePush(runEvent(threadId, 'run9', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    runtime.reply(threadId, 'run9', '**Three** meetings today.')
    router.handlePush(runEvent(threadId, 'run9', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    router.handlePush(runEvent(threadId, 'run9', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['Three meetings today.'])
    expect(telegram.typingCalls[0]).toEqual({ conversationId: 'chat-1', on: true })
  })

  it('replies on the app the owner last texted from', async () => {
    await pairOwner('imessage', '+15555550100')
    await router.handleInbound(inbound('hi from imessage', { channel: 'imessage', conversationId: 'space-7', senderId: '+15555550100' }))
    const threadId = store.read().threadId!
    runtime.reply(threadId, 'runA', 'Hey! **Here**.')
    router.handlePush(runEvent(threadId, 'runA', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(imessage.sent).toEqual([{ conversationId: 'space-7', text: 'Hey! Here.', options: undefined }])
    expect(telegram.sent).toHaveLength(0)
  })

  it('keeps replies on the desktop when the owner last typed there', async () => {
    const threadId = store.read().threadId!
    runtime.userMessage(threadId, 'refactor the parser (typed in the app)')
    router.handlePush({ kind: 'message.updated', message: runtime.messages.get(threadId)!.at(-1)! })
    runtime.reply(threadId, 'runD', 'Done refactoring.')
    router.handlePush(runEvent(threadId, 'runD', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toHaveLength(0)
    expect(store.read().delivered).toHaveLength(1)
  })

  it('texts results of background work that finished after a phone request', async () => {
    await router.handleInbound(inbound('run the scraper in the background'))
    const threadId = store.read().threadId!
    runtime.reply(threadId, 'run1', 'Started it, will report back.')
    router.handlePush(runEvent(threadId, 'run1', { type: 'run.completed', reason: 'done' }))
    runtime.userMessage(threadId, 'background job finished: 42 rows', { kind: 'shell', label: 'shell' } as ChatMessage['origin'])
    runtime.reply(threadId, 'run2', 'Scraper finished with 42 rows.')
    router.handlePush(runEvent(threadId, 'run2', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['Started it, will report back.', 'Scraper finished with 42 rows.'])
  })

  it('reports a failed run that produced no text', async () => {
    await router.handleInbound(inbound('do the thing'))
    const threadId = store.read().threadId!
    router.handlePush(runEvent(threadId, 'runE', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(runEvent(threadId, 'runE', { type: 'error', category: 'provider', message: 'provider unavailable', retryable: true } as unknown as RunEvent['body']))
    router.handlePush(runEvent(threadId, 'runE', { type: 'run.completed', reason: 'error' }))
    await router.idle()
    expect(telegram.texts()).toEqual(["that didn't work: provider unavailable. text me again to retry."])
  })

  it('ignores subagent events and other threads', async () => {
    await router.handleInbound(inbound('go'))
    const threadId = store.read().threadId!
    runtime.reply(threadId, 'runS', 'final')
    router.handlePush({ kind: 'run.event', event: { id: 'e', runId: 'runS', threadId, seq: 1, ts: 0, agent: 'sub1', body: { type: 'run.completed', reason: 'done' } } as unknown as RunEvent })
    router.handlePush(runEvent('other-thread', 'runS', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toHaveLength(0)
  })

  it('recreates the thread and retries when it was deleted underneath', async () => {
    runtime.failNextSendWithMissingThread = true
    const before = store.read().threadId
    await router.handleInbound(inbound('still there?'))
    expect(store.read().threadId).not.toBe(before)
    expect(runtime.sends).toHaveLength(1)
  })

  it('passes image attachments through attachFile', async () => {
    await router.handleInbound(inbound('what is this', { attachments: [{ path: '/tmp/p.png', name: 'p.png', mime: 'image/png', kind: 'image' }] }))
    expect(runtime.sends[0]!.attachments).toEqual([expect.objectContaining({ path: '/tmp/p.png', kind: 'image' })])
  })

  it('hands documents, and images the runtime cannot attach, to the assistant by path', async () => {
    const api = runtime.api()
    api.attachFile = async () => {
      throw new Error('Only PNG, JPEG, WebP, and GIF images can be attached.')
    }
    router.detach()
    await router.attach(api)
    await router.handleInbound(inbound('summarize this', { attachments: [
      { path: '/Users/me/LatticeAssistant/Inbox/telegram-1-u1-lease.pdf', name: 'lease.pdf', mime: 'application/pdf', kind: 'file' },
      { path: '/Users/me/LatticeAssistant/Inbox/telegram-2-u2-IMG_1.heic', name: 'IMG_1.heic', mime: 'image/heic', kind: 'image' }
    ] }))
    const sent = runtime.sends.at(-1)!
    expect(sent.attachments).toBeUndefined()
    expect(sent.text.split('\n').slice(1)).toEqual([
      '(sent a file "lease.pdf", saved at /Users/me/LatticeAssistant/Inbox/telegram-1-u1-lease.pdf)',
      '(sent an image "IMG_1.heic", saved at /Users/me/LatticeAssistant/Inbox/telegram-2-u2-IMG_1.heic)',
      'summarize this'
    ])
  })

  it('asks for text instead of a voice note when transcription is off', async () => {
    await router.handleInbound(inbound('', { attachments: [{ path: '/tmp/v.ogg', name: 'v.ogg', mime: 'audio/ogg', kind: 'audio' }] }))
    expect(runtime.sends).toHaveLength(0)
    expect(telegram.texts()[0]).toContain("can't listen to voice notes")
  })
})

describe('transcribed voice notes', () => {
  it('sends the transcript as the message', async () => {
    router = new ChannelRouter({ dataDir: dir, store, config, adapters: new Map([['telegram', telegram]]), log: () => undefined, transcribe: async () => 'remind me to call mom' })
    await pairOwner()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('', { attachments: [{ path: '/tmp/v.ogg', name: 'v.ogg', mime: 'audio/ogg', kind: 'audio' }] }))
    expect(runtime.sends[0]!.text.endsWith('(voice note) remind me to call mom')).toBe(true)
  })
})

describe('approvals and questions over text', () => {
  const approval = (id: string, threadId: string): ApprovalRequest => ({ id, runId: 'r', threadId, callId: 'c', tool: 'shell', args: {}, summary: 'Run npm publish', resource: 'shell', action: 'execute', riskTier: 'R3' } as unknown as ApprovalRequest)

  beforeEach(async () => {
    await pairOwner()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('publish it'))
    telegram.sent.length = 0
  })

  it('texts an approval with buttons and approves on a plain "yes"', async () => {
    const threadId = store.read().threadId!
    router.handlePush({ kind: 'approval.request', request: approval('ap1', threadId) })
    await router.idle()
    expect(telegram.sent[0]!.text).toBe('⚠️ ok to run npm publish?')
    expect(telegram.sent[0]!.options?.buttons?.[0]).toHaveLength(3)
    const before = telegram.sent.length
    await router.handleInbound(inbound('yes'))
    expect(runtime.approvalsAnswered).toEqual([{ requestId: 'ap1', effect: 'allow', scope: 'once' }])
    expect(runtime.sends).toHaveLength(1)
    // A yes needs no echo: the work itself is the answer.
    expect(telegram.sent).toHaveLength(before)
  })

  it('treats the Always button as a saved thread rule', async () => {
    const threadId = store.read().threadId!
    router.handlePush({ kind: 'approval.request', request: approval('ap2', threadId) })
    await router.handleInbound(inbound('', { callback: { data: 'lat:ap:always:ap2' } }))
    expect(runtime.approvalsAnswered).toEqual([{ requestId: 'ap2', effect: 'allow', scope: 'thread', saveRule: true }])
  })

  it('reminds about a pending approval when the owner texts something else', async () => {
    const threadId = store.read().threadId!
    router.handlePush({ kind: 'approval.request', request: approval('ap3', threadId) })
    await router.handleInbound(inbound('wait, which version?'))
    expect(runtime.sends).toHaveLength(2)
    expect(telegram.texts().at(-1)).toContain('(still waiting on a yes or no for: Run npm publish)')
  })

  it('does not re-answer an approval resolved on the desktop', async () => {
    const threadId = store.read().threadId!
    router.handlePush({ kind: 'approval.request', request: approval('ap4', threadId) })
    router.handlePush({ kind: 'approval.resolved', requestId: 'ap4' })
    await router.handleInbound(inbound('', { callback: { data: 'lat:ap:allow:ap4' } }))
    expect(runtime.approvalsAnswered).toHaveLength(0)
    expect(telegram.texts().at(-1)).toContain('already handled')
  })

  it('answers a choice question with the chosen option', async () => {
    const threadId = store.read().threadId!
    const ask = { id: 'q1', runId: 'r', threadId, callId: 'c', question: 'Which seat?', kind: 'choice', options: [{ label: 'Aisle' }, { label: 'Window' }] } as AskRequest
    router.handlePush({ kind: 'ask.request', request: ask })
    await router.idle()
    expect(telegram.texts().at(-1)).toContain('1. Aisle')
    await router.handleInbound(inbound('2'))
    expect(runtime.asksAnswered).toEqual([{ requestId: 'q1', answer: 'Window' }])
  })

  it('picks up approvals that were already pending when the gateway connected', async () => {
    const threadId = store.read().threadId!
    runtime.pendingApprovals = [approval('ap5', threadId)]
    router.detach()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('ok'))
    expect(runtime.approvalsAnswered).toEqual([{ requestId: 'ap5', effect: 'allow', scope: 'once' }])
  })
})

describe('commands', () => {
  beforeEach(async () => {
    await pairOwner()
    await router.attach(runtime.api())
  })

  it('/new clears the slate on the same thread by rolling everything into memory', async () => {
    const before = store.read().threadId
    await router.handleInbound(inbound('/new'))
    expect(store.read().threadId).toBe(before)
    expect(runtime.threads.size).toBe(1)
    expect(runtime.rolls).toEqual([{ id: before, keepTokens: 0 }])
    expect(telegram.texts().at(-1)).toBe('fresh start. i folded our conversation into memory (3 things saved), so i still know what matters.')
    runtime.rollResult = { ok: false, reason: 'Nothing to roll yet.' }
    await router.handleInbound(inbound('/new'))
    expect(telegram.texts().at(-1)).toBe("we're already on a clean slate.")
  })

  it('/new falls back to a new thread on a runtime without rolling', async () => {
    runtime.supportsRolling = false
    const before = store.read().threadId
    await router.handleInbound(inbound('/new'))
    expect(store.read().threadId).not.toBe(before)
    expect(telegram.texts().at(-1)).toContain('started a fresh conversation')
  })

  it('/model switches on a unique match and lists ambiguous ones', async () => {
    await router.handleInbound(inbound('/model deepseek'))
    expect(telegram.texts().at(-1)).toContain('matches 2 models')
    await router.handleInbound(inbound('/model v4-pro'))
    expect(runtime.threads.get(store.read().threadId!)!.model).toBe('deepseek/deepseek-v4-pro')
    expect(config.assistant.model).toBe('deepseek/deepseek-v4-pro')
  })

  it('/remember writes an approved user memory', async () => {
    await router.handleInbound(inbound("/remember Sam's birthday is May 3"))
    expect(runtime.memories).toEqual([expect.objectContaining({ content: "Sam's birthday is May 3", status: 'approved', author: 'user', scope: 'user' })])
  })

  it('/stop stops all work on the thread', async () => {
    await router.handleInbound(inbound('/stop'))
    expect(runtime.stopped).toEqual([store.read().threadId])
  })

  it('/pair issues a code for linking another app', async () => {
    await router.handleInbound(inbound('/pair'))
    const code = store.read().pairing?.code
    expect(code).toMatch(/^\d{6}$/)
    expect(telegram.texts().at(-1)).toContain(`/pair ${code}`)
  })

  it('passes unknown slash words to the assistant', async () => {
    await router.handleInbound(inbound('/weather tomorrow'))
    expect(runtime.sends).toHaveLength(1)
  })
})

describe('offline and reconnect', () => {
  it('saves texts while Lattice is down, says so once, and replays them on reconnect', async () => {
    await pairOwner()
    await router.handleInbound(inbound('first'))
    await router.handleInbound(inbound('second'))
    expect(telegram.texts().filter((text) => text.includes("can't reach lattice"))).toHaveLength(1)
    expect(store.read().pendingInbound).toHaveLength(2)
    await router.attach(runtime.api())
    expect(runtime.sends.map((send) => send.text.split('\n').slice(1).join('\n'))).toEqual(['(sent while Lattice was offline)\nfirst', '(sent while Lattice was offline)\nsecond'])
    expect(store.read().pendingInbound).toHaveLength(0)
  })

  it('delivers replies that settled while the gateway was away, but never older history', async () => {
    await pairOwner()
    await router.attach(runtime.api())
    const threadId = store.read().threadId!
    runtime.messages.get(threadId)!.push({ id: 'old', threadId, runId: 'old-run', role: 'assistant', createdAt: -5, text: 'ancient', status: 'complete' })
    await router.handleInbound(inbound('check the build'))
    router.detach()
    runtime.reply(threadId, 'runX', 'Build is green.')
    await router.attach(runtime.api())
    expect(telegram.texts()).toEqual(['Build is green.'])
    router.detach()
    await router.attach(runtime.api())
    expect(telegram.texts()).toEqual(['Build is green.'])
  })
})

describe('voice turns', () => {
  beforeEach(async () => {
    await pairOwner()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('hi'))
    telegram.sent.length = 0
  })

  it('does not text an answer the call already spoke', async () => {
    const turn = await router.sendVoiceTurn('what is on my calendar')
    expect(turn?.busy).toBe(false)
    expect(runtime.sends.at(-1)!.text.startsWith('[Phone call · ')).toBe(true)
    runtime.reply(turn!.threadId, turn!.runId, 'Two meetings.')
    router.setVoiceRunState(turn!.runId, 'spoken')
    router.handlePush(runEvent(turn!.threadId, turn!.runId, { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toHaveLength(0)
  })

  it('does not show a typing indicator on the text app during a call, even when run.started wins the race', async () => {
    telegram.typingCalls.length = 0
    runtime.beforeSendResolves = (threadId, runId) => router.handlePush(runEvent(threadId, runId, { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    const turn = await router.sendVoiceTurn('what time is it')
    runtime.beforeSendResolves = undefined
    expect(telegram.typingCalls).toHaveLength(0)
    runtime.reply(turn!.threadId, turn!.runId, 'Four thirty.')
    router.setVoiceRunState(turn!.runId, 'spoken')
    router.handlePush(runEvent(turn!.threadId, turn!.runId, { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toHaveLength(0)
  })

  it('texts the answer when the call handed off', async () => {
    const turn = await router.sendVoiceTurn('research flights to Denver')
    runtime.reply(turn!.threadId, turn!.runId, 'Cheapest is $142 on Frontier.')
    router.setVoiceRunState(turn!.runId, 'overflow')
    router.handlePush(runEvent(turn!.threadId, turn!.runId, { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['Cheapest is $142 on Frontier.'])
  })

  it('reports a busy thread so the caller is told the answer comes by text', async () => {
    runtime.running.add(store.read().threadId!)
    const turn = await router.sendVoiceTurn('and also book it')
    expect(turn?.busy).toBe(true)
  })
})

describe('files in replies', () => {
  let home: string

  beforeEach(async () => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'lattice-home-')))
    router = new ChannelRouter({
      dataDir: dir,
      store,
      config,
      adapters: new Map<ChannelId, ChannelAdapter>([['telegram', telegram], ['imessage', imessage]]),
      log: (line) => logs.push(line),
      outboundPolicy: (maxBytes) => ({ home, extraRoots: [], maxBytes }),
      bubbleGapMs: 0
    })
    await pairOwner()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('make me a chart'))
    telegram.sent.length = 0
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  function write(relative: string, bytes = 'data'): string {
    const path = join(home, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, bytes)
    return path
  }

  function complete(text: string): Promise<void> {
    const threadId = store.read().threadId!
    runtime.reply(threadId, 'runF', text)
    router.handlePush(runEvent(threadId, 'runF', { type: 'run.completed', reason: 'done' }))
    return router.idle()
  }

  it('texts the words, then uploads each linked file once', async () => {
    const chart = write('LatticeAssistant/chart.png')
    const report = write('Documents/report.pdf')
    await complete(`Here you go.\n\n![chart](${chart})\n\nAnd the [full report](file://${report}), plus the chart again: ![](${chart})`)
    expect(telegram.texts()).toEqual(['Here you go.', 'And the full report, plus the chart again:'])
    expect(telegram.files.map((item) => [item.conversationId, item.file.name, item.file.kind, item.file.caption])).toEqual([
      ['chat-1', 'chart.png', 'image', undefined],
      ['chat-1', 'report.pdf', 'file', undefined]
    ])
  })

  it('captions a lone image with its alt text', async () => {
    const photo = write('Desktop/sunset.jpg')
    await complete(`![Sunset from the roof](${photo})`)
    expect(telegram.sent).toHaveLength(0)
    expect(telegram.files[0]!.file).toMatchObject({ name: 'sunset.jpg', mime: 'image/jpeg', caption: 'Sunset from the roof' })
  })

  it('says which files it would not send, and why', async () => {
    const key = write('.ssh/id_ed25519')
    const big = write('Movies/clip.mov', 'x'.repeat(4096))
    await complete(`Sure: [key](${key}) and [clip](${big}) and [ghost](${join(home, 'nope.txt')})`)
    expect(telegram.files).toHaveLength(0)
    const all = telegram.texts().join('\n')
    expect(telegram.texts()[0]).toBe('Sure: key and clip and ghost')
    expect(all).toContain("(couldn't send key: looks like a key or credentials file)")
    expect(all).toContain("(couldn't send clip: larger than the 1 KB upload limit)")
    expect(all).toContain("(couldn't send ghost: file not found)")
    expect(logs.some((line) => line.includes('not sending'))).toBe(true)
  })

  it('reports a failed upload instead of dropping it', async () => {
    telegram.failUpload = true
    const chart = write('chart.png')
    await complete(`Chart: ![c](${chart})`)
    expect(telegram.texts()).toEqual(['Chart:', "(couldn't send chart.png: Request Entity Too Large)"])
  })

  it('names the file on channels that cannot upload', async () => {
    const chart = write('chart.png')
    Object.defineProperty(imessage, 'sendFile', { value: undefined }) // a channel without uploads
    await pairOwner('imessage', '+15555550100')
    await router.handleInbound(inbound('and on imessage?', { channel: 'imessage', conversationId: 'space-7', senderId: '+15555550100' }))
    await complete(`Here: ![c](${chart})`)
    expect(imessage.texts().slice(-2)).toEqual(['Here:', `(file on the computer: ${chart})`])
  })

  it('applies the file policy on channels that cannot upload, too', async () => {
    const key = write('.ssh/id_ed25519')
    Object.defineProperty(imessage, 'sendFile', { value: undefined })
    await pairOwner('imessage', '+15555550100')
    await router.handleInbound(inbound('and on imessage?', { channel: 'imessage', conversationId: 'space-7', senderId: '+15555550100' }))
    await complete(`Here: ![k](${key})`)
    expect(imessage.texts().slice(-2)).toEqual(['Here:', "(couldn't send k: looks like a key or credentials file)"])
    expect(imessage.texts().join('\n')).not.toContain(key)
  })

  it('sends at most ten files from one reply and says how many it held back', async () => {
    const links = Array.from({ length: 12 }, (_, index) => `[f${index}](${write(`batch/file-${index}.txt`)})`)
    await complete(`All of them: ${links.join(' ')}`)
    expect(telegram.files).toHaveLength(10)
    expect(telegram.texts().join('\n')).toContain('(2 more files not sent; ask for them by name)')
  })

  it('delivers files whose names contain parentheses', async () => {
    const shot = write('Desktop/Screenshot (1).png')
    await complete(`![shot](${shot})`)
    expect(telegram.files.map((item) => item.file.name)).toEqual(['Screenshot (1).png'])
    expect(telegram.sent).toHaveLength(0)
  })

  it('attaches files to a notify', async () => {
    const log = write('build.log')
    await router.notify('Build finished', [log])
    expect(telegram.texts()).toEqual(['Build finished'])
    expect(telegram.files.map((item) => item.file.name)).toEqual(['build.log'])
  })
})

describe('notify', () => {
  it('texts the last conversation, and explains when there is none', async () => {
    await pairOwner()
    await router.attach(runtime.api())
    await expect(router.notify('nobody home')).rejects.toThrow(/no conversation yet/)
    expect(logs.some((line) => line.includes('no conversation yet'))).toBe(true)
    await router.handleInbound(inbound('hi'))
    await router.notify('Deploy finished ✅')
    expect(telegram.texts().at(-1)).toBe('Deploy finished ✅')
  })
})

describe('texting while it works', () => {
  let threadId: string

  function delta(runId: string, text: string): PushEvent {
    return runEvent(threadId, runId, { type: 'text.delta', text } as RunEvent['body'])
  }

  function toolProposed(runId: string, tool: string, args: Record<string, unknown> = {}): PushEvent {
    return runEvent(threadId, runId, { type: 'tool.proposed', callId: `c-${tool}`, tool, args, riskTier: 'R0' } as RunEvent['body'])
  }

  const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

  beforeEach(async () => {
    await pairOwner()
    await router.attach(runtime.api())
    await router.handleInbound(inbound('did the vinyl images go through?'))
    threadId = store.read().threadId!
    telegram.sent.length = 0
  })

  it('texts the heads-up the moment a tool starts, then only the rest of the answer at the end', async () => {
    router.handlePush(runEvent(threadId, 'r1', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(delta('r1', 'on it, checking seller central'))
    router.handlePush(toolProposed('r1', 'web_fetch', { url: 'https://sellercentral.amazon.com/imaging' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['on it, checking seller central'])

    router.handlePush(delta('r1', 'yes, all 8 slots are live.\n\n'))
    router.handlePush(delta('r1', '7 show on the public page though'))
    runtime.reply(threadId, 'r1', 'on it, checking seller centralyes, all 8 slots are live.\n\n7 show on the public page though')
    router.handlePush(runEvent(threadId, 'r1', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['on it, checking seller central', 'yes, all 8 slots are live.', '7 show on the public page though'])
    expect(store.read().delivered).toHaveLength(1)
  })

  it('never texts the same words twice when the model repeats itself after a tool call', async () => {
    router.handlePush(runEvent(threadId, 'r2', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(delta('r2', '**$1.32** left on DeepSeek.'))
    router.handlePush(toolProposed('r2', 'memory_save'))
    router.handlePush(delta('r2', '$1.32 left on deepseek.'))
    runtime.reply(threadId, 'r2', 'x')
    router.handlePush(runEvent(threadId, 'r2', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.texts()).toEqual(['$1.32 left on DeepSeek.'])
  })

  it('sends nothing for a notice the assistant acknowledged with NO_REPLY', async () => {
    runtime.userMessage(threadId, '⏳ Background job job_1 has finished (exit 0).', { kind: 'shell', label: 'shell' } as ChatMessage['origin'])
    router.handlePush(runEvent(threadId, 'r3', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(delta('r3', 'NO_REPLY'))
    runtime.reply(threadId, 'r3', 'NO_REPLY')
    router.handlePush(runEvent(threadId, 'r3', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toHaveLength(0)
    expect(store.read().delivered).toHaveLength(1)
  })

  it('renders markdown to plain text with entities instead of markup', async () => {
    router.handlePush(runEvent(threadId, 'r4', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(delta('r4', 'run `lattice channels pair` on the mac'))
    runtime.reply(threadId, 'r4', 'run `lattice channels pair` on the mac')
    router.handlePush(runEvent(threadId, 'r4', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.sent).toEqual([
      { conversationId: 'chat-1', text: 'run lattice channels pair on the mac', options: { entities: [{ type: 'code', offset: 4, length: 21 }] } }
    ])
  })

  it('reads a run it did not watch from the runtime event log, so segments stay separate', async () => {
    runtime.reply(threadId, 'r5', 'on it.done, 3 new orders.')
    runtime.runEvents.set('r5', [
      { id: 'a', runId: 'r5', threadId, seq: 1, ts: 1, body: { type: 'text.delta', text: 'on it.' } },
      { id: 'b', runId: 'r5', threadId, seq: 2, ts: 2, body: { type: 'tool.started', callId: 'c', tool: 'web_fetch', args: {} } },
      { id: 'c', runId: 'r5', threadId, seq: 3, ts: 3, body: { type: 'text.delta', text: 'done, 3 new orders.' } }
    ] as RunEvent[])
    router.detach()
    await router.attach(runtime.api())
    expect(telegram.texts()).toEqual(['on it.', 'done, 3 new orders.'])
  })

  it('sends status updates while a long task stays quiet, naming what it is doing', async () => {
    config.assistant.progressNoticeMs = 40
    config.assistant.progressEveryMs = 60
    router.handlePush(runEvent(threadId, 'r6', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(toolProposed('r6', 'web_fetch', { url: 'https://www.ebay.com/sh/ovw' }))
    await sleep(80)
    await router.idle()
    expect(telegram.texts()).toEqual(['still on it, reading ebay.com'])
    router.handlePush(toolProposed('r6', 'shell', { command: 'ssh pve bash', purpose: 'Check the Radarr queue' }))
    await sleep(140)
    await router.idle()
    expect(telegram.texts()[1]).toBe('still going, check the Radarr queue')
    runtime.reply(threadId, 'r6', 'done')
    router.handlePush(runEvent(threadId, 'r6', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    const count = telegram.sent.length
    await sleep(150)
    expect(telegram.sent.length).toBe(count)
  })

  it('holds status updates while an approval is waiting', async () => {
    config.assistant.progressNoticeMs = 30
    config.assistant.progressEveryMs = 30
    router.handlePush(runEvent(threadId, 'r7', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush({ kind: 'approval.request', request: { id: 'ap', runId: 'r7', threadId, callId: 'c', tool: 'shell', summary: 'Delete the old export', riskTier: 'R3', args: {} } as unknown as ApprovalRequest })
    await sleep(100)
    await router.idle()
    expect(telegram.texts().filter((text) => text.startsWith('still'))).toHaveLength(0)
    router.handlePush(runEvent(threadId, 'r7', { type: 'run.completed', reason: 'done' }))
    await router.idle()
  })

  it('answers "update?" with a status when the model has not replied to it soon', async () => {
    router = new ChannelRouter({ dataDir: dir, store, config, adapters: new Map<ChannelId, ChannelAdapter>([['telegram', telegram]]), log: () => undefined, bubbleGapMs: 0, steerAckMs: 40 })
    await router.attach(runtime.api())
    router.handlePush(runEvent(threadId, 'r8', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    router.handlePush(toolProposed('r8', 'shell', { command: 'ssh x', purpose: 'Rescan the Jellyfin library' }))
    await router.handleInbound(inbound('update?'))
    await sleep(80)
    await router.idle()
    expect(telegram.texts().at(-1)).toBe('got it. still on it, rescan the Jellyfin library')
    router.handlePush(runEvent(threadId, 'r8', { type: 'run.completed', reason: 'done' }))
    await router.idle()
  })

  it('sends images the model shows right away, once, and does not re-upload them when the reply links the same file', async () => {
    const shot = join(dir, 'assistant', 'shots', 'captcha.png')
    mkdirSync(join(dir, 'assistant', 'shots'), { recursive: true })
    writeFileSync(shot, Buffer.from('iVBORw0KGgo=', 'base64'))
    const data = Buffer.from('iVBORw0KGgo=', 'base64').toString('base64')
    router.handlePush(runEvent(threadId, 'r9', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    const result = { type: 'tool.result', callId: 'c', tool: 'show_image', ok: true, durationMs: 1, result: { type: 'image', mimeType: 'image/png', data, path: shot, caption: 'the wall' } }
    router.handlePush(runEvent(threadId, 'r9', result as unknown as RunEvent['body']))
    router.handlePush(runEvent(threadId, 'r9', result as unknown as RunEvent['body']))
    await router.idle()
    expect(telegram.files.map((item) => [item.file.name, item.file.caption])).toEqual([['captcha.png', 'the wall']])
    router.handlePush(delta('r9', `that's the captcha ![](${shot})`))
    runtime.reply(threadId, 'r9', `that's the captcha ![](${shot})`)
    router.handlePush(runEvent(threadId, 'r9', { type: 'run.completed', reason: 'done' }))
    await router.idle()
    expect(telegram.files).toHaveLength(1)
    expect(telegram.texts()).toEqual(["that's the captcha"])
  })

  it('writes shown image bytes with no usable path to a temp file and sends that', async () => {
    router.handlePush(runEvent(threadId, 'r10', { type: 'run.started', model: 'm', mode: 'act' } as RunEvent['body']))
    const result = { type: 'tool.result', callId: 'c', tool: 'show_image_data', ok: true, durationMs: 1, result: { type: 'image', mimeType: 'image/jpeg', data: Buffer.from('jpeg-bytes').toString('base64') } }
    router.handlePush(runEvent(threadId, 'r10', result as unknown as RunEvent['body']))
    await router.idle()
    expect(telegram.files).toHaveLength(1)
    expect(telegram.files[0]!.file).toMatchObject({ mime: 'image/jpeg', kind: 'image' })
    router.handlePush(runEvent(threadId, 'r10', { type: 'run.completed', reason: 'done' }))
    await router.idle()
  })
})

describe('older runtimes', () => {
  it('carries the texting voice in the goal when the runtime drops the texting style', async () => {
    runtime.supportsTexting = false
    await pairOwner()
    await router.attach(runtime.api())
    const thread = runtime.threads.get(store.read().threadId!)!
    expect(thread.goal).toContain('NO_REPLY')
    expect(router.statusSnapshot().texting).toBe(false)
  })
})
