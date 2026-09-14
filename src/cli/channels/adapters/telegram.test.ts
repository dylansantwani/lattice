import { createServer, type IncomingMessage, type Server } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { InboundMessage } from '../types'
import { BOT_DESCRIPTION, BOT_SHORT_DESCRIPTION, botCommands, TelegramAdapter } from './telegram'

interface Call {
  method: string
  body: Record<string, unknown>
  /** Uploaded files by form field, for multipart calls. */
  files?: Record<string, { name: string; type: string; text: string }>
}

/** A local stand-in for api.telegram.org that scripts updates and records every call. */
class FakeBotApi {
  server!: Server
  base = ''
  calls: Call[] = []
  updates: unknown[][] = []
  failSendOnce: { code: number; description: string; retry_after?: number } | null = null
  failPhotoOnce: { code: number; description: string } | null = null
  profile: { commands: unknown[]; short_description: string; description: string } = { commands: [], short_description: '', description: '' }

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res))
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()))
    const address = this.server.address()
    this.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async body(req: IncomingMessage): Promise<Pick<Call, 'body' | 'files'>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const type = req.headers['content-type'] ?? ''
    if (type.startsWith('multipart/form-data')) {
      const form = await new Response(raw, { headers: { 'content-type': type } }).formData()
      const body: Record<string, unknown> = {}
      const files: NonNullable<Call['files']> = {}
      for (const [key, value] of form.entries()) {
        if (typeof value === 'string') body[key] = value
        else files[key] = { name: value.name, type: value.type, text: await value.text() }
      }
      return { body, files }
    }
    return { body: raw.length ? (JSON.parse(raw.toString('utf8')) as Record<string, unknown>) : {} }
  }

  private async handle(req: IncomingMessage, res: import('node:http').ServerResponse): Promise<void> {
    const url = req.url ?? ''
    if (url.startsWith('/file/botTOKEN/')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' })
      res.end(Buffer.from('fake-bytes'))
      return
    }
    const method = url.replace('/botTOKEN/', '')
    const { body, files } = await this.body(req)
    this.calls.push({ method, body, ...(files ? { files } : {}) })
    const reply = (result: unknown): void => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, result }))
    }
    if (method === 'getMe') return reply({ id: 99, is_bot: true, first_name: 'Lattice', username: 'LatticeTestBot' })
    if (method === 'getUpdates') {
      const next = this.updates.shift()
      if (next) return reply(next)
      // Hold the long poll briefly like the real API, then return nothing.
      setTimeout(() => reply([]), 50)
      return
    }
    if (method === 'getFile') return reply({ file_path: `photos/${String(body.file_id)}.jpg` })
    if (method === 'getMyCommands') return reply(this.profile.commands)
    if (method === 'setMyCommands') {
      this.profile.commands = body.commands as unknown[]
      return reply(true)
    }
    if (method === 'getMyShortDescription') return reply({ short_description: this.profile.short_description })
    if (method === 'setMyShortDescription') {
      this.profile.short_description = String(body.short_description)
      return reply(true)
    }
    if (method === 'getMyDescription') return reply({ description: this.profile.description })
    if (method === 'setMyDescription') {
      this.profile.description = String(body.description)
      return reply(true)
    }
    if (method === 'sendPhoto' && this.failPhotoOnce) {
      const failure = this.failPhotoOnce
      this.failPhotoOnce = null
      res.writeHead(failure.code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: failure.code, description: failure.description }))
      return
    }
    if (method === 'sendMessage' && this.failSendOnce) {
      const failure = this.failSendOnce
      this.failSendOnce = null
      res.writeHead(failure.code, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error_code: failure.code, description: failure.description, ...(failure.retry_after ? { parameters: { retry_after: failure.retry_after } } : {}) }))
      return
    }
    reply(true)
  }
}

let api: FakeBotApi
let dir: string
let offset: number | undefined
let adapter: TelegramAdapter
let received: InboundMessage[]

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

beforeEach(async () => {
  api = new FakeBotApi()
  await api.start()
  dir = mkdtempSync(join(tmpdir(), 'lattice-telegram-'))
  offset = undefined
  received = []
  adapter = new TelegramAdapter({
    botToken: 'TOKEN',
    apiBase: api.base,
    mediaDir: join(dir, 'media'),
    log: () => undefined,
    loadOffset: () => offset,
    saveOffset: (value) => {
      offset = value
    },
    pollTimeoutSec: 1
  })
})

