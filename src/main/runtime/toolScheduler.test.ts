import { describe, expect, it } from 'vitest'
import { scheduleTool } from './toolScheduler'
const signal = new AbortController().signal
const tick = () => new Promise(resolve => setTimeout(resolve, 0))
describe('tool resource scheduler', () => {
  it('serializes conflicting writes and subsequent reads in submission order', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const seen: string[] = []
    const first = scheduleTool({ resources: ['path:/repo/file'], write: true }, signal, async () => { seen.push('write1'); await gate })
    const second = scheduleTool({ resources: ['path:/repo/file'], write: true }, signal, async () => { seen.push('write2') })
    const read = scheduleTool({ resources: ['path:/repo/file'], write: false }, signal, async () => { seen.push('read') })
    await tick()
    expect(seen).toEqual(['write1'])
    release()
    await Promise.all([first, second, read])
    expect(seen).toEqual(['write1', 'write2', 'read'])
  })
  it('overlaps independent reads and distinct files while respecting directory writes', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const seen: string[] = []
    const a = scheduleTool({ resources: ['path:/repo/a'], write: false }, signal, async () => { seen.push('a'); await gate })
    const b = scheduleTool({ resources: ['path:/repo/a'], write: false }, signal, async () => { seen.push('b'); await gate })
    const c = scheduleTool({ resources: ['path:/other'], write: true }, signal, async () => { seen.push('c') })
    const d = scheduleTool({ resources: ['path:/repo'], write: true }, signal, async () => { seen.push('directory') })
    await tick()
    expect(seen).toEqual(['a', 'b', 'c'])
    release()
    await Promise.all([a, b, c, d])
    expect(seen.at(-1)).toBe('directory')
  })
  it('cancels queued work without leaking or blocking later calls', async () => {
    let release!: () => void
    const gate = new Promise<void>(r => { release = r })
    const first = scheduleTool({ resources: ['path:/cancel'], write: true }, signal, () => gate)
    const abort = new AbortController()
    const pending = scheduleTool({ resources: ['path:/cancel'], write: true }, abort.signal, async () => { throw new Error('must not execute') })
    abort.abort()
    await expect(pending).rejects.toThrow('canceled')
    release()
    await first
    await expect(scheduleTool({ resources: ['path:/cancel'], write: true }, signal, async () => 'ok')).resolves.toBe('ok')
  })
})
