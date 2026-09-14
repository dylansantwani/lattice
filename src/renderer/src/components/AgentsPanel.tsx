import React, { useEffect, useMemo, useState } from 'react'
import type { BgJobView } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'
import { fmtTokens } from './ContextOrbit'
import { RunTimeline } from './TurnActivity'
import { buildTimeline } from './runTimeline'
import { formatElapsed, useElapsed } from './useElapsed'
import { useSubagentIndex } from './useSubagentIndex'
import { titleCase, type SubagentToolTrace, type SubagentView } from './subagents'
import {
  agentOutcome,
  agentSpanMs,
  agentStatus,
  buildWorkItems,
  FINISHED_PREVIEW,
  indexBriefs,
  jobStatus,
  outputLineCount,
  shortModel,
  summarize,
  type Brief,
  type StatusLine,
  type WorkItem
} from './agentsWork'

/**
 * The Agents panel: everything working for this thread besides the main model, as one list.
 *
 * Two kinds of work land here — subagents the model delegated to (`run_agent`) and shell commands
 * running in the background — and both read the same way: a glyph that says its state, a name, a
 * one-line status ("Reading src/app.ts", "Done · 12 tool calls · 1m 04s", the command's last
 * output line), and how long it has been going. A summary strip on top says at a glance how many
 * are still working and how the rest ended, with one Stop-all for the lot.
 *
 * Rows stay collapsed: a running row already narrates itself, so nothing auto-expands into a wall
 * of streaming detail when three agents fan out at once. Opening a row adds its brief, its recent
 * tool calls, token/cost facts, a jump to the delegation in the transcript, and — one click deeper —
 * the full woven log (thinking, text, every tool call) that used to be the only view.
 */
export function AgentsPanel(): React.JSX.Element {
  const index = useSubagentIndex()
  const events = useStore((s) => s.events)
  const jobs = useStore((s) => s.jobs)
  const loadJobs = useStore((s) => s.loadJobs)
  const stopBackgroundWork = useStore((s) => s.stopBackgroundWork)

  // Jobs are pushed on start/finish/output, but a promoted command's live output is read from its
  // PTY buffer on demand — so while anything runs, refetch on a slow tick to keep the tail moving.
  const anyJobRunning = jobs.some((j) => j.running)
  useEffect(() => {
    void loadJobs()
  }, [loadJobs])
  useEffect(() => {
    if (!anyJobRunning) return
    const t = setInterval(() => void loadJobs(), 1000)
    return () => clearInterval(t)
  }, [anyJobRunning, loadJobs])

  const briefs = useMemo(() => indexBriefs(events), [events])
  const lists = useMemo(() => buildWorkItems(index, briefs, jobs), [index, briefs, jobs])
  const summary = useMemo(() => summarize(lists), [lists])

  const [showAll, setShowAll] = useState(false)
  const [stoppingAll, setStoppingAll] = useState(false)
  useEffect(() => {
    if (lists.working.length === 0) setStoppingAll(false)
  }, [lists.working.length])

  if (lists.working.length + lists.finished.length === 0) {
    return (
      <div className="agents-empty">
        <I name="account_tree" size={22} />
        <div className="title">Nothing delegated yet</div>
        <div className="body">
          When the model hands work to a subagent or moves a long command to the background, it shows up here
          with live status, how long it has run, and a Stop button.
        </div>
      </div>
    )
  }

  const visibleFinished = showAll ? lists.finished : lists.finished.slice(0, FINISHED_PREVIEW)
  const hidden = lists.finished.length - visibleFinished.length

  const stopAll = (): void => {
    setStoppingAll(true)
    const agentIds = lists.working.filter((i) => i.kind === 'agent').map((i) => (i as { view: SubagentView }).view.id)
    const jobIds = lists.working.filter((i) => i.kind === 'job').map((i) => (i as { job: BgJobView }).job.id)
    void stopBackgroundWork(agentIds, jobIds)
  }

  return (
    <div className="ag-panel">
      <div className="ag-summary" aria-label="Summary">
        {summary.working > 0 ? (
          <span className="ag-sum live">
            <I name="autorenew" size={13} className="spin" />
            {summary.working} working
          </span>
        ) : (
          <span className="ag-sum muted">
            <I name="check_circle" size={13} />
            Nothing running
          </span>
        )}
        {summary.done > 0 && (
          <span className="ag-sum ok">
            <I name="check" size={13} />
            {summary.done} done
          </span>
        )}
        {summary.failed > 0 && (
          <span className="ag-sum bad">
            <I name="error" size={13} />
            {summary.failed} failed
          </span>
        )}
        {summary.truncated > 0 && (
          <span className="ag-sum warn">
            <I name="content_cut" size={13} />
            {summary.truncated} cut off
          </span>
        )}
        {summary.stopped > 0 && (
          <span className="ag-sum muted">
            <I name="block" size={13} />
            {summary.stopped} stopped
          </span>
        )}
        {summary.working > 0 && (
          <button className="ag-stop-all" onClick={stopAll} disabled={stoppingAll} title="Stop every running subagent and background job">
            <I name={stoppingAll ? 'autorenew' : 'stop'} size={12} className={stoppingAll ? 'spin' : ''} />
            {stoppingAll ? 'Stopping…' : 'Stop all'}
          </button>
        )}
      </div>

      {lists.working.length > 0 && (
        <section aria-label="Working now">
          <h4 className="ag-section">Working now ({lists.working.length})</h4>
          {lists.working.map((item) => (
            <WorkRow key={item.id} item={item} />
          ))}
        </section>
      )}

      {lists.finished.length > 0 && (
        <section aria-label="Finished">
          <h4 className="ag-section">Finished ({lists.finished.length})</h4>
          {visibleFinished.map((item) => (
            <WorkRow key={item.id} item={item} />
          ))}
          {hidden > 0 && (
            <button className="ag-more" onClick={() => setShowAll(true)}>
              <I name="expand_more" size={14} />
              Show {hidden} older
            </button>
          )}
          {showAll && lists.finished.length > FINISHED_PREVIEW && (
            <button className="ag-more" onClick={() => setShowAll(false)}>
              <I name="expand_less" size={14} />
              Show fewer
            </button>
          )}
        </section>
      )}
    </div>
  )
}

