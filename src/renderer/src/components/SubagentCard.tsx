import React, { useMemo, useState } from 'react'
import type { RunEvent } from '@shared/types'
import { useStore } from '@/state/store'
import { Markdown } from './Markdown'
import { I } from './Icon'
import { fmtTokens } from './ContextOrbit'
import { useElapsed, formatElapsed } from './useElapsed'
import { incomingCollapsedByDefault, incomingPreview, incomingSizeHint } from './incomingDisplay'
import { draftStringField, type ToolCall } from './runTimeline'
import {
  indexSubagents,
  isBackgroundHandle,
  resultErrorOf,
  resultTextOf,
  subagentForCall,
  subagentPhase,
  titleCase,
  type SubagentIndex,
  type SubagentPhase,
  type SubagentToolTrace,
  type SubagentView
} from './subagents'

/**
 * The subagent index is folded from the thread's whole event list, so it's computed once per
 * events snapshot (keyed by array identity) and shared by every card on screen — not once per
 * card per event, which would be O(cards × events) on every streamed delta.
 */
const indexCache = new WeakMap<RunEvent[], SubagentIndex>()
function useSubagentIndex(): SubagentIndex {
  const events = useStore((s) => s.events)
  return useMemo(() => {
    let idx = indexCache.get(events)
    if (!idx) {
      idx = indexSubagents(events)
      indexCache.set(events, idx)
    }
    return idx
  }, [events])
}

const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)
const record = (v: unknown): Record<string, unknown> | undefined =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined

const PHASE_LABEL: Record<SubagentPhase, string> = {
  starting: 'Spinning up',
  running: 'Running',
  done: 'Done',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted'
}

const PHASE_ICON: Record<SubagentPhase, string> = {
  starting: 'more_horiz',
  running: 'autorenew',
  done: 'check',
  failed: 'error',
  stopped: 'block',
  interrupted: 'do_not_disturb_on'
}

/** "12ms" under a second, else "1m 04s" — a subagent's span reads in whole seconds once it's real. */
function fmtSpan(ms: number): string {
  return ms < 1000 ? `${Math.max(0, Math.round(ms))}ms` : formatElapsed(ms)
}

/**
 * A `run_agent` delegation, rendered as the subagent it spawned rather than as a tool row: who it
 * is (name, role, model), what it was asked to do, what it is doing right now (live activity and a
 * trail of its recent tool calls, folded from its own tagged events), and — once it reports back —
 * its answer rendered as prose. The card is the transcript-side face of the Agents panel: the same
 * agent, in the place the delegation happened, with a stop button while it runs.
 */
