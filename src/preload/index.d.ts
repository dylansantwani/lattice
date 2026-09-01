import type { LatticeApi, PushEvent } from '../shared/ipc'

declare global {
  interface Window {
    lattice: LatticeApi & {
      onPush(fn: (event: PushEvent) => void): () => void
    }
  }
}

export {}
