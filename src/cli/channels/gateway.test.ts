import { createServer, type Server, type Socket } from 'node:net'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { channelsPaths, loadConfig, saveConfig, defaultConfig, StateStore } from './config'
import { Gateway, queryGateway } from './gateway'

/** Speaks the runtime's newline-delimited control-socket protocol well enough for the gateway. */
class FakeControlRuntime {
  server: Server | null = null
  sockets = new Set<Socket>()
  calls: string[] = []
  private threadCreated = false
  currentModel = 'm'

  constructor(readonly path: string) {}

  async start(): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket)
      socket.on('close', () => this.sockets.delete(socket))
      let buffer = ''
      socket.on('data', (chunk) => {
        buffer += chunk.toString('utf8')
        let newline: number
        while ((newline = buffer.indexOf('\n')) >= 0) {
          const request = JSON.parse(buffer.slice(0, newline)) as { id: number; method?: string; args?: unknown[]; subscribe?: boolean }
          buffer = buffer.slice(newline + 1)
          socket.write(`${JSON.stringify(this.answer(request))}\n`)
        }
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(this.path, () => resolve()))
  }

  private answer(request: { id: number; method?: string; args?: unknown[]; subscribe?: boolean }): Record<string, unknown> {
    if (request.subscribe) return { id: request.id, ok: true }
    if (request.method === 'health') return { id: request.id, ok: true, protocol: 1, pid: process.pid, version: 'test' }
    this.calls.push(request.method ?? '?')
    const now = Date.now()
    const meta = { id: 'thread-1', workspaceId: 'ws', title: 'Assistant', createdAt: now, updatedAt: now, pinned: true, archived: false, model: this.currentModel, mode: 'act', permissionPreset: 'workspace', goal: '' }
    switch (request.method) {
      case 'getThreadView':
        if (!this.threadCreated) return { id: request.id, ok: false, error: { message: 'thread not found' } }
        return { id: request.id, ok: true, result: { meta, messages: [], turns: {}, events: [], hasMore: false } }
      case 'resolveWorkspace':
        return { id: request.id, ok: true, result: { id: 'ws', name: 'Assistant', roots: [] } }
      case 'createThread':
        this.threadCreated = true
        return { id: request.id, ok: true, result: meta }
      case 'pendingApprovals':
      case 'pendingAsks':
        return { id: request.id, ok: true, result: [] }
      case 'listModels':
        return { id: request.id, ok: true, result: [{ id: 'm' }, { id: 'openai/gpt-5.5' }] }
      case 'getSettings':
        return { id: request.id, ok: true, result: { defaultModel: 'm' } }
      case 'updateThread': {
        const patch = request.args?.[1] as { model?: string } | undefined
        if (patch?.model) this.currentModel = patch.model
        return { id: request.id, ok: true, result: { ...meta, model: this.currentModel } }
      }
      default:
        return { id: request.id, ok: true, result: meta }
    }
  }

  /** Simulate the app quitting: drop every connection and stop listening. */
  async crash(): Promise<void> {
    for (const socket of this.sockets) socket.destroy()
    await new Promise<void>((resolve) => this.server!.close(() => resolve()))
    this.server = null
  }

  async stop(): Promise<void> {
    if (this.server) await this.crash()
  }
}

let dir: string
let runtime: FakeControlRuntime
let gateway: Gateway | null
let logs: string[]

async function waitFor(predicate: () => boolean, timeoutMs = 8_000): Promise<void> {
  const started = Date.now()
  while (!predicate()) {
    if (Date.now() - started > timeoutMs) throw new Error(`timed out; logs:\n${logs.join('\n')}`)
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'lat-gw-'))
  runtime = new FakeControlRuntime(join(dir, 'control.sock'))
  await runtime.start()
  writeFileSync(join(dir, 'runtime.json'), JSON.stringify({ pid: process.pid, startedAt: '', socket: runtime.path, protocol: 1, version: 'test', mode: 'desktop', dataDir: dir }))
  const config = defaultConfig()
  config.assistant.workspaceRoot = join(dir, 'assistant')
  config.assistant.allowTools = []
  // The phone endpoint on an ephemeral port is the cheapest channel that makes the gateway attach.
  config.voice = { enabled: true, port: 0, bind: '127.0.0.1', secret: 'test-secret', allowedCallers: [], maxWaitMs: 1_000, quickTunnel: false }
  saveConfig(dir, config)
  logs = []
  gateway = null
})

afterEach(async () => {
  await gateway?.stop()
  await runtime.stop()
  rmSync(dir, { recursive: true, force: true })
})

