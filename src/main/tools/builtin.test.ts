import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools } from './builtin'
import type { ToolContext, ToolDefinition } from './types'

const tool = (name: string): ToolDefinition => {
  const found = builtinTools.find((t) => t.name === name)
  if (!found) throw new Error(`tool not found: ${name}`)
  return found
}

let root: string
let ctx: ToolContext

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'lattice-tools-'))
  ctx = {
    threadMeta: { id: 't1', workspaceId: 'w1' } as ToolContext['threadMeta'],
    workspace: { id: 'w1', name: 'test', roots: [root] } as ToolContext['workspace'],
    runId: 'r1',
    signal: new AbortController().signal
  }
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('tool registry shape', () => {
  it('exposes destructive delete at a higher risk tier than reversible mutations', () => {
    expect(tool('fs_delete').riskTier).toBe('R2')
    expect(tool('fs_move').riskTier).toBe('R1')
    expect(tool('fs_mkdir').riskTier).toBe('R1')
    expect(tool('fs_delete').action).toBe('delete')
  })

  it('declares both endpoints of a move as path args for containment checks', () => {
    expect(tool('fs_move').pathArgs).toEqual(['from', 'to'])
  })
})

describe('fs_mkdir', () => {
  it('creates nested directories', async () => {
    await tool('fs_mkdir').run({ path: join(root, 'a/b/c') }, ctx)
    expect((await stat(join(root, 'a/b/c'))).isDirectory()).toBe(true)
  })
})

describe('fs_delete', () => {
  it('removes a file', async () => {
    const f = join(root, 'file.txt')
    await writeFile(f, 'hi')
    const res = await tool('fs_delete').run({ path: f }, ctx)
    expect(res).toMatchObject({ removed: true, kind: 'file' })
    expect(await exists(f)).toBe(false)
  })

  it('refuses to delete a directory without recursive', async () => {
    await mkdir(join(root, 'dir'))
    await expect(tool('fs_delete').run({ path: join(root, 'dir') }, ctx)).rejects.toThrow(/recursive/)
    expect(await exists(join(root, 'dir'))).toBe(true)
  })

  it('removes a directory tree when recursive is set', async () => {
    await mkdir(join(root, 'dir/sub'), { recursive: true })
    await writeFile(join(root, 'dir/sub/x.txt'), 'x')
    await tool('fs_delete').run({ path: join(root, 'dir'), recursive: true }, ctx)
    expect(await exists(join(root, 'dir'))).toBe(false)
  })

  it('deletes a symlink without following it to the target', async () => {
    const target = join(root, 'target.txt')
    const link = join(root, 'link.txt')
    await writeFile(target, 'keep')
    await symlink(target, link)
    await tool('fs_delete').run({ path: link }, ctx)
    expect(await exists(link)).toBe(false)
    expect(await readFile(target, 'utf8')).toBe('keep')
  })

  it('refuses to delete a workspace root', async () => {
    await expect(tool('fs_delete').run({ path: root }, ctx)).rejects.toThrow(/workspace root/)
    expect(await exists(root)).toBe(true)
  })
})

describe('fs_move', () => {
  it('renames a file and creates missing parents', async () => {
    await writeFile(join(root, 'a.txt'), 'data')
    await tool('fs_move').run({ from: join(root, 'a.txt'), to: join(root, 'nested/b.txt') }, ctx)
    expect(await exists(join(root, 'a.txt'))).toBe(false)
    expect(await readFile(join(root, 'nested/b.txt'), 'utf8')).toBe('data')
  })

  it('refuses to overwrite an existing destination by default', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await expect(
      tool('fs_move').run({ from: join(root, 'a.txt'), to: join(root, 'b.txt') }, ctx)
    ).rejects.toThrow(/already exists/)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('b')
  })

  it('overwrites when overwrite is true', async () => {
    await writeFile(join(root, 'a.txt'), 'a')
    await writeFile(join(root, 'b.txt'), 'b')
    await tool('fs_move').run({ from: join(root, 'a.txt'), to: join(root, 'b.txt'), overwrite: true }, ctx)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('a')
  })
})

