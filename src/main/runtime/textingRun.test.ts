/**
 * Run-level behavior of personal-assistant ("texting") threads and the runtime fixes that came with
 * them: the texting base prompt, steers that land between tool rounds, background completions that
 * wake the thread once (and may be acknowledged silently), rolling context, and vision fallback.
 * The provider is scripted; everything else (store, tools, background jobs) is real.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/types'
import type { StreamChunk, StreamRequest, WireMessage } from '../providers/openaiCompat'


const testState = vi.hoisted(() => {
  const provider = {
    id: 'test-provider',
    label: 'test provider',
    kind: 'openai-compat' as const,
    baseUrl: 'http://test.invalid',
    apiKey: 'test-key',
    enabled: true,
    promptCaching: false
  }
  const state = {
    provider,
    calls: [] as StreamRequest[],
    script: undefined as undefined | ((req: StreamRequest, call: number) => AsyncGenerator<StreamChunk>),
    distilledSpans: [] as string[]
  }
  return state
})

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-texting-run-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../providers/openaiCompat', async () => {
  const actual = await vi.importActual<typeof import('../providers/openaiCompat')>('../providers/openaiCompat')
  return {
    ...actual,
    streamChat: (_provider: unknown, req: StreamRequest) => {
      testState.calls.push(req)
      return testState.script!(req, testState.calls.length)
    }
  }
})
vi.mock('../providers/registry', () => ({ providerForModel: () => testState.provider }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn(), scheduleMemoryExport: vi.fn(), isImported: () => false }))
vi.mock('./selfLearn', () => ({
  distillMemories: vi.fn(async () => ({ stored: 0 })),
  distillSpan: vi.fn(async (deps: { transcript: string }) => {
    testState.distilledSpans.push(deps.transcript)
    return 2
  })
}))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { availableTools, buildWireMessages, isRunning, rollThread, send } from './runManager'
import { TEXTING_SYSTEM_PROMPT, TEXTING_VOICE } from './textingProfile'
import { ROLLING_SUMMARY_INSTRUCTION, ROLLING_SUMMARY_PREFIX } from './rollingContext'
import { IMAGE_DESCRIPTION_PROMPT } from './visionFallback'

const waitFor = async (predicate: () => boolean, timeoutMs = 4000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Timed out waiting for run state')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

async function* reply(text: string): AsyncGenerator<StreamChunk> {
  yield { type: 'text', text }
  yield { type: 'finish', reason: 'stop' }
}

async function* toolCalls(...calls: Array<{ id: string; name: string; args: unknown }>): AsyncGenerator<StreamChunk> {
  for (const [index, call] of calls.entries()) {
    yield { type: 'tool_call_delta', index, id: call.id, name: call.name, argsDelta: JSON.stringify(call.args) }
  }
  yield { type: 'finish', reason: 'tool_calls' }
}

const systemOf = (req: StreamRequest): string => (typeof req.messages[0]?.content === 'string' ? req.messages[0].content : '')
const isMainCall = (req: StreamRequest): boolean => systemOf(req).startsWith('You are Lattice')
const textOf = (message: WireMessage): string =>
  typeof message.content === 'string' ? message.content : Array.isArray(message.content) ? message.content.map((part) => part.text ?? '').join('') : ''

function assistantThread(extra: Partial<Parameters<typeof store.createThread>[0]> = {}) {
  const workspace = store.ensureDefaultWorkspace()
  return store.createThread({
    workspaceId: workspace.id,
    title: 'Assistant',
    model: 'test/model',
    mode: 'act',
    permissionPreset: 'full',
    replyStyle: 'texting',
    goal: 'Owner is Dylan.',
    ...extra
  })
}

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings; DELETE FROM model_cache; DELETE FROM image_descriptions')
  store.resetStoreMemos()
  testState.calls.length = 0
  testState.distilledSpans.length = 0
  testState.script = (req) => reply(isMainCall(req) ? 'ok' : 'Summary.')
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

describe('texting threads', () => {
  it('persist their reply style and rolling policy, and normalize a bad policy away', () => {
    const thread = assistantThread({ contextPolicy: { mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000 } })
    expect(store.getThreadMeta(thread.id)).toMatchObject({ replyStyle: 'texting', contextPolicy: { mode: 'rolling', triggerTokens: 80_000, keepTokens: 24_000 } })
    const updated = store.updateThread(thread.id, { contextPolicy: { mode: 'rolling', triggerTokens: 10, keepTokens: 5 } })
    expect(updated.contextPolicy).toBeUndefined()
    expect(store.getThreadMeta(thread.id)?.contextPolicy).toBeUndefined()
    store.updateThread(thread.id, { replyStyle: null as never })
    expect(store.getThreadMeta(thread.id)?.replyStyle).toBeUndefined()
  })

  it('use the texting base prompt with the goal as standing instructions, and never offer thread renames', () => {
    const thread = assistantThread()
    const wire = buildWireMessages(thread.id, thread, thread.model)
    const system = wire[0]!.content as string
    expect(system.startsWith(TEXTING_SYSTEM_PROMPT)).toBe(true)
    // The voice closes the prompt, after the tool inventory, where it is weighed most.
    expect(system.endsWith(TEXTING_VOICE)).toBe(true)
    expect(system.indexOf('# Standing instructions')).toBeLessThan(system.indexOf(TEXTING_VOICE))
    expect(system).not.toContain('well-structured GitHub-flavored Markdown')
    expect(system).toContain('# Standing instructions from the owner\nOwner is Dylan.')
    expect(system).not.toContain('north-star goal')
    expect(availableTools(thread).some((tool) => tool.name === 'set_thread_title')).toBe(false)
    expect(availableTools(thread).some((tool) => tool.name === 'show_image')).toBe(true)
    const plain = store.createThread({ workspaceId: thread.workspaceId, model: 'test/model', permissionPreset: 'full' })
    expect(availableTools(plain).some((tool) => tool.name === 'set_thread_title')).toBe(true)
  })
})

describe('texting length guard', () => {
  it('rewinds a reply too long to text and keeps the short rewrite', async () => {
    const thread = assistantThread()
    const essay = `Proton VPN. ${'Here is every detail about the endpoint and the exit IP. '.repeat(12)}`
    testState.script = (_req, call) => reply(call === 1 ? essay : 'proton. want the details?')
    await send({ threadId: thread.id, text: 'what vpn do i use', disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(thread.id) && testState.calls.length >= 2)
    const final = store.listMessages(thread.id).filter((message) => message.role === 'assistant')
    expect(final.at(-1)!.text).toBe('proton. want the details?')
    const nudge = testState.calls[1]!.messages.at(-1)!
    expect(textOf(nudge)).toContain('too long to text')
    expect(store.listEvents(thread.id).some((event) => event.body.type === 'retry' && event.body.rewound)).toBe(true)
  })

  it('asks only once: a second long reply (they asked for a draft) stands', async () => {
    const thread = assistantThread()
    const draft = 'Dear landlord, '.padEnd(900, 'x')
    testState.script = () => reply(draft)
    await send({ threadId: thread.id, text: 'write me the full email draft', disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(thread.id) && testState.calls.length >= 2)
    expect(testState.calls).toHaveLength(2)
    expect(store.listMessages(thread.id).filter((message) => message.role === 'assistant').at(-1)!.text).toBe(draft)
  })

  it('leaves normal threads alone', async () => {
    const workspace = store.ensureDefaultWorkspace()
    const plain = store.createThread({ workspaceId: workspace.id, model: 'test/model', permissionPreset: 'full' })
    testState.script = () => reply('x'.repeat(2_000))
    await send({ threadId: plain.id, text: 'explain', disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(plain.id) && testState.calls.length >= 1)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(testState.calls.filter(isMainCall)).toHaveLength(1)
  })
})

describe('steers between tool rounds', () => {
  it('reach the model at the next round boundary even when that round made tool calls', async () => {
    const thread = assistantThread()
    testState.script = (req, call) => {
      if (call === 1) return toolCalls({ id: 'c1', name: 'shell', args: { command: 'sleep 0.6; echo scanned', purpose: 'Scan' } })
      if (call === 2) return toolCalls({ id: 'c2', name: 'shell', args: { command: 'echo second', purpose: 'Second' } })
      return reply('done')
    }
    await send({ threadId: thread.id, text: 'scan the thing', disposition: 'send' }, () => {})
    await waitFor(() => store.listEvents(thread.id).some((event) => event.body.type === 'tool.started'))
    await send({ threadId: thread.id, text: 'update?', disposition: 'steer' }, () => {})
    await waitFor(() => !isRunning(thread.id))
    // Round 2 already had the steer, although round 1 ended in a tool call (so did round 2).
    const second = testState.calls[1]!
    const steerIndex = second.messages.findIndex((message) => message.role === 'user' && textOf(message) === 'update?')
    const toolIndex = second.messages.findIndex((message) => message.role === 'tool')
    expect(steerIndex).toBeGreaterThan(toolIndex)
    expect(toolIndex).toBeGreaterThan(0)
    // Transcript order stays truthful: reply-so-far → steer → continuation.
    const messages = store.listMessages(thread.id)
    const steer = messages.findIndex((message) => message.text === 'update?')
    expect(messages[steer - 1]?.role).toBe('assistant')
    expect(messages.slice(steer + 1).some((message) => message.role === 'assistant' && message.text === 'done')).toBe(true)
  }, 15_000)
})

describe('background completions', () => {
  it('two jobs finishing together wake the thread once, with both outputs, and NO_REPLY is allowed', async () => {
    const thread = assistantThread()
    let wakeRequest: StreamRequest | undefined
    testState.script = (req, call) => {
      if (call === 1) {
        return toolCalls(
          { id: 'j1', name: 'start_job', args: { command: 'sleep 0.5; echo ALPHA-DONE' } },
          { id: 'j2', name: 'start_job', args: { command: 'sleep 0.7; echo BETA-DONE' } }
        )
      }
      if (call === 2) return reply("started both, i'll text you")
      wakeRequest = req
      return reply('NO_REPLY')
    }
    await send({ threadId: thread.id, text: 'run both', disposition: 'send' }, () => {})
    await waitFor(() => store.listMessages(thread.id).filter((message) => message.origin?.kind === 'shell').length === 2, 10_000)
    await waitFor(() => testState.calls.length >= 3, 10_000)
    await waitFor(() => !isRunning(thread.id), 10_000)
    await new Promise((resolve) => setTimeout(resolve, 1_600))
    // Exactly one wake-up request, and it saw both notices.
    expect(testState.calls).toHaveLength(3)
    const seen = wakeRequest!.messages.map(textOf).join('\n')
    expect(seen).toContain('ALPHA-DONE')
    expect(seen).toContain('BETA-DONE')
    const notices = store.listMessages(thread.id).filter((message) => message.origin?.kind === 'shell')
    expect(notices[0]!.text).toContain('reply with exactly NO_REPLY')
    expect(store.listMessages(thread.id).at(-1)).toMatchObject({ role: 'assistant', text: 'NO_REPLY' })
    // No retry nudge fought the silent acknowledgement.
    expect(store.listEvents(thread.id).some((event) => event.body.type === 'retry')).toBe(false)
  }, 20_000)

  it('clip a huge job output and name the spill file', async () => {
    const thread = assistantThread()
    testState.script = (_req, call) => {
      if (call === 1) return toolCalls({ id: 'big', name: 'start_job', args: { command: "sleep 0.2; head -c 60000 /dev/zero | tr '\\\\0' 'x'; echo; echo TAIL-MARK" } })
      if (call === 2) return reply('started')
      return reply('NO_REPLY')
    }
    await send({ threadId: thread.id, text: 'big output', disposition: 'send' }, () => {})
    await waitFor(() => store.listMessages(thread.id).some((message) => message.origin?.kind === 'shell'), 10_000)
    const notice = store.listMessages(thread.id).find((message) => message.origin?.kind === 'shell')!
    expect(notice.text.length).toBeLessThan(20_000)
    expect(notice.text).toContain('TAIL-MARK')
    expect(notice.text).toMatch(/chars truncated; full output: .*lattice-spill/)
    await waitFor(() => testState.calls.length >= 3 && !isRunning(thread.id), 10_000)
  }, 20_000)
})

describe('rolling context', () => {
  function seedHistory(threadId: string, turns: number): void {
    let at = Date.now() - turns * 10_000
    for (let turn = 0; turn < turns; turn += 1) {
      store.insertMessage({ id: `u${turn}`, threadId, role: 'user', createdAt: (at += 1_000), text: `[Texted via Telegram] question ${turn} ${'q'.repeat(600)}` })
      store.insertMessage({ id: `a${turn}`, threadId, runId: `r${turn}`, role: 'assistant', createdAt: (at += 1_000), text: `answer ${turn} ${'a'.repeat(600)}`, status: 'complete' })
    }
  }

  it('folds the oldest turns into a running summary and memories after a turn, not before it', async () => {
    const thread = assistantThread({ contextPolicy: { mode: 'rolling', triggerTokens: 8_000, keepTokens: 2_000 } })
    seedHistory(thread.id, 26) // ~10k tokens: past the 8k trigger, short of the 12k urgent line
    const summaries: StreamRequest[] = []
    testState.script = (req) => {
      if (systemOf(req) === ROLLING_SUMMARY_INSTRUCTION) {
        summaries.push(req)
        return reply('Recent topics: many questions about q and a.')
      }
      return reply('sure')
    }
    await send({ threadId: thread.id, text: 'next question', disposition: 'send' }, () => {})
    await waitFor(() => store.listMessages(thread.id).some((message) => message.role === 'system' && !message.compacted), 8_000)
    // The turn itself was answered from the full history (the roll happens after it).
    const main = testState.calls.find(isMainCall)!
    expect(main.messages.some((message) => textOf(message).includes('question 0 '))).toBe(true)

    const messages = store.listMessages(thread.id)
    const summary = messages.find((message) => message.role === 'system' && !message.compacted)!
    const live = messages.filter((message) => !message.compacted)
    expect(messages.filter((message) => message.compacted).length).toBeGreaterThan(30)
    // The summary sits right before the kept turns, and the kept tail ends with this turn.
    expect(live[0]!.id).toBe(summary.id)
    expect(live.at(-1)).toMatchObject({ role: 'assistant', text: 'sure' })
    expect(testState.distilledSpans).toHaveLength(1)
    expect(testState.distilledSpans[0]).toContain('question 0')

    // The next turn reads the summary under the rolling prefix, not the folded turns.
    const wire = buildWireMessages(thread.id, store.getThreadMeta(thread.id)!, thread.model)
    expect(wire[1]).toMatchObject({ role: 'system', content: ROLLING_SUMMARY_PREFIX + 'Recent topics: many questions about q and a.' })
    expect(wire.some((message) => textOf(message).includes('question 0 '))).toBe(false)
    expect(summaries).toHaveLength(1)
  }, 15_000)

  it('rolls before the turn when history is far past the trigger', async () => {
    const thread = assistantThread({ contextPolicy: { mode: 'rolling', triggerTokens: 8_000, keepTokens: 2_000 } })
    seedHistory(thread.id, 50) // ~20k tokens, past 1.5x the trigger
    testState.script = (req) => reply(systemOf(req) === ROLLING_SUMMARY_INSTRUCTION ? 'Recent topics: fifty questions.' : 'sure')
    await send({ threadId: thread.id, text: 'next', disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(thread.id) && testState.calls.some(isMainCall))
    const main = testState.calls.find(isMainCall)!
    expect(main.messages.some((message) => textOf(message).includes('question 0 '))).toBe(false)
    expect(main.messages.some((message) => textOf(message).includes('Recent topics: fifty questions.'))).toBe(true)
    expect(main.messages.at(-1)).toMatchObject({ role: 'user' })
    expect(textOf(main.messages.at(-1)!)).toContain('next')
  })

  it('rolls everything on demand (a fresh start that remembers)', async () => {
    const thread = assistantThread()
    seedHistory(thread.id, 6)
    testState.script = () => reply('Recent topics: six questions.')
    const result = await rollThread(thread.id, () => {}, { keepTokens: 0 })
    expect(result).toMatchObject({ ok: true, folded: 12, memories: 2 })
    const live = store.listMessages(thread.id).filter((message) => !message.compacted)
    expect(live).toHaveLength(1)
    expect(live[0]).toMatchObject({ role: 'system', text: 'Recent topics: six questions.' })
  })
})

describe('vision fallback', () => {
  const MODELS: ModelInfo[] = [
    { id: 'test/model', name: 'm', provider: 'test', contextLength: 128_000, maxOutputTokens: 4_096, capabilities: { vision: false, tools: true, reasoning: false, effortTiers: [] } },
    { id: 'test/model-vision', name: 'v', provider: 'test', contextLength: 128_000, maxOutputTokens: 4_096, capabilities: { vision: true, tools: true, reasoning: false, effortTiers: [] } }
  ]

  it('describes a photo for a model that cannot see, once, and sends the description instead', async () => {
    store.setSettings({ providers: [testState.provider as never] })
    store.setCachedModels(testState.provider.id, MODELS)
    const thread = assistantThread()
    const photo = { id: 'att', name: 'receipt.jpg', mime: 'image/jpeg', bytes: 3, sha256: 'x', kind: 'image' as const, content: 'data:image/jpeg;base64,/9j/RECEIPT' }
    testState.script = (req) => {
      const first = req.messages[0]
      if (first && Array.isArray(first.content) && first.content[0]?.text === IMAGE_DESCRIPTION_PROMPT) {
        expect(req.model).toBe('test/model-vision')
        return reply('A receipt from Blue Bottle for $12.40.')
      }
      return reply('twelve forty')
    }
    await send({ threadId: thread.id, text: 'how much was this', attachments: [photo], disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(thread.id) && testState.calls.length >= 2)
    const main = testState.calls.find(isMainCall)!
    const user = main.messages.at(-1)!
    expect(JSON.stringify(user)).toContain('A receipt from Blue Bottle for $12.40.')
    expect(JSON.stringify(main.messages)).not.toContain('image_url')

    // A second turn replays the photo from history: described from the store, no new vision call.
    const before = testState.calls.length
    await send({ threadId: thread.id, text: 'thanks', disposition: 'send' }, () => {})
    await waitFor(() => !isRunning(thread.id) && testState.calls.length > before)
    expect(testState.calls.slice(before).every(isMainCall)).toBe(true)
  })
})
