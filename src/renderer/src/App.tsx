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
import { Inbox } from '@/components/Inbox'
import { ErrorBoundary } from '@/components/ErrorBoundary'
import { Toast } from '@/components/Toast'
import { I } from '@/components/Icon'

export default function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const ui = useStore((s) => s.ui)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const thread = useStore((s) => activeThread(s))
  const sessionUnread = useStore((s) => s.sessionUnread)
  const [inboxOpen, setInboxOpen] = useState(false)

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    document.documentElement.dataset.theme = settings?.theme ?? 'graphite'
    document.documentElement.dataset.density = settings?.density ?? 'comfortable'
  }, [settings?.theme, settings?.density])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!e.metaKey) return
      if (e.key === 'm') {
        e.preventDefault()
        setUi({ modelPickerOpen: !useStore.getState().ui.modelPickerOpen })
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
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setUi])

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
                onClick={() => setInboxOpen(true)}
                title="Session messages"
                aria-label={sessionUnread ? `Session messages (${sessionUnread} unread)` : 'Session messages'}
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
      <Inbox open={inboxOpen} onClose={() => setInboxOpen(false)} />
      <Toast />
    </>
  )
}
