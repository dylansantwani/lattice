import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  extractPathCandidates,
  prefetchMentionedFiles,
  PREFETCH_MAX_FILES,
  PREFETCH_MAX_FILE_BYTES
} from './prefetch'
import type { Attachment } from '@shared/types'

describe('extractPathCandidates — path-looking tokens in a message', () => {
  it('finds relative, absolute, and bare-filename mentions and strips :line suffixes', () => {
    const text =
      'fix the bug in src/main/runtime/runManager.ts:3324 and check ./scripts/e2e-app.mjs, ' +
      'also /etc/hosts.bak and registry.ts please'
    expect(extractPathCandidates(text)).toEqual([
      'src/main/runtime/runManager.ts',
      './scripts/e2e-app.mjs',
      '/etc/hosts.bak',
      'registry.ts'
    ])
  })

  it('never treats a URL path as a workspace file', () => {
    const cands = extractPathCandidates('see https://example.com/docs/setup.html and src/app.ts')
    expect(cands).toEqual(['src/app.ts'])
  })

  it('drops trailing punctuation, dedupes, and skips prose abbreviations', () => {
    expect(extractPathCandidates('read a/b.ts, then a/b.ts! (also notes.md).')).toEqual(['a/b.ts', 'notes.md'])
    // A slash-less token needs a filename-shaped stem and extension — abbreviations never qualify.
    expect(extractPathCandidates('e.g. etc. i.e.')).toEqual([])
  })
})

describe('prefetchMentionedFiles — conservative auto-attach', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'lattice-prefetch-'))
    await mkdir(join(root, 'src'), { recursive: true })
    await writeFile(join(root, 'src', 'app.ts'), 'export const answer = 42\n')
    await writeFile(join(root, 'notes.md'), 'hello notes\n')
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('attaches an existing mentioned file with its content, hash, and an auto-attached label', async () => {
    const atts = await prefetchMentionedFiles('please look at src/app.ts', root, [root])
    expect(atts).toHaveLength(1)
    expect(atts[0]!.name).toBe('src/app.ts (auto-attached)')
    expect(atts[0]!.kind).toBe('text')
    expect(atts[0]!.content).toContain('answer = 42')
    expect(atts[0]!.sha256).toMatch(/^[0-9a-f]{64}$/)
  })

  it('silently skips mentions that are not real files', async () => {
    const atts = await prefetchMentionedFiles('node.js vs deno.land, also missing/file.ts', root, [root])
    expect(atts).toEqual([])
  })

  it('refuses files outside the workspace roots even when they exist', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'lattice-prefetch-out-'))
    try {
      await writeFile(join(outside, 'secret.txt'), 'nope')
      const atts = await prefetchMentionedFiles(`read ${join(outside, 'secret.txt')}`, root, [root])
      expect(atts).toEqual([])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('skips binaries and empty files', async () => {
    await writeFile(join(root, 'img.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]))
    await writeFile(join(root, 'empty.txt'), '')
    const atts = await prefetchMentionedFiles('see img.png and empty.txt and notes.md', root, [root])
    expect(atts.map((a) => a.name)).toEqual(['notes.md (auto-attached)'])
  })

  it('clips an oversized file to the per-file cap with a note pointing at fs_read', async () => {
    await writeFile(join(root, 'big.log'), 'x'.repeat(PREFETCH_MAX_FILE_BYTES + 500))
    const atts = await prefetchMentionedFiles('why does big.log say that', root, [root])
    expect(atts).toHaveLength(1)
    expect(atts[0]!.content!.length).toBeLessThan(PREFETCH_MAX_FILE_BYTES + 200)
    expect(atts[0]!.content).toContain('fs_read it with offset/limit')
    expect(atts[0]!.bytes).toBe(PREFETCH_MAX_FILE_BYTES + 500)
  })

  it('caps the number of files attached per message', async () => {
    const names: string[] = []
    for (let i = 0; i < PREFETCH_MAX_FILES + 3; i++) {
      const n = `f${i}.txt`
      await writeFile(join(root, n), `file ${i}`)
      names.push(n)
    }
    const atts = await prefetchMentionedFiles(`look at ${names.join(' and ')}`, root, [root])
    expect(atts).toHaveLength(PREFETCH_MAX_FILES)
  })

  it('does not duplicate a file the user already attached (by path)', async () => {
    const already: Attachment[] = [
      {
        id: 'a1',
        name: 'app.ts',
        path: join(root, 'src', 'app.ts'),
        mime: 'text/plain',
        bytes: 10,
        sha256: 'x',
        kind: 'text',
        content: 'user copy'
      }
    ]
    const atts = await prefetchMentionedFiles('src/app.ts and notes.md', root, [root], already)
    expect(atts.map((a) => a.name)).toEqual(['notes.md (auto-attached)'])
  })
})
