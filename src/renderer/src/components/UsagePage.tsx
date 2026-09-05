import React, { useEffect, useMemo, useState } from 'react'
import { useStore } from '@/state/store'
import { fmtTokens } from './ContextOrbit'
import { fmtCost } from './usageStats'
import {
  STATS_RANGE_KEYS,
  type StatsDay,
  type StatsGroup,
  type StatsRangeKey,
  type StatsSnapshot,
  type StatsTool,
  type StatsWindow
} from '@shared/statsSnapshot'
import { I } from './Icon'

/** Deepest a single breakdown table goes before folding the rest into a "+N more" line. */
const MAX_BREAKDOWN_ROWS = 8

const RANGE_LABELS: Record<StatsRangeKey, string> = {
  today: 'Today',
  '7d': '7 days',
  '30d': '30 days',
  all: 'All time'
}

/**
 * The app-wide Usage view: a richly detailed breakdown of every main-run turn Lattice has served —
 * headline token/cost/timing cards, a 30-day activity heat-map, a requests time series, and
 * per-model / per-provider / per-thread / per-tool tables — for a selectable time window.
 *
 * Renders one {@link StatsSnapshot} fetched from the main process (`getStatsSnapshot`), which is the
 * single source of truth shared with the macOS menu-bar widget, so the two never disagree.
 */
