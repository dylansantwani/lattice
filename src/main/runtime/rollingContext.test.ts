import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import {
  buildRollingSummaryPrompt,
  estimateMessageTokens,
  firstPendingQueuedIndex,
  planRoll,
  rollContext,
  rollTranscript,
  summaryTargetWords,
  type RollDeps
} from './rollingContext'

let clock = 1_000
let seq = 0
function msg(role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  clock += 1_000
  seq += 1
  return { id: `m${seq}`, threadId: 't', role, createdAt: clock, text, ...extra }
}

/** A plain back-and-forth: `turns` user/assistant pairs of ~`chars` characters each. */
function conversation(turns: number, chars = 400): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let turn = 0; turn < turns; turn += 1) {
    const run = `run${turn}`
    out.push(msg('user', `question ${turn} ${'q'.repeat(chars)}`))
    out.push(msg('assistant', `answer ${turn} ${'a'.repeat(chars)}`, { runId: run }))
  }
  return out
}

const tokens = (messages: ChatMessage[]): number => messages.reduce((sum, m) => sum + estimateMessageTokens(m), 0)

describe('planRoll', () => {
  it('does nothing below the trigger', () => {
    const messages = conversation(4)
    expect(planRoll(messages, { keepTokens: 100, triggerTokens: tokens(messages) + 1 })).toBeNull()
  })

  it('folds the oldest whole turns and keeps about keepTokens of the tail', () => {
    const messages = conversation(20)
    const total = tokens(messages)
    const plan = planRoll(messages, { keepTokens: Math.round(total * 0.3), triggerTokens: Math.round(total * 0.5) })!
    expect(plan).not.toBeNull()
    expect(plan.fold.length + plan.keep.length).toBe(messages.length)
    // The cut lands on a user message: no question is separated from its answer.
    expect(plan.keep[0]!.role).toBe('user')
    expect(plan.fold.at(-1)!.role).toBe('assistant')
    expect(plan.keptTokens).toBeGreaterThanOrEqual(Math.round(total * 0.3))
    expect(plan.keptTokens).toBeLessThan(Math.round(total * 0.3) + 250)
  })

  it('never splits a run: a steer and the rest of its run stay with the turn that started it', () => {
    const messages = conversation(10)
    // Turn 10: a question, the run's first assistant bubble, a steer bound to that run, the continuation.
    const start = msg('user', 'long task please')
    const first = msg('assistant', 'on it', { runId: 'long' })
    const steer = msg('user', 'update?', { runId: 'long' })
    const rest = msg('assistant', 'x'.repeat(8_000), { runId: 'long' })
    messages.push(start, first, steer, rest)
    // keepTokens smaller than the continuation alone would put the cut at the steer.
    const plan = planRoll(messages, { keepTokens: 100, force: true })!
    expect(plan.keep.map((m) => m.id)).toEqual([start.id, first.id, steer.id, rest.id])
  })

  it('treats a queued turn that later started as a turn start even though it carries a run id', () => {
    const messages = conversation(6)
    const queued = msg('user', 'next thing', { runId: 'r-next' })
    const reply = msg('assistant', 'done', { runId: 'r-next' })
    messages.push(queued, reply)
    const plan = planRoll(messages, { keepTokens: 1, force: true })!
    expect(plan.keep[0]!.id).toBe(queued.id)
  })

  it('ignores an orphaned queued row that history has moved past (a lost in-memory queue)', () => {
    // The 2026-09-14 Print Desk Lead shape: two "stop" rows stranded as queued early in a long thread.
    const messages = [...conversation(2), msg('user', 'STOP STOP', { queued: true }), msg('user', 'make it sto', { queued: true }), ...conversation(30)]
    expect(firstPendingQueuedIndex(messages)).toBe(-1)
    const total = tokens(messages)
    const plan = planRoll(messages, { keepTokens: Math.round(total * 0.2), triggerTokens: Math.round(total * 0.5) })!
    expect(plan).not.toBeNull()
    expect(plan.fold.length).toBeGreaterThan(20)
    expect(plan.keptTokens).toBeLessThan(Math.round(total * 0.2) + 250)
  })

  it('still holds back a genuinely pending queued row, heuristically or by the run manager\'s ids', () => {
    const messages = [...conversation(10), msg('user', 'waiting', { queued: true })]
    expect(firstPendingQueuedIndex(messages)).toBe(messages.length - 1)
    expect(planRoll(messages, { keepTokens: 0, force: true })!.keep.map((m) => m.text)).toEqual(['waiting'])
    // Authoritative ids: a queued row the run manager does not hold is an orphan even at the tail…
    expect(firstPendingQueuedIndex(messages, new Set())).toBe(-1)
    // …and one it does hold stays pending even when a later assistant segment exists (a requeued steer).
    const steer = msg('user', 'steer', { queued: true })
    const withLater = [...conversation(4), steer, msg('assistant', 'segment split after the steer', { runId: 'r' })]
    expect(firstPendingQueuedIndex(withLater, new Set([steer.id]))).toBe(4 * 2)
  })

  it('checks the trigger against measured tokens and scales keepTokens to them', () => {
    const messages = conversation(20)
    const estimate = tokens(messages)
    // Under the trigger by the estimate, over it by the real wire (replayed tool JSON undercounts).
    expect(planRoll(messages, { keepTokens: 1_000, triggerTokens: estimate + 10 })).toBeNull()
    const plan = planRoll(messages, { keepTokens: 1_000, triggerTokens: estimate + 10, measuredTokens: estimate * 2 })!
    expect(plan).not.toBeNull()
    expect(plan.liveTokens).toBeGreaterThanOrEqual(estimate * 2 - 40)
    // keep is counted in measured tokens: roughly half as many messages as unscaled would keep.
    const unscaled = planRoll(messages, { keepTokens: 1_000, force: true })!
    expect(plan.keep.length).toBeLessThan(unscaled.keep.length)
    // A wild measurement is clamped rather than folding everything.
    expect(planRoll(messages, { keepTokens: 1_000, triggerTokens: estimate + 10, measuredTokens: estimate * 100 })!.liveTokens).toBeLessThanOrEqual(estimate * 4 + 100)
  })

  it('folds everything with keepTokens 0 but never what is still queued or protected', () => {
    const messages = conversation(6)
    const live = msg('user', 'in flight')
    const liveReply = msg('assistant', '', { runId: 'flight' })
    messages.push(live, liveReply)
    const everything = planRoll(messages.slice(0, 12), { keepTokens: 0, force: true })!
    expect(everything.keep).toEqual([])
    const protectedPlan = planRoll(messages, { keepTokens: 0, force: true, protectFromId: live.id })!
    expect(protectedPlan.keep.map((m) => m.id)).toEqual([live.id, liveReply.id])
    const queued = [...conversation(6), msg('user', 'waiting', { queued: true })]
    expect(planRoll(queued, { keepTokens: 0, force: true })!.keep.map((m) => m.text)).toEqual(['waiting'])
  })

  it('includes the earlier running summary in the fold and reports it', () => {
    const summary = msg('system', 'Earlier: talked about the eBay store.')
    const messages = [msg('user', 'old', { compacted: true }), summary, ...conversation(12)]
    const plan = planRoll(messages, { keepTokens: 200, force: true })!
    expect(plan.previousSummary?.id).toBe(summary.id)
    expect(plan.fold[0]!.id).toBe(summary.id)
    // Already-folded rows are not live and never fold twice.
    expect(plan.fold.some((m) => m.compacted)).toBe(false)
  })

  it('does not roll a span too small to be worth a summary unless forced', () => {
    const messages = conversation(2)
    expect(planRoll(messages, { keepTokens: 1, triggerTokens: 1 })).toBeNull()
    expect(planRoll(messages, { keepTokens: 1, force: true })).not.toBeNull()
  })

  it('weighs tool exchanges and images, not just visible text', () => {
    const light = msg('assistant', 'ok', { runId: 'a' })
    const heavy = msg('assistant', 'ok', {
      runId: 'b',
      toolExchanges: [
        { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'shell', arguments: '{"command":"ls"}' } }] },
        { role: 'tool', tool_call_id: 'c', content: 'x'.repeat(40_000) },
        { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }
      ]
    })
    expect(estimateMessageTokens(heavy)).toBeGreaterThan(estimateMessageTokens(light) + 10_000)
  })
})

