import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'

// electron's `app` is unavailable under vitest; point the store at a throwaway dir.
const memDataDir = mkdtempSync(join(tmpdir(), 'lattice-recall-test-'))
vi.mock('electron', () => ({ app: { getPath: () => memDataDir } }))
// never append test entries to the real ~/.lattice/memory-injections.jsonl
process.env.LATTICE_RECALL_LOG = join(memDataDir, 'injections.jsonl')

import * as memStore from '../store/eventStore'
import { closeDb } from '../store/db'
import { applyAutoRecall, buildRecallBlock } from './runManager'
import type { WireMessage } from '../providers/openaiCompat'

const seed = (content: string, extra: Record<string, unknown> = {}) =>
  memStore.upsertMemory({ content, type: 'reference', scope: 'user', author: 'user', confidence: 1, status: 'approved', ...extra } as never)

describe('buildRecallBlock', () => {
  beforeEach(() => {
    memStore.setSettings({ includeMemory: true, memoryAutoRecall: true })
  })
  afterAll(() => {
    closeDb()
    rmSync(memDataDir, { recursive: true, force: true })
  })

  it('returns a bounded block naming a matching memory, and remembers what it used', () => {
    const m = seed('The subscription sandbox runs on a ThreadRipper box with 128GB RAM')
    const { block, ids } = buildRecallBlock('what does the subscription sandbox run on')
    expect(block).toContain('ThreadRipper')
    expect(ids).toContain(m.id)
    expect(block.length).toBeLessThanOrEqual(1400)
  })

  it('stays empty when the setting is off', () => {
    seed('The zephyr gateway listens on port 9911')
    memStore.setSettings({ memoryAutoRecall: false })
    expect(buildRecallBlock('what port does the zephyr gateway use').block).toBe('')
  })

  it('skips trivial turns so short messages cost nothing', () => {
    seed('The zephyr gateway listens on port 9911')
    expect(buildRecallBlock('ok').block).toBe('')
    expect(buildRecallBlock('').block).toBe('')
  })

  it('never injects pinned memories (they already ride in the system prompt)', () => {
    seed('The quokka cron runs every 15 minutes on the build host', { pinned: true })
    expect(buildRecallBlock('quokka cron schedule').block).toBe('')
  })

  it('never injects sensitive memories', () => {
    seed('The rutabaga api key is stored in the keychain', { sensitivity: 'sensitive' })
    expect(buildRecallBlock('where is the rutabaga api key').block).toBe('')
  })

  it('stays silent when the only overlap is a common word (relevance floor)', () => {
    // six memories all mention "gateway", so the term carries no signal and nothing is injected
    for (let i = 0; i < 6; i++) seed(`The gateway node ${i} forwards traffic on port 90${i}0`)
    expect(buildRecallBlock('what about the gateway').block).toBe('')
  })

  it('still injects when the turn shares a distinctive term', () => {
    for (let i = 0; i < 6; i++) seed(`The gateway node ${i} forwards traffic on port 90${i}0`)
    seed('The rutabaga sandbox rebuilds itself every night at 03:00')
    const { block } = buildRecallBlock('when does the rutabaga sandbox rebuild')
    expect(block).toContain('rutabaga')
  })
})

describe('applyAutoRecall', () => {
  beforeEach(() => {
    memStore.setSettings({ includeMemory: true, memoryAutoRecall: true })
  })

  it('prepends the block to the newest user message and leaves the system prompt alone', () => {
    seed('The xylem export pipeline writes parquet to /Volumes/archive')
    const wire: WireMessage[] = [
      { role: 'system', content: 'SYSTEM PROMPT' },
      { role: 'user', content: 'older turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'where does the xylem export pipeline write' }
    ]
    applyAutoRecall(wire)
    expect(wire[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' })
    expect(wire[1]).toEqual({ role: 'user', content: 'older turn' })
    const newest = wire[3] as WireMessage
    expect(newest.content).toContain('/Volumes/archive')
    expect(newest.content).toContain('where does the xylem export pipeline write')
  })

  it('leaves the wire untouched when nothing matches', () => {
    const wire: WireMessage[] = [
      { role: 'system', content: 'S' },
      { role: 'user', content: 'zzqqxx wwvvuu nothing stored about this' }
    ]
    const before = JSON.stringify(wire)
    applyAutoRecall(wire)
    expect(JSON.stringify(wire)).toBe(before)
  })
})
