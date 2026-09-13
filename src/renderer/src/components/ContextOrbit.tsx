import React from 'react'
import { fmtTokens } from '@shared/view/format'
import type { ContextBudget } from '@shared/types'
import { fmtContextWindow } from '@shared/contextScale'
import { useStore } from '@/state/store'

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
  outputReserve: 'Held for the reply',
  safety: 'Safety margin'
}

/** Short plain-language explanation for each segment (shown on hover). */
export const SEGMENT_HELP: Record<string, string> = {
  system: 'Your instructions and the agent’s system prompt.',
  tools: 'JSON schemas for every tool the agent can call.',
  history: 'The running conversation — messages and tool results so far.',
  injected: 'Files, memory, and context pulled in for this turn.',
  outputReserve: 'Space kept free so the model has room to write its reply.',
  safety: 'A small cushion before auto-compaction kicks in.'
}

/** Segments that are reserved space, not consumed context. */
export const RESERVED = new Set(['outputReserve', 'safety'])

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

  // Tie the ring's warm/hot states to the actual thresholds: "hot" once a turn would be blocked,
  // "warm" once the next turn will auto-compact (or the user should compact manually).
  const compactionThreshold = useStore((s) => s.settings?.compactionThreshold ?? 0.92)
  const blockThreshold = useStore((s) => s.settings?.blockThreshold ?? 0.97)
  const occupancy = budget?.occupancy ?? 0
  const pct = Math.round(occupancy * 100)
  const cls = occupancy >= blockThreshold ? 'hot' : occupancy >= compactionThreshold ? 'warm' : ''
  const all = budget ? Object.entries(budget.segments).filter(([, v]) => v > 0) : []
  // Only what the conversation actually consumes goes in the ring and the "used"
  // total; reserved space (reply + safety) is held back off the top and listed
  // apart so it never reads as used.
  const consumed = all.filter(([k]) => !RESERVED.has(k))
  const reservedTotal = all
    .filter(([k]) => RESERVED.has(k))
    .reduce((sum, [, v]) => sum + v, 0)

  let offset = 0

  return (
    <div className={`orbit-wrap ${cls}`}>
      <div className="orbit-tip" role="tooltip">
        <div className="tip-head">
          <span className="label-caps" style={{ color: 'var(--text)' }}>
            Context
            {budget && budget.contextLength > 0 && (
              <span
                className="label-caps"
                style={{ color: 'var(--text-faint)', marginLeft: 6 }}
                title="The model's total context window"
              >
                {fmtContextWindow(budget.contextLength)} window
              </span>
            )}
          </span>
          <span style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
            {budget && <span className="tip-pct">{pct}% used</span>}
            <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12.5, color: 'var(--text-dim)' }}>
              {budget ? `${fmtTokens(budget.usedTokens)} / ${fmtTokens(budget.usableTokens)}` : '—'}
            </span>
          </span>
        </div>
        {consumed.map(([k, v]) => (
          <div key={k} className="row">
            <span>
              <span className="dot" style={{ background: SEGMENT_COLORS[k] }} />
              {SEGMENT_LABELS[k]}
            </span>
            <span>{fmtTokens(v)}</span>
          </div>
        ))}
        {budget && (
          <div className="row" style={{ color: 'var(--text-faint)' }}>
            <span>
              <span className="dot" style={{ background: 'var(--raised)' }} />
              Free
            </span>
            <span>{fmtTokens(Math.max(0, budget.usableTokens - budget.usedTokens))}</span>
          </div>
        )}
        {reservedTotal > 0 && (
          <div className="row tip-reserved">
            <span>
              <span className="dot" style={{ background: SEGMENT_COLORS.outputReserve }} />
              Reserved for reply
            </span>
            <span>{fmtTokens(reservedTotal)}</span>
          </div>
        )}
        {!budget && <div className="row">No context data yet.</div>}
      </div>

      <div className="orbit-pct">
        <span className="n">
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
            consumed.map(([key, tokens]) => {
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

export { fmtTokens } from '@shared/view/format'
