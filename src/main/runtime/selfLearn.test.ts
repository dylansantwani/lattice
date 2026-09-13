import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ChatMessage, ProviderConfig, ThreadMeta, TurnTelemetry } from '@shared/types'

// electron's `app` is unavailable under vitest; point the db at a throwaway dir.
const mockDataDir = mkdtempSync(join(tmpdir(), 'lattice-selflearn-'))
vi.mock('electron', () => ({ app: { getPath: () => mockDataDir } }))
// Never let a test export into the real ~/.claude — the scheduler is observed, not run.
vi.mock('../memory/bridge', async () => ({
  ...(await vi.importActual<typeof import('../memory/bridge')>('../memory/bridge')),
  scheduleMemoryExport: vi.fn()
}))

import {
  AUTO_APPROVE_CONFIDENCE,
  DEFAULT_TTL_DAYS,
  MIN_NEW_TRANSCRIPT_CHARS,
  buildLearnPrompt,
  buildTranscript,
  dedupeLearnings,
  distillMemories,
  expiryFor,
  hasLearnSignal,
  looksSensitive,
  messagesSinceMark,
  normalizeForDedup,
  parseLearnings,
  parseLearningsResult,
  planLearnings,
  resolveScope,
  statusFor,
  storeLearning,
  transcriptKeywords,
  utilityRoute,
  type LearnDraft
} from './selfLearn'
import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { scheduleMemoryExport } from '../memory/bridge'



afterAll(() => {
  closeDb()
  rmSync(mockDataDir, { recursive: true, force: true })
})

const draft = (over: Partial<LearnDraft> = {}): LearnDraft => ({
  content: 'Prefers terse answers',
  type: 'preference',
  scope: 'user',
  confidence: 0.9,
  ...over
})

const msg = (role: ChatMessage['role'], text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: role + text.slice(0, 12) + text.length, threadId: 't', role, text, createdAt: 0, ...over }) as ChatMessage

describe('parseLearnings', () => {
  it('parses a clean JSON array with validated fields', () => {
    const out = parseLearnings(
      '[{"content":"Prefers tabs","type":"preference","scope":"user","confidence":0.9}]'
    )
    expect(out).toEqual([{ content: 'Prefers tabs', type: 'preference', scope: 'user', confidence: 0.9 }])
  })

  it('carries through replaces and a clamped ttlDays', () => {
    const out = parseLearnings(
      '[{"content":"x","replaces":"01ABC","ttlDays":30},{"content":"y","ttlDays":null},{"content":"z","ttlDays":9000},{"content":"w","ttlDays":-2}]'
    )
    expect(out[0]).toMatchObject({ replaces: '01ABC', ttlDays: 30 })
    expect(out[1]).toMatchObject({ ttlDays: null })
    expect(out[2]!.ttlDays).toBe(365)
    expect(out[3]!.ttlDays).toBeUndefined()
  })

  it('tolerates a ```json code fence', () => {
    const out = parseLearnings('```json\n[{"content":"Uses pnpm"}]\n```')
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ content: 'Uses pnpm', type: 'note', scope: 'user' })
  })

  it('tolerates a line of prose before the array', () => {
    const out = parseLearnings('Here is what I found:\n[{"content":"Runs on macOS","type":"environment"}]')
    expect(out).toHaveLength(1)
    expect(out[0]!.type).toBe('environment')
  })

  it('returns [] for an empty array, empty string, or malformed JSON', () => {
    expect(parseLearnings('[]')).toEqual([])
    expect(parseLearnings('')).toEqual([])
    expect(parseLearnings('not json at all')).toEqual([])
    expect(parseLearnings('[{"content": ')).toEqual([])
  })

  it('distinguishes a well-formed empty reply from a garbled one', () => {
    expect(parseLearningsResult('[]').wellFormed).toBe(true)
    expect(parseLearningsResult('Sure! []').wellFormed).toBe(true)
    expect(parseLearningsResult('').wellFormed).toBe(false)
    expect(parseLearningsResult('I could not do that').wellFormed).toBe(false)
    expect(parseLearningsResult('[{"content": ').wellFormed).toBe(false)
    expect(parseLearningsResult('{"content":"x"}').wellFormed).toBe(false)
  })

  it('drops entries with no content and clamps confidence to 0..1', () => {
    const out = parseLearnings(
      '[{"content":""},{"content":"x","confidence":5},{"content":"y","confidence":-3}]'
    )
    expect(out.map((d) => d.content)).toEqual(['x', 'y'])
    expect(out[0]!.confidence).toBe(1)
    expect(out[1]!.confidence).toBe(0)
  })

  it('falls back to safe defaults for unknown type/scope and non-numeric confidence', () => {
    const out = parseLearnings('[{"content":"z","type":"bogus","scope":"galaxy","confidence":"high"}]')
    expect(out[0]).toMatchObject({ type: 'note', scope: 'user', confidence: 0.5 })
  })
})

