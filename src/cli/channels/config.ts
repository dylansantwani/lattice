/**
 * On-disk configuration and state for the text gateway.
 *
 * `config.json` is what the owner sets up (tokens, which channels are on); `state.json` is what the
 * gateway learns while running (paired owners, the assistant thread, delivery bookkeeping). Both
 * live under `<dataDir>/channels/` with 0600 permissions because they hold bot tokens and project
 * secrets.
 *
 * Every write is read-modify-write against the file (never a long-lived in-memory copy) and lands
 * atomically via rename, so a crash never leaves a torn file. While the gateway runs it is the only
 * state writer: one-shot commands (`channels pair`, `owners rm`) send their edits over its control
 * socket and only write the file themselves when no gateway is running.
 */
import { createHash, randomInt } from 'node:crypto'
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { dirname, join } from 'node:path'
import type { ChannelId } from './types'

export interface AssistantConfig {
  /** Working directory (and Lattice workspace root) for the assistant thread. */
  workspaceRoot: string
  /** Model for the assistant thread; empty means the runtime's default model. */
  model?: string
  effort?: string
  /** Permission preset for the thread. `workspace` asks (over text) before risky actions. */
  preset: 'manual' | 'workspace' | 'full'
  /**
   * Tool specs (`lattice --allow-tool` syntax) pre-approved on the assistant thread, re-applied on
   * every connect. Defaults to read-only web access: an assistant you text should not need a "yes"
   * to look something up, while writes, shell and outward actions still ask.
   */
  allowTools: string[]
  /** Name used in the assistant's instructions. */
  ownerName: string
  /** Extra standing instructions appended to the built-in texting contract. */
  persona?: string
  /** What a text does while the assistant is mid-task: fold into the current turn, or wait its turn. */
  busyDisposition: 'steer' | 'queue'
  /** First "still on it" text after this long without anything sent during a task; 0 disables updates. */
  progressNoticeMs: number
  /** Later updates while the task keeps going, at most this often. */
  progressEveryMs: number
  /**
   * The assistant is one conversation forever: past `triggerTokens` of live history its oldest turns
   * are folded into a running summary and long-term memory, keeping about `keepTokens` verbatim.
   */
  rolling: { triggerTokens: number; keepTokens: number }
  /** IANA zone for the timestamp header on each message; defaults to the host zone. */
  timeZone?: string
}

export interface TelegramConfig {
  enabled: boolean
  botToken: string
  /** Override for tests or a self-hosted Bot API server. */
  apiBase?: string
}

export interface IMessageConfig {
  enabled: boolean
  provider: 'photon'
  projectId: string
  projectSecret: string
}

export interface VoiceConfig {
  enabled: boolean
  port: number
  bind: string
  /** Bearer secret the voice platform sends (Vapi: the Custom LLM provider key). */
  secret: string
  /** E.164 numbers allowed to talk to the assistant. Empty = any caller who has the secret. */
  allowedCallers: string[]
  /** How long a caller waits for an answer before the assistant promises to text it instead. */
  maxWaitMs: number
  /** Start a free Cloudflare quick tunnel for the endpoint and log its URL. */
  quickTunnel: boolean
  /** When set with `vapiAssistantId`, the gateway points the Vapi assistant at each new tunnel URL. */
  vapiApiKey?: string
  vapiAssistantId?: string
}

export interface TranscriptionConfig {
  /** `local`: faster-whisper on this machine. `openai` (default): an OpenAI-compatible endpoint. */
  provider?: 'openai' | 'local'
  /** OpenAI-compatible base URL exposing `/audio/transcriptions` (Groq, OpenAI, a local server). */
  baseUrl?: string
  apiKey?: string
  /** Endpoint model id, or the faster-whisper model name (`small`, `large-v3`, …) for `local`. */
  model: string
  /** `local` only: a Python interpreter that can import faster_whisper. */
  python?: string
  /** ISO language hint (`en`); empty lets the model detect it. */
  language?: string
}

