/**
 * Transcript lab entry. Mounts the real <Transcript/> on a thread read from the local DB (see
 * vite.harness.config.ts), inside a faithful copy of the app's center column, so the conversation UI
 * can be iterated on against genuine runs. A scrubber replays one run's events in order, with the
 * assistant message marked live, so every in-flight state (drafting, running, thinking, streaming)
 * is reachable without waiting on a model.
 */
import React, { useEffect, useMemo, useState } from 'react'
import ReactDOM from 'react-dom/client'
import '@fontsource-variable/instrument-sans'
import '@fontsource/ibm-plex-mono/400.css'
import '@fontsource/ibm-plex-mono/500.css'
import 'material-symbols/outlined.css'
import '@/theme/global.css'
import { useStore } from '@/state/store'
import { Transcript } from '@/components/Transcript'
import { DEFAULT_SETTINGS, type ChatMessage, type RunEvent, type ThreadMeta } from '@shared/types'

interface ThreadRow {
  id: string
  title: string
  model: string
  updatedAt: number
  messages: number
  toolCalls: number
  agentEvents: number
  errors: number
}
interface ThreadDump {
  thread: ThreadMeta
  messages: ChatMessage[]
  events: RunEvent[]
}

const params = new URLSearchParams(location.search)

function Lab(): React.JSX.Element {
  const [threads, setThreads] = useState<ThreadRow[]>([])
  const [threadId, setThreadId] = useState<string>(params.get('thread') ?? '')
  const [dump, setDump] = useState<ThreadDump | null>(null)
  const [theme, setTheme] = useState(params.get('theme') ?? 'graphite')
  const [width, setWidth] = useState(Number(params.get('width') ?? 1100))
  const [replayRun, setReplayRun] = useState<string>('')
  const [cursor, setCursor] = useState<number>(-1)
  // ?replay=<turn index, 1-based>&cursor=<event count> reproduces a live state from the URL.
  const urlReplay = Number(params.get('replay') ?? 0)
  const urlCursor = Number(params.get('cursor') ?? -1)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    void fetch('/api/threads')
      .then((r) => r.json())
      .then((rows: ThreadRow[]) => {
        setThreads(rows)
        if (!threadId && rows[0]) setThreadId(rows[0].id)
      })
      .catch((e) => setError(String(e)))
  }, [])

  useEffect(() => {
    if (!threadId) return
    setDump(null)
    setReplayRun('')
    setCursor(-1)
    void fetch(`/api/thread/${threadId}`)
      .then(async (r) => {
        if (!r.ok) throw new Error(await r.text())
        return r.json() as Promise<ThreadDump>
      })
      .then(setDump)
      .catch((e) => setError(String(e)))
    const u = new URL(location.href)
    u.searchParams.set('thread', threadId)
    history.replaceState(null, '', u)
  }, [threadId])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    document.documentElement.dataset.density = 'comfortable'
  }, [theme])

  const runIds = useMemo(() => {
    if (!dump) return []
    const seen: string[] = []
    for (const m of dump.messages) if (m.role === 'assistant' && m.runId && !seen.includes(m.runId)) seen.push(m.runId)
    return seen
  }, [dump])
  useEffect(() => {
    if (!dump || !urlReplay || !runIds[urlReplay - 1]) return
    setReplayRun(runIds[urlReplay - 1]!)
    setCursor(urlCursor >= 0 ? urlCursor : 0)
  }, [dump, runIds])

  const replayEvents = useMemo(
    () => (dump && replayRun ? dump.events.filter((e) => e.runId === replayRun).sort((a, b) => a.seq - b.seq) : []),
    [dump, replayRun]
  )

  // Push the (possibly replayed) thread into the real store the components read from.
  useEffect(() => {
    if (!dump) return
    let messages = dump.messages
    let events = dump.events
    if (replayRun && cursor >= 0) {
      const shown = replayEvents.slice(0, cursor)
      const text = shown
        .filter((e) => !e.agent && e.body.type === 'text.delta')
        .map((e) => (e.body as { text: string }).text)
        .join('')
      const idx = messages.findIndex((m) => m.role === 'assistant' && m.runId === replayRun)
      messages = messages.slice(0, idx + 1).map((m, i) =>
        i === idx ? { ...m, status: undefined, telemetry: undefined, text } : m
      )
      events = [...events.filter((e) => e.runId !== replayRun), ...shown]
    }
    useStore.setState({
      ready: true,
      threads: [{ ...dump.thread, running: !!(replayRun && cursor >= 0) }],
      activeThreadId: dump.thread.id,
      messages,
      events,
      settings: { ...DEFAULT_SETTINGS },
      models: []
    })
  }, [dump, replayRun, cursor, replayEvents])

  const current = threads.find((t) => t.id === threadId)
  return (
    <div className="lab">
      <div className="lab-bar">
        <select value={threadId} onChange={(e) => setThreadId(e.target.value)}>
          {threads.map((t) => (
            <option key={t.id} value={t.id}>
              {t.title.slice(0, 48)} · {t.toolCalls} calls{t.agentEvents ? ' · agents' : ''}
              {t.errors ? ` · ${t.errors} err` : ''} · {t.model.split('/').slice(-1)[0]}
            </option>
          ))}
        </select>
        <select value={theme} onChange={(e) => setTheme(e.target.value)}>
          {['graphite', 'midnight', 'paper', 'high-contrast'].map((t) => (
            <option key={t}>{t}</option>
          ))}
        </select>
        <label>
          width <input type="number" value={width} step={50} onChange={(e) => setWidth(Number(e.target.value))} />
        </label>
        <select value={replayRun} onChange={(e) => { setReplayRun(e.target.value); setCursor(0) }}>
          <option value="">settled (no replay)</option>
          {runIds.map((r, i) => (
            <option key={r} value={r}>
              replay turn {i + 1}
            </option>
          ))}
        </select>
        {replayRun && (
          <label className="lab-scrub">
            <input
              type="range"
              min={0}
              max={replayEvents.length}
              value={Math.max(0, cursor)}
              onChange={(e) => {
                const n = Number(e.target.value)
                setCursor(n)
                const u = new URL(location.href)
                u.searchParams.set('replay', String(runIds.indexOf(replayRun) + 1))
                u.searchParams.set('cursor', String(n))
                history.replaceState(null, '', u)
              }}
            />
            <span>
              {Math.max(0, cursor)}/{replayEvents.length}
              {cursor > 0 && replayEvents[cursor - 1] ? ` · ${replayEvents[cursor - 1]!.body.type}` : ''}
            </span>
          </label>
        )}
        {current && (
          <span className="lab-meta">
            {current.messages} msgs · {dump ? dump.events.length : '…'} events
          </span>
        )}
        {error && <span className="lab-err">{error}</span>}
      </div>
      <div className="shell rail-collapsed no-inspector lab-shell" style={{ width, gridTemplateColumns: '1fr' }}>
        <main className="center">
          <div className="pane-header">
            <div className="session-title">
              <span className="v">{dump?.thread.title ?? '—'}</span>
            </div>
          </div>
          {dump ? <Transcript /> : <div className="empty-state">Loading…</div>}
          <div className="lab-composer">Composer</div>
        </main>
      </div>
    </div>
  )
}

const style = document.createElement('style')
style.textContent = `
  .lab { height: 100%; display: flex; flex-direction: column; background: #000; }
  .lab-bar { display: flex; gap: 10px; align-items: center; padding: 6px 10px; background: #111; color: #aaa;
    font: 12px var(--font-mono); border-bottom: 1px solid #222; flex: none; }
  .lab-bar select, .lab-bar input { background: #1a1a1a; color: #ddd; border: 1px solid #333; border-radius: 4px; padding: 3px 6px; font: inherit; }
  .lab-bar input[type=number] { width: 70px; }
  .lab-scrub { display: flex; gap: 8px; align-items: center; flex: 1; }
  .lab-scrub input { flex: 1; }
  .lab-meta { margin-left: auto; color: #666; }
  .lab-err { color: #e98287; }
  .lab-shell { margin: 0 auto; height: 100%; min-height: 0; border-left: 1px solid #222; border-right: 1px solid #222; }
  .lab-composer { flex: none; margin: 8px 32px 16px; padding: 14px; border: 1px dashed var(--hairline-strong);
    border-radius: 12px; color: var(--text-faint); font-size: 13px; }
`
document.head.appendChild(style)

ReactDOM.createRoot(document.getElementById('root')!).render(<Lab />)
