import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AgentKind, AgentWorkingMemory, ApprovalRequest, AskRequest, ContextBudget, Fleet, FleetActivityItem, FleetAgentView, FleetChange, Mode, ModelInfo, PermissionPreset, RunEvent, SessionActivity } from '@shared/types'
import { useStore } from '@/state/store'
import { I } from './Icon'
import { RunTimeline } from './TurnActivity'
import { buildTimeline } from './runTimeline'
import { describeFleetChange, fleetCounts, fleetReasoningLabel, fleetTreeRoutes, latestFleetRun, plainPreview, type FleetBox, type FleetRoute } from './fleetView'
import { EFFORT_TIERS, effortLabel, resolveEffortTiers } from './effort'
import { formatUsd, type TaskUsage } from '@shared/taskUsage'

/**
 * The Agent Fleet — a full-window dashboard for a persistent orchestrator plus its dedicated worker
 * agents. Unlike the ephemeral subagents `run_agent` spawns, a fleet agent lives on: it keeps its own
 * thread, role, working memory and working directory (each new worker task starts on a clean context).
 *
 * The screen is a real view, not a dialog: the orchestrator sits at the top with a command bar you
 * type tasks into, and its workers are big status cards below. Selecting any agent slides in a panel
 * to configure it or message it (delegate / steer / queue / discuss). Self-contained, like Sessions:
 * it talks to `window.lattice.*` directly and only reaches into the store to jump to a thread.
 */

const MODES: Mode[] = ['act', 'plan', 'review']
const PRESETS: PermissionPreset[] = ['workspace', 'manual', 'full']

interface AgentForm {
  name: string
  kind: AgentKind
  role: string
  model: string
  effort: string
  mode: Mode
  permissionPreset: PermissionPreset
  cwd: string
  rolling: boolean
  allowedTools: string
}

function blankForm(kind: AgentKind, model: string, effort = ''): AgentForm {
  return {
    name: kind === 'orchestrator' ? 'Orchestrator' : '',
    kind,
    role:
      kind === 'orchestrator'
        ? 'You are the orchestrator of a fleet of dedicated agents. Use list_fleet to see your agents and delegate_to_agent to hand each one work in its domain. Keep your own replies short; do the real work through your agents, check on them with peek_session, and report back to the user. Never take an irreversible action (purchase, send, publish) without the user’s go-ahead.'
        : '',
    model,
    effort,
    mode: 'act',
    // Agents run unattended: under `workspace` every web/MCP/shell call parks on an approval card in
    // a hidden thread, which is how a fleet "silently dies". Full is the working default.
    permissionPreset: 'full',
    cwd: '',
    rolling: true,
    allowedTools: ''
  }
}

/** Builtin tool names a worker allowlist can name — shown as a hint under the Tools field. */
const TOOL_HINT =
  'web_search, web_fetch, fetch_image, fs_read, fs_write, fs_edit, fs_list, grep_search, shell, start_job, ' +
  'memory_save, todo_write, find_mcp'

