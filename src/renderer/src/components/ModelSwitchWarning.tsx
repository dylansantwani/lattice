import React, { useEffect } from 'react'
import { useStore, activeThread } from '@/state/store'
import { computeModelSwitchInfo } from '@/state/modelSwitch'
import { fmtTokens } from './ContextOrbit'
import { I } from './Icon'

function fmtUsd(n: number): string {
  if (n < 0.01) return '<$0.01'
  return `$${n.toFixed(2)}`
}

/**
 * Confirmation gate for a mid-conversation model change. Switching models re-sends the whole
 * transcript to the new model — a fresh prompt cache and, on a priced route, real input cost —
 * so `store.setModel` parks the change here (`pendingModelSwitch`) and the user confirms after
 * seeing the context size and cost implications.
 */
export function ModelSwitchWarning(): React.JSX.Element | null {
  const pending = useStore((s) => s.pendingModelSwitch)
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const budget = useStore((s) => s.budget)
  const thread = useStore((s) => activeThread(s))
  const confirm = useStore((s) => s.confirmModelSwitch)
  const cancel = useStore((s) => s.cancelModelSwitch)

  useEffect(() => {
    if (!pending) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        cancel()
      } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
        e.preventDefault()
        void confirm()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [pending, cancel, confirm])

  if (!pending) return null

  const currentModel = thread?.model ?? ''
  const currentInfo = models.find((m) => m.id === currentModel)
  const target = models.find((m) => m.id === pending.model)
  const info = computeModelSwitchInfo({
    currentModel,
    currentName: currentInfo?.name,
    targetModel: pending.model,
    target,
    contextTokens: budget?.usedTokens ?? 0,
    models,
    overrides
  })

  const rowStyle: React.CSSProperties = {
    display: 'flex',
    justifyContent: 'space-between',
    gap: 12,
    padding: '7px 0',
    borderBottom: '1px solid var(--hairline)',
    fontSize: 13
  }
  const keyStyle: React.CSSProperties = { color: 'var(--text-faint)' }
  const valStyle: React.CSSProperties = { color: 'var(--text)', fontWeight: 550, textAlign: 'right' }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && cancel()}>
      <div className="modal" role="dialog" aria-label="Confirm model switch" style={{ width: 460 }}>
        <h3 style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <I name="swap_horiz" size={19} />
          Switch model mid-conversation?
        </h3>
        <p style={{ fontSize: 13, color: 'var(--text-dim)', lineHeight: 1.55, margin: '0 0 6px' }}>
          The whole conversation so far will be inserted into{' '}
          <strong style={{ color: 'var(--text)' }}>{info.targetName}</strong>. That starts a fresh
          prompt cache on the new model, so its first turn re-reads the entire context.
        </p>

        <div style={{ margin: '12px 0 2px' }}>
          <div style={rowStyle}>
            <span style={keyStyle}>From → To</span>
            <span style={valStyle}>
              {info.currentName} → {info.targetName}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={keyStyle}>Context to carry over</span>
            <span style={valStyle}>
              {fmtTokens(info.contextTokens)}
              {budget && !budget.exact ? ' (est.)' : ''}
            </span>
          </div>
          <div style={rowStyle}>
            <span style={keyStyle}>New context window</span>
            <span style={valStyle}>
              {info.targetContextLength > 0 ? fmtTokens(info.targetContextLength) : 'unknown'}
            </span>
          </div>
          {info.estInputCost !== undefined && (
            <div style={rowStyle}>
              <span style={keyStyle}>{info.estInputCostEstimated ? 'Est. cost to re-read once' : 'Cost to re-read once'}</span>
              <span style={valStyle}>
                {fmtUsd(info.estInputCost)}
              </span>
            </div>
          )}
        </div>

        {!info.fitsInTarget && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 12,
              padding: '8px 10px',
              borderRadius: 8,
              fontSize: 12.5,
              color: 'var(--brass)',
              background: 'color-mix(in srgb, var(--brass) 10%, transparent)',
              border: '1px solid color-mix(in srgb, var(--brass) 40%, transparent)'
            }}
          >
            <I name="warning" size={16} />
            The current context ({fmtTokens(info.contextTokens)}) is larger than{' '}
            {info.targetName}&rsquo;s window — the oldest turns may be dropped or rejected.
          </div>
        )}

        <div className="row">
          <button className="btn" onClick={cancel}>
            Cancel
          </button>
          <button className="btn primary" onClick={() => void confirm()}>
            Switch model
          </button>
        </div>
      </div>
    </div>
  )
}
