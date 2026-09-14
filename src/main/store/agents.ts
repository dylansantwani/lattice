import { ulid } from '@shared/id'
import { prep } from './db'
import { createThread, deleteThread, getThreadMeta, updateThread } from './eventStore'
import type {
  AgentKind,
  AgentProfile,
  ContextPolicy,
  Fleet,
  Mode,
  PermissionPreset,
  ThreadMeta
} from '@shared/types'

/**
 * Persistent agent fleets (dedicated orchestrator + workers), the store layer.
 *
 * An agent is a saved role ({@link AgentProfile}) bound one-to-one to a persistent thread. Everything
 * that is really a *conversation* setting — model, cwd, mode/preset, rolling context — lives on the
 * thread and is reached through {@link createThread}/{@link updateThread}; the profile row only holds
 * name, kind, role and the optional tool allowlist. Deleting an agent deletes its thread.
 *
 * A small in-memory cache keyed by thread id backs {@link agentForThread}, because it is read on the
 * hot path (`availableTools`, once per model request) to decide whether a thread is an orchestrator
 * (gets the fleet tools) or a narrowed worker. Every write invalidates it.
 */

/** The rolling policy a "lives forever" agent thread gets: fold past ~120k tokens, keep ~40k verbatim. */
const ROLLING_POLICY: ContextPolicy = { mode: 'rolling', triggerTokens: 120_000, keepTokens: 40_000 }

// ---------- cache ----------

let cache: Map<string, AgentProfile> | null = null

function ensureCache(): Map<string, AgentProfile> {
  if (!cache) {
    cache = new Map()
    for (const row of allAgentRows()) cache.set(row.threadId, row)
  }
  return cache
}

function invalidate(): void {
  cache = null
}

/** The agent profile whose persistent thread is `threadId`, or undefined. Cached (hot path). */
export function agentForThread(threadId: string): AgentProfile | undefined {
  return ensureCache().get(threadId)
}

/** True when `threadId` is an orchestrator agent's thread (it gets the fleet tools). */
export function isOrchestratorThread(threadId: string): boolean {
  return ensureCache().get(threadId)?.kind === 'orchestrator'
}

/** A worker's builtin tool allowlist, or undefined for "inherit everything its mode/preset grants". */
export function agentAllowlist(threadId: string): string[] | undefined {
  const profile = ensureCache().get(threadId)
  return profile?.allowedTools && profile.allowedTools.length ? profile.allowedTools : undefined
}

// ---------- fleets ----------

export function listFleets(workspaceId?: string): Fleet[] {
  const rows = (
    workspaceId
      ? prep('SELECT * FROM fleets WHERE workspace_id = ? ORDER BY created_at').all(workspaceId)
      : prep('SELECT * FROM fleets ORDER BY created_at').all()
  ) as Record<string, unknown>[]
  return rows.map(rowToFleet)
}

export function getFleet(id: string): Fleet | undefined {
  const row = prep('SELECT * FROM fleets WHERE id = ?').get(id) as Record<string, unknown> | undefined
  return row ? rowToFleet(row) : undefined
}

export function createFleet(opts: { workspaceId: string; name?: string }): Fleet {
  const now = Date.now()
  const fleet: Fleet = {
    id: ulid(),
    workspaceId: opts.workspaceId,
    name: opts.name?.trim() || 'Fleet',
    createdAt: now,
    updatedAt: now
  }
  prep('INSERT INTO fleets (id, workspace_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)').run(
    fleet.id,
    fleet.workspaceId,
    fleet.name,
    fleet.createdAt,
    fleet.updatedAt
  )
  return fleet
}

export function renameFleet(id: string, name: string): Fleet {
  const current = getFleet(id)
  if (!current) throw new Error(`fleet not found: ${id}`)
  const next: Fleet = { ...current, name: name.trim() || current.name, updatedAt: Date.now() }
  prep('UPDATE fleets SET name = ?, updated_at = ? WHERE id = ?').run(next.name, next.updatedAt, id)
  return next
}

/** Delete a fleet and every agent in it (and each agent's thread). */
export function deleteFleet(id: string): void {
  for (const agent of listAgents(id)) deleteAgent(agent.id)
  prep('DELETE FROM fleets WHERE id = ?').run(id)
}

// ---------- agents ----------

export function listAgents(fleetId: string): AgentProfile[] {
  const rows = prep(
    'SELECT * FROM agent_profiles WHERE fleet_id = ? ORDER BY sort_order, created_at'
  ).all(fleetId) as Record<string, unknown>[]
  return rows.map(rowToAgent)
}

function allAgentRows(): AgentProfile[] {
  const rows = prep('SELECT * FROM agent_profiles').all() as Record<string, unknown>[]
  return rows.map(rowToAgent)
}

export function getAgent(id: string): AgentProfile | undefined {
  const row = prep('SELECT * FROM agent_profiles WHERE id = ?').get(id) as
    | Record<string, unknown>
    | undefined
  return row ? rowToAgent(row) : undefined
}

export interface CreateAgentOpts {
  fleetId: string
  name: string
  kind: AgentKind
  role?: string
  model: string
  effort?: string
  mode?: Mode
  permissionPreset?: PermissionPreset
  cwd?: string
  rolling?: boolean
  allowedTools?: string[]
}

/**
 * Create a dedicated agent: its persistent thread first (carrying the model, cwd, mode/preset, the
 * role as the thread goal so it is injected into the prompt, and a rolling policy when asked), then
 * the profile bound to it.
 */