const STYLE = `
.fleet-screen { position: fixed; inset: 0; z-index: 60; background: var(--canvas); color: var(--text);
  font-family: var(--font-ui); display: flex; flex-direction: column; }
.fleet-top { min-height: 56px; flex: none; display: flex; align-items: center; gap: 10px;
  padding: 0 18px 0 calc(84px / var(--zoom, 1)); border-bottom: 1px solid var(--hairline); background: var(--shell);
  -webkit-app-region: drag; }
.fleet-top button, .fleet-top select { -webkit-app-region: no-drag; }
.fleet-top .fleet-mark { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 15px; }
.fleet-top select { background: var(--raised); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 5px 8px; font-size: 13px; min-width: 0; max-width: 220px; }
.fleet-spacer { flex: 1; }
.fleet-ghost { background: transparent; color: var(--text-dim); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 6px 12px; font-size: 13px; cursor: pointer; }
.fleet-ghost:hover { background: var(--raised); color: var(--text); }

.fleet-body { flex: 1; overflow: auto; padding: 38px 34px 80px; }
.fleet-inner { max-width: 1220px; margin: 0 auto; }

.fleet-orch { display: grid; grid-template-columns: auto 1fr auto; gap: 18px; align-items: center;
  background: var(--panel); border: 1px solid var(--hairline-strong); border-left: 3px solid var(--violet);
  border-radius: var(--radius); padding: 22px 24px; }
.fleet-orch .fleet-orch-text { cursor: pointer; }
.fleet-orch .badge-hub { width: 50px; height: 50px; border-radius: 13px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--violet) 22%, transparent); color: var(--violet-soft); cursor: pointer; }
.fleet-orch h2 { margin: 0 0 4px; font-size: 21px; }
.fleet-orch-model { display: flex; flex-direction: column; gap: 5px; min-width: 200px; }
.fleet-orch-model select { background: var(--raised); color: var(--text); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; }
.fleet-mini-label { font-size: 10px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }
.fleet-agents-label { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); margin: 0 2px; }
.fleet-kicker { font-size: 11px; letter-spacing: .06em; text-transform: uppercase; color: var(--violet-soft); }
.fleet-role { color: var(--text-dim); font-size: 13.5px; line-height: 1.5; margin-top: 7px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }

.fleet-command { display: flex; gap: 8px; align-items: center; margin: 16px 0 4px; }
.fleet-command input { flex: 1; height: 50px; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline-strong); border-radius: var(--radius); padding: 0 16px; font-size: 15px; }
.fleet-command input:focus { outline: none; border-color: var(--violet); }
.fleet-command select { height: 50px; background: var(--raised); color: var(--text-dim);
  border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 0 8px; font-size: 12px; }
.fleet-send { height: 50px; padding: 0 22px; border: none; border-radius: var(--radius); cursor: pointer;
  background: var(--violet); color: #16131f; font-weight: 600; font-size: 15px; }
.fleet-send:disabled { opacity: .45; cursor: default; }

/* The tree: orchestrator console -> hub -> a rail -> one line into every agent card. Lines are measured
   from the laid-out DOM (fleetTreeRoutes) and drawn in an SVG behind the cards, so they stay attached
   through wrapping, resizing and cards growing taller. */
.fleet-tree { position: relative; }
.fleet-lines { position: absolute; left: 0; top: 0; pointer-events: none; z-index: 0; overflow: visible; }
.fleet-lines path { fill: none; stroke: color-mix(in srgb, var(--violet) 42%, var(--hairline-strong)); stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round; }
.fleet-lines path.add { stroke: var(--hairline-strong); stroke-dasharray: 3 5; }
.fleet-lines path.needs { stroke: var(--brass); stroke-width: 2; }
.fleet-lines path.error { stroke: color-mix(in srgb, var(--red) 70%, var(--hairline-strong)); stroke-width: 1.75; }
.fleet-lines path.running { stroke: color-mix(in srgb, var(--green) 45%, transparent); stroke-width: 2; }
.fleet-lines path.flow { stroke: var(--green); stroke-width: 2.25; stroke-dasharray: 2 10; animation: fleetFlow .9s linear infinite; }
.fleet-lines path.stem.live { stroke: var(--green); }
.fleet-lines .tip { fill: none; stroke-width: 1.5; }
@keyframes fleetFlow { to { stroke-dashoffset: -24; } }
@media (prefers-reduced-motion: reduce) { .fleet-lines path.flow { animation: none; stroke-dasharray: none; } }
.fleet-tree-head { position: relative; z-index: 1; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;
  justify-content: space-between; margin-top: 30px; }
.fleet-hub-node { position: relative; z-index: 1; display: flex; justify-content: center; margin: 14px 0 0; }
.fleet-hub-node > span { display: inline-flex; align-items: center; gap: 6px; font-size: 10.5px; letter-spacing: .08em;
  text-transform: uppercase; color: var(--violet-soft); background: var(--canvas);
  border: 1px solid color-mix(in srgb, var(--violet) 45%, var(--hairline-strong)); border-radius: 999px; padding: 4px 11px; }
.fleet-hub-node > span.live { color: var(--green); border-color: color-mix(in srgb, var(--green) 55%, var(--hairline-strong)); }
.fleet-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 18px; margin-top: 10px; }
.fleet-tree .fleet-grid { position: relative; z-index: 1; margin-top: 44px; row-gap: 52px; }
.fleet-card { background: var(--panel); border: 1px solid var(--hairline-strong); border-radius: var(--radius);
  padding: 16px; cursor: pointer; display: flex; flex-direction: column; gap: 10px; min-width: 0;
  transition: border-color .12s, box-shadow .12s; text-align: left; position: relative; }
.fleet-card:hover { border-color: color-mix(in srgb, var(--violet) 55%, var(--hairline-strong)); }
.fleet-card.running { border-color: color-mix(in srgb, var(--green) 55%, var(--hairline-strong)); }
.fleet-card.needs { border-color: var(--brass); }
.fleet-card.error { border-color: color-mix(in srgb, var(--red) 55%, var(--hairline-strong)); }
.fleet-card.sel { border-color: var(--violet); box-shadow: 0 0 0 1px var(--violet); }
.fleet-card-open { border: 0; padding: 0; margin: 0; width: 100%; flex: 1; background: transparent; color: inherit;
  font: inherit; cursor: pointer; display: flex; flex-direction: column; gap: 12px; text-align: left; }
.fleet-card-open:focus-visible { outline: 2px solid var(--violet); outline-offset: 5px; border-radius: var(--radius-sm); }
.fleet-card .head { display: flex; align-items: center; gap: 9px; min-width: 0; }
.fleet-card .head .fleet-status { margin-left: auto; flex: none; font-weight: 500; font-size: 11.5px; }
.fleet-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.fleet-dot.running { background: var(--green); box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 70%, transparent);
  animation: fleetPulse 1.6s infinite; }
.fleet-dot.queued { background: var(--brass); }
.fleet-dot.idle { background: var(--text-faint); }
@keyframes fleetPulse { 0% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--green) 60%, transparent); }
  70% { box-shadow: 0 0 0 7px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
.fleet-card .name { font-weight: 600; font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-card .sub { color: var(--text-faint); font-size: 12px; }
.fleet-card .role { color: var(--text-dim); font-size: 12.5px; line-height: 1.4; flex: 1;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.fleet-chips { display: flex; flex-wrap: wrap; gap: 6px; }
.fleet-chip { font-size: 11px; color: var(--text-dim); background: var(--raised);
  border: 1px solid var(--hairline); border-radius: 999px; padding: 2px 8px; max-width: 100%;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.fleet-status { font-size: 12px; font-weight: 600; }
.fleet-status.running { color: var(--green); }
.fleet-status.queued { color: var(--brass); }
.fleet-status.idle { color: var(--text-faint); }
.fleet-chip.warn { color: var(--brass); border-color: color-mix(in srgb, var(--brass) 45%, var(--hairline)); }
.fleet-summary { display: flex; gap: 6px; flex-wrap: wrap; }
.fleet-summary > span { display: inline-flex; align-items: center; gap: 6px; background: var(--panel);
  border: 1px solid var(--hairline); border-radius: 999px; padding: 3px 10px; color: var(--text-dim); font-size: 12px; }
.fleet-summary .live { color: var(--green); }
.fleet-summary .needs { color: var(--brass); }
.fleet-summary .bad { color: var(--red); }

.fleet-add { border: 1px dashed var(--hairline-strong); background: transparent; color: var(--text-dim);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 6px; font-size: 13px; cursor: pointer; min-height: 138px;
  border-radius: var(--radius); position: relative; }
.fleet-add:hover { border-color: var(--violet); color: var(--text); }

.fleet-empty { text-align: center; color: var(--text-dim); padding: 60px 20px; }
.fleet-empty h2 { color: var(--text); margin: 0 0 8px; }
.fleet-empty p { max-width: 460px; margin: 0 auto 18px; line-height: 1.5; }

.fleet-backdrop { position: fixed; inset: 0; background: rgba(0,0,0,.4); z-index: 61; }
.fleet-drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(460px, 92vw); z-index: 62;
  background: var(--shell); border-left: 1px solid var(--hairline); display: flex; flex-direction: column;
  box-shadow: -18px 0 40px rgba(0,0,0,.35); }
.fleet-drawer-head { flex: none; display: flex; align-items: center; gap: 10px; padding: 16px 18px;
  border-bottom: 1px solid var(--hairline); }
.fleet-drawer-head .name { font-weight: 600; font-size: 16px; flex: 1; }
.fleet-drawer-body { flex: 1; overflow: auto; padding: 16px 18px; display: flex; flex-direction: column; gap: 16px; }
.fleet-section-label { font-size: 11px; letter-spacing: .06em; text-transform: uppercase;
  color: var(--text-faint); margin-bottom: 8px; }
.fleet-msg textarea, .fleet-field input, .fleet-field textarea, .fleet-field select {
  width: 100%; background: var(--panel); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 8px 10px; font-size: 13px; font-family: inherit; box-sizing: border-box; }
.fleet-field { display: flex; flex-direction: column; gap: 4px; }
.fleet-field > span { font-size: 11px; color: var(--text-faint); }
.fleet-two { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.fleet-row { display: flex; gap: 8px; align-items: center; }
.fleet-btn { border: 1px solid var(--hairline); background: var(--raised); color: var(--text);
  border-radius: var(--radius-sm); padding: 7px 12px; font-size: 13px; cursor: pointer; }
.fleet-btn:hover { border-color: var(--hairline-strong); }
.fleet-btn.primary { background: var(--violet); color: #16131f; border-color: transparent; font-weight: 600; }
.fleet-btn.danger { color: var(--red); }
.fleet-btn:disabled { opacity: .5; cursor: default; }
.fleet-check { display: flex; gap: 8px; align-items: flex-start; font-size: 12px; color: var(--text-dim); line-height: 1.4; }


.fleet-needs { background: color-mix(in srgb, var(--brass) 12%, var(--panel)); border: 1px solid var(--brass);
  border-radius: var(--radius); padding: 16px 18px; margin-bottom: 18px; display: flex; flex-direction: column; gap: 4px; }
.fleet-needs h3 { margin: 0 0 6px; font-size: 13px; letter-spacing: .04em; text-transform: uppercase;
  color: var(--brass); display: flex; align-items: center; gap: 8px; }
.fleet-need { display: flex; flex-direction: column; gap: 9px; padding: 12px 0; border-top: 1px solid var(--hairline); }
.fleet-need:first-of-type { border-top: none; }
.fleet-need .who { font-size: 12px; color: var(--brass); font-weight: 600; }
.fleet-need .q { color: var(--text); font-size: 14.5px; line-height: 1.45; }
.fleet-need .answer { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.fleet-need input { flex: 1; min-width: 220px; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline-strong); border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; }

.fleet-model-btn { width: 100%; background: var(--raised); color: var(--text); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius-sm); padding: 9px 11px; font-size: 13px; cursor: pointer; text-align: left;
  display: flex; justify-content: space-between; gap: 8px; align-items: center; }
.fleet-model-btn:hover { border-color: var(--violet); }
.fleet-model-btn .chev { color: var(--text-faint); }

.fleet-live { background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  padding: 12px; display: flex; flex-direction: column; gap: 7px; }
.fleet-live .doing { color: var(--green); font-size: 13.5px; display: flex; gap: 7px; align-items: center; }
.fleet-live .tool { font-size: 12px; color: var(--text-dim); display: flex; gap: 7px; align-items: center; }
.fleet-live .tool .t-name { color: var(--text); }
.fleet-head { position: relative; z-index: 1; }
.fleet-card .preview { color: var(--text-dim); font-size: 12.5px; line-height: 1.4; flex: none; max-height: 2.8em;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; overflow-wrap: anywhere; }
.fleet-card .fleet-chips { margin-top: auto; }
.fleet-card .preview.live { color: var(--green); }
.fleet-feed { margin-top: 28px; background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius); }
.fleet-feed-head { display: flex; align-items: center; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--hairline);
  font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--text-faint); }
.fleet-feed-empty { padding: 16px; color: var(--text-faint); font-size: 13px; }
.fleet-feed-item { display: grid; grid-template-columns: 64px 1fr; gap: 12px; padding: 10px 16px; border-top: 1px solid var(--hairline);
  cursor: pointer; text-align: left; background: transparent; border-left: none; border-right: none; border-bottom: none; color: inherit; width: 100%; }
.fleet-feed-item:first-of-type { border-top: none; }
.fleet-feed-item:hover { background: var(--raised); }
.fleet-feed-item .when { font-size: 11.5px; color: var(--text-faint); padding-top: 2px; }
.fleet-feed-item .route { font-size: 12.5px; font-weight: 600; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.fleet-feed-item .route .arrow { color: var(--text-faint); font-weight: 400; }
.fleet-feed-item .route .tag { font-size: 10.5px; font-weight: 500; color: var(--text-faint); border: 1px solid var(--hairline); border-radius: 999px; padding: 0 6px; }
.fleet-feed-item .body { color: var(--text-dim); font-size: 12.5px; line-height: 1.45; margin-top: 3px;
  display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; white-space: pre-wrap; }
.fleet-feed-item.open .body { display: block; -webkit-line-clamp: unset; }
.fleet-dot.needs { background: var(--brass); }
.fleet-dot.error { background: var(--red); }
.fleet-status.needs { color: var(--brass); }
.fleet-status.error { color: var(--red); }
.fleet-console { margin: 22px 0 0; position: relative; z-index: 1; background: var(--panel); border: 1px solid var(--hairline-strong);
  border-radius: var(--radius); overflow: hidden; box-shadow: inset 0 2px 0 color-mix(in srgb, var(--violet) 78%, transparent); }
.fleet-console-head { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--hairline); }
.fleet-console.collapsed .fleet-console-head { border-bottom: 0; }
.fleet-console-toggle { min-width: 76px; }
.fleet-console-title { display: flex; align-items: center; gap: 8px; font-weight: 650; font-size: 13.5px; flex: 1; }
.fleet-console-title small { color: var(--text-faint); font-weight: 400; }
.fleet-console-meta { display: flex; align-items: center; gap: 9px; flex-wrap: wrap; padding: 10px 16px;
  background: color-mix(in srgb, var(--raised) 65%, transparent); border-bottom: 1px solid var(--hairline); }
.fleet-context { display: flex; align-items: center; gap: 8px; color: var(--text-dim); font-size: 11.5px; min-width: 210px; }
.fleet-context-track { width: 92px; height: 5px; overflow: hidden; border-radius: 999px; background: var(--hairline-strong); }
.fleet-context-fill { display: block; height: 100%; border-radius: inherit; background: var(--violet); }
.fleet-context-fill.warm { background: var(--brass); }
.fleet-context-fill.hot { background: var(--red); }
.fleet-console-body { padding: 14px 16px 16px; min-height: 84px; max-height: 380px; overflow: auto; }
.fleet-console-body .agent-detail { margin: 0; padding: 0; border: 0; }
.fleet-console-empty { color: var(--text-faint); font-size: 13px; line-height: 1.5; padding: 8px 2px; }
.fleet-card-context { display: flex; align-items: center; gap: 7px; color: var(--text-faint); font-size: 10.5px; }
.fleet-card-context .fleet-context-track { flex: 1; width: auto; }
.fleet-card-context.pending { min-height: 5px; opacity: .72; }
.fleet-card-task { display: flex; align-items: center; gap: 7px; color: var(--text-faint); font-size: 10.5px; min-width: 0; }
.fleet-card-task .n { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--text-dim); }
.fleet-card-task .usd { flex: none; font-variant-numeric: tabular-nums; color: var(--text); font-weight: 600; }
.fleet-card-task.warm .usd, .fleet-task-chip.warm { color: var(--brass); }
.fleet-card-task.hot .usd, .fleet-task-chip.hot { color: var(--red); }
.fleet-effort { display: flex; align-items: center; gap: 7px; color: var(--text-faint); font-size: 10.5px; }
.fleet-effort span { flex: none; }
.fleet-effort select { flex: 1; min-width: 0; background: var(--raised); color: var(--text); border: 1px solid var(--hairline);
  border-radius: var(--radius-sm); padding: 5px 7px; font-size: 11px; }
.fleet-effort select:focus-visible { outline: 2px solid var(--violet); outline-offset: 1px; }
.fleet-log-head { display: flex; align-items: center; gap: 8px; }
.fleet-log-head .fleet-section-label { flex: 1; margin: 0; }
.fleet-log-meta { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; }
.fleet-log { background: var(--panel); border: 1px solid var(--hairline); border-radius: var(--radius-sm);
  padding: 10px 12px; min-height: 54px; }
.fleet-log .agent-detail { margin: 0; padding: 0; border: 0; }
.fleet-log-empty { color: var(--text-faint); font-size: 12.5px; padding: 8px 2px; }
.fleet-memory textarea { width: 100%; min-height: 260px; resize: vertical; background: var(--panel); color: var(--text);
  border: 1px solid var(--hairline); border-radius: var(--radius-sm); padding: 10px 12px; box-sizing: border-box;
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace); font-size: 12px; line-height: 1.5; }
.fleet-memory textarea:focus { outline: none; border-color: var(--violet); }
.fleet-memory-meta { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 0 0 8px; font-size: 11.5px; color: var(--text-faint); }
.fleet-memory-meta .path { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; flex: 1; }
.fleet-memory-meta .over { color: var(--brass); }
.fleet-memory-note { font-size: 12px; color: var(--text-dim); line-height: 1.45; margin: 0 0 8px; }
.fleet-change .route .tag.agent { color: var(--violet); border-color: var(--violet); }
.fleet-change-reason { color: var(--text-dim); font-size: 12.5px; margin-top: 3px; }
.fleet-change-fields { display: none; margin-top: 8px; gap: 8px; flex-direction: column; }
.fleet-feed-item.open .fleet-change-fields { display: flex; }
.fleet-change-field .label { font-size: 10.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--text-faint); }
.fleet-change-field .before, .fleet-change-field .after { font-size: 12px; line-height: 1.45; white-space: pre-wrap;
  padding: 6px 8px; border-radius: var(--radius-sm); margin-top: 3px; max-height: 220px; overflow: auto; }
.fleet-change-field .before { background: color-mix(in srgb, var(--red) 10%, transparent); color: var(--text-dim); }
.fleet-change-field .after { background: color-mix(in srgb, var(--green) 10%, transparent); color: var(--text); }
@media (max-width: 760px) {
  .fleet-top { gap: 6px; overflow-x: auto; }
  .fleet-top .fleet-ghost { padding-inline: 8px; white-space: nowrap; }
  .fleet-body { padding-inline: 16px; }
  .fleet-orch { grid-template-columns: auto 1fr; }
  .fleet-orch-model { grid-column: 1 / -1; min-width: 0; }
  .fleet-console-head { align-items: flex-start; flex-wrap: wrap; }
  .fleet-tree .fleet-grid { grid-template-columns: 1fr; }
  .fleet-two { grid-template-columns: 1fr; }
  .fleet-model-btn > span:first-child { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
}
`

