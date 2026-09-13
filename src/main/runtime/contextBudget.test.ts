import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ulid } from '@shared/id'
import type { Attachment, ChatMessage, Role, ThreadId } from '@shared/types'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-context-budget-'))
vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))
vi.mock('../memory/bridge', () => ({ syncExternalMemory: vi.fn() }))
vi.mock('./selfLearn', () => ({ distillMemories: vi.fn() }))
vi.mock('../mcp/manager', () => ({ mcpTools: () => [] }))

import * as store from '../store/eventStore'
import { closeDb, getDb } from '../store/db'
import { getContextBudget, budgetForWire, buildWireMessages, estTokens, IMAGE_TOKEN_ESTIMATE } from './runManager'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM settings')
  store.resetStoreMemos() // raw SQL bypasses the store writers, so drop their in-memory memos
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
})

function makeThread(goal?: string): ThreadId {
  const workspace = store.ensureDefaultWorkspace()
  const thread = store.createThread({
    workspaceId: workspace.id,
    title: 'Budget thread',
    model: 'test/model',
    effort: 'high',
    mode: 'act',
    permissionPreset: 'workspace',
    goal
  })
  return thread.id
}

function insert(threadId: ThreadId, role: Role, text: string, extra: Partial<ChatMessage> = {}): ChatMessage {
  const msg: ChatMessage = { id: ulid(), threadId, role, createdAt: Date.now(), text, ...extra }
  store.insertMessage(msg)
  return msg
}

describe('getContextBudget', () => {
  it('prices image attachments flat, not by their base64 data-URL length', () => {
    const threadId = makeThread()
    // A "small" inline image is still a few hundred KB of base64. Counting that as text/4 would
    // add ~50k phantom tokens; the fix charges a flat per-image figure instead.
    const dataUrl = 'data:image/png;base64,' + 'A'.repeat(200_000)
    const image: Attachment = {
      id: ulid(),
      name: 'shot.png',
      mime: 'image/png',
      bytes: 150_000,
      sha256: 'deadbeef',
      kind: 'image',
      content: dataUrl
    }
    insert(threadId, 'user', 'describe this screenshot', { attachments: [image] })

    const budget = getContextBudget(threadId, [])
    expect(budget).not.toBeNull()
    // History includes the provider message envelope plus one flat image, and nothing resembling
    // the data-URL length.
    expect(budget!.segments.history).toBeGreaterThanOrEqual(estTokens('describe this screenshot') + IMAGE_TOKEN_ESTIMATE)
    expect(budget!.segments.history).toBeLessThan(estTokens(dataUrl) / 4)
  })

  it('counts text attachment bodies but not binary ones', () => {
    const textDoc: Attachment = {
      id: ulid(),
      name: 'notes.md',
      mime: 'text/markdown',
      bytes: 400,
      sha256: 'aa',
      kind: 'text',
      content: 'x'.repeat(400)
    }
    const binary: Attachment = {
      id: ulid(),
      name: 'blob.bin',
      mime: 'application/octet-stream',
      bytes: 999_999,
      sha256: 'bb',
      kind: 'binary'
      // no `content`: a binary attachment is never sent to the model, so it must not be counted.
    }

    const withBinary = makeThread()
    insert(withBinary, 'user', 'see attached', { attachments: [textDoc, binary] })
    const textOnly = makeThread()
    insert(textOnly, 'user', 'see attached', { attachments: [textDoc] })

    const a = getContextBudget(withBinary, [])!.segments.history
    const b = getContextBudget(textOnly, [])!.segments.history
    // The binary attachment is never sent, so it adds nothing over the text-only case.
    expect(a).toBe(b)
    // The text body itself is real context and must be counted.
    expect(b).toBeGreaterThan(estTokens('x'.repeat(400)))
  })

  it('reflects the assembled system prompt — tool inventory included, not just the base prose', () => {
    const threadId = makeThread()
    const budget = getContextBudget(threadId, [])
    expect(budget).not.toBeNull()
    // The system segment carries the full tool inventory + execution protocol, so it is far larger
    // than the couple hundred tokens the old hand-rolled est(SYSTEM_PROMPT) alone would report.
    expect(budget!.segments.system).toBeGreaterThan(1_000)
    expect(budget!.segments.tools).toBeGreaterThan(0)
    expect(budget!.segments.history).toBe(0)
    // usedTokens is exactly the sum of the consumed segments (reserve + safety are held off the top).
    expect(budget!.usedTokens).toBe(
      budget!.segments.system + budget!.segments.tools + budget!.segments.history + budget!.segments.injected
    )
  })

  it('excludes compacted messages and counts the compaction summary as history', () => {
    const threadId = makeThread()
    const u = insert(threadId, 'user', 'a'.repeat(200))
    const a = insert(threadId, 'assistant', 'b'.repeat(200))
    store.markMessagesCompacted([u.id, a.id])
    // A live system-role message standing in for the folded-away turns.
    insert(threadId, 'system', 'compaction summary text')

    const budget = getContextBudget(threadId, [])
    // The summary itself counts (plus the wire's compaction-prefix framing)...
    expect(budget!.segments.history).toBeGreaterThanOrEqual(estTokens('compaction summary text'))
    // ...but the folded-away user/assistant turns (~50 tokens each) are gone.
    expect(budget!.segments.history).toBeLessThan(
      estTokens('a'.repeat(200)) + estTokens('b'.repeat(200))
    )
  })

  it('uses the model context window and holds back reply reserve + safety', () => {
    const threadId = makeThread()
    const models = [
      {
        id: 'test/model',
        contextLength: 200_000,
        maxOutputTokens: 8_000,
        capabilities: {} as never
      } as never
    ]
    const budget = getContextBudget(threadId, models)
    expect(budget!.contextLength).toBe(200_000)
    // maxOut is capped at 4096; safety is 2% of the window.
    expect(budget!.segments.outputReserve).toBe(4_096)
    expect(budget!.segments.safety).toBe(Math.floor(200_000 * 0.02))
    expect(budget!.usableTokens).toBe(200_000 - 4_096 - Math.floor(200_000 * 0.02))
  })
})

