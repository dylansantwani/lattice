import React from 'react'
import type { ContextBudget } from '@shared/types'

export const SEGMENT_COLORS: Record<string, string> = {
  system: '#8e87d8',
  tools: '#d5a45d',
  history: '#7fb98a',
  injected: '#6aa5c8',
  outputReserve: '#5a5f66',
  safety: '#3c4046'
}

export const SEGMENT_LABELS: Record<string, string> = {
  system: 'System & instructions',
  tools: 'Tool schemas',
  history: 'Conversation history',
  injected: 'Injected content',
  outputReserve: 'Output reserve',
  safety: 'Safety buffer'
}

/**
 * The Context Orbit: segmented occupancy ring + "N% Used" text + hover breakdown
 * tooltip (per the Stitch baseline), clicking opens the Context inspector.
 */
export function ContextOrbit({
  budget,
  onClick
}: {
  budget: ContextBudget | null
  onClick?: () => void
}): React.JSX.Element {
  const size = 32
  const stroke = 3.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r

  const occupancy = budget?.occupancy ?? 0
  const pct = Math.round(occupancy * 100)
  const cls = occupancy >= 0.92 ? 'hot' : occupancy >= 0.8 ? 'warm' : ''
  const entries = budget ? Object.entries(budget.segments).filter(([, v]) => v > 0) : []

  let offset = 0

  return (
    <div className={`orbit-wrap ${cls}`}>
      <div className="orbit-tip" role="tooltip">
        <div className="tip-head">
          <span className="label-caps" style={{ color: 'var(--text)' }}>
            Context breakdown
          </span>
          <span
            style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--violet-soft)' }}
          >
            {budget ? `${fmtTokens(budget.contextLength)} max` : '—'}
          </span>
        </div>
        {entries.map(([k, v]) => (
          <div key={k} className="row">
            <span>
              <span className="dot" style={{ background: SEGMENT_COLORS[k] }} />
              {SEGMENT_LABELS[k]}
            </span>
            <span>
              {budget && !budget.exact ? '~' : ''}
              {fmtTokens(v)}
            </span>
          </div>
        ))}
        {!budget && <div className="row">No context data yet.</div>}
      </div>

      <div className="orbit-pct">
        <span className="n">
          {budget && !budget.exact ? '~' : ''}
          {pct}%
        </span>
        <span className="l">Used</span>
      </div>

      <div
        className="orbit"
        onClick={onClick}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === 'Enter' && onClick?.()}
        aria-label={`Context ${pct}% used — open context inspector`}
      >
        <svg width={size} height={size}>
          <circle
            cx={size / 2}
            cy={size / 2}
            r={r}
            fill="none"
            stroke="var(--raised)"
            strokeWidth={stroke}
          />
          {budget &&
            entries.map(([key, tokens]) => {
              const frac = Math.min(1, tokens / budget.usableTokens)
              const dash = frac * c
              const el = (
                <circle
                  key={key}
                  cx={size / 2}
                  cy={size / 2}
                  r={r}
                  fill="none"
                  stroke={SEGMENT_COLORS[key] ?? '#666'}
                  strokeWidth={stroke}
                  strokeDasharray={`${dash} ${c - dash}`}
                  strokeDashoffset={-offset}
                />
              )
              offset += dash
              return el
            })}
        </svg>
      </div>
    </div>
  )
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