export interface ChannelsConfig {
  version: 1
  assistant: AssistantConfig
  telegram?: TelegramConfig
  imessage?: IMessageConfig
  voice?: VoiceConfig
  transcription?: TranscriptionConfig
  /** How the gateway reaches Lattice. Default: attach to the live app/runtime in the data dir. */
  runtime?: { remote?: string; embedded?: boolean }
}

export interface OwnerHandle {
  channel: ChannelId
  senderId: string
  name?: string
  pairedAt: number
}

export interface Route {
  channel: ChannelId
  conversationId: string
  at: number
}

export interface PendingInbound {
  channel: ChannelId
  conversationId: string
  senderId: string
  messageId: string
  text: string
  receivedAt: number
}

export interface ChannelsState {
  version: 1
  owners: OwnerHandle[]
  pairing?: { code: string; expiresAt: number }
  workspaceId?: string
  threadId?: string
  /** Where the owner last texted from — replies and proactive notices go here. */
  lastRoute?: Route
  /** Assistant message ids already texted out (bounded). */
  delivered: string[]
  /** Assistant messages created before this instant are never auto-delivered (no history dumps). */
  deliveryCursor: number
  /** `${channel}:${messageId}` of inbound messages already handled (bounded). */
  seenInbound: string[]
  /** Texts that arrived while Lattice was unreachable, replayed on reconnect (bounded). */
  pendingInbound: PendingInbound[]
  telegramOffset?: number
}

export const DELIVERED_LIMIT = 500
export const SEEN_LIMIT = 500
export const PENDING_LIMIT = 50
export const PAIRING_TTL_MS = 15 * 60_000

export function channelsDir(dataDir: string): string {
  return join(dataDir, 'channels')
}

/** Unix socket paths are capped at 104 bytes on macOS (108 on Linux), terminator included. */
const MAX_SOCKET_PATH_BYTES = 100

/**
 * `<dir>/gateway.sock`, or — when a long data directory would push that past the unix socket limit
 * (listen() then binds a truncated path and chmod fails) — a short stand-in named by a hash of the
 * directory inside the per-user runtime/temp folder, so every command still finds the same socket.
 */
export function gatewaySocketPath(dir: string, env: NodeJS.ProcessEnv = process.env): string {
  const preferred = join(dir, 'gateway.sock')
  if (Buffer.byteLength(preferred) <= MAX_SOCKET_PATH_BYTES) return preferred
  const digest = createHash('sha256').update(dir).digest('hex').slice(0, 16)
  // XDG_RUNTIME_DIR (Linux) and macOS's tmpdir (/var/folders/…/T) are private to the user.
  return join(env.XDG_RUNTIME_DIR || tmpdir(), `lattice-channels-${digest}.sock`)
}

export function channelsPaths(dataDir: string): {
  dir: string
  config: string
  state: string
  log: string
  media: string
  photonSdk: string
  socket: string
} {
  const dir = channelsDir(dataDir)
  return {
    dir,
    config: join(dir, 'config.json'),
    state: join(dir, 'state.json'),
    log: join(dir, 'gateway.log'),
    media: join(dir, 'media'),
    photonSdk: join(dir, 'photon-sdk'),
    socket: gatewaySocketPath(dir)
  }
}

/** The login name, capitalized ("dylan" → "Dylan"); `setup assistant --name` overrides it. */
function defaultOwnerName(): string {
  try {
    const name = userInfo().username.split(/[._-]/)[0] ?? ''
    return name ? name[0]!.toUpperCase() + name.slice(1) : 'the owner'
  } catch {
    return 'the owner'
  }
}

export function defaultConfig(): ChannelsConfig {
  return {
    version: 1,
    assistant: {
      workspaceRoot: join(homedir(), 'LatticeAssistant'),
      preset: 'workspace',
      allowTools: ['web_search', 'web_fetch', 'fetch_image'],
      ownerName: defaultOwnerName(),
      busyDisposition: 'steer',
      progressNoticeMs: 30_000,
      progressEveryMs: 90_000,
      rolling: { triggerTokens: 64_000, keepTokens: 24_000 }
    }
  }
}