describe('run_agent (concurrent subagent spawn)', () => {
  type Spawned = { task: string; name?: string; agentType?: string; model?: string; effort?: string; tools?: string[] }
  const withAgents = (
    sink?: Spawned[],
    over?: Partial<NonNullable<ToolContext['agents']>>
  ): ToolContext => ({
    ...ctx,
    agents: {
      spawn: (spec) => {
        sink?.push(spec as Spawned)
        return { agentId: 'agent_1', name: spec.name ?? 'agent', status: 'running', tools: spec.tools ?? ['fs_read'] }
      },
      message: () => ({ ok: true, agentId: 'agent_1', name: 'agent', status: 'running' }),
      collect: async () => ({ ok: true, agentId: 'agent_1', name: 'agent', status: 'idle', result: 'done', toolCalls: 0 }),
      list: () => [],
      stop: () => ({ ok: true, name: 'agent' }),
      ...over
    }
  })

  it('is registered and available under the default preset (R0)', () => {
    const t = tool('run_agent')
    expect(t.riskTier).toBe('R0')
    expect(t.action).toBe('execute')
  })

  it('refuses to run when the agents API is absent (e.g. inside a subagent)', async () => {
    await expect(tool('run_agent').run({ task: 'do a thing' }, ctx)).rejects.toThrow(/cannot spawn/)
  })

  it('rejects an empty task', async () => {
    await expect(tool('run_agent').run({ task: '   ' }, withAgents())).rejects.toThrow(/task is required/)
  })

  it('spawns with the model-chosen name and returns the handle immediately', async () => {
    const sink: Spawned[] = []
    const res = (await tool('run_agent').run(
      { name: 'scout', task: 'find the answer', agent_type: 'researcher', model: 'cc/claude-opus-5' },
      withAgents(sink)
    )) as { agentId: string; name: string; status: string; tools: string[]; note: string }
    expect(sink).toEqual([
      { task: 'find the answer', name: 'scout', agentType: 'researcher', model: 'cc/claude-opus-5', effort: undefined, tools: undefined }
    ])
    expect(res.agentId).toBe('agent_1')
    expect(res.name).toBe('scout')
    expect(res.status).toBe('running')
    expect(res.tools).toEqual(['fs_read'])
    expect(res.note).toMatch(/collect_agent/)
  })

  it('passes a tools allowlist through to the spawner', async () => {
    const sink: Spawned[] = []
    await tool('run_agent').run({ task: 'read a file', tools: ['fs_read', 'grep_search'] }, withAgents(sink))
    expect(sink[0]!.tools).toEqual(['fs_read', 'grep_search'])
  })

  it('forwards an empty allowlist verbatim (a text-only subagent)', async () => {
    const sink: Spawned[] = []
    await tool('run_agent').run({ task: 'summarize', tools: [] }, withAgents(sink))
    expect(sink[0]!.tools).toEqual([])
  })

  it('rejects an unknown tool name with the valid set, before spawning', async () => {
    let spawned = false
    const ctxA = withAgents(undefined, {
      spawn: () => {
        spawned = true
        return { agentId: 'a', name: 'a', status: 'running', tools: [] }
      }
    })
    await expect(
      tool('run_agent').run({ task: 't', tools: ['fs_read', 'fs_reeed'] }, ctxA)
    ).rejects.toThrow(/Unknown tool name\(s\): fs_reeed/)
    expect(spawned).toBe(false)
  })

  it('refuses to delegate agent-management tools or ask_user', async () => {
    await expect(
      tool('run_agent').run({ task: 't', tools: ['run_agent'] }, withAgents())
    ).rejects.toThrow(/cannot be granted: run_agent/)
    await expect(
      tool('run_agent').run({ task: 't', tools: ['message_agent'] }, withAgents())
    ).rejects.toThrow(/cannot be granted: message_agent/)
    await expect(
      tool('run_agent').run({ task: 't', tools: ['ask_user'] }, withAgents())
    ).rejects.toThrow(/cannot be granted: ask_user/)
  })

  it('rejects a non-array tools argument', async () => {
    await expect(
      tool('run_agent').run({ task: 't', tools: 'fs_read' }, withAgents())
    ).rejects.toThrow(/tools must be an array/)
  })

  it('message_agent / collect_agent / list_agents / stop_agent route to the agents API', async () => {
    const ctxA = withAgents()
    expect(await tool('message_agent').run({ agent: 'scout', message: 'go' }, ctxA)).toMatchObject({ ok: true })
    expect(await tool('collect_agent').run({ agent: 'scout', wait: true }, ctxA)).toMatchObject({ result: 'done' })
    expect(await tool('list_agents').run({}, ctxA)).toMatchObject({ agents: [] })
    expect(await tool('stop_agent').run({ agent: 'scout' }, ctxA)).toMatchObject({ ok: true })
    // and they refuse when the agents API is absent
    await expect(tool('message_agent').run({ agent: 'x', message: 'y' }, ctx)).rejects.toThrow(/not available/)
  })
})

describe('ask_user', () => {
  type AskSpec = { question: string; kind: string; options?: string[]; placeholder?: string; multiline?: boolean }
  const withAsk = (
    answer: { answer: string; canceled?: boolean },
    sink?: AskSpec[]
  ): ToolContext => ({
    ...ctx,
    ask: async (spec: AskSpec) => {
      sink?.push(spec)
      return { requestId: 'ask_1', ...answer }
    }
  })

  it('is always available (R0, allowed in plan) so the model can ask in any mode', () => {
    expect(tool('ask_user').riskTier).toBe('R0')
    expect(tool('ask_user').allowedInPlan).toBe(true)
    expect(tool('ask_user').resource).toBe('external_action')
  })

  it('returns the user answer to the model', async () => {
    const res = await tool('ask_user').run({ question: 'Which port?' }, withAsk({ answer: '8080' }))
    expect(res).toEqual({ answer: '8080' })
  })

  it('reports a canceled question with a null answer', async () => {
    const res = await tool('ask_user').run({ question: 'Proceed?' }, withAsk({ answer: '', canceled: true }))
    expect(res).toEqual({ canceled: true, answer: null })
  })

  it('defaults to a text question, and to choice when options are given', async () => {
    const sink: AskSpec[] = []
    await tool('ask_user').run({ question: 'Your name?' }, withAsk({ answer: 'x' }, sink))
    await tool('ask_user').run(
      { question: 'Pick one', options: ['a', 'b'] },
      withAsk({ answer: 'a' }, sink)
    )
    expect(sink[0]).toMatchObject({ kind: 'text' })
    expect(sink[1]).toMatchObject({ kind: 'choice', options: ['a', 'b'] })
  })

  it('falls back to text when kind:choice is requested with no usable options', async () => {
    const sink: AskSpec[] = []
    await tool('ask_user').run({ question: 'Pick', kind: 'choice', options: [] }, withAsk({ answer: 'x' }, sink))
    expect(sink[0]).toMatchObject({ kind: 'text' })
    expect(sink[0]!.options).toBeUndefined()
  })

  it('rejects an empty question', async () => {
    await expect(tool('ask_user').run({ question: '  ' }, withAsk({ answer: 'x' }))).rejects.toThrow(
      /question is required/
    )
  })

  it('refuses to run when asking is unavailable (e.g. inside a subagent)', async () => {
    await expect(tool('ask_user').run({ question: 'hi?' }, ctx)).rejects.toThrow(/not available/)
  })
})
