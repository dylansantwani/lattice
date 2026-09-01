import { ipcMain, BrowserWindow } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import type { LatticeApi, PushEvent } from '@shared/ipc'
import type { AppSettings, McpServerConfig, SendOptions, ThreadMeta } from '@shared/types'
import * as store from './store/eventStore'
import * as runManager from './runtime/runManager'
import { fetchModels } from './providers/registry'
import { ulid } from '@shared/id'

function push(event: PushEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('lattice:push', event)
  }
}

export function registerIpc(): void {
  const ws = store.ensureDefaultWorkspace()

  const api: LatticeApi = {
    async listWorkspaces() {
      return store.listWorkspaces()
    },
    async listThreads(workspaceId) {
      return store.listThreads(workspaceId).map((t) => ({
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
    async updateThread(id, patch) {
      const meta = store.updateThread(id, patch as Partial<ThreadMeta>)
      push({ kind: 'thread.updated', meta })
      return meta
    },
    async deleteThread(id) {
      store.deleteThread(id)
    },
    async send(opts: SendOptions) {
      return runManager.send(opts, push)
    },
    async cancelRun(runId) {
      runManager.cancelRun(runId)
    },
    async listModels(refresh) {
      const settings = store.getSettings()
      const provider = settings.providers.find((p) => p.enabled)
      if (!provider) return []
      return fetchModels(provider, refresh)
    },
    async getSettings() {
      return store.getSettings()
    },
    async setSettings(patch: Partial<AppSettings>) {
      return store.setSettings(patch)
    },
    async respondApproval() {
      // approvals arrive with the tool broker (next slice)
    },
    async pendingApprovals() {
      return []
    },
    async getContextBudget(threadId) {
      const settings = store.getSettings()
      const provider = settings.providers.find((p) => p.enabled)
      const models = provider ? await fetchModels(provider).catch(() => []) : []
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
      return store.upsertMemory(item)
    },
    async deleteMemory(id) {
      store.deleteMemory(id)
    },
    async listMcpServers() {
      return store.listMcpConfigs().map((config) => ({
        config,
        status: { id: config.id, connected: false, tools: [] }
      }))
    },
    async upsertMcpServer(config: McpServerConfig) {
      store.upsertMcpConfig(config)
    },
    async deleteMcpServer(id) {
      store.deleteMcpConfig(id)
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
          enabled: true
        }
      ]
    })
  } else if (settings.providers.some((p) => p.enabled && !p.apiKey)) {
    const key = discoverOmniKey()
    if (key) {
      store.setSettings({
        providers: settings.providers.map((p) => (p.enabled && !p.apiKey ? { ...p, apiKey: key } : p))
      })
    }
  }
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
