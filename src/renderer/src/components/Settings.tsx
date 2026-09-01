import React, { useEffect, useState } from 'react'
import { useStore } from '@/state/store'
import { ulid } from '@shared/id'
import { DEFAULT_SETTINGS, type AppSettings, type McpServerConfig, type ProviderConfig } from '@shared/types'
import { EFFORT_LABELS } from './effort'
import { I } from './Icon'

type Tab = 'general' | 'model' | 'conversation' | 'appearance' | 'providers' | 'mcp'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'general', label: 'General', icon: 'tune' },
  { key: 'model', label: 'Model', icon: 'neurology' },
  { key: 'conversation', label: 'Conversation', icon: 'forum' },
  { key: 'appearance', label: 'Appearance', icon: 'palette' },
  { key: 'providers', label: 'Providers', icon: 'cloud' },
  { key: 'mcp', label: 'MCP servers', icon: 'extension' }
]

/** Effort tiers offered as a default; the composer still narrows to what a given model supports. */
const EFFORT_CHOICES = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const

export function SettingsModal(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.settingsOpen)
  const setUi = useStore((s) => s.setUi)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const flash = useStore((s) => s.flash)
  const [tab, setTab] = useState<Tab>('general')

  useEffect(() => {
    if (open) setTab('general')
  }, [open])

  if (!open || !settings) return null

  const set = <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
    void saveSettings({ [key]: value } as Partial<AppSettings>)
  }

  const resetPreferences = (): void => {
    // Reset every preference to its default, but keep the configured providers (and their API
    // keys) — losing those would be a surprising, hard-to-undo side effect of "reset".
    const { providers: _providers, ...prefs } = DEFAULT_SETTINGS
    void saveSettings(prefs)
    flash('Preferences reset to defaults')
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && setUi({ settingsOpen: false })}>
      <div className="modal settings-modal" role="dialog" aria-label="Settings">
        <nav className="settings-nav" aria-label="Settings sections">
          <div className="settings-nav-title">Settings</div>
          {TABS.map((t) => (
            <button
              key={t.key}
              className={`settings-nav-item ${tab === t.key ? 'active' : ''}`}
              aria-current={tab === t.key}
              onClick={() => setTab(t.key)}
            >
              <I name={t.icon} size={17} />
              {t.label}
            </button>
          ))}
          <div className="settings-nav-spacer" />
          <button className="settings-nav-item reset" onClick={resetPreferences} title="Reset all preferences to their defaults (keeps your providers)">
            <I name="restart_alt" size={17} />
            Reset defaults
          </button>
        </nav>

        <div className="settings-body">
          {tab === 'general' && <GeneralTab settings={settings} set={set} onClose={() => setUi({ settingsOpen: false })} />}
          {tab === 'model' && <ModelTab settings={settings} set={set} />}
          {tab === 'conversation' && <ConversationTab settings={settings} set={set} />}
          {tab === 'appearance' && <AppearanceTab settings={settings} set={set} />}
          {tab === 'providers' && <ProvidersTab settings={settings} />}
          {tab === 'mcp' && <McpSection />}

          <div className="row settings-foot">
            <button className="btn primary" onClick={() => setUi({ settingsOpen: false })}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

type SetFn = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => void

/** A labelled control row: title + optional hint on the left, the control on the right. */
function Field({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="set-field">
      <div className="set-copy">
        <span className="set-title">{title}</span>
        {hint && <span className="set-hint">{hint}</span>}
      </div>
      <div className="set-control">{children}</div>
    </div>
  )
}