afterEach(async () => {
  await adapter.stop()
  await api.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('TelegramAdapter', () => {
  it('validates the token, clears webhooks, and long-polls private messages', async () => {
    api.updates.push([
      { update_id: 10, message: { message_id: 5, from: { id: 42, first_name: 'Dylan', last_name: 'S' }, chat: { id: 42, type: 'private' }, date: 1_700_000_000, text: 'hello' } },
      { update_id: 11, message: { message_id: 6, from: { id: 7 }, chat: { id: -100, type: 'group' }, date: 1_700_000_001, text: 'group noise' } }
    ])
    await adapter.start((message) => received.push(message))
    await waitFor(() => received.length === 1 && offset === 12)
    expect(api.calls.slice(0, 2).map((call) => call.method)).toEqual(['getMe', 'deleteWebhook'])
    expect(received[0]).toMatchObject({ channel: 'telegram', conversationId: '42', senderId: '42', senderName: 'Dylan S', messageId: '5', text: 'hello', receivedAt: 1_700_000_000_000 })
    expect(adapter.status()).toMatchObject({ connected: true, identity: '@LatticeTestBot', detail: 'https://t.me/LatticeTestBot' })
    await waitFor(() => api.calls.some((call) => call.method === 'getUpdates' && call.body.offset === 12))
  })

  it('downloads the largest photo size into the media directory', async () => {
    api.updates.push([
      { update_id: 1, message: { message_id: 9, from: { id: 42 }, chat: { id: 42, type: 'private' }, date: 1, caption: 'what is this', photo: [{ file_id: 'small', width: 90, height: 90 }, { file_id: 'large', file_unique_id: 'u1', width: 900, height: 900 }] } }
    ])
    await adapter.start((message) => received.push(message))
    await waitFor(() => received.length === 1)
    const [attachment] = received[0]!.attachments
    expect(received[0]!.text).toBe('what is this')
    expect(api.calls.find((call) => call.method === 'getFile')?.body.file_id).toBe('large')
    expect(attachment).toMatchObject({ kind: 'image', mime: 'image/jpeg' })
    expect(existsSync(attachment!.path)).toBe(true)
    expect(readFileSync(attachment!.path, 'utf8')).toBe('fake-bytes')
  })

  it('does not download files from senders the gateway has not paired', async () => {
    await adapter.stop()
    adapter = new TelegramAdapter({ botToken: 'TOKEN', apiBase: api.base, mediaDir: join(dir, 'media'), log: () => undefined, loadOffset: () => offset, saveOffset: (value) => { offset = value }, pollTimeoutSec: 1, mayDownload: (senderId) => senderId === '42' })
    api.updates.push([
      { update_id: 1, message: { message_id: 9, from: { id: 666 }, chat: { id: 666, type: 'private' }, date: 1, caption: '/pair 123456', document: { file_id: 'huge', file_size: 19_000_000, file_name: 'junk.bin' } } }
    ])
    await adapter.start((message) => received.push(message))
    await waitFor(() => received.length === 1)
    expect(received[0]).toMatchObject({ senderId: '666', text: '/pair 123456', attachments: [] })
    expect(api.calls.some((call) => call.method === 'getFile')).toBe(false)
  })

  it('turns an inline button tap into a callback and acknowledges it', async () => {
    api.updates.push([
      { update_id: 3, callback_query: { id: 'cbq', from: { id: 42 }, data: 'lat:ap:allow:ap1', message: { message_id: 1, chat: { id: 42, type: 'private' }, date: 1 } } }
    ])
    await adapter.start((message) => received.push(message))
    await waitFor(() => received.length === 1)
    expect(received[0]).toMatchObject({ senderId: '42', conversationId: '42', callback: { data: 'lat:ap:allow:ap1' } })
    expect(api.calls.some((call) => call.method === 'answerCallbackQuery' && call.body.callback_query_id === 'cbq')).toBe(true)
  })

  it('sends plain text with entities and inline buttons, never parse_mode', async () => {
    const entities = [{ type: 'code' as const, offset: 4, length: 4 }]
    await adapter.send('42', 'run pair now', { buttons: [[{ label: 'Yes', data: 'lat:ap:allow:1' }]], entities })
    const call = api.calls.find((item) => item.method === 'sendMessage')!
    expect(call.body).toMatchObject({ chat_id: '42', text: 'run pair now', entities, reply_markup: { inline_keyboard: [[{ text: 'Yes', callback_data: 'lat:ap:allow:1' }]] } })
    expect(call.body.parse_mode).toBeUndefined()
  })

  it('drops the entities and keeps the words when Telegram rejects one', async () => {
    api.failSendOnce = { code: 400, description: 'Bad Request: wrong HTTP URL specified' }
    await adapter.send('42', 'see the docs', { entities: [{ type: 'text_link', offset: 4, length: 8, url: 'https://bad' }] })
    const sends = api.calls.filter((call) => call.method === 'sendMessage')
    expect(sends).toHaveLength(2)
    expect(sends[1]!.body).toMatchObject({ text: 'see the docs' })
    expect(sends[1]!.body.entities).toBeUndefined()
  })

  it('waits out a 429 and retries', async () => {
    api.failSendOnce = { code: 429, description: 'Too Many Requests', retry_after: 0.05 }
    await adapter.send('42', 'hi')
    expect(api.calls.filter((call) => call.method === 'sendMessage')).toHaveLength(2)
  })

  it('sends typing and 👀 reactions', async () => {
    await adapter.typing('42', true)
    await adapter.typing('42', false)
    await adapter.react('42', '5', '👀')
    await adapter.react('42', 'cb:x', '👀')
    expect(api.calls.map((call) => call.method)).toEqual(['sendChatAction', 'setMessageReaction'])
    expect(api.calls[1]!.body).toEqual({ chat_id: '42', message_id: 5, reaction: [{ type: 'emoji', emoji: '👀' }] })
  })

  it('sets the command menu and profile once, and leaves them alone when they already match', async () => {
    expect(await adapter.configureProfile()).toEqual(['commands', 'short description', 'description'])
    expect(api.profile).toEqual({ commands: botCommands(), short_description: BOT_SHORT_DESCRIPTION, description: BOT_DESCRIPTION })
    expect(botCommands().map((command) => command.command)).toEqual(['new', 'stop', 'status', 'model', 'remember', 'pair', 'help'])
    api.calls = []
    expect(await adapter.configureProfile()).toEqual([])
    expect(api.calls.map((call) => call.method)).toEqual(['getMyCommands', 'getMyShortDescription', 'getMyDescription'])
    expect(BOT_SHORT_DESCRIPTION.length).toBeLessThanOrEqual(120)
    expect(BOT_DESCRIPTION.length).toBeLessThanOrEqual(512)
  })

  it('configures the profile on start without holding up polling', async () => {
    await adapter.start((message) => received.push(message))
    await waitFor(() => api.calls.some((call) => call.method === 'setMyDescription'))
    expect(api.calls.slice(0, 2).map((call) => call.method)).toEqual(['getMe', 'deleteWebhook'])
  })

  it('uploads an image as a photo with its caption', async () => {
    const path = join(dir, 'chart.png')
    writeFileSync(path, 'PNGDATA')
    await adapter.sendFile('42', { path, name: 'chart.png', mime: 'image/png', kind: 'image', bytes: 7, caption: 'Weekly sales' })
    const call = api.calls.find((item) => item.method === 'sendPhoto')!
    expect(call.body).toEqual({ chat_id: '42', caption: 'Weekly sales' })
    expect(call.files).toEqual({ photo: { name: 'chart.png', type: 'image/png', text: 'PNGDATA' } })
  })

  it('sends other files, and photos Telegram refuses, as documents', async () => {
    const pdf = join(dir, 'report.pdf')
    writeFileSync(pdf, '%PDF')
    await adapter.sendFile('42', { path: pdf, name: 'report.pdf', mime: 'application/pdf', kind: 'file', bytes: 4 })
    expect(api.calls.at(-1)).toMatchObject({ method: 'sendDocument', files: { document: { name: 'report.pdf', text: '%PDF' } } })

    const panorama = join(dir, 'pano.jpg')
    writeFileSync(panorama, 'JPEG')
    api.failPhotoOnce = { code: 400, description: 'Bad Request: PHOTO_INVALID_DIMENSIONS' }
    await adapter.sendFile('42', { path: panorama, name: 'pano.jpg', mime: 'image/jpeg', kind: 'image', bytes: 4 })
    expect(api.calls.slice(-2).map((call) => call.method)).toEqual(['sendPhoto', 'sendDocument'])
  })

  it('refuses uploads over the Bot API limit before reading them', async () => {
    await expect(adapter.sendFile('42', { path: '/nonexistent', name: 'huge.mov', mime: 'video/quicktime', kind: 'file', bytes: 60 * 1024 * 1024 })).rejects.toThrow(/50 MB/)
    expect(api.calls).toHaveLength(0)
  })

  it('names downloads readably and keeps them inside the media folder', async () => {
    api.updates.push([
      { update_id: 1, message: { message_id: 9, from: { id: 42 }, chat: { id: 42, type: 'private' }, date: 1, document: { file_id: 'doc', file_unique_id: 'u9', file_name: '../../etc/Resume 2026.pdf', mime_type: 'application/pdf' } } }
    ])
    await adapter.start((message) => received.push(message))
    await waitFor(() => received.length === 1)
    const [attachment] = received[0]!.attachments
    expect(attachment!.path.startsWith(join(dir, 'media', 'telegram-'))).toBe(true)
    expect(attachment!.path.endsWith('-u9-.._.._etc_Resume 2026.pdf')).toBe(true)
    expect(attachment).toMatchObject({ kind: 'file', mime: 'application/pdf' })
  })
})
