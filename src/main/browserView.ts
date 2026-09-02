import { WebContentsView, BrowserWindow } from 'electron'
import type { BrowserState, BrowserBounds } from '@shared/types'

/**
 * A single isolated, embedded browser surface (Electron `WebContentsView`) the renderer overlays on
 * the Browser inspector tab. It lives in its OWN session partition with sandboxing on and no app
 * preload, so the page it loads is fully walled off from Lattice's renderer. The native view is
 * positioned in the window's content-DIP space; the renderer sends bounds already scaled by the page
 * zoom factor (see the Browser tab), since `setZoomFactor` does not affect a child WebContentsView.
 */

let view: WebContentsView | null = null
let visible = false
let onState: ((s: BrowserState) => void) | null = null

export function configureBrowser(cb: { onState: (s: BrowserState) => void }): void {
  onState = cb.onState
}

function stateOf(v: WebContentsView): BrowserState {
  const wc = v.webContents
  return {
    url: wc.getURL(),
    title: wc.getTitle(),
    canGoBack: wc.navigationHistory.canGoBack(),
    canGoForward: wc.navigationHistory.canGoForward(),
    loading: wc.isLoading()
  }
}

function emit(): void {
  if (view && !view.webContents.isDestroyed()) onState?.(stateOf(view))
}

function ensureView(): WebContentsView | null {
  if (view && !view.webContents.isDestroyed()) return view
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return null
  view = new WebContentsView({
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      partition: 'persist:lattice-browser'
    }
  })
  win.contentView.addChildView(view)
  view.setVisible(false)
  const wc = view.webContents
  // Links that would open a new window instead load in place — a single embedded surface.
  wc.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void wc.loadURL(url)
    return { action: 'deny' }
  })
  // Only web schemes may load in the embedded browser; block file:// and app-internal navigations.
  wc.on('will-navigate', (e, url) => {
    if (!/^(https?:|about:blank)/i.test(url)) e.preventDefault()
  })
  // Relay every navigation-state-changing event to the renderer's URL bar. The event names are a
  // heterogeneous union across webContents overloads, so bind a string-typed `on` to attach uniformly.
  const onWc = wc.on.bind(wc) as (event: string, listener: () => void) => void
  for (const ev of [
    'did-navigate',
    'did-navigate-in-page',
    'page-title-updated',
    'did-start-loading',
    'did-stop-loading',
    'did-finish-load',
    'did-fail-load'
  ]) {
    onWc(ev, () => emit())
  }
  return view
}

export function normalizeUrl(input: string): string | null {
  const s = input.trim()
  if (!s) return null
  if (/^https?:\/\//i.test(s)) return s
  if (/^about:blank$/i.test(s)) return s
  // A bare "example.com" or "example.com/path" → https; anything with a space is a search query.
  if (/^[^\s]+\.[^\s]+/.test(s) && !s.includes(' ')) return `https://${s}`
  return `https://duckduckgo.com/?q=${encodeURIComponent(s)}`
}

function roundBounds(b: BrowserBounds): BrowserBounds {
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(0, Math.round(b.width)),
    height: Math.max(0, Math.round(b.height))
  }
}

/** Show the browser at `bounds`, creating it (and loading a blank start page) on first use. */
export function browserAttach(bounds: BrowserBounds): BrowserState | null {
  const v = ensureView()
  if (!v) return null
  v.setBounds(roundBounds(bounds))
  v.setVisible(true)
  visible = true
  if (!v.webContents.getURL()) void v.webContents.loadURL('about:blank')
  return stateOf(v)
}

export function browserSetBounds(bounds: BrowserBounds): void {
  if (view && visible && !view.webContents.isDestroyed()) view.setBounds(roundBounds(bounds))
}

export function browserDetach(): void {
  view?.setVisible(false)
  visible = false
}

export function browserNavigate(url: string): void {
  const v = ensureView()
  const target = normalizeUrl(url)
  if (v && target) void v.webContents.loadURL(target)
}

export function browserBack(): void {
  if (view?.webContents.navigationHistory.canGoBack()) view.webContents.navigationHistory.goBack()
}
export function browserForward(): void {
  if (view?.webContents.navigationHistory.canGoForward()) view.webContents.navigationHistory.goForward()
}
export function browserReload(): void {
  view?.webContents.reload()
}
export function browserStop(): void {
  view?.webContents.stop()
}

export function destroyBrowser(): void {
  if (!view) return
  try {
    const win = BrowserWindow.getAllWindows()[0]
    win?.contentView.removeChildView(view)
    if (!view.webContents.isDestroyed()) view.webContents.close()
  } catch {
    // window already gone
  }
  view = null
  visible = false
}
