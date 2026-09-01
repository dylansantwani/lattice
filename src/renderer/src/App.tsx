import React, { useEffect } from 'react'
import { useStore, activeThread } from '@/state/store'
import { Sidebar } from '@/components/Sidebar'
import { Transcript } from '@/components/Transcript'
import { Composer } from '@/components/Composer'
import { ModelPicker } from '@/components/ModelPicker'
import { Inspector } from '@/components/Inspector'
import { SettingsModal } from '@/components/Settings'

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
      if (e.metaKey && e.key === 'm') {
        e.preventDefault()
        setUi({ modelPickerOpen: !useStore.getState().ui.modelPickerOpen })
      } else if (e.metaKey && e.key === ',') {
        e.preventDefault()
        setUi({ settingsOpen: true })
      } else if (e.metaKey && e.key === 'n') {
        e.preventDefault()
        void useStore.getState().newThread()
      } else if (e.metaKey && e.key === 'i') {
        e.preventDefault()
        setUi({ inspectorOpen: !useStore.getState().ui.inspectorOpen })
      } else if (e.metaKey && e.key === 'b') {
        e.preventDefault()
        setUi({ railCollapsed: !useStore.getState().ui.railCollapsed })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setUi])

  if (!ready) {
    return (
      <div className="shell">
        <div className="titlebar">Lattice</div>
        <div className="empty-state">
          <div>Loading…</div>
        </div>
      </div>
    )
  }

  return (
    <div className="shell">
      <div className="titlebar">
        <button className="chip ghost" onClick={() => setUi({ railCollapsed: !ui.railCollapsed })} title="Toggle sidebar (⌘B)">
          ☰
        </button>
        <span style={{ fontWeight: 620, color: 'var(--text)' }}>{thread?.title ?? 'Lattice'}</span>
        <div style={{ flex: 1 }} />
        <button className="chip" onClick={() => setUi({ settingsOpen: true })} title="Settings (⌘,)">
          settings
        </button>
        <button
          className="chip"
          onClick={() => setUi({ inspectorOpen: !ui.inspectorOpen })}
          title="Toggle inspector (⌘I)"
        >
          inspector
        </button>
      </div>
      <div
        className={`body ${ui.inspectorOpen ? 'with-inspector' : ''} ${ui.railCollapsed ? 'rail-collapsed' : ''}`}
      >
        <Sidebar />
        <main className="center">
          <Transcript />
          <Composer />
        </main>
        {ui.inspectorOpen && <Inspector />}
      </div>
      <ModelPicker />
      <SettingsModal />
    </div>
  )
}
