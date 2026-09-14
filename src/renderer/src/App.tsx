import React, { useEffect, useState } from 'react'
import { useStore, activeThread } from '@/state/store'
import { Sidebar } from '@/components/Sidebar'
import { Transcript } from '@/components/Transcript'
import { ApprovalBar } from '@/components/ApprovalBar'
import { AskBar } from '@/components/AskBar'
import { Composer } from '@/components/Composer'
import { ModelPicker } from '@/components/ModelPicker'
import { ModelSwitchWarning } from '@/components/ModelSwitchWarning'
import { Inspector } from '@/components/Inspector'
import { SideChat } from '@/components/SideChat'
import { SettingsModal } from '@/components/Settings'
import { UsagePage } from '@/components/UsagePage'
import { CostEditor } from '@/components/CostEditor'
import { Sessions } from '@/components/Sessions'
import { FleetScreen } from '@/components/Fleet'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toast } from '@/components/Toast'
import { I } from '@/components/Icon'
import { adjacentThreadId } from '@/threadNavigation'
import { useSpeechRuntime } from '@/speech/useSpeech'

export default function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const bootError = useStore((s) => s.bootError)
  const init = useStore((s) => s.init)
  const ui = useStore((s) => s.ui)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const thread = useStore((s) => activeThread(s))
  const sessionUnread = useStore((s) => s.sessionUnread)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  useSpeechRuntime()

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'graphite'
    document.documentElement.dataset.density = settings?.density ?? 'comfortable'
  }, [settings?.theme, settings?.density])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && !e.metaKey && !e.altKey && e.key === 'Tab') {
        e.preventDefault()
        const state = useStore.getState()
        const id = adjacentThreadId(
          state.threads,
          state.activeThreadId,
          e.shiftKey ? 'previous' : 'next'
        )
        if (id) void state.selectThread(id)
        return
      }
      if (!e.metaKey) return
      if (e.key === 'm') {
        e.preventDefault()
        const state = useStore.getState()
        if (state.ui.modelPickerOpen) setUi({ modelPickerOpen: false, modelPickerIntent: 'thread', modelPickerFocus: null })
        else state.openModelPicker()
      } else if (e.key === ',') {
        e.preventDefault()
        setUi({ settingsOpen: true })
      } else if (e.key === 'n') {
        e.preventDefault()
        void useStore.getState().newThread()
      } else if (e.key === 'i') {
        e.preventDefault()
        setUi({ inspectorOpen: !useStore.getState().ui.inspectorOpen })
      } else if (e.key === 'b') {
        e.preventDefault()
        setUi({ railCollapsed: !useStore.getState().ui.railCollapsed })
      } else if (e.key === 'u') {
        e.preventDefault()
        setUi({ usageOpen: !useStore.getState().ui.usageOpen })
      } else if (e.key === 'j') {
        e.preventDefault()
        setUi({ fleetOpen: !useStore.getState().ui.fleetOpen })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setUi])

  if (bootError) {
    return (
      <div className="shell" style={{ gridTemplateColumns: '1fr' }}>
        <div className="empty-state" style={{ padding: 32 }}>
          <div style={{ maxWidth: 520, textAlign: 'center' }}>
            <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 10 }}>
              Lattice couldn’t start
            </div>
            <div style={{ opacity: 0.8, lineHeight: 1.5 }}>{bootError}</div>
          </div>
        </div>
      </div>
    )
  }

  if (!ready) {
    return (
      <div className="shell" style={{ gridTemplateColumns: '1fr' }}>
        <div className="empty-state">
          <div>Loading…</div>
        </div>
      </div>
    )
  }

  const shellClass = `shell ${ui.railCollapsed ? 'rail-collapsed' : ''} ${
    ui.inspectorOpen ? '' : 'no-inspector'
  }`

  return (
    <>
      <div className={shellClass}>
        <div className="pane-clip rail-clip">
          <Sidebar />
        </div>
        <main className="center">
          <div className="pane-header">
            <div className="session-title">
              <button
                className="icon-btn"
                onClick={() => setUi({ railCollapsed: !ui.railCollapsed })}
                title="Toggle sidebar (⌘B)"
                aria-label="Toggle sidebar"
              >
                <I name={ui.railCollapsed ? 'left_panel_open' : 'left_panel_close'} size={18} />
              </button>
              <span className="v">{thread?.title ?? '—'}</span>
            </div>
            <div style={{ display: 'flex', gap: 4 }}>
              <button
                className="icon-btn"
                onClick={() => setSessionsOpen(true)}
                title="Sessions — what your other chats are doing, and their messages"
                aria-label={sessionUnread ? `Sessions (${sessionUnread} unread)` : 'Sessions'}
                style={{ position: 'relative' }}
              >
                <I name="forum" size={18} />
                {sessionUnread > 0 && (
                  <span
                    aria-hidden
                    style={{
                      position: 'absolute',
                      top: 2,
                      right: 2,
                      minWidth: 14,
                      height: 14,
                      padding: '0 3px',
                      borderRadius: 7,
                      background: 'var(--brass)',
                      color: '#1b1610', // fixed dark: reads on brass in both light and dark themes
                      fontSize: 9,
                      fontWeight: 700,
                      lineHeight: '14px',
                      textAlign: 'center'
                    }}
                  >
                    {sessionUnread > 9 ? '9+' : sessionUnread}
                  </span>
                )}
              </button>
              <button
                className="icon-btn"
                onClick={() => setUi({ fleetOpen: true })}
                title="Agent Fleet — your orchestrator and dedicated agents (⌘J)"
                aria-label="Agent Fleet"
              >
                <I name="hub" size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={() => setUi({ usageOpen: true })}
                title="Usage (⌘U)"
                aria-label="Usage"
              >
                <I name="bar_chart" size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={() => setUi({ settingsOpen: true })}
                title="Settings (⌘,)"
                aria-label="Settings"
              >
                <I name="settings" size={18} />
              </button>
              <button
                className="icon-btn"
                onClick={() => setUi({ inspectorOpen: !ui.inspectorOpen })}
                title="Toggle inspector (⌘I)"
                aria-label="Toggle inspector"
              >
                <I name={ui.inspectorOpen ? 'right_panel_close' : 'right_panel_open'} size={18} />
              </button>
            </div>
          </div>
          <ErrorBoundary label="the transcript">
            <Transcript />
          </ErrorBoundary>
          <AskBar />
          <ApprovalBar />
          <Composer />
        </main>
        <div className="pane-clip inspector-clip">
          <ErrorBoundary label="the inspector">
            <Inspector />
          </ErrorBoundary>
        </div>
        <ErrorBoundary label="the aside">
          <SideChat />
        </ErrorBoundary>
      </div>
      <ModelPicker />
      <ModelSwitchWarning />
      <SettingsModal />
      <UsagePage />
      <CostEditor />
      <Sessions open={sessionsOpen} onClose={() => setSessionsOpen(false)} />
      <FleetScreen />
      <Toast />
    </>
  )
}