function Check({
  checked,
  onChange,
  label
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
}): React.JSX.Element {
  return (
    <label className="check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  )
}

// ---------------------------------------------------------------------------------- General

function GeneralTab({
  settings,
  set,
  onClose
}: {
  settings: AppSettings
  set: SetFn
  onClose: () => void
}): React.JSX.Element {
  const models = useStore((s) => s.models)
  const setUi = useStore((s) => s.setUi)
  const current = models.find((m) => m.id === settings.defaultModel)

  return (
    <section className="settings-panel">
      <h4 className="settings-h">Defaults for new threads</h4>
      <p className="settings-lede">These seed every new conversation. You can still change model, effort, mode, and permissions per thread from the composer.</p>

      <Field title="Default model" hint={current ? current.id : settings.defaultModel}>
        <div className="default-model">
          <span className="default-model-name">{current?.name ?? settings.defaultModel}</span>
          <button
            className="btn"
            onClick={() => {
              onClose()
              setUi({ modelPickerOpen: true })
            }}
            title="Open the model picker — star a model there to make it the default"
          >
            Choose…
          </button>
        </div>
      </Field>

      <Field title="Default effort" hint="Reasoning budget for models that support it.">
        <select value={settings.defaultEffort ?? ''} onChange={(e) => set('defaultEffort', e.target.value || undefined)}>
          <option value="">Auto (model default)</option>
          {EFFORT_CHOICES.map((t) => (
            <option key={t} value={t}>
              {EFFORT_LABELS[t] ?? t}
            </option>
          ))}
        </select>
      </Field>

      <Field title="Default mode" hint="Plan investigates, Act executes, Review inspects without editing.">
        <select value={settings.defaultMode} onChange={(e) => set('defaultMode', e.target.value as AppSettings['defaultMode'])}>
          <option value="plan">Plan</option>
          <option value="act">Act</option>
          <option value="review">Review</option>
        </select>
      </Field>

      <Field title="Default permissions" hint="How much a new thread may do before asking you.">
        <select
          value={settings.defaultPermissionPreset}
          onChange={(e) => set('defaultPermissionPreset', e.target.value as AppSettings['defaultPermissionPreset'])}
        >
          <option value="manual">Manual — ask before everything</option>
          <option value="workspace">Workspace — auto-allow inside your roots</option>
          <option value="full">Full — auto-allow everything</option>
        </select>
      </Field>

      <h4 className="settings-h">Composer</h4>
      <Field title="Send messages with" hint="⌘/Ctrl+Enter mode lets Enter insert newlines freely.">
        <select value={settings.sendKey} onChange={(e) => set('sendKey', e.target.value as AppSettings['sendKey'])}>
          <option value="enter">Enter (⌘/Ctrl+Enter queues)</option>
          <option value="mod-enter">⌘/Ctrl+Enter (Enter = newline)</option>
        </select>
      </Field>
    </section>
  )
}

// ------------------------------------------------------------------------------------ Model

function ModelTab({ settings, set }: { settings: AppSettings; set: SetFn }): React.JSX.Element {
  const [instructions, setInstructions] = useState(settings.customInstructions)
  useEffect(() => setInstructions(settings.customInstructions), [settings.customInstructions])

  const tempOn = settings.temperature !== null
  return (
    <section className="settings-panel">
      <h4 className="settings-h">Sampling</h4>
      <p className="settings-lede">Applied to every request — your main turns and subagents alike.</p>

      <Field title="Temperature" hint="Higher is more varied, lower more focused. Off uses the model's own default.">
        <div className="temp-control">
          <label className="check-row inline">
            <input
              type="checkbox"
              checked={tempOn}
              onChange={(e) => set('temperature', e.target.checked ? 0.7 : null)}
            />
            <span>{tempOn ? '' : 'Model default'}</span>
          </label>
          {tempOn && (
            <>
              <input
                type="range"
                min={0}
                max={2}
                step={0.05}
                value={settings.temperature ?? 0.7}
                onChange={(e) => set('temperature', Number(e.target.value))}
              />
              <span className="temp-readout">{(settings.temperature ?? 0.7).toFixed(2)}</span>
            </>
          )}
        </div>
      </Field>

      <Field title="Max output tokens" hint="Hard cap on a single response. 0 = the model/provider default.">
        <input
          type="number"
          min={0}
          step={256}
          value={settings.maxOutputTokens}
          onChange={(e) => set('maxOutputTokens', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
      </Field>

      <h4 className="settings-h">Standing instructions</h4>
      <p className="settings-lede">Appended to the system prompt on every turn — your persistent preferences, style, and rules.</p>
      <textarea
        className="set-textarea"
        value={instructions}
        placeholder="e.g. Prefer TypeScript. Keep explanations terse. Always run the tests before claiming done."
        rows={6}
        onChange={(e) => setInstructions(e.target.value)}
        onBlur={() => {
          if (instructions !== settings.customInstructions) set('customInstructions', instructions)
        }}
      />

      <h4 className="settings-h">Memory</h4>
      <Check
        checked={settings.includeMemory}
        onChange={(v) => set('includeMemory', v)}
        label="Memory recall — pinned memories ride in every prompt; the rest is fetched on demand via memory_search"
      />
      <Check
        checked={settings.selfLearning}
        onChange={(v) => set('selfLearning', v)}
        label="Self-learning — after each turn, distill durable facts & preferences from the conversation"
      />
      {settings.selfLearning && (
        <Check
          checked={settings.selfLearningAutoApprove}
          onChange={(v) => set('selfLearningAutoApprove', v)}
          label="Auto-approve confident learnings (inject them and share to Claude Code & Hermes without review)"
        />
      )}
    </section>
  )
}

// ----------------------------------------------------------------------------- Conversation

/** Percent slider (50–100) bound to a 0..1 threshold setting. */
function ThresholdField({
  title,
  hint,
  value,
  min,
  onChange
}: {
  title: string
  hint: string
  value: number
  min: number
  onChange: (v: number) => void
}): React.JSX.Element {
  return (
    <Field title={title} hint={hint}>
      <div className="temp-control">
        <input
          type="range"
          min={min}
          max={100}
          step={1}
          value={Math.round(value * 100)}
          onChange={(e) => onChange(Number(e.target.value) / 100)}
        />
        <span className="temp-readout">{Math.round(value * 100)}%</span>
      </div>
    </Field>
  )
}

function ConversationTab({ settings, set }: { settings: AppSettings; set: SetFn }): React.JSX.Element {
  return (
    <section className="settings-panel">
      <h4 className="settings-h">Context window</h4>
      <p className="settings-lede">The orbit gauge tracks how full the context is; these set where it warns and where it forces a compaction.</p>

      <ThresholdField
        title="Compaction threshold"
        hint="Suggest compacting the conversation once the context passes this fill."
        value={settings.compactionThreshold}
        min={50}
        onChange={(v) => set('compactionThreshold', v)}
      />
      <ThresholdField
        title="Block threshold"
        hint="Stop accepting new turns until you compact, once the context passes this fill."
        value={settings.blockThreshold}
        min={Math.max(60, Math.round(settings.compactionThreshold * 100))}
        onChange={(v) => set('blockThreshold', v)}
      />

      <h4 className="settings-h">Runaway-loop guards</h4>
      <p className="settings-lede">Cap how many tool rounds a single turn may take before it is cut off. 0 disables the cap — a legitimate long task is never truncated.</p>

      <Field title="Max tool rounds / turn" hint="Applies to your main turn loop.">
        <input
          type="number"
          min={0}
          step={1}
          value={settings.maxToolRounds}
          onChange={(e) => set('maxToolRounds', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
      </Field>
      <Field title="Max tool rounds / subagent" hint="Applies to each subagent loop.">
        <input
          type="number"
          min={0}
          step={1}
          value={settings.maxSubagentToolRounds}
          onChange={(e) => set('maxSubagentToolRounds', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
        />
      </Field>
    </section>
  )
}

// ------------------------------------------------------------------------------- Appearance

function AppearanceTab({ settings, set }: { settings: AppSettings; set: SetFn }): React.JSX.Element {
  return (
    <section className="settings-panel">
      <h4 className="settings-h">Appearance</h4>

      <Field title="Theme">
        <select value={settings.theme} onChange={(e) => set('theme', e.target.value as AppSettings['theme'])}>
          <option value="graphite">Graphite</option>
          <option value="midnight">Midnight</option>
          <option value="paper">Paper</option>
          <option value="high-contrast">High contrast</option>
        </select>
      </Field>

      <Field title="Density" hint="Spacing and sizing across the interface.">
        <select value={settings.density} onChange={(e) => set('density', e.target.value as AppSettings['density'])}>
          <option value="comfortable">Comfortable</option>
          <option value="compact">Compact</option>
          <option value="presentation">Presentation</option>
        </select>
      </Field>

      <Field title="Reasoning visibility" hint="How model thinking appears in the transcript.">
        <select
          value={settings.reasoningVisibility}
          onChange={(e) => set('reasoningVisibility', e.target.value as AppSettings['reasoningVisibility'])}
        >
          <option value="expanded">Expanded — show thinking by default</option>
          <option value="auto">Auto — collapsed, click to open</option>
          <option value="hidden">Hidden — never show thinking</option>
        </select>
      </Field>

      <h4 className="settings-h">Transcript</h4>
      <Check
        checked={settings.telemetryFooter}
        onChange={(v) => set('telemetryFooter', v)}
        label="Show the telemetry footer under each answer (tokens, timing, cost)"
      />
    </section>
  )
}

// -------------------------------------------------------------------------------- Providers

function ProvidersTab({ settings }: { settings: AppSettings }): React.JSX.Element {
  const saveSettings = useStore((s) => s.saveSettings)
  // null = nothing being edited; 'new' = the add form; otherwise the id of the provider being edited.
  const [editing, setEditing] = useState<string | null>(settings.providers.length === 0 ? 'new' : null)

  // Persist without closing the modal — provider management is multi-step (toggle several,
  // edit one after removing another); snapping Settings shut on every click made that impossible.
  const persist = (providers: ProviderConfig[]): void => {
    void saveSettings({ providers })
  }

  const upsert = (p: ProviderConfig): void => {
    const exists = settings.providers.some((existing) => existing.id === p.id)
    persist(exists ? settings.providers.map((existing) => (existing.id === p.id ? p : existing)) : [...settings.providers, p])
    setEditing(null)
  }

  const remove = (id: string): void => {
    const target = settings.providers.find((p) => p.id === id)
    const enabledLeft = settings.providers.filter((p) => p.enabled && p.id !== id).length
    if (
      target?.enabled &&
      enabledLeft === 0 &&
      !window.confirm(
        `Remove "${target.label}"? It is your only enabled provider — models and runs will be unavailable until you add another.`
      )
    )
      return
    persist(settings.providers.filter((p) => p.id !== id))
    if (editing === id) setEditing(null)
  }

  const toggle = (id: string, enabled: boolean): void => {
    persist(settings.providers.map((p) => (p.id === id ? { ...p, enabled } : p)))
  }

  return (
    <section className="settings-panel">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <h4 className="settings-h" style={{ margin: 0 }}>Providers ({settings.providers.length})</h4>
        {editing === null && (
          <button className="btn" onClick={() => setEditing('new')}>Add provider</button>
        )}
      </div>
      <p className="settings-lede">
        OpenAI-compatible endpoints (OmniRoute, OpenRouter, a local server…). Models from every enabled
        provider appear together in the picker; each request goes to the provider that serves its model
        (first provider wins when two expose the same id).
      </p>

      {settings.providers.map((p) =>
        editing === p.id ? (
          <ProviderForm key={p.id} initial={p} onSave={upsert} onCancel={() => setEditing(null)} />
        ) : (
          <div
            key={p.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', marginBottom: 6,
              background: 'var(--raised)', border: '1px solid var(--hairline)', borderRadius: 8
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 13 }}>{p.label}</div>
              <div style={{ fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {p.baseUrl}{p.promptCaching === false ? ' · caching off' : ' · caching on'}
              </div>
            </div>
            <label className="check-row inline" style={{ margin: 0 }}>
              <input type="checkbox" checked={p.enabled} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span>Enabled</span>
            </label>
            <button className="btn" onClick={() => setEditing(p.id)}>Edit</button>
            <button className="btn" onClick={() => remove(p.id)}>Remove</button>
          </div>
        )
      )}

      {editing === 'new' && (
        <ProviderForm
          onSave={upsert}
          onCancel={settings.providers.length > 0 ? () => setEditing(null) : undefined}
        />
      )}
    </section>
  )
}

function ProviderForm({
  initial,
  onSave,
  onCancel
}: {
  initial?: ProviderConfig
  onSave: (p: ProviderConfig) => void
  onCancel?: () => void
}): React.JSX.Element {
  const [label, setLabel] = useState(initial?.label ?? (initial ? '' : 'OmniRoute'))
  const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? 'http://localhost:20128')
  const [apiKey, setApiKey] = useState(initial?.apiKey ?? '')
  const [caching, setCaching] = useState(initial?.promptCaching ?? true)

  const save = (): void =>
    onSave({
      id: initial?.id ?? ulid(),
      label: label.trim() || baseUrl,
      kind: 'openai-compat',
      baseUrl: baseUrl.trim().replace(/\/$/, ''),
      apiKey,
      enabled: initial?.enabled ?? true,
      headers: initial?.headers,
      promptCaching: caching
    })

  return (
    <div style={{ padding: '10px 12px', marginBottom: 6, background: 'var(--raised)', border: '1px solid var(--hairline)', borderRadius: 8 }}>
      <label>Label</label>
      <input type="text" value={label} onChange={(e) => setLabel(e.target.value)} />
      <label>Base URL</label>
      <input type="text" value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
      <label>API key</label>
      <input type="password" value={apiKey} placeholder="sk-…" onChange={(e) => setApiKey(e.target.value)} />
      <label className="check-row">
        <input type="checkbox" checked={caching} onChange={(e) => setCaching(e.target.checked)} />
        <span>Prompt caching — reuse the stable prefix across turns (raises cache hit rate)</span>
      </label>
      <div className="row">
        <button className="btn primary" onClick={save} disabled={!baseUrl.trim()}>
          {initial ? 'Save changes' : 'Add provider'}
        </button>
        {onCancel && <button className="btn" onClick={onCancel}>Cancel</button>}
      </div>
    </div>
  )
}

// -------------------------------------------------------------------------------------- MCP

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
    <section className="settings-panel">
      <h4 className="settings-h mcp-tab-head">
        MCP servers
        <button className="mini-add" onClick={() => setAdding((v) => !v)} title="Add MCP server">
          <I name={adding ? 'close' : 'add'} size={15} />
        </button>
      </h4>
      <p className="settings-lede">Connect Model Context Protocol servers to expose their tools to every model.</p>

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
    </section>
  )
}
