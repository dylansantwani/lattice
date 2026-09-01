import React, { useState } from 'react'
import { useStore } from '@/state/store'
import { ulid } from '@shared/id'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.settingsOpen)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)

  const provider = settings?.providers[0]
  const [label, setLabel] = useState(provider?.label ?? 'OmniRoute')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'http://localhost:20128')
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')

  React.useEffect(() => {
    if (open && provider) {
      setLabel(provider.label)
      setBaseUrl(provider.baseUrl)
      setApiKey(provider.apiKey)
    }
  }, [open, provider])

  if (!open || !settings) return null

  const save = (): void => {
    void saveSettings({
      providers: [
        {
          id: provider?.id ?? ulid(),
          label,
          kind: 'openai-compat',
          baseUrl,
          apiKey,
          enabled: true
        }
      ]
    })
    setUi({ settingsOpen: false })
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setUi({ settingsOpen: false })}>
      <div className="modal">
        <h3>Settings</h3>

        <h4 style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '0.05em', color: 'var(--text-faint)' }}>
          Provider
        </h4>
        <label>Label</label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        <label>Base URL</label>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <label>API key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />

        <label>Theme</label>
        <select
          value={settings.theme}
          onChange={(e) => void saveSettings({ theme: e.target.value as typeof settings.theme })}
        >
          <option value="graphite">Graphite</option>
          <option value="midnight">Midnight</option>
          <option value="paper">Paper</option>
          <option value="high-contrast">High contrast</option>
        </select>

        <label>Density</label>
        <select
          value={settings.density}
          onChange={(e) => void saveSettings({ density: e.target.value as typeof settings.density })}
        >
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
          <option value="presentation">Presentation</option>
        </select>

        <label>Reasoning visibility</label>
        <select
          value={settings.reasoningVisibility}
          onChange={(e) =>
            void saveSettings({ reasoningVisibility: e.target.value as typeof settings.reasoningVisibility })
          }
        >
          <option value="expanded">Expanded</option>
          <option value="auto">Auto</option>
          <option value="hidden">Hidden</option>
        </select>

        <div className="row">
          <button className="btn" onClick={() => setUi({ settingsOpen: false })}>
            Cancel
          </button>
          <button className="btn primary" onClick={save}>
            Save
          </button>
        </div>
      </div>
    </div>
  )
}
