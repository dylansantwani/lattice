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

export interface ChannelsAdminStatus {
  telegramConfigured: boolean
  telegramEnabled: boolean
  gatewayRunning: boolean
  /** Undefined means the messaging assistant follows Lattice's default model. */
  assistantModel?: string
}

export interface ChannelsAdmin {
  status(): Promise<ChannelsAdminStatus>
  setAssistantModel(model?: string): Promise<ChannelsAdminStatus>
}

declare global {
  interface Window {
    lattice: LatticeApi & {
      onPush(fn: (event: PushEvent) => void): () => void
      remote: RemoteAdmin
      channels: ChannelsAdmin
    }
  }
}

export {}
