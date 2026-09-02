import { readdir, stat, readFile } from 'node:fs/promises'
import { basename, join, extname } from 'node:path'
import { isPathInsideRoots } from './tools/builtin'
import { listWorkspaces } from './store/eventStore'
import type { FsEntry, FsFile } from '@shared/types'

/**
 * Read-only filesystem access for the Files inspector. Every path is validated against the union of
 * every workspace's approved roots (symlink-resolved by `isPathInsideRoots`) before it is touched, so
 * the inspector can never read outside the same boundary the agent's fs tools honor.
 */

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif'
}

const TEXT_CAP = 512 * 1024 // clip very large text files to keep the viewer responsive
const IMAGE_CAP = 8 * 1024 * 1024 // above this an image is treated as an un-rendered binary
const HARD_CAP = 32 * 1024 * 1024 // never slurp a file larger than this into memory

/** The union of every workspace's approved roots — the read boundary for the inspector. */
export function approvedRoots(): string[] {
  const roots = new Set<string>()
  for (const w of listWorkspaces()) for (const r of w.roots) roots.add(r)
  return [...roots]
}

/** List a directory (or the roots themselves when `path` is omitted), dirs first then files, alpha. */
export async function fsTree(path?: string): Promise<FsEntry[]> {
  const roots = approvedRoots()
  if (!path) {
    return roots.map((r) => ({ name: basename(r) || r, path: r, kind: 'dir' as const }))
  }
  if (!(await isPathInsideRoots(path, roots))) {
    throw new Error('Path is outside the approved workspace roots.')
  }
  const entries = await readdir(path, { withFileTypes: true })
  const rows: FsEntry[] = await Promise.all(
    entries.map(async (e) => {
      const full = join(path, e.name)
      const kind = e.isDirectory() ? ('dir' as const) : ('file' as const)
      let size: number | undefined
      if (kind === 'file') {
        try {
          size = (await stat(full)).size
        } catch {
          // a broken symlink or a race — leave size undefined
        }
      }
      return { name: e.name, path: full, kind, size }
    })
  )
  return rows.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1
  )
}

/** Read one file for the viewer: text (clipped), an image data URL, or a binary marker. */
export async function fsReadFile(path: string): Promise<FsFile> {
  const roots = approvedRoots()
  if (!(await isPathInsideRoots(path, roots))) {
    throw new Error('Path is outside the approved workspace roots.')
  }
  const info = await stat(path)
  if (!info.isFile()) throw new Error('Not a file.')
  const size = info.size
  const ext = extname(path).slice(1).toLowerCase()
  const mime = IMAGE_MIME[ext]
  if (mime) {
    if (size > IMAGE_CAP) return { path, kind: 'binary', size }
    const data = (await readFile(path)).toString('base64')
    return { path, kind: 'image', dataUrl: `data:${mime};base64,${data}`, size }
  }
  if (size > HARD_CAP) return { path, kind: 'binary', size }
  const full = await readFile(path)
  const buf = size > TEXT_CAP ? full.subarray(0, TEXT_CAP) : full
  if (buf.includes(0)) return { path, kind: 'binary', size }
  return { path, kind: 'text', text: buf.toString('utf8'), size, truncated: size > TEXT_CAP }
}
