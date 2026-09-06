import { describe, expect, it } from 'vitest'
import {
  acceptImageFiles,
  bytesToDataUrl,
  fileToAttachment,
  fmtBytes,
  hasImagePayload,
  imageFileName,
  imageFilesFrom,
  isSupportedImage,
  MAX_IMAGE_BYTES,
  MAX_IMAGES_PER_MESSAGE,
  sha256Hex,
  validateImageFile
} from './attachments'
import type { Attachment } from '@shared/types'

/** A real File, so the code under test does the same work it does in the renderer. */
function imageFile(name: string, type = 'image/png', bytes = 12): File {
  return new File([new Uint8Array(bytes).fill(7)], name, { type })
}

/** A File that reports a size without allocating it (the 40MB-drop case). */
function hugeFile(name: string, size: number, type = 'image/png'): { name: string; type: string; size: number } {
  return { name, type, size }
}

/** Minimal DataTransfer stand-in: the shape paste/drop handlers actually read. */
function transfer(files: File[], types: string[] = ['Files']): DataTransfer {
  return {
    types,
    files,
    items: files.map((f) => ({ kind: 'file' as const, getAsFile: () => f }))
  } as unknown as DataTransfer
}

describe('what may be attached', () => {
  it('accepts the image types vision models take, and nothing else', () => {
    expect(isSupportedImage('image/png')).toBe(true)
    expect(isSupportedImage('image/JPEG')).toBe(true)
    expect(isSupportedImage('image/webp')).toBe(true)
    expect(isSupportedImage('image/gif')).toBe(true)
    expect(isSupportedImage('image/svg+xml')).toBe(false)
    expect(isSupportedImage('application/pdf')).toBe(false)
    expect(isSupportedImage('')).toBe(false)
  })

  it('refuses a non-image with a reason naming the type', () => {
    const res = validateImageFile({ name: 'notes.pdf', type: 'application/pdf', size: 100 })
    expect(res).toMatchObject({ ok: false })
    expect(!res.ok && res.error).toMatch(/application\/pdf/)
  })

  it('refuses an image past the size cap, before reading a byte of it', () => {
    const res = validateImageFile(hugeFile('huge.png', MAX_IMAGE_BYTES + 1))
    expect(res).toMatchObject({ ok: false })
    expect(!res.ok && res.error).toMatch(/huge\.png is 8\.0 MB — the limit is 8\.0 MB/)
    expect(validateImageFile(hugeFile('ok.png', MAX_IMAGE_BYTES))).toEqual({ ok: true })
  })

  it('refuses an empty file and a message that is already full', () => {
    expect(validateImageFile({ name: 'x.png', type: 'image/png', size: 0 })).toMatchObject({ ok: false })
    const full = validateImageFile({ name: 'x.png', type: 'image/png', size: 10 }, { existing: MAX_IMAGES_PER_MESSAGE })
    expect(full).toMatchObject({ ok: false })
    expect(!full.ok && full.error).toMatch(new RegExp(`${MAX_IMAGES_PER_MESSAGE} images`))
  })

  it('formats sizes the way the preview chip shows them', () => {
    expect(fmtBytes(900)).toBe('900 B')
    expect(fmtBytes(2048)).toBe('2 KB')
    expect(fmtBytes(2.5 * 1024 * 1024)).toBe('2.5 MB')
  })
})

describe('naming', () => {
  const at = new Date(2026, 8, 4, 9, 5, 3)

  it('names a nameless clipboard bitmap for the moment it was pasted', () => {
    expect(imageFileName({ type: 'image/png' }, at)).toBe('pasted-09-05-03.png')
    // Chrome hands over the placeholder "image.png" for a clipboard screenshot — equally useless.
    expect(imageFileName({ name: 'image.png', type: 'image/png' }, at)).toBe('pasted-09-05-03.png')
    expect(imageFileName({ name: '', type: 'image/jpeg' }, at)).toBe('pasted-09-05-03.jpg')
  })

  it('keeps a real filename from a dropped or chosen file', () => {
    expect(imageFileName({ name: 'q3-chart.png', type: 'image/png' }, at)).toBe('q3-chart.png')
  })
})

