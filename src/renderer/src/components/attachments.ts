import type { Attachment } from '@shared/types'
import { ulid } from '@shared/id'

/**
 * Composer image attachments: pasted from the clipboard, dropped on the composer, or chosen with the
 * attach button.
 *
 * All of the logic lives here rather than in the Composer component so it has a real test surface:
 * what counts as an image, how big is too big, how a nameless clipboard bitmap gets a filename, and
 * how a browser `File` becomes the {@link Attachment} the run manager already knows how to put on
 * the wire as an `image_url` content part.
 */

/** Image types the vision models we talk to actually accept. */
export const SUPPORTED_IMAGE_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif'
}

/** Human list for error messages and the attach button's tooltip. */
export const SUPPORTED_IMAGE_TEXT = 'PNG, JPEG, WebP, GIF'

/**
 * Per-image ceiling. Matches the `show_image` tool's cap, and is roughly where a base64 data URL
 * starts costing more context than the picture is worth (~11MB of text at 8MB of bytes).
 */
export const MAX_IMAGE_BYTES = 8 * 1024 * 1024

/** How many images one message may carry. Enough for a set of screenshots, not enough to blow a window. */
export const MAX_IMAGES_PER_MESSAGE = 6

/** Is this a file we can attach as a vision input? */
export function isSupportedImage(type: string): boolean {
  return type.toLowerCase() in SUPPORTED_IMAGE_MIME
}

/** "2.4 MB" / "812 KB" — for the preview chip and the too-big error. */
export function fmtBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Whether a file may be attached, with the reason when it may not. Checked before any bytes are
 * read, so a 40MB drop is refused instantly instead of after a long encode.
 */
export function validateImageFile(
  file: { name?: string; type: string; size: number },
  opts: { existing?: number } = {}
): { ok: true } | { ok: false; error: string } {
  if (!isSupportedImage(file.type)) {
    const what = file.type ? `“${file.type}”` : 'that file type'
    return { ok: false, error: `Can't attach ${what} — images only (${SUPPORTED_IMAGE_TEXT}).` }
  }
  if (file.size <= 0) return { ok: false, error: 'That image is empty.' }
  if (file.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      error: `${file.name || 'That image'} is ${fmtBytes(file.size)} — the limit is ${fmtBytes(MAX_IMAGE_BYTES)}.`
    }
  }
  if ((opts.existing ?? 0) >= MAX_IMAGES_PER_MESSAGE) {
    return { ok: false, error: `You can attach ${MAX_IMAGES_PER_MESSAGE} images to one message.` }
  }
  return { ok: true }
}

/**
 * A filename for an image. A clipboard bitmap arrives as a nameless blob (or the useless
 * "image.png"), so pasted images are named for the moment they were pasted — which is the only
 * thing that distinguishes one screenshot from the next in a preview strip.
 */
export function imageFileName(file: { name?: string; type: string }, at = new Date()): string {
  const ext = SUPPORTED_IMAGE_MIME[file.type.toLowerCase()] ?? 'png'
  const name = (file.name ?? '').trim()
  if (name && name.toLowerCase() !== `image.${ext}` && name.includes('.')) return name
  const stamp = [at.getHours(), at.getMinutes(), at.getSeconds()]
    .map((n) => String(n).padStart(2, '0'))
    .join('-')
  return `pasted-${stamp}.${ext}`
}

/** Lowercase hex SHA-256 of some bytes, via WebCrypto (available in the renderer and in Node). */
export async function sha256Hex(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** Base64-encode bytes without blowing the argument limit on a multi-megabyte image. */
export function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

/** A `data:` URL for these bytes — the form the provider wire (and an `<img src>`) both take. */
export function bytesToDataUrl(bytes: Uint8Array, mime: string): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`
}

/**
 * Turn a browser `File` into a persisted {@link Attachment}: a data URL the transcript can render
 * and the run manager already forwards to the model as an `image_url` part, plus the digest the
 * store records. Validation is the caller's job ({@link validateImageFile}) — by the time we are
 * reading bytes the file has been accepted.
 */
export async function fileToAttachment(file: File, at = new Date()): Promise<Attachment> {
  const buffer = await file.arrayBuffer()
  const bytes = new Uint8Array(buffer)
  return {
    id: ulid(),
    name: imageFileName(file, at),
    mime: file.type,
    bytes: bytes.byteLength,
    sha256: await sha256Hex(buffer),
    kind: 'image',
    content: bytesToDataUrl(bytes, file.type)
  }
}

/**
 * The image files in a paste or a drop. A screenshot pasted from the system clipboard arrives as a
 * `DataTransferItem` of kind "file" rather than in `files` on some platforms, so both are read;
 * anything that is not a supported image is ignored here and reported by the caller's validation.
 */
export function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return []
  const out: File[] = []
  const seen = new Set<string>()
  const add = (file: File | null): void => {
    if (!file || !isSupportedImage(file.type)) return
    const key = `${file.name}:${file.size}:${file.lastModified}`
    if (seen.has(key)) return
    seen.add(key)
    out.push(file)
  }
  for (const item of Array.from(data.items ?? [])) {
    if (item.kind === 'file') add(item.getAsFile())
  }
  for (const file of Array.from(data.files ?? [])) add(file)
  return out
}

/** Does a paste/drop carry anything we would attach? Used to decide whether to swallow the event. */
export function hasImagePayload(data: DataTransfer | null): boolean {
  if (!data) return false
  const types = Array.from(data.types ?? [])
  return types.some((t) => t === 'Files') && imageFilesFrom(data).length > 0
}

/**
 * Accept a batch of files against the images already staged: the ones to add, and the first reason
 * anything was refused (one message, not a stack of toasts for a ten-file drop).
 */
export async function acceptImageFiles(
  files: File[],
  existing: Attachment[],
  at = new Date()
): Promise<{ added: Attachment[]; error?: string }> {
  const added: Attachment[] = []
  let error: string | undefined
  for (const file of files) {
    const check = validateImageFile(file, { existing: existing.length + added.length })
    if (!check.ok) {
      error ??= check.error
      continue
    }
    added.push(await fileToAttachment(file, at))
  }
  return { added, ...(error ? { error } : {}) }
}
