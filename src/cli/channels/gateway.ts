/**
 * `lattice channels serve` — the long-lived gateway process.
 *
 * It attaches to the Lattice runtime the same way the CLI does (the live app's control socket by
 * default, a remote bridge, or an embedded runtime for a headless box) and keeps that connection
 * alive across app restarts. Channel adapters start independently of the runtime connection, so a
 * text that arrives while Lattice is restarting is acknowledged, saved, and replayed on reconnect.
 *
 * A unix socket next to the config (`gateway.sock`, 0600) serves `status` and `notify` to one-shot
 * CLI commands and doubles as the single-instance guard.
 */
import { createConnection, createServer, type Server } from 'node:net'
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, unlinkSync, unwatchFile, watchFile } from 'node:fs'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { isPidAlive } from '../../main/runtimeLock'
import { connectLocalTransport, readRuntimeInfo } from '../transport/socket'
import { connectRemoteTransport } from '../transport/remote'
import { TransportError, type LatticeTransport } from '../transport/types'
import { TelegramAdapter } from './adapters/telegram'
import { PhotonAdapter } from './adapters/photon'
import { channelsPaths, isOwner, issuePairingCode, loadConfig, StateStore, type ChannelsConfig } from './config'
import { inboxDir } from './files'
import { ChannelRouter } from './router'
import { createTranscriber } from './transcribe'
import { pointVapiAssistant, QuickTunnel } from './tunnel'
import type { ChannelAdapter, ChannelId, Logger } from './types'
import { VoiceServer } from './voice'

export interface GatewayOptions {
  dataDir: string
  remote?: string
  token?: string
  password?: string
  embedded?: boolean
  /** Running under launchd (or another supervisor) that restarts the process when it exits. */
  supervised?: boolean
  log: Logger
  /**
   * Called when `config.json` changes on disk to something other than what this process holds
   * (a `channels setup …` run). A supervised gateway exits so launchd restarts it with the change.
   */
  onConfigChange?: () => void
}

/** Files the owner sent stay in the assistant's Inbox for a month, long enough to ask about them later. */
const MEDIA_MAX_AGE_MS = 30 * 24 * 60 * 60_000

export class EventHub {
  private readonly listeners = new Set<(event: PushEvent) => void>()

  constructor(private readonly log: Logger) {}

  subscribe(listener: (event: PushEvent) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit(event: PushEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.log(`hub: listener failed: ${(error as Error).message}`)
      }
    }
  }
}

/** Ask a running gateway something over its control socket. Rejects when none is running. */
export function queryGateway(socketPath: string, request: Record<string, unknown>, timeoutMs = 5_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath)
    let buffer = ''
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error('gateway did not answer'))
    }, timeoutMs)
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    socket.on('connect', () => socket.write(`${JSON.stringify(request)}\n`))
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline < 0) return
      clearTimeout(timer)
      socket.end()
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as Record<string, unknown>)
      } catch (error) {
        reject(error)
      }
    })
  })
}

export function pruneMedia(dir: string, maxAgeMs = MEDIA_MAX_AGE_MS, now = Date.now()): number {
  if (!existsSync(dir)) return 0
  let removed = 0
  for (const name of readdirSync(dir)) {
    const path = join(dir, name)
    try {
      if (now - statSync(path).mtimeMs > maxAgeMs) {
        rmSync(path, { force: true })
        removed += 1
      }
    } catch {
      /* raced with another cleanup */
    }
  }
  return removed
}

export function buildAdapters(config: ChannelsConfig, dataDir: string, store: StateStore, log: Logger): Map<ChannelId, ChannelAdapter> {
  const paths = channelsPaths(dataDir)
  const mediaDir = inboxDir(config.assistant.workspaceRoot)
  const adapters = new Map<ChannelId, ChannelAdapter>()
  if (config.telegram?.enabled && config.telegram.botToken) {
    adapters.set('telegram', new TelegramAdapter({
      botToken: config.telegram.botToken,
      apiBase: config.telegram.apiBase,
      mediaDir,
      log,
      mayDownload: (senderId) => isOwner(store.read(), 'telegram', senderId),
      loadOffset: () => store.read().telegramOffset,
      saveOffset: (offset) => {
        store.update((state) => {
          state.telegramOffset = offset
        })
      }
    }))
  }
  if (config.imessage?.enabled && config.imessage.projectId && config.imessage.projectSecret) {
    adapters.set('imessage', new PhotonAdapter({
      projectId: config.imessage.projectId,
      projectSecret: config.imessage.projectSecret,
      sdkDir: paths.photonSdk,
      mediaDir,
      log,
      mayDownload: (senderId) => isOwner(store.read(), 'imessage', senderId)
    }))
  }
  return adapters
}

export class Gateway {
  private readonly paths: ReturnType<typeof channelsPaths>
  private readonly store: StateStore
  private readonly config: ChannelsConfig
  private readonly hub: EventHub
  private readonly router: ChannelRouter
  private readonly adapters: Map<ChannelId, ChannelAdapter>
  private voice: VoiceServer | null = null
  private tunnel: QuickTunnel | null = null
  private control: Server | null = null
  private transport: LatticeTransport | null = null
  private stopping = false
  private wake: (() => void) | null = null
  private loop: Promise<void> | null = null
  private mediaTimer: ReturnType<typeof setInterval> | null = null
  private runtimeMode = 'disconnected'

