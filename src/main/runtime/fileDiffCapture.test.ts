import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-filediff-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'lattice-filediff-work-'))
// The default workspace roots at $HOME; point it at the temp work dir so fs_write lands inside the
// approved roots (and passes the path-containment check) under the workspace preset.
process.env.HOME = workDir

const testProvider = {
  id: 'test-provider',
  label: 'test',
  kind: 'openai-compat' as const,
  baseUrl: 'http://test.invalid',
  apiKey: 'k',
  enabled: true,
  promptCaching: false
}

let streamCall = 0
const scriptedArgs = { path: join(workDir, 'out.txt'), content: 'hello world\nsecond line\n' }

vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return {
    ...actual,
    streamChat: vi.fn(async function* () {
      streamCall += 1
      if (streamCall === 1) {
        // First model turn: call fs_write with the scripted args, then stop for the tool round.
        yield { type: 'text' as const, text: 'Writing the file.' }
        yield {
          type: 'tool_call_delta' as const,
          index: 0,
          id: 'call_w',
          name: 'fs_write',
          argsDelta: JSON.stringify(scriptedArgs)
        }
        yield { type: 'finish' as const, reason: 'tool_calls' }
      } else {
        yield { type: 'text' as const, text: 'Done.' }
        yield { type: 'finish' as const, reason: 'stop' }
      }
    })
  }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testProvider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn(() => Promise.resolve()) }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { send } from './runManager'

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM file_changes')
  streamCall = 0
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('file-diff capture through the run loop', () => {
  it('records a create when the agent writes a new file', async () => {
    const ws = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: ws.id,
      title: 'Files run', // pre-titled → no title-generation stream perturbs the call sequence
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace' // fs_write is allowed here without approval
    })
    const push = (): void => {}

    await send({ threadId: thread.id, text: 'write out.txt', disposition: 'send' }, push)
    await waitFor(() => store.listFileChanges(thread.id).length > 0)

    const changes = store.listFileChanges(thread.id)
    expect(changes).toHaveLength(1)
    expect(changes[0]!.path).toBe(scriptedArgs.path)
    expect(changes[0]!.kind).toBe('create')
    expect(changes[0]!.before).toBeNull()
    expect(changes[0]!.after).toBe(scriptedArgs.content)
  })

  it('records an edit (keeping the original baseline) when the agent rewrites an existing file', async () => {
    const ws = store.ensureDefaultWorkspace()
    const thread = store.createThread({
      workspaceId: ws.id,
      title: 'Files run 2',
      model: 'test/model',
      effort: 'high',
      mode: 'act',
      permissionPreset: 'workspace'
    })
    // The file already exists with prior content → the capture should treat this as an edit and keep
    // the pre-edit baseline.
    writeFileSync(scriptedArgs.path, 'original baseline\n')
    const push = (): void => {}

    await send({ threadId: thread.id, text: 'rewrite out.txt', disposition: 'send' }, push)
    await waitFor(() => store.listFileChanges(thread.id).length > 0)

    const c = store.listFileChanges(thread.id)[0]!
    expect(c.kind).toBe('edit')
    expect(c.before).toBe('original baseline\n')
    expect(c.after).toBe(scriptedArgs.content)
  })
})
