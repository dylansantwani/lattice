import React, { useState } from 'react'
import { useStore } from '@/state/store'
import { ulid } from '@shared/id'
import type { McpServerConfig } from '@shared/types'
import { I } from './Icon'

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.settingsOpen)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)

  const provider = settings?.providers[0]
  const [label, setLabel] = useState(provider?.label ?? 'OmniRoute')
  const [baseUrl, setBaseUrl] = useState(provider?.baseUrl ?? 'http://localhost:20128')
  const [apiKey, setApiKey] = useState(provider?.apiKey ?? '')
  const [caching, setCaching] = useState(provider?.promptCaching ?? true)

  React.useEffect(() => {
    if (open && provider) {
      setLabel(provider.label)
      setBaseUrl(provider.baseUrl)
      setApiKey(provider.apiKey)
      setCaching(provider.promptCaching ?? true)
    }
  }, [open, provider])

  if (!open || !settings) return null

  const saveProvider = (): void => {
    void saveSettings({
      providers: [
        {
          id: provider?.id ?? ulid(),
          label,
          kind: 'openai-compat',
          baseUrl,
          apiKey,
          enabled: true,
          promptCaching: caching
        }
      ]
    })
    setUi({ settingsOpen: false })
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setUi({ settingsOpen: false })}>
      <div className="modal">
        <h3>Settings</h3>

        <h4 className="settings-section">Provider</h4>
        <label>Label</label>
        <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
        <label>Base URL</label>
        <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
        <label>API key</label>
        <input type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} />
        <label className="check-row">
          <input type="checkbox" checked={caching} onChange={(e) => setCaching(e.target.checked)} />
          <span>Prompt caching — reuse the stable prefix across turns (raises cache hit rate)</span>
        </label>

        <h4 className="settings-section">Appearance</h4>
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

        <h4 className="settings-section">Runtime</h4>
        <div className="num-field">
          <span className="num-copy">
            <span className="num-title">Max tool rounds / turn</span>
            <span className="num-hint">Runaway-loop guard for a turn. 0 = no limit.</span>
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.maxToolRounds}
            onChange={(e) => void saveSettings({ maxToolRounds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })}
          />
        </div>
        <div className="num-field">
          <span className="num-copy">
            <span className="num-title">Max tool rounds / subagent</span>
            <span className="num-hint">Same guard, applied to each subagent loop. 0 = no limit.</span>
          </span>
          <input
            type="number"
            min={0}
            step={1}
            value={settings.maxSubagentToolRounds}
            onChange={(e) =>
              void saveSettings({ maxSubagentToolRounds: Math.max(0, Math.floor(Number(e.target.value) || 0)) })
            }
          />
        </div>

        <McpSection />

        <div className="row">
          <button className="btn" onClick={() => setUi({ settingsOpen: false })}>
            Cancel
          </button>
          <button className="btn primary" onClick={saveProvider}>
            Save provider
          </button>
        </div>
      </div>
    </div>
  )
}

function McpSection(): React.JSX.Element {
  const servers = useStore((s) => s.mcpServers)
  const [adding, setAdding] = useState(false)
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio')
  const [label, setLabel] = useState('')
  const [command, setCommand] = useState('')
  const [argsText, setArgsText] = useState('')
  const [url, setUrl] = useState('')

  const upsert = (config: McpServerConfig): void => {
    void window.lattice.upsertMcpServer(config)
  }

  const addServer = (): void => {
    if (!label.trim()) return
    const config: McpServerConfig = {
      id: ulid(),
      label: label.trim(),
      transport,
      enabled: true,
      ...(transport === 'stdio'
        ? { command: command.trim(), args: argsText.trim() ? argsText.trim().split(/\s+/) : [] }
        : { url: url.trim() })
    }
    upsert(config)
    setAdding(false)
    setLabel('')
    setCommand('')
    setArgsText('')
    setUrl('')
  }

  return (
    <>
      <h4 className="settings-section">
        MCP servers
        <button className="mini-add" onClick={() => setAdding((v) => !v)} title="Add MCP server">
          <I name={adding ? 'close' : 'add'} size={15} />
        </button>
      </h4>

      {servers.length === 0 && !adding && (
        <div className="mcp-empty">No MCP servers configured. Add one to expose its tools to models.</div>
      )}

      {servers.map(({ config, status }) => (
        <div className="mcp-row" key={config.id}>
          <div className="mcp-main">
            <span className={`mcp-dot ${status.connected ? 'up' : config.enabled ? 'err' : 'off'}`} />
            <div className="mcp-text">
              <div className="mcp-label">{config.label}</div>
              <div className="mcp-sub">
                {config.transport === 'http' ? config.url : `${config.command} ${(config.args ?? []).join(' ')}`.trim()}
              </div>
              <div className="mcp-status">
                {status.error
                  ? `error: ${status.error.slice(0, 60)}`
                  : status.connected
                    ? `connected · ${status.tools.length} tool${status.tools.length === 1 ? '' : 's'}`
                    : config.enabled
                      ? 'connecting…'
                      : 'disabled'}
              </div>
            </div>
          </div>
          <div className="mcp-actions">
            <button
              className={`mcp-toggle ${config.enabled ? 'on' : ''}`}
              onClick={() => upsert({ ...config, enabled: !config.enabled })}
              title={config.enabled ? 'Disable server' : 'Enable server'}
            >
              {config.enabled ? 'On' : 'Off'}
            </button>
            <button
              className="icon-btn"
              onClick={() => void window.lattice.deleteMcpServer(config.id)}
              title="Remove server"
            >
              <I name="delete" size={16} />
            </button>
          </div>
        </div>
      ))}

      {adding && (
        <div className="mcp-add-form">
          <label>Transport</label>
          <select value={transport} onChange={(e) => setTransport(e.target.value as 'stdio' | 'http')}>
            <option value="stdio">stdio (local command)</option>
            <option value="http">http (streamable)</option>
          </select>
          <label>Label</label>
          <input type="text" value={label} placeholder="e.g. Filesystem" onChange={(e) => setLabel(e.target.value)} />
          {transport === 'stdio' ? (
            <>
              <label>Command</label>
              <input type="text" value={command} placeholder="npx" onChange={(e) => setCommand(e.target.value)} />
              <label>Arguments</label>
              <input
                type="text"
                value={argsText}
                placeholder="-y @modelcontextprotocol/server-filesystem /path"
                onChange={(e) => setArgsText(e.target.value)}
              />
            </>
          ) : (
            <>
              <label>URL</label>
              <input type="text" value={url} placeholder="https://host/mcp" onChange={(e) => setUrl(e.target.value)} />
            </>
          )}
          <div className="row">
            <button className="btn" onClick={() => setAdding(false)}>
              Cancel
            </button>
            <button className="btn primary" onClick={addServer}>
              Add server
            </button>
          </div>
        </div>
      )}
    </>
  )
}
