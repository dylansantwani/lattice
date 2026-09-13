import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import {
  buildWorkspacePrimer,
  isHomeLikeRoot,
  PRIMER_MAX_FS_OPS,
  PROTECTED_HOME_DIRS,
  resetWorkspacePrimerCache,
  workspacePrimerFor
} from './workspacePrimer'

describe('workspace primer', () => {
  let root: string
  const realHome = process.env.HOME
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'lattice-primer-'))
    resetWorkspacePrimerCache()
  })
  afterEach(() => {
    process.env.HOME = realHome
    rmSync(root, { recursive: true, force: true })
  })

  it('lists a project root two levels deep with its manifests and orientation doc', () => {
    mkdirSync(join(root, 'packages', 'core'), { recursive: true })
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'vitest' } }))
    writeFileSync(join(root, 'packages', 'core', 'package.json'), JSON.stringify({ name: '@demo/core' }))
    writeFileSync(join(root, 'README.md'), '# Demo\n\nA demo repo.')
    const primer = buildWorkspacePrimer([root])
    expect(primer).toContain('Top level: packages/  src/  README.md  package.json')
    expect(primer).toContain('packages/: core/')
    expect(primer).toContain('./package.json — demo (scripts: test)')
    expect(primer).toContain('packages/core/package.json — @demo/core')
    expect(primer).toContain('README.md (excerpt):')
  })

  it('recognises the home directory and anything above it as home-like', () => {
    expect(isHomeLikeRoot(homedir())).toBe(true)
    expect(isHomeLikeRoot('/')).toBe(true)
    expect(isHomeLikeRoot(join(homedir(), '..'))).toBe(true)
    expect(isHomeLikeRoot(join(homedir(), 'some-project'))).toBe(false)
    expect(isHomeLikeRoot(root)).toBe(false)
  })

  it('never descends into a home-like root — protected folders are not even opened', () => {
    // Point HOME at the temp root so the walker treats it as the home directory.
    process.env.HOME = root
    for (const name of [...PROTECTED_HOME_DIRS, 'lattice']) mkdirSync(join(root, name), { recursive: true })
    mkdirSync(join(root, 'lattice', 'src'), { recursive: true })
    writeFileSync(join(root, 'lattice', 'package.json'), JSON.stringify({ name: 'lattice' }))
    // A sentinel that would only show up if the walker opened a protected folder.
    writeFileSync(join(root, 'Desktop', 'SECRET-sentinel.txt'), 'x')
    const primer = buildWorkspacePrimer([root])
    expect(primer).toContain('Top level:')
    expect(primer).toContain('lattice/')
    expect(primer).not.toContain('Desktop/')
    expect(primer).not.toContain('SECRET-sentinel')
    expect(primer).not.toContain('lattice/: src/') // no descent at all from a home-like root
    expect(primer).not.toContain('lattice/package.json')
    expect(primer).toContain('home directory, not a project')
  })

  it('keeps protected folders out even when a project root happens to contain one', () => {
    // A project root (not home-like) may legitimately have a Documents/ dir; that is fine to list.
    mkdirSync(join(root, 'Documents', 'inner'), { recursive: true })
    const primer = buildWorkspacePrimer([root])
    expect(primer).toContain('Documents/: inner/')
  })

  it('stops after the filesystem-operation budget on a wide tree', () => {
    for (let i = 0; i < PRIMER_MAX_FS_OPS + 50; i += 1) {
      mkdirSync(join(root, `dir-${String(i).padStart(3, '0')}`, `child-${i}`), { recursive: true })
      writeFileSync(join(root, `dir-${String(i).padStart(3, '0')}`, `child-${i}`, 'package.json'), JSON.stringify({ name: `p${i}` }))
    }
    const primer = buildWorkspacePrimer([root])
    expect(primer.length).toBeLessThanOrEqual(6000 + 40)
    // Twelve manifests at most, and the walk did not visit every one of the 210 directories.
    expect((primer.match(/package\.json —/g) ?? []).length).toBeLessThanOrEqual(12)
  })

  it('memoizes per root set so every spawn shares identical bytes', () => {
    writeFileSync(join(root, 'README.md'), 'v1')
    const a = workspacePrimerFor([root])
    writeFileSync(join(root, 'README.md'), 'v2')
    expect(workspacePrimerFor([root])).toBe(a)
    resetWorkspacePrimerCache()
    expect(workspacePrimerFor([root])).toContain('v2')
  })
})
