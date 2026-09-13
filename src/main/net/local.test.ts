import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createConnection, type Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import type { LatticeApi } from '@shared/ipc'
import { _resetBridge, broadcast, registerApi } from './bridge'
import { localControlSocketPath, MAX_UNIX_SOCKET_PATH_BYTES, runtimeInfoPath, startLocalControlSocket } from './local'

const directories: string[] = []
const servers: Array<Awaited<ReturnType<typeof startLocalControlSocket>>> = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-local-socket-'))
  directories.push(dir)
  return dir
}

function mockApi(overrides: Partial<Record<keyof LatticeApi, (...args: never[]) => unknown>>): LatticeApi {
  return overrides as unknown as LatticeApi
}

async function connect(path: string): Promise<{ socket: Socket; messages: unknown[] }> {
  const socket = createConnection(path)
  const messages: unknown[] = []
  let buffer = ''
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) messages.push(JSON.parse(line))
  })
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve)
    socket.once('error', reject)
  })
  return { socket, messages }
}

async function eventually<T>(read: () => T | undefined): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = read()
    if (value !== undefined) return value
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
  throw new Error('timed out waiting for socket response')
}

afterEach(async () => {
  for (const server of servers.splice(0)) await server.stop()
  _resetBridge()
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('local control socket', () => {
  it('dispatches NDJSON RPCs and writes lifecycle metadata', async () => {
    const dir = dataDir()
    registerApi(mockApi({ listThreads: async () => [{ id: 'thread-1' }] }))
    const server = await startLocalControlSocket({ dataDir: dir, mode: 'serve', version: 'test-version' })
    servers.push(server)
    const client = await connect(server.path)
    client.socket.write('{"id":1,"method":"listThreads","args":[]}\n')
    await expect(eventually(() => client.messages[0])).resolves.toEqual({ id: 1, ok: true, result: [{ id: 'thread-1' }] })
    expect(JSON.parse(readFileSync(runtimeInfoPath(dir), 'utf8'))).toMatchObject({ socket: server.path, mode: 'serve', version: 'test-version' })
    client.socket.destroy()
  })

  it('reports health, errors, and push subscriptions', async () => {
    const dir = dataDir()
    registerApi(mockApi({}))
    const server = await startLocalControlSocket({ dataDir: dir, mode: 'desktop', version: 'test-version' })
    servers.push(server)
    const client = await connect(server.path)
    client.socket.write('{"id":1,"method":"health"}\n{"id":2,"method":"nope","args":[]}\n{"id":3,"subscribe":true}\n')
    await expect(eventually(() => client.messages.find((message) => (message as { id?: number }).id === 3))).resolves.toEqual({ id: 3, ok: true })
    expect(client.messages.find((message) => (message as { id?: number }).id === 1)).toMatchObject({ id: 1, protocol: 1, mode: 'desktop', version: 'test-version' })
    expect(client.messages.find((message) => (message as { id?: number }).id === 2)).toMatchObject({ id: 2, ok: false, error: { code: 'UNKNOWN_METHOD' } })
    broadcast({ kind: 'models.updated' })
    await expect(eventually(() => client.messages.find((message) => (message as { push?: unknown }).push !== undefined))).resolves.toEqual({ push: { kind: 'models.updated' } })
    client.socket.write('{"id":3,"unsubscribe":true}\n')
    await expect(eventually(() => client.messages.filter((message) => (message as { id?: number }).id === 3).length === 2 ? client.messages.filter((message) => (message as { id?: number }).id === 3)[1] : undefined)).resolves.toEqual({ id: 3, ok: true })
    client.socket.destroy()
  })

  it('keeps a data dir too deep for a unix socket bindable through a short temp-dir socket', async () => {
    const deep = join(dataDir(), 'a'.repeat(60), 'b'.repeat(60))
    mkdirSync(deep, { recursive: true })
    const path = localControlSocketPath(deep)
    if (process.platform === 'win32') return
    expect(Buffer.byteLength(join(deep, 'control.sock'))).toBeGreaterThan(MAX_UNIX_SOCKET_PATH_BYTES)
    expect(Buffer.byteLength(path)).toBeLessThanOrEqual(MAX_UNIX_SOCKET_PATH_BYTES)
    expect(localControlSocketPath(deep)).toBe(path)
    const server = await startLocalControlSocket({ dataDir: deep })
    servers.push(server)
    expect(server.path).toBe(path)
    expect(JSON.parse(readFileSync(runtimeInfoPath(deep), 'utf8')).socket).toBe(path)
  })

  it('reclaims a socket whose recorded owner has exited', async () => {
    const dir = dataDir()
    const path = localControlSocketPath(dir)
    writeFileSync(path, 'stale socket placeholder')
    writeFileSync(runtimeInfoPath(dir), JSON.stringify({ pid: 99999999, socket: path }))
    const server = await startLocalControlSocket({ dataDir: dir })
    servers.push(server)
    expect(server.path).toBe(path)
  })
})
