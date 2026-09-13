/**
 * Telegram adapter over the Bot API with long polling — outbound HTTPS only, so it works behind NAT
 * with no public URL, tunnel or webhook. Free, and a bot is created in a minute with @BotFather.
 *
 * Only private chats are accepted; the router decides whether the sender is the paired owner.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { readVettedFile } from '../files'
import { GATEWAY_COMMANDS } from '../format'
import type { ChannelAdapter, ChannelStatus, InboundAttachment, InboundMessage, Logger, OutboundFile, SendOptions } from '../types'

interface TelegramUser {
  id: number
  is_bot?: boolean
  first_name?: string
  last_name?: string
  username?: string
}

interface TelegramChat {
  id: number
  type: 'private' | 'group' | 'supergroup' | 'channel'
}

interface TelegramFileRef {
  file_id: string
  file_unique_id?: string
  file_size?: number
  mime_type?: string
  file_name?: string
}

interface TelegramMessage {
  message_id: number
  from?: TelegramUser
  chat: TelegramChat
  date: number
  text?: string
  caption?: string
  photo?: Array<TelegramFileRef & { width: number; height: number }>
  document?: TelegramFileRef
  voice?: TelegramFileRef & { duration?: number }
  audio?: TelegramFileRef
  video_note?: TelegramFileRef
}

interface TelegramUpdate {
  update_id: number
  message?: TelegramMessage
  callback_query?: { id: string; from: TelegramUser; data?: string; message?: TelegramMessage }
}

interface BotApiResponse<T> {
  ok: boolean
  result?: T
  description?: string
  error_code?: number
  parameters?: { retry_after?: number }
}

export class TelegramApiError extends Error {
  constructor(message: string, readonly code?: number, readonly retryAfter?: number) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

export interface TelegramAdapterOptions {
  botToken: string
  apiBase?: string
  mediaDir: string
  log: Logger
  /** Persisted update offset so a restart neither replays nor skips messages. */
  loadOffset: () => number | undefined
  saveOffset: (offset: number) => void
  pollTimeoutSec?: number
  fetchImpl?: typeof fetch
  /**
   * Whether files from this sender may be downloaded. Checked before any bytes are fetched, so a
   * stranger messaging the (public) bot cannot fill the disk; their text still reaches the router
   * for pairing.
   */
  mayDownload?: (senderId: string) => boolean
}

const MAX_DOWNLOAD_BYTES = 20 * 1024 * 1024 // Bot API getFile ceiling
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024 // Bot API multipart upload ceiling
const MAX_PHOTO_BYTES = 10 * 1024 * 1024 // larger images must go up as documents
const PHOTO_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp'])
const MAX_CAPTION_CHARS = 1024

/**
 * What a stranger who finds the bot sees before pressing Start, and the "/" command menu. The bot
 * username is public, so the profile says plainly that the bot answers only its owner.
 */
export const BOT_SHORT_DESCRIPTION = 'A private Lattice assistant. It only answers the person who paired it.'
export const BOT_DESCRIPTION = [
  'This is a private Lattice assistant running on its owner\'s computer.',
  '',
  'It only answers the account that paired it. If that is you, run `lattice channels pair` on your Mac and open the link it prints, or send /pair followed by the code.'
].join('\n')

export function botCommands(): Array<{ command: string; description: string }> {
  return GATEWAY_COMMANDS.map((command) => ({ command: command.name, description: command.description.slice(0, 256) }))
}

function displayName(user: TelegramUser | undefined): string | undefined {
  if (!user) return undefined
  const name = [user.first_name, user.last_name].filter(Boolean).join(' ')
  return name || user.username
}

function stripTags(html: string): string {
  return html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&')
}

export class TelegramAdapter implements ChannelAdapter {
  readonly id = 'telegram' as const
  readonly maxMessageChars = 3800 // Bot API limit is 4096 after entity parsing; leave room for tags
  readonly format = 'telegram-html' as const
  readonly typingTtlMs = 5_000
  readonly maxUploadBytes = MAX_UPLOAD_BYTES

  private readonly apiBase: string
  private readonly fetchImpl: typeof fetch
  private running = false
  private abort: AbortController | null = null
  private loop: Promise<void> | null = null
  private connected = false
  private username?: string
  private lastError?: string