export function FleetScreen(): React.JSX.Element | null {
  const open = useStore((s) => s.ui.fleetOpen)
  const setUi = useStore((s) => s.setUi)
  const selectThread = useStore((s) => s.selectThread)
  const flash = useStore((s) => s.flash)
  const models = useStore((s) => s.models)
  const settings = useStore((s) => s.settings)
  const openModelPicker = useStore((s) => s.openModelPicker)
  const asks = useStore((s) => s.asks)
  const approvals = useStore((s) => s.approvals)
  const respondAsk = useStore((s) => s.respondAsk)
  const respondApproval = useStore((s) => s.respondApproval)
  const defaultModel = settings?.defaultModel ?? models[0]?.id ?? ''
  const nameOf = (id: string): string => (id ? models.find((m) => m.id === id)?.name ?? id : 'Choose model')

  const [fleets, setFleets] = useState<Fleet[]>([])
  const [fleetId, setFleetId] = useState<string | null>(null)
  const [agents, setAgents] = useState<FleetAgentView[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [adding, setAdding] = useState<AgentKind | null>(null)
  const [form, setForm] = useState<AgentForm>(() => blankForm('worker', defaultModel, settings?.defaultEffort ?? ''))
  const [msg, setMsg] = useState('')
  const [disposition, setDisposition] = useState<'send' | 'steer' | 'queue'>('send')
  const [busy, setBusy] = useState(false)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  const [detail, setDetail] = useState<SessionActivity | null>(null)
  const [detailEvents, setDetailEvents] = useState<RunEvent[]>([])
  const [showLog, setShowLog] = useState(true)
  const [showOrchestratorOutput, setShowOrchestratorOutput] = useState(true)
  const [feed, setFeed] = useState<FleetActivityItem[]>([])
  const [feedOpen, setFeedOpen] = useState<string | null>(null)
  const [changes, setChanges] = useState<FleetChange[]>([])
  const [changeOpen, setChangeOpen] = useState<string | null>(null)
  const [memory, setMemory] = useState<AgentWorkingMemory | null>(null)
  const [memDraft, setMemDraft] = useState('')
  const [memNote, setMemNote] = useState('')
  const [budgets, setBudgets] = useState<Record<string, ContextBudget>>({})
  const [orchDetail, setOrchDetail] = useState<SessionActivity | null>(null)
  const [orchEvents, setOrchEvents] = useState<RunEvent[]>([])
  const [budgetsLoaded, setBudgetsLoaded] = useState(false)
  const [memoryStatus, setMemoryStatus] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle')
  const drawerRef = useRef<HTMLElement | null>(null)

  const fleetIdRef = useRef<string | null>(null)
  fleetIdRef.current = fleetId

  const orchestrator = useMemo(() => agents.find((a) => a.kind === 'orchestrator'), [agents])
  const workers = useMemo(
    () => agents.filter((a) => a.kind === 'worker').sort((a, b) => a.sortOrder - b.sortOrder),
    [agents]
  )
  const selected = useMemo(() => agents.find((a) => a.id === selectedId) ?? null, [agents, selectedId])
  const counts = useMemo(() => fleetCounts(agents), [agents])
  const selectedModel = useMemo(() => models.find((m) => m.id === selected?.model), [models, selected?.model])
  const latestEvents = useMemo(() => latestFleetRun(detailEvents), [detailEvents])
  const timeline = useMemo(() => buildTimeline(latestEvents), [latestEvents])
  const timelineText = useMemo(
    () => timeline.reduce((text, item) => (item.kind === 'output' ? text + item.text : text), ''),
    [timeline]
  )
  const orchLatestEvents = useMemo(() => latestFleetRun(orchEvents), [orchEvents])
  const orchTimeline = useMemo(() => buildTimeline(orchLatestEvents), [orchLatestEvents])
  const orchTimelineText = useMemo(
    () => orchTimeline.reduce((text, item) => (item.kind === 'output' ? text + item.text : text), ''),
    [orchTimeline]
  )
  const orchLastReply = useMemo(
    () => orchDetail?.messages.slice().reverse().find((message) => message.role === 'assistant')?.text,
    [orchDetail]
  )

  // Pending questions/approvals for any agent in this fleet — surfaced right on the screen so an
  // orchestrator escalating with ask_user (or a mid-run approval) is answerable here, not buried in
  // a hidden agent thread. The store already tracks every pending ask/approval across threads.
  const agentByThread = useMemo(() => new Map(agents.map((a) => [a.threadId, a])), [agents])
  const pendingAsks = useMemo(() => asks.filter((a) => agentByThread.has(a.threadId)), [asks, agentByThread])
  const pendingApprovals = useMemo(
    () => approvals.filter((a) => agentByThread.has(a.threadId)),
    [approvals, agentByThread]
  )

  // Live "what is it doing now" for the open agent, refreshed while the drawer is up.
  const selThread = selected?.threadId
  useEffect(() => {
    if (!open || !selThread || adding) {
      setDetail(null)
      setDetailEvents([])
      return
    }
    let cancelled = false
    const load = (): void => {
      void Promise.all([
        window.lattice.getSessionActivity(selThread),
        window.lattice.getThread(selThread, { eventLimit: 400, messageLimit: 1 })
      ])
        .then(([d, thread]) => {
          if (!cancelled) {
            setDetail(d)
            setDetailEvents(thread.events)
          }
        })
        .catch(() => {})
    }
    load()
    const t = window.setInterval(load, 2000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [open, selThread, adding])

  // The orchestrator is the fleet's voice. Keep its latest run visible on the main screen even when
  // no drawer is open, so delegations never make its own progress and final response disappear.
  const orchThread = orchestrator?.threadId
  useEffect(() => {
    if (!open || !orchThread) {
      setOrchDetail(null)
      setOrchEvents([])
      return
    }
    let cancelled = false
    const load = (): void => {
      void Promise.all([
        window.lattice.getSessionActivity(orchThread),
        window.lattice.getThread(orchThread, { eventLimit: 400, messageLimit: 8 })
      ]).then(([activity, thread]) => {
        if (!cancelled) {
          setOrchDetail(activity)
          setOrchEvents(thread.events)
        }
      }).catch(() => {})
    }
    load()
    const timer = window.setInterval(load, 2000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [open, orchThread])

  // The tree's lines are geometry: measured from the laid-out console, hub and cards after every
  // layout change (resize, wrap, cards growing, the console folding) and routed by fleetTreeRoutes.
  const treeRef = useRef<HTMLDivElement | null>(null)
  const hubRef = useRef<HTMLDivElement | null>(null)
  const consoleRef = useRef<HTMLElement | null>(null)
  const [routes, setRoutes] = useState<FleetRoute[]>([])
  const [stem, setStem] = useState('')
  const [treeSize, setTreeSize] = useState({ w: 0, h: 0 })
  const measureTree = useCallback(() => {
    const tree = treeRef.current
    const hub = hubRef.current?.firstElementChild
    if (!tree || !hub) return
    const origin = tree.getBoundingClientRect()
    const box = (el: Element): FleetBox => {
      const r = el.getBoundingClientRect()
      return { x: r.left - origin.left, y: r.top - origin.top, w: r.width, h: r.height }
    }
    const hubBox = box(hub)
    const nodes = Array.from(tree.querySelectorAll<HTMLElement>('[data-tree-node]'))
    const next = fleetTreeRoutes(hubBox, nodes.map((el) => ({ id: el.dataset.treeNode!, box: box(el) })))
    const cx = Math.round((hubBox.x + hubBox.w / 2) * 10) / 10
    const consoleEl = consoleRef.current
    const top = consoleEl ? Math.round((consoleEl.getBoundingClientRect().bottom - origin.top) * 10) / 10 : 0
    setStem(consoleEl ? `M ${cx} ${top} L ${cx} ${Math.round(hubBox.y * 10) / 10}` : '')
    setTreeSize((size) => (size.w === origin.width && size.h === origin.height ? size : { w: origin.width, h: origin.height }))
    setRoutes((prev) => (prev.length === next.length && prev.every((r, i) => r.id === next[i]!.id && r.d === next[i]!.d) ? prev : next))
  }, [])
  const rosterKey = useMemo(() => agents.map((a) => `${a.id}:${a.kind}`).join('|'), [agents])
  useLayoutEffect(() => {
    if (!open) return
    let frame = 0
    const schedule = (): void => {
      window.cancelAnimationFrame(frame)
      frame = window.requestAnimationFrame(measureTree)
    }
    measureTree()
    const observer = new ResizeObserver(schedule)
    const tree = treeRef.current
    if (tree) {
      observer.observe(tree)
      tree.querySelectorAll('[data-tree-node]').forEach((el) => observer.observe(el))
    }
    if (consoleRef.current) observer.observe(consoleRef.current)
    window.addEventListener('resize', schedule)
    return () => {
      window.cancelAnimationFrame(frame)
      observer.disconnect()
      window.removeEventListener('resize', schedule)
    }
  }, [open, rosterKey, measureTree, showOrchestratorOutput])

  const contextThreads = useMemo(() => agents.map((agent) => agent.threadId).sort().join('|'), [agents])
  useEffect(() => {
    if (!open || !contextThreads) {
      setBudgets({})
      setBudgetsLoaded(false)
      return
    }
    setBudgetsLoaded(false)
    const threadIds = contextThreads.split('|')
    let cancelled = false
    const load = (): void => {
      void Promise.all(threadIds.map(async (threadId) => [threadId, await window.lattice.getContextBudget(threadId).catch(() => null)] as const))
        .then((rows) => {
          if (cancelled) return
          setBudgets(Object.fromEntries(rows.filter((row): row is readonly [string, ContextBudget] => row[1] !== null)))
          setBudgetsLoaded(true)
        })
    }
    load()
    const timer = window.setInterval(load, 10000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [open, contextThreads])

  // The open agent's working memory. Refreshed on a timer only while the editor holds no unsaved
  // edits, so the agent's own writes show up live without ever clobbering what the user is typing.
  const selAgentId = selected && !adding ? selected.id : null
  const memDirty = memory !== null && memDraft !== memory.content
  const memDirtyRef = useRef(false)
  memDirtyRef.current = memDirty
  useEffect(() => {
    setMemNote('')
    if (!open || !selAgentId) {
      setMemory(null)
      setMemDraft('')
      setMemoryStatus('idle')
      return
    }
    setMemoryStatus('loading')
    let cancelled = false
    const load = (force: boolean): void => {
      if (!force && memDirtyRef.current) return
      void window.lattice
        .getAgentWorkingMemory(selAgentId)
        .then((m) => {
          if (cancelled || (!force && memDirtyRef.current)) return
          setMemory(m)
          setMemDraft(m.content)
          setMemoryStatus('ready')
        })
        .catch(() => { if (!cancelled) setMemoryStatus('error') })
    }
    load(true)
    const t = window.setInterval(() => load(false), 4000)
    return () => {
      cancelled = true
      window.clearInterval(t)
    }
  }, [open, selAgentId])

  const saveMemory = async (): Promise<void> => {
    if (!selAgentId || !memDirty) return
    try {
      const m = await window.lattice.setAgentWorkingMemory(selAgentId, memDraft, memory?.updatedAt ?? null)
      setMemory(m)
      setMemDraft(m.content)
      setMemNote('Saved — the agent reads it at the start of its next run.')
    } catch (err) {
      setMemNote(err instanceof Error ? err.message : String(err))
      const latest = await window.lattice.getAgentWorkingMemory(selAgentId).catch(() => null)
      if (latest) setMemory(latest)
    }
  }

  const loadAgents = useCallback(async (id: string) => {
    const [list, activity, changeLog] = await Promise.all([
      window.lattice.listAgents(id).catch(() => [] as FleetAgentView[]),
      window.lattice.listFleetActivity(id, 40).catch(() => [] as FleetActivityItem[]),
      window.lattice.listFleetChanges(id, 30).catch(() => [] as FleetChange[])
    ])
    if (fleetIdRef.current === id) {
      setAgents(list)
      setFeed(activity)
      setChanges(changeLog)
    }
  }, [])

  const loadFleets = useCallback(async () => {
    let list = await window.lattice.listFleets().catch(() => [] as Fleet[])
    if (list.length === 0) {
      const created = await window.lattice.createFleet({ name: 'My Fleet' }).catch(() => null)
      if (created) list = [created]
    }
    setFleets(list)
    const next = list.find((f) => f.id === fleetIdRef.current) ?? list[0]
    if (next) {
      setFleetId(next.id)
      fleetIdRef.current = next.id
      await loadAgents(next.id)
    }
  }, [loadAgents])

  useEffect(() => {
    if (!open) return
    void loadFleets()
  }, [open, loadFleets])

  useEffect(() => {
    if (!open) return
    const off = window.lattice.onPush((event) => {
      if (
        event.kind === 'fleet.updated' ||
        event.kind === 'thread.updated' ||
        event.kind === 'thread.deleted' ||
        event.kind === 'session.message'
      ) {
        const id = fleetIdRef.current
        if (id) void loadAgents(id)
      }
    })
    const timer = window.setInterval(() => {
      const id = fleetIdRef.current
      if (id) void loadAgents(id)
    }, 2500)
    return () => {
      off()
      window.clearInterval(timer)
    }
  }, [open, loadAgents])

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        if (selectedId || adding) {
          setSelectedId(null)
          setAdding(null)
        } else setUi({ fleetOpen: false })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, setUi, selectedId, adding])

  // Keep keyboard focus inside the modal side sheet and restore it to the card/control that opened
  // the sheet. Otherwise Tab can reach obscured controls behind the backdrop.
  useEffect(() => {
    if (!open || (!selectedId && !adding)) return
    const drawer = drawerRef.current
    if (!drawer) return
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = (): HTMLElement[] => Array.from(
      drawer.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')
    ).filter((element) => !element.hidden)
    window.requestAnimationFrame(() => (focusable()[0] ?? drawer).focus())
    const trap = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) { event.preventDefault(); drawer.focus(); return }
      const first = items[0]!
      const last = items[items.length - 1]!
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    drawer.addEventListener('keydown', trap)
    return () => {
      drawer.removeEventListener('keydown', trap)
      if (previous?.isConnected) previous.focus()
    }
  }, [open, selectedId, adding])

  // Populate the editor when a real agent is selected.
  useEffect(() => {
    if (adding || !selected) return
    setForm({
      name: selected.name,
      kind: selected.kind,
      role: selected.role ?? '',
      model: selected.model || defaultModel,
      effort: selected.effort ?? '',
      mode: selected.mode,
      permissionPreset: selected.permissionPreset,
      cwd: selected.cwd ?? '',
      rolling: selected.rolling,
      allowedTools: (selected.allowedTools ?? []).join(', ')
    })
  }, [selected, adding, defaultModel])

  const parseTools = (raw: string): string[] | undefined => {
    const list = raw.split(',').map((t) => t.trim()).filter(Boolean)
    return list.length ? list : undefined
  }

  const startAdd = (kind: AgentKind): void => {
    setSelectedId(null)
    setAdding(kind)
    setForm(blankForm(kind, defaultModel, settings?.defaultEffort ?? ''))
  }

  const createAgent = async (): Promise<void> => {
    if (!fleetId || busy) return
    if (form.kind === 'worker' && !form.name.trim()) {
      flash('Give the agent a name.', 'warn')
      return
    }
    setBusy(true)
    try {
      const created = await window.lattice.createAgent({
        fleetId,
        name: form.name.trim() || (form.kind === 'orchestrator' ? 'Orchestrator' : 'Agent'),
        kind: form.kind,
        role: form.role.trim() || undefined,
        model: form.model || undefined,
        effort: form.effort || undefined,
        mode: form.mode,
        permissionPreset: form.permissionPreset,
        cwd: form.cwd.trim() || undefined,
        rolling: form.rolling,
        allowedTools: parseTools(form.allowedTools)
      })
      setAdding(null)
      setSelectedId(created.id)
      await loadAgents(fleetId)
      flash(`Added ${created.name}.`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not create the agent.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const saveAgent = async (): Promise<void> => {
    if (!selected || busy) return
    setBusy(true)
    try {
      await window.lattice.updateAgent(selected.id, {
        name: form.name.trim() || selected.name,
        kind: form.kind,
        role: form.role.trim() || '',
        model: form.model || undefined,
        effort: form.effort || null,
        mode: form.mode,
        permissionPreset: form.permissionPreset,
        cwd: form.cwd.trim() ? form.cwd.trim() : null,
        rolling: form.rolling,
        allowedTools: parseTools(form.allowedTools) ?? null
      })
      if (fleetId) await loadAgents(fleetId)
      flash('Saved.')
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not save.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const removeAgent = async (): Promise<void> => {
    if (!selected) return
    if (!window.confirm(`Delete “${selected.name}” and its thread? This cannot be undone.`)) return
    await window.lattice.deleteAgent(selected.id).catch(() => {})
    setSelectedId(null)
    if (fleetId) await loadAgents(fleetId)
  }

  const openThread = (threadId: string): void => {
    void selectThread(threadId)
    setUi({ fleetOpen: false })
  }

  const sendTo = async (agent: FleetAgentView, text: string, disp: 'send' | 'steer' | 'queue'): Promise<boolean> => {
    const body = text.trim()
    if (!body || busy) return false
    setBusy(true)
    try {
      await window.lattice.send({ threadId: agent.threadId, text: body, disposition: disp })
      const verb = disp === 'steer' ? (agent.running ? 'steered in' : 'sent') : disp === 'queue' ? 'queued' : 'sent'
      flash(`Task ${verb} → ${agent.name}`)
      if (fleetId) await loadAgents(fleetId)
      return true
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not send.', 'warn')
      return false
    } finally {
      setBusy(false)
    }
  }

  const commandOrchestrator = async (): Promise<void> => {
    if (!orchestrator) return
    if (await sendTo(orchestrator, msg, disposition)) setMsg('')
  }

  const stopAgentWork = async (agent: FleetAgentView): Promise<void> => {
    try {
      await window.lattice.stopThreadWork(agent.threadId)
      flash(`Stopped ${agent.name}.`)
      if (fleetId) await loadAgents(fleetId)
    } catch (err) {
      flash(err instanceof Error ? err.message : `Could not stop ${agent.name}.`, 'warn')
    }
  }

  const answerAsk = (req: AskRequest, value: string): void => {
    void respondAsk({ requestId: req.id, answer: value })
    setAnswers((a) => {
      const next = { ...a }
      delete next[req.id]
      return next
    })
  }
  const decideApproval = (req: ApprovalRequest, effect: 'allow' | 'deny'): void => {
    void respondApproval({ requestId: req.id, effect, scope: 'once' })
  }
  const openAgentModel = (agent: { id: string; model: string }): void =>
    openModelPicker({ intent: 'agent', agent: { id: agent.id, model: agent.model } })

  const effortTiersFor = (modelId: string, current?: string): string[] => {
    const model = models.find((candidate) => candidate.id === modelId)
    const supported = model ? resolveEffortTiers(model) : [...EFFORT_TIERS]
    return current && !supported.includes(current) ? [...supported, current] : supported
  }

  const changeAgentEffort = async (agent: FleetAgentView, effort: string): Promise<void> => {
    if (busy || !effort || effort === agent.effort) return
    setBusy(true)
    try {
      await window.lattice.updateAgent(agent.id, { effort })
      if (fleetId) await loadAgents(fleetId)
      flash(`${agent.name} reasoning → ${effortLabel(effort)}`)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not change reasoning.', 'warn')
    } finally {
      setBusy(false)
    }
  }

  const newFleet = async (): Promise<void> => {
    const name = window.prompt('Name the new fleet', 'New Fleet')?.trim()
    if (!name) return
    const created = await window.lattice.createFleet({ name }).catch(() => null)
    if (!created) {
      flash('Could not create the fleet.', 'warn')
      return
    }
    setFleets((f) => [...f, created])
    setFleetId(created.id)
    fleetIdRef.current = created.id
    setSelectedId(null)
    setAdding(null)
    await loadAgents(created.id)
  }

  const currentFleet = fleets.find((f) => f.id === fleetId) ?? null

  const renameCurrentFleet = async (): Promise<void> => {
    if (!currentFleet) return
    const name = window.prompt('Rename this fleet', currentFleet.name)?.trim()
    if (!name || name === currentFleet.name) return
    try {
      const updated = await window.lattice.renameFleet(currentFleet.id, name)
      setFleets((f) => f.map((x) => (x.id === updated.id ? updated : x)))
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not rename.', 'warn')
    }
  }

  const deleteCurrentFleet = async (): Promise<void> => {
    if (!currentFleet) return
    const n = agents.length
    const what = n ? ` and its ${n} agent${n === 1 ? '' : 's'} (their threads too)` : ''
    if (!window.confirm(`Delete the fleet “${currentFleet.name}”${what}? This cannot be undone.`)) return
    try {
      await window.lattice.deleteFleet(currentFleet.id)
      setSelectedId(null)
      setAdding(null)
      fleetIdRef.current = null
      setFleetId(null)
      await loadFleets()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not delete.', 'warn')
    }
  }

  if (!open) return null

  const tone = (a: FleetAgentView): string =>
    a.running || a.status === 'running'
      ? 'running'
      : a.status === 'waiting-approval' || a.status === 'waiting-answer'
        ? 'needs'
        : a.status === 'error'
          ? 'error'
          : a.unread > 0
            ? 'queued'
            : 'idle'
  const base = (p?: string): string => (p ? p.split('/').filter(Boolean).pop() ?? p : '')
  const fmtWhen = (ts: number): string => {
    const d = new Date(ts)
    const sameDay = new Date().toDateString() === d.toDateString()
    return sameDay ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : d.toLocaleDateString([], { month: 'short', day: 'numeric' })
  }
  const fmtTokens = (value: number): string =>
    value >= 1_000_000 ? `${(value / 1_000_000).toFixed(value >= 10_000_000 ? 0 : 1)}M` : value >= 1000 ? `${(value / 1000).toFixed(value >= 100000 ? 0 : 1)}k` : String(value)
  const contextTone = (occupancy: number): string => occupancy >= 0.9 ? 'hot' : occupancy >= 0.72 ? 'warm' : ''
  // A task's spend: brass past a dollar, red past five, so a runaway agent stands out on the board.
  const taskTone = (usage: TaskUsage): string => (usage.costUsd ?? 0) >= 5 ? 'hot' : (usage.costUsd ?? 0) >= 1 ? 'warm' : ''
  const taskTitle = (usage: TaskUsage): string => {
    const cachedShare = usage.tokensIn ? Math.round((usage.cachedTokens / usage.tokensIn) * 100) : 0
    return [
      `Current task since ${fmtWhen(usage.since)}`,
      `${usage.calls} model call${usage.calls === 1 ? '' : 's'}`,
      `${usage.tokensIn.toLocaleString()} input tokens (${cachedShare}% from cache)`,
      `${usage.tokensOut.toLocaleString()} output tokens`,
      `largest prompt ${usage.peakPromptTokens.toLocaleString()} tokens`,
      usage.costUsd === undefined ? 'no price known for this route' : `${formatUsd(usage.costUsd)}${usage.estimated ? ' (list-price estimate)' : ''}`
    ].join('\n')
  }
  const taskLine = (usage: TaskUsage | undefined, running: boolean): React.JSX.Element | null => {
    if (!usage || usage.calls === 0) return null
    return (
      <div className={`fleet-card-task ${taskTone(usage)}`} title={taskTitle(usage)}>
        <span>{running ? 'This task' : 'Last task'}</span>
        <span className="n">{usage.calls} calls · {fmtTokens(usage.tokensIn)} in · {fmtTokens(usage.tokensOut)} out</span>
        <span className="usd">{usage.costUsd !== undefined ? formatUsd(usage.costUsd) : '—'}</span>
      </div>
    )
  }

  const card = (a: FleetAgentView): React.JSX.Element => {
    const live = !!a.activity && (a.running || a.status === 'running')
    const body = live ? a.activity! : plainPreview(a.preview) || plainPreview(a.role)
    const model = models.find((m) => m.id === a.model)
    const budget = budgets[a.threadId]
    const effortTiers = effortTiersFor(a.model, a.effort)
    const openAgent = (): void => {
      setAdding(null)
      setSelectedId(a.id)
      setShowLog(true)
    }
    return (
      <article
        key={a.id}
        data-tree-node={a.id}
        className={`fleet-card ${tone(a)}${a.id === selectedId ? ' sel' : ''}`}
      >
        <button type="button" className="fleet-card-open" onClick={openAgent} aria-label={`Open ${a.name} configuration`}>
          <div className="head">
            <span className={`fleet-dot ${tone(a)}`} />
            <span className="name" title={a.name}>{a.name}</span>
            <span className={`fleet-status ${tone(a)}`}>{a.statusText}</span>
          </div>
          {body && <div className={`preview ${live ? 'live' : ''}`}>{live ? `⏳ ${body}` : body}</div>}
          <div className="fleet-chips">
            {a.model && <span className={`fleet-chip${model ? '' : ' warn'}`} title={model ? a.model : `Unavailable model: ${a.model}`}>{model?.name ?? a.model}</span>}
            {a.cwd && <span className="fleet-chip" title={a.cwd}>📁 {base(a.cwd)}</span>}
            {a.rolling && <span className="fleet-chip">rolling</span>}
          </div>
          {budget && (
            <div className="fleet-card-context" title={`${budget.usedTokens.toLocaleString()} of ${budget.usableTokens.toLocaleString()} usable context tokens`}>
              <span>Context {Math.round(budget.occupancy * 100)}%</span>
              <span className="fleet-context-track"><span className={`fleet-context-fill ${contextTone(budget.occupancy)}`} style={{ width: `${Math.max(2, budget.occupancy * 100)}%` }} /></span>
            </div>
          )}
          {!budget && <div className="fleet-card-context pending">{budgetsLoaded ? 'Context unavailable' : 'Loading context…'}</div>}
          {taskLine(a.taskUsage, a.running)}
        </button>
        <label className="fleet-effort" title={fleetReasoningLabel(a, model)}>
          <span>Reasoning</span>
          <select
            value={a.effort ?? ''}
            disabled={busy || effortTiers.length === 0}
            onChange={(event) => void changeAgentEffort(a, event.target.value)}
            aria-label={`Reasoning for ${a.name}`}
          >
            {effortTiers.length === 0 ? <option value="">Not supported</option> : null}
            {effortTiers.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
          </select>
        </label>
      </article>
    )
  }

  const renderAsk = (req: AskRequest): React.JSX.Element => {
    const who = agentByThread.get(req.threadId)?.name ?? 'An agent'
    const val = answers[req.id] ?? ''
    const submit = (): void => { if (val.trim()) answerAsk(req, val.trim()) }
    return (
      <div className="fleet-need" key={req.id}>
        <span className="who">{who} asks</span>
        <span className="q">{req.question}</span>
        <div className="answer">
          {req.kind === 'confirm' ? (
            <>
              <button className="fleet-btn primary" onClick={() => answerAsk(req, 'yes')}>Yes</button>
              <button className="fleet-btn" onClick={() => answerAsk(req, 'no')}>No</button>
            </>
          ) : (
            <>
              {req.kind === 'choice' &&
                (req.options ?? []).map((o) => (
                  <button key={o.label} className={`fleet-btn ${o.recommended ? 'primary' : ''}`} title={o.description} onClick={() => answerAsk(req, o.label)}>
                    {o.label}
                  </button>
                ))}
              <input
                placeholder={req.kind === 'choice' ? 'Other…' : req.placeholder ?? 'Your answer…'}
                value={val}
                onChange={(e) => setAnswers((a) => ({ ...a, [req.id]: e.target.value }))}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); submit() } }}
              />
              <button className="fleet-btn primary" disabled={!val.trim()} onClick={submit}>Send</button>
            </>
          )}
        </div>
      </div>
    )
  }

  const renderApproval = (req: ApprovalRequest): React.JSX.Element => {
    const who = agentByThread.get(req.threadId)?.name ?? 'An agent'
    return (
      <div className="fleet-need" key={req.id}>
        <span className="who">{who} needs approval</span>
        <span className="q">{req.summary || req.tool}</span>
        <div className="answer">
          <button className="fleet-btn primary" onClick={() => decideApproval(req, 'allow')}>Allow</button>
          <button className="fleet-btn danger" onClick={() => decideApproval(req, 'deny')}>Deny</button>
        </div>
      </div>
    )
  }

  return (
    <>
      <style>{STYLE}</style>
      <div className="fleet-screen">
        <div className="fleet-top">
          <span className="fleet-mark"><I name="hub" size={18} /> Agent Fleet</span>
          <select
            value={fleetId ?? ''}
            onChange={(e) => { setFleetId(e.target.value); fleetIdRef.current = e.target.value; setSelectedId(null); setAdding(null); void loadAgents(e.target.value) }}
          >
            {fleets.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select>
          <button className="fleet-ghost" onClick={() => void renameCurrentFleet()} disabled={!currentFleet} title="Rename this fleet">Rename</button>
          <button className="fleet-ghost" onClick={() => void newFleet()}>+ Fleet</button>
          <button className="fleet-ghost" onClick={() => void deleteCurrentFleet()} disabled={!currentFleet} title="Delete this fleet and its agents">Delete fleet</button>
          <div className="fleet-spacer" />
          <button className="fleet-ghost" onClick={() => setUi({ fleetOpen: false })}>Done ✕</button>
        </div>

        <div className="fleet-body">
          <div className="fleet-inner">
            {(pendingAsks.length > 0 || pendingApprovals.length > 0) && (
              <div className="fleet-needs">
                <h3><I name="front_hand" size={15} /> Needs you</h3>
                {pendingAsks.map(renderAsk)}
                {pendingApprovals.map(renderApproval)}
              </div>
            )}
            {orchestrator ? (
              <div className="fleet-map">
                <div className="fleet-head">
                <div className="fleet-orch">
                  <div className="badge-hub" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>
                    <I name="hub" size={24} />
                  </div>
                  <div className="fleet-orch-text" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>
                    <div className="fleet-kicker">Orchestrator</div>
                    <h2>{orchestrator.name}</h2>
                    {orchestrator.role && <div className="fleet-role">{orchestrator.role}</div>}
                  </div>
                  <div className="fleet-orch-model" onClick={(e) => e.stopPropagation()}>
                    <span className="fleet-mini-label">Model</span>
                    <button className="fleet-model-btn" onClick={() => openAgentModel(orchestrator)} title="Change the orchestrator's model">
                      <span>{nameOf(orchestrator.model)}</span><span className="chev">▾</span>
                    </button>
                    <label className="fleet-effort" title="Change the reasoning used on the orchestrator's next run">
                      <span>Reasoning</span>
                      <select
                        value={orchestrator.effort ?? ''}
                        disabled={busy || effortTiersFor(orchestrator.model, orchestrator.effort).length === 0}
                        onChange={(event) => void changeAgentEffort(orchestrator, event.target.value)}
                        aria-label={`Reasoning for ${orchestrator.name}`}
                      >
                        {effortTiersFor(orchestrator.model, orchestrator.effort).length === 0 ? <option value="">Not supported</option> : null}
                        {effortTiersFor(orchestrator.model, orchestrator.effort).map((effort) => (
                          <option key={effort} value={effort}>{effortLabel(effort)}</option>
                        ))}
                      </select>
                    </label>
                    <button className="fleet-ghost" onClick={() => { setAdding(null); setSelectedId(orchestrator.id) }}>Configure</button>
                  </div>
                </div>

                <div className="fleet-command" onClick={(e) => e.stopPropagation()}>
                  <input
                    value={msg}
                    onChange={(e) => setMsg(e.target.value)}
                    placeholder={`Tell ${orchestrator.name} what to do — it delegates to its agents…`}
                    onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void commandOrchestrator() } }}
                  />
                  <select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)} title="How to deliver">
                    <option value="send">Send</option>
                    <option value="steer">Steer</option>
                    <option value="queue">Queue</option>
                  </select>
                  <button className="fleet-send" onClick={() => void commandOrchestrator()} disabled={!msg.trim() || busy}>Send</button>
                </div>
                </div>

                <section ref={consoleRef} className={`fleet-console${showOrchestratorOutput ? '' : ' collapsed'}`} aria-label="Orchestrator output">
                  <div className="fleet-console-head">
                    <div className="fleet-console-title">
                      <I name="terminal" size={15} /> Orchestrator output
                      <small>{orchestrator.running ? 'live' : 'latest run'}</small>
                    </div>
                    <span className={`fleet-status ${tone(orchestrator)}`}>{orchestrator.statusText}</span>
                    {orchestrator.running && (
                      <button className="fleet-btn danger" onClick={() => void stopAgentWork(orchestrator)}>
                        <I name="stop_circle" size={13} /> Stop
                      </button>
                    )}
                    <button className="fleet-btn" onClick={() => openThread(orchestrator.threadId)}>Open thread</button>
                    <button
                      className="fleet-btn fleet-console-toggle"
                      onClick={() => setShowOrchestratorOutput((value) => !value)}
                      aria-expanded={showOrchestratorOutput}
                      aria-controls="fleet-orchestrator-output-body"
                    >
                      <I name={showOrchestratorOutput ? 'unfold_less' : 'unfold_more'} size={13} /> {showOrchestratorOutput ? 'Fold' : 'Expand'}
                    </button>
                  </div>
                  <div className="fleet-console-meta" hidden={!showOrchestratorOutput}>
                    {budgets[orchestrator.threadId] && (() => {
                      const budget = budgets[orchestrator.threadId]!
                      return (
                        <div className="fleet-context" title={`${budget.usedTokens.toLocaleString()} used · ${budget.contextLength.toLocaleString()} total window`}>
                          <span>Context {fmtTokens(budget.usedTokens)} / {fmtTokens(budget.usableTokens)}</span>
                          <span className="fleet-context-track"><span className={`fleet-context-fill ${contextTone(budget.occupancy)}`} style={{ width: `${Math.max(2, budget.occupancy * 100)}%` }} /></span>
                          <strong>{Math.round(budget.occupancy * 100)}%</strong>
                        </div>
                      )
                    })()}
                    {!budgets[orchestrator.threadId] && <span className="fleet-chip">{budgetsLoaded ? 'Context unavailable' : 'Loading context…'}</span>}
                    {orchestrator.taskUsage && orchestrator.taskUsage.calls > 0 && (
                      <span className={`fleet-chip fleet-task-chip ${taskTone(orchestrator.taskUsage)}`} title={taskTitle(orchestrator.taskUsage)}>
                        This job · {fmtTokens(orchestrator.taskUsage.tokensIn)} in · {orchestrator.taskUsage.costUsd !== undefined ? formatUsd(orchestrator.taskUsage.costUsd) : 'unpriced'}
                      </span>
                    )}
                    {orchDetail?.activity && <span className="fleet-chip">Now · {orchDetail.activity}</span>}
                    <span className="fleet-chip">{fleetReasoningLabel(orchestrator, models.find((m) => m.id === orchestrator.model))}</span>
                  </div>
                  <div id="fleet-orchestrator-output-body" className="fleet-console-body" aria-live="polite" hidden={!showOrchestratorOutput}>
                    {orchTimeline.length > 0 ? (
                      <div className="agent-detail">
                        <RunTimeline items={orchTimeline} running={orchestrator.running} fullText={orchTimelineText} model={orchestrator.model} />
                      </div>
                    ) : orchLastReply ? (
                      <div style={{ whiteSpace: 'pre-wrap', fontSize: 13.5, lineHeight: 1.55 }}>{orchLastReply}</div>
                    ) : (
                      <div className="fleet-console-empty">The orchestrator’s progress and replies will appear here as soon as you give it a task.</div>
                    )}
                  </div>
                </section>

                <div className="fleet-tree" ref={treeRef}>
                  <svg className="fleet-lines" width={treeSize.w} height={treeSize.h} aria-hidden="true">
                    {stem && <path className={`stem${counts.running ? ' live' : ''}`} d={stem} />}
                    {routes.map((route) => {
                      const agent = workers.find((w) => w.id === route.id)
                      const state = agent ? tone(agent) : 'add'
                      return (
                        <g key={route.id}>
                          <path className={state} d={route.d} />
                          {state === 'running' && <path className="flow" d={route.d} />}
                        </g>
                      )
                    })}
                  </svg>
                  <div className="fleet-tree-head">
                    <div className="fleet-agents-label">Agents · {workers.length}</div>
                    <div className="fleet-summary" aria-label="Fleet health">
                      <span className={counts.running ? 'live' : ''}><I name="autorenew" size={13} /> {counts.running} running</span>
                      <span className={counts.needsYou ? 'needs' : ''}><I name="front_hand" size={13} /> {counts.needsYou} need you</span>
                      <span className={counts.failed ? 'bad' : ''}><I name="error" size={13} /> {counts.failed} failed</span>
                      <span><I name="check_circle" size={13} /> {counts.idle} idle</span>
                    </div>
                  </div>
                  <div className="fleet-hub-node" ref={hubRef}>
                    <span className={counts.running ? 'live' : ''}><I name="call_split" size={13} /> delegates · steers · learns</span>
                  </div>
                  <div className="fleet-grid">
                    {workers.map(card)}
                    <button className="fleet-add" data-tree-node="add" onClick={() => startAdd('worker')}><I name="add" size={22} /> Add agent</button>
                  </div>
                </div>

                <div className="fleet-feed" onClick={(e) => e.stopPropagation()}>
                  <div className="fleet-feed-head"><I name="forum" size={14} /> Activity — delegations, reports and questions between agents</div>
                  {feed.length === 0 ? (
                    <div className="fleet-feed-empty">Nothing yet. Give {orchestrator.name} a task above; every hand-off and every report shows up here.</div>
                  ) : (
                    feed.map((item) => {
                      const from = agentByThread.get(item.fromThreadId)
                      const to = agentByThread.get(item.toThreadId)
                      const isReport = from?.kind === 'worker' && to?.kind === 'orchestrator'
                      const open = feedOpen === item.id
                      return (
                        <button
                          key={item.id}
                          className={`fleet-feed-item${open ? ' open' : ''}`}
                          onClick={() => setFeedOpen(open ? null : item.id)}
                          onDoubleClick={() => openThread(item.toThreadId)}
                          title="Click to expand · double-click to open the receiving agent's thread"
                        >
                          <span className="when">{fmtWhen(item.createdAt)}</span>
                          <span>
                            <span className="route">
                              {item.fromName} <span className="arrow">→</span> {item.toName}
                              <span className="tag">{isReport ? 'report' : item.delivery === 'injected' ? 'steer' : item.delivery === 'woken' ? 'task' : 'queued'}</span>
                            </span>
                            <span className="body">{item.body}</span>
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>

                <div className="fleet-feed" onClick={(e) => e.stopPropagation()}>
                  <div className="fleet-feed-head"><I name="psychology" size={14} /> How the fleet has changed — agents added, re-roled and removed, and why</div>
                  {changes.length === 0 ? (
                    <div className="fleet-feed-empty">No changes yet. When {orchestrator.name} learns from a job it rewrites roles, adds or removes agents, and every change lands here with its reason.</div>
                  ) : (
                    changes.map((change) => {
                      const view = describeFleetChange(change)
                      const isOpen = changeOpen === change.id
                      return (
                        <button
                          key={change.id}
                          className={`fleet-feed-item fleet-change${isOpen ? ' open' : ''}`}
                          onClick={() => setChangeOpen(isOpen ? null : change.id)}
                          title={view.fields.length ? 'Click to see what changed' : undefined}
                        >
                          <span className="when">{fmtWhen(change.createdAt)}</span>
                          <span>
                            <span className="route">
                              {view.headline}
                              <span className={`tag${view.byAgent ? ' agent' : ''}`}>{view.byAgent ? 'self-improvement' : change.actor === 'user' ? 'you' : change.action}</span>
                            </span>
                            {view.reason && <span className="fleet-change-reason" style={{ display: 'block' }}>{view.reason}</span>}
                            {view.fields.length > 0 && (
                              <span className="fleet-change-fields">
                                {view.fields.map((f) => (
                                  <span className="fleet-change-field" key={f.label} style={{ display: 'block' }}>
                                    <span className="label">{f.label}</span>
                                    {f.before !== undefined && <span className="before" style={{ display: 'block' }}>{f.before}</span>}
                                    {f.after !== undefined && <span className="after" style={{ display: 'block' }}>{f.after}</span>}
                                  </span>
                                ))}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })
                  )}
                </div>
              </div>
            ) : (
              <div className="fleet-empty">
                <h2>Build your fleet</h2>
                <p>A fleet is a persistent orchestrator plus dedicated agents — each with its own working
                  directory, tools and memory. Add the orchestrator, give it workers, then tell it what you
                  want and it delegates the work and reports back.</p>
                <p>Or build it from any chat: tell the model what the team should do and it creates the
                  whole fleet in one call (the <code>create_fleet</code> tool) — it shows up here.</p>
                <button className="fleet-btn primary" onClick={() => startAdd('orchestrator')}>Add the orchestrator</button>
              </div>
            )}
          </div>
        </div>
      </div>

      {(selected || adding) && (
        <>
          <div className="fleet-backdrop" onClick={() => { setSelectedId(null); setAdding(null) }} />
          <aside ref={drawerRef} tabIndex={-1} className="fleet-drawer" role="dialog" aria-modal="true" aria-label={adding ? 'Create agent' : `${selected?.name ?? 'Agent'} details`}>
            <div className="fleet-drawer-head">
              <I name={adding === 'orchestrator' || selected?.kind === 'orchestrator' ? 'hub' : 'smart_toy'} size={18} />
              <span className="name">{adding ? (adding === 'orchestrator' ? 'New orchestrator' : 'New agent') : selected?.name}</span>
              {selected && !adding && (
                <>
                  <button className="fleet-btn" onClick={() => openThread(selected.threadId)}>Open thread</button>
                  {selected.running && <button className="fleet-btn danger" onClick={() => void stopAgentWork(selected)}>Stop</button>}
                  <button className="fleet-btn danger" onClick={() => void removeAgent()}>Delete</button>
                </>
              )}
              <button className="fleet-btn" onClick={() => { setSelectedId(null); setAdding(null) }}>✕</button>
            </div>
            <div className="fleet-drawer-body">
              {selected && !adding && (
                <div className="fleet-msg">
                  <div className="fleet-section-label">
                    {selected.kind === 'orchestrator' ? 'Give the orchestrator a task' : 'Message · steer · queue'}
                  </div>
                  <textarea
                    value={msg}
                    onChange={(e) => setMsg(e.target.value)}
                    rows={3}
                    placeholder={selected.kind === 'orchestrator' ? 'It will delegate to its agents…' : 'Send a task, steer its run, or queue behind it…'}
                    onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void (async () => { if (await sendTo(selected, msg, disposition)) setMsg('') })() } }}
                  />
                  <div className="fleet-row" style={{ marginTop: 6 }}>
                    <select value={disposition} onChange={(e) => setDisposition(e.target.value as typeof disposition)}>
                      <option value="send">Send{selected.running ? ' (after current)' : ''}</option>
                      <option value="steer">Steer (fold into run)</option>
                      <option value="queue">Queue (after current)</option>
                    </select>
                    <button className="fleet-btn primary" disabled={!msg.trim() || busy} onClick={() => void (async () => { if (await sendTo(selected, msg, disposition)) setMsg('') })()}>Send</button>
                  </div>
                </div>
              )}

              {selected && !adding && detail && (detail.activity || (detail.tools?.length ?? 0) > 0) && (
                <div>
                  <div className="fleet-section-label">{selected.running ? 'Working now' : 'Recent activity'}</div>
                  <div className="fleet-live">
                    {selected.running && detail.activity && (
                      <div className="doing"><span className="fleet-dot running" /> {detail.activity}</div>
                    )}
                    {(detail.tools ?? []).slice().reverse().slice(0, 5).map((t) => (
                      <div className="tool" key={t.callId}>
                        <I name={t.status === 'running' ? 'pending' : t.status === 'ok' ? 'check' : 'close'} size={12} />
                        <span className="t-name">{t.tool}</span>
                        {t.summary ? ` — ${t.summary}` : ''}
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {selected && !adding && (
                <div>
                  <div className="fleet-log-head">
                    <div className="fleet-section-label">{selected.running ? 'Live run log' : 'Latest run log'}</div>
                    <button className="fleet-btn" onClick={() => setShowLog((value) => !value)} aria-expanded={showLog}>
                      <I name={showLog ? 'unfold_less' : 'unfold_more'} size={13} /> {showLog ? 'Hide' : 'Show'}
                    </button>
                  </div>
                  <div className="fleet-log-meta">
                    <span className={`fleet-chip${selectedModel ? '' : ' warn'}`} title={selected.model}>
                      {selectedModel?.name ?? `${selected.model} · unavailable`}
                    </span>
                    <span className="fleet-chip">{fleetReasoningLabel(selected, selectedModel)}</span>
                    <span className={`fleet-status ${tone(selected)}`}>{selected.statusText}</span>
                    {budgets[selected.threadId] && (
                      <span className="fleet-chip" title={`${budgets[selected.threadId]!.usedTokens.toLocaleString()} used of ${budgets[selected.threadId]!.usableTokens.toLocaleString()} usable tokens · ${budgets[selected.threadId]!.contextLength.toLocaleString()} total window`}>
                        context {Math.round(budgets[selected.threadId]!.occupancy * 100)}% · {fmtTokens(budgets[selected.threadId]!.usedTokens)} / {fmtTokens(budgets[selected.threadId]!.usableTokens)}
                      </span>
                    )}
                  </div>
                  {showLog && (
                    <div className="fleet-log">
                      {timeline.length > 0 ? (
                        <div className="agent-detail">
                          <RunTimeline items={timeline} running={selected.running} fullText={timelineText} model={selected.model} />
                        </div>
                      ) : (
                        <div className="fleet-log-empty">Nothing logged for this agent yet.</div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {selected && !adding && memory && (
                <div className="fleet-memory">
                  <div className="fleet-log-head">
                    <div className="fleet-section-label">Working memory</div>
                    <button className="fleet-btn" disabled={!memDirty} onClick={() => memory && setMemDraft(memory.content)}>Revert</button>
                    <button className="fleet-btn primary" disabled={!memDirty} onClick={() => void saveMemory()}>Save</button>
                  </div>
                  <p className="fleet-memory-note">
                    {selected.kind === 'orchestrator'
                      ? 'Its notebook: focus, process, lessons learned, notes on each agent, and the change log. It rewrites this itself as it learns; edit it to teach it directly.'
                      : 'Its notebook for this job: how it works and the lessons it has learned. Shown to it at the start of every run.'}
                  </p>
                  <div className="fleet-memory-meta">
                    <span className="path" title={memory.path}>{memory.exists ? memory.path : 'Not written yet — starter layout'}</span>
                    <span className={memDraft.length > memory.softLimit ? 'over' : ''}>{memDraft.length.toLocaleString()} / {memory.softLimit.toLocaleString()} chars</span>
                  </div>
                  <textarea
                    value={memDraft}
                    spellCheck={false}
                    onChange={(e) => { setMemDraft(e.target.value); setMemNote('') }}
                    onKeyDown={(e) => { if (e.key === 's' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); void saveMemory() } }}
                  />
                  {memNote && <p className="fleet-memory-note" style={{ marginTop: 6 }}>{memNote}</p>}
                </div>
              )}
              {selected && !adding && !memory && (
                <div className="fleet-memory">
                  <div className="fleet-section-label">Working memory</div>
                  <div className="fleet-log-empty">
                    {memoryStatus === 'error' ? 'Working memory is unavailable. Close and reopen this agent to retry.' : 'Loading working memory…'}
                  </div>
                </div>
              )}

              <div>
                {selected && !adding && <div className="fleet-section-label">Configuration</div>}
                <AgentEditor
                  form={form}
                  setForm={setForm}
                  models={models}
                  busy={busy}
                  onSubmit={() => (adding ? void createAgent() : void saveAgent())}
                  submitLabel={adding ? 'Create agent' : 'Save changes'}
                  lockKind={!adding}
                  pickModel={selected && !adding ? () => openAgentModel({ id: selected.id, model: form.model }) : undefined}
                />
              </div>
            </div>
          </aside>
        </>
      )}

    </>
  )
}

/** The create/edit form for one agent (rendered inside the drawer). */
function AgentEditor({
  form,
  setForm,
  models,
  busy,
  onSubmit,
  submitLabel,
  lockKind,
  pickModel
}: {
  form: AgentForm
  setForm: React.Dispatch<React.SetStateAction<AgentForm>>
  models: ModelInfo[]
  busy: boolean
  onSubmit: () => void
  submitLabel: string
  lockKind?: boolean
  /** When present (editing an existing agent), the Model field opens the real picker and saves immediately. */
  pickModel?: () => void
}): React.JSX.Element {
  const set = <K extends keyof AgentForm>(key: K, value: AgentForm[K]): void => setForm((f) => ({ ...f, [key]: value }))
  const model = models.find((candidate) => candidate.id === form.model)
  const effortTiers = model ? resolveEffortTiers(model) : [...EFFORT_TIERS]
  if (form.effort && !effortTiers.includes(form.effort)) effortTiers.push(form.effort)
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div className="fleet-two">
        <label className="fleet-field"><span>Name</span>
          <input value={form.name} onChange={(e) => set('name', e.target.value)} placeholder="eBay Sourcing" />
        </label>
        <label className="fleet-field"><span>Kind</span>
          <select value={form.kind} onChange={(e) => set('kind', e.target.value as AgentKind)} disabled={lockKind}>
            <option value="orchestrator">Orchestrator</option>
            <option value="worker">Worker</option>
          </select>
        </label>
      </div>
      <label className="fleet-field"><span>Role — the mission, injected into its prompt</span>
        <textarea value={form.role} onChange={(e) => set('role', e.target.value)} rows={4} placeholder="You source computer parts on eBay…" />
      </label>
      <div className="fleet-two">
        <label className="fleet-field"><span>Model</span>
          {pickModel ? (
            <button type="button" className="fleet-model-btn" onClick={pickModel} title="Change model — opens the full model picker">
              <span>{models.find((m) => m.id === form.model)?.name ?? form.model ?? 'Choose model'}</span>
              <span className="chev">▾</span>
            </button>
          ) : (
            <select value={form.model} onChange={(e) => set('model', e.target.value)}>
              {form.model && !models.some((m) => m.id === form.model) && <option value={form.model}>{form.model}</option>}
              {models.length === 0 && !form.model && <option value="">(no models loaded)</option>}
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.name && m.name !== m.id ? `${m.name} — ${m.id}` : m.id}
                </option>
              ))}
            </select>
          )}
        </label>
        <label className="fleet-field"><span>Reasoning</span>
          <select value={form.effort} onChange={(e) => set('effort', e.target.value)} disabled={effortTiers.length === 0}>
            {effortTiers.length === 0 ? <option value="">Not supported by this model</option> : null}
            {effortTiers.map((effort) => <option key={effort} value={effort}>{effortLabel(effort)}</option>)}
          </select>
        </label>
        <label className="fleet-field"><span>Working directory</span>
          <input value={form.cwd} onChange={(e) => set('cwd', e.target.value)} placeholder="~/work/ebay" />
        </label>
        <label className="fleet-field"><span>Mode</span>
          <select value={form.mode} onChange={(e) => set('mode', e.target.value as Mode)}>
            {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
          </select>
        </label>
        <label className="fleet-field"><span>Permissions</span>
          <select value={form.permissionPreset} onChange={(e) => set('permissionPreset', e.target.value as PermissionPreset)}>
            {PRESETS.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </label>
      </div>
      <div className="fleet-check" style={{ marginTop: -6 }}>
        {form.permissionPreset === 'full'
          ? 'Full: runs unattended — web, MCP and shell calls never wait on you.'
          : form.permissionPreset === 'workspace'
            ? 'Workspace: every web, MCP and shell call waits for your approval (shown under “Needs you” here). An unattended agent stalls there.'
            : 'Manual: read-only tools only; everything else is refused.'}
      </div>
      <label className="fleet-field"><span>{form.kind === 'orchestrator'
        ? 'Extra tools (comma-separated). An orchestrator only gets coordination tools — delegate, peek, message, memory, ask — so it must hand work to its agents; name any work tool here to add it back.'
        : 'Tools (comma-separated; blank = all its mode allows; MCP tools it loads are always kept)'}</span>
        <input value={form.allowedTools} onChange={(e) => set('allowedTools', e.target.value)} placeholder="web_search, web_fetch, fs_write" />
        <span title={TOOL_HINT}>Builtins: {TOOL_HINT}. Messaging + memory_search are always kept.</span>
      </label>
      <label className="fleet-check">
        <input type="checkbox" checked={form.rolling} onChange={(e) => set('rolling', e.target.checked)} />
        Rolling context — lives forever, folds old turns into memory (recommended for workers)
      </label>
      <div className="fleet-row">
        <button className="fleet-btn primary" onClick={onSubmit} disabled={busy}>{submitLabel}</button>
      </div>
    </div>
  )
}