  constructor(private readonly options: GatewayOptions) {
    this.paths = channelsPaths(options.dataDir)
    mkdirSync(this.paths.dir, { recursive: true, mode: 0o700 })
    this.store = StateStore.forDataDir(options.dataDir)
    // Materialize state now so the delivery cursor is pinned to first boot, not to first write.
    this.store.update(() => undefined)
    this.config = loadConfig(options.dataDir)
    this.hub = new EventHub(options.log)
    this.adapters = buildAdapters(this.config, options.dataDir, this.store, options.log)
    this.router = new ChannelRouter({
      dataDir: options.dataDir,
      store: this.store,
      config: this.config,
      adapters: this.adapters,
      log: options.log,
      transcribe: this.config.transcription ? createTranscriber(this.config.transcription) : undefined,
      runtimeIsLocal: !(options.remote ?? this.config.runtime?.remote)
    })
    this.hub.subscribe((event) => this.router.handlePush(event))
  }

  async start(): Promise<void> {
    const { log } = this.options
    await this.listenControl()
    this.watchConfig()
    if (this.adapters.size === 0 && !this.config.voice?.enabled) {
      // Nothing can reach the assistant, so do not attach (and create its thread) yet.
      log('gateway: no channels are enabled. Run `lattice channels setup telegram` (or imessage / voice) first.')
      return
    }
    for (const adapter of this.adapters.values()) void this.startAdapter(adapter)
    if (this.config.voice?.enabled) await this.startVoice()
    const prune = (): void => {
      pruneMedia(inboxDir(this.config.assistant.workspaceRoot))
      pruneMedia(this.paths.media) // where older gateways saved media
    }
    prune()
    this.mediaTimer = setInterval(prune, 6 * 60 * 60_000)
    this.mediaTimer.unref?.()
    this.loop = this.connectionLoop()
  }

  private watchConfig(): void {
    const onChange = this.options.onConfigChange
    if (!onChange) return
    watchFile(this.paths.config, { interval: 3_000, persistent: false }, (current, previous) => {
      if (current.mtimeMs === previous.mtimeMs || this.stopping) return
      try {
        // The router persists `/model` into the same file; a write that matches what this process
        // already holds is its own, not a new setup.
        if (JSON.stringify(loadConfig(this.options.dataDir)) === JSON.stringify(this.config)) return
      } catch {
        return // a half-edited file; the next change will be picked up
      }
      this.options.log('gateway: config.json changed')
      onChange()
    })
  }

  private async startAdapter(adapter: ChannelAdapter): Promise<void> {
    let backoff = 5_000
    while (!this.stopping) {
      try {
        await adapter.start((message) => {
          void this.router.handleInbound(message)
        })
        const status = adapter.status()
        this.options.log(`gateway: ${adapter.id} up${status.identity ? ` as ${status.identity}` : ''}`)
        return
      } catch (error) {
        this.options.log(`gateway: ${adapter.id} failed to start (${(error as Error).message}); retrying in ${backoff / 1000}s`)
        await this.sleep(backoff)
        backoff = Math.min(backoff * 2, 5 * 60_000)
      }
    }
  }

  private async startVoice(): Promise<void> {
    const voiceConfig = this.config.voice!
    if (!voiceConfig.secret) {
      this.options.log('gateway: voice is enabled but has no secret; run `lattice channels setup voice`')
      return
    }
    this.voice = new VoiceServer({
      config: voiceConfig,
      router: this.router,
      subscribe: (listener) => this.hub.subscribe(listener),
      log: this.options.log
    })
    const port = await this.voice.start()
    if (!voiceConfig.quickTunnel) return
    this.tunnel = new QuickTunnel(port, this.options.log, (url) => {
      if (!voiceConfig.vapiApiKey || !voiceConfig.vapiAssistantId) return
      void pointVapiAssistant({ apiKey: voiceConfig.vapiApiKey, assistantId: voiceConfig.vapiAssistantId, baseUrl: url })
        .then(() => this.options.log('tunnel: Vapi assistant now points at the new URL'))
        .catch((error: Error) => this.options.log(`tunnel: could not update the Vapi assistant: ${error.message}`))
    })
    this.tunnel.start()
  }

  private async connect(): Promise<LatticeTransport> {
    const remote = this.options.remote ?? this.config.runtime?.remote
    if (remote) {
      return connectRemoteTransport({ endpoint: remote, token: this.options.token, password: this.options.password, device: 'lattice-channels' })
    }
    if (this.options.embedded ?? this.config.runtime?.embedded) {
      const { createEmbeddedTransport } = await import('../transport/embedded')
      return createEmbeddedTransport({ dataDir: this.options.dataDir })
    }
    const runtime = await readRuntimeInfo(this.options.dataDir)
    if (!runtime || !isPidAlive(runtime.pid)) throw new TransportError(`Lattice is not running (no live runtime in ${this.options.dataDir})`)
    return connectLocalTransport({ path: runtime.socket, timeoutMs: 3_000 })
  }