  constructor(private readonly options: TelegramAdapterOptions) {
    this.apiBase = (options.apiBase ?? 'https://api.telegram.org').replace(/\/$/, '')
    this.fetchImpl = options.fetchImpl ?? fetch
  }

  private async call<T>(method: string, body: Record<string, unknown> | FormData = {}, signal?: AbortSignal): Promise<T> {
    const multipart = body instanceof FormData
    const response = await this.fetchImpl(`${this.apiBase}/bot${this.options.botToken}/${method}`, {
      method: 'POST',
      // fetch sets the multipart boundary itself; naming a content-type here would break it.
      ...(multipart ? {} : { headers: { 'content-type': 'application/json' } }),
      body: multipart ? body : JSON.stringify(body),
      signal
    })
    let payload: BotApiResponse<T>
    try {
      payload = (await response.json()) as BotApiResponse<T>
    } catch {
      throw new TelegramApiError(`${method}: HTTP ${response.status}`, response.status)
    }
    if (!payload.ok) {
      throw new TelegramApiError(`${method}: ${payload.description ?? `HTTP ${response.status}`}`, payload.error_code ?? response.status, payload.parameters?.retry_after)
    }
    return payload.result as T
  }

  /** Validate the token; returns the bot's @username. */
  async getMe(): Promise<TelegramUser> {
    return this.call<TelegramUser>('getMe')
  }

  /**
   * Keep the bot's "/" menu and its profile text in step with the gateway. Reads first and writes
   * only what differs, so a restart loop never spends Telegram's rate limit on no-op writes.
   * Returns the fields it changed.
   */
  async configureProfile(): Promise<string[]> {
    const changed: string[] = []
    const commands = botCommands()
    const current = await this.call<Array<{ command: string; description: string }>>('getMyCommands')
    if (JSON.stringify(current) !== JSON.stringify(commands)) {
      await this.call('setMyCommands', { commands })
      changed.push('commands')
    }
    const short = await this.call<{ short_description?: string }>('getMyShortDescription')
    if ((short.short_description ?? '') !== BOT_SHORT_DESCRIPTION) {
      await this.call('setMyShortDescription', { short_description: BOT_SHORT_DESCRIPTION })
      changed.push('short description')
    }
    const long = await this.call<{ description?: string }>('getMyDescription')
    if ((long.description ?? '') !== BOT_DESCRIPTION) {
      await this.call('setMyDescription', { description: BOT_DESCRIPTION })
      changed.push('description')
    }
    return changed
  }

  async start(sink: (message: InboundMessage) => void): Promise<void> {
    const me = await this.getMe()
    this.username = me.username
    // A webhook left over from another tool makes getUpdates fail with 409; polling needs it gone.
    await this.call('deleteWebhook', { drop_pending_updates: false })
    // Cosmetic: a failure here must never keep the owner from texting.
    void this.configureProfile()
      .then((changed) => {
        if (changed.length) this.options.log(`telegram: updated the bot's ${changed.join(', ')}`)
      })
      .catch((error: Error) => this.options.log(`telegram: could not update the bot profile (${error.message})`))
    this.running = true
    this.connected = true
    this.options.log(`telegram: polling as @${me.username}`)
    this.loop = this.poll(sink)
  }

  private async poll(sink: (message: InboundMessage) => void): Promise<void> {
    let backoff = 1_000
    while (this.running) {
      this.abort = new AbortController()
      try {
        const offset = this.options.loadOffset()
        const updates = await this.call<TelegramUpdate[]>(
          'getUpdates',
          {
            timeout: this.options.pollTimeoutSec ?? 25,
            allowed_updates: ['message', 'callback_query'],
            ...(offset !== undefined ? { offset } : {})
          },
          this.abort.signal
        )
        this.connected = true
        this.lastError = undefined
        backoff = 1_000
        for (const update of updates) {
          // Advance past the update before handling it: a message that crashes the handler must not
          // be redelivered forever. The router dedupes, so an early save costs nothing.
          this.options.saveOffset(update.update_id + 1)
          try {
            const inbound = await this.normalize(update)
            if (inbound) sink(inbound)
          } catch (error) {
            this.options.log(`telegram: could not handle update ${update.update_id}: ${(error as Error).message}`)
          }
        }
      } catch (error) {
        if (!this.running) break
        const err = error as TelegramApiError
        this.connected = false
        this.lastError = err.message
        const wait = err.retryAfter ? err.retryAfter * 1_000 : err.code === 409 ? 30_000 : backoff
        if (err.code === 401 || err.code === 404) {
          this.options.log('telegram: the bot token was rejected; fix it with `lattice channels setup telegram`')
        } else {
          this.options.log(`telegram: poll failed (${err.message}); retrying in ${Math.round(wait / 1000)}s`)
        }
        await this.sleep(wait)
        backoff = Math.min(backoff * 2, 30_000)
      }
    }
  }