describe('Gateway', () => {
  it('attaches to the runtime, creates the assistant thread, and serves status over its socket', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    await waitFor(() => runtime.calls.includes('createThread') && runtime.calls.includes('pendingAsks'))
    expect(StateStore.forDataDir(dir).read().threadId).toBe('thread-1')
    const reply = await queryGateway(channelsPaths(dir).socket, { op: 'status' })
    expect(reply).toMatchObject({ ok: true, status: { runtime: 'attached', threadId: 'thread-1', voice: { port: expect.any(Number) } } })
  })

  it('stays detached, and creates no thread, while no channel is enabled', async () => {
    const config = defaultConfig()
    config.assistant.workspaceRoot = join(dir, 'assistant')
    saveConfig(dir, config)
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(runtime.calls).toEqual([])
    expect(logs.some((line) => line.includes('no channels are enabled'))).toBe(true)
  })

  it('reports a setup change on disk but ignores rewrites of its own config', async () => {
    let changes = 0
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line), onConfigChange: () => { changes += 1 } })
    await gateway.start()
    await new Promise((resolve) => setTimeout(resolve, 50))
    const same = loadConfig(dir)
    await new Promise((resolve) => setTimeout(resolve, 20))
    saveConfig(dir, same) // same content, new mtime: e.g. the router persisting /model
    await new Promise((resolve) => setTimeout(resolve, 3_500))
    expect(changes).toBe(0)
    saveConfig(dir, { ...same, telegram: { enabled: true, botToken: '123:abc' } })
    await waitFor(() => changes === 1, 8_000)
  }, 15_000)

  it('reconnects after the runtime goes away and comes back, reusing the thread', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    await waitFor(() => runtime.calls.includes('pendingAsks'))
    await runtime.crash()
    await waitFor(() => logs.some((line) => line.includes('connection closed')))
    const status = await queryGateway(channelsPaths(dir).socket, { op: 'status' })
    expect(status).toMatchObject({ status: { runtime: 'disconnected' } })
    runtime.calls = []
    await runtime.start()
    await waitFor(() => runtime.calls.includes('pendingAsks'))
    expect(runtime.calls).not.toContain('createThread')
    expect(logs.filter((line) => line.includes('connected to Lattice (attached)'))).toHaveLength(2)
  })

  it('takes pairing and owner edits over its control socket so it stays the only state writer', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    const pair = await queryGateway(channelsPaths(dir).socket, { op: 'pair' })
    expect((pair.pairing as { code: string }).code).toMatch(/^\d{6}$/)
    expect(StateStore.forDataDir(dir).read().pairing?.code).toBe((pair.pairing as { code: string }).code)
    StateStore.forDataDir(dir).update((state) => {
      state.owners.push({ channel: 'telegram', senderId: '42', pairedAt: 1 })
    })
    expect(await queryGateway(channelsPaths(dir).socket, { op: 'owners-rm', channel: 'telegram', senderId: '42' })).toEqual({ ok: true, removed: true })
    expect(await queryGateway(channelsPaths(dir).socket, { op: 'owners-rm', channel: 'telegram', senderId: '42' })).toEqual({ ok: true, removed: false })
    expect(StateStore.forDataDir(dir).read().owners).toEqual([])
  })

  it('changes the live assistant model over its control socket and persists it', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    await waitFor(() => runtime.calls.includes('pendingAsks'))
    const reply = await queryGateway(channelsPaths(dir).socket, { op: 'assistant-model', model: 'openai/gpt-5.5' })
    expect(reply).toMatchObject({ ok: true, model: 'openai/gpt-5.5', configuredModel: 'openai/gpt-5.5' })
    expect(runtime.currentModel).toBe('openai/gpt-5.5')
    expect(loadConfig(dir).assistant.model).toBe('openai/gpt-5.5')
  })

  it('refuses to start a second gateway on the same data directory', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    const second = new Gateway({ dataDir: dir, log: () => undefined })
    await expect(second.start()).rejects.toThrow(/already running/)
  })

  it('explains a notify with nowhere to send, and removes its socket on stop', async () => {
    gateway = new Gateway({ dataDir: dir, log: (line) => logs.push(line) })
    await gateway.start()
    await waitFor(() => runtime.calls.includes('pendingAsks'))
    await queryGateway(channelsPaths(dir).socket, { op: 'notify', text: 'hello' })
    expect(logs.some((line) => line.includes('no conversation yet'))).toBe(true)
    await gateway.stop()
    gateway = null
    expect(existsSync(channelsPaths(dir).socket)).toBe(false)
  })
})
