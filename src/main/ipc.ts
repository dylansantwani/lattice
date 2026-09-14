import { ipcMain, BrowserWindow, app } from 'electron'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, resolve } from 'node:path'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import type { AgentProfile, AppSettings, FleetAgentView, McpServerConfig, PermissionRule, RunEvent, RunId, SendOptions, SessionActivitySummary, ThreadMeta, TurnSummary } from '@shared/types'
import * as store from './store/eventStore'
import * as agents from './store/agents'
import { summarizeTaskUsage, type TaskUsage } from '@shared/taskUsage'

import { windowEvents, windowLimit } from './eventWindow'
import * as runManager from './runtime/runManager'
import { clearLoaded } from './runtime/toolCatalog'
import { effortDefaultFor, withDerivedEffort } from './runtime/effortDefaults'
import { configureBgJobs, killThreadJobs, listJobs, stopJob } from './tools/bgJobs'
import { notify } from './notify'
import { buildToolInventory } from './runtime/toolInventory'
import { builtinTools } from './tools/builtin'
import { deferredTools, findMcpTool, loadedDeferredTools } from './runtime/toolCatalog'
import * as approvals from './runtime/approvals'
import * as asks from './runtime/asks'
import * as sessionMessaging from './runtime/sessionMessaging'
import * as fleet from './runtime/fleet'
import * as agentMemory from './runtime/agentMemory'
import * as sessionActivity from './runtime/sessionActivity'
import { runMemorySync, scheduleMemoryExport } from './memory/bridge'
import { compactRunEvents } from '@shared/view/compactEvents'
import { summarizeTurn } from '@shared/view/turnSummary'
import { findDuplicatePairs } from './memory/similarity'
import { isImported } from './memory/bridge'
import { tokenizeQuery, rankMemorySearch } from './tools/builtin'
import { fetchAllModels, probeProvider } from './providers/registry'
import { checkModelHealth } from './providers/health'
import { initMcp, mcpStatuses, reconnectServer, disconnectServer } from './mcp/manager'
import { planLegacyBrowserMigration } from './mcp/legacyMigration'
import { fsTree, fsReadFile } from './files'
import { configureTerminal, createTerminal, writeTerminal, resizeTerminal, killTerminal } from './ptyTerminal'
import {
  configureBrowser,
  browserAttach,
  browserSetBounds,
  browserDetach,
  browserNavigate,
  browserBack,
  browserForward,
  browserReload,
  browserStop
} from './browserView'
import { ulid } from '@shared/id'
import { channelsPaths, loadConfig as loadChannelsConfig, updateConfig as updateChannelsConfig } from '../cli/channels/config'
import { queryGateway } from '../cli/channels/gateway'
import * as bridge from './net/bridge'
import { startBridge, stopBridge, bridgeStatus, setControlStatus } from './net/server'
import { hasPassword, setPassword, listDevices, revokeDevice } from './net/auth'
import { computeSnapshot } from './stats'
import { attachFile as attachPath } from './attachments'
import { isPathInsideRoots } from './tools/builtin'
import { acquireRuntimeLock, type RuntimeLock } from './runtimeLock'
import { startLocalControlSocket, type LocalControlSocket } from './net/local'
import { listSpeechVoices, synthesizeSpeech } from './speech'

let runtimeLock: RuntimeLock | null = null
let controlSocket: LocalControlSocket | null = null

/**
 * Join an agent profile with its live thread state — the row the Fleet screen renders. When an
 * activity summary is supplied (built once per roster load), the richer live status/activity from
 * the cross-session activity view is used; otherwise a plain running/queued/idle status is derived.
 */
function decorateAgent(profile: AgentProfile, act?: SessionActivitySummary): FleetAgentView {
  const thread = store.getThreadMeta(profile.threadId)
  const running = act?.running ?? runManager.isRunning(profile.threadId)
  const unread = act?.unread ?? sessionMessaging.unreadCount(profile.threadId)
  const statusText = act?.statusText ?? (running ? 'running' : unread > 0 ? `queued (${unread})` : 'idle')
  return {
    ...profile,
    title: thread?.title ?? profile.name,
    model: thread?.model ?? '',
    effort: thread?.effort,
    mode: thread?.mode ?? 'act',
    permissionPreset: thread?.permissionPreset ?? 'workspace',
    cwd: thread?.cwd,
    goal: thread?.goal,
    rolling: !!thread?.contextPolicy,
    running,
    unread,
    status: act?.status,
    statusText,
    activity: act?.activity,
    preview: lastPreview(profile.threadId),
    lastActivityAt: thread?.updatedAt ?? profile.updatedAt,
    ...(thread ? { taskUsage: currentTaskUsage(profile, thread.model) } : {})
  }
}

/**
 * The current task's usage for a Fleet card. A worker's task starts at the delegation that woke it;
 * an orchestrator's at the person's latest message (the reports that wake it belong to that job).
 */
function currentTaskUsage(profile: AgentProfile, model: string): TaskUsage | undefined {
  const since =
    profile.kind === 'orchestrator'
      ? store.lastHumanMessageAt(profile.threadId) ?? sessionMessaging.lastWokenAt(profile.threadId)
      : sessionMessaging.lastWokenAt(profile.threadId)
  if (since === undefined) return undefined
  try {
    return summarizeTaskUsage(since, store.listUsageSince(profile.threadId, since), model, runManager.cachedModelList(), store.getSettings().costOverrides)
  } catch {
    return undefined
  }
}

function push(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lattice:push', event)
  }
  // Anything that changes a thread also changes how that session looks to anyone watching it in the
  // cross-session activity view. The module coalesces and only acts on watched threads, so this is
  // a no-op unless the panel is actually open on that session.
  const changed = sessionActivity.threadOfEvent(event)
  if (changed) sessionActivity.noteSessionChange(changed)
  // Fan the same event out to any connected remote client (the iOS app) over the bridge's WebSocket.
  bridge.broadcast(event)
  raiseNotices(event)
}