  private async connectionLoop(): Promise<void> {
    const { log } = this.options
    let backoff = 1_000
    let lastFailure = ''
    while (!this.stopping) {
      try {
        this.transport = await this.connect()
        // stop() may have run while connect() was pending; it could not close a transport that did
        // not exist yet, so nothing would ever end the event stream below.
        if (this.stopping) {
          await this.transport.close().catch(() => undefined)
          this.transport = null
          break
        }
        this.runtimeMode = this.transport.mode
        log(`gateway: connected to Lattice (${this.transport.mode})`)
        lastFailure = ''
        backoff = 1_000
        await this.router.attach(this.transport.api)
        for await (const event of this.transport.events) this.hub.emit(event)
        if (!this.stopping) log('gateway: Lattice connection closed; reconnecting')
      } catch (error) {
        const message = (error as Error).message
        // A runtime that is down for an hour should not write an hour of identical lines.
        if (message !== lastFailure) log(`gateway: cannot reach Lattice: ${message}`)
        lastFailure = message
      }
      this.router.detach()
      this.runtimeMode = 'disconnected'
      await this.transport?.close().catch(() => undefined)
      this.transport = null
      if (this.stopping) break
      await this.sleep(backoff)
      backoff = Math.min(backoff * 2, 15_000)
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.wake = null
        resolve()
      }, ms)
      this.wake = () => {
        clearTimeout(timer)
        this.wake = null
        resolve()
      }
    })
  }

  private async listenControl(): Promise<void> {
    const path = this.paths.socket
    if (existsSync(path)) {
      const alive = await queryGateway(path, { op: 'ping' }, 1_000).then(() => true, () => false)
      if (alive) throw new Error(`another gateway is already running (${path})`)
      unlinkSync(path)
    }
    const server = createServer((socket) => {
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        const newline = buffer.indexOf('\n')
        if (newline < 0) return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        void this.handleControl(line).then((reply) => socket.end(`${JSON.stringify(reply)}\n`))
      })
      socket.on('error', () => undefined)
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => resolve())
    })
    chmodSync(path, 0o600)
    this.control = server
  }

  private async handleControl(line: string): Promise<Record<string, unknown>> {
    try {
      const request = JSON.parse(line) as { op?: string; text?: string; files?: unknown; model?: unknown }
      if (request.op === 'ping') return { ok: true }
      if (request.op === 'status') return { ok: true, status: this.status() }
      // State edits from one-shot CLI commands land here while the gateway runs, so this process
      // is the only writer and a CLI write can never interleave with (and undo) a router write.
      if (request.op === 'pair') return { ok: true, pairing: issuePairingCode(this.store) }
      if (request.op === 'owners-rm') {
        const { channel, senderId } = request as { channel?: string; senderId?: string }
        let removed = false
        this.store.update((state) => {
          const before = state.owners.length
          state.owners = state.owners.filter((owner) => !(owner.channel === channel && owner.senderId === senderId))
          removed = state.owners.length !== before
        })
        return { ok: true, removed }
      }
      if (request.op === 'notify') {
        const files = Array.isArray(request.files) ? request.files.filter((file): file is string => typeof file === 'string') : []
        if (!request.text?.trim() && files.length === 0) return { ok: false, error: 'text or a file is required' }
        await this.router.notify(request.text ?? '', files)
        return { ok: true }
      }
      if (request.op === 'roll') {
        const keepTokens = typeof (request as { keepTokens?: unknown }).keepTokens === 'number' ? (request as { keepTokens: number }).keepTokens : undefined
        return { ok: true, result: await this.router.rollNow(keepTokens) }
      }
      if (request.op === 'assistant-model') {
        const model = typeof request.model === 'string' && request.model.trim() ? request.model.trim() : undefined
        return { ok: true, ...(await this.router.setAssistantModel(model)) }
      }
      return { ok: false, error: `unknown op ${request.op}` }
    } catch (error) {
      return { ok: false, error: (error as Error).message }
    }
  }

  status(): Record<string, unknown> {
    return {
      pid: process.pid,
      supervised: this.options.supervised === true,
      ...this.router.statusSnapshot(),
      runtime: this.runtimeMode,
      voice: this.voice ? { port: this.voice.listeningPort, publicUrl: this.tunnel?.url } : undefined
    }
  }

  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    this.wake?.()
    unwatchFile(this.paths.config)
    if (this.mediaTimer) clearInterval(this.mediaTimer)
    this.tunnel?.stop()
    await Promise.all([...this.adapters.values()].map((adapter) => adapter.stop().catch(() => undefined)))
    await this.voice?.stop()
    await this.transport?.close().catch(() => undefined)
    await this.loop?.catch(() => undefined)
    await this.router.idle()
    await new Promise<void>((resolve) => (this.control ? this.control.close(() => resolve()) : resolve()))
    try {
      unlinkSync(this.paths.socket)
    } catch {
      /* already gone */
    }
  }
}
