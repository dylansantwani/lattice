import { bufferedByPipe } from '@shared/commandHints'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile, readFile, stat, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  builtinTools,
  rankMemorySearch,
  tokenizeQuery,
  leadingSleepSeconds,
  slowCommandHint,
  validateSubagentToolAllowlist,
  SLOW_COMMAND_HINT_MS,
  SLEEP_POLL_MIN_S,
  FOREGROUND_GRACE_MS,
  foregroundGraceMs,
  throttledProgress,
  JOB_WAIT_MAX_MS,
  jobWaitMs
} from './builtin'
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

describe('show_image', () => {
  it('reads an image file and returns it as an MCP-shaped image block', async () => {
    const png = join(root, 'chart.png')
    const bytes = Buffer.from('not-really-a-png-but-bytes-are-bytes')
    await writeFile(png, bytes)
    const res = await tool('show_image').run({ path: png, caption: 'Q3 revenue' }, ctx)
    expect(res).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: bytes.toString('base64'),
      path: png,
      caption: 'Q3 revenue'
    })
  })

  it('omits caption entirely when none is given', async () => {
    const png = join(root, 'plain.png')
    await writeFile(png, 'x')
    const res = await tool('show_image').run({ path: png }, ctx)
    expect(res).not.toHaveProperty('caption')
  })

  it('detects mime type from a handful of common extensions', async () => {
    const cases: [string, string][] = [
      ['a.jpg', 'image/jpeg'],
      ['a.jpeg', 'image/jpeg'],
      ['a.gif', 'image/gif'],
      ['a.webp', 'image/webp'],
      ['a.svg', 'image/svg+xml'],
      ['a.bmp', 'image/bmp']
    ]
    for (const [name, mime] of cases) {
      const p = join(root, name)
      await writeFile(p, 'x')
      const res = (await tool('show_image').run({ path: p }, ctx)) as { mimeType: string }
      expect(res.mimeType).toBe(mime)
    }
  })

  it('rejects an unsupported extension', async () => {
    const p = join(root, 'notes.txt')
    await writeFile(p, 'x')
    await expect(tool('show_image').run({ path: p }, ctx)).rejects.toThrow(/Unsupported image type/)
  })

  it('rejects a file over the size cap', async () => {
    const p = join(root, 'huge.png')
    await writeFile(p, Buffer.alloc(9 * 1024 * 1024))
    await expect(tool('show_image').run({ path: p }, ctx)).rejects.toThrow(/too large/)
  })

  it('rejects a directory', async () => {
    const p = join(root, 'dir.png')
    await mkdir(p)
    await expect(tool('show_image').run({ path: p }, ctx)).rejects.toThrow(/Not a file/)
  })

  it('also detects avif and ico by extension', async () => {
    for (const [name, mime] of [
      ['a.avif', 'image/avif'],
      ['a.ico', 'image/x-icon']
    ] as const) {
      const p = join(root, name)
      await writeFile(p, 'x')
      const res = (await tool('show_image').run({ path: p }, ctx)) as { mimeType: string }
      expect(res.mimeType).toBe(mime)
    }
  })
})

