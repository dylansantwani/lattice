import { ipcMain, BrowserWindow, app } from 'electron'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import type { AppSettings, McpServerConfig, SendOptions, ThreadMeta } from '@shared/types'
import * as store from './store/eventStore'
import * as runManager from './runtime/runManager'
import { clearLoaded } from './runtime/toolCatalog'
import * as approvals from './runtime/approvals'
import * as asks from './runtime/asks'
import { runMemorySync } from './memory/bridge'
import { fetchAllModels } from './providers/registry'
import { initMcp, mcpStatuses, reconnectServer, disconnectServer } from './mcp/manager'
import { ulid } from '@shared/id'

function push(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lattice:push', event)
  }
}

export function registerIpc(): void {
  const ws = store.ensureDefaultWorkspace()
  // Any run still "active" at last quit died with the process; mark its dangling
  // assistant message as interrupted so the transcript stops showing it as running.
  store.reconcileInterruptedRuns()

  const api: LatticeApi = {
    async listWorkspaces() {
      return store.listWorkspaces()
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
      return store.createThread({
        workspaceId: opts?.workspaceId ?? ws.id,
        title: opts?.title,
        model: opts?.model ?? settings.defaultModel,
        effort: opts?.effort ?? settings.defaultEffort,
        mode: opts?.mode ?? settings.defaultMode,
        permissionPreset: settings.defaultPermissionPreset
      })
    },
    async getThread(id) {
      const meta = store.getThreadMeta(id)
      if (!meta) throw new Error(`thread not found: ${id}`)
      return {
        meta: { ...meta, running: runManager.isRunning(id) },
        messages: store.listMessages(id),
        events: store.listEvents(id)
      }
    },
    async searchThreads(query, limit) {
      return store.searchThreadContent(query, limit)
    },
    async updateThread(id, patch) {
      const meta = store.updateThread(id, patch as Partial<ThreadMeta>)
      push({ kind: 'thread.updated', meta })
      return meta
    },
    async deleteThread(id) {
      if (runManager.isRunning(id)) runManager.cancelRunForThread(id)
      store.deleteThread(id)
      clearLoaded(id) // drop the thread's deferred-tool loadout with it
      push({ kind: 'thread.deleted', id })
    },
    async clearThread(id) {
      if (runManager.isRunning(id)) runManager.cancelRunForThread(id)
      store.clearThreadContent(id)
      const meta = store.getThreadMeta(id)
      if (meta) push({ kind: 'thread.updated', meta: { ...meta, running: false, lastMessagePreview: undefined } })
    },
    async forkThread(id, opts) {
      const child = runManager.forkThread(id, opts)
      if (!child) throw new Error(`thread not found: ${id}`)
      push({ kind: 'thread.updated', meta: { ...child, lastMessagePreview: lastPreview(child.id) } })
      return child
    },
    async compactThread(id) {
      return runManager.compactThread(id, push)
    },
    async send(opts: SendOptions) {
      return runManager.send(opts, push)
    },
    async cancelRun(runId) {
      runManager.cancelRun(runId)
    },
    async dequeueMessage(threadId, messageId) {
      return runManager.dequeueMessage(threadId, messageId, push)
    },
    async editQueuedMessage(threadId, messageId, text) {
      return runManager.editQueuedMessage(threadId, messageId, text, push)
    },
    async listModels(refresh) {
      return fetchAllModels(store.getSettings().providers, refresh)
    },
    async getSettings() {
      return store.getSettings()
    },
    async setSettings(patch: Partial<AppSettings>) {
      return store.setSettings(patch)
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
    async listTodos(threadId) {
      return store.listTodos(threadId)
    },
    async upsertTodo(todo) {
      const result = store.upsertTodo({ workspaceId: ws.id, ...todo })
      push({ kind: 'todos.updated', threadId: result.threadId })
      return result
    },
    async listMemory() {
      return store.listMemory()
    },
    async upsertMemory(item) {
      const saved = store.upsertMemory(item)
      // A user approval/edit is the durable boundary: immediately mirror approved Lattice memory
      // to CC and Hermes instead of requiring a second manual Sync click.
      if (saved.status === 'approved') runMemorySync(ws)
      push({ kind: 'memory.updated' })
      return saved
    },
    async deleteMemory(id) {
      store.deleteMemory(id)
      runMemorySync(ws)
      push({ kind: 'memory.updated' })
    },
    async syncMemory() {
      return runMemorySync(ws)
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
    }
  }

  for (const [name, fn] of Object.entries(api)) {
    ipcMain.handle(`lattice:${name}`, (_ev, ...args) => (fn as (...a: unknown[]) => unknown)(...args))
  }

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

  // seed local MCP servers the host Claude config already knows how to launch. openbrowser
  // ships enabled (browser tools out of the box); the rest are added switched off so the user
  // can flip them on from the MCP panel when they want them.
  seedHostMcpServers()

  // connect configured MCP servers in the background; tools appear once ready
  void initMcp()

  // Reconcile both directions on launch so all three agents start from the same durable snapshot.
  // Best-effort — a missing or unreadable store is reported inside the sync, not thrown here.
  try {
    runMemorySync(ws)
  } catch {
    /* memory bridge is a convenience; never block startup on it */
  }
}

/** Servers that ship enabled; every other discovered server is seeded switched off. */
const MCP_ENABLED_BY_DEFAULT = new Set(['openbrowser'])

/**
 * Seed the local (command-launched) MCP servers from the host `~/.claude.json` so Lattice ships
 * with them wired up. Each server seeds once — a per-name marker file records it so a later user
 * deletion is respected rather than resurrected on the next launch. Remote/OAuth connectors
 * (url-based) are skipped: Lattice can't complete their auth, so surfacing them would only error.
 */
function seedHostMcpServers(): void {
  const discovered = collectClaudeMcpServers()
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
    const script = readFileSync(`${homedir()}/.local/bin/omni-cc`, 'utf8')
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