export function defaultState(now = Date.now()): ChannelsState {
  return { version: 1, owners: [], delivered: [], deliveryCursor: now, seenInbound: [], pendingInbound: [] }
}

function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw new Error(`${path} is not valid JSON: ${(error as Error).message}`)
  }
}

/** Atomic 0600 write: a crash mid-write leaves the previous file intact, never a torn one. */
export function writePrivateJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 })
  renameSync(tmp, path)
  try {
    chmodSync(path, 0o600)
  } catch {
    /* best effort on filesystems without modes */
  }
}

export function loadConfig(dataDir: string): ChannelsConfig {
  const stored = readJson<Partial<ChannelsConfig>>(channelsPaths(dataDir).config)
  const base = defaultConfig()
  if (!stored) return base
  const assistant = { ...base.assistant, ...(stored.assistant ?? {}) }
  // A partial or hand-edited rolling block keeps the defaults for what it leaves out.
  assistant.rolling = { ...base.assistant.rolling, ...(stored.assistant?.rolling ?? {}) }
  return { ...base, ...stored, version: 1, assistant }
}

export function saveConfig(dataDir: string, config: ChannelsConfig): void {
  writePrivateJson(channelsPaths(dataDir).config, config)
}

export function updateConfig(dataDir: string, fn: (config: ChannelsConfig) => ChannelsConfig | void): ChannelsConfig {
  const current = loadConfig(dataDir)
  const next = fn(current) ?? current
  saveConfig(dataDir, next)
  return next
}

export function configExists(dataDir: string): boolean {
  return existsSync(channelsPaths(dataDir).config)
}

/**
 * State store bound to one data directory. `read()` always goes to disk; `update()` applies a
 * mutation to a fresh read and writes it back, so concurrent processes interleave safely at the
 * granularity of one update.
 */
export class StateStore {
  constructor(private readonly path: string, private readonly now: () => number = Date.now) {}

  static forDataDir(dataDir: string): StateStore {
    return new StateStore(channelsPaths(dataDir).state)
  }

  read(): ChannelsState {
    const stored = readJson<Partial<ChannelsState>>(this.path)
    const base = defaultState(this.now())
    if (!stored) return base
    return {
      ...base,
      ...stored,
      version: 1,
      owners: stored.owners ?? [],
      delivered: stored.delivered ?? [],
      seenInbound: stored.seenInbound ?? [],
      pendingInbound: stored.pendingInbound ?? [],
      deliveryCursor: stored.deliveryCursor ?? base.deliveryCursor
    }
  }

  update(fn: (state: ChannelsState) => void): ChannelsState {
    const state = this.read()
    fn(state)
    if (state.delivered.length > DELIVERED_LIMIT) state.delivered = state.delivered.slice(-DELIVERED_LIMIT)
    if (state.seenInbound.length > SEEN_LIMIT) state.seenInbound = state.seenInbound.slice(-SEEN_LIMIT)
    if (state.pendingInbound.length > PENDING_LIMIT) state.pendingInbound = state.pendingInbound.slice(-PENDING_LIMIT)
    writePrivateJson(this.path, state)
    return state
  }
}

export function isOwner(state: ChannelsState, channel: ChannelId, senderId: string): boolean {
  return state.owners.some((owner) => owner.channel === channel && owner.senderId === senderId)
}

/** A fresh six-digit pairing code, valid for {@link PAIRING_TTL_MS}. */
export function issuePairingCode(store: StateStore, now = Date.now()): { code: string; expiresAt: number } {
  const pairing = { code: String(randomInt(0, 1_000_000)).padStart(6, '0'), expiresAt: now + PAIRING_TTL_MS }
  store.update((state) => {
    state.pairing = pairing
  })
  return pairing
}
