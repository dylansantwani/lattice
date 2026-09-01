import { app, BrowserWindow, shell } from 'electron'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { registerIpc } from './ipc'
import { closeDb } from './store/db'
import { shutdownMcp } from './mcp/manager'
import { killAllBgJobs } from './tools/bgJobs'

const isDev = !!process.env.ELECTRON_RENDERER_URL

// dev-only: allow CDP-driven UI testing
if (isDev) app.commandLine.appendSwitch('remote-debugging-port', '9223')

// UI zoom. The interface reads a touch dense at 100%, so the app ships slightly zoomed OUT — smaller
// type, more breathing room, more visible at once. ⌘= / ⌘- adjust it, ⌘0 resets to 100%, and the
// choice persists in userData so it survives restarts.
const ZOOM_MIN = 0.6
const ZOOM_MAX = 1.4
const ZOOM_STEP = 0.05
const ZOOM_DEFAULT = 0.9
const zoomFile = (): string => join(app.getPath('userData'), 'zoom.json')
function loadZoom(): number {
  try {
    const v = (JSON.parse(readFileSync(zoomFile(), 'utf8')) as { zoom?: unknown }).zoom
    if (typeof v === 'number' && v >= ZOOM_MIN && v <= ZOOM_MAX) return v
  } catch {
    /* first run / unreadable — fall through to the default */
  }
  return ZOOM_DEFAULT
}
function saveZoom(z: number): void {
  try {
    writeFileSync(zoomFile(), JSON.stringify({ zoom: z }))
  } catch {
    /* persistence is a convenience, not load-bearing */
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1480,
    height: 940,
    minWidth: 760,
    minHeight: 560,
    title: 'Lattice',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 16, y: 16 },
    backgroundColor: '#121416',
    webPreferences: {
      preload: join(__dirname, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  })

  // Apply the saved zoom on every load (a reload/navigation resets the frame's zoom otherwise).
  let zoom = loadZoom()
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(zoom))
  // ⌘= zoom in, ⌘- zoom out, ⌘0 reset to 100%. Handled in-main so it works without an app menu.
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !(input.meta || input.control)) return
    let next: number | null = null
    if (input.key === '=' || input.key === '+') next = Math.min(ZOOM_MAX, zoom + ZOOM_STEP)
    else if (input.key === '-' || input.key === '_') next = Math.max(ZOOM_MIN, zoom - ZOOM_STEP)
    else if (input.key === '0') next = 1
    if (next === null) return
    event.preventDefault()
    zoom = Math.round(next * 100) / 100
    win.webContents.setZoomFactor(zoom)
    saveZoom(zoom)
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (ev, url) => {
    if (!url.startsWith(isDev ? process.env.ELECTRON_RENDERER_URL! : 'file://')) ev.preventDefault()
  })

  if (isDev) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL!)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  registerIpc()
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  void shutdownMcp()
  killAllBgJobs()
  closeDb()
})