export function SubagentCard({
  callId,
  call,
  live
}: {
  callId: string
  call: ToolCall
  /** whether the parent turn is still running (a background agent may outlive it) */
  live: boolean
}): React.JSX.Element {
  const index = useSubagentIndex()
  const view = subagentForCall(index, callId, call)
  const cancelAgent = useStore((s) => s.cancelAgent)
  const setUi = useStore((s) => s.setUi)
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)

  const args = record(call.args)
  const result = record(call.result)
  const phase = subagentPhase(call, view, live)
  const active = phase === 'starting' || phase === 'running'

  // Identity: the agent's own run.started is authoritative; before it lands, read the call's
  // (possibly still-streaming) arguments so the card has a name from the first drafted byte.
  const role = view?.role ?? str(args?.agent_type) ?? draftStringField(call.draftArgs, 'agent_type')
  const name =
    view?.name ??
    str(args?.name) ??
    draftStringField(call.draftArgs, 'name') ??
    (role ? titleCase(role) : 'Subagent')
  const task = str(args?.task) ?? draftStringField(call.draftArgs, 'task') ?? ''
  const background = isBackgroundHandle(call.result) || args?.background === true
  const model = view?.model ?? str(args?.model)
  const effort = view?.effort ?? str(args?.effort)
  const granted = view?.tools ?? (Array.isArray(result?.tools) ? (result!.tools as string[]) : undefined)
  const requestedTools = Array.isArray(args?.tools) ? (args!.tools as string[]) : undefined

  // Elapsed ticks live from the agent's own start; once settled, its real span (or the call's).
  const ticking = useElapsed(active, view?.startedAt)
  const settledMs =
    view?.startedAt !== undefined && view.endedAt !== undefined ? view.endedAt - view.startedAt : call.durationMs
  const elapsedMs = active ? ticking : settledMs

  const toolCalls = view?.toolCalls ?? (typeof result?.toolCalls === 'number' ? (result.toolCalls as number) : undefined)
  const resultText = phase === 'done' ? resultTextOf(call.result) : undefined
  const failure = call.reason ?? resultErrorOf(call.result) ?? view?.error
  const showRole = !!role && role.toLowerCase() !== name.toLowerCase()
  const showTrail = !!view && view.recentTools.length > 0 && (active || open)

  const onStop = (e: React.MouseEvent): void => {
    e.stopPropagation()
    if (!view) return
    setStopping(true)
    void cancelAgent(view.id)
  }
  const onOpenPanel = (e: React.MouseEvent): void => {
    e.stopPropagation()
    setUi({ inspectorOpen: true, inspectorTab: 'agents' })
  }

  return (
    <div className={`subagent-card ${phase}${open ? ' open' : ''}${background ? ' background' : ''}`}>
      <div
        className="subagent-head"
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen((v) => !v)
          }
        }}
      >
        <span className="subagent-avatar" aria-hidden>
          <I name="smart_toy" size={17} />
        </span>
        <div className="subagent-title">
          <div className="subagent-kicker">
            <span>Subagent</span>
            {showRole && <span className="subagent-chip">{role}</span>}
            {background && (
              <span className="subagent-chip bg" title="Runs concurrently; its report is delivered as a new turn">
                background
              </span>
            )}
          </div>
          <div className="subagent-name" title={name}>
            {name}
          </div>
        </div>
        <span className={`subagent-state ${phase}`}>
          <I name={PHASE_ICON[phase]} size={12} className={phase === 'running' ? 'spin' : phase === 'starting' ? 'pulse' : ''} />
          {background && phase === 'running' ? 'In background' : PHASE_LABEL[phase]}
        </span>
        <span className="subagent-actions">
          {view?.running && (
            <button
              className="subagent-icon-btn stop"
              disabled={stopping}
              onClick={onStop}
              aria-label={`Stop ${name}`}
              title={`Stop ${name}`}
            >
              <I name={stopping ? 'autorenew' : 'stop_circle'} size={15} className={stopping ? 'spin' : ''} />
            </button>
          )}
          <button
            className="subagent-icon-btn"
            onClick={onOpenPanel}
            aria-label="Open in the Agents panel"
            title="Open in the Agents panel"
          >
            <I name="account_tree" size={13} />
          </button>
          <I name={open ? 'expand_less' : 'expand_more'} size={16} className="subagent-chev" />
        </span>
      </div>

      <div className="subagent-meta">
        {model && (
          <span className="subagent-meta-item" title="Model">
            <I name="memory" size={11} />
            {model}
            {effort && <span className="subagent-meta-dim"> · {effort}</span>}
          </span>
        )}
        {(granted ?? requestedTools) && (
          <span className="subagent-meta-item" title={(granted ?? requestedTools)!.join(', ') || 'text-only'}>
            <I name="handyman" size={11} />
            {(granted ?? requestedTools)!.length === 0
              ? 'text-only'
              : `${(granted ?? requestedTools)!.length} tools${granted ? '' : ' requested'}`}
          </span>
        )}
        {toolCalls !== undefined && (
          <span className="subagent-meta-item" title="Tool calls made">
            <I name="build" size={11} />
            {toolCalls} {toolCalls === 1 ? 'call' : 'calls'}
          </span>
        )}
        {elapsedMs !== undefined && (
          <span className="subagent-meta-item" title={active ? 'Running for' : 'Took'}>
            <I name="schedule" size={11} />
            {fmtSpan(elapsedMs)}
          </span>
        )}
      </div>

      {task && (
        <div className="subagent-task" title={open ? undefined : task}>
          {task}
        </div>
      )}

      {active && (
        <div className="subagent-live" aria-live="polite">
          <ActivityLine view={view} phase={phase} />
          {showTrail && <Trail traces={view!.recentTools} />}
        </div>
      )}
      {!active && showTrail && (
        <div className="subagent-live settled">
          <Trail traces={view!.recentTools} />
        </div>
      )}

      {resultText !== undefined && <Report text={resultText} />}

      {phase === 'done' && resultText === undefined && background && (
        <div className="subagent-note">
          <I name="check_circle" size={14} />
          {view ? 'Finished — its report was delivered as a new turn below.' : 'Started in the background.'}
        </div>
      )}
      {phase === 'running' && background && (
        <div className="subagent-note">
          <I name="schedule_send" size={14} />
          Working concurrently — its report lands here as a new turn when it finishes.
        </div>
      )}
      {phase === 'failed' && (
        <div className="subagent-note failure">
          <I name="error" size={14} />
          <span>{failure ?? 'The subagent failed.'}</span>
        </div>
      )}
      {phase === 'stopped' && (
        <div className="subagent-note">
          <I name="block" size={14} />
          Stopped before it finished.
        </div>
      )}
      {phase === 'interrupted' && (
        <div className="subagent-note">
          <I name="do_not_disturb_on" size={14} />
          The run ended before this subagent reported back.
        </div>
      )}

      {open && <Details view={view} args={args} result={result} resultText={resultText} granted={granted} />}
    </div>
  )
}

