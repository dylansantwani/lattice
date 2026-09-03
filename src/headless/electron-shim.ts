/**
 * A headless stand-in for the `electron` module.
 *
 * Lattice's main-process runtime (store, runManager, ipc, tools, mcp, notify, browserView) imports a
 * small handful of electron symbols. When the same runtime is bundled to run as a plain Node service
 * on a VM — the "full backend in the cloud" deployment — there is no Electron around it. The headless
 * build aliases `electron` to this module (see scripts/build-headless.mjs), providing exactly those
 * symbols with GUI-free behavior:
 *
 *   app                 → path/name/lifecycle, data dir from $LATTICE_DATA_DIR
 *   ipcMain             → handle() records handlers (harmless; remote clients use the HTTP bridge)
 *   BrowserWindow       → getAllWindows() = [] (push fan-out then reaches only the bridge WebSocket)
 *   Notification/shell  → no-op (no desktop notifications / no shell.openExternal on a server)
 *   WebContentsView     → stub so browserView.ts imports resolve; the embedded browser is disabled
 *                          headless (ensureView() returns null with zero windows, so it never
 *                          instantiates one)
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync } from 'node:fs'

type Listener = (...args: unknown[]) => void

function dataRoot(): string {
  const base = process.env.LATTICE_DATA_DIR || join(homedir(), '.lattice')
  try {
    mkdirSync(base, { recursive: true })
  } catch {
    /* best effort */
  }
  return base
}

const appEmitter = new Map<string, Listener[]>()

interface AppShim {
  getPath(name: string): string
  getName(): string
  getVersion(): string
  whenReady(): Promise<void>
  on(event: string, listener: Listener): AppShim
  emit(event: string, ...args: unknown[]): void
  quit(): void
  requestSingleInstanceLock(): boolean
  commandLine: { appendSwitch(): void }
}

export const app: AppShim = {
  getPath(name: string): string {
    // The runtime asks for 'userData' (db + marker files). Everything maps under the data root.
    const dir = name === 'userData' ? dataRoot() : join(dataRoot(), name)
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* best effort */
    }
    return dir
  },
  getName(): string {
    return 'Lattice'
  },
  getVersion(): string {
    return process.env.npm_package_version || '0.1.0'
  },
  whenReady(): Promise<void> {
    return Promise.resolve()
  },
  on(event: string, listener: Listener): typeof app {
    const list = appEmitter.get(event) ?? []
    list.push(listener)
    appEmitter.set(event, list)
    return app
  },
  emit(event: string, ...args: unknown[]): void {
    for (const l of appEmitter.get(event) ?? []) l(...args)
  },
  quit(): void {
    app.emit('before-quit')
    process.exit(0)
  },
  requestSingleInstanceLock(): boolean {
    return true
  },
  commandLine: { appendSwitch(): void {} }
}

const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>()
export const ipcMain = {
  handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcHandlers.set(channel, fn)
  },
  removeHandler(channel: string): void {
    ipcHandlers.delete(channel)
  },
  on(): void {},
  /** Not used by the bridge, but available for a local IPC-style caller if ever needed. */
  _handlers: ipcHandlers
}

/** Zero windows headless — push fan-out iterates this and finds nothing, so only the bridge sees events. */
export class BrowserWindow {
  static getAllWindows(): unknown[] {
    return []
  }
  static getFocusedWindow(): unknown {
    return null
  }
}

export class Notification {
  static isSupported(): boolean {
    return false
  }
  constructor(_opts?: unknown) {}
  show(): void {}
  on(): this {
    return this
  }
}

export const shell = {
  openExternal(): Promise<void> {
    return Promise.resolve()
  },
  beep(): void {}
}

/** Stub so browserView.ts's import resolves; never instantiated headless (no window to attach to). */
export class WebContentsView {
  constructor(_opts?: unknown) {
    throw new Error('embedded browser is not available in the headless backend')
  }
}

export const nativeImage = {
  createFromDataURL(): unknown {
    return {}
  },
  createFromPath(): unknown {
    return {}
  }
}

// A few modules import electron's default export shape; provide it too.
export default { app, ipcMain, BrowserWindow, Notification, shell, WebContentsView, nativeImage }