export function createAgent(opts: CreateAgentOpts): { profile: AgentProfile; thread: ThreadMeta } {
  const fleet = getFleet(opts.fleetId)
  if (!fleet) throw new Error(`fleet not found: ${opts.fleetId}`)
  const name = opts.name.trim() || (opts.kind === 'orchestrator' ? 'Orchestrator' : 'Agent')
  const role = opts.role?.trim() || undefined
  const thread = createThread({
    workspaceId: fleet.workspaceId,
    title: name,
    titleSource: 'user',
    model: opts.model,
    effort: opts.effort,
    mode: opts.mode,
    permissionPreset: opts.permissionPreset,
    cwd: opts.cwd,
    goal: role,
    isAgent: true,
    ...(opts.rolling ? { contextPolicy: ROLLING_POLICY } : {})
  })
  const now = Date.now()
  const profile: AgentProfile = {
    id: ulid(),
    fleetId: opts.fleetId,
    threadId: thread.id,
    name,
    kind: opts.kind,
    role,
    allowedTools: opts.allowedTools && opts.allowedTools.length ? opts.allowedTools : undefined,
    sortOrder: nextSortOrder(opts.fleetId),
    createdAt: now,
    updatedAt: now
  }
  insertAgent(profile)
  invalidate()
  return { profile, thread }
}

export interface UpdateAgentPatch {
  name?: string
  role?: string
  kind?: AgentKind
  allowedTools?: string[] | null
  sortOrder?: number
  // thread-side fields
  model?: string
  mode?: Mode
  permissionPreset?: PermissionPreset
  cwd?: string | null
  rolling?: boolean
}

/** Update an agent — routing name/role/kind/allowlist to the profile and the conversation fields to its thread. */
export function updateAgent(id: string, patch: UpdateAgentPatch): AgentProfile {
  const current = getAgent(id)
  if (!current) throw new Error(`agent not found: ${id}`)

  // Thread-side fields, when any were touched.
  const threadPatch: Partial<ThreadMeta> = {}
  if (patch.name !== undefined) threadPatch.title = patch.name.trim() || current.name
  if (patch.role !== undefined) threadPatch.goal = patch.role.trim() || undefined
  if (patch.model !== undefined) threadPatch.model = patch.model
  if (patch.mode !== undefined) threadPatch.mode = patch.mode
  if (patch.permissionPreset !== undefined) threadPatch.permissionPreset = patch.permissionPreset
  if (patch.cwd !== undefined) threadPatch.cwd = patch.cwd ?? undefined
  if (patch.rolling !== undefined) threadPatch.contextPolicy = patch.rolling ? ROLLING_POLICY : undefined
  if (Object.keys(threadPatch).length) updateThread(current.threadId, threadPatch)

  const next: AgentProfile = {
    ...current,
    name: patch.name?.trim() || current.name,
    kind: patch.kind ?? current.kind,
    role: patch.role !== undefined ? patch.role.trim() || undefined : current.role,
    allowedTools:
      patch.allowedTools === undefined
        ? current.allowedTools
        : patch.allowedTools && patch.allowedTools.length
          ? patch.allowedTools
          : undefined,
    sortOrder: patch.sortOrder ?? current.sortOrder,
    updatedAt: Date.now()
  }
  prep(
    'UPDATE agent_profiles SET name=?, kind=?, role=?, allowed_tools_json=?, sort_order=?, updated_at=? WHERE id=?'
  ).run(
    next.name,
    next.kind,
    next.role ?? null,
    next.allowedTools ? JSON.stringify(next.allowedTools) : null,
    next.sortOrder,
    next.updatedAt,
    id
  )
  invalidate()
  return next
}

/** Delete an agent and (by default) its persistent thread. */
export function deleteAgent(id: string, opts?: { keepThread?: boolean }): void {
  const current = getAgent(id)
  if (!current) return
  prep('DELETE FROM agent_profiles WHERE id = ?').run(id)
  if (!opts?.keepThread) {
    try {
      deleteThread(current.threadId)
    } catch {
      // Thread already gone — the profile removal is what matters.
    }
  }
  invalidate()
}

// ---------- storage helpers ----------

function nextSortOrder(fleetId: string): number {
  const row = prep('SELECT MAX(sort_order) AS m FROM agent_profiles WHERE fleet_id = ?').get(fleetId) as
    | { m: number | null }
    | undefined
  return (row?.m ?? -1) + 1
}

function insertAgent(a: AgentProfile): void {
  prep(
    `INSERT INTO agent_profiles (id, fleet_id, thread_id, name, kind, role, allowed_tools_json, sort_order, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    a.id,
    a.fleetId,
    a.threadId,
    a.name,
    a.kind,
    a.role ?? null,
    a.allowedTools ? JSON.stringify(a.allowedTools) : null,
    a.sortOrder,
    a.createdAt,
    a.updatedAt
  )
}

function rowToFleet(r: Record<string, unknown>): Fleet {
  return {
    id: r.id as string,
    workspaceId: r.workspace_id as string,
    name: r.name as string,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function rowToAgent(r: Record<string, unknown>): AgentProfile {
  const allow = r.allowed_tools_json ? safeParseArray(r.allowed_tools_json as string) : undefined
  return {
    id: r.id as string,
    fleetId: r.fleet_id as string,
    threadId: r.thread_id as string,
    name: r.name as string,
    kind: r.kind as AgentKind,
    role: (r.role as string) ?? undefined,
    allowedTools: allow && allow.length ? allow : undefined,
    sortOrder: (r.sort_order as number) ?? 0,
    createdAt: r.created_at as number,
    updatedAt: r.updated_at as number
  }
}

function safeParseArray(raw: string): string[] | undefined {
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === 'string') : undefined
  } catch {
    return undefined
  }
}

/** Drop the cache — for tests that reset the database between cases. */
export function resetAgentCache(): void {
  invalidate()
}
