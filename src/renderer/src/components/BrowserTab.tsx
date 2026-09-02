import React from 'react'
import { I } from './Icon'
import type { BrowserState } from '@shared/types'

/**
 * The embedded browser inspector. The actual page is a native Electron WebContentsView living in the
 * main process (see {@link module:browserView}); this component renders the chrome (URL bar + nav
 * buttons) and a host element whose on-screen rectangle the native view is positioned over. Because
 * the renderer is scaled with `setZoomFactor` but the native view is not, bounds are multiplied by
 * the live `--zoom` factor before being sent. The view is shown on mount and hidden on unmount.
 */
export function BrowserTab(): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [input, setInput] = React.useState('')
  const [state, setState] = React.useState<BrowserState | null>(null)
  const editingRef = React.useRef(false)

  // Coalesce bursts of bounds updates (scroll/resize) into one per frame.
  const rafRef = React.useRef<number | null>(null)
  const boundsOf = React.useCallback(() => {
    const el = hostRef.current
    if (!el) return null
    const zoom = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--zoom')) || 1
    const r = el.getBoundingClientRect()
    return { x: r.left * zoom, y: r.top * zoom, width: r.width * zoom, height: r.height * zoom }
  }, [])

  const syncBounds = React.useCallback(() => {
    if (rafRef.current !== null) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null
      const b = boundsOf()
      if (b) void window.lattice.browserSetBounds(b)
    })
  }, [boundsOf])

  React.useEffect(() => {
    const b = boundsOf()
    if (b)
      void window.lattice.browserAttach(b).then((s) => {
        if (s) {
          setState(s)
          if (!editingRef.current) setInput(s.url === 'about:blank' ? '' : s.url)
        }
      })

    const el = hostRef.current
    const ro = el ? new ResizeObserver(syncBounds) : null
    if (el && ro) ro.observe(el)
    window.addEventListener('resize', syncBounds)
    // Capture-phase scroll catches the inspector body scrolling the host.
    window.addEventListener('scroll', syncBounds, true)

    const unsub = window.lattice.onPush((ev) => {
      if (ev.kind === 'browser.state') {
        setState(ev.state)
        if (!editingRef.current) setInput(ev.state.url === 'about:blank' ? '' : ev.state.url)
      } else if (ev.kind === 'zoom.changed') {
        // --zoom updates in the store's handler; re-read it next frame.
        syncBounds()
      }
    })

    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current)
      ro?.disconnect()
      window.removeEventListener('resize', syncBounds)
      window.removeEventListener('scroll', syncBounds, true)
      unsub()
      void window.lattice.browserDetach()
    }
  }, [boundsOf, syncBounds])

  const go = (): void => {
    editingRef.current = false
    if (input.trim()) void window.lattice.browserNavigate(input)
  }

  return (
    <div className="browser-tab">
      <div className="browser-bar">
        <button className="browser-nav" disabled={!state?.canGoBack} onClick={() => void window.lattice.browserBack()} aria-label="Back">
          <I name="arrow_back" size={16} />
        </button>
        <button className="browser-nav" disabled={!state?.canGoForward} onClick={() => void window.lattice.browserForward()} aria-label="Forward">
          <I name="arrow_forward" size={16} />
        </button>
        <button
          className="browser-nav"
          onClick={() => (state?.loading ? window.lattice.browserStop() : window.lattice.browserReload())}
          aria-label={state?.loading ? 'Stop' : 'Reload'}
        >
          <I name={state?.loading ? 'close' : 'refresh'} size={16} />
        </button>
        <input
          className="browser-url"
          value={input}
          placeholder="Search or enter a URL…"
          spellCheck={false}
          onFocus={() => (editingRef.current = true)}
          onBlur={() => (editingRef.current = false)}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              go()
              e.currentTarget.blur()
            }
          }}
        />
      </div>
      {/* The native WebContentsView is positioned over this element by the main process. */}
      <div className="browser-host" ref={hostRef} />
      {state?.title && <div className="browser-title" title={state.url}>{state.title}</div>}
    </div>
  )
}