describe('encoding', () => {
  it('produces a data URL an <img> and the provider wire both accept', () => {
    expect(bytesToDataUrl(new Uint8Array([1, 2, 3]), 'image/png')).toBe('data:image/png;base64,AQID')
  })

  it('encodes a multi-megabyte image without blowing the call stack', () => {
    const big = new Uint8Array(3 * 1024 * 1024).fill(65)
    const url = bytesToDataUrl(big, 'image/jpeg')
    expect(url.startsWith('data:image/jpeg;base64,')).toBe(true)
    expect(url.length).toBeGreaterThan(4_000_000)
  })

  it('digests bytes as lowercase hex sha-256', async () => {
    // Known vector: sha256("abc")
    const hash = await sha256Hex(new TextEncoder().encode('abc').buffer as ArrayBuffer)
    expect(hash).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
  })
})

describe('fileToAttachment', () => {
  it('turns a File into the attachment the store persists and the model sees', async () => {
    const att = await fileToAttachment(imageFile('shot.png', 'image/png', 4), new Date(2026, 8, 4, 1, 2, 3))
    expect(att).toMatchObject({ name: 'shot.png', mime: 'image/png', bytes: 4, kind: 'image' })
    expect(att.content).toMatch(/^data:image\/png;base64,/)
    expect(att.sha256).toHaveLength(64)
    expect(att.id).toBeTruthy()
  })
})

describe('reading a paste or a drop', () => {
  it('takes the images out of a clipboard payload and ignores everything else', () => {
    const png = imageFile('a.png')
    const pdf = new File([new Uint8Array(4)], 'notes.pdf', { type: 'application/pdf' })
    expect(imageFilesFrom(transfer([png, pdf])).map((f) => f.name)).toEqual(['a.png'])
  })

  it('does not attach the same file twice when it appears in both items and files', () => {
    const png = imageFile('a.png')
    const data = { types: ['Files'], files: [png], items: [{ kind: 'file', getAsFile: () => png }] } as unknown as DataTransfer
    expect(imageFilesFrom(data)).toHaveLength(1)
  })

  it('reports whether a payload is worth swallowing the event for', () => {
    expect(hasImagePayload(transfer([imageFile('a.png')]))).toBe(true)
    // Copied text carries no files: the paste must fall through to the textarea untouched.
    expect(hasImagePayload(transfer([], ['text/plain']))).toBe(false)
    expect(hasImagePayload(transfer([new File(['x'], 'a.txt', { type: 'text/plain' })]))).toBe(false)
    expect(hasImagePayload(null)).toBe(false)
  })

  it('handles an empty transfer', () => {
    expect(imageFilesFrom(null)).toEqual([])
  })
})

describe('acceptImageFiles', () => {
  const none: Attachment[] = []

  it('converts what it can and reports the first refusal once', async () => {
    const files = [imageFile('a.png'), new File([new Uint8Array(2)], 'b.pdf', { type: 'application/pdf' })]
    const { added, error } = await acceptImageFiles(files, none)
    expect(added.map((a) => a.name)).toEqual(['a.png'])
    expect(error).toMatch(/images only/)
  })

  it('stops at the per-message ceiling and says so, keeping the ones that fit', async () => {
    const files = Array.from({ length: MAX_IMAGES_PER_MESSAGE + 2 }, (_, i) => imageFile(`s${i}.png`))
    const { added, error } = await acceptImageFiles(files, none)
    expect(added).toHaveLength(MAX_IMAGES_PER_MESSAGE)
    expect(error).toMatch(new RegExp(`${MAX_IMAGES_PER_MESSAGE} images`))
  })

  it('counts what is already staged against the ceiling', async () => {
    const staged = await acceptImageFiles([imageFile('a.png'), imageFile('b.png')], none)
    const { added, error } = await acceptImageFiles(
      Array.from({ length: MAX_IMAGES_PER_MESSAGE }, (_, i) => imageFile(`c${i}.png`)),
      staged.added
    )
    expect(added).toHaveLength(MAX_IMAGES_PER_MESSAGE - 2)
    expect(error).toBeTruthy()
  })

  it('adds nothing, and complains about nothing, for an empty batch', async () => {
    expect(await acceptImageFiles([], none)).toEqual({ added: [] })
  })
})