export function UsagePage(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.usageOpen)
  const setUi = useStore((s) => s.setUi)
  const [snap, setSnap] = useState<StatsSnapshot | null>(null)
  const [loading, setLoading] = useState(true)
  const [range, setRange] = useState<StatsRangeKey>('7d')

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    window.lattice
      .getStatsSnapshot()
      .then((s) => !cancelled && setSnap(s))
      .catch(() => !cancelled && setSnap(null))
      .finally(() => !cancelled && setLoading(false))
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

  const rangeData = snap?.ranges[range]
  const w = rangeData?.window
  const editCost = (modelId: string): void => setUi({ costEditorModel: modelId })
  const editableTotalModel = useMemo(
    () => (rangeData ? singleLocalModel(rangeData.byModel) : null),
    [rangeData]
  )

  if (!open) return null
  const close = (): void => setUi({ usageOpen: false })
  const hasData = !!w && w.requests > 0

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <div className="modal usage-modal" role="dialog" aria-label="Usage">
        <div className="usage-modal-head">
          <h3 style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
            <I name="bar_chart" size={19} />
            Usage
            {snap?.tz && (
              <span className="usage-tz" title="Windows are bucketed by your local calendar day">
                {snap.tz} calendar day
              </span>
            )}
          </h3>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <div className="seg" role="tablist" aria-label="Time range">
              {STATS_RANGE_KEYS.map((r) => (
                <button
                  key={r}
                  className={`seg-btn ${range === r ? 'on' : ''}`}
                  onClick={() => setRange(r)}
                >
                  {RANGE_LABELS[r]}
                </button>
              ))}
            </div>
            <button className="icon-btn" onClick={close} aria-label="Close usage">
              <I name="close" size={18} />
            </button>
          </div>
        </div>

        <div className="usage-modal-body">
          {loading && !snap ? (
            <p className="usage-empty">Loading…</p>
          ) : !hasData ? (
            <p className="usage-empty">No usage recorded {range === 'all' ? 'yet' : 'in this range'}.</p>
          ) : (
            <>
              <HeadlineGrid
                w={w!}
                onEditCost={editableTotalModel ? () => editCost(editableTotalModel) : undefined}
              />
              <DetailStrip w={w!} />

              <SectionTitle icon="calendar_month" title="Activity" hint="last 30 days · tokens/day" />
              <HeatMap days={snap!.daily} />

              <SectionTitle icon="show_chart" title="Requests over time" />
              <UsageChart days={snap!.daily} range={range} />

              <BreakdownTable
                title="By model"
                icon="deployed_code"
                groups={rangeData!.byModel}
                onEditCost={editCost}
                showProvider
              />
              <BreakdownTable title="By provider" icon="dns" groups={rangeData!.byProvider} />
              <BreakdownTable title="By thread" icon="forum" groups={rangeData!.byThread} />
              <ToolTable tools={rangeData!.tools} />

              {w!.costEstimated && (
                <div className="usage-foot-note">
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

/** Eight headline tiles, each with a value and a contextual sub-line. */
function HeadlineGrid({ w, onEditCost }: { w: StatsWindow; onEditCost?: () => void }): React.JSX.Element {
  const perReq = w.requests > 0 ? Math.round(w.freshTotalTokens / w.requests) : 0
  return (
    <div className="usage-stat-grid usage-stat-grid-4">
      <StatTile
        icon="tag"
        label="Tokens"
        value={fmtTokens(w.freshTotalTokens)}
        sub={`${fmtTokens(w.freshInputTokens)} ↓in · ${fmtTokens(w.outputTokens)} ↑out`}
      />
      <StatTile
        icon="sync_alt"
        label="Requests"
        value={w.requests.toLocaleString()}
        sub={
          w.failed > 0
            ? `${w.failed.toLocaleString()} failed · ≈${fmtTokens(perReq)}/req`
            : `≈${fmtTokens(perReq)}/req · ${w.activeThreads} thread${w.activeThreads === 1 ? '' : 's'}`
        }
        subTone={w.failed > 0 ? 'bad' : undefined}
      />
      <StatTile
        icon="bolt"
        label="Cache hit"
        value={w.cacheHitPct === null ? '—' : `${w.cacheHitPct}%`}
        sub={`${fmtTokens(w.cacheReadTokens)} read · ${fmtTokens(w.cacheWriteTokens)} written`}
      />
      <StatTile
        icon="payments"
        label={w.costEstimated ? 'Est. cost' : 'Cost'}
        value={w.costUsd > 0 ? fmtCost(w.costUsd, w.costEstimated) : '—'}
        sub={w.reasoningTokens > 0 ? `${fmtTokens(w.reasoningTokens)} reasoning tok` : 'billed for this window'}
        accent
        onClick={onEditCost}
        title={onEditCost ? 'Edit the cost model for this route' : undefined}
      />
    </div>
  )
}

/** A compact secondary strip: throughput, latency, tool-time share, output volume. */
function DetailStrip({ w }: { w: StatsWindow }): React.JSX.Element {
  const avgTtft = w.requests > 0 ? Math.round(w.ttftMs / w.requests) : 0
  return (
    <div className="usage-strip">
      <Metric label="Avg throughput" value={w.tps > 0 ? `${w.tps} tok/s` : '—'} icon="speed" />
      <Metric label="Avg TTFT" value={avgTtft > 0 ? fmtMs(avgTtft) : '—'} icon="timer" />
      <Metric label="Tool calls" value={w.toolCalls.toLocaleString()} icon="build" />
      <Metric label="Reasoning" value={w.reasoningTokens > 0 ? fmtTokens(w.reasoningTokens) : '—'} icon="neurology" />
      <Metric label="Total tokens" value={fmtTokens(w.totalTokens)} icon="database" />
    </div>
  )
}

function Metric({ label, value, icon }: { label: string; value: string; icon: string }): React.JSX.Element {
  return (
    <div className="usage-metric">
      <span className="usage-metric-label">
        <I name={icon} size={13} />
        {label}
      </span>
      <span className="usage-metric-value">{value}</span>
    </div>
  )
}

function StatTile({
  icon,
  label,
  value,
  sub,
  subTone,
  accent,
  onClick,
  title
}: {
  icon: string
  label: string
  value: React.ReactNode
  sub?: string
  subTone?: 'bad'
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
      {sub && <span className={`usage-stat-sub${subTone === 'bad' ? ' bad' : ''}`}>{sub}</span>}
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

function SectionTitle({ icon, title, hint }: { icon: string; title: string; hint?: string }): React.JSX.Element {
  return (
    <h4 className="usage-section">
      <I name={icon} size={15} />
      {title}
      {hint && <span className="usage-section-hint">{hint}</span>}
    </h4>
  )
}

/** GitHub-style 30-day heat-map: five weeks of squares shaded by that day's token volume. */
function HeatMap({ days }: { days: StatsDay[] }): React.JSX.Element {
  const [hover, setHover] = useState<StatsDay | null>(null)
  const max = Math.max(1, ...days.map((d) => d.tokens))
  const weekdayLabels = ['S', 'M', 'T', 'W', 'T', 'F', 'S']
  // Lay out in columns of weeks; pad the first week so weekday rows line up.
  const lead = days[0]?.weekday ?? 0
  const cells: (StatsDay | null)[] = [...Array<null>(lead).fill(null), ...days]
  const weeks: (StatsDay | null)[][] = []
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7))

  const level = (tokens: number): number => (tokens <= 0 ? 0 : Math.min(4, Math.max(1, Math.ceil((tokens / max) * 4))))

  return (
    <div className="usage-heat">
      <div className="usage-heat-grid">
        <div className="usage-heat-days">
          {weekdayLabels.map((l, i) => (
            <span key={i} className="usage-heat-daylabel">
              {i % 2 === 1 ? l : ''}
            </span>
          ))}
        </div>
        {weeks.map((week, wi) => (
          <div key={wi} className="usage-heat-week">
            {Array.from({ length: 7 }, (_, di) => {
              const cell = week[di] ?? null
              if (!cell) return <span key={di} className="usage-heat-cell empty" />
              return (
                <span
                  key={di}
                  className={`usage-heat-cell lvl${level(cell.tokens)}${hover?.date === cell.date ? ' on' : ''}`}
                  onMouseEnter={() => setHover(cell)}
                  onMouseLeave={() => setHover((h) => (h?.date === cell.date ? null : h))}
                  title={`${cell.date} · ${fmtTokens(cell.tokens)} tokens · ${cell.requests} req`}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="usage-heat-caption">
        {hover ? (
          <span>
            <strong>{prettyDay(hover.date)}</strong> · {fmtTokens(hover.tokens)} tokens · {hover.requests} req
            {hover.costUsd > 0 && <> · {fmtCost(hover.costUsd, false)}</>}
          </span>
        ) : (
          <span className="usage-heat-legend">
            Less
            {[0, 1, 2, 3, 4].map((l) => (
              <span key={l} className={`usage-heat-cell lvl${l}`} />
            ))}
            More
          </span>
        )}
      </div>
    </div>
  )
}

function UsageChart({ days, range }: { days: StatsDay[]; range: StatsRangeKey }): React.JSX.Element {
  const shown = range === '7d' ? days.slice(-7) : days
  const max = Math.max(...shown.map((d) => d.requests), 1)
  return (
    <div className="usage-chart">
      {shown.map((d) => (
        <div
          key={d.date}
          className="usage-chart-col"
          title={`${d.date}: ${d.requests} request${d.requests === 1 ? '' : 's'}${
            d.costUsd > 0 ? `, ${fmtCost(d.costUsd, false)}` : ''
          }`}
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
  icon,
  groups,
  onEditCost,
  showProvider
}: {
  title: string
  icon: string
  groups: StatsGroup[]
  /** when set (the By model table), each locally-priced row's cost opens the cost editor */
  onEditCost?: (modelId: string) => void
  showProvider?: boolean
}): React.JSX.Element | null {
  if (groups.length === 0) return null
  const shown = groups.slice(0, MAX_BREAKDOWN_ROWS)
  const restCount = groups.length - shown.length
  const maxTokens = Math.max(1, ...groups.map((g) => g.freshTotalTokens))
  return (
    <>
      <SectionTitle icon={icon} title={title} />
      <table className="usage-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Req</th>
            <th>In</th>
            <th>Out</th>
            <th>Cache</th>
            <th>tok/s</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((g) => {
            const editable = !!onEditCost && g.costLocal && g.key !== 'unknown'
            return (
              <tr key={g.key}>
                <td className="usage-table-name" title={g.label}>
                  <span className="usage-table-bar" style={{ width: `${(g.freshTotalTokens / maxTokens) * 100}%` }} />
                  <span className="usage-table-name-text">
                    {g.label}
                    {showProvider && g.sublabel && <span className="usage-table-sub">{g.sublabel}</span>}
                  </span>
                </td>
                <td>
                  {g.requests}
                  {g.failed > 0 && <span className="usage-fail"> ·{g.failed}✗</span>}
                </td>
                <td>{fmtTokens(g.freshInputTokens + g.cachedInputTokens)}</td>
                <td>{fmtTokens(g.outputTokens)}</td>
                <td>{g.cacheHitPct === null ? '—' : `${Math.round(g.cacheHitPct)}%`}</td>
                <td>{g.tps > 0 ? g.tps : '—'}</td>
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
      {restCount > 0 && <div className="usage-more">+{restCount} more</div>}
    </>
  )
}

function ToolTable({ tools }: { tools: StatsTool[] }): React.JSX.Element | null {
  if (tools.length === 0) return null
  const shown = tools.slice(0, MAX_BREAKDOWN_ROWS)
  const restCount = tools.length - shown.length
  const maxCalls = Math.max(1, ...tools.map((t) => t.calls))
  return (
    <>
      <SectionTitle icon="build" title="By tool" />
      <table className="usage-table">
        <thead>
          <tr>
            <th>Tool</th>
            <th>Calls</th>
            <th>Failed</th>
            <th>Avg time</th>
          </tr>
        </thead>
        <tbody>
          {shown.map((t) => (
            <tr key={t.tool}>
              <td className="usage-table-name" title={t.tool}>
                <span className="usage-table-bar" style={{ width: `${(t.calls / maxCalls) * 100}%` }} />
                <span className="usage-table-name-text">{t.tool}</span>
              </td>
              <td>{t.calls.toLocaleString()}</td>
              <td className={t.failed > 0 ? 'usage-fail' : undefined}>{t.failed || '—'}</td>
              <td>{t.avgMs === null ? '—' : fmtMs(t.avgMs)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {restCount > 0 && <div className="usage-more">+{restCount} more</div>}
    </>
  )
}

function singleLocalModel(groups: StatsGroup[]): string | null {
  const modelIds = new Set(groups.filter((g) => g.costLocal && g.key !== 'unknown').map((g) => g.key))
  return modelIds.size === 1 ? modelIds.values().next().value ?? null : null
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(ms < 10000 ? 1 : 0)}s`
}

function prettyDay(ymd: string): string {
  const [y, m, d] = ymd.split('-')
  const date = new Date(Number(y), Number(m) - 1, Number(d))
  return date.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })
}
