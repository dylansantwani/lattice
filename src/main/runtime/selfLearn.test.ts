import { describe, expect, it } from 'vitest'
import type { ChatMessage, ThreadMeta } from '@shared/types'
import {
  AUTO_APPROVE_CONFIDENCE,
  buildTranscript,
  dedupeLearnings,
  looksSensitive,
  normalizeForDedup,
  parseLearnings,
  resolveScope,
  statusFor,
  type LearnDraft
} from './selfLearn'

const draft = (over: Partial<LearnDraft> = {}): LearnDraft => ({
  content: 'Prefers terse answers',
  type: 'preference',
  scope: 'user',
  confidence: 0.9,
  ...over
})

const msg = (role: ChatMessage['role'], text: string, over: Partial<ChatMessage> = {}): ChatMessage =>
  ({ id: role + text, threadId: 't', role, text, createdAt: 0, ...over }) as ChatMessage

describe('parseLearnings', () => {
  it('parses a clean JSON array with validated fields', () => {
    const out = parseLearnings(
      '[{"content":"Prefers tabs","type":"preference","scope":"user","confidence":0.9}]'
    )
    expect(out).toEqual([{ content: 'Prefers tabs', type: 'preference', scope: 'user', confidence: 0.9 }])
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

describe('normalizeForDedup', () => {
  it('lowercases, strips punctuation, and collapses whitespace', () => {
    expect(normalizeForDedup('  Prefers  TABS, not spaces! ')).toBe('prefers tabs not spaces')
  })
})

describe('dedupeLearnings', () => {
  it('drops drafts that duplicate an existing memory (containment, either direction)', () => {
    const drafts = [draft({ content: 'The user prefers terse answers' })]
    const existing = [{ content: 'Prefers terse answers' }]
    expect(dedupeLearnings(drafts, existing)).toEqual([])
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
  it('auto-approves high-confidence, non-sensitive learnings when the setting allows', () => {
    expect(statusFor(draft({ confidence: AUTO_APPROVE_CONFIDENCE }), true)).toBe('approved')
    expect(statusFor(draft({ confidence: 0.99 }), true)).toBe('approved')
  })

  it('proposes low-confidence learnings even when auto-approve is on', () => {
    expect(statusFor(draft({ confidence: 0.5 }), true)).toBe('proposed')
  })

  it('never auto-approves sensitive content', () => {
    expect(statusFor(draft({ content: 'password is hunter2', confidence: 1 }), true)).toBe('proposed')
  })

  it('proposes everything when auto-approve is off', () => {
    expect(statusFor(draft({ confidence: 1 }), false)).toBe('proposed')
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