describe('buildLearnPrompt', () => {
  it('normalizes the subject to third person and lists what is already known', () => {
    const p = buildLearnPrompt('User: hi', [{ id: '01X', content: 'The user prefers tabs' }])
    expect(p).toContain('third person as "The user …"')
    expect(p).toContain('--- ALREADY KNOWN')
    expect(p).toContain('[01X] The user prefers tabs')
    expect(p).toContain('"replaces"')
    expect(p).toContain('"ttlDays"')
  })
  it('omits the known block when there is nothing known', () => {
    expect(buildLearnPrompt('User: hi')).not.toContain('--- ALREADY KNOWN')
  })
})

describe('normalizeForDedup', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForDedup('  Prefers  TABS, not spaces! ')).toBe('prefers tabs not spaces')
  })
})

describe('dedupeLearnings / planLearnings', () => {
  it('drops drafts that duplicate an existing memory (containment, either direction)', () => {
    const drafts = [draft({ content: 'The user prefers terse answers' })]
    const existing = [{ content: 'Prefers terse answers' }]
    expect(dedupeLearnings(drafts, existing)).toEqual([])
  })

  it('drops a rewording that no longer contains the original (the username cluster)', () => {
    const drafts = [draft({ content: "The user's username on macOS is dylan (home directory /Users/dylan)" })]
    const existing = [{ content: "User's macOS username is dylan (home directory /Users/dylan)." }]
    expect(dedupeLearnings(drafts, existing)).toEqual([])
  })

  it('is not swallowed by a long imported document that happens to contain the words', () => {
    const blob = 'Global instructions:\n' + 'Do the whole thing. '.repeat(300) + 'prefers terse answers ' + 'more. '.repeat(100)
    const drafts = [draft({ content: 'The user prefers terse answers' })]
    expect(dedupeLearnings(drafts, [{ content: blob }])).toHaveLength(1)
  })

  it('keeps the highest-confidence draft among in-batch near-duplicates', () => {
    const drafts = [
      draft({ content: 'Uses pnpm as the package manager', confidence: 0.6 }),
      draft({ content: 'Uses pnpm', confidence: 0.95 })
    ]
    const kept = dedupeLearnings(drafts, [])
    expect(kept).toHaveLength(1)
    expect(kept[0]!.confidence).toBe(0.95)
  })

  it('keeps genuinely distinct drafts', () => {
    const drafts = [draft({ content: 'Runs on macOS' }), draft({ content: 'Deploys with electron-builder' })]
    expect(dedupeLearnings(drafts, [])).toHaveLength(2)
  })

  it('does not treat two short distinct facts as duplicates', () => {
    const drafts = [draft({ content: 'Uses zsh' }), draft({ content: 'Uses vim' })]
    expect(dedupeLearnings(drafts, [])).toHaveLength(2)
  })

  it('plans an in-place revision when a draft refines a Lattice-authored memory', () => {
    const existing = [{ id: 'm1', content: "The user's macOS username is dylan", author: 'model' as const, status: 'approved' as const }]
    const plans = planLearnings([draft({ content: "The user's macOS username is dylan (home directory /Users/dylan)" })], existing)
    expect(plans).toHaveLength(1)
    expect(plans[0]!.replaces?.id).toBe('m1')
  })

  it('never revises an import or a rejected item, and drops the draft instead', () => {
    const imported = [{ id: 'mem:cc:global', content: "The user's macOS username is dylan", author: 'import' as const, status: 'approved' as const }]
    expect(planLearnings([draft({ content: "The user's macOS username is dylan (home /Users/dylan)" })], imported)).toEqual([])
    const rejected = [{ id: 'r1', content: "The user's macOS username is dylan", author: 'model' as const, status: 'rejected' as const }]
    expect(planLearnings([draft({ content: "The user's macOS username is dylan (home /Users/dylan)" })], rejected)).toEqual([])
  })

  it('revises on a one-word correction and drops only a strict subset', () => {
    const existing = [{ id: 'm1', content: 'The user operates two Bambu A1 Combo printers in cloud mode', author: 'model' as const, status: 'approved' as const }]
    const correction = planLearnings([draft({ content: 'The user operates two Bambu A1 Combo printers in LAN mode' })], existing)
    expect(correction.map((p) => p.replaces?.id)).toEqual(['m1'])
    const subset = planLearnings([draft({ content: 'The user operates two Bambu A1 Combo printers' })], existing)
    expect(subset).toEqual([])
  })

  it('honors an explicit replaces id from the model and claims each row once', () => {
    const existing = [{ id: 'm1', content: 'The user prefers dark themes', author: 'model' as const, status: 'approved' as const }]
    const plans = planLearnings(
      [
        draft({ content: 'The user prefers the Midnight theme in every app', replaces: 'm1', confidence: 0.9 }),
        draft({ content: 'The user prefers the Midnight theme', replaces: 'm1', confidence: 0.8 })
      ],
      existing
    )
    expect(plans.map((p) => p.replaces?.id)).toEqual(['m1'])
  })
})

