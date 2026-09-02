import React from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'

/**
 * A live interactive terminal, backed by a real login-shell PTY in the main process (see
 * {@link module:ptyTerminal}). Keystrokes stream to the PTY; its output streams back over the
 * `pty.data` push channel into xterm.js. The PTY is created when this tab mounts and killed when it
 * unmounts, so leaving the Terminal tab tears the shell down.
 */
export function TerminalTab(): React.JSX.Element {
  const hostRef = React.useRef<HTMLDivElement>(null)
  const [exited, setExited] = React.useState<number | null>(null)
  const [reopenKey, setReopenKey] = React.useState(0)

  React.useEffect(() => {
    const el = hostRef.current
    if (!el) return
    setExited(null)
    let disposed = false
    let unsub = (): void => {}
    let createdId: string | null = null

    const cs = getComputedStyle(document.documentElement)
    const readVar = (name: string, fallback: string): string => cs.getPropertyValue(name).trim() || fallback

    const term = new Terminal({
      fontSize: 11,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: readVar('--panel', '#1b1d21'),
        foreground: readVar('--text', '#e6e6e6'),
        cursor: readVar('--brass', '#d5a45d')
      }
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(el)
    try {
      fit.fit()
    } catch {
      // container not measurable yet — the ResizeObserver below will fit once it is
    }

    void window.lattice.ptyCreate({ cols: term.cols, rows: term.rows }).then(({ id }) => {
      if (disposed) {
        void window.lattice.ptyKill(id)
        return
      }
      createdId = id
      unsub = window.lattice.onPush((ev) => {
        if (ev.kind === 'pty.data' && ev.id === id) term.write(ev.data)
        else if (ev.kind === 'pty.exit' && ev.id === id) setExited(ev.exitCode)
      })
      term.onData((d) => void window.lattice.ptyInput(id, d))
    })

    const ro = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        return
      }
      if (createdId) void window.lattice.ptyResize(createdId, term.cols, term.rows)
    })
    ro.observe(el)

    return () => {
      disposed = true
      ro.disconnect()
      unsub()
      if (createdId) void window.lattice.ptyKill(createdId)
      term.dispose()
    }
  }, [reopenKey])

  return (
    <div className="terminal-tab">
      <div className="terminal-host" ref={hostRef} />
      {exited !== null && (
        <div className="terminal-exited">
          <span className="files-note">Shell exited (code {exited}).</span>
          <button className="file-viewer-back" onClick={() => setReopenKey((k) => k + 1)}>
            Restart
          </button>
        </div>
      )}
    </div>
  )
}
