import React from 'react'
import type { ContextBudget } from '@shared/types'

const SEGMENT_COLORS: Record<string, string> = {
  system: '#8e87d8',
  tools: '#d5a45d',
  history: '#7fb98a',
  injected: '#6aa5c8',
  outputReserve: '#5a5f66',
  safety: '#3c4046'
}

/**
 * The Context Orbit: segmented circular gauge of effective context occupancy.
 */
export function ContextOrbit({
  budget,
  onClick
}: {
  budget: ContextBudget | null
  onClick?: () => void
}): React.JSX.Element {
  const size = 34
  const stroke = 3.5
  const r = (size - stroke) / 2
  const c = 2 * Math.PI * r

  const occupancy = budget?.occupancy ?? 0
  const pct = Math.round(occupancy * 100)
  const cls = occupancy >= 0.92 ? 'hot' : occupancy >= 0.8 ? 'warm' : ''

  const segs: { key: string; frac: number }[] = []
  if (budget) {
    const total = budget.usableTokens
    for (const [key, tokens] of Object.entries(budget.segments)) {
      if (tokens > 0) segs.push({ key, frac: Math.min(1, tokens / total) })
    }
  }

  let offset = 0
  const title = budget
    ? `${budget.exact ? '' : '~'}${fmtTokens(budget.usedTokens)} / ${fmtTokens(budget.usableTokens)} usable`
    : 'context usage unavailable'

  return (
    <div className={`orbit ${cls}`} onClick={onClick} title={title} role="button" tabIndex={0} aria-label={`Context ${pct}% used. ${title}`}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--raised)" strokeWidth={stroke} />
        {segs.map((s) => {
          const dash = s.frac * c
          const el = (
            <circle
              key={s.key}
              cx={size / 2}
              cy={size / 2}
              r={r}
              fill="none"
              stroke={SEGMENT_COLORS[s.key] ?? '#666'}
              strokeWidth={stroke}
              strokeDasharray={`${dash} ${c - dash}`}
              strokeDashoffset={-offset}
              strokeLinecap="butt"
            />
          )
          offset += dash
          return el
        })}
      </svg>
      <span className="pct">
        {budget && !budget.exact ? '~' : ''}
        {pct}
      </span>
    </div>
  )
}

export function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`
  return String(n)
}
