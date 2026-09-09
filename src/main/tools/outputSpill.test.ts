import { describe, expect, it } from 'vitest'
import { mkdtemp, readFile, stat, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pruneStaleSpills, spillDir, spillOutput, SPILL_MAX_AGE_MS } from './outputSpill'

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

describe('spillOutput', () => {
  it('writes the full text to a file inside the spill dir and returns its path', async () => {
    const text = 'line one\n'.repeat(500)
    const path = await spillOutput(text, 'test')
    expect(path.startsWith(spillDir())).toBe(true)
    expect(await readFile(path, 'utf8')).toBe(text)
  })
})

describe('pruneStaleSpills', () => {
  it('removes files past the max age and keeps fresh ones', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'lattice-spill-test-'))
    const stale = join(dir, 'stale.txt')
    const fresh = join(dir, 'fresh.txt')
    await writeFile(stale, 'old', 'utf8')
    await writeFile(fresh, 'new', 'utf8')
    const past = new Date(Date.now() - SPILL_MAX_AGE_MS - 60_000)
    await utimes(stale, past, past)
    await pruneStaleSpills(dir)
    expect(await exists(stale)).toBe(false)
    expect(await exists(fresh)).toBe(true)
  })
})
