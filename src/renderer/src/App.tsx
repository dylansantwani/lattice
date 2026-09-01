import React, { useEffect } from 'react'
import { useStore, activeThread } from '@/state/store'
import { Sidebar } from '@/components/Sidebar'
import { Transcript } from '@/components/Transcript'
import { ApprovalBar } from '@/components/ApprovalBar'
import { AskBar } from '@/components/AskBar'
import { Composer } from '@/components/Composer'
import { ModelPicker } from '@/components/ModelPicker'
import { Inspector } from '@/components/Inspector'
import { SettingsModal } from '@/components/Settings'
import { Toast } from '@/components/Toast'
import { I } from '@/components/Icon'

export default function App(): React.JSX.Element {
  const ready = useStore((s) => s.ready)
  const init = useStore((s) => s.init)
  const ui = useStore((s) => s.ui)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const thread = useStore((s) => activeThread(s))

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
          <Transcript />
          <AskBar />
          <ApprovalBar />
          <Composer />
        </main>
        <div className="pane-clip inspector-clip">
          <Inspector />
        </div>
      </div>
      <ModelPicker />
      <SettingsModal />
      <Toast />
    </>
  )
}
