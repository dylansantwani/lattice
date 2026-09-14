import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const testState = vi.hoisted(() => {
  const provider = {
    id: 'lean-provider',
    label: 'lean provider',
    kind: 'openai-compat' as const,
    baseUrl: 'http://test.invalid',
    apiKey: 'test-key',
    enabled: true,
    promptCaching: false
  }
  const streamChat = vi.fn<typeof import('../providers/openaiCompat').streamChat>(async function* (_provider, req) {
    const last = req.messages.at(-1)
    const asksForTitle = typeof last?.content === 'string' && /title/i.test(last.content) && req.messages.length > 0 && /Title:|Reply:/.test(last.content)
    yield { type: 'text' as const, text: asksForTitle ? 'Lean Profile Check' : 'done' }
    yield { type: 'finish' as const, reason: 'stop' }
  })
  return { provider, streamChat }
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-context-profile-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return { ...actual, streamChat: testState.streamChat }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testState.provider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn(), scheduleMemoryExport: vi.fn(), isImported: () => false }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn(async () => ({ stored: 0 })) }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { availableTools, buildWireMessages, housekeepingRequest, resolveToolCall, send, threadContextProfile } from './runManager'
import { LEAN_SYSTEM_PROMPT } from './contextProfile'
import type { ModelInfo } from '@shared/types'

const LOCAL = 'llamacpp/qwen36-q4kxl'
const HOSTED = 'cc/claude-fable-5'

function model(id: string, ownedBy: string): ModelInfo {
  return { id, name: id, provider: id.split('/')[0]!, ownedBy, contextLength: 131072, maxOutputTokens: 16384, capabilities: { vision: false, tools: true, reasoning: true, effortTiers: [] } }
}

function newThread(modelId: string, title = 'New thread') {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({ workspaceId: workspace.id, model: modelId, effort: 'high', mode: 'act', permissionPreset: 'full', ...(title === 'New thread' ? {} : { title }) })
}

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