describe('show_image_data', () => {
  it('accepts base64 data with an explicit mime_type', async () => {
    const bytes = Buffer.from('hello')
    const res = await tool('show_image_data').run(
      { data: bytes.toString('base64'), mime_type: 'image/png', caption: 'hi' },
      ctx
    )
    expect(res).toEqual({ type: 'image', mimeType: 'image/png', data: bytes.toString('base64'), caption: 'hi' })
  })

  it('omits caption entirely when none is given', async () => {
    const res = await tool('show_image_data').run({ data: 'aGVsbG8=', mime_type: 'image/png' }, ctx)
    expect(res).not.toHaveProperty('caption')
  })

  it('parses a full data: URL, inferring mime_type from it', async () => {
    const bytes = Buffer.from('hello')
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`
    const res = await tool('show_image_data').run({ data: dataUrl }, ctx)
    expect(res).toMatchObject({ type: 'image', mimeType: 'image/jpeg', data: bytes.toString('base64') })
  })

  it('an explicit mime_type overrides the one embedded in a data: URL', async () => {
    const bytes = Buffer.from('hello')
    const dataUrl = `data:image/jpeg;base64,${bytes.toString('base64')}`
    const res = (await tool('show_image_data').run({ data: dataUrl, mime_type: 'image/png' }, ctx)) as {
      mimeType: string
    }
    expect(res.mimeType).toBe('image/png')
  })

  it('normalizes alternate MIME spellings (e.g. image/jpg, image/x-ms-bmp)', async () => {
    const a = (await tool('show_image_data').run({ data: 'aGVsbG8=', mime_type: 'image/jpg' }, ctx)) as {
      mimeType: string
    }
    expect(a.mimeType).toBe('image/jpeg')
    const b = (await tool('show_image_data').run({ data: 'aGVsbG8=', mime_type: 'image/x-ms-bmp' }, ctx)) as {
      mimeType: string
    }
    expect(b.mimeType).toBe('image/bmp')
  })

  it('rejects a data: URL that is not base64-encoded', async () => {
    await expect(tool('show_image_data').run({ data: 'data:image/png,not-base64' }, ctx)).rejects.toThrow(
      /base64-encoded/
    )
  })

  it('rejects a missing mime_type when data is not a data: URL', async () => {
    await expect(tool('show_image_data').run({ data: 'aGVsbG8=' }, ctx)).rejects.toThrow(/mime_type is required/)
  })

  it('rejects an unsupported mime_type', async () => {
    await expect(
      tool('show_image_data').run({ data: 'aGVsbG8=', mime_type: 'application/pdf' }, ctx)
    ).rejects.toThrow(/Unsupported image type/)
  })

  it('rejects data over the size cap', async () => {
    const big = Buffer.alloc(9 * 1024 * 1024).toString('base64')
    await expect(tool('show_image_data').run({ data: big, mime_type: 'image/png' }, ctx)).rejects.toThrow(
      /too large/
    )
  })

  it('rejects empty data', async () => {
    await expect(tool('show_image_data').run({ data: '   ' }, ctx)).rejects.toThrow(/non-empty/)
  })
})

describe('fetch_image', () => {
  afterEach(() => vi.unstubAllGlobals())

  // Literal IPs throughout (never a hostname): assertPublicHost skips DNS entirely for a literal
  // IP, so these tests never make a real network lookup regardless of sandboxing.
  const PUBLIC_URL = 'https://93.184.216.34/chart.png'

  it('fetches a public image URL and returns it as an MCP-shaped image block', async () => {
    const bytes = new TextEncoder().encode('fake-png-bytes')
    const fetchMock = vi.fn(async (_url: string | URL, _opts?: RequestInit) =>
      new Response(bytes, { status: 200, headers: { 'Content-Type': 'image/png' } })
    )
    vi.stubGlobal('fetch', fetchMock)
    const res = await tool('fetch_image').run({ url: PUBLIC_URL, caption: 'Q3' }, ctx)
    expect(res).toEqual({
      type: 'image',
      mimeType: 'image/png',
      data: Buffer.from(bytes).toString('base64'),
      url: PUBLIC_URL,
      caption: 'Q3'
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const opts = fetchMock.mock.calls[0]![1]
    expect(opts?.redirect).toBe('error')
  })

  it('falls back to a URL-extension guess when Content-Type is missing/generic', async () => {
    const bytes = new TextEncoder().encode('fake-jpeg')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(bytes, { status: 200, headers: { 'Content-Type': 'application/octet-stream' } }))
    )
    const res = (await tool('fetch_image').run({ url: 'https://93.184.216.34/photo.jpg' }, ctx)) as {
      mimeType: string
    }
    expect(res.mimeType).toBe('image/jpeg')
  })

  it('normalizes an alternate Content-Type spelling (image/x-icon vs image/vnd.microsoft.icon)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(new Uint8Array(1), { status: 200, headers: { 'Content-Type': 'image/vnd.microsoft.icon' } }))
    )
    const res = (await tool('fetch_image').run({ url: PUBLIC_URL }, ctx)) as { mimeType: string }
    expect(res.mimeType).toBe('image/x-icon')
  })

  it('rejects a non-image response with no recognizable extension', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'Content-Type': 'text/html' } }))
    )
    await expect(tool('fetch_image').run({ url: 'https://93.184.216.34/page' }, ctx)).rejects.toThrow(
      /did not return a supported image type/
    )
  })

  it('rejects a non-2xx response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })))
    await expect(tool('fetch_image').run({ url: PUBLIC_URL }, ctx)).rejects.toThrow(/404/)
  })

  it('rejects when the declared Content-Length exceeds the size cap', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(new Uint8Array(1), {
            status: 200,
            headers: { 'Content-Type': 'image/png', 'Content-Length': String(9 * 1024 * 1024) }
          })
      )
    )
    await expect(tool('fetch_image').run({ url: PUBLIC_URL }, ctx)).rejects.toThrow(/too large/)
  })

  it('aborts a response that streams past the size cap even if Content-Length lied', async () => {
    const chunk = new Uint8Array(1024 * 1024) // 1MB
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let i = 0; i < 9; i++) controller.enqueue(chunk)
        controller.close()
      }
    })
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(stream, {
            status: 200,
            // lies about the size — the streaming cap must catch it anyway
            headers: { 'Content-Type': 'image/png', 'Content-Length': '1' }
          })
      )
    )
    await expect(tool('fetch_image').run({ url: PUBLIC_URL }, ctx)).rejects.toThrow(/too large/)
  })

  it('rejects a non-http(s) URL scheme', async () => {
    await expect(tool('fetch_image').run({ url: 'file:///etc/passwd' }, ctx)).rejects.toThrow(
      /Unsupported URL scheme/
    )
  })

  it('rejects an invalid URL', async () => {
    await expect(tool('fetch_image').run({ url: 'not a url' }, ctx)).rejects.toThrow(/Invalid URL/)
  })

  it('rejects an empty URL', async () => {
    await expect(tool('fetch_image').run({ url: '' }, ctx)).rejects.toThrow(/non-empty/)
  })

  it('refuses localhost by name, without ever calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(tool('fetch_image').run({ url: 'http://localhost/x.png' }, ctx)).rejects.toThrow(/localhost/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a literal loopback IP, without ever calling fetch', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(tool('fetch_image').run({ url: 'http://127.0.0.1/x.png' }, ctx)).rejects.toThrow(
      /private\/internal/
    )
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a literal private-range IP (10.x)', async () => {
    await expect(tool('fetch_image').run({ url: 'http://10.0.0.5/x.png' }, ctx)).rejects.toThrow(
      /private\/internal/
    )
  })

  it('refuses a literal private-range IP (192.168.x)', async () => {
    await expect(tool('fetch_image').run({ url: 'http://192.168.1.1/x.png' }, ctx)).rejects.toThrow(
      /private\/internal/
    )
  })

  it('refuses the link-local range, which covers the cloud metadata address', async () => {
    await expect(
      tool('fetch_image').run({ url: 'http://169.254.169.254/latest/meta-data' }, ctx)
    ).rejects.toThrow(/private\/internal/)
  })

  it('refuses the IPv6 loopback address', async () => {
    await expect(tool('fetch_image').run({ url: 'http://[::1]/x.png' }, ctx)).rejects.toThrow(/private\/internal/)
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

  it('stamps the spawning callId onto the spec so the transcript can bind the agent to its row', async () => {
    const calls: { parentCallId?: string }[] = []
    const withSpawner = {
      ...ctx,
      callId: 'call_42',
      runSubagent: async (spec: { task: string; parentCallId?: string }) => {
        calls.push(spec)
        return { text: 'ok', agentId: 'a9', toolCalls: 0, toolNames: [] }
      },
      spawnBackgroundAgent: (spec: { task: string; parentCallId?: string }) => {
        calls.push(spec)
        return { agentId: 'a10', name: spec.task }
      }
    }
    await tool('run_agent').run({ task: 'x' }, withSpawner)
    expect(calls[0]!.parentCallId).toBe('call_42')
    await tool('run_agent').run({ task: 'y', background: true }, withSpawner)
    expect(calls[1]!.parentCallId).toBe('call_42')
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

describe('peek_agents (check in on background subagents)', () => {
  const peek = (agentId: string, status: 'running' | 'done' | 'error', extra: Record<string, unknown> = {}) => ({
    agentId,
    status,
    elapsedMs: 1000,
    idleMs: 100,
    toolCalls: 0,
    activity: status === 'running' ? 'thinking' : status,
    ...extra
  })

  it('mirrors run_agent (network/execute/R0) so the delegation trio is gated together, and is allowed in plan', () => {
    const t = tool('peek_agents')
    expect(t.riskTier).toBe('R0')
    expect(t.action).toBe('execute')
    expect(t.resource).toBe('network')
    expect(t.allowedInPlan).toBe(true)
  })

  it('peeks via ctx.peekAgents and reports how many are still running', async () => {
    const calls: unknown[] = []
    const withPeek = {
      ...ctx,
      peekAgents: (opts: { agents?: string[] }) => {
        calls.push(opts)
        return [
          peek('a1', 'running', { currentTool: 'grep', activity: 'running grep', preview: '…' }),
          peek('a2', 'done', { result: 'answer', toolCalls: 3 })
        ]
      }
    }
    const res = (await tool('peek_agents').run({}, withPeek)) as { agents: unknown[]; running: number }
    // omitted `agents` peeks at every background agent
    expect(calls[0]).toEqual({ agents: undefined })
    expect(res.agents).toHaveLength(2)
    expect(res.running).toBe(1)
  })

  it('passes an agents filter straight through, cleaning blank names', async () => {
    let seen: unknown
    const withPeek = {
      ...ctx,
      peekAgents: (opts: unknown) => {
        seen = opts
        return []
      }
    }
    await tool('peek_agents').run({ agents: ['One', '  ', 'a2'] }, withPeek)
    expect(seen).toEqual({ agents: ['One', 'a2'] })
  })

  it('refuses when peeking is unavailable (e.g. inside a subagent)', async () => {
    await expect(tool('peek_agents').run({}, ctx)).rejects.toThrow(/not available here/)
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

  // ---- start_job: the dedicated "run this in the background" tool ----

  it('start_job mirrors shell\'s policy profile and is never delegatable', () => {
    expect(tool('start_job').resource).toBe('shell')
    expect(tool('start_job').action).toBe('execute')
    expect(tool('start_job').riskTier).toBe('R2')
    expect(tool('start_job').allowedInPlan).toBe(false)
    expect(() => validateSubagentToolAllowlist(['start_job'])).toThrow(/cannot be granted: start_job/)
  })

  it('start_job starts a detached job exactly like shell(background:true) and tells the model it will be pinged', async () => {
    const promoted: { jobId: string; command: string; kind: string }[] = []
    const res = (await tool('start_job').run(
      { command: 'echo via-start-job' },
      { ...ctx, promoteShellToBackground: (info) => promoted.push(info) }
    )) as { jobId: string; status: string; background: boolean; note: string }
    expect(res.background).toBe(true)
    expect(res.status).toBe('running')
    expect(res.jobId).toMatch(/^job_/)
    // Registered for the notify-on-completion ping as a deliberate background job.
    expect(promoted).toEqual([{ jobId: res.jobId, command: 'echo via-start-job', kind: 'background' }])
    expect(res.note).toMatch(/delivered to you automatically/)
    expect(res.note).toMatch(/CONTINUE WORKING/)
    expect(res.note).toMatch(/never poll with sleep/i)
    expect(res.note).toMatch(/job_status\(\{"jobs":\["job_/)
    const done = (await tool('job_status').run({ jobs: [res.jobId], wait: true }, ctx)) as {
      jobs: { status: string; output: string }[]
    }
    expect(done.jobs[0]).toMatchObject({ status: 'done' })
    expect(done.jobs[0]!.output).toContain('via-start-job')
  })

  it('shell(background:true) registers the job for the completion ping too', async () => {
    const promoted: { jobId: string; kind: string }[] = []
    const res = (await tool('shell').run(
      { command: 'echo bg-ping', background: true },
      { ...ctx, promoteShellToBackground: (info) => promoted.push(info) }
    )) as { jobId: string }
    expect(promoted).toEqual([{ jobId: res.jobId, command: 'echo bg-ping', kind: 'background' }])
  })

  it('without a ping hook (no run manager), the note points at job_status instead of promising a ping', async () => {
    const res = (await tool('start_job').run({ command: 'echo quiet' }, ctx)) as { note: string }
    expect(res.note).not.toMatch(/automatically/)
    expect(res.note).toMatch(/job_status/)
  })

  it('refuses a background job inside a subagent (nothing could deliver its result)', async () => {
    const sub = { ...ctx, agentIdentity: { agentId: 'a1', parentThreadId: 't1' } }
    await expect(tool('start_job').run({ command: 'echo nope' }, sub)).rejects.toThrow(/not available to a subagent/)
    await expect(tool('shell').run({ command: 'echo nope', background: true }, sub)).rejects.toThrow(
      /not available to a subagent/
    )
  })

  // ---- job_status: bounded wait ----

  it('job_status(wait) is bounded by timeout_ms and says the job will still report back', async () => {
    const started = (await tool('shell').run({ command: 'sleep 30', background: true }, ctx)) as {
      jobId: string
    }
    const t0 = Date.now()
    const res = (await tool('job_status').run({ jobs: [started.jobId], wait: true, timeout_ms: 1000 }, ctx)) as {
      jobs: { status: string }[]
      running: number
      timedOut?: boolean
      note?: string
    }
    expect(Date.now() - t0).toBeLessThan(5000)
    expect(res.running).toBe(1)
    expect(res.jobs[0]!.status).toBe('running')
    expect(res.timedOut).toBe(true)
    expect(res.note).toMatch(/delivered to you automatically/)
    expect(res.note).toMatch(/never poll with sleep/i)
    expect(res.note).toMatch(/CONTINUE WORKING/)
  })

  it('job_status returns no timedOut flag when the jobs finished within the wait', async () => {
    const started = (await tool('shell').run({ command: 'echo fast', background: true }, ctx)) as {
      jobId: string
    }
    const res = (await tool('job_status').run({ jobs: [started.jobId], wait: true, timeout_ms: 5000 }, ctx)) as {
      running: number
      timedOut?: boolean
    }
    expect(res.running).toBe(0)
    expect(res.timedOut).toBeUndefined()
  })

  // ---- sleep-polling guard ----

  it('refuses a long `sleep` while a background job is running, naming the job', async () => {
    const started = (await tool('shell').run({ command: 'sleep 30', background: true }, ctx)) as {
      jobId: string
    }
    await expect(
      tool('shell').run({ command: `sleep ${SLEEP_POLL_MIN_S}; echo tick` }, ctx)
    ).rejects.toThrow(new RegExp(`Refused: do not wait with \`sleep ${SLEEP_POLL_MIN_S}\`[\\s\\S]*${started.jobId}`))
  })

  it('refuses a `sleep` that could never finish inside the call timeout', async () => {
    await expect(tool('shell').run({ command: 'sleep 120; wc -l out.txt' }, ctx)).rejects.toThrow(
      /Refused: `sleep 120` is longer than this call's 120s timeout/
    )
  })

  it('still runs short sleeps and sleeps with no job to wait on', async () => {
    const res = (await tool('shell').run({ command: 'sleep 0; echo short-ok' }, ctx)) as { stdout: string }
    expect(res.stdout).toContain('short-ok')
  })
})