describe('budgetForWire — the live in-flight core', () => {
  it('matches getContextBudget when handed the same persisted wire', () => {
    const threadId = makeThread()
    insert(threadId, 'user', 'a real question worth some tokens')
    const meta = store.getThreadMeta(threadId)!
    const wire = buildWireMessages(threadId, meta, meta.model, meta.effort)
    // getContextBudget is exactly this composition; the run loop calls the same core with its own
    // in-flight wire so the number the Orbit shows mid-run is derived identically to the idle one.
    expect(budgetForWire(threadId, meta, [], wire)).toEqual(getContextBudget(threadId, []))
  })

  it('grows history and occupancy as in-flight messages are appended to the wire', () => {
    const threadId = makeThread()
    insert(threadId, 'user', 'kick things off')
    const meta = store.getThreadMeta(threadId)!
    const wire = buildWireMessages(threadId, meta, meta.model, meta.effort)

    const before = budgetForWire(threadId, meta, [], wire)
    // Simulate a turn streaming: a big tool result lands in the wire (as it does mid-run, before
    // any of it is persisted). The Orbit must reflect that immediately.
    const after = budgetForWire(threadId, meta, [], [
      ...wire,
      { role: 'assistant', content: 'here is a large tool result ' + 'x'.repeat(4_000) }
    ])

    expect(after.segments.history).toBeGreaterThan(before.segments.history)
    expect(after.usedTokens).toBeGreaterThan(before.usedTokens)
    expect(after.occupancy).toBeGreaterThan(before.occupancy)
    // The system prompt and tool schemas are unchanged by appending history.
    expect(after.segments.system).toBe(before.segments.system)
    expect(after.segments.tools).toBe(before.segments.tools)
  })

  it('counts the serialized tool-call envelope and arguments, not only message content', () => {
    const threadId = makeThread()
    const meta = store.getThreadMeta(threadId)!
    const args = JSON.stringify({ path: '/workspace/' + 'nested/'.repeat(700) + 'report.json' })
    const withoutCall = budgetForWire(threadId, meta, [], [{ role: 'assistant', content: null }])
    const withCall = budgetForWire(threadId, meta, [], [
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'fs_read', arguments: args } }]
      }
    ])

    const delta = withCall.segments.history - withoutCall.segments.history
    expect(delta).toBeGreaterThan(estTokens(args))
  })

  it('counts only the first system message as system; later ones (compaction summaries) are history', () => {
    const threadId = makeThread()
    const meta = store.getThreadMeta(threadId)!
    const base = buildWireMessages(threadId, meta, meta.model, meta.effort)
    const withSummary = budgetForWire(threadId, meta, [], [
      ...base,
      { role: 'system', content: 'a later system message stands in for folded-away turns' }
    ])
    const plain = budgetForWire(threadId, meta, [], base)
    // The extra system-role message does not inflate the system segment...
    expect(withSummary.segments.system).toBe(plain.segments.system)
    // ...it counts as history, exactly as a compaction summary does.
    expect(withSummary.segments.history).toBeGreaterThan(plain.segments.history)
  })
})