const systemText = (content: unknown): string =>
  typeof content === 'string' ? content : (content as Array<{ text?: string }>).map((part) => part.text ?? '').join('')

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos()
  store.setSettings({ providers: [testState.provider], contextProfile: 'auto' })
  store.setCachedModels(testState.provider.id, [model(LOCAL, 'llamacpp'), model(HOSTED, 'claude')])
  testState.streamChat.mockClear()
  delete process.env.LATTICE_CONTEXT_PROFILE
  delete process.env.LATTICE_LEAN_PARTS
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('context profile in the run manager', () => {
  it('gives a local-model thread the lean tool set, compact schemas and the condensed prompt', () => {
    const lean = newThread(LOCAL)
    const full = newThread(HOSTED)
    expect(threadContextProfile(lean).profile).toBe('lean')
    expect(threadContextProfile(full).profile).toBe('full')

    const leanNames = availableTools(lean).map((tool) => tool.name)
    const fullNames = availableTools(full).map((tool) => tool.name)
    expect(fullNames).toContain('run_agent')
    expect(leanNames).not.toContain('run_agent')
    expect(leanNames).not.toContain('set_thread_title')
    expect(leanNames).not.toContain('show_image')
    expect(leanNames).toContain('fs_read')
    const shell = (list: ReturnType<typeof availableTools>) => list.find((tool) => tool.name === 'shell')!
    expect(shell(availableTools(lean)).description.length).toBeLessThan(shell(availableTools(full)).description.length)

    const leanSystem = systemText(buildWireMessages(lean.id, lean)[0]!.content)
    const fullSystem = systemText(buildWireMessages(full.id, full)[0]!.content)
    expect(leanSystem.startsWith(LEAN_SYSTEM_PROMPT)).toBe(true)
    expect(leanSystem).not.toContain('# Your tools')
    expect(fullSystem).toContain('# Your tools')
    expect(leanSystem.length).toBeLessThan(fullSystem.length / 3)
  })

  it('treats a model the user filed under a local machine as local before its listing is cached', () => {
    store.setCachedModels(testState.provider.id, [])
    const thread = newThread('qwen36-q4kxl')
    expect(threadContextProfile(thread).profile).toBe('full')
    store.setSettings({ modelSourceOverrides: { 'qwen36-q4kxl': 'pc5080' } })
    expect(threadContextProfile(thread).profile).toBe('lean')
  })

  it('refuses a hidden tool called by name, naming the context profile rather than permissions', () => {
    const lean = newThread(LOCAL)
    const refused = resolveToolCall('run_agent', lean) as { error: string }
    expect(refused.error).toContain('lean context profile')
    expect(refused.error).not.toContain('preset')
    expect('tool' in resolveToolCall('fs_read', lean)).toBe(true)
    expect('tool' in resolveToolCall('run_agent', newThread(HOSTED))).toBe(true)
  })

  it('honors the explicit setting and the benchmark env override', () => {
    const local = newThread(LOCAL)
    store.setSettings({ contextProfile: 'full' })
    expect(threadContextProfile(local).profile).toBe('full')
    process.env.LATTICE_CONTEXT_PROFILE = 'lean'
    expect(threadContextProfile(local).profile).toBe('lean')
    process.env.LATTICE_LEAN_PARTS = 'schema'
    expect([...threadContextProfile(local).parts]).toEqual(['schema'])
  })

  it('titles a lean thread as a continuation of its own request, so a single-slot server keeps the prefix', async () => {
    const thread = newThread(LOCAL)
    await send({ threadId: thread.id, text: 'check the lean profile end to end', disposition: 'send' }, () => undefined)
    await waitFor(() => testState.streamChat.mock.calls.length >= 2 && store.getThreadMeta(thread.id)?.title === 'Lean Profile Check')

    const [turn, title] = testState.streamChat.mock.calls.map((call) => call[1])
    expect(systemText(title!.messages[0]!.content)).toBe(systemText(turn!.messages[0]!.content))
    expect(title!.tools!.map((tool) => tool.function.name)).toEqual(turn!.tools!.map((tool) => tool.function.name))
    // Same history as the next turn will send, then the titling prompt last.
    const history = buildWireMessages(thread.id, store.getThreadMeta(thread.id)!, LOCAL, 'high')
    expect(title!.messages.slice(0, history.length).map((m) => systemText(m.content))).toEqual(history.map((m) => systemText(m.content)))
    expect(systemText(title!.messages.at(-1)!.content)).toContain('Title:')
    // A title needs no reasoning: the turn ran at `high`, the titling pass runs with it off.
    expect(turn!.effort).toBe('high')
    expect(title!.effort).toBe('off')
  })

  it('builds the continuation for the model that produced the turn, even if the thread switched models since', () => {
    const thread = newThread(LOCAL)
    store.updateThread(thread.id, { model: HOSTED })
    const request = housekeepingRequest(thread.id, LOCAL, LOCAL, 'high', 'Title:')
    expect(request.messages.length).toBeGreaterThan(1)
    expect(systemText(request.messages[0]!.content).startsWith(LEAN_SYSTEM_PROMPT)).toBe(true)
    expect(request.tools.map((tool) => tool.function.name)).not.toContain('run_agent')
  })

  it('keeps the lone titling prompt for hosted threads, a utility model, or with the part switched off', () => {
    const hosted = newThread(HOSTED)
    expect(housekeepingRequest(hosted.id, HOSTED, HOSTED, 'high', 'Title:').messages).toHaveLength(1)
    expect(housekeepingRequest(hosted.id, HOSTED, HOSTED, 'high', 'Title:')).not.toHaveProperty('effort')
    const local = newThread(LOCAL)
    expect(housekeepingRequest(local.id, 'mac/qwen3:4b', LOCAL, 'high', 'Title:')).toMatchObject({ tools: [], cache: false })
    process.env.LATTICE_LEAN_PARTS = 'tools,schema,inventory,prompt'
    expect(housekeepingRequest(local.id, LOCAL, LOCAL, 'high', 'Title:').messages).toHaveLength(1)
    delete process.env.LATTICE_LEAN_PARTS
    expect(housekeepingRequest(local.id, LOCAL, LOCAL, 'high', 'Title:').messages.length).toBeGreaterThan(1)
  })
})