describe('messagesSinceMark / hasLearnSignal', () => {
  const a = msg('user', 'first question about the build pipeline')
  const b = msg('assistant', 'an answer')
  const c = msg('user', 'follow-up')
  it('returns everything after the mark, or everything if the mark is gone', () => {
    expect(messagesSinceMark([a, b, c], b.id)).toEqual([c])
    expect(messagesSinceMark([a, b, c], null)).toEqual([a, b, c])
    expect(messagesSinceMark([a, b, c], 'nope')).toEqual([a, b, c])
  })
  it('requires a human-typed user turn, an assistant reply, and enough new text', () => {
    const long = 'x'.repeat(MIN_NEW_TRANSCRIPT_CHARS)
    expect(hasLearnSignal([msg('user', long), msg('assistant', 'ok')], buildTranscript([msg('user', long), msg('assistant', 'ok')]))).toBe(true)
    // A "thanks" turn: too short.
    expect(hasLearnSignal([msg('user', 'thanks'), msg('assistant', 'np')], 'User: thanks\n\nAssistant: np')).toBe(false)
    // A subagent completion delivered as a user turn is not the human talking.
    const agent = msg('user', long, { origin: { kind: 'agent', label: 'x' } })
    expect(hasLearnSignal([agent, msg('assistant', 'ok')], buildTranscript([agent, msg('assistant', 'ok')]))).toBe(false)
    // No reply yet.
    expect(hasLearnSignal([msg('user', long)], buildTranscript([msg('user', long)]))).toBe(false)
  })
  it('treats an explicit cue as signal at any length', () => {
    for (const text of ['remember: I always use pnpm', 'from now on reply in Spanish', 'I never want emojis', "don't forget I'm on macOS"]) {
      const m = [msg('user', text), msg('assistant', 'ok')]
      expect(hasLearnSignal(m, buildTranscript(m))).toBe(true)
    }
    const plain = [msg('user', 'what time is it'), msg('assistant', 'noon')]
    expect(hasLearnSignal(plain, buildTranscript(plain))).toBe(false)
  })
})

describe('transcriptKeywords', () => {
  it('returns the most frequent identity tokens, most frequent first', () => {
    const t = 'pnpm pnpm pnpm electron electron the user the user is is macos'
    expect(transcriptKeywords(t, 3)).toEqual(['pnpm', 'electron', 'macos'])
  })
})

describe('looksSensitive', () => {
  it('flags credential-shaped content', () => {
    expect(looksSensitive('The API key is stored in .env')).toBe(true)
    expect(looksSensitive('password is hunter2')).toBe(true)
    expect(looksSensitive('token: sk-abcdefghijklmnopqrstuvwx')).toBe(true)
    expect(looksSensitive('a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0')).toBe(true) // long hex
  })

  it('does not flag ordinary durable facts', () => {
    expect(looksSensitive('Prefers terse answers')).toBe(false)
    expect(looksSensitive('Runs the app with pnpm dev')).toBe(false)
  })
})