  /** A backoff wait that `stop()` cuts short. */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(done, ms)
      const signal = this.abort?.signal
      function done(): void {
        clearTimeout(timer)
        signal?.removeEventListener('abort', done)
        resolve()
      }
      signal?.addEventListener('abort', done, { once: true })
    })
  }

  private async normalize(update: TelegramUpdate): Promise<InboundMessage | undefined> {
    if (update.callback_query) {
      const query = update.callback_query
      await this.call('answerCallbackQuery', { callback_query_id: query.id }).catch(() => undefined)
      if (!query.message || query.message.chat.type !== 'private' || !query.data) return undefined
      return {
        channel: 'telegram',
        conversationId: String(query.message.chat.id),
        senderId: String(query.from.id),
        senderName: displayName(query.from),
        messageId: `cb:${query.id}`,
        text: '',
        attachments: [],
        receivedAt: Date.now(),
        callback: { data: query.data }
      }
    }
    const message = update.message
    if (!message || message.chat.type !== 'private' || !message.from || message.from.is_bot) return undefined
    const attachments: InboundAttachment[] = []
    const notes: string[] = []
    const allowed = this.options.mayDownload?.(String(message.from.id)) ?? true
    const fetchFile = async (ref: TelegramFileRef, kind: InboundAttachment['kind'], name: string): Promise<void> => {
      if (!allowed) return
      try {
        attachments.push(await this.download(ref, kind, name))
      } catch (error) {
        // Keep the words even when the file can't come along.
        notes.push(`(could not download ${name}: ${(error as Error).message})`)
      }
    }
    const photo = message.photo?.length ? message.photo[message.photo.length - 1] : undefined
    if (photo) await fetchFile(photo, 'image', `photo-${message.message_id}.jpg`)
    if (message.document) await fetchFile(message.document, message.document.mime_type?.startsWith('image/') ? 'image' : 'file', message.document.file_name ?? `file-${message.message_id}`)
    if (message.voice) await fetchFile(message.voice, 'audio', `voice-${message.message_id}.ogg`)
    if (message.audio) await fetchFile(message.audio, 'audio', message.audio.file_name ?? `audio-${message.message_id}.mp3`)
    const text = [message.text ?? message.caption ?? '', ...notes].filter(Boolean).join('\n')
    return {
      channel: 'telegram',
      conversationId: String(message.chat.id),
      senderId: String(message.from.id),
      senderName: displayName(message.from),
      messageId: String(message.message_id),
      text,
      attachments,
      receivedAt: message.date * 1_000
    }
  }

  private async download(ref: TelegramFileRef, kind: InboundAttachment['kind'], fallbackName: string): Promise<InboundAttachment> {
    if (ref.file_size && ref.file_size > MAX_DOWNLOAD_BYTES) throw new Error(`${fallbackName} is larger than Telegram lets bots download (20 MB)`)
    const file = await this.call<{ file_path?: string }>('getFile', { file_id: ref.file_id })
    if (!file.file_path) throw new Error('Telegram returned no file path')
    const response = await this.fetchImpl(`${this.apiBase}/file/bot${this.options.botToken}/${file.file_path}`)
    if (!response.ok) throw new Error(`file download failed: HTTP ${response.status}`)
    const bytes = Buffer.from(await response.arrayBuffer())
    mkdirSync(this.options.mediaDir, { recursive: true, mode: 0o700 })
    const name = fallbackName.replace(/[^\w.\- ]+/g, '_').slice(-120)
    const ext = extname(name) ? '' : extname(file.file_path)
    // Readable in Finder, unique per upload, and never a path the sender controls.
    const path = join(this.options.mediaDir, `telegram-${Date.now()}-${ref.file_unique_id ?? 'file'}-${name}${ext}`)
    writeFileSync(path, bytes, { mode: 0o600 })
    return { path, name, mime: ref.mime_type ?? (kind === 'image' ? 'image/jpeg' : kind === 'audio' ? 'audio/ogg' : 'application/octet-stream'), kind }
  }

  async stop(): Promise<void> {
    this.running = false
    this.connected = false
    this.abort?.abort()
    await this.loop?.catch(() => undefined)
  }

  async send(conversationId: string, text: string, options?: SendOptions): Promise<void> {
    const markup = options?.buttons?.length
      ? { reply_markup: { inline_keyboard: options.buttons.map((row) => row.map((button) => ({ text: button.label, callback_data: button.data.slice(0, 64) }))) } }
      : {}
    const base = { chat_id: conversationId, link_preview_options: { is_disabled: true }, ...markup }
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.call('sendMessage', { ...base, text, parse_mode: 'HTML' })
        return
      } catch (error) {
        const err = error as TelegramApiError
        if (err.retryAfter) {
          await new Promise((resolve) => setTimeout(resolve, err.retryAfter! * 1_000))
          continue
        }
        // Rendering can still produce HTML Telegram refuses; the words matter more than the styling.
        if (err.code === 400 && /parse|entit|tag/i.test(err.message)) {
          await this.call('sendMessage', { ...base, text: stripTags(text) })
          return
        }
        throw error
      }
    }
    throw new TelegramApiError('sendMessage: rate limited repeatedly')
  }

  /**
   * Upload a file: an ordinary photo shows inline, anything else (or a photo Telegram refuses, like
   * an extreme panorama) goes up as a document so it still arrives.
   */
  async sendFile(conversationId: string, file: OutboundFile): Promise<void> {
    if (file.bytes > MAX_UPLOAD_BYTES) throw new TelegramApiError(`${file.name} is larger than Telegram lets bots upload (50 MB)`)
    const bytes = readVettedFile(file)
    const caption = file.caption ? file.caption.slice(0, MAX_CAPTION_CHARS) : undefined
    const form = (field: 'photo' | 'document'): FormData => {
      const data = new FormData()
      data.append('chat_id', conversationId)
      if (caption) data.append('caption', caption)
      data.append(field, new Blob([bytes], { type: file.mime }), file.name)
      return data
    }
    let asPhoto = file.kind === 'image' && PHOTO_MIMES.has(file.mime) && file.bytes <= MAX_PHOTO_BYTES
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        if (asPhoto) await this.call('sendPhoto', form('photo'))
        else await this.call('sendDocument', form('document'))
        return
      } catch (error) {
        const err = error as TelegramApiError
        if (err.retryAfter) {
          await new Promise((resolve) => setTimeout(resolve, err.retryAfter! * 1_000))
          continue
        }
        // PHOTO_INVALID_DIMENSIONS and friends: the same bytes are fine as a document.
        if (asPhoto && err.code === 400) {
          asPhoto = false
          continue
        }
        throw error
      }
    }
    throw new TelegramApiError(`${asPhoto ? 'sendPhoto' : 'sendDocument'}: rate limited repeatedly`)
  }

  async typing(conversationId: string, on: boolean): Promise<void> {
    if (!on) return // Telegram's indicator lapses on its own
    await this.call('sendChatAction', { chat_id: conversationId, action: 'typing' })
  }

  async react(conversationId: string, messageId: string, emoji: string): Promise<void> {
    if (!/^\d+$/.test(messageId)) return
    await this.call('setMessageReaction', { chat_id: conversationId, message_id: Number(messageId), reaction: [{ type: 'emoji', emoji }] })
  }

  status(): ChannelStatus {
    return {
      connected: this.connected,
      identity: this.username ? `@${this.username}` : undefined,
      detail: this.username ? `https://t.me/${this.username}` : undefined,
      lastError: this.lastError
    }
  }
}