/** Broadcast a thread's checklist after any edit, with the fresh list inline so panels never refetch. */
function pushTodos(threadId: string | undefined): void {
  push({ kind: 'todos.updated', threadId, todos: threadId ? store.listTodos(threadId) : undefined })
}

/**
 * Turn the moments that deserve noise into notices (see `notify.ts`): a main-run error, a subagent
 * that died, an approval or a question waiting on the user, and a run finishing while the window
 * is in the background. Job failures are raised by the run manager where the job settles. A notice
 * push never re-enters here (it is not one of these kinds), so this cannot loop.
 */
function raiseNotices(event: PushEvent): void {
  if (event.kind === 'run.event') {
    const { body, threadId, agent } = event.event
    if (body.type === 'error') {
      notify(push, {
        kind: 'failure',
        title: agent ? 'A subagent failed' : 'Run failed',
        body: body.message,
        threadId
      })
    } else if (body.type === 'run.completed' && !agent && body.reason === 'done') {
      notify(push, { kind: 'done', title: 'Run finished', threadId })
    }
  } else if (event.kind === 'approval.request') {
    notify(push, {
      kind: 'attention',
      title: 'Approval needed',
      body: event.request.summary,
      threadId: event.request.threadId
    })
  } else if (event.kind === 'ask.request') {
    notify(push, {
      kind: 'attention',
      title: 'The model has a question',
      body: event.request.question,
      threadId: event.request.threadId
    })
  }
}