describe('statusFor', () => {
  it('auto-approves non-sensitive learnings when the setting allows', () => {
    expect(statusFor(draft({ confidence: AUTO_APPROVE_CONFIDENCE }), true)).toBe('approved')
    expect(statusFor(draft({ confidence: 0.99 }), true)).toBe('approved')
  })

  it('adds low-confidence learnings too when auto-approve is on (no review backlog)', () => {
    expect(statusFor(draft({ confidence: 0.5 }), true)).toBe('approved')
    expect(statusFor(draft({ confidence: 0 }), true)).toBe('approved')
  })

  it('never auto-approves sensitive content', () => {
    expect(statusFor(draft({ content: 'password is hunter2', confidence: 1 }), true)).toBe('proposed')
  })

  it('proposes everything when auto-approve is off', () => {
    expect(statusFor(draft({ confidence: 1 }), false)).toBe('proposed')
  })
})

describe('expiryFor', () => {
  const now = 1_000
  const day = 24 * 3600_000
  it('uses the model ttl, else the type default, else durable', () => {
    expect(expiryFor({ type: 'fact', ttlDays: 10 }, now)).toBe(now + 10 * day)
    expect(expiryFor({ type: 'note' }, now)).toBe(now + DEFAULT_TTL_DAYS.note! * day)
    expect(expiryFor({ type: 'fact' }, now)).toBeUndefined()
    expect(expiryFor({ type: 'preference' }, now)).toBeUndefined()
  })
  it('an explicit null overrides the type default', () => {
    expect(expiryFor({ type: 'note', ttlDays: null }, now)).toBeUndefined()
  })
})

describe('utilityRoute', () => {
  const threadProvider = { id: 'main' } as ProviderConfig
  const cheap = { id: 'cheap' } as ProviderConfig
  it('uses the utility model with no forced effort when it resolves', () => {
    expect(utilityRoute('big/model', threadProvider, 'high', () => cheap, 'local/small')).toEqual({
      model: 'local/small',
      provider: cheap,
      effort: undefined
    })
  })
  it('falls back to the thread model (with its effort) when unset, same, or unresolvable', () => {
    expect(utilityRoute('big/model', threadProvider, 'high', () => cheap, '')).toEqual({ model: 'big/model', provider: threadProvider, effort: 'high' })
    expect(utilityRoute('big/model', threadProvider, 'high', () => cheap, 'big/model')).toEqual({ model: 'big/model', provider: threadProvider, effort: 'high' })
    expect(utilityRoute('big/model', threadProvider, 'high', () => null, 'gone/model')).toEqual({ model: 'big/model', provider: threadProvider, effort: 'high' })
  })
})

describe('resolveScope', () => {
  const meta = { id: 'thread-1', workspaceId: 'ws-1' } as ThreadMeta
  it('maps workspace scope to the thread workspace id', () => {
    expect(resolveScope('workspace', meta)).toEqual({ scope: 'workspace', scopeId: 'ws-1' })
  })
  it('maps thread scope to the thread id', () => {
    expect(resolveScope('thread', meta)).toEqual({ scope: 'thread', scopeId: 'thread-1' })
  })
  it('maps user scope with no scopeId', () => {
    expect(resolveScope('user', meta)).toEqual({ scope: 'user' })
  })
})

describe('buildTranscript', () => {
  it('includes only user/assistant turns with text and labels them', () => {
    const t = buildTranscript([
      msg('user', 'hello'),
      msg('assistant', 'hi there'),
      msg('system', 'compaction summary'),
      msg('assistant', '', {})
    ])
    expect(t).toBe('User: hello\n\nAssistant: hi there')
  })

  it('skips compacted messages', () => {
    const t = buildTranscript([
      msg('user', 'old', { compacted: true }),
      msg('user', 'new')
    ])
    expect(t).toBe('User: new')
  })

  it('drops oldest turns to stay within the character budget', () => {
    const big = 'x'.repeat(9000)
    const t = buildTranscript([msg('user', big), msg('assistant', big)])
    // Both turns are ~9k; together they exceed the 12k budget, so the oldest is dropped.
    expect(t.startsWith('Assistant:')).toBe(true)
    expect(t).not.toContain('User:')
  })
})

