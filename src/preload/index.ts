import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, type LatticeApi, type PushEvent } from '@shared/ipc'

const api = {} as Record<string, (...args: unknown[]) => Promise<unknown>>
for (const method of API_METHODS) {
  api[method] = (...args: unknown[]) => ipcRenderer.invoke(`lattice:${method}`, ...args)
}

const listeners = new Set<(event: PushEvent) => void>()
ipcRenderer.on('lattice:push', (_ev, event: PushEvent) => {
  for (const fn of listeners) fn(event)
})

contextBridge.exposeInMainWorld('lattice', {
  ...api,
  onPush(fn: (event: PushEvent) => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }
})

export type LatticeBridge = LatticeApi & {
  onPush(fn: (event: PushEvent) => void): () => void
}
