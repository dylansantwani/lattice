import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createServer, type Socket } from 'node:net'
import { createHash, randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { PushEvent } from '@shared/ipc'
import { dispatch, subscribe, UnknownMethodError } from './bridge'
import { isPidAlive } from '../runtimeLock'

export const LOCAL_PROTOCOL_VERSION = 1

const MAX_LINE_BYTES = 32 * 1024 * 1024

export interface RuntimeInfo {
  pid: number
  startedAt: string
  socket: string
  protocol: number
  version: string
  mode: 'desktop' | 'serve'
  dataDir: string
  bridgePort?: number
}

export interface LocalControlSocketOptions {
  dataDir: string
  mode?: RuntimeInfo['mode']
  version?: string
  pid?: number
  bridgePort?: number
}

export interface LocalControlSocket {
  readonly path: string
  readonly runtime: RuntimeInfo
  connections(): number
  stop(): Promise<void>
}

interface Request {
  id?: number
  method?: string
  args?: unknown
  subscribe?: boolean
  unsubscribe?: boolean
}

/**
 * Platform-specific address for a data directory's local control server.
 *
 * Unix socket paths are capped by `sun_path` (104 bytes on macOS, 108 on Linux, NUL included). A
 * data dir deep enough to exceed it would fail to bind with a misleading ENOENT, so long paths fall
 * back to a short per-data-dir socket in the temp directory. Clients never recompute this path from
 * scratch when a runtime is live — they read it from runtime.json — so the fallback is transparent.
 */
export const MAX_UNIX_SOCKET_PATH_BYTES = 103

export function localControlSocketPath(dataDir: string): string {
  const hash = createHash('sha256').update(dataDir).digest('hex').slice(0, 20)
  if (process.platform === 'win32') return `\\\\.\\pipe\\lattice-${hash}`
  const beside = join(dataDir, 'control.sock')
  if (Buffer.byteLength(beside) <= MAX_UNIX_SOCKET_PATH_BYTES) return beside
  return join(tmpdir(), `lattice-${hash}.sock`)
}

export function runtimeInfoPath(dataDir: string): string {
  return join(dataDir, 'runtime.json')
}

function errorCode(error: unknown): string {
  if (error instanceof UnknownMethodError) return 'UNKNOWN_METHOD'
  const code = (error as { category?: unknown }).category
  return typeof code === 'string' ? code : 'INTERNAL'
}

function send(socket: Socket, value: unknown): void {
  if (!socket.destroyed) socket.write(`${JSON.stringify(value)}\n`)
}

async function readRuntimeInfo(dataDir: string): Promise<RuntimeInfo | undefined> {
  try {
    return JSON.parse(await readFile(runtimeInfoPath(dataDir), 'utf8')) as RuntimeInfo
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function removeStaleSocket(dataDir: string, path: string): Promise<void> {
  if (process.platform === 'win32') return
  const runtime = await readRuntimeInfo(dataDir)
  if (!runtime || runtime.socket !== path || isPidAlive(runtime.pid)) return
  await rm(path, { force: true })
  await rm(runtimeInfoPath(dataDir), { force: true })
}

async function writeRuntimeInfo(info: RuntimeInfo): Promise<void> {
  const path = runtimeInfoPath(info.dataDir)
  const temporaryPath = `${path}.${randomUUID()}.tmp`
  await writeFile(temporaryPath, `${JSON.stringify(info)}\n`, { encoding: 'utf8', mode: 0o600 })
  await rename(temporaryPath, path)
  if (process.platform !== 'win32') await chmod(path, 0o600)
}

/**
 * Starts the newline-delimited JSON control socket for a single local runtime.
 * It deliberately has no startup integration: callers own when the runtime starts and stops.
 */
export async function startLocalControlSocket(options: LocalControlSocketOptions): Promise<LocalControlSocket> {
  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(options.dataDir, 0o700)
  const path = localControlSocketPath(options.dataDir)
  await removeStaleSocket(options.dataDir, path)

  const runtime: RuntimeInfo = {
    pid: options.pid ?? process.pid,
    startedAt: new Date().toISOString(),
    socket: path,
    protocol: LOCAL_PROTOCOL_VERSION,
    version: options.version ?? '0.1.0',
    mode: options.mode ?? 'desktop',
    dataDir: options.dataDir,
    ...(options.bridgePort === undefined ? {} : { bridgePort: options.bridgePort })
  }
  const sockets = new Set<Socket>()
  const server = createServer((socket) => {
    sockets.add(socket)
    const subscriptions = new Map<number, () => void>()
    let buffer = ''

    const cleanup = (): void => {
      sockets.delete(socket)
      for (const unsubscribe of subscriptions.values()) unsubscribe()
      subscriptions.clear()
    }
    socket.on('close', cleanup)
    socket.on('error', cleanup)
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8')
      if (Buffer.byteLength(buffer) > MAX_LINE_BYTES) return socket.destroy(new Error('request too large'))
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) void handleLine(socket, subscriptions, runtime, line)
    })
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(path, () => {
        server.off('error', reject)
        resolve()
      })
    })
    if (process.platform !== 'win32') await chmod(path, 0o600)
    await writeRuntimeInfo(runtime)
  } catch (error) {
    server.close()
    throw error
  }

  let stopped = false
  return {
    path,
    runtime,
    connections: () => sockets.size,
    async stop(): Promise<void> {
      if (stopped) return
      stopped = true
      for (const socket of sockets) socket.destroy()
      await new Promise<void>((resolve) => server.close(() => resolve()))
      if (process.platform !== 'win32') await rm(path, { force: true })
      try {
        const current = await readRuntimeInfo(options.dataDir)
        if (current?.pid === runtime.pid && current.socket === path) await rm(runtimeInfoPath(options.dataDir), { force: true })
      } catch {
        // Shutdown should not fail merely because another runtime has replaced its metadata.
      }
    }
  }
}

async function handleLine(socket: Socket, subscriptions: Map<number, () => void>, runtime: RuntimeInfo, line: string): Promise<void> {
  let request: Request
  try {
    request = JSON.parse(line) as Request
  } catch {
    send(socket, { ok: false, error: { message: 'invalid JSON', code: 'BAD_REQUEST' } })
    return
  }
  if (typeof request.id !== 'number' || !Number.isInteger(request.id)) {
    send(socket, { ok: false, error: { message: 'request id must be an integer', code: 'BAD_REQUEST' } })
    return
  }
  const id = request.id
  if (request.method === 'health') {
    send(socket, { id, protocol: runtime.protocol, pid: runtime.pid, version: runtime.version, mode: runtime.mode })
    return
  }
  if (request.subscribe === true) {
    subscriptions.get(id)?.()
    subscriptions.set(id, subscribe((event: PushEvent) => send(socket, { push: event })))
    send(socket, { id, ok: true })
    return
  }
  if (request.unsubscribe === true) {
    subscriptions.get(id)?.()
    subscriptions.delete(id)
    send(socket, { id, ok: true })
    return
  }
  if (typeof request.method !== 'string' || !Array.isArray(request.args)) {
    send(socket, { id, ok: false, error: { message: 'method and args are required', code: 'BAD_REQUEST' } })
    return
  }
  try {
    send(socket, { id, ok: true, result: await dispatch(request.method, request.args) })
  } catch (error) {
    send(socket, { id, ok: false, error: { message: (error as Error).message || 'internal error', code: errorCode(error) } })
  }
}
