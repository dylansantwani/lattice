/**
 * Photos as a model can take them. The runtime attaches PNG, JPEG, WebP and GIF up to 8 MB, but an
 * iPhone photo sent "as a file" is a HEIC, and a screenshot sent uncompressed is often a 12 MB PNG.
 * Both used to fall back to "(sent an image, saved at …)", which a model cannot look at. On macOS
 * they are converted with `sips` (built in) to a JPEG no larger than 2048 px, saved next to the
 * original so the full-quality file is still there.
 */
import { execFile } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { extname } from 'node:path'

/** Largest image the runtime attaches (attachments.ts), with room for the base64 envelope. */
const ATTACHABLE_BYTES = 7 * 1024 * 1024
const ATTACHABLE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif'])
const CONVERTIBLE_EXTENSIONS = new Set(['.heic', '.heif', '.tif', '.tiff', '.bmp', '.png', '.jpg', '.jpeg', '.webp'])

export type ImageConverter = (input: string, output: string) => Promise<void>

/** `sips -s format jpeg -Z 2048`: macOS's own image tool, no dependencies. */
export const sipsConverter: ImageConverter = (input, output) =>
  new Promise((resolve, reject) => {
    execFile('/usr/bin/sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '82', '-Z', '2048', input, '--out', output], { timeout: 30_000 }, (error) =>
      error ? reject(error) : resolve()
    )
  })

/** Whether `path` needs converting before the runtime will attach it. */
export function needsConversion(path: string, bytes: number): boolean {
  const ext = extname(path).toLowerCase()
  if (!ATTACHABLE_EXTENSIONS.has(ext)) return CONVERTIBLE_EXTENSIONS.has(ext)
  return bytes > ATTACHABLE_BYTES
}

/**
 * The path to attach for an inbound image: the original when it is already attachable, otherwise a
 * converted JPEG beside it. Resolves to the original when conversion is impossible (not macOS, sips
 * failed), leaving the caller's "saved at" fallback to explain.
 */
export async function prepareImageForModel(
  path: string,
  _mime?: string,
  options: { converter?: ImageConverter; platform?: NodeJS.Platform } = {}
): Promise<string> {
  let bytes = 0
  try {
    bytes = statSync(path).size
  } catch {
    return path
  }
  if (!needsConversion(path, bytes)) return path
  const platform = options.platform ?? process.platform
  const converter = options.converter ?? (platform === 'darwin' ? sipsConverter : undefined)
  if (!converter) return path
  const output = `${path.slice(0, path.length - extname(path).length)}.model.jpg`
  try {
    if (!existsSync(output)) await converter(path, output)
    return existsSync(output) && statSync(output).size > 0 ? output : path
  } catch {
    return path
  }
}