describe('background-job helpers', () => {
  it('leadingSleepSeconds recognises a leading sleep and its separators only', () => {
    expect(leadingSleepSeconds('sleep 115; echo tick')).toBe(115)
    expect(leadingSleepSeconds('  sleep 60 && ls')).toBe(60)
    expect(leadingSleepSeconds('sleep 2.5 | cat')).toBe(2.5)
    expect(leadingSleepSeconds('sleep 30')).toBe(30)
    expect(leadingSleepSeconds('echo hi; sleep 30')).toBeNull()
    expect(leadingSleepSeconds('sleeper 30')).toBeNull()
    expect(leadingSleepSeconds('sleep $N')).toBeNull()
    expect(leadingSleepSeconds('npm test')).toBeNull()
  })

  it('slowCommandHint fires only past the threshold and teaches the background pattern', () => {
    expect(slowCommandHint(SLOW_COMMAND_HINT_MS - 1)).toBeUndefined()
    const hint = slowCommandHint(45_000)
    expect(hint).toMatch(/blocked you for 45s/)
    expect(hint).toMatch(/start_job/)
    expect(hint).toMatch(/background: true/)
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

describe('run_agent — subagent model choice', () => {
  const spawnerOf = (calls: unknown[]): typeof ctx => ({
    ...ctx,
    runSubagent: async (spec: unknown) => {
      calls.push(spec)
      return { text: 'ok', agentId: 'agent_1', toolCalls: 0, toolNames: [] }
    }
  })

  it('refuses a model outside the allowed list and names the choices', async () => {
    const calls: unknown[] = []
    const withList = { ...spawnerOf(calls), subagentModels: ['cc/claude-fable-5', 'openrouter/z-ai/glm-5.3-flash'] }
    await expect(
      tool('run_agent').run({ task: 'x', model: 'cc/claude-opus-5' }, withList)
    ).rejects.toThrow(/not available for subagents.*"cc\/claude-fable-5", "openrouter\/z-ai\/glm-5\.3-flash"/)
    expect(calls).toHaveLength(0)
  })

  it('passes an allowed model through, trimmed', async () => {
    const calls: { model?: string }[] = []
    const withList = { ...spawnerOf(calls), subagentModels: ['cc/claude-fable-5', 'openrouter/z-ai/glm-5.3-flash'] }
    await tool('run_agent').run({ task: 'x', model: ' openrouter/z-ai/glm-5.3-flash ' }, withList)
    expect(calls[0]?.model).toBe('openrouter/z-ai/glm-5.3-flash')
  })

  it('omitting model always works (the subagent inherits the parent model)', async () => {
    const calls: { model?: string }[] = []
    const withList = { ...spawnerOf(calls), subagentModels: ['cc/claude-fable-5'] }
    await tool('run_agent').run({ task: 'x' }, withList)
    expect(calls[0]?.model).toBeUndefined()
  })

  it('does not restrict the model when no allowed list was injected', async () => {
    const calls: { model?: string }[] = []
    await tool('run_agent').run({ task: 'x', model: 'anything/goes' }, spawnerOf(calls))
    expect(calls[0]?.model).toBe('anything/goes')
  })
})

describe('shell — foreground grace window', () => {
  it('never lets a top-level run block past FOREGROUND_GRACE_MS, whatever timeout_ms asked for', () => {
    // The seven-minute foreground benchmark: the model asked for 420 s; it gets 20 s, then a job.
    expect(foregroundGraceMs(420_000, true)).toBe(FOREGROUND_GRACE_MS)
    expect(foregroundGraceMs(600_000, true)).toBe(FOREGROUND_GRACE_MS)
    expect(foregroundGraceMs(120_000, true)).toBe(FOREGROUND_GRACE_MS)
  })

  it('honours a shorter timeout_ms (a quick check), with a 1 s floor', () => {
    expect(foregroundGraceMs(5_000, true)).toBe(5_000)
    expect(foregroundGraceMs(10, true)).toBe(1_000)
  })

  it('does not promote inside a subagent (nothing could deliver the result back)', () => {
    expect(foregroundGraceMs(420_000, false)).toBeUndefined()
  })
})

describe('shell — purpose labels and live progress', () => {
  it('start_job records the purpose on the job and in the promotion info', async () => {
    const promoted: unknown[] = []
    const res = (await tool('start_job').run(
      { command: 'echo with-purpose', purpose: '  Say   hello  ' },
      { ...ctx, promoteShellToBackground: (info) => promoted.push(info) }
    )) as { jobId: string; purpose?: string }
    expect(res.purpose).toBe('Say hello')
    expect(promoted[0]).toMatchObject({ jobId: res.jobId, kind: 'background', purpose: 'Say hello' })
    const status = (await tool('job_status').run({ jobs: [res.jobId] }, ctx)) as { jobs: { purpose?: string }[] }
    expect(status.jobs[0]?.purpose).toBe('Say hello')
  })

  it('summarizes a command by its purpose when one is given', () => {
    expect(tool('shell').summarize({ command: 'pnpm test', purpose: 'Run the unit tests' })).toBe(
      'Run: Run the unit tests — pnpm test'
    )
    expect(tool('shell').summarize({ command: 'pnpm test', background: true })).toBe('Run (background): pnpm test')
    expect(tool('start_job').summarize({ command: 'pnpm build', purpose: 'Build it' })).toBe(
      'Run (background): Build it — pnpm build'
    )
  })

  it('throttledProgress coalesces chatty output into one snapshot per interval, ending on the latest', async () => {
    const reports: string[] = []
    const report = throttledProgress((o) => reports.push(o), 30)!
    report('a')
    report('ab')
    report('abc')
    // First call flushes immediately; the burst behind it collapses into a single trailing snapshot.
    expect(reports).toEqual(['a'])
    await new Promise((r) => setTimeout(r, 60))
    expect(reports).toEqual(['a', 'abc'])
    expect(throttledProgress(undefined)).toBeUndefined()
  })

  it('a foreground shell command streams its live output to ctx.progress', async () => {
    const snapshots: string[] = []
    const res = (await tool('shell').run(
      { command: 'echo live-one; sleep 0.5; echo live-two', purpose: 'Stream two lines' },
      { ...ctx, progress: (o) => snapshots.push(o) }
    )) as { exitCode: number; stdout: string }
    expect(res.exitCode).toBe(0)
    expect(res.stdout).toContain('live-two')
    // At least one snapshot landed before the command finished, carrying the first line.
    expect(snapshots.length).toBeGreaterThan(0)
    expect(snapshots.some((o) => o.includes('live-one'))).toBe(true)
  })
})

describe('job_status — never parks the model', () => {
  it('caps a top-level wait at JOB_WAIT_MAX_MS whatever timeout_ms asks for', () => {
    // The live case: job_status({wait:true, timeout_ms:590000}) right after starting a 10-minute sweep.
    expect(jobWaitMs(590_000, true)).toBe(JOB_WAIT_MAX_MS)
    expect(jobWaitMs(5_000, true)).toBe(5_000)
    expect(jobWaitMs(0, true)).toBe(JOB_WAIT_MAX_MS)
    expect(jobWaitMs(590_000, false)).toBe(590_000)
  })

  it('peeks by default: a running job comes back immediately, unclaimed', async () => {
    const promoted: unknown[] = []
    const started = (await tool('start_job').run(
      { command: 'sleep 5', purpose: 'Sleep a bit' },
      { ...ctx, promoteShellToBackground: (info) => promoted.push(info) }
    )) as { jobId: string }
    const t0 = Date.now()
    const res = (await tool('job_status').run({ jobs: [started.jobId] }, ctx)) as { running: number; timedOut?: boolean }
    expect(Date.now() - t0).toBeLessThan(1000)
    expect(res.running).toBe(1)
    expect(res.timedOut).toBeUndefined()
    await tool('stop_job').run({ jobs: [started.jobId] }, ctx)
  })

  it('tells the model when a job\'s pipeline hides its output', async () => {
    const res = (await tool('start_job').run(
      { command: 'sleep 2 | tail -60', purpose: 'Buffered' },
      { ...ctx, promoteShellToBackground: () => undefined }
    )) as { jobId: string; liveOutputNote?: string }
    expect(res.liveOutputNote).toMatch(/pipes through `tail`/)
    const peek = (await tool('job_status').run({ jobs: [res.jobId] }, ctx)) as { jobs: { liveOutputNote?: string }[] }
    expect(peek.jobs[0]?.liveOutputNote).toMatch(/holds everything/)
    await tool('stop_job').run({ jobs: [res.jobId] }, ctx)
  })
})

describe('bufferedByPipe', () => {
  it('names the final stage that swallows output until EOF', () => {
    expect(bufferedByPipe('python sweep.py 2>&1 | tail -60')).toBe('tail')
    expect(bufferedByPipe('ls | sort | head -5')).toBe('head')
    expect(bufferedByPipe('cat a | /usr/bin/wc -l')).toBe('wc')
    expect(bufferedByPipe('npm test')).toBeNull()
    expect(bufferedByPipe('grep x file | tee out.log')).toBeNull()
    expect(bufferedByPipe('cmd1 || cmd2')).toBeNull()
  })
})

describe('fs_read — several files in one round', () => {
  it('reads every path in one call and reports a missing one without failing the batch', async () => {
    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = join(root, 'fsread-batch')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'a.txt'), 'alpha')
    writeFileSync(join(dir, 'b.txt'), 'beta\nbravo')
    const res = (await tool('fs_read').run({ paths: [join(dir, 'a.txt'), join(dir, 'b.txt'), join(dir, 'missing.txt')], limit: 1 }, ctx)) as {
      files: { path: string; content?: string; error?: string }[]
    }
    expect(res.files.map((f) => f.content ?? 'ERR')).toEqual(['alpha', 'beta', 'ERR'])
    expect(res.files[2]!.error).toBeTruthy()
    expect(tool('fs_read').summarize({ paths: ['x', 'y', 'z', 'w'] })).toBe('Read 4 files: x, y, z…')
  })

  it('still reads a single path', async () => {
    await expect(tool('fs_read').run({}, ctx)).rejects.toThrow(/needs `path` or `paths`/)
  })
})
