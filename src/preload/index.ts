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

// Remote-access administration (the iOS bridge). Renderer-only — deliberately NOT part of
// LatticeApi, so a connected remote client can never toggle the bridge or set its password.
const remote = {
  status: () => ipcRenderer.invoke('lattice:remote:status'),
  setEnabled: (enabled: boolean) => ipcRenderer.invoke('lattice:remote:setEnabled', enabled),
  setPassword: (password: string) => ipcRenderer.invoke('lattice:remote:setPassword', password),
  setConfig: (patch: { port?: number; publicUrl?: string; tokenTtlDays?: number }) =>
    ipcRenderer.invoke('lattice:remote:setConfig', patch),
  listDevices: () => ipcRenderer.invoke('lattice:remote:listDevices'),
  revokeDevice: (id: string) => ipcRenderer.invoke('lattice:remote:revokeDevice', id)
}

contextBridge.exposeInMainWorld('lattice', {
  ...api,
  onPush(fn: (event: PushEvent) => void): () => void {
    listeners.add(fn)
    return () => listeners.delete(fn)
  },
  remote
})

export type RemoteAdmin = typeof remote

export type LatticeBridge = LatticeApi & {
  onPush(fn: (event: PushEvent) => void): () => void
  remote: RemoteAdmin
}