function WorkRow({ item }: { item: WorkItem }): React.JSX.Element {
  return item.kind === 'agent' ? <AgentRow view={item.view} brief={item.brief} /> : <JobRow job={item.job} />
}

/** Keyboard-and-click disclosure handlers for a row header. */
function disclosure(toggle: () => void): React.HTMLAttributes<HTMLDivElement> {
  return {
    role: 'button',
    tabIndex: 0,
    onClick: toggle,
    onKeyDown: (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault()
        toggle()
      }
    }
  }
}

function StopButton({ label, stopping, onStop }: { label: string; stopping: boolean; onStop: () => void }): React.JSX.Element {
  return (
    <button
      className="ag-stop"
      disabled={stopping}
      onClick={(e) => {
        e.stopPropagation()
        onStop()
      }}
      aria-label={label}
      title={label}
    >
      <I name={stopping ? 'autorenew' : 'stop'} size={13} className={stopping ? 'spin' : ''} />
    </button>
  )
}

function Glyph({ status, running }: { status: StatusLine; running: boolean }): React.JSX.Element {
  return (
    <span className={`ag-glyph ${status.tone}`} aria-hidden>
      {running ? <I name="autorenew" size={15} className="spin" /> : <I name={status.icon} size={15} />}
    </span>
  )
}

/**
 * Scroll the transcript to the `run_agent` card that spawned an agent and light it up briefly.
 * The card carries `id="subagent-<callId>"`; if the delegation isn't in the rendered transcript
 * (an older turn folded away), say so instead of silently doing nothing.
 */
function revealInTranscript(callId: string, flash: (text: string, tone?: 'info' | 'warn' | 'error') => void): void {
  const el = document.getElementById(`subagent-${callId}`)
  if (!el) {
    flash('That delegation is not in the visible transcript.', 'warn')
    return
  }
  el.scrollIntoView({ block: 'center', behavior: 'smooth' })
  el.classList.remove('ag-flash')
  // Restart the animation even if the class was just removed.
  void el.getBoundingClientRect()
  el.classList.add('ag-flash')
  window.setTimeout(() => el.classList.remove('ag-flash'), 1800)
}

