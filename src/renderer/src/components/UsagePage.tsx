import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import type { UsageRow } from '@shared/types'
import { fmtTokens } from './ContextOrbit'
import { fmtCost } from './usageStats'
import {
  buildUsagePageData,
  filterByRange,
  USAGE_RANGES,
  type UsageDayBucket,
  type UsageGroup,
  type UsageRange
} from './usageRollup'
import { I } from './Icon'

/** Deepest a single breakdown table goes before folding the rest into a "+N more" line — keeps
 * a workspace with hundreds of threads or a long model history from turning into a wall of rows. */
const MAX_BREAKDOWN_ROWS = 8

/**
 * A dedicated, app-wide view of usage — tokens, cache hit-rate, cost, tok/s, and request volume
 * over time, broken down by model/provider/thread. Rolls up the per-turn telemetry already
 * captured on every assistant message (see `usagePage.ts`) into session/lifetime aggregates.
 *
 * Self-contained like Settings/Inbox: fetches its own data through `window.lattice` rather than
 * routing through the store, since it's the only consumer of the full cross-thread usage log.
 */
export function UsagePage(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.usageOpen)
  const setUi = useStore((s) => s.setUi)
  const models = useStore((s) => s.models)
  const overrides = useStore((s) => s.settings?.costOverrides)
  const [rows, setRows] = useState<UsageRow[] | null>(null)
  const [range, setRange] = useState<UsageRange>('7d')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    window.lattice
      .listUsageRows()
      .then((r) => !cancelled && setRows(r))
      .catch(() => !cancelled && setRows([]))
    return () => {
      cancelled = true
    }
  }, [open])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        setUi({ usageOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUi])

  const filtered = useMemo(() => (rows ? filterByRange(rows, range) : []), [rows, range])
  const data = useMemo(() => buildUsagePageData(filtered, models, overrides), [filtered, models, overrides])
  const editableTotalModel = useMemo(() => singleLocalModel(data.byModel), [data.byModel])
  const editCost = (modelId: string): void => setUi({ costEditorModel: modelId })

  if (!open) return null

  const close = (): void => setUi({ usageOpen: false })

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal usage-modal" role="dialog" aria-label="Usage">
        <div className="usage-modal-head">
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <I name="bar_chart" size={19} />
            Usage
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="seg" role="tablist" aria-label="Time range">
              {USAGE_RANGES.map((r) => (
                <button
                  key={r.key}
                  className={`seg-btn ${range === r.key ? 'on' : ''}`}
                  onClick={() => setRange(r.key)}
                >
                  {r.label}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={close} aria-label="Close usage">
              <I name="close" size={18} />
            </button>
          </div>
        </div>

        <div className="usage-modal-body">
          {rows === null ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)', textAlign: 'center', padding: '30px 0' }}>Loading…</p>
          ) : filtered.length === 0 ? (
            <p style={{ fontSize: 13, color: 'var(--text-dim)', textAlign: 'center', padding: '30px 0' }}>
              No usage recorded {range === 'all' ? 'yet' : 'in this range'}.
            </p>
          ) : (
            <>
              <div className="usage-stat-grid">
                <StatTile icon="forum" label="Requests" value={data.totals.requests.toLocaleString()} />
                <StatTile icon="arrow_downward" label="Input" value={fmtTokens(data.totals.freshInputTokens)} />
                <StatTile icon="bolt" label="Cached input" value={fmtTokens(data.totals.cachedInputTokens)} />
                <StatTile icon="arrow_upward" label="Output" value={fmtTokens(data.totals.outputTokens)} />
                <StatTile icon="speed" label="Avg tok/s" value={data.totals.tps > 0 ? data.totals.tps : '—'} />
                <StatTile
                  icon="paid"
                  label={data.totals.costEstimated ? 'Est. cost' : 'Total cost'}
                  value={data.totals.costUsd > 0 ? fmtCost(data.totals.costUsd, data.totals.costEstimated) : '—'}
                  accent
                  onClick={editableTotalModel ? () => editCost(editableTotalModel) : undefined}
                  title={editableTotalModel ? 'Edit the cost model for this route' : undefined}
                />
              </div>

              {data.cacheHitRate !== null && (
                <div className="kv" style={{ marginBottom: 4 }}>
                  <span className="k">Cache hit rate</span>
                  <span className="v">{Math.round(data.cacheHitRate * 100)}% of input</span>
                </div>
              )}
              {data.totals.reasoningTokens > 0 && (
                <div className="kv" style={{ marginBottom: 10 }}>
                  <span className="k">Reasoning tokens</span>
                  <span className="v">{fmtTokens(data.totals.reasoningTokens)}</span>
                </div>
              )}

              <h4>Requests over time</h4>
              <UsageChart days={data.byDay} />

              <BreakdownTable title="By model" groups={data.byModel} onEditCost={editCost} />
              <BreakdownTable title="By provider" groups={data.byProvider} />
              <BreakdownTable title="By thread" groups={data.byThread} />

              {data.totals.costEstimated && (
                <div style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 4 }}>
                  Estimated cost is from list price; at least one turn&rsquo;s route didn&rsquo;t report actual
                  billed cost. Click a cost in <em>By model</em> to set your own rates and make it exact.
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

function StatTile({
  icon,
  label,
  value,
  accent,
  onClick,
  title
}: {
  icon: string
  label: string
  value: React.ReactNode
  accent?: boolean
  onClick?: () => void
  title?: string
}): React.JSX.Element {
  const cls = `usage-stat${accent ? ' accent' : ''}${onClick ? ' editable' : ''}`
  const body = (
    <>
      <span className="usage-stat-label">
        <I name={icon} size={13} />
        {label}
        {onClick && <I name="edit" size={11} />}
      </span>
      <span className="usage-stat-value">{value}</span>
    </>
  )
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {body}
    </button>
  ) : (
    <div className={cls} title={title}>
      {body}
    </div>
  )
}

function singleLocalModel(groups: UsageGroup[]): string | null {
  const modelIds = new Set(groups.filter((group) => group.costLocal && group.key !== 'unknown').map((group) => group.key))
  return modelIds.size === 1 ? modelIds.values().next().value ?? null : null
}

function UsageChart({ days }: { days: UsageDayBucket[] }): React.JSX.Element {
  const max = Math.max(...days.map((d) => d.requests), 1)
  return (
    <div className="usage-chart">
      {days.map((d) => (
        <div
          key={d.date}
          className="usage-chart-col"
          title={`${d.date}: ${d.requests} request${d.requests === 1 ? '' : 's'}, ${fmtCost(d.costUsd, d.costEstimated)}`}
        >
          <div className="usage-chart-bar" style={{ height: `${Math.max(4, (d.requests / max) * 100)}%` }} />
          <span className="usage-chart-day-label">{d.date.slice(5)}</span>
        </div>
      ))}
    </div>
  )
}

function BreakdownTable({
  title,
  groups,
  onEditCost
}: {
  title: string
  groups: UsageGroup[]
  /** when set (the By model table), each locally-priced row's cost opens the cost editor for that route */
  onEditCost?: (modelId: string) => void
}): React.JSX.Element | null {
  if (groups.length === 0) return null
  const shown = groups.slice(0, MAX_BREAKDOWN_ROWS)
  const restCount = groups.length - shown.length
  return (
    <>
      <h4>{title}</h4>
      <table className="usage-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Requests</th>
            <th>Input</th>
            <th>Output</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((g) => {
            const editable = !!onEditCost && g.costLocal && g.key !== 'unknown'
            return (
              <tr key={g.key}>
                <td className="usage-table-name" title={g.label}>
                  {g.label}
                </td>
                <td>{g.requests}</td>
                <td>{fmtTokens(g.freshInputTokens + g.cachedInputTokens)}</td>
                <td>{fmtTokens(g.outputTokens)}</td>
                <td>
                  {editable ? (
                    <button
                      type="button"
                      className="usage-cost-edit"
                      onClick={() => onEditCost!(g.key)}
                      title="Edit the cost model for this route"
                    >
                      {g.costUsd > 0 ? fmtCost(g.costUsd, g.costEstimated) : '—'}
                      <I name="edit" size={11} />
                    </button>
                  ) : g.costUsd > 0 ? (
                    fmtCost(g.costUsd, g.costEstimated)
                  ) : (
                    '—'
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
      {restCount > 0 && (
        <div style={{ fontSize: 11, color: 'var(--text-faint)', margin: '2px 0 12px' }}>+{restCount} more</div>
      )}
    </>
  )
}
