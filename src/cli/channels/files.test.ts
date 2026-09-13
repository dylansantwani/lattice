import { appendFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { inboxDir, mimeForPath, readVettedFile, vetOutboundFile, type OutboundFilePolicy } from './files'

let root: string
let home: string
let scratch: string
let policy: OutboundFilePolicy

function file(path: string, bytes = 'data'): string {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, bytes)
  return path
}

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'lattice-files-')))
  home = join(root, 'home')
  scratch = join(root, 'scratch')
  mkdirSync(home)
  mkdirSync(scratch)
  policy = { home, extraRoots: [scratch], maxBytes: 1024 }
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('outbound file policy', () => {
  it('sends ordinary files from home and the extra roots, typed by extension', () => {
    const chart = file(join(home, 'LatticeAssistant', 'chart.png'))
    const verdict = vetOutboundFile(chart, policy, 'Weekly chart')
    expect(verdict).toEqual({ ok: true, file: { path: chart, name: 'chart.png', mime: 'image/png', kind: 'image', bytes: 4, identity: expect.stringMatching(/^\d+:\d+$/), caption: 'Weekly chart' } })
    const report = file(join(scratch, 'report.pdf'))
    expect(vetOutboundFile(report, policy)).toMatchObject({ ok: true, file: { mime: 'application/pdf', kind: 'file' } })
  })

  it('refuses hidden folders, ~/Library, and key material wherever it sits', () => {
    expect(vetOutboundFile(file(join(home, '.ssh', 'config')), policy)).toEqual({ ok: false, reason: 'files in hidden folders are not sent' })
    expect(vetOutboundFile(file(join(home, 'Library', 'Cookies', 'Cookies.binarycookies')), policy)).toEqual({ ok: false, reason: 'files in ~/Library are not sent' })
    expect(vetOutboundFile(file(join(home, 'Documents', 'id_ed25519')), policy)).toMatchObject({ ok: false, reason: expect.stringContaining('key') })
    expect(vetOutboundFile(file(join(scratch, 'server.pem')), policy)).toMatchObject({ ok: false })
    expect(vetOutboundFile(file(join(home, 'project', '.env.local')), policy)).toMatchObject({ ok: false })
  })

  it('is not fooled by letter case on a case-insensitive volume', () => {
    file(join(home, 'Library', 'Keychains', 'login.txt'))
    const probe = join(home, 'library', 'Keychains', 'login.txt')
    // Only meaningful where the volume ignores case (the macOS default); elsewhere the file is just missing.
    const verdict = vetOutboundFile(probe, policy)
    expect(verdict).toEqual({ ok: false, reason: existsSync(probe) ? 'files in ~/Library are not sent' : 'file not found' })
  })

  it('judges a symlink by where it points', () => {
    const secret = file(join(home, '.aws', 'config'))
    const innocent = join(home, 'Desktop', 'notes.txt')
    mkdirSync(join(home, 'Desktop'))
    symlinkSync(secret, innocent)
    expect(vetOutboundFile(innocent, policy)).toEqual({ ok: false, reason: 'files in hidden folders are not sent' })
  })

  it('refuses paths outside home and the extra roots, missing files, folders, and oversized or empty files', () => {
    const outside = file(join(root, 'elsewhere', 'a.txt'))
    expect(vetOutboundFile(outside, policy)).toMatchObject({ ok: false, reason: expect.stringContaining('home folder') })
    expect(vetOutboundFile(join(home, 'nope.png'), policy)).toEqual({ ok: false, reason: 'file not found' })
    expect(vetOutboundFile('relative/path.png', policy)).toEqual({ ok: false, reason: 'not an absolute path' })
    mkdirSync(join(home, 'folder'))
    expect(vetOutboundFile(join(home, 'folder'), policy)).toEqual({ ok: false, reason: 'not a file' })
    expect(vetOutboundFile(file(join(home, 'big.bin'), 'x'.repeat(2048)), policy)).toMatchObject({ ok: false, reason: expect.stringContaining('upload limit') })
    expect(vetOutboundFile(file(join(home, 'empty.txt'), ''), policy)).toEqual({ ok: false, reason: 'the file is empty' })
  })

  it('knows common types and puts the inbox inside the workspace', () => {
    expect(mimeForPath('/x/photo.JPG')).toBe('image/jpeg')
    expect(mimeForPath('/x/deck.pptx')).toContain('presentationml')
    expect(mimeForPath('/x/unknown.xyz')).toBe('application/octet-stream')
    expect(inboxDir('/Users/me/LatticeAssistant')).toBe('/Users/me/LatticeAssistant/Inbox')
  })

  it('reads exactly the file that was vetted, and refuses one swapped or grown since', () => {
    const path = file(join(home, 'Desktop', 'photo.jpg'), 'JPEGDATA')
    const vetted = vetOutboundFile(path, policy)
    if (!vetted.ok) throw new Error(vetted.reason)
    expect(readVettedFile(vetted.file).toString()).toBe('JPEGDATA')

    appendFileSync(path, 'more')
    expect(() => readVettedFile(vetted.file)).toThrow(/changed after it was checked/)

    const again = vetOutboundFile(path, policy)
    if (!again.ok) throw new Error(again.reason)
    // A different file of exactly the same size at the same path: only the inode tells them apart.
    const secret = file(join(home, '.ssh', 'id_ed25519_copy'), 'PRIVATEKEY!!')
    expect(again.file.bytes).toBe(12)
    rmSync(path)
    renameSync(secret, path)
    expect(() => readVettedFile(again.file)).toThrow(/changed after it was checked/)
    rmSync(path)
    symlinkSync(file(join(home, '.aws', 'credentials-12b'), 'AWSSECRET123'), path)
    expect(() => readVettedFile(again.file)).toThrow(/changed after it was checked/)
  })
})