// The model distiller was removed: extraction is deterministic (selfLearnRules.ts), so the pass no
// longer takes a stream, a provider or a model. These cases exercised that deleted path and are kept
// only as documentation of what it used to guarantee.
describe.skip('storeLearning + distillMemories (store-backed, model pass — removed)', () => {
  const meta = { id: 'thread-1', workspaceId: 'ws-1' } as ThreadMeta
  const provider = { id: 'p-main', kind: 'openai' } as unknown as ProviderConfig
  const human = (text: string, id = 'u1'): ChatMessage => msg('user', text, { id })
  const reply = (text: string, id = 'a1'): ChatMessage => msg('assistant', text, { id })
  const longAsk = 'I keep my dotfiles in ~/dotfiles and always use pnpm; please remember that. '.repeat(4)

  type Stream = NonNullable<Parameters<typeof distillMemories>[0]['stream']>
  const streamReturning = (text: string, usage?: Partial<TurnTelemetry>): { stream: Stream; calls: { model: string; effort?: string; prompt: string }[] } => {
    const calls: { model: string; effort?: string; prompt: string }[] = []
    const stream: Stream = async function* (_provider, req) {
      const first = req.messages[0]
      const prompt = typeof first?.content === 'string' ? first.content : JSON.stringify(first?.content)
      calls.push({ model: req.model, effort: req.effort, prompt })
      yield { type: 'text', text }
      if (usage) yield { type: 'usage', usage }
      yield { type: 'finish', reason: 'stop' }
    }
    return { stream, calls }
  }

  beforeEach(() => {
    getDb().exec('DELETE FROM memory; DELETE FROM memory_distill_marks; DELETE FROM settings; DELETE FROM workspaces')
    store.resetStoreMemos()
    vi.mocked(scheduleMemoryExport).mockClear()
  })

  it('stores an approved learning, reports usage, advances the watermark, and schedules an export', async () => {
    const { stream, calls } = streamReturning(
      '[{"content":"The user keeps dotfiles in ~/dotfiles","type":"environment","scope":"user","confidence":0.9}]',
      { tokensIn: 321, tokensOut: 40 }
    )
    const usages: TurnTelemetry[] = []
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: 'high',
      messages: [human(longAsk), reply('Noted.')],
      provider,
      push: () => {},
      onUsage: (u) => usages.push(u),
      stream
    })
    expect(out).toEqual({ stored: 1, model: 'big/model' })
    const rows = store.listMemory()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ status: 'approved', author: 'model', type: 'environment', scope: 'user' })
    expect(usages).toEqual([{ tokensIn: 321, tokensOut: 40, purpose: 'distill', route: 'big/model' }])
    expect(store.getDistillMark(meta.id)).toBe('a1')
    expect(calls[0]).toMatchObject({ model: 'big/model', effort: 'high' })
    expect(scheduleMemoryExport).not.toHaveBeenCalled() // no workspace row in this test store
  })

  it('is incremental: the same span is never distilled twice, and a "thanks" turn costs no call', async () => {
    const { stream, calls } = streamReturning('[]')
    const msgs = [human(longAsk), reply('Noted.')]
    await distillMemories({ meta, model: 'm', effort: undefined, messages: msgs, provider, push: () => {}, stream })
    expect(calls).toHaveLength(1)
    expect(await distillMemories({ meta, model: 'm', effort: undefined, messages: msgs, provider, push: () => {}, stream })).toMatchObject({ skipped: 'no-signal' })
    const thanks = [...msgs, human('thanks!', 'u2'), reply('You are welcome.', 'a2')]
    expect(await distillMemories({ meta, model: 'm', effort: undefined, messages: thanks, provider, push: () => {}, stream })).toMatchObject({ skipped: 'no-signal' })
    expect(calls).toHaveLength(1)
    // The mark did not advance past the un-distilled short turn, so it rides with the next real one.
    expect(store.getDistillMark(meta.id)).toBe('a1')
    const more = [...thanks, human(longAsk + ' Also I use zsh.', 'u3'), reply('Got it.', 'a3')]
    await distillMemories({ meta, model: 'm', effort: undefined, messages: more, provider, push: () => {}, stream })
    expect(calls).toHaveLength(2)
    expect(calls[1]!.prompt).toContain('thanks!') // the skipped span was carried forward, not lost
    expect(store.getDistillMark(meta.id)).toBe('a3')
  })

  it('does not advance the watermark on a garbled reply, so the span is retried next turn', async () => {
    const { stream, calls } = streamReturning('I am a small model and I refuse to output JSON')
    const out = await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream })
    expect(out).toMatchObject({ stored: 0, skipped: 'model-error' })
    expect(store.getDistillMark(meta.id)).toBeNull()
    expect(calls).toHaveLength(1)
    // A well-formed empty reply DOES consume the span.
    const ok = streamReturning('[]')
    await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream: ok.stream })
    expect(store.getDistillMark(meta.id)).toBe('a1')
  })

  it('does not advance the watermark when the model call fails', async () => {
    const failing: Stream = async function* () {
      throw new Error('boom')
    }
    const out = await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream: failing })
    expect(out).toMatchObject({ skipped: 'model-error' })
    expect(store.getDistillMark(meta.id)).toBeNull()
  })

  it('shows the distiller what it already knows and revises that row in place on `replaces`', async () => {
    const existing = store.upsertMemory({ content: 'The user keeps dotfiles in ~/dotfiles', author: 'model', status: 'approved', type: 'environment' })
    const { stream, calls } = streamReturning(
      `[{"content":"The user keeps dotfiles in ~/dotfiles, managed with chezmoi","type":"environment","scope":"user","confidence":0.9,"replaces":"${existing.id}"}]`
    )
    const out = await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk + ' chezmoi dotfiles'), reply('ok')], provider, push: () => {}, stream })
    expect(calls[0]!.prompt).toContain(`[${existing.id}] The user keeps dotfiles in ~/dotfiles`)
    expect(out.stored).toBe(1)
    const rows = store.listMemory()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ id: existing.id, version: 2, status: 'approved' })
    expect(rows[0]!.content).toContain('chezmoi')
  })

  it('revises a near-duplicate in place even without `replaces`, and drops a plain rewording', async () => {
    const existing = store.upsertMemory({ content: "The user's macOS username is dylan", author: 'model', status: 'approved' })
    const { stream } = streamReturning(
      '[{"content":"The user\'s username on macOS is dylan (home directory /Users/dylan)","type":"fact","scope":"user","confidence":0.9},' +
        '{"content":"The user\'s macOS username is dylan.","type":"fact","scope":"user","confidence":0.8}]'
    )
    await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream })
    const rows = store.listMemory()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.id).toBe(existing.id)
    expect(rows[0]!.content).toContain('/Users/dylan')
  })

  it('routes to the utility model when configured and resolvable', async () => {
    store.setSettings({ utilityModel: 'local/small' })
    const cheap = { id: 'p-cheap' } as unknown as ProviderConfig
    const { stream, calls } = streamReturning('[]')
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: 'high',
      messages: [human(longAsk), reply('ok')],
      provider,
      push: () => {},
      resolveProvider: (m) => (m === 'local/small' ? cheap : null),
      stream
    })
    expect(out.model).toBe('local/small')
    expect(calls[0]).toMatchObject({ model: 'local/small', effort: undefined })
  })

  it('holds sensitive content as proposed and applies a note ttl by default', async () => {
    const { stream } = streamReturning(
      '[{"content":"The user\'s API key lives in .env.local","type":"fact","scope":"user","confidence":0.95},' +
        '{"content":"The nightly job currently runs at 3am","type":"note","scope":"workspace","confidence":0.9}]'
    )
    await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream })
    const rows = store.listMemory()
    const secret = rows.find((r) => r.content.includes('API key'))!
    const note = rows.find((r) => r.type === 'note')!
    expect(secret.status).toBe('proposed')
    expect(secret.sensitivity).toBe('sensitive')
    expect(note.expiresAt).toBeGreaterThan(Date.now())
    expect(note).toMatchObject({ scope: 'workspace', scopeId: 'ws-1' })
  })

  it('storeLearning: a revision keeps id/createdAt/pinned and bumps the version', () => {
    const before = store.upsertMemory({ content: 'The user prefers tabs', author: 'model', status: 'approved', pinned: true, createdAt: 5 })
    const after = storeLearning({ draft: draft({ content: 'The user prefers tabs, width 2' }), replaces: before }, meta, true)
    expect(after).toMatchObject({ id: before.id, createdAt: 5, pinned: true, version: 2, status: 'approved' })
  })

  it('does nothing when self-learning is off', async () => {
    store.setSettings({ selfLearning: false })
    const { stream, calls } = streamReturning('[]')
    expect(await distillMemories({ meta, model: 'm', effort: undefined, messages: [human(longAsk), reply('ok')], provider, push: () => {}, stream })).toEqual({ stored: 0, skipped: 'off' })
    expect(calls).toHaveLength(0)
  })
})