export async function registerIpc(): Promise<void> {
  if (runtimeLock) return
  const dataDir = app.getPath('userData')
  runtimeLock = await acquireRuntimeLock(dataDir)
  const ws = store.ensureDefaultWorkspace()
  // Any run still "active" at last quit died with the process; mark its dangling
  // assistant message as interrupted so the transcript stops showing it as running.
  store.reconcileInterruptedRuns()

  // Wire the inter-session messaging broker to the run manager + renderer push channel. It stays a
  // leaf module (no runManager import) by taking these as callbacks — mirroring the ask/approval brokers.
  sessionMessaging.configureSessionMessaging({
    push,
    isRunning: runManager.isRunning,
    stop: runManager.cancelRunForThread,
    steer: (opts) => {
      void runManager.send(opts, push)
    }
  })

  // The fleet runtime pushes roster changes made by the model's fleet tools (create_fleet, add_agent…)
  // to the Fleet screen the same way the IPC handlers below do, and borrows the cwd guard.
  fleet.configureFleet({
    push,
    isPathInsideRoots,
    stopThreadWork: runManager.cancelRunForThread,
    startFreshTask: (threadId) => runManager.startFreshTaskContext(threadId, push)
  })

  // The read-only cross-session activity view. Same leaf-module shape as the messaging broker: it
  // reads the store and the brokers itself, and takes its run-manager couplings as callbacks.
  sessionActivity.configureSessionActivity({
    push,
    isRunning: runManager.isRunning,
    runningAgents: (threadId) => runManager.runningAgentNames(threadId).length,
    runningJobs: (threadId) => listJobs(threadId).filter((j) => j.running).length
  })

  // Background jobs push a lightweight change notice; the inspector refetches the thread's jobs.
  configureBgJobs({ onChange: (threadId) => push({ kind: 'jobs.updated', threadId }) })

  // Stream terminal PTY output/exit to the renderer over the push channel (leaf module, no cycle).
  configureTerminal({
    onData: (id, data) => push({ kind: 'pty.data', id, data }),
    onExit: (id, exitCode) => push({ kind: 'pty.exit', id, exitCode })
  })

  // Stream the embedded browser's navigation state to the renderer's URL bar.
  configureBrowser({ onState: (state) => push({ kind: 'browser.state', state }) })

  const api: LatticeApi = {
    async listWorkspaces() {
      return store.listWorkspaces()
    },
    async createWorkspace(opts) {
      return store.createWorkspace(opts)
    },
    async updateWorkspace(id, patch) {
      return store.updateWorkspace(id, patch)
    },
    async deleteWorkspace(id) {
      store.deleteWorkspace(id)
    },
    async resolveWorkspace(path, opts) {
      const target = resolve(path)
      const matches: Array<{ workspace: typeof ws; specificity: number }> = []
      for (const workspace of store.listWorkspaces()) {
        const containingRoots: string[] = []
        for (const root of workspace.roots) {
          if (await isPathInsideRoots(target, [root])) containingRoots.push(root)
        }
        if (containingRoots.length) {
          matches.push({ workspace, specificity: Math.max(...containingRoots.map((root) => resolve(root).length)) })
        }
      }
      // The seeded home-directory workspace is a useful fallback, but a repo-specific workspace
      // must win when both contain the path. This keeps CLI sessions bound to the nearest project
      // root instead of silently filing every repository under the broadest workspace.
      const best = matches.sort((a, b) => b.specificity - a.specificity)[0]
      if (best) return best.workspace
      if (!opts?.create) throw new Error(`no workspace contains path: ${target}`)
      return store.createWorkspace({ name: basename(target) || 'Workspace', roots: [target] })
    },
    async listThreads(workspaceId, includeArchived) {
      return store.listThreads(workspaceId, includeArchived).map((t) => ({
        ...t,
        running: runManager.isRunning(t.id),
        lastMessagePreview: lastPreview(t.id)
      }))
    },
    async createThread(opts) {
      const settings = store.getSettings()
      const model = opts?.model ?? settings.defaultModel
      const workspaceId = opts?.workspaceId ?? ws.id
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === workspaceId)
      if (!workspace) throw new Error(`workspace not found: ${workspaceId}`)
      const cwd = opts?.cwd ? resolve(opts.cwd) : undefined
      if (cwd && !(await isPathInsideRoots(cwd, workspace.roots))) {
        throw new Error('thread cwd is outside the workspace roots')
      }
      return store.createThread({
        workspaceId,
        title: opts?.title,
        model,
        // The model's own default tier before the global one: a tier picked for a local model is
        // the wrong one for a hosted route (see runtime/effortDefaults).
        effort: opts?.effort ?? effortDefaultFor(model, settings) ?? settings.defaultEffort,
        mode: opts?.mode ?? settings.defaultMode,
        permissionPreset: opts?.permissionPreset ?? settings.defaultPermissionPreset,
        goal: opts?.goal,
        cwd
      })
    },
    async getThread(id, opts) {
      const meta = store.getThreadMeta(id)
      if (!meta) throw new Error(`thread not found: ${id}`)
      // A windowed read is what makes this cheap enough to open a chat on a phone: the full event
      // log of a long thread is tens of megabytes, nearly all of it tool results behind runs the
      // reader is not going to weave. Callers that want everything (the desktop transcript) simply
      // omit the options and get the previous behaviour byte for byte.
      const eventLimit = windowLimit(opts?.eventLimit)
      const messageLimit = windowLimit(opts?.messageLimit)
      return {
        meta: { ...meta, running: runManager.isRunning(id) },
        messages: messageLimit ? store.listRecentMessages(id, messageLimit) : store.listMessages(id),
        events: eventLimit ? windowEvents(store.listEvents(id), eventLimit) : store.listEvents(id)
      }
    },
    async getThreadView(id, opts) {
      const meta = store.getThreadMeta(id)
      if (!meta) throw new Error(`thread not found: ${id}`)
      const limit = Math.min(200, Math.max(1, Math.floor(opts?.messageLimit ?? 40)))
      const before = typeof opts?.before === 'number' && Number.isFinite(opts.before) ? opts.before : undefined
      const page = store.listMessagePage(id, limit, before)
      const running = runManager.isRunning(id)
      // Replay-only fields never render on a phone; the tool exchanges alone can be most of a
      // message's bytes.
      const messages = page.messages.map((m) => {
        const { toolExchanges: _tx, reasoningContent: _rc, ...rest } = m
        return rest as typeof m
      })
      // The live run is the last run on the thread while it is running: it streams compact events,
      // every other run behind the page is folded into a summary from its own rows only.
      const liveRunId = running ? [...page.messages].reverse().find((m) => m.role === 'assistant' && m.runId)?.runId : undefined
      const turns: Record<RunId, TurnSummary> = {}
      let events: RunEvent[] = []
      const seen = new Set<RunId>()
      for (const m of page.messages) {
        if (m.role !== 'assistant' || !m.runId || seen.has(m.runId)) continue
        seen.add(m.runId)
        const runEvents = store.listEventsForRun(id, m.runId)
        if (m.runId === liveRunId) {
          events = compactRunEvents(runEvents)
          continue
        }
        turns[m.runId] = summarizeTurn(m.runId, runEvents, { model: m.model })
      }
      return { meta: { ...meta, running }, messages, turns, events, hasMore: page.hasMore }
    },
    async getRunEvents(threadId, runId, opts) {
      if (!store.getThreadMeta(threadId)) throw new Error(`thread not found: ${threadId}`)
      const events = store.listEventsForRun(threadId, runId)
      return opts?.compact === false ? events : compactRunEvents(events, { maxResultChars: opts?.maxResultChars })
    },
    async searchThreads(query, limit) {
      return store.searchThreadContent(query, limit)
    },
    async updateThread(id, patch) {
      if (patch.cwd !== undefined && typeof patch.cwd === 'string' && patch.cwd.trim()) {
        const current = store.getThreadMeta(id)
        if (!current) throw new Error(`thread not found: ${id}`)
        const workspace = store.listWorkspaces().find((candidate) => candidate.id === current.workspaceId)
        if (!workspace) throw new Error(`workspace not found: ${current.workspaceId}`)
        const cwd = resolve(patch.cwd)
        if (!(await isPathInsideRoots(cwd, workspace.roots))) {
          throw new Error('thread cwd is outside the workspace roots')
        }
        patch = { ...patch, cwd }
      }
      // A model switch carries the thread's reasoning tier with it when the tier was inherited
      // rather than hand-picked — the composer's model picker is the usual way a thread reaches a
      // Claude route, so this is where the per-model default actually lands.
      const derived = withDerivedEffort(patch as Partial<ThreadMeta>, store.getThreadMeta(id), store.getSettings())
      const meta = store.updateThread(id, derived)
      push({ kind: 'thread.updated', meta })
      return meta
    },
    async setPermissionRules(threadId: string, rules: PermissionRule[]) {
      if (!store.getThreadMeta(threadId)) throw new Error(`thread not found: ${threadId}`)
      approvals.setThreadRules(threadId, Array.isArray(rules) ? rules : [])
    },
    async deleteThread(id) {
      // The runtime owns both the main run and detached background agents. Cancel unconditionally
      // before deleting so a settled-looking main turn cannot leave a child working against a thread
      // that is about to disappear.
      runManager.cancelRunForThread(id)
      store.deleteThread(id)
      approvals.clearThreadRules(id)
      clearLoaded(id) // drop the thread's deferred-tool loadout with it
      killThreadJobs(id) // kill any background jobs the thread started
      push({ kind: 'thread.deleted', id })
    },
    async clearThread(id) {
      // A detached background agent may outlive the main model turn, so the clear path must cancel
      // the thread's runtime state even when the main-run predicate is already idle.
      runManager.cancelRunForThread(id)
      store.clearThreadContent(id)
      clearLoaded(id) // the loadout follows the transcript; an emptied history restarts from the core
      const meta = store.getThreadMeta(id)
      if (meta) push({ kind: 'thread.updated', meta: { ...meta, running: false, lastMessagePreview: undefined } })
    },
    async forkThread(id, opts) {
      const child = runManager.forkThread(id, opts)
      if (!child) throw new Error(`thread not found: ${id}`)
      push({ kind: 'thread.updated', meta: { ...child, lastMessagePreview: lastPreview(child.id) } })
      return child
    },
    async rollThread(id, opts) {
      return runManager.rollThread(id, push, opts)
    },
    async compactThread(id) {
      return runManager.compactThread(id, push)
    },
    async listThreadGroups(workspaceId) {
      return store.listThreadGroups(workspaceId ?? ws.id)
    },
    async createThreadGroup(opts) {
      const group = store.createThreadGroup({
        workspaceId: opts?.workspaceId ?? ws.id,
        name: opts?.name ?? 'New group',
        color: opts?.color
      })
      push({ kind: 'groups.updated', groups: store.listThreadGroups(group.workspaceId) })
      return group
    },
    async updateThreadGroup(id, patch) {
      const group = store.updateThreadGroup(id, patch)
      push({ kind: 'groups.updated', groups: store.listThreadGroups(group.workspaceId) })
      return group
    },
    async deleteThreadGroup(id) {
      store.deleteThreadGroup(id)
      push({ kind: 'groups.updated', groups: store.listThreadGroups(ws.id) })
    },
    async setThreadGroup(threadId, groupId) {
      const meta = store.setThreadGroup(threadId, groupId)
      push({ kind: 'thread.updated', meta: { ...meta, running: runManager.isRunning(threadId), lastMessagePreview: lastPreview(threadId) } })
      return meta
    },
    async send(opts: SendOptions) {
      return runManager.send(opts, push)
    },
    async cancelRun(runId) {
      runManager.cancelRun(runId)
    },
    async cancelAgent(agentId) {
      runManager.cancelAgent(agentId)
    },
    async stopThreadWork(threadId) {
      runManager.cancelRunForThread(threadId)
      const meta = store.getThreadMeta(threadId)
      if (meta) push({ kind: 'thread.updated', meta: { ...meta, running: runManager.isRunning(threadId) } })
      push({ kind: 'jobs.updated', threadId })
    },
    async dequeueMessage(threadId, messageId) {
      return runManager.dequeueMessage(threadId, messageId, push)
    },
    async editQueuedMessage(threadId, messageId, text) {
      return runManager.editQueuedMessage(threadId, messageId, text, push)
    },
    async steerQueuedMessage(threadId, messageId) {
      return runManager.steerQueuedMessage(threadId, messageId, push)
    },
    async retryTurn(threadId, messageId, mode) {
      return runManager.retryTurn(threadId, messageId, push, mode)
    },
    async listTools(threadId) {
      const meta = store.getThreadMeta(threadId)
      if (!meta) return []
      return buildToolInventory({
        meta,
        core: [...builtinTools, findMcpTool()],
        deferred: deferredTools(),
        loadedNames: new Set(loadedDeferredTools(threadId).map((t) => t.name)),
        servers: mcpStatuses(),
        effectOf: runManager.toolEffect
      })
    },
    async listJobs(threadId) {
      return listJobs(threadId)
    },
    async stopJob(jobId) {
      return stopJob(jobId)
    },
    async listModels(refresh) {
      return fetchAllModels(store.getSettings().providers, refresh)
    },
    async checkModelHealth(modelIds, refresh) {
      // Each result is pushed as it lands so the picker fills in progressively, and the whole set is
      // returned for the caller that would rather await it.
      return checkModelHealth(Array.isArray(modelIds) ? modelIds : [], {
        refresh,
        onResult: (health) => push({ kind: 'model.health', health })
      })
    },
    async checkProvider(providerId) {
      const provider = store.getSettings().providers.find((p) => p.id === providerId)
      if (!provider) return { ok: false, count: 0, error: 'Unknown provider' }
      return probeProvider(provider)
    },
    async getSettings() {
      return store.getSettings()
    },
    async setSettings(patch: Partial<AppSettings>) {
      return store.setSettings(patch)
    },
    async listUsageRows() {
      return store.listUsageRows()
    },
    async getStatsSnapshot() {
      return computeSnapshot(true)
    },
    async respondApproval(decision) {
      approvals.resolveApproval(decision, push)
    },
    async pendingApprovals() {
      return approvals.listPendingApprovals()
    },
    async respondAsk(response) {
      asks.resolveAsk(response, push)
    },
    async pendingAsks() {
      return asks.listPendingAsks()
    },
    async getContextBudget(threadId) {
      const models = await fetchAllModels(store.getSettings().providers).catch(() => [])
      return runManager.getContextBudget(threadId, models)
    },
    async fsTree(path) {
      return fsTree(path)
    },
    async fsReadFile(path) {
      return fsReadFile(path)
    },
    async attachFile(path) {
      return attachPath(path)
    },
    async fileChanges(threadId) {
      return store.listFileChanges(threadId)
    },
    async ptyCreate(opts) {
      return createTerminal({ cwd: opts?.cwd ?? ws.roots[0], cols: opts?.cols, rows: opts?.rows })
    },
    async ptyInput(id, data) {
      writeTerminal(id, data)
    },
    async ptyResize(id, cols, rows) {
      resizeTerminal(id, cols, rows)
    },
    async ptyKill(id) {
      killTerminal(id)
    },
    async browserAttach(bounds) {
      return browserAttach(bounds)
    },
    async browserSetBounds(bounds) {
      browserSetBounds(bounds)
    },
    async browserDetach() {
      browserDetach()
    },
    async browserNavigate(url) {
      browserNavigate(url)
    },
    async browserBack() {
      browserBack()
    },
    async browserForward() {
      browserForward()
    },
    async browserReload() {
      browserReload()
    },
    async browserStop() {
      browserStop()
    },
    async listTodos(threadId) {
      return store.listTodos(threadId)
    },
    async upsertTodo(todo) {
      const result = store.upsertTodo({ workspaceId: ws.id, source: 'user', ...todo })
      pushTodos(result.threadId)
      return result
    },
    async updateTodo(id, patch) {
      const result = store.updateTodo(id, patch)
      if (result) pushTodos(result.threadId)
      return result
    },
    async deleteTodo(id) {
      const threadId = store.getTodo(id)?.threadId
      store.deleteTodo(id)
      pushTodos(threadId)
    },
    async clearTodos(threadId, mode) {
      const removed = store.clearTodos(threadId, mode)
      pushTodos(threadId)
      return removed
    },
    async reorderTodos(threadId, orderedIds) {
      store.reorderTodos(threadId, orderedIds)
      pushTodos(threadId)
    },
    async listMemory() {
      return store.listMemory()
    },
    async upsertMemory(item) {
      const prev = item.id ? store.getMemory(item.id) : null
      // This handler is only reached from the Memory tab, so an upsert of a model-authored item IS
      // the human review the export gate keys on (approve, pin, or edit). Re-approving an expired
      // row also clears its horizon — the person just said it still holds.
      const reviewedAt = prev && prev.author !== 'user' ? Date.now() : undefined
      const saved = store.upsertMemory({
        ...item,
        ...(reviewedAt ? { reviewedAt: item.reviewedAt ?? reviewedAt } : {}),
        ...(item.status === 'approved' && prev?.status === 'expired' ? { expiresAt: null } : {})
      })
      // A user approval/edit is the durable boundary: mirror approved Lattice memory to CC and
      // Hermes — debounced, so approving five items in a row is one diff-only export, off the
      // IPC handler's critical path.
      if (saved.status === 'approved' || prev?.status === 'approved') scheduleMemoryExport(ws)
      push({ kind: 'memory.updated' })
      return saved
    },
    async deleteMemory(id) {
      const prev = store.getMemory(id)
      store.deleteMemory(id)
      if (prev?.status === 'approved') scheduleMemoryExport(ws)
      push({ kind: 'memory.updated' })
    },
    async syncMemory() {
      // The button is the user saying "look again": bypass both change caches.
      store.sweepMemory()
      const report = await runMemorySync(ws, { force: true })
      push({ kind: 'memory.updated' })
      return report
    },
    async searchMemory(query) {
      const tokens = tokenizeQuery(query)
      if (tokens.length === 0) return []
      try {
        return store.searchMemoryFts(tokens, {
          statuses: ['approved', 'proposed', 'rejected', 'expired'],
          limit: 200
        })
      } catch {
        return rankMemorySearch(store.listMemory(), query)
      }
    },
    async listMemoryDuplicates() {
      // Only Lattice-authored rows can be merged; an import is a mirror of an external file.
      const own = store.listMemory().filter((m) => !isImported(m) && m.status !== 'rejected')
      return findDuplicatePairs(own).slice(0, 200)
    },
    async mergeMemory(keepId, dropIds, content) {
      const merged = store.mergeMemory(keepId, dropIds, content)
      if (merged) {
        scheduleMemoryExport(ws)
        push({ kind: 'memory.updated' })
      }
      return merged
    },
    async bulkMemory(ids, action) {
      let changed = 0
      const now = Date.now()
      for (const id of ids) {
        const m = store.getMemory(id)
        if (!m) continue
        if (action === 'delete') {
          if (isImported(m)) continue
          store.deleteMemory(id)
          changed += 1
          continue
        }
        if (isImported(m) && action !== 'pin' && action !== 'unpin') continue
        const patch: Parameters<typeof store.upsertMemory>[0] = { ...m }
        if (action === 'approve') {
          patch.status = 'approved'
          if (m.status === 'expired') patch.expiresAt = null
        } else if (action === 'reject') patch.status = 'rejected'
        else if (action === 'pin') patch.pinned = true
        else if (action === 'unpin') patch.pinned = false
        if (m.author !== 'user') patch.reviewedAt = m.reviewedAt ?? now
        store.upsertMemory(patch)
        changed += 1
      }
      if (changed) {
        scheduleMemoryExport(ws)
        push({ kind: 'memory.updated' })
      }
      return changed
    },
    async memoryCounts() {
      return store.memoryCounts()
    },
    async sweepMemory() {
      const report = store.sweepMemory()
      if (report.expired || report.retired || report.deletedExpired || report.deletedRejected) {
        scheduleMemoryExport(ws)
        push({ kind: 'memory.updated' })
      }
      return report
    },
    async listMcpServers() {
      return mcpStatuses()
    },
    async upsertMcpServer(config: McpServerConfig) {
      store.upsertMcpConfig(config)
      await reconnectServer(config.id)
      push({ kind: 'mcp.updated' })
    },
    async deleteMcpServer(id) {
      store.deleteMcpConfig(id)
      await disconnectServer(id)
      push({ kind: 'mcp.updated' })
    },
    async listSessions(excludeThreadId) {
      return sessionMessaging.listSessions(excludeThreadId)
    },
    async sendSessionMessage(opts) {
      return sessionMessaging.sendSessionMessage(opts)
    },
    async listInbox(threadId) {
      return sessionMessaging.listInbox(threadId)
    },
    async markSessionMessageRead(id) {
      return sessionMessaging.markSessionMessageRead(id)
    },
    async listSessionActivity(excludeThreadId) {
      return sessionActivity.listSessionActivity(excludeThreadId)
    },
    async getSessionActivity(threadId) {
      return sessionActivity.getSessionActivity(threadId)
    },
    async watchSessionActivity(threadIds) {
      sessionActivity.setWatchedSessions(Array.isArray(threadIds) ? threadIds : [])
    },
    // ----- agent fleets -----
    async listFleets(workspaceId) {
      return agents.listFleets(workspaceId)
    },
    async createFleet(opts) {
      const fleet = agents.createFleet({ workspaceId: opts?.workspaceId ?? ws.id, name: opts?.name })
      push({ kind: 'fleet.updated' })
      return fleet
    },
    async renameFleet(id, name) {
      const fleet = agents.renameFleet(id, String(name ?? ''))
      push({ kind: 'fleet.updated' })
      return fleet
    },
    async deleteFleet(id) {
      // A fleet's agents own their threads; tell the renderer each one is gone, then reload the fleet.
      const doomed = agents.listAgents(id)
      for (const agent of doomed) {
        runManager.cancelRunForThread(agent.threadId)
        agentMemory.archiveWorkingMemory(agent)
      }
      agents.deleteFleet(id)
      for (const agent of doomed) push({ kind: 'thread.deleted', id: agent.threadId })
      push({ kind: 'fleet.updated' })
    },
    async listAgents(fleetId) {
      // One activity snapshot for the whole fleet, so each card shows what its agent is doing now.
      const acts = new Map(sessionActivity.listSessionActivity().map((a) => [a.threadId, a]))
      return agents.listAgents(fleetId).map((p) => decorateAgent(p, acts.get(p.threadId)))
    },
    async listFleetActivity(fleetId, limit) {
      const roster = agents.listAgents(fleetId)
      const names = new Map(roster.map((a) => [a.threadId, a.name]))
      const clip = (s: string): string => (s.length > 600 ? `${s.slice(0, 599)}…` : s)
      return sessionMessaging
        .listMessagesAmong(roster.map((a) => a.threadId), Math.max(1, Math.min(200, Number(limit) || 40)))
        .map((m) => ({
          id: m.id,
          fromThreadId: m.fromThreadId,
          toThreadId: m.toThreadId,
          fromName: names.get(m.fromThreadId) ?? m.fromTitle,
          toName: names.get(m.toThreadId) ?? store.getThreadMeta(m.toThreadId)?.title ?? 'session',
          body: clip(m.body),
          createdAt: m.createdAt,
          delivery: m.delivery
        }))
    },
    async createAgent(opts) {
      const settings = store.getSettings()
      const fleetRow = agents.getFleet(opts.fleetId)
      if (!fleetRow) throw new Error(`fleet not found: ${opts.fleetId}`)
      const workspace = store.listWorkspaces().find((candidate) => candidate.id === fleetRow.workspaceId)
      if (!workspace) throw new Error(`workspace not found: ${fleetRow.workspaceId}`)
      const model = opts.model ?? settings.defaultModel
      let cwd: string | undefined
      if (opts.cwd && opts.cwd.trim()) {
        cwd = resolve(opts.cwd)
        if (!(await isPathInsideRoots(cwd, workspace.roots))) {
          throw new Error('agent cwd is outside the workspace roots')
        }
      }
      const { profile, thread } = agents.createAgent({
        fleetId: opts.fleetId,
        name: opts.name,
        kind: opts.kind,
        role: opts.role,
        model,
        effort: opts.effort ?? effortDefaultFor(model, settings) ?? settings.defaultEffort,
        mode: opts.mode ?? settings.defaultMode,
        permissionPreset: opts.permissionPreset ?? settings.defaultPermissionPreset,
        cwd,
        rolling: opts.rolling,
        allowedTools: opts.allowedTools
      })
      fleet.logFleetChange({ fleetId: opts.fleetId, profile, action: 'add', ctx: { actor: 'user' }, after: fleet.snapshotAgent(profile) })
      push({ kind: 'thread.updated', meta: thread })
      push({ kind: 'fleet.updated' })
      return decorateAgent(profile)
    },
    async updateAgent(id, patch) {
      const current = agents.getAgent(id)
      if (!current) throw new Error(`agent not found: ${id}`)
      let next = patch
      const currentThread = store.getThreadMeta(current.threadId)
      if (next.model !== undefined && next.effort === undefined) {
        const derived = withDerivedEffort({ model: next.model }, currentThread, store.getSettings())
        if ('effort' in derived) next = { ...next, effort: derived.effort ?? null }
      }
      // Validate a new cwd against the agent's workspace roots, exactly as updateThread does.
      if (next && typeof next.cwd === 'string' && next.cwd.trim()) {
        const thread = store.getThreadMeta(current.threadId)
        const workspace = thread
          ? store.listWorkspaces().find((candidate) => candidate.id === thread.workspaceId)
          : undefined
        if (!workspace) throw new Error('workspace not found for agent')
        const cwd = resolve(next.cwd)
        if (!(await isPathInsideRoots(cwd, workspace.roots))) {
          throw new Error('agent cwd is outside the workspace roots')
        }
        next = { ...next, cwd }
      }
      const beforeSnap = fleet.snapshotAgent(current)
      const profile = agents.updateAgent(id, next)
      fleet.logScreenUpdate(profile, beforeSnap)
      const thread = store.getThreadMeta(profile.threadId)
      if (thread) push({ kind: 'thread.updated', meta: thread })
      push({ kind: 'fleet.updated' })
      return decorateAgent(profile)
    },
    async deleteAgent(id) {
      const current = agents.getAgent(id)
      if (!current) return
      fleet.removeAgent(current, { actor: 'user' })
      push({ kind: 'thread.deleted', id: current.threadId })
      push({ kind: 'fleet.updated' })
    },
    async getAgentWorkingMemory(agentId) {
      const profile = agents.getAgent(agentId)
      if (!profile) throw new Error(`agent not found: ${agentId}`)
      return agentMemory.readWorkingMemory(profile)
    },
    async setAgentWorkingMemory(agentId, content, expectedUpdatedAt) {
      const profile = agents.getAgent(agentId)
      if (!profile) throw new Error(`agent not found: ${agentId}`)
      const before = agentMemory.readWorkingMemory(profile)
      const changedSinceOpen =
        (expectedUpdatedAt === null && before.exists) ||
        (typeof expectedUpdatedAt === 'number' && before.updatedAt !== expectedUpdatedAt)
      if (changedSinceOpen) {
        throw new Error('Working memory changed while you were editing it. Revert to load the agent\'s latest notes, then apply your edit again.')
      }
      const written = agentMemory.writeWorkingMemory(profile, String(content ?? ''))
      if (!written.ok) throw new Error(written.error)
      agents.recordFleetChange({
        fleetId: profile.fleetId,
        agentId: profile.id,
        agentName: profile.name,
        action: 'memory',
        actor: 'user',
        reason: 'edited working memory on the Fleet screen',
        before: { chars: before.exists ? before.chars : 0 },
        after: { chars: written.chars }
      })
      push({ kind: 'fleet.updated' })
      return agentMemory.readWorkingMemory(profile)
    },
    async listFleetChanges(fleetId, limit) {
      return agents.listFleetChanges(fleetId, { limit: Math.max(1, Math.min(200, Number(limit) || 50)) })
    },
    async synthesizeSpeech(text, overrides) {
      return synthesizeSpeech(String(text ?? ''), store.getSettings().speech, overrides ?? {})
    },
    async listSpeechVoices(overrides) {
      return listSpeechVoices(store.getSettings().speech, overrides ?? {})
    }
  }

  for (const [name, fn] of Object.entries(api)) {
    ipcMain.handle(`lattice:${name}`, (_ev, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

  // Expose the same api object to the remote bridge (iOS app), reached over the network instead of
  // over IPC. The bridge dispatches by method name against API_METHODS and redacts secrets.
  bridge.registerApi(api)
  if (process.env.LATTICE_NO_CONTROL_SOCKET !== '1') {
    try {
      controlSocket = await startLocalControlSocket({
        dataDir,
        mode: process.env.LATTICE_RUNTIME_MODE === 'serve' ? 'serve' : 'desktop',
        version: app.getVersion(),
        bridgePort: bridgeStatus().port || undefined
      })
      setControlStatus({ path: controlSocket.path, connections: controlSocket.connections })
    } catch (error) {
      await runtimeLock.release()
      runtimeLock = null
      throw error
    }
  }

  // Remote-access administration is renderer-ONLY (never on LatticeApi), so a connected remote
  // client can never set the password, toggle the bridge, or revoke its peers. Exposed to the
  // renderer through the `remote` namespace in the preload bridge.
  const syncBridge = async (): Promise<void> => {
    if (process.env.LATTICE_NO_REMOTE_BRIDGE === '1') {
      await stopBridge()
      return
    }
    const ra = store.getSettings().remoteAccess
    // The desktop app binds loopback (a tunnel fronts it); a headless VM deployment sets
    // LATTICE_BIND=0.0.0.0 so the VM is directly reachable (still gated by the password).
    const bindHost = process.env.LATTICE_BIND || '127.0.0.1'
    if (ra.enabled && hasPassword()) {
      await startBridge(ra.port, bindHost).catch((e) => push({ kind: 'notice', tone: 'error', text: `Remote bridge failed to start: ${(e as Error).message}` }))
    } else {
      await stopBridge()
    }
  }
  ipcMain.handle('lattice:remote:status', () => ({
    ...bridgeStatus(),
    hasPassword: hasPassword(),
    settings: store.getSettings().remoteAccess
  }))
  ipcMain.handle('lattice:remote:setEnabled', async (_ev, enabled: boolean) => {
    const ra = store.getSettings().remoteAccess
    store.setSettings({ remoteAccess: { ...ra, enabled } })
    await syncBridge()
    return { ...bridgeStatus(), hasPassword: hasPassword() }
  })
  ipcMain.handle('lattice:remote:setPassword', async (_ev, password: string) => {
    setPassword(String(password ?? ''))
    await syncBridge()
    return { hasPassword: hasPassword() }
  })
  ipcMain.handle('lattice:remote:setConfig', async (_ev, patch: { port?: number; publicUrl?: string; tokenTtlDays?: number }) => {
    const ra = store.getSettings().remoteAccess
    store.setSettings({
      remoteAccess: {
        ...ra,
        port: typeof patch.port === 'number' && patch.port > 0 ? patch.port : ra.port,
        publicUrl: patch.publicUrl ?? ra.publicUrl,
        tokenTtlDays: typeof patch.tokenTtlDays === 'number' && patch.tokenTtlDays > 0 ? patch.tokenTtlDays : ra.tokenTtlDays
      }
    })
    await syncBridge()
    return store.getSettings().remoteAccess
  })
  ipcMain.handle('lattice:remote:listDevices', () => listDevices())
  ipcMain.handle('lattice:remote:revokeDevice', (_ev, id: string) => {
    revokeDevice(String(id))
    return listDevices()
  })

  // Messaging-channel administration is renderer-only too: expose the selected assistant model,
  // never the Telegram token or other credentials kept beside it in channels/config.json.
  const channelStatus = async (): Promise<{
    telegramConfigured: boolean
    telegramEnabled: boolean
    gatewayRunning: boolean
    assistantModel?: string
  }> => {
    const config = loadChannelsConfig(dataDir)
    const live = await queryGateway(channelsPaths(dataDir).socket, { op: 'status' }, 1_000).catch(() => undefined)
    return {
      telegramConfigured: !!config.telegram?.botToken,
      telegramEnabled: config.telegram?.enabled === true,
      gatewayRunning: live?.ok === true,
      ...(config.assistant.model ? { assistantModel: config.assistant.model } : {})
    }
  }
  ipcMain.handle('lattice:channels:status', () => channelStatus())
  ipcMain.handle('lattice:channels:setAssistantModel', async (_ev, rawModel: unknown) => {
    const model = typeof rawModel === 'string' && rawModel.trim() ? rawModel.trim() : undefined
    if (model) {
      const models = await fetchAllModels(store.getSettings().providers)
      if (!models.some((candidate) => candidate.id === model)) throw new Error(`Unknown model: ${model}`)
    }
    const reply = await queryGateway(
      channelsPaths(dataDir).socket,
      { op: 'assistant-model', model: model ?? null },
      10_000
    ).catch(() => undefined)
    if (reply && reply.ok !== true) throw new Error(String(reply.error ?? 'The Telegram gateway rejected the model change'))
    if (!reply) {
      updateChannelsConfig(dataDir, (config) => {
        if (model) config.assistant.model = model
        else delete config.assistant.model
      })
    }
    return channelStatus()
  })
  // Boot the bridge now if it was left enabled with a password set.
  void syncBridge()

  // seed a default OmniRoute provider on first launch if none configured
  const settings = store.getSettings()
  if (settings.providers.length === 0) {
    store.setSettings({
      providers: [
        {
          id: ulid(),
          label: 'OmniRoute',
          kind: 'openai-compat',
          baseUrl: 'http://localhost:20128',
          apiKey: discoverOmniKey() ?? '',
          enabled: true,
          promptCaching: true
        }
      ]
    })
  } else {
    // migrate existing installs: backfill a missing key and default prompt caching on
    // (so the cache hit rate stops reading 0 for providers created before caching existed)
    const key = discoverOmniKey()
    const needsMigration = settings.providers.some(
      (p) => (p.enabled && !p.apiKey && key) || p.promptCaching === undefined
    )
    if (needsMigration) {
      store.setSettings({
        providers: settings.providers.map((p) => ({
          ...p,
          apiKey: p.enabled && !p.apiKey && key ? key : p.apiKey,
          promptCaching: p.promptCaching ?? true
        }))
      })
    }
  }

  // seed local MCP servers the host Claude config already knows how to launch. latchkey and
  // openbrowser both ship enabled (browser tools out of the box); the rest are added switched
  // off so the user can flip them on from the MCP panel when they want them.
  // LATTICE_NO_MCP=1 keeps a scratch runtime (benchmarks, isolated test data dirs) from seeding and
  // launching the user's MCP servers — browser automation servers would fight the real app's.
  if (process.env.LATTICE_NO_MCP !== '1') {
    seedHostMcpServers()

    // connect configured MCP servers in the background; tools appear once ready
    void initMcp()
  }

  // Memory housekeeping, then reconcile both directions on launch so all three agents start from
  // the same durable snapshot. The import half runs synchronously (the store is populated before
  // the first turn); the export half is async and diff-only. Best-effort — a missing or unreadable
  // store is reported inside the sync, not thrown here.
  try {
    store.sweepMemory()
    void runMemorySync(ws).catch(() => {})
  } catch {
    /* memory bridge is a convenience; never block startup on it */
  }
}

/** Stop the local runtime resources owned by registerIpc (used by desktop/headless/embedded exit). */
export async function stopRuntime(): Promise<void> {
  const socket = controlSocket
  controlSocket = null
  setControlStatus(undefined)
  if (socket) await socket.stop()
  const lock = runtimeLock
  runtimeLock = null
  if (lock) await lock.release()
}

/** Servers that ship enabled; every other discovered server is seeded switched off. */
const MCP_ENABLED_BY_DEFAULT = new Set(['latchkey', 'openbrowser'])

/**
 * Seed the local (command-launched) MCP servers from the host `~/.claude.json` so Lattice ships
 * with them wired up. Each server seeds once — a per-name marker file records it so a later user
 * deletion is respected rather than resurrected on the next launch. Remote/OAuth connectors
 * (url-based) are skipped: Lattice can't complete their auth, so surfacing them would only error.
 */
function seedHostMcpServers(): void {
  const discovered = collectClaudeMcpServers()
  // abrowser → latchkey (renamed 2026-09-11): replace the legacy row before seeding, or both run.
  const migration = planLegacyBrowserMigration(store.listMcpConfigs(), discovered)
  if (migration) {
    store.deleteMcpConfig(migration.removeId)
    store.upsertMcpConfig(migration.add)
    try {
      writeFileSync(join(app.getPath('userData'), 'mcp-seeded-latchkey'), new Date().toISOString())
    } catch {
      /* best-effort marker, as below */
    }
  }
  const existing = store.listMcpConfigs()
  for (const [name, entry] of Object.entries(discovered)) {
    if (typeof entry.command !== 'string' || !entry.command) continue // stdio-only
    const marker = join(app.getPath('userData'), `mcp-seeded-${name}`)
    if (existsSync(marker)) continue
    const config: McpServerConfig = {
      id: name,
      label: name,
      transport: 'stdio',
      command: entry.command,
      args: Array.isArray(entry.args) ? entry.args.map(String) : [],
      env: entry.env,
      enabled: MCP_ENABLED_BY_DEFAULT.has(name)
    }
    const already = existing.some(
      (c) => c.id === config.id || (c.command === config.command && (c.args ?? []).join(' ') === config.args!.join(' '))
    )
    if (!already) store.upsertMcpConfig(config)
    try {
      writeFileSync(marker, new Date().toISOString())
    } catch {
      /* marker is best-effort; worst case the seed re-checks (and no-ops) next launch */
    }
  }
}

interface RawMcpEntry {
  command?: string
  args?: unknown
  url?: string
  env?: Record<string, string>
}

/** Read the host `~/.claude.json` and merge every `mcpServers` map found in the config tree. */
function collectClaudeMcpServers(): Record<string, RawMcpEntry> {
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(join(homedir(), '.claude.json'), 'utf8'))
  } catch {
    return {}
  }
  const out: Record<string, RawMcpEntry> = {}
  const walk = (node: unknown): void => {
    if (!node || typeof node !== 'object') return
    const obj = node as Record<string, unknown>
    const servers = obj.mcpServers
    if (servers && typeof servers === 'object') {
      for (const [name, entry] of Object.entries(servers as Record<string, unknown>)) {
        if (!out[name] && entry && typeof entry === 'object' && ('command' in entry || 'url' in entry)) {
          out[name] = entry as RawMcpEntry
        }
      }
    }
    for (const value of Object.values(obj)) walk(value)
  }
  walk(raw)
  return out
}

/** Find the OmniRoute key: env var first, then the user's omni-cc wrapper script. */
function discoverOmniKey(): string | null {
  if (process.env.OMNI_KEY) return process.env.OMNI_KEY
  try {
    const script = readFileSync(join(homedir(), '.local', 'bin', 'omni-cc'), 'utf8')
    const m = script.match(/OMNI_KEY:-([A-Za-z0-9._-]+)/)
    return m?.[1] ?? null
  } catch {
    return null
  }
}

function lastPreview(threadId: string): string | undefined {
  const msgs = store.listMessages(threadId)
  const last = msgs[msgs.length - 1]
  return last?.text.replace(/\s+/g, ' ').slice(0, 80)
}