/** What the agent is doing right now, from its latest events (or the call alone before any land). */
function ActivityLine({ view, phase }: { view: SubagentView | undefined; phase: SubagentPhase }): React.JSX.Element {
  const activity = view?.activity
  const since = useElapsed(true, activity?.since)
  let icon = 'autorenew'
  let label: string
  if (!view || !activity || activity.kind === 'starting') {
    icon = phase === 'starting' ? 'rocket_launch' : 'autorenew'
    label = phase === 'starting' ? 'Spinning up…' : 'Getting started…'
  } else if (activity.kind === 'thinking') {
    icon = 'neurology'
    label = 'Thinking…'
  } else if (activity.kind === 'writing') {
    icon = 'edit_note'
    label = 'Writing its report…'
  } else {
    icon = 'build'
    label = activity.label
  }
  return (
    <div className="subagent-activity">
      <I name={icon} size={14} className={icon === 'autorenew' ? 'spin' : 'pulse'} />
      <span className="subagent-activity-label" title={label}>
        {label}
      </span>
      {view && (
        <span className="subagent-stats">
          {view.thinkingBouts > 0 && (
            <span title="Bouts of reasoning">
              {view.thinkingBouts} {view.thinkingBouts === 1 ? 'thought' : 'thoughts'}
            </span>
          )}
          {view.toolCalls > 0 && (
            <span title="Tool calls so far">
              {view.toolsDone}/{view.toolCalls} tools
            </span>
          )}
        </span>
      )}
      {activity && activity.kind !== 'starting' && since >= 2000 && (
        <span className="subagent-activity-since" title="Time on this step">
          {formatElapsed(since)}
        </span>
      )}
    </div>
  )
}

/** The agent's most recent tool calls, oldest → newest, each with its outcome. */
function Trail({ traces }: { traces: SubagentToolTrace[] }): React.JSX.Element {
  return (
    <div className="subagent-trail" aria-label="Recent tool calls">
      {traces.map((t) => (
        <span key={t.callId} className={`subagent-trace ${t.status}`} title={`${t.label}${t.durationMs !== undefined ? ` · ${t.durationMs}ms` : ''}`}>
          <I
            name={
              t.status === 'running'
                ? 'autorenew'
                : t.status === 'requested'
                  ? 'more_horiz'
                  : t.status === 'complete'
                    ? 'check'
                    : 'error'
            }
            size={11}
            className={t.status === 'running' ? 'spin' : ''}
          />
          <span className="subagent-trace-label">{t.label}</span>
        </span>
      ))}
    </div>
  )
}

