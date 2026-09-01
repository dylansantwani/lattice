import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { builtinTools, rankMemorySearch, tokenizeQuery } from './builtin'
import { killThreadJobs } from './bgJobs'
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

describe('set_thread_title', () => {
  it('is a store-backed R0 edit with no path arg to contain', () => {
    const t = tool('set_thread_title')
    expect(t.riskTier).toBe('R0')
    expect(t.action).toBe('edit')
    expect(t.allowedInPlan).toBe(true)
    // Tagged filesystem for grouping, but it takes no path — so it must NOT declare pathArgs,
    // or the broker would reject it for a missing path (the todo_write/memory_* convention).
    expect(t.pathArgs).toBeUndefined()
  })

  it('rejects a blank title before touching the store', async () => {
    // The guard throws on an empty/whitespace title ahead of store.updateThread, so this never
    // reaches the database (kept out of this DB-less unit test on purpose).
    await expect(tool('set_thread_title').run({ title: '   ' }, ctx)).rejects.toThrow(/non-empty/)
    await expect(tool('set_thread_title').run({}, ctx)).rejects.toThrow(/non-empty/)
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

describe('run_agent (subagent delegation)', () => {
  it('is registered and available under the default preset (R0)', () => {
    const t = tool('run_agent')
    expect(t.riskTier).toBe('R0')
    expect(t.action).toBe('execute')
  })

  it('refuses to run when no subagent spawner is available (e.g. inside a subagent)', async () => {
    await expect(tool('run_agent').run({ task: 'do a thing' }, ctx)).rejects.toThrow(/cannot spawn/)
  })

  it('rejects an empty task', async () => {
    const withSpawner = {
      ...ctx,
      runSubagent: async () => ({ text: '', agentId: 'a', toolCalls: 0, toolNames: [] })
    }
    await expect(tool('run_agent').run({ task: '   ' }, withSpawner)).rejects.toThrow(/task is required/)
  })

  it('delegates to the spawner and returns its result to the caller', async () => {
    const calls: unknown[] = []
    const withSpawner = {
      ...ctx,
      runSubagent: async (spec: { task: string; name?: string; agentType?: string; model?: string }) => {
        calls.push(spec)
        return { text: 'the answer is 42', agentId: 'agent_1', toolCalls: 3, toolNames: ['fs_read'] }
      }
    }
    const res = await tool('run_agent').run(
      { task: 'find the answer', name: 'Answer Hunt', agent_type: 'researcher', model: 'cc/claude-opus-5' },
      withSpawner
    )
    expect(calls).toEqual([
      {
        task: 'find the answer',
        name: 'Answer Hunt',
        agentType: 'researcher',
        model: 'cc/claude-opus-5',
        effort: undefined,
        tools: undefined
      }
    ])
    expect(res).toEqual({ agentId: 'agent_1', toolCalls: 3, tools: ['fs_read'], result: 'the answer is 42' })
  })

  it('forwards the model-given name, trimmed to a sane length', async () => {
    const calls: { name?: string }[] = []
    const withSpawner = {
      ...ctx,
      runSubagent: async (spec: { task: string; name?: string }) => {
        calls.push(spec)
        return { text: 'ok', agentId: 'a4', toolCalls: 0, toolNames: [] }
      }
    }
    await tool('run_agent').run({ task: 'x', name: 'Docs Researcher' }, withSpawner)
    expect(calls[0]!.name).toBe('Docs Researcher')

    calls.length = 0
    await tool('run_agent').run({ task: 'x', name: 'N'.repeat(200) }, withSpawner)
    expect(calls[0]!.name!.length).toBe(60)
  })

  it('passes a tools allowlist through to the spawner and echoes what the subagent got', async () => {
    const calls: { tools?: string[] }[] = []
    const withSpawner = {
      ...ctx,
      runSubagent: async (spec: { task: string; tools?: string[] }) => {
        calls.push(spec)
        return { text: 'done', agentId: 'a2', toolCalls: 1, toolNames: spec.tools ?? [] }
      }
    }
    const res = await tool('run_agent').run(
      { task: 'read a file', tools: ['fs_read', 'grep_search'] },
      withSpawner
    )
    expect(calls[0]!.tools).toEqual(['fs_read', 'grep_search'])
    expect(res).toMatchObject({ tools: ['fs_read', 'grep_search'], result: 'done' })
  })

  it('forwards an empty allowlist verbatim (a text-only subagent)', async () => {
    const calls: { tools?: string[] }[] = []
    const withSpawner = {
      ...ctx,
      runSubagent: async (spec: { task: string; tools?: string[] }) => {
        calls.push(spec)
        return { text: 'ok', agentId: 'a3', toolCalls: 0, toolNames: spec.tools ?? [] }
      }
    }
    await tool('run_agent').run({ task: 'summarize', tools: [] }, withSpawner)
    expect(calls[0]!.tools).toEqual([])
  })

  it('rejects an unknown tool name with the valid set, before spawning', async () => {
    let spawned = false
    const withSpawner = {
      ...ctx,
      runSubagent: async () => {
        spawned = true
        return { text: '', agentId: 'a', toolCalls: 0, toolNames: [] }
      }
    }
    await expect(
      tool('run_agent').run({ task: 't', tools: ['fs_read', 'fs_reeed'] }, withSpawner)
    ).rejects.toThrow(/Unknown tool name\(s\): fs_reeed/)
    expect(spawned).toBe(false)
  })

  it('refuses to delegate run_agent, agent_result, ask_user, or set_thread_title', async () => {
    const withSpawner = {
      ...ctx,
      runSubagent: async () => ({ text: '', agentId: 'a', toolCalls: 0, toolNames: [] })
    }
    for (const forbidden of [
      'run_agent',
      'agent_result',
      'job_status',
      'stop_job',
      'ask_user',
      'set_thread_title'
    ]) {
      await expect(
        tool('run_agent').run({ task: 't', tools: [forbidden] }, withSpawner)
      ).rejects.toThrow(new RegExp(`cannot be granted: ${forbidden}`))
    }
  })

  it('rejects a non-array tools argument', async () => {
    const withSpawner = {
      ...ctx,
      runSubagent: async () => ({ text: '', agentId: 'a', toolCalls: 0, toolNames: [] })
    }
    await expect(
      tool('run_agent').run({ task: 't', tools: 'fs_read' }, withSpawner)
    ).rejects.toThrow(/tools must be an array/)
  })

  describe('background delegation', () => {
    it('background:true spawns without blocking and returns a live handle', async () => {
      const spawned: { name?: string }[] = []
      const withBg = {
        ...ctx,
        runSubagent: async () => ({ text: 'x', agentId: 'a', toolCalls: 0, toolNames: [] }),
        spawnBackgroundAgent: (spec: { name?: string }) => {
          spawned.push(spec)
          return { agentId: 'agent_bg1', name: spec.name }
        }
      }
      const res = await tool('run_agent').run(
        { task: 'crunch the corpus', name: 'Cruncher', background: true },
        withBg
      )
      expect(spawned).toHaveLength(1)
      expect(res).toMatchObject({ agentId: 'agent_bg1', name: 'Cruncher', status: 'running', background: true })
    })

    it('background:true errors when no background spawner is available', async () => {
      const noBg = {
        ...ctx,
        runSubagent: async () => ({ text: '', agentId: 'a', toolCalls: 0, toolNames: [] })
      }
      await expect(
        tool('run_agent').run({ task: 't', background: true }, noBg)
      ).rejects.toThrow(/Background subagents are not available/)
    })
  })
})

describe('agent_result (collect background subagents)', () => {
  it('mirrors run_agent (network/execute/R0) so the two are gated together, and is allowed in plan', () => {
    const t = tool('agent_result')
    expect(t.riskTier).toBe('R0')
    expect(t.action).toBe('execute')
    expect(t.resource).toBe('network')
    expect(t.allowedInPlan).toBe(true)
  })

  it('collects via ctx.collectAgents and reports how many are still running', async () => {
    const calls: unknown[] = []
    const withCollect = {
      ...ctx,
      collectAgents: async (opts: { agents?: string[]; wait: boolean }) => {
        calls.push(opts)
        return [
          { agentId: 'a1', name: 'One', status: 'done' as const, result: 'answer', toolCalls: 2, tools: ['fs_read'] },
          { agentId: 'a2', name: 'Two', status: 'running' as const }
        ]
      }
    }
    const res = (await tool('agent_result').run({ wait: true }, withCollect)) as {
      agents: unknown[]
      pending: number
    }
    // omitted `agents` targets every background agent; wait defaults through as true
    expect(calls[0]).toEqual({ agents: undefined, wait: true })
    expect(res.agents).toHaveLength(2)
    expect(res.pending).toBe(1)
  })

  it('passes an agents filter and wait:false straight through', async () => {
    let seen: unknown
    const withCollect = {
      ...ctx,
      collectAgents: async (opts: unknown) => {
        seen = opts
        return []
      }
    }
    await tool('agent_result').run({ agents: ['One', 'a2'], wait: false }, withCollect)
    expect(seen).toEqual({ agents: ['One', 'a2'], wait: false })
  })

  it('refuses when collection is unavailable (e.g. inside a subagent)', async () => {
    await expect(tool('agent_result').run({}, ctx)).rejects.toThrow(/not available here/)
  })
})

describe('ask_user', () => {
  type AskOption = { label: string; description?: string; recommended?: boolean }
  type AskSpec = { question: string; kind: string; options?: AskOption[]; placeholder?: string; multiline?: boolean }
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
    // Plain-string options are normalized into { label } objects for the renderer.
    expect(sink[1]).toMatchObject({ kind: 'choice', options: [{ label: 'a' }, { label: 'b' }] })
  })

  it('accepts rich options and keeps only the first recommended flag', async () => {
    const sink: AskSpec[] = []
    await tool('ask_user').run(
      {
        question: 'Which package manager?',
        options: [
          { label: 'pnpm', description: 'Fast, disk-efficient', recommended: true },
          'npm',
          { label: 'yarn', recommended: true } // second recommended must be dropped
        ]
      },
      withAsk({ answer: 'pnpm' }, sink)
    )
    expect(sink[0]).toMatchObject({
      kind: 'choice',
      options: [{ label: 'pnpm', description: 'Fast, disk-efficient', recommended: true }, { label: 'npm' }, { label: 'yarn' }]
    })
    expect(sink[0]!.options!.filter((o) => o.recommended)).toHaveLength(1)
  })

  it('always marks a recommended option — defaults to the first when the model marks none', async () => {
    const sink: AskSpec[] = []
    await tool('ask_user').run(
      { question: 'Which package manager?', options: ['pnpm', 'npm', 'yarn'] },
      withAsk({ answer: 'pnpm' }, sink)
    )
    const opts = sink[0]!.options!
    expect(opts.filter((o) => o.recommended)).toHaveLength(1)
    expect(opts[0]).toMatchObject({ label: 'pnpm', recommended: true })
  })

  it('respects an explicit recommended flag instead of forcing the first option', async () => {
    const sink: AskSpec[] = []
    await tool('ask_user').run(
      { question: 'Which?', options: [{ label: 'a' }, { label: 'b', recommended: true }, { label: 'c' }] },
      withAsk({ answer: 'b' }, sink)
    )
    const opts = sink[0]!.options!
    expect(opts.filter((o) => o.recommended)).toHaveLength(1)
    expect(opts.find((o) => o.recommended)!.label).toBe('b')
  })

  it('drops blank and duplicate-label options and caps at 8', async () => {
    const sink: AskSpec[] = []
    const many = Array.from({ length: 12 }, (_, i) => ({ label: `opt${i}` }))
    await tool('ask_user').run(
      { question: 'Pick', options: [{ label: '  ' }, 'dup', 'dup', ...many] },
      withAsk({ answer: 'x' }, sink)
    )
    const opts = sink[0]!.options!
    expect(opts.length).toBe(8)
    expect(opts.filter((o) => o.label === 'dup')).toHaveLength(1)
    expect(opts.some((o) => o.label === '')).toBe(false)
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

describe('background jobs (shell background + job_status + stop_job)', () => {
  // These tools spawn real (fast) child processes on ctx.threadMeta.id ('t1'); tear them down.
  afterEach(() => killThreadJobs('t1'))

  it('shell(background:true) starts a detached job and returns a live handle', async () => {
    const res = (await tool('shell').run({ command: 'echo bg-ok', background: true }, ctx)) as {
      jobId: string
      status: string
      background: boolean
    }
    expect(res.background).toBe(true)
    expect(res.status).toBe('running')
    expect(res.jobId).toMatch(/^job_/)
  })

  it('job_status waits for a background job and returns its output', async () => {
    const started = (await tool('shell').run({ command: 'echo collected', background: true }, ctx)) as {
      jobId: string
    }
    const res = (await tool('job_status').run({ jobs: [started.jobId], wait: true }, ctx)) as {
      jobs: { id: string; status: string; output: string }[]
      running: number
    }
    expect(res.running).toBe(0)
    expect(res.jobs[0]).toMatchObject({ id: started.jobId, status: 'done' })
    expect(res.jobs[0]!.output).toContain('collected')
  })

  it('stop_job cancels a running background job', async () => {
    const started = (await tool('shell').run({ command: 'sleep 30', background: true }, ctx)) as {
      jobId: string
    }
    const res = (await tool('stop_job').run({ jobs: [started.jobId] }, ctx)) as {
      stopped: string[]
      notRunning: string[]
    }
    expect(res.stopped).toEqual([started.jobId])
    const after = (await tool('job_status').run({ jobs: [started.jobId], wait: false }, ctx)) as {
      jobs: { status: string }[]
    }
    expect(after.jobs[0]!.status).toBe('canceled')
  })

  it('stop_job requires at least one job id', async () => {
    await expect(tool('stop_job').run({ jobs: [] }, ctx)).rejects.toThrow(/jobs is required/)
  })

  it('job_status is a read-only R0 tool; stop_job mirrors run_agent (execute/R0)', () => {
    expect(tool('job_status').action).toBe('read')
    expect(tool('job_status').riskTier).toBe('R0')
    expect(tool('stop_job').action).toBe('execute')
    expect(tool('stop_job').riskTier).toBe('R0')
  })
})

describe('tokenizeQuery', () => {
  it('lowercases, splits on non-alphanumerics, dedupes, and drops stopwords + 1-char tokens', () => {
    expect(tokenizeQuery('eBay 3D printable under 2 hours LH_Sold black PLA ebay')).toEqual([
      'ebay',
      '3d',
      'printable',
      'hours',
      'lh',
      'sold',
      'black',
      'pla'
    ])
  })

  it('returns [] for an all-stopword or empty query', () => {
    expect(tokenizeQuery('the a of for to')).toEqual([])
    expect(tokenizeQuery('   ')).toEqual([])
  })
})

describe('rankMemorySearch', () => {
  const m = (content: string, over: Partial<{ updatedAt: number; lastUsedAt: number }> = {}) => ({
    content,
    ...over
  })

  it('matches on ANY query word, not the exact whole phrase (the always-0 bug)', () => {
    const items = [m('The user resells black PLA 3D prints on eBay')]
    // The full multi-word query never appears verbatim, but individual words do.
    const out = rankMemorySearch(items, 'eBay 3D printable product research sold black PLA low competition')
    expect(out).toHaveLength(1)
  })

  it('ranks by number of distinct matching query words, highest first', () => {
    const items = [
      m('eBay reselling notes'), // matches: ebay
      m('black PLA prints sold on eBay') // matches: ebay, black, pla, sold
    ]
    const out = rankMemorySearch(items, 'eBay black PLA sold')
    expect(out[0]!.content).toBe('black PLA prints sold on eBay')
    expect(out[1]!.content).toBe('eBay reselling notes')
  })

  it('excludes items that match no query word', () => {
    const items = [m('a note about matplotlib charts')]
    expect(rankMemorySearch(items, 'ebay pla resell')).toEqual([])
  })

  it('breaks score ties by recency (lastUsedAt over updatedAt)', () => {
    const items = [
      m('ebay note one', { updatedAt: 1 }),
      m('ebay note two', { updatedAt: 5, lastUsedAt: 100 })
    ]
    const out = rankMemorySearch(items, 'ebay')
    expect(out[0]!.content).toBe('ebay note two')
  })

  it('returns [] for an all-stopword query rather than every item', () => {
    expect(rankMemorySearch([m('anything')], 'the of for')).toEqual([])
  })
})
