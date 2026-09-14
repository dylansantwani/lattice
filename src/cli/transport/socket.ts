import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import { LOCAL_PROTOCOL_VERSION, localControlSocketPath, type RuntimeInfo } from '../../main/net/local'
import { createApiProxy, PushEventQueue, TransportError, type LatticeTransport } from './types'

interface SocketOptions {
  path?: string
  dataDir?: string
  timeoutMs?: number
  expectedProtocol?: number
}

interface Reply {
  id?: number
  ok?: boolean
  result?: unknown
  error?: { message?: string; code?: string }
  protocol?: number
  pid?: number
  version?: string
  mode?: string
  push?: PushEvent
}

function protocolError(expected: number, actual: number | undefined, version?: string): TransportError {
  return new TransportError(
    `control protocol mismatch: CLI expects ${expected}, running Lattice reports ${actual ?? 'unknown'}${version ? ` (${version})` : ''}; upgrade the CLI or the running Lattice.`
  )
}

export async function connectLocalTransport(options: SocketOptions): Promise<LatticeTransport> {
  const path = options.path ?? localControlSocketPath(options.dataDir ?? '')
  const timeoutMs = options.timeoutMs ?? 300
  const socket = createConnection(path)
  const queue = new PushEventQueue()
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: unknown) => void }>()
  let nextId = 1
  let buffer = ''
  let closed = false

  const rejectPending = (error: unknown): void => {
    for (const entry of pending.values()) entry.reject(error)
    pending.clear()
  }
  const fail = (error: unknown): void => {
    const wrapped = error instanceof TransportError ? error : new TransportError((error as Error).message || String(error), { cause: error })
    rejectPending(wrapped)
    queue.end()
  }
  socket.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8')
    const lines = buffer.split('\n')
    buffer = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim()) continue
      let message: Reply
      try {
        message = JSON.parse(line) as Reply
      } catch (error) {
        fail(new TransportError(`invalid control-socket response: ${(error as Error).message}`))
        return
      }
      if (message.push !== undefined) {
        queue.push(message.push)
        continue
      }
      if (typeof message.id !== 'number') continue
      const entry = pending.get(message.id)
      if (!entry) continue
      pending.delete(message.id)
      if (message.ok === false) {
        const error = new Error(message.error?.message || 'control-socket request failed') as Error & { code?: string }
        error.name = message.error?.code || 'RemoteError'
        entry.reject(error)
      } else {
        entry.resolve(message)
      }
    }
  })
  socket.on('error', fail)
  socket.on('close', () => {
    if (!closed) fail(new TransportError('control socket closed'))
  })

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new TransportError(`could not reach local runtime at ${path}`))
    }, timeoutMs)
    socket.once('connect', () => {
      clearTimeout(timer)
      resolve()
    })
    socket.once('error', (error) => {
      clearTimeout(timer)
      reject(new TransportError(`could not reach local runtime at ${path}: ${(error as Error).message}`, { cause: error }))
    })
  })

  const request = (method: string, args: unknown[]): Promise<unknown> => {
    if (closed || socket.destroyed) return Promise.reject(new TransportError('local transport is closed'))
    const id = nextId++
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject })
      socket.write(`${JSON.stringify({ id, method, args })}\n`)
    }).then((message) => (message as Reply).result)
  }

  const waitForReply = (id: number, payload: Record<string, unknown>, waitMs: number): Promise<Reply> =>
    new Promise<Reply>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new TransportError(`local runtime did not answer request ${id} within ${waitMs}ms`))
      }, waitMs)
      pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value as Reply) },
        reject: (error) => { clearTimeout(timer); reject(error) }
      })
      try {
        socket.write(`${JSON.stringify({ id, ...payload })}\n`)
      } catch (error) {
        clearTimeout(timer)
        pending.delete(id)
        reject(error)
      }
    })

  try {
    const healthId = nextId++
    const health = await waitForReply(healthId, { method: 'health' }, timeoutMs)
    const expected = options.expectedProtocol ?? LOCAL_PROTOCOL_VERSION
    if (health.protocol !== expected) throw protocolError(expected, health.protocol, health.version)

    const subscriptionId = nextId++
    await waitForReply(subscriptionId, { subscribe: true }, Math.max(timeoutMs, 1_000))
  } catch (error) {
    closed = true
    socket.destroy()
    throw error
  }

  const api = createApiProxy(request)
  return {
    api,
    events: queue,
    mode: 'attached',
    async close(): Promise<void> {
      if (closed) return
      closed = true
      try {
        const id = nextId++
        socket.write(`${JSON.stringify({ id, unsubscribe: true })}\n`)
      } catch {
        /* socket is already closing */
      }
      rejectPending(new TransportError('local transport closed'))
      queue.end()
      socket.end()
    }
  }
}

/** Read the runtime metadata file without throwing when no runtime has booted. */
export async function readRuntimeInfo(dataDir: string): Promise<RuntimeInfo | undefined> {
  const { readFile } = await import('node:fs/promises')
  try {
    return JSON.parse(await readFile(join(dataDir, 'runtime.json'), 'utf8')) as RuntimeInfo
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    return undefined
  }
}
