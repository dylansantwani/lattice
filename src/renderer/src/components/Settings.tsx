import React, { useEffect, useState } from 'react'
import { useStore } from '@/state/store'
import { ulid } from '@shared/id'
import {
  DEFAULT_SETTINGS,
  type AppSettings,
  type CostRates,
  type McpServerConfig,
  type ProviderConfig,
  type ProviderProbe
} from '@shared/types'
import { EFFORT_LABELS } from './effort'
import { I } from './Icon'

type Tab = 'general' | 'model' | 'conversation' | 'appearance' | 'providers' | 'pricing' | 'mcp' | 'remote'

const TABS: { key: Tab; label: string; icon: string }[] = [
  { key: 'general', label: 'General', icon: 'tune' },
  { key: 'model', label: 'Model', icon: 'neurology' },
  { key: 'conversation', label: 'Conversation', icon: 'forum' },
  { key: 'appearance', label: 'Appearance', icon: 'palette' },
  { key: 'providers', label: 'Providers', icon: 'cloud' },
  { key: 'pricing', label: 'Pricing', icon: 'paid' },
  { key: 'mcp', label: 'MCP servers', icon: 'extension' },
  { key: 'remote', label: 'Remote access', icon: 'smartphone' }
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
          {tab === 'pricing' && <PricingTab settings={settings} />}
          {tab === 'mcp' && <McpSection />}
          {tab === 'remote' && <RemoteTab settings={settings} set={set} />}

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
            title="Open the model picker — pin a model there (the pin button) to make it the default; the star marks favorites"
          >
            Choose…
          </button>
        </div>
      </Field>

      <SubagentModelsField settings={settings} onClose={onClose} />

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

      <h4 className="settings-h">Notifications</h4>
      <Field
        title="Notify me about"
        hint="A toast in the app, a system notification when Lattice is in the background, and a sound. Failures are a run error or a failed job/subagent; attention is an approval or a question waiting on you."
      >
        <select
          value={settings.notifications ?? 'attention'}
          onChange={(e) => set('notifications', e.target.value as AppSettings['notifications'])}
        >
          <option value="off">Nothing</option>
          <option value="failures">Failures only</option>
          <option value="attention">Failures and things that need me</option>
          <option value="all">Everything, including finished runs</option>
        </select>
      </Field>
      <Check
        checked={settings.notificationSound ?? true}
        onChange={(v) => set('notificationSound', v)}
        label="Play the alert sound"
      />
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
      <p className="settings-lede">The orbit gauge tracks how full the context is; these set where it auto-compacts and where it hard-stops new turns.</p>

      <Check
        checked={settings.autoCompact}
        onChange={(v) => set('autoCompact', v)}
        label="Auto-compact — summarize old history automatically once the context passes the compaction threshold"
      />
      <ThresholdField
        title="Compaction threshold"
        hint={settings.autoCompact
          ? 'Auto-compact the conversation once the context passes this fill (the current turn is kept intact).'
          : 'Tint the orbit gauge once the context passes this fill (auto-compact is off — compact manually with /compact).'}
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

      <h4 className="settings-h">Stale tool results</h4>
      <p className="settings-lede">Old tool output — a big file read or command dump from many turns ago — is the largest, least-useful bulk in a long conversation. Pruning replaces those far-back result bodies with a short placeholder (the model can re-run the tool if it needs them again), reclaiming context. The most recent tool results are always kept in full.</p>
      <Check
        checked={settings.pruneToolResults}
        onChange={(v) => set('pruneToolResults', v)}
        label="Prune stale tool results to save context (recent results stay intact)"
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

      <h4 className="settings-h">Endpoint failures</h4>
      <p className="settings-lede">
        When a model request fails transiently — the endpoint rate-limits you, returns a 5xx, or the
        connection drops mid-stream — automatically redo the round instead of surfacing the error.
        Backoff is exponential with jitter and honors a <code>Retry-After</code> the endpoint sends;
        a mid-stream drop restarts the round cleanly. 0 disables auto-retry — a failure surfaces at
        once, and permanent errors (bad auth, an over-long prompt) always surface immediately.
      </p>
      <Field title="Auto-retry attempts" hint="Redo a failed round up to this many times before giving up.">
        <input
          type="number"
          min={0}
          step={1}
          value={settings.maxEndpointRetries}
          onChange={(e) => set('maxEndpointRetries', Math.max(0, Math.floor(Number(e.target.value) || 0)))}
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

/** Per-provider probe state for the status line: undefined = never checked, else last result + in-flight. */
type ProbeState = ProviderProbe & { loading?: boolean }

/** One-line reachability status under a provider row: checking / ✓ N models / ✗ reason / disabled. */
function ProviderStatus({ enabled, state }: { enabled: boolean; state?: ProbeState }): React.JSX.Element | null {
  if (!enabled) return <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>Disabled</div>
  if (!state || state.loading)
    return <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>Checking…</div>
  if (state.ok)
    return (
      <div style={{ fontSize: 11.5, color: 'var(--good, #3fb950)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4 }}>
        <I name="check_circle" size={12} />
        {state.count} model{state.count === 1 ? '' : 's'}
      </div>
    )
  return (
    <div
      style={{ fontSize: 11.5, color: 'var(--bad, #f85149)', marginTop: 2, display: 'flex', alignItems: 'center', gap: 4, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      title={state.error}
    >
      <I name="error" size={12} />
      Couldn&rsquo;t reach — {state.error ?? 'unknown error'}
    </div>
  )
}

function ProvidersTab({ settings }: { settings: AppSettings }): React.JSX.Element {
  const saveSettings = useStore((s) => s.saveSettings)
  const reloadModels = useStore((s) => s.reloadModels)
  // null = nothing being edited; 'new' = the add form; otherwise the id of the provider being edited.
  const [editing, setEditing] = useState<string | null>(settings.providers.length === 0 ? 'new' : null)
  const [status, setStatus] = useState<Record<string, ProbeState>>({})

  // Live-probe one provider's /v1/models. A successful probe warms the main-process cache, so we then
  // reload the picker's model list — the reason to refetch is almost always "make my new models show up".
  const check = async (id: string): Promise<void> => {
    setStatus((s) => ({ ...s, [id]: { ...(s[id] ?? { ok: false, count: 0 }), loading: true } }))
    const res = await window.lattice.checkProvider(id).catch(
      (e): ProviderProbe => ({ ok: false, count: 0, error: e instanceof Error ? e.message : String(e) })
    )
    setStatus((s) => ({ ...s, [id]: { ...res, loading: false } }))
    if (res.ok) void reloadModels()
  }

  const checkAll = (): void => {
    for (const p of settings.providers) if (p.enabled) void check(p.id)
  }

  // Probe every enabled provider once when the tab opens, so status is populated without a click.
  // Keyed on the set of enabled provider ids so adding/enabling one re-probes just as expected.
  const enabledKey = settings.providers.filter((p) => p.enabled).map((p) => p.id).join(',')
  useEffect(() => {
    for (const p of settings.providers) if (p.enabled) void check(p.id)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabledKey])

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
          <div style={{ display: 'flex', gap: 8 }}>
            {settings.providers.some((p) => p.enabled) && (
              <button className="btn" onClick={checkAll} title="Re-probe every enabled provider and refresh the model list">
                Refetch all
              </button>
            )}
            <button className="btn" onClick={() => setEditing('new')}>Add provider</button>
          </div>
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
              <ProviderStatus enabled={p.enabled} state={status[p.id]} />
            </div>
            <label className="check-row inline" style={{ margin: 0 }}>
              <input type="checkbox" checked={p.enabled} onChange={(e) => toggle(p.id, e.target.checked)} />
              <span>Enabled</span>
            </label>
            <button
              className="btn"
              onClick={() => void check(p.id)}
              disabled={!p.enabled || status[p.id]?.loading}
              title={p.enabled ? 'Re-probe /v1/models and refresh the model list' : 'Enable the provider to fetch its models'}
            >
              {status[p.id]?.loading ? 'Checking…' : 'Refetch'}
            </button>
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

// ------------------------------------------------------------------------------------ Pricing

/**
 * The models a main model may run subagents on. Its own model is always allowed; this list adds
 * the others. Mirrors the picker's robot toggle (both write `settings.subagentModels`), with an
 * inline add-by-select so the choice is discoverable without opening the picker.
 */
function SubagentModelsField({ settings, onClose }: { settings: AppSettings; onClose: () => void }): React.JSX.Element {
  const models = useStore((s) => s.models)
  const setUi = useStore((s) => s.setUi)
  const toggleSubagentModel = useStore((s) => s.toggleSubagentModel)
  const [pick, setPick] = useState('')
  const designated = settings.subagentModels ?? []
  const nameOf = (id: string): string => models.find((m) => m.id === id)?.name ?? id
  const candidates = models.filter((m) => !designated.includes(m.id))

  return (
    <Field
      title="Subagent models"
      hint="Models your main model may run subagents on, alongside its own. It sees this list and picks per task."
    >
      <div className="subagent-models">
        {designated.length === 0 && (
          <div className="subagent-models-empty">
            None yet — subagents run on the main model. Add a cheaper or faster model for bounded work.
          </div>
        )}
        {designated.map((id) => (
          <div key={id} className="subagent-models-row" title={id}>
            <I name="smart_toy" size={14} />
            <span className="subagent-models-name">{nameOf(id)}</span>
            <span className="subagent-models-id">{id}</span>
            <button className="btn" onClick={() => void toggleSubagentModel(id)} aria-label={`Remove ${nameOf(id)} from subagent models`}>
              Remove
            </button>
          </div>
        ))}
        <div className="subagent-models-add">
          <select value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Model to add as a subagent model">
            <option value="">Add a model…</option>
            {candidates.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!pick}
            onClick={() => {
              if (!pick) return
              void toggleSubagentModel(pick)
              setPick('')
            }}
          >
            Add
          </button>
          <button
            className="btn"
            onClick={() => {
              onClose()
              setUi({ modelPickerOpen: true })
            }}
            title="Open the model picker — the robot toggle on any row marks it as a subagent model"
          >
            Pick in picker…
          </button>
        </div>
      </div>
    </Field>
  )
}

/** A compact "in $x · cached $y · out $z · reason $w" summary of an override's rates. */
function rateSummary(r: CostRates): string {
  const f = (n: number | undefined): string => (n === undefined ? '—' : `$${Number(n.toFixed(6))}`)
  return `in ${f(r.inputPerMTok)} · cached ${f(r.cachedInputPerMTok ?? r.inputPerMTok)} · out ${f(r.outputPerMTok)} · reason ${f(r.reasoningPerMTok ?? r.outputPerMTok)} /1M`
}

function PricingTab({ settings }: { settings: AppSettings }): React.JSX.Element {
  const models = useStore((s) => s.models)
  const setUi = useStore((s) => s.setUi)
  const saveSettings = useStore((s) => s.saveSettings)
  const [pick, setPick] = useState('')

  const overrides = settings.costOverrides ?? {}
  const entries = Object.entries(overrides)
  const nameOf = (id: string): string => models.find((m) => m.id === id)?.name ?? id
  const edit = (modelId: string): void => setUi({ costEditorModel: modelId })
  const removeOverride = (modelId: string): void => {
    const next = { ...overrides }
    delete next[modelId]
    void saveSettings({ costOverrides: next })
  }

  return (
    <section className="settings-panel">
      <h4 className="settings-h">Cost overrides ({entries.length})</h4>
      <p className="settings-lede">
        Set your own rates (USD per million tokens) for a route — input, cached input, output, and
        reasoning. Overrides price turns on routes the provider doesn&rsquo;t bill for, and replace the
        coarse list-price estimate with an <strong>exact</strong> figure. You can
        also open this editor by clicking any estimated cost in the Run inspector or the Usage page.
      </p>

      {entries.length === 0 && <p style={{ fontSize: 13, color: 'var(--text-faint)' }}>No overrides yet.</p>}

      {entries.map(([id, r]) => (
        <div
          key={id}
          style={{
            display: 'flex', alignItems: 'center', gap: 10, padding: '9px 12px', marginBottom: 6,
            background: 'var(--raised)', border: '1px solid var(--hairline)', borderRadius: 8
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {nameOf(id)}
            </div>
            <div style={{ fontSize: 11.5, color: 'var(--text-faint)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {rateSummary(r)}
            </div>
          </div>
          <button className="btn" onClick={() => edit(id)}>Edit</button>
          <button className="btn" onClick={() => removeOverride(id)}>Remove</button>
        </div>
      ))}

      <Field title="Add a route" hint="Pick a model to set custom rates for.">
        <div style={{ display: 'flex', gap: 8 }}>
          <select value={pick} onChange={(e) => setPick(e.target.value)}>
            <option value="">Choose a model…</option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            className="btn"
            disabled={!pick}
            onClick={() => {
              if (pick) {
                edit(pick)
                setPick('')
              }
            }}
          >
            Set rates
          </button>
        </div>
      </Field>
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

// ---------------------------------------------------------------------------------- Remote access

interface RemoteStatus {
  running: boolean
  port: number
  subscribers: number
  hasPassword: boolean
  settings: AppSettings['remoteAccess']
}
interface RemoteDevice {
  id: string
  device: string
  createdAt: number
  lastSeenAt: number
  expiresAt: number
}

/**
 * Remote access (the Lattice iOS app). Toggles the loopback bridge, sets the shared password, and
 * shows the public URL to point a phone at plus the authorized devices. Password and tokens never
 * live in AppSettings — this talks to the renderer-only `window.lattice.remote` admin channel.
 */
function RemoteTab({ settings, set }: { settings: AppSettings; set: SetFn }): React.JSX.Element {
  const flash = useStore((s) => s.flash)
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [devices, setDevices] = useState<RemoteDevice[]>([])
  const [pw, setPw] = useState('')
  const [port, setPort] = useState(String(settings.remoteAccess.port))
  const [url, setUrl] = useState(settings.remoteAccess.publicUrl ?? '')

  const refresh = async (): Promise<void> => {
    const s = (await window.lattice.remote.status()) as RemoteStatus
    setStatus(s)
    setDevices((await window.lattice.remote.listDevices()) as RemoteDevice[])
  }
  useEffect(() => {
    void refresh()
    const t = setInterval(refresh, 4000) // keep subscriber/running state live
    return () => clearInterval(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggle = async (enabled: boolean): Promise<void> => {
    if (enabled && !(status?.hasPassword ?? false)) {
      flash('Set a password before enabling remote access', 'warn')
      return
    }
    await window.lattice.remote.setEnabled(enabled)
    set('remoteAccess', { ...settings.remoteAccess, enabled })
    await refresh()
  }

  const savePassword = async (): Promise<void> => {
    await window.lattice.remote.setPassword(pw)
    setPw('')
    flash(pw ? 'Remote password set' : 'Remote password cleared')
    await refresh()
  }

  const saveConfig = async (): Promise<void> => {
    const p = parseInt(port, 10)
    await window.lattice.remote.setConfig({ port: Number.isFinite(p) ? p : undefined, publicUrl: url })
    set('remoteAccess', { ...settings.remoteAccess, port: Number.isFinite(p) ? p : settings.remoteAccess.port, publicUrl: url })
    flash('Remote config saved')
    await refresh()
  }

  const running = status?.running ?? false
  return (
    <section className="settings-panel">
      <h4 className="settings-h">Remote access (iOS app)</h4>
      <p className="settings-lede">
        Expose this desktop runtime to the Lattice iOS app over an authenticated bridge — the same chats, models,
        and live runs, reachable from your phone. The bridge binds <code>127.0.0.1</code> only; a Cloudflare tunnel
        publishes it at your public URL. Nothing is reachable until you set a password and enable it.
      </p>

      <Field title="Status" hint={running ? `Listening on 127.0.0.1:${status?.port} · ${status?.subscribers ?? 0} device(s) connected` : 'Bridge stopped'}>
        <span className={`pill ${running ? 'ok' : ''}`} style={{ padding: '2px 10px', borderRadius: 8 }}>
          {running ? 'Running' : 'Stopped'}
        </span>
      </Field>

      <Check
        checked={settings.remoteAccess.enabled}
        onChange={(v) => void toggle(v)}
        label="Enable remote access bridge"
      />

      <h4 className="settings-h" style={{ marginTop: 18 }}>Password</h4>
      <p className="settings-lede">
        {status?.hasPassword ? 'A password is set. Enter a new one to replace it, or clear it to revoke all access.' : 'No password set yet — required before the bridge will accept any connection.'}
      </p>
      <div className="row" style={{ gap: 8 }}>
        <input
          type="password"
          className="input"
          placeholder={status?.hasPassword ? 'New password' : 'Set a password'}
          value={pw}
          onChange={(e) => setPw(e.target.value)}
          style={{ flex: 1 }}
        />
        <button className="btn" onClick={() => void savePassword()} disabled={!pw && !status?.hasPassword}>
          {pw ? 'Save' : 'Clear'}
        </button>
      </div>

      <h4 className="settings-h" style={{ marginTop: 18 }}>Endpoint</h4>
      <Field title="Public URL" hint="Where your phone connects (the Cloudflare tunnel hostname).">
        <input className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://vmcontroller.pulse-core.com" style={{ width: 260 }} />
      </Field>
      <Field title="Local port" hint="Loopback port the bridge listens on; the tunnel forwards to it.">
        <input className="input" value={port} onChange={(e) => setPort(e.target.value)} style={{ width: 90 }} />
      </Field>
      <div className="row" style={{ justifyContent: 'flex-end' }}>
        <button className="btn" onClick={() => void saveConfig()}>Save endpoint</button>
      </div>

      <h4 className="settings-h" style={{ marginTop: 18 }}>Authorized devices ({devices.length})</h4>
      {devices.length === 0 ? (
        <p className="settings-lede">No devices have signed in yet.</p>
      ) : (
        <div className="col" style={{ gap: 6 }}>
          {devices.map((d) => (
            <div key={d.id} className="row" style={{ justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
              <div className="col" style={{ gap: 0 }}>
                <span className="set-title">{d.device}</span>
                <span className="set-hint">last seen {new Date(d.lastSeenAt).toLocaleString()} · expires {new Date(d.expiresAt).toLocaleDateString()}</span>
              </div>
              <button
                className="btn danger"
                onClick={async () => {
                  setDevices((await window.lattice.remote.revokeDevice(d.id)) as RemoteDevice[])
                }}
              >
                Revoke
              </button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
