import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { extname, resolve } from 'node:path'
import type { Attachment } from '@shared/types'
import { ulid } from '@shared/id'
import { listWorkspaces } from './store/eventStore'
import { isPathInsideRoots } from './tools/builtin'

/** Keep server-side path attachments aligned with the renderer's composer limits. */
export const ATTACHMENT_IMAGE_MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif'
}
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024

export async function attachFile(filePath: string): Promise<Attachment> {
  const path = resolve(String(filePath))
  const roots = listWorkspaces().flatMap((workspace) => workspace.roots)
  if (!(await isPathInsideRoots(path, roots))) {
    throw new Error('Attachment path is outside the approved workspace roots.')
  }
  const mime = ATTACHMENT_IMAGE_MIME[extname(path).toLowerCase()]
  if (!mime) throw new Error('Only PNG, JPEG, WebP, and GIF images can be attached.')
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Attachment path is not a file.')
  if (info.size <= 0) throw new Error('That image is empty.')
  if (info.size > MAX_ATTACHMENT_BYTES) {
    throw new Error(`Image is ${info.size} bytes; the limit is ${MAX_ATTACHMENT_BYTES} bytes.`)
  }
  const bytes = await readFile(path)
  return {
    id: ulid(),
    name: path.split(/[\\/]/).pop() ?? path,
    path,
    mime,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    kind: 'image',
    content: `data:${mime};base64,${bytes.toString('base64')}`
  }
}
