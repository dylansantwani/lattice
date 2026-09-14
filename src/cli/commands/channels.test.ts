import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseCliArgs } from '../args'
import { loadConfig, StateStore } from '../channels/config'
import { parseBotToken, parseTokenCount, runChannelsCommand } from './channels'

const TOKEN = '8123456789:AAFz-kE3yRw1YtmPq2Vn_x7cQ0LsH9dJ4bU'

/** Enough of api.telegram.org for setup: token check and the bot profile calls. */
class FakeBotApi {
  server!: Server
  base = ''
  methods: string[] = []
  rejectToken = false

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      const [, bot, method] = (req.url ?? '').split('/')
      this.methods.push(method ?? '')
      req.resume()
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' })
        if (this.rejectToken || bot !== `bot${TOKEN}`) {
          res.end(JSON.stringify({ ok: false, error_code: 401, description: 'Unauthorized' }))
          return
        }
        if (method === 'getMe') res.end(JSON.stringify({ ok: true, result: { id: 8123456789, is_bot: true, first_name: 'Lattice', username: 'DylanLatticeBot' } }))
        else if (method === 'getMyCommands') res.end(JSON.stringify({ ok: true, result: [] }))
        else if (method === 'getMyShortDescription') res.end(JSON.stringify({ ok: true, result: { short_description: '' } }))
        else if (method === 'getMyDescription') res.end(JSON.stringify({ ok: true, result: { description: '' } }))
        else res.end(JSON.stringify({ ok: true, result: true }))
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', () => resolve()))
    const address = this.server.address()
    this.base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }
}

let dir: string
let api: FakeBotApi
let output: string[]

async function run(...args: string[]): Promise<number> {
  return runChannelsCommand({ flags: parseCliArgs(['channels', ...args]), dataDir: dir, stdout: (text) => output.push(text), interactive: false, platform: 'linux' })
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-channels-cmd-'))
  api = new FakeBotApi()
  await api.start()
  output = []
})

afterEach(async () => {
  await api.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('parseBotToken', () => {
  it('accepts a token however it was pasted', () => {
    expect(parseBotToken(TOKEN)).toBe(TOKEN)
    expect(parseBotToken(`  ${TOKEN}\n`)).toBe(TOKEN)
    expect(parseBotToken(`bot${TOKEN}`)).toBe(TOKEN)
    expect(parseBotToken(`https://api.telegram.org/bot${TOKEN}/getMe`)).toBe(TOKEN)
    expect(parseBotToken(`Use this token to access the HTTP API:\n${TOKEN}\nKeep your token secure`)).toBe(TOKEN)
  })

  it('rejects things that are not tokens', () => {
    expect(parseBotToken('')).toBeUndefined()
    expect(parseBotToken('123456:short')).toBeUndefined()
    expect(parseBotToken('my password is hunter2')).toBeUndefined()
    expect(parseBotToken(undefined)).toBeUndefined()
  })
})

describe('lattice channels setup telegram', () => {
  it('validates the token, saves it privately, sets the bot profile, and prints the pairing link', async () => {
    const code = await run('setup', 'telegram', '--token', `bot${TOKEN}`, '--api-base', api.base, '--no-transcription')
    expect(code).toBe(0)
    const config = loadConfig(dir)
    expect(config.telegram).toEqual({ enabled: true, botToken: TOKEN, apiBase: api.base })
    expect(statSync(join(dir, 'channels', 'config.json')).mode & 0o777).toBe(0o600)
    expect(api.methods).toEqual(['getMe', 'getMyCommands', 'setMyCommands', 'getMyShortDescription', 'setMyShortDescription', 'getMyDescription', 'setMyDescription'])
    const text = output.join('\n')
    const pairing = StateStore.forDataDir(dir).read().pairing!
    expect(text).toContain('Telegram bot @DylanLatticeBot is set up (token 8123…J4bU saved')
    expect(text).not.toContain(TOKEN)
    expect(text).toContain(`https://t.me/DylanLatticeBot?start=${pairing.code}`)
    expect(text).toContain(`/pair ${pairing.code}`)
    expect(text).toContain('Start the gateway: lattice channels serve')
    expect(text).not.toContain('[107m') // no QR outside a terminal
  })

  it('explains how to get a token when none is given and nothing can prompt', async () => {
    const previous = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    try {
      expect(await run('setup', 'telegram')).toBe(2)
    } finally {
      if (previous !== undefined) process.env.TELEGRAM_BOT_TOKEN = previous
    }
    expect(output.join('\n')).toContain('https://t.me/BotFather')
    expect(loadConfig(dir).telegram).toBeUndefined()
  })

  it('refuses a malformed token before calling Telegram, and a rejected one without saving', async () => {
    await expect(run('setup', 'telegram', '--token', 'not-a-token', '--api-base', api.base)).rejects.toThrow(/does not look like a bot token/)
    expect(api.methods).toEqual([])
    api.rejectToken = true
    await expect(run('setup', 'telegram', '--token', TOKEN, '--api-base', api.base, '--no-transcription')).rejects.toThrow(/Telegram rejected that token: getMe: Unauthorized/)
    expect(loadConfig(dir).telegram).toBeUndefined()
  })
})

describe('lattice channels setup transcription --local', () => {
  it('saves a local faster-whisper provider for an explicit interpreter', async () => {
    expect(await run('setup', 'transcription', '--local', '--python', '/opt/venv/bin/python', '--model', 'large-v3', '--language', 'en', '--no-verify')).toBe(0)
    expect(loadConfig(dir).transcription).toEqual({ provider: 'local', python: '/opt/venv/bin/python', model: 'large-v3', language: 'en' })
    expect(output.join('\n')).toContain('faster-whisper large-v3')
  })
})

describe('lattice channels notify', () => {
  it('refuses missing files and reports a gateway that is not running', async () => {
    await expect(run('notify', 'hi', '--file', join(dir, 'missing.png'))).rejects.toThrow(/no such file/)
    expect(await run('notify', 'hi')).toBe(1)
    expect(output.at(-1)).toMatch(/notify failed: gateway not running/)
  })
})

describe('lattice channels setup assistant', () => {
  it('saves progress cadence and the rolling window, and refuses a window that could not roll', async () => {
    expect(await run('setup', 'assistant', '--progress', '20s', '--progress-every', '2m', '--rolling-trigger', '96k', '--rolling-keep', '30000')).toBe(0)
    expect(loadConfig(dir).assistant).toMatchObject({ progressNoticeMs: 20_000, progressEveryMs: 120_000, rolling: { triggerTokens: 96_000, keepTokens: 30_000 } })
    await expect(run('setup', 'assistant', '--rolling-trigger', '40k', '--rolling-keep', '30k')).rejects.toThrow(/well under/)
    await expect(run('setup', 'assistant', '--rolling-trigger', 'lots')).rejects.toThrow(/invalid token count/)
  })
})

describe('lattice channels roll', () => {
  it('reports a gateway that is not running', async () => {
    expect(await run('roll', '--keep', '0')).toBe(1)
    expect(output.at(-1)).toMatch(/roll failed: gateway not running/)
  })

  it('parses token counts', () => {
    expect(parseTokenCount('64k', 0)).toBe(64_000)
    expect(parseTokenCount('1.5m', 0)).toBe(1_500_000)
    expect(parseTokenCount('24000', 0)).toBe(24_000)
    expect(parseTokenCount(undefined, 7)).toBe(7)
  })
})