/** The subagent's answer, as prose. Long reports arrive folded behind a one-line preview. */
function Report({ text }: { text: string }): React.JSX.Element {
  const foldable = useMemo(() => incomingCollapsedByDefault(text), [text])
  const [open, setOpen] = useState(!foldable)
  const preview = useMemo(() => (foldable ? incomingPreview(text) : ''), [foldable, text])
  if (!text.trim()) {
    return (
      <div className="subagent-note">
        <I name="check_circle" size={14} />
        Finished without a written report.
      </div>
    )
  }
  return (
    <div className={`subagent-result${open ? '' : ' folded'}`}>
      <button className="subagent-result-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <I name="assignment_turned_in" size={13} />
        <span>Report</span>
        {!open && <span className="subagent-result-preview">{preview}</span>}
        {foldable && (
          <>
            <span className="subagent-result-hint">{open ? 'Collapse' : incomingSizeHint(text)}</span>
            <I name={open ? 'expand_less' : 'expand_more'} size={14} />
          </>
        )}
      </button>
      {open && <Markdown text={text} />}
    </div>
  )
}

/** Expanded detail: the full brief, tools granted and used, token/time telemetry, raw payloads. */
function Details({
  view,
  args,
  result,
  resultText,
  granted
}: {
  view: SubagentView | undefined
  args: Record<string, unknown> | undefined
  result: Record<string, unknown> | undefined
  resultText: string | undefined
  granted: string[] | undefined
}): React.JSX.Element {
  const t = view?.telemetry
  const chips: { icon: string; label: string; title: string }[] = []
  if (t?.tokensIn !== undefined) chips.push({ icon: 'input', label: `${fmtTokens(t.tokensIn)} in`, title: 'Input tokens' })
  if (t?.tokensOut !== undefined) chips.push({ icon: 'tag', label: `${fmtTokens(t.tokensOut)} out`, title: 'Output tokens' })
  if (t?.tokensReasoning) chips.push({ icon: 'neurology', label: `${fmtTokens(t.tokensReasoning)} think`, title: 'Reasoning tokens' })
  if (t?.tps) chips.push({ icon: 'speed', label: `${t.tps} tok/s`, title: 'Throughput' })
  if (t?.costUsd !== undefined) chips.push({ icon: 'paid', label: `$${t.costUsd.toFixed(4)}`, title: 'Billed cost' })
  // The raw result is only worth a pre block when it isn't already rendered as the report above.
  const rawResult = resultText === undefined && result ? JSON.stringify(result, null, 2) : ''
  const rawArgs = args ? JSON.stringify(args, null, 2) : ''
  return (
    <div className="subagent-detail">
      {(granted || (view && view.toolsUsed.length > 0)) && (
        <div className="subagent-detail-grid">
          {granted && (
            <>
              <span className="subagent-detail-label">Granted</span>
              <span className="subagent-detail-value">{granted.length ? granted.join(', ') : 'no tools (text only)'}</span>
            </>
          )}
          {view && view.toolsUsed.length > 0 && (
            <>
              <span className="subagent-detail-label">Used</span>
              <span className="subagent-detail-value">{view.toolsUsed.join(', ')}</span>
            </>
          )}
          {view && (view.toolsFailed > 0 || view.thinkingBouts > 0) && (
            <>
              <span className="subagent-detail-label">Activity</span>
              <span className="subagent-detail-value">
                {view.thinkingBouts} {view.thinkingBouts === 1 ? 'bout' : 'bouts'} of thinking · {view.toolsDone} tool
                {view.toolsDone === 1 ? ' call' : ' calls'} ok
                {view.toolsFailed > 0 && <span className="subagent-detail-bad"> · {view.toolsFailed} failed</span>}
              </span>
            </>
          )}
        </div>
      )}
      {chips.length > 0 && (
        <div className="subagent-chips">
          {chips.map((c) => (
            <span key={c.title} className="tchip" title={c.title}>
              <I name={c.icon} size={12} />
              {c.label}
            </span>
          ))}
        </div>
      )}
      {rawArgs && (
        <>
          <div className="subagent-detail-label">Arguments</div>
          <pre>{rawArgs.length > 4000 ? rawArgs.slice(0, 4000) + `\n… [${rawArgs.length - 4000} more chars]` : rawArgs}</pre>
        </>
      )}
      {rawResult && (
        <>
          <div className="subagent-detail-label">Result</div>
          <pre>{rawResult}</pre>
        </>
      )}
    </div>
  )
}
