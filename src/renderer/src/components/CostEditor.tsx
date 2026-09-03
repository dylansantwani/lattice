import React, { useEffect, useState } from 'react'
import { useStore } from '@/state/store'
import type { CostRates } from '@shared/types'
import { prefillRates } from '@shared/cost'
import { I } from './Icon'

/**
 * Editor for a route's cost override. Opened from any "estimated cost" surface (the Run inspector's
 * cost tile, the Usage page's per-model breakdown, or Settings → Pricing) via
 * `setUi({ costEditorModel })`. It pre-fills the four per-million-token rates from the current
 * override, else the model's list price (cached ← input, reasoning ← output — the same coarse
 * assumption the list-price estimate already makes), so saving without edits simply promotes the
 * estimate to an exact figure. The user can then refine any of the four dimensions.
 */
export function CostEditor(): React.JSX.Element | null {
  const modelId = useStore((s) => s.ui.costEditorModel)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const saveSettings = useStore((s) => s.saveSettings)
  const setUi = useStore((s) => s.setUi)

  const close = (): void => setUi({ costEditorModel: null })

  const overrides = settings?.costOverrides
  const model = models.find((m) => m.id === modelId)
  const hasOverride = !!(modelId && overrides?.[modelId])

  // String-backed field state so the user can clear a field mid-edit; re-seeded whenever the target
  // route changes (opening the editor for a different model).
  const [fields, setFields] = useState({ input: '', cached: '', output: '', reasoning: '' })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    setSaving(false)
    setSaveError(null)
    if (!modelId) return
    const p = prefillRates(modelId, models, overrides)
    setFields({
      input: fmtRate(p.inputPerMTok),
      cached: fmtRate(p.cachedInputPerMTok ?? p.inputPerMTok),
      output: fmtRate(p.outputPerMTok),
      reasoning: fmtRate(p.reasoningPerMTok ?? p.outputPerMTok)
    })
    // Only re-seed on target change, not on every keystroke-driven override write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId])

  useEffect(() => {
    if (!modelId) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        close()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modelId, fields, saving])

  if (!modelId || !settings) return null

  const preview = parseRate(fields.input) + parseRate(fields.cached) + parseRate(fields.output) + parseRate(fields.reasoning)

  const save = async (): Promise<void> => {
    if (saving || preview <= 0) return
    const rates: CostRates = {
      inputPerMTok: parseRate(fields.input),
      cachedInputPerMTok: parseRate(fields.cached),
      outputPerMTok: parseRate(fields.output),
      reasoningPerMTok: parseRate(fields.reasoning)
    }
    setSaving(true)
    setSaveError(null)
    try {
      await saveSettings({ costOverrides: { ...settings.costOverrides, [modelId]: rates } })
      close()
    } catch {
      setSaving(false)
      setSaveError('Could not save these rates. Try again.')
    }
  }

  const removeOverride = async (): Promise<void> => {
    if (saving) return
    const next = { ...settings.costOverrides }
    delete next[modelId]
    setSaving(true)
    setSaveError(null)
    try {
      await saveSettings({ costOverrides: next })
      close()
    } catch {
      setSaving(false)
      setSaveError('Could not remove this override. Try again.')
    }
  }

  const hasListPrice = !!model?.pricing

  return (
    <div
      className="overlay cost-editor-overlay"
      onMouseDown={(e) => e.target === e.currentTarget && close()}
    >
      <div className="modal cost-editor" role="dialog" aria-label="Edit cost model">
        <div className="cost-editor-head">
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <I name="paid" size={18} />
            Cost model
          </h3>
          <button className="icon-btn" onClick={close} aria-label="Close cost editor">
            <I name="close" size={18} />
          </button>
        </div>

        <div className="cost-editor-model">
          <span className="cost-editor-model-name">{model?.name ?? modelId}</span>
          <span className="cost-editor-model-id">{modelId}</span>
        </div>

        <p className="settings-lede" style={{ marginTop: 4 }}>
          Rates in USD per million tokens. Used to price turns on this route when the provider
          doesn&rsquo;t report a billed cost — and a route with a saved override shows an{' '}
          <strong>exact</strong> cost instead of a list-price estimate.
          {hasListPrice
            ? ' Pre-filled from list price; adjust any field.'
            : ' No list price is known for this route, so these start at zero.'}
        </p>

        <RateField
          title="Input"
          hint="Fresh (non-cached) input tokens."
          value={fields.input}
          onChange={(v) => setFields((f) => ({ ...f, input: v }))}
          autoFocus
        />
        <RateField
          title="Cached input"
          hint="Input tokens read from or written to the prompt cache — often much cheaper."
          value={fields.cached}
          onChange={(v) => setFields((f) => ({ ...f, cached: v }))}
        />
        <RateField
          title="Output"
          hint="Completion tokens, excluding reasoning."
          value={fields.output}
          onChange={(v) => setFields((f) => ({ ...f, output: v }))}
        />
        <RateField
          title="Reasoning"
          hint="Thinking tokens, when billed separately from output."
          value={fields.reasoning}
          onChange={(v) => setFields((f) => ({ ...f, reasoning: v }))}
        />

        <div className="cost-editor-foot">
          <div className="cost-editor-foot-actions">
            {hasOverride && (
              <button className="btn" onClick={() => void removeOverride()} disabled={saving} title="Delete this override and fall back to list-price estimation">
                {hasListPrice ? 'Reset to list price' : 'Remove override'}
              </button>
            )}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn" onClick={close} disabled={saving}>
              Cancel
            </button>
            <button className="btn primary" onClick={() => void save()} disabled={preview <= 0 || saving} title={preview <= 0 ? 'Set at least one non-zero rate' : 'Save (⌘/Ctrl+Enter)'}>
              {saving ? 'Saving…' : 'Save override'}
            </button>
          </div>
        </div>
        {saveError && <div className="cost-editor-error">{saveError}</div>}
      </div>
    </div>
  )
}

function RateField({
  title,
  hint,
  value,
  onChange,
  autoFocus
}: {
  title: string
  hint: string
  value: string
  onChange: (v: string) => void
  autoFocus?: boolean
}): React.JSX.Element {
  return (
    <div className="set-field">
      <div className="set-copy">
        <span className="set-title">{title}</span>
        <span className="set-hint">{hint}</span>
      </div>
      <div className="set-control cost-rate-control">
        <span className="cost-rate-prefix">$</span>
        <input
          type="number"
          min={0}
          step="any"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoFocus={autoFocus}
          aria-label={`${title} price per million tokens in USD`}
        />
        <span className="cost-rate-suffix">/ 1M</span>
      </div>
    </div>
  )
}

/** Parse a field to a non-negative number; blank/garbage → 0. */
function parseRate(s: string): number {
  const n = Number(s)
  return Number.isFinite(n) && n > 0 ? n : 0
}

/** Render a stored rate into the input: trim trailing zeros but keep small values readable. */
function fmtRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return ''
  return String(Number(n.toFixed(6)))
}
