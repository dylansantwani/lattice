import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ThreadId } from '@shared/types'

const dataDir = mkdtempSync(join(tmpdir(), 'lattice-files-data-'))
const workDir = mkdtempSync(join(tmpdir(), 'lattice-files-work-'))
// The default workspace roots itself at $HOME; point that at our temp work dir so files written
// there are inside the approved roots the Files inspector validates against.
process.env.HOME = workDir

vi.mock('electron', () => ({ app: { getPath: () => dataDir } }))

import * as store from './store/eventStore'
import { closeDb, getDb } from './store/db'
import { fsTree, fsReadFile, approvedRoots } from './files'

beforeEach(() => {
  getDb().exec('DELETE FROM threads; DELETE FROM messages; DELETE FROM events; DELETE FROM workspaces; DELETE FROM file_changes')
  store.ensureDefaultWorkspace()
})

afterAll(() => {
  closeDb()
  rmSync(dataDir, { recursive: true, force: true })
  rmSync(workDir, { recursive: true, force: true })
})

describe('file change tracking', () => {
  it('keeps the original baseline across repeated edits and derives kind', () => {
    const t = 't1' as ThreadId
    const p = join(workDir, 'a.ts')
    store.recordFileChange({ threadId: t, path: p, before: 'v1', after: 'v2' })
    store.recordFileChange({ threadId: t, path: p, before: 'v2', after: 'v3' })
    const changes = store.listFileChanges(t)
    expect(changes).toHaveLength(1)
    // before stays the ORIGINAL baseline (v1), after is the latest (v3) — the whole-session diff.
    expect(changes[0]!.before).toBe('v1')
    expect(changes[0]!.after).toBe('v3')
    expect(changes[0]!.kind).toBe('edit')
  })

  it('labels a file with no baseline as create, and a removed file as delete', () => {
    const t = 't2' as ThreadId
    store.recordFileChange({ threadId: t, path: join(workDir, 'new.ts'), before: null, after: 'hello' })
    store.recordFileChange({ threadId: t, path: join(workDir, 'gone.ts'), before: 'was here', after: null })
    const byPath = Object.fromEntries(store.listFileChanges(t).map((c) => [c.path.split('/').pop(), c.kind]))
    expect(byPath['new.ts']).toBe('create')
    expect(byPath['gone.ts']).toBe('delete')
  })

  it('lists newest-first and clears with the thread', () => {
    const t = 't3' as ThreadId
    store.recordFileChange({ threadId: t, path: join(workDir, 'x'), before: 'a', after: 'b' })
    expect(store.listFileChanges(t)).toHaveLength(1)
    store.clearFileChanges(t)
    expect(store.listFileChanges(t)).toHaveLength(0)
  })
})

describe('fsTree', () => {
  it('lists directory entries within approved roots, dirs before files', async () => {
    mkdirSync(join(workDir, 'sub'), { recursive: true })
    writeFileSync(join(workDir, 'z.txt'), 'zzz')
    writeFileSync(join(workDir, 'a.txt'), 'aaa')
    const entries = await fsTree(workDir)
    const names = entries.map((e) => e.name)
    // 'sub' (dir) sorts before the files; files are alphabetical.
    expect(names.indexOf('sub')).toBeLessThan(names.indexOf('a.txt'))
    const file = entries.find((e) => e.name === 'a.txt')!
    expect(file.kind).toBe('file')
    expect(file.size).toBe(3)
  })

  it('refuses a path outside the approved roots', async () => {
    await expect(fsTree('/etc')).rejects.toThrow(/approved workspace roots/)
  })

  it('returns the roots themselves when no path is given', async () => {
    const roots = await fsTree()
    expect(roots.every((r) => r.kind === 'dir')).toBe(true)
    expect(approvedRoots().length).toBeGreaterThan(0)
  })
})

describe('fsReadFile', () => {
  it('reads a text file', async () => {
    const p = join(workDir, 'note.md')
    writeFileSync(p, '# hi\ncontent')
    const f = await fsReadFile(p)
    expect(f.kind).toBe('text')
    expect(f.text).toBe('# hi\ncontent')
    expect(f.size).toBe('# hi\ncontent'.length)
  })

  it('returns an image as a data URL', async () => {
    const p = join(workDir, 'pic.png')
    // A tiny fake PNG payload — content doesn't matter, only the extension drives the branch.
    writeFileSync(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]))
    const f = await fsReadFile(p)
    expect(f.kind).toBe('image')
    expect(f.dataUrl).toMatch(/^data:image\/png;base64,/)
  })

  it('flags a binary (NUL-containing) file', async () => {
    const p = join(workDir, 'blob.dat')
    writeFileSync(p, Buffer.from([1, 2, 0, 3, 4]))
    const f = await fsReadFile(p)
    expect(f.kind).toBe('binary')
  })

  it('refuses a path outside the approved roots', async () => {
    await expect(fsReadFile('/etc/hosts')).rejects.toThrow(/approved workspace roots/)
  })
})
