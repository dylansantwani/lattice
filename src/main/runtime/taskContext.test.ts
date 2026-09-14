import { describe, expect, it } from 'vitest'
import type { ChatMessage } from '@shared/types'
import { planTaskBoundary, taskBoundaryMarker, taskTranscript } from './taskContext'

let seq = 0
const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => {
  seq += 1
  return { id: `m${seq}`, threadId: 't', role, createdAt: Date.UTC(2026, 8, 14, 19, seq), text, ...extra }
}

describe('planTaskBoundary', () => {
  it('sets aside every live message, including an earlier summary or marker', () => {
    const live = [msg('system', 'old summary'), msg('user', 'task one'), msg('assistant', 'report one: 120x120mm base')]
    const plan = planTaskBoundary(live, 'UTC')!
    expect(plan.fold.map((m) => m.id)).toEqual(live.map((m) => m.id))
  })

  it('is a no-op for an empty thread or one that holds only an earlier marker', () => {
    expect(planTaskBoundary([])).toBeNull()
    expect(planTaskBoundary([msg('system', 'marker')])).toBeNull()
  })

  it('keeps anything still queued (it has yet to run)', () => {
    const queued = msg('user', 'queued next', { queued: true })
    const plan = planTaskBoundary([msg('user', 'a'), msg('assistant', 'b'), queued])!
    expect(plan.fold.some((m) => m.id === queued.id)).toBe(false)
  })

  it('writes a content-free marker so no claim from an earlier task leaks into the next', () => {
    const fold = [msg('user', 'measure the stand'), msg('assistant', 'geometry ≈120×120 mm base, ~150 mm post')]
    const marker = taskBoundaryMarker(fold, 'UTC')
    expect(marker).toContain('set aside')
    expect(marker).toContain('memory_search')
    expect(marker).not.toMatch(/120|150|stand/)
  })
})

describe('taskTranscript', () => {
  it('keeps the words for memory distillation, skips system rows and clips long messages', () => {
    const text = taskTranscript([msg('system', 'marker'), msg('user', 'task'), msg('assistant', 'x'.repeat(5_000))])
    expect(text).not.toContain('marker')
    expect(text).toContain('Task/message: task')
    expect(text.length).toBeLessThan(3_200)
  })
})
