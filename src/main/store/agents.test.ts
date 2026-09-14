import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-agents-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))

import * as store from './eventStore'
import { getDb, closeDb } from './db'
import * as agents from './agents'

let wsId: string

beforeEach(() => {
  getDb().exec(
    'DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM fleets; DELETE FROM agent_profiles'
  )
  agents.resetAgentCache()
  wsId = store.ensureDefaultWorkspace().id
})

afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const mkFleet = (name = 'Fleet'): string => agents.createFleet({ workspaceId: wsId, name }).id

describe('fleets', () => {
  it('creates and lists fleets scoped to a workspace', () => {
    mkFleet('Sourcing')
    mkFleet('Ops')
    const list = agents.listFleets(wsId)
    expect(list.map((f) => f.name).sort()).toEqual(['Ops', 'Sourcing'])
  })

  it('renames a fleet', () => {
    const id = mkFleet('Old')
    const next = agents.renameFleet(id, 'New')
    expect(next.name).toBe('New')
    expect(agents.getFleet(id)?.name).toBe('New')
  })
})

describe('agents', () => {
  it('creates an orchestrator: a thread carrying the role as its goal, and a profile bound to it', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'Conductor',
      kind: 'orchestrator',
      role: 'You run the fleet.',
      model: 'm/x'
    })
    expect(profile.kind).toBe('orchestrator')
    expect(profile.threadId).toBe(thread.id)
    // role is mirrored into the thread goal (which the prompt injects) and the title is the name.
    expect(thread.goal).toBe('You run the fleet.')
    expect(thread.title).toBe('Conductor')
    // the thread is flagged as an agent so it stays out of the regular sidebar
    expect(store.getThreadMeta(thread.id)?.isAgent).toBe(true)
    // cache reflects it immediately
    expect(agents.isOrchestratorThread(thread.id)).toBe(true)
    expect(agents.agentForThread(thread.id)?.id).toBe(profile.id)
  })

  it('creates a worker with a rolling context policy and a tool allowlist', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'eBay',
      kind: 'worker',
      model: 'm/x',
      rolling: true,
      allowedTools: ['fs_read', 'shell']
    })
    const meta = store.getThreadMeta(thread.id)
    expect(meta?.contextPolicy?.mode).toBe('rolling')
    expect(agents.isOrchestratorThread(thread.id)).toBe(false)
    expect(agents.agentAllowlist(thread.id)).toEqual(['fs_read', 'shell'])
    expect(profile.allowedTools).toEqual(['fs_read', 'shell'])
  })

  it('lists agents in a fleet in sort order', () => {
    const fleetId = mkFleet()
    agents.createAgent({ fleetId, name: 'A', kind: 'orchestrator', model: 'm/x' })
    agents.createAgent({ fleetId, name: 'B', kind: 'worker', model: 'm/x' })
    agents.createAgent({ fleetId, name: 'C', kind: 'worker', model: 'm/x' })
    expect(agents.listAgents(fleetId).map((a) => a.name)).toEqual(['A', 'B', 'C'])
  })

  it('updates role → thread goal, model → thread model, and toggles rolling off', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'W',
      kind: 'worker',
      model: 'm/x',
      role: 'first',
      rolling: true
    })
    agents.updateAgent(profile.id, { role: 'second', model: 'm/y', rolling: false })
    const meta = store.getThreadMeta(thread.id)
    expect(meta?.goal).toBe('second')
    expect(meta?.model).toBe('m/y')
    expect(meta?.contextPolicy).toBeUndefined()
  })

  it('clears an allowlist with null and reflects kind changes in the cache', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({
      fleetId,
      name: 'W',
      kind: 'worker',
      model: 'm/x',
      allowedTools: ['fs_read']
    })
    agents.updateAgent(profile.id, { allowedTools: null, kind: 'orchestrator' })
    expect(agents.agentAllowlist(thread.id)).toBeUndefined()
    expect(agents.isOrchestratorThread(thread.id)).toBe(true)
  })

  it('deleting an agent deletes its thread', () => {
    const fleetId = mkFleet()
    const { profile, thread } = agents.createAgent({ fleetId, name: 'W', kind: 'worker', model: 'm/x' })
    agents.deleteAgent(profile.id)
    expect(store.getThreadMeta(thread.id)).toBeNull()
    expect(agents.agentForThread(thread.id)).toBeUndefined()
    expect(agents.getAgent(profile.id)).toBeUndefined()
  })

  it('deleting a fleet deletes its agents and their threads', () => {
    const fleetId = mkFleet()
    const a = agents.createAgent({ fleetId, name: 'A', kind: 'orchestrator', model: 'm/x' })
    const b = agents.createAgent({ fleetId, name: 'B', kind: 'worker', model: 'm/x' })
    agents.deleteFleet(fleetId)
    expect(agents.listFleets(wsId)).toHaveLength(0)
    expect(store.getThreadMeta(a.thread.id)).toBeNull()
    expect(store.getThreadMeta(b.thread.id)).toBeNull()
  })
})