describe('rollTranscript', () => {
  it('labels who spoke, clips tool output, and skips earlier summaries', () => {
    const transcript = rollTranscript(
      [
        msg('system', 'SUMMARY TEXT'),
        msg('user', '[Texted via Telegram · Sat] what is my balance'),
        msg('user', '⏳ job done', { origin: { kind: 'shell', label: 'shell' } }),
        msg('assistant', '$1.32', {
          runId: 'r',
          toolExchanges: [
            { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'web_fetch', arguments: '{"url":"https://x"}' } }] },
            { role: 'tool', tool_call_id: 'c', content: 'y'.repeat(5_000) }
          ]
        })
      ],
      'America/Chicago'
    )
    expect(transcript).not.toContain('SUMMARY TEXT')
    expect(transcript).toMatch(/Owner: \[Texted via Telegram · Sat\] what is my balance/)
    expect(transcript).toContain('Notice from a background command: ⏳ job done')
    expect(transcript).toContain('Assistant: $1.32')
    expect(transcript).toContain('web_fetch({"url":"https://x"})')
    expect(transcript).toContain('more chars]')
    expect(transcript.length).toBeLessThan(2_000)
  })
})

describe('summary prompt', () => {
  it('carries the previous summary and scales its length with the kept window', () => {
    const prompt = buildRollingSummaryPrompt('old summary', 'turns', 600)
    expect(prompt).toContain('old summary')
    expect(prompt).toContain('turns')
    expect(prompt).toContain('600 words')
    expect(buildRollingSummaryPrompt(undefined, 't', 300)).toContain('(none yet)')
    expect(summaryTargetWords({ keepTokens: 24_000 })).toBe(1_400)
    expect(summaryTargetWords({ keepTokens: 1_000 })).toBe(250)
  })
})