describe('distillMemories — deterministic (no model call)', () => {
  const meta = { id: 'thread-1', workspaceId: 'ws-1' } as ThreadMeta
  const provider = { id: 'p-main', kind: 'openai' } as unknown as ProviderConfig
  const human = (text: string, id = 'u1'): ChatMessage => msg('user', text, { id })
  const reply = (text: string, id = 'a1'): ChatMessage => msg('assistant', text, { id })
  let calls: string[] = []

  // Any attempt to reach a model lands here and is counted.
  const stream = (async function* (_provider: unknown, req: { model: string }) {
    calls.push(req.model)
    yield { type: 'text', text: '[]' }
  }) as never

  beforeEach(() => {
    getDb().exec('DELETE FROM memory; DELETE FROM memory_distill_marks; DELETE FROM settings; DELETE FROM workspaces')
    store.resetStoreMemos()
    vi.mocked(scheduleMemoryExport).mockClear()
    calls = []
  })

  it('stores a remembered preference, approves it, and never calls a model', async () => {
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: undefined,
      messages: [human('Please remember that I always want the tests run before you claim something works'), reply('Noted.')],
      provider,
      push: () => {},
      stream
    })
    expect(out.stored).toBe(1)
    expect(calls).toEqual([])
    const rows = store.listMemory()
    expect(rows).toHaveLength(1)
    expect(rows[0]!.type).toBe('preference')
    expect(rows[0]!.status).toBe('approved')
    expect(rows[0]!.content).toMatch(/tests run/i)
  })

  it('stores a durable environment fact', async () => {
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: undefined,
      messages: [
        human('Where does the gateway live, and where does the shared memory store live on this machine?'),
        reply(
          'The gateway listens on port 20128 and the store lives at /Users/dylan/.lattice/memory-tombstones. '.repeat(2)
        )
      ],
      provider,
      push: () => {},
      stream
    })
    expect(out.stored).toBeGreaterThanOrEqual(1)
    const rows = store.listMemory()
    expect(rows.some((r) => r.type === 'environment' && /20128|\.lattice/.test(r.content))).toBe(true)
  })

  it('turns a command sequence into a workflow memory', async () => {
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: undefined,
      messages: [
        human('ship the change'),
        reply(['Rebuild and install', '  pnpm build', '  pnpm package', '  ditto release/mac-arm64/Lattice.app /Applications/Lattice.app.new', 'Gotcha: relaunching does not install a new bundle, so quit and reopen afterwards.'].join('\n'))
      ],
      provider,
      push: () => {},
      stream
    })
    expect(out.stored).toBeGreaterThanOrEqual(1)
    const wf = store.listMemory().find((r) => r.type === 'workflow')
    expect(wf).toBeTruthy()
    expect(wf!.content).toMatch(/\*\*Steps\*\*/)
    expect(calls).toEqual([])
  })

  it('stores nothing, reports why, and does not rescan the same span', async () => {
    const neutral = 'What do you think about the overall approach here, and is there anything you would change? '
    const messages = [human(neutral.repeat(4)), reply('It looks reasonable to me overall. '.repeat(6))]
    const first = await distillMemories({ meta, model: 'big/model', effort: undefined, messages, provider, push: () => {}, stream })
    expect(first).toEqual({ stored: 0, skipped: 'no-candidates' })
    // watermark advanced ⇒ the same span is not scanned again
    const second = await distillMemories({ meta, model: 'big/model', effort: undefined, messages, provider, push: () => {}, stream })
    expect(second).toEqual({ stored: 0, skipped: 'no-signal' })
    expect(store.listMemory()).toHaveLength(0)
    expect(calls).toEqual([])
  })

  it('keeps credential-shaped learnings out of the prompt (proposed, sensitive)', async () => {
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: undefined,
      messages: [human('remember that the staging api key is sk-live-abcdef123456 and never log it'), reply('Understood.')],
      provider,
      push: () => {},
      stream
    })
    expect(out.stored).toBe(1)
    const row = store.listMemory()[0]!
    expect(row.status).toBe('proposed')
    expect(row.sensitivity).toBe('sensitive')
  })

  it('does nothing at all when self-learning is off', async () => {
    store.setSettings({ selfLearning: false })
    const out = await distillMemories({
      meta,
      model: 'big/model',
      effort: undefined,
      messages: [human('remember that I always want tests run first'), reply('Noted.')],
      provider,
      push: () => {},
      stream
    })
    expect(out).toEqual({ stored: 0, skipped: 'off' })
    expect(store.listMemory()).toHaveLength(0)
  })
})
