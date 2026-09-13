import type { LatticeApi, PushEvent } from '@shared/ipc'
import { registerIpc, stopRuntime } from '../../main/ipc'
import { dispatch, subscribe } from '../../main/net/bridge'
import { closeDb } from '../../main/store/db'
import { getSettings, setSettings } from '../../main/store/eventStore'
import { shutdownMcp } from '../../main/mcp/manager'
import { killAllBgJobs } from '../../main/tools/bgJobs'
import { killAllTerminals } from '../../main/ptyTerminal'
import { createApiProxy, PushEventQueue, TransportError, type LatticeTransport } from './types'

export interface EmbeddedTransportOptions {
  dataDir: string
}

export async function createEmbeddedTransport(options: EmbeddedTransportOptions): Promise<LatticeTransport> {
  process.env.LATTICE_DATA_DIR = options.dataDir
  if (process.env.LATTICE_SERVE_BRIDGE !== '1') process.env.LATTICE_NO_REMOTE_BRIDGE = '1'
  process.env.LATTICE_RUNTIME_MODE = 'serve'
  if (process.env.LATTICE_SERVE_BRIDGE === '1') {
    const settings = getSettings()
    const port = Number.parseInt(process.env.LATTICE_PORT || '', 10)
    setSettings({ remoteAccess: { ...settings.remoteAccess, enabled: true, ...(port > 0 ? { port } : {}) } })
  }
  try {
    await registerIpc()
  } catch (error) {
    throw new TransportError((error as Error).message || 'could not start embedded runtime', { cause: error })
  }

  const queue = new PushEventQueue()
  const unsubscribe = subscribe((event: PushEvent) => queue.push(event))
  const api = createApiProxy((method, args) => dispatch(method, args))
  let closed = false
  return {
    api,
    events: queue,
    mode: 'embedded',
    async close(): Promise<void> {
      if (closed) return
      closed = true
      unsubscribe()
      queue.end()
      await shutdownMcp()
      killAllBgJobs()
      killAllTerminals()
      await stopRuntime()
      closeDb()
    }
  }
}