describe('rollContext', () => {
  function deps(messages: ChatMessage[], overrides: Partial<RollDeps> = {}): RollDeps & { committed: { ids: string[]; summary: ChatMessage }[]; published: ChatMessage[][] } {
    const committed: { ids: string[]; summary: ChatMessage }[] = []
    const published: ChatMessage[][] = []
    return {
      committed,
      published,
      liveMessages: () => messages.filter((m) => !m.compacted),
      commitFold: (ids, summary) => {
        committed.push({ ids, summary })
        return true
      },
      summarize: async () => 'Open threads: none. Recent topics: balances.',
      distill: async () => 3,
      publish: (changed) => published.push(changed),
      newId: () => 'summary1',
      ...overrides
    }
  }

  it('folds, writes the summary just ahead of the kept tail, and reports memories', async () => {
    const messages = conversation(20)
    const d = deps(messages)
    const result = await rollContext({ threadId: 't', policy: { keepTokens: 600, triggerTokens: 1_000 } }, d)
    expect(result.ok).toBe(true)
    expect(result.memories).toBe(3)
    expect(d.committed).toHaveLength(1)
    const { ids, summary } = d.committed[0]!
    const firstKept = messages.find((m) => !ids.includes(m.id))!
    expect(summary.createdAt).toBe(firstKept.createdAt - 1)
    expect(summary.role).toBe('system')
    expect(d.published[0]!.filter((m) => m.compacted)).toHaveLength(ids.length)
    expect(result.afterTokens!).toBeLessThan(result.beforeTokens!)
  })

  it('folds nothing when the summary fails, is empty, or is not shorter', async () => {
    const messages = conversation(20)
    const failing = deps(messages, { summarize: async () => { throw new Error('provider down') } })
    expect(await rollContext({ threadId: 't', policy: { keepTokens: 600 }, force: true }, failing)).toMatchObject({ ok: false, reason: expect.stringContaining('provider down') })
    expect(failing.committed).toHaveLength(0)
    const empty = deps(messages, { summarize: async () => '   ' })
    expect((await rollContext({ threadId: 't', policy: { keepTokens: 600 }, force: true }, empty)).ok).toBe(false)
    const bloated = deps(messages, { summarize: async () => 'z'.repeat(1_000_000) })
    expect((await rollContext({ threadId: 't', policy: { keepTokens: 600 }, force: true }, bloated)).ok).toBe(false)
  })

  it('still folds when memory distillation fails', async () => {
    const d = deps(conversation(20), { distill: async () => { throw new Error('bad json') } })
    const result = await rollContext({ threadId: 't', policy: { keepTokens: 600 }, force: true }, d)
    expect(result).toMatchObject({ ok: true, memories: 0 })
  })

  it('refuses a second roll of the same thread while one is running', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => (release = resolve))
    const d = deps(conversation(20), { summarize: async () => { await gate; return 'short' } })
    const first = rollContext({ threadId: 'same', policy: { keepTokens: 600 }, force: true }, d)
    const second = await rollContext({ threadId: 'same', policy: { keepTokens: 600 }, force: true }, d)
    expect(second).toMatchObject({ ok: false, reason: expect.stringContaining('already') })
    release()
    expect((await first).ok).toBe(true)
  })

  it('reports a history that changed underneath instead of double-folding', async () => {
    const d = deps(conversation(20), { commitFold: () => false })
    expect(await rollContext({ threadId: 't', policy: { keepTokens: 600 }, force: true }, d)).toMatchObject({ ok: false, reason: expect.stringContaining('changed') })
  })
})
