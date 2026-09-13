import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelsPaths, DELIVERED_LIMIT, gatewaySocketPath, isOwner, issuePairingCode, loadConfig, StateStore, updateConfig } from './config'
import { pruneMedia } from './gateway'
import { renderAgentPlist } from './launchd'
import { parseQuickTunnelUrl, pointVapiAssistant } from './tunnel'
import { readDotenv } from '../commands/channels'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-channels-config-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('config', () => {
  it('fills defaults and merges stored assistant settings', () => {
    expect(loadConfig(dir).assistant).toMatchObject({ preset: 'workspace', busyDisposition: 'steer', progressNoticeMs: 45_000 })
    updateConfig(dir, (config) => {
      config.assistant.ownerName = 'Dylan'
      config.telegram = { enabled: true, botToken: 'secret-token' }
    })
    const loaded = loadConfig(dir)
    expect(loaded.assistant).toMatchObject({ ownerName: 'Dylan', preset: 'workspace' })
    expect(loaded.telegram?.botToken).toBe('secret-token')
  })

  it('writes secrets with owner-only permissions', () => {
    updateConfig(dir, (config) => {
      config.telegram = { enabled: true, botToken: 't' }
    })
    expect(statSync(channelsPaths(dir).config).mode & 0o777).toBe(0o600)
  })

  it('reports corrupt JSON instead of silently resetting it', () => {
    mkdirSync(channelsPaths(dir).dir, { recursive: true })
    writeFileSync(channelsPaths(dir).config, '{ nope')
    expect(() => loadConfig(dir)).toThrow(/not valid JSON/)
  })
})

describe('StateStore', () => {
  it('re-reads the file on every update so two writers do not clobber each other', () => {
    const gateway = StateStore.forDataDir(dir)
    const cli = StateStore.forDataDir(dir)
    gateway.update((state) => {
      state.threadId = 'thread-1'
    })
    cli.update((state) => {
      state.owners.push({ channel: 'telegram', senderId: '42', pairedAt: 1 })
    })
    gateway.update((state) => {
      state.delivered.push('msg-1')
    })
    const state = JSON.parse(readFileSync(channelsPaths(dir).state, 'utf8'))
    expect(state).toMatchObject({ threadId: 'thread-1', owners: [{ senderId: '42' }], delivered: ['msg-1'] })
    expect(isOwner(cli.read(), 'telegram', '42')).toBe(true)
    expect(isOwner(cli.read(), 'imessage', '42')).toBe(false)
  })

  it('bounds the bookkeeping lists', () => {
    const store = StateStore.forDataDir(dir)
    store.update((state) => {
      for (let index = 0; index < DELIVERED_LIMIT + 25; index += 1) state.delivered.push(`m${index}`)
    })
    const delivered = store.read().delivered
    expect(delivered).toHaveLength(DELIVERED_LIMIT)
    expect(delivered.at(-1)).toBe(`m${DELIVERED_LIMIT + 24}`)
  })

  it('issues six-digit pairing codes that expire', () => {
    const store = StateStore.forDataDir(dir)
    const pairing = issuePairingCode(store, 1_000)
    expect(pairing.code).toMatch(/^\d{6}$/)
    expect(pairing.expiresAt).toBe(1_000 + 15 * 60_000)
    expect(store.read().pairing).toEqual(pairing)
  })
})

describe('media pruning', () => {
  it('removes downloads older than the retention window', () => {
    const media = join(dir, 'media')
    mkdirSync(media)
    writeFileSync(join(media, 'old.jpg'), 'x')
    writeFileSync(join(media, 'new.jpg'), 'x')
    writeFileSync(join(media, 'last-week.pdf'), 'x')
    const days = (count: number): number => (Date.now() - count * 24 * 60 * 60_000) / 1000
    utimesSync(join(media, 'old.jpg'), days(31), days(31))
    // Still around a week later, so "the PDF I sent last week" can be found.
    utimesSync(join(media, 'last-week.pdf'), days(8), days(8))
    expect(pruneMedia(media)).toBe(1)
    expect(existsSync(join(media, 'last-week.pdf'))).toBe(true)
    expect(pruneMedia(join(dir, 'missing'))).toBe(0)
  })
})

