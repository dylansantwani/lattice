import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { needsConversion, prepareImageForModel } from './imagePrep'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'lattice-image-prep-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('needsConversion', () => {
  it('converts HEIC and oversized images, leaves small attachable ones', () => {
    expect(needsConversion('/x/IMG_1.HEIC', 2_000_000)).toBe(true)
    expect(needsConversion('/x/shot.png', 12 * 1024 * 1024)).toBe(true)
    expect(needsConversion('/x/photo.jpg', 300_000)).toBe(false)
    expect(needsConversion('/x/file.pdf', 10)).toBe(false)
  })
})

describe('prepareImageForModel', () => {
  it('returns an attachable photo untouched', async () => {
    const path = join(dir, 'photo.jpg')
    writeFileSync(path, 'jpeg')
    expect(await prepareImageForModel(path, 'image/jpeg', { converter: async () => { throw new Error('not called') } })).toBe(path)
  })

  it('converts a HEIC next to the original, once', async () => {
    const path = join(dir, 'IMG_2201.heic')
    writeFileSync(path, 'heic')
    let conversions = 0
    const converter = async (input: string, output: string): Promise<void> => {
      conversions += 1
      writeFileSync(output, `jpeg of ${readFileSync(input, 'utf8')}`)
    }
    const out = await prepareImageForModel(path, 'image/heic', { converter })
    expect(out).toBe(join(dir, 'IMG_2201.model.jpg'))
    expect(readFileSync(out, 'utf8')).toBe('jpeg of heic')
    expect(existsSync(path)).toBe(true)
    expect(await prepareImageForModel(path, 'image/heic', { converter })).toBe(out)
    expect(conversions).toBe(1)
  })

  it('falls back to the original when conversion is unavailable or fails', async () => {
    const path = join(dir, 'IMG.heic')
    writeFileSync(path, 'heic')
    expect(await prepareImageForModel(path, 'image/heic', { platform: 'linux' })).toBe(path)
    expect(await prepareImageForModel(path, 'image/heic', { converter: async () => { throw new Error('sips failed') } })).toBe(path)
    expect(await prepareImageForModel(join(dir, 'missing.heic'))).toBe(join(dir, 'missing.heic'))
  })
})