function AgentRow({ view, brief }: { view: SubagentView; brief?: Brief }): React.JSX.Element {
  const models = useStore((s) => s.models)
  const cancelAgent = useStore((s) => s.cancelAgent)
  const flash = useStore((s) => s.flash)
  const outcome = agentOutcome(view)
  const running = outcome === 'running'
  const status = agentStatus(view)
  const [open, setOpen] = useState(false)
  const [showLog, setShowLog] = useState(false)
  // Once clicked, the button stays disabled: the row stays "running" until the in-flight round
  // actually unwinds, and a second click would just hit an id cancelAgent no longer recognises.
  const [stopping, setStopping] = useState(false)

  const name = view.name ?? (view.role ? titleCase(view.role) : 'Subagent')
  const showRole = !!view.role && view.role.toLowerCase() !== name.toLowerCase()
  // The catalog name when we have it, else the id — either way trimmed of its routing prefix so it
  // fits the chip ("openrouter/minimax/minimax-m3:free" → "minimax-m3:free"; hover for the full id).
  const modelName = view.model ? shortModel(models.find((m) => m.id === view.model)?.name ?? view.model) : undefined
  const ticking = useElapsed(running, view.startedAt)
  const elapsed = running ? ticking : agentSpanMs(view)
  const t = view.telemetry

  return (
    <div className={`ag-row ${outcome}${open ? ' open' : ''}`}>
      <div className="ag-head" aria-expanded={open} {...disclosure(() => setOpen((v) => !v))}>
        <Glyph status={status} running={running} />
        <div className="ag-main">
          <div className="ag-title-line">
            <span className="ag-name" title={name}>
              {name}
            </span>
            {elapsed !== undefined && (
              <span className="ag-elapsed" title={running ? 'Running for' : 'Took'}>
                {formatElapsed(elapsed)}
              </span>
            )}
          </div>
          <div className={`ag-status ${status.tone}`} title={status.text} aria-live={running ? 'polite' : undefined}>
            {running && <I name={status.icon} size={12} className="pulse" />}
            <span className="ag-status-text">{status.text}</span>
            {running && view.toolCalls > 0 && (
              <span className="ag-status-count" title="Tool calls finished / made">
                {view.toolsDone}/{view.toolCalls}
              </span>
            )}
          </div>
        </div>
        <div className="ag-side">
          {running && (
            <StopButton
              label={`Stop ${name}`}
              stopping={stopping}
              onStop={() => {
                setStopping(true)
                void cancelAgent(view.id)
              }}
            />
          )}
          <I name={open ? 'expand_less' : 'expand_more'} size={16} className="ag-chev" />
        </div>
      </div>

      {(running || open) && (showRole || modelName || brief?.background) && (
        <div className="ag-chips">
          {showRole && <span className="ag-chip role">{view.role}</span>}
          {modelName && (
            <span className="ag-chip model" title={view.model}>
              {modelName}
              {view.effort ? ` · ${view.effort}` : ''}
            </span>
          )}
          {brief?.background && (
            <span className="ag-chip bg" title="Runs on its own; its report arrives as a new turn in the transcript">
              background
            </span>
          )}
        </div>
      )}
      {(running || open) && brief?.task && (
        <div className={`ag-brief${open ? ' full' : ''}`} title={open ? undefined : brief.task}>
          {brief.task}
        </div>
      )}
      {running && !open && view.recentTools.length > 0 && <Trail traces={view.recentTools.slice(-3)} />}

      {open && (
        <div className="ag-detail">
          {view.recentTools.length > 0 && (
            <div>
              <div className="ag-label">Recent tool calls</div>
              <Trail traces={view.recentTools} />
            </div>
          )}
          <div className="ag-facts">
            {view.tools && (
              <>
                <span className="ag-fact-k">Tools</span>
                <span className="ag-fact-v" title={view.tools.join(', ') || 'text only'}>
                  {view.tools.length === 0
                    ? 'none (text only)'
                    : `${view.tools.length} granted${view.toolsUsed.length ? ` · ${view.toolsUsed.length} used` : ''}`}
                </span>
              </>
            )}
            {view.thinkingBouts > 0 && (
              <>
                <span className="ag-fact-k">Thinking</span>
                <span className="ag-fact-v">
                  {view.thinkingBouts} {view.thinkingBouts === 1 ? 'bout' : 'bouts'}
                </span>
              </>
            )}
            {t?.tokensIn !== undefined && (
              <>
                <span className="ag-fact-k">Tokens</span>
                <span className="ag-fact-v">
                  {fmtTokens(t.tokensIn)} in · {fmtTokens(t.tokensOut ?? 0)} out
                  {t.tokensReasoning ? ` · ${fmtTokens(t.tokensReasoning)} thinking` : ''}
                </span>
              </>
            )}
            {t?.costUsd !== undefined && (
              <>
                <span className="ag-fact-k">Cost</span>
                <span className="ag-fact-v">${t.costUsd.toFixed(4)}</span>
              </>
            )}
          </div>
          {view.error && (
            <div className="ag-note bad">
              <I name="error" size={14} />
              <span>{view.error}</span>
            </div>
          )}
          <div className="ag-actions">
            {view.parentCallId && (
              <button className="ag-btn" onClick={() => revealInTranscript(view.parentCallId!, flash)}>
                <I name="vertical_align_center" size={13} />
                Show in transcript
              </button>
            )}
            <button className="ag-btn" onClick={() => setShowLog((v) => !v)} aria-expanded={showLog}>
              <I name={showLog ? 'unfold_less' : 'unfold_more'} size={13} />
              {showLog ? 'Hide full log' : 'Full log'}
            </button>
          </div>
          {showLog && <FullLog view={view} />}
        </div>
      )}
    </div>
  )
}