describe('launchd plist', () => {
  it('runs channels serve with KeepAlive, throttling, and XML-escaped paths', () => {
    const plist = renderAgentPlist({ node: '/usr/local/bin/node', cli: '/Users/d/lattice & co/out/cli/lattice.cjs', dataDir: '/Users/d/Library/Application Support/Lattice', logPath: '/tmp/gw.log', path: '/usr/bin' })
    expect(plist).toContain('<string>/Users/d/lattice &amp; co/out/cli/lattice.cjs</string>')
    expect(plist).toContain('<string>channels</string>\n    <string>serve</string>')
    expect(plist).toContain('<key>KeepAlive</key><true/>')
    expect(plist).toContain('<key>ThrottleInterval</key><integer>30</integer>')
    expect(plist).toContain('<key>LATTICE_CHANNELS_SUPERVISED</key><string>1</string>')
  })
})

describe('tunnel helpers', () => {
  it('finds the quick tunnel URL in cloudflared output', () => {
    const output = '2026-09-12T22:00:00Z INF |  https://calm-river-demo.trycloudflare.com  |\n'
    expect(parseQuickTunnelUrl(output)).toBe('https://calm-river-demo.trycloudflare.com')
    expect(parseQuickTunnelUrl('INF Registered tunnel connection')).toBeUndefined()
  })

  it('re-points a Vapi assistant without dropping its model settings', async () => {
    const requests: Array<{ url: string; method: string; body?: unknown }> = []
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      requests.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })
      if (!init?.method) return new Response(JSON.stringify({ model: { provider: 'custom-llm', model: 'lattice-assistant', url: 'https://old.trycloudflare.com', messages: [{ role: 'system', content: 'keep me' }] } }))
      return new Response('{}')
    }) as typeof fetch
    await pointVapiAssistant({ apiKey: 'k', assistantId: 'asst_1', baseUrl: 'https://new.trycloudflare.com', fetchImpl })
    expect(requests[1]).toEqual({
      url: 'https://api.vapi.ai/assistant/asst_1',
      method: 'PATCH',
      body: { model: { provider: 'custom-llm', model: 'lattice-assistant', url: 'https://new.trycloudflare.com', messages: [{ role: 'system', content: 'keep me' }] } }
    })
  })
})

describe('readDotenv', () => {
  it('parses export lines and quoted values', () => {
    const path = join(dir, '.env')
    writeFileSync(path, '# comment\nPHOTON_PROJECT_ID=proj_1\nexport PHOTON_PROJECT_SECRET="s3cr=t"\nBAD LINE\n')
    expect(readDotenv(path)).toEqual({ PHOTON_PROJECT_ID: 'proj_1', PHOTON_PROJECT_SECRET: 's3cr=t' })
    expect(readDotenv(join(dir, 'missing'))).toEqual({})
  })
})

describe('gateway socket path', () => {
  it('lives next to the config unless that would exceed the unix socket limit', () => {
    expect(gatewaySocketPath('/Users/dylan/Library/Application Support/Lattice/channels')).toBe('/Users/dylan/Library/Application Support/Lattice/channels/gateway.sock')
    const deep = `/private/tmp/claude-501/${'x'.repeat(60)}/scratchpad/e2e/data/channels`
    const short = gatewaySocketPath(deep, { XDG_RUNTIME_DIR: '/run/user/501' })
    expect(short).toMatch(/^\/run\/user\/501\/lattice-channels-[0-9a-f]{16}\.sock$/)
    expect(gatewaySocketPath(deep, { XDG_RUNTIME_DIR: '/run/user/501' })).toBe(short)
    expect(gatewaySocketPath(`${deep}2`, { XDG_RUNTIME_DIR: '/run/user/501' })).not.toBe(short)
    expect(Buffer.byteLength(gatewaySocketPath(deep, {}))).toBeLessThanOrEqual(100)
  })
})
