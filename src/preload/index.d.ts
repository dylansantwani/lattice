import type { LatticeApi, PushEvent } from '../shared/ipc'
import type { RemoteAccessSettings } from '../shared/types'

/** Remote-access admin surface (see src/preload/index.ts). Renderer-only, not on LatticeApi. */
export interface RemoteAdmin {
  status(): Promise<{ running: boolean; port: number; subscribers: number; hasPassword: boolean; settings: RemoteAccessSettings }>
  setEnabled(enabled: boolean): Promise<{ running: boolean; port: number; subscribers: number; hasPassword: boolean }>
  setPassword(password: string): Promise<{ hasPassword: boolean }>
  setConfig(patch: { port?: number; publicUrl?: string; tokenTtlDays?: number }): Promise<RemoteAccessSettings>
  listDevices(): Promise<{ id: string; device: string; createdAt: number; lastSeenAt: number; expiresAt: number }[]>
  revokeDevice(id: string): Promise<{ id: string; device: string; createdAt: number; lastSeenAt: number; expiresAt: number }[]>
}

declare global {
  interface Window {
    lattice: LatticeApi & {
      onPush(fn: (event: PushEvent) => void): () => void
      remote: RemoteAdmin
    }
  }
}

export {}