/** The agent's most recent tool calls, oldest → newest, each with its outcome. */
function Trail({ traces }: { traces: SubagentToolTrace[] }): React.JSX.Element {
  const icon = (s: SubagentToolTrace['status']): string =>
    s === 'running' ? 'autorenew' : s === 'requested' ? 'more_horiz' : s === 'complete' ? 'check' : 'error'
  return (
    <ul className="ag-trail" aria-label="Recent tool calls">
      {traces.map((t) => (
        <li key={t.callId} className={`ag-trace ${t.status}`}>
          <I name={icon(t.status)} size={12} className={t.status === 'running' ? 'spin' : ''} />
          <span className="ag-trace-label" title={t.label}>
            {t.label}
          </span>
          {t.durationMs !== undefined && (
            <span className="ag-trace-dur">{t.durationMs < 1000 ? `${Math.round(t.durationMs)}ms` : formatElapsed(t.durationMs)}</span>
          )}
        </li>
      ))}
    </ul>
  )
}

/**
 * The agent's full woven activity — reasoning, spoken text, and tool calls with args and results —
 * rendered with the transcript's own timeline components, styled compact for the column. Built only
 * while it's showing, so a closed row costs nothing per streamed delta.
 */
function FullLog({ view }: { view: SubagentView }): React.JSX.Element {
  const timeline = useMemo(() => buildTimeline(view.events), [view.events])
  const fullText = useMemo(() => timeline.reduce((s, t) => (t.kind === 'output' ? s + t.text : s), ''), [timeline])
  if (timeline.length === 0) {
    return (
      <div className="ag-note">
        <I name="info" size={14} />
        <span>Nothing logged yet.</span>
      </div>
    )
  }
  return (
    <div className="agent-detail">
      <RunTimeline items={timeline} running={view.running} fullText={fullText} model={view.model} />
    </div>
  )
}

function JobRow({ job }: { job: BgJobView }): React.JSX.Element {
  const stopJob = useStore((s) => s.stopJob)
  const [open, setOpen] = useState(false)
  const [stopping, setStopping] = useState(false)
  const status = jobStatus(job)
  const ticking = useElapsed(job.running, job.startedAt)
  const elapsed = job.running ? ticking : (job.endedAt ?? job.startedAt) - job.startedAt
  const lines = outputLineCount(job.output)
  const tail = job.output.split('\n').slice(-60).join('\n').trim()
  const outcome = job.running ? 'running' : job.status === 'done' ? 'done' : job.status === 'failed' ? 'failed' : 'stopped'

  return (
    <div className={`ag-row job ${outcome}${open ? ' open' : ''}`}>
      <div className="ag-head" aria-expanded={open} {...disclosure(() => setOpen((v) => !v))}>
        <Glyph status={status} running={job.running} />
        <div className="ag-main">
          <div className="ag-title-line">
            <span className={`ag-name${job.purpose ? '' : ' mono'}`} title={job.command}>
              {job.purpose ?? job.command}
            </span>
            <span className="ag-elapsed" title={job.running ? 'Running for' : 'Ran for'}>
              {formatElapsed(elapsed)}
            </span>
          </div>
          <div className={`ag-status ${status.tone}${job.running ? ' mono' : ''}`} title={status.text} aria-live={job.running ? 'polite' : undefined}>
            <span className="ag-status-text">{status.text}</span>
            {job.running && lines > 0 && (
              <span className="ag-status-count" title="Lines of output so far">
                {lines} {lines === 1 ? 'line' : 'lines'}
              </span>
            )}
          </div>
        </div>
        <div className="ag-side">
          {job.running && (
            <StopButton
              label="Stop this command"
              stopping={stopping}
              onStop={() => {
                setStopping(true)
                void stopJob(job.id)
              }}
            />
          )}
          <I name={open ? 'expand_less' : 'expand_more'} size={16} className="ag-chev" />
        </div>
      </div>
      {(job.running || open) && (
        <div className="ag-chips">
          <span className="ag-chip job" title={job.promoted ? 'A foreground command that outran its grace window and kept running in the background' : 'Started as a background command'}>
            {job.promoted ? 'moved to background' : 'background command'}
          </span>
        </div>
      )}
      {(job.running || open) && job.purpose && (
        <div className="ag-brief mono" title={job.command}>
          {job.command}
        </div>
      )}
      {open && <pre className="ag-output">{tail || '(no output yet)'}</pre>}
    </div>
  )
}
