import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { isPidAlive } from '../../main/runtimeLock'
import { connectLocalTransport, readRuntimeInfo } from './socket'
import { createEmbeddedTransport } from './embedded'
import { connectRemoteTransport } from './remote'
import { TransportError, type LatticeTransport } from './types'

export interface ResolveTransportOptions {
  dataDir?: string
  remote?: string
  token?: string
  password?: string
  embedded?: boolean
  verbose?: boolean
  log?: (message: string) => void
}

export function defaultDataDir(): string {
  if (process.env.LATTICE_DATA_DIR) return resolve(process.env.LATTICE_DATA_DIR)
  if (process.platform === 'darwin') return resolve(join(homedir(), 'Library/Application Support/Lattice'))
  return resolve(join(homedir(), '.lattice'))
}

function note(options: ResolveTransportOptions, message: string): void {
  if (options.verbose) (options.log ?? console.error)(`[transport] ${message}`)
}

async function canAttach(dataDir: string, options: ResolveTransportOptions): Promise<LatticeTransport | undefined> {
  const runtime = await readRuntimeInfo(dataDir)
  if (!runtime || !isPidAlive(runtime.pid)) return undefined
  note(options, `runtime ${runtime.pid} is alive; probing ${runtime.socket}`)
  try {
    return await connectLocalTransport({ path: runtime.socket, timeoutMs: 300 })
  } catch (error) {
    if (error instanceof TransportError && error.message.includes('protocol mismatch')) throw error
    note(options, `runtime probe failed: ${(error as Error).message}`)
    return undefined
  }
}

async function describeLock(dataDir: string): Promise<string> {
  try {
    const contents = await readFile(join(dataDir, 'runtime.lock'), 'utf8')
    const pid = Number.parseInt(contents.trim().split(/\s+/, 1)[0] ?? '', 10)
    if (Number.isInteger(pid) && pid > 0) return `pid ${pid}`
  } catch {
    /* no lock or unreadable lock; the embedded error remains the source of truth */
  }
  return 'another process'
}

export async function resolveTransport(options: ResolveTransportOptions = {}): Promise<LatticeTransport> {
  if (options.remote) {
    note(options, `using remote endpoint ${options.remote}`)
    return connectRemoteTransport({ endpoint: options.remote, token: options.token, password: options.password })
  }

  const dataDir = resolve(options.dataDir || defaultDataDir())
  if (!options.embedded) {
    const attached = await canAttach(dataDir, options)
    if (attached) {
      note(options, 'attached to the live runtime')
      return attached
    }
  }

  note(options, options.embedded ? 'embedded mode forced' : 'no reachable runtime; starting embedded mode')
  try {
    return await createEmbeddedTransport({ dataDir })
  } catch (error) {
    const lock = await describeLock(dataDir)
    throw new TransportError(
      `cannot start an embedded runtime: ${lock} holds ${dataDir}, but its control socket is unreachable. ` +
        `Use lattice --remote <url> or quit that process before retrying. ${(error as Error).message}`,
      { cause: error }
    )
  }
}

export * from './types'
export * from './socket'
export * from './embedded'
export * from './remote'
