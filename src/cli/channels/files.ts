/**
 * Files crossing the gateway: where inbound media lands, and which local files the assistant may
 * hand the owner.
 *
 * Inbound photos and documents are saved inside the assistant's workspace (`<root>/Inbox`), because
 * the runtime only attaches images from approved workspace roots and the assistant can only open a
 * PDF it is allowed to read.
 *
 * Outbound, the assistant names a file with a markdown link to its absolute path. It only ever
 * reaches the paired owner, but the bytes still land on Telegram's or Photon's servers, so a
 * prompt-injected "send me ~/.ssh/id_ed25519" is refused: files must sit in the home folder (not in
 * a hidden folder or ~/Library) or a temp folder, must not look like key material, and must fit the
 * platform's upload limit.
 */
import { closeSync, fstatSync, openSync, readSync, realpathSync, statSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, extname, isAbsolute, join, relative, sep } from 'node:path'
import type { OutboundFile } from './types'

export function inboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, 'Inbox')
}

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.heic': 'image/heic',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.html': 'text/html',
  '.zip': 'application/zip',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
}

export function mimeForPath(path: string): string {
  return MIME_BY_EXTENSION[extname(path).toLowerCase()] ?? 'application/octet-stream'
}

/** Names that are key material or credentials whatever folder they sit in. */
const SECRET_NAME = /^(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|\.env(?:\..*)?|.*\.(?:pem|key|p12|pfx|keychain|keychain-db|kdbx|ovpn)|credentials(?:\.json)?)$/i

export interface OutboundFilePolicy {
  /** The owner's home folder. */
  home: string
  /** Folders outside home that are always fine (temp folders). Home rules still apply inside home. */
  extraRoots: string[]
  maxBytes: number
}

export function defaultOutboundPolicy(maxBytes: number): OutboundFilePolicy {
  return { home: homedir(), extraRoots: [tmpdir(), '/tmp'], maxBytes }
}

/**
 * The on-disk spelling of a path. Plain `realpathSync` echoes back the caller's letter case, and
 * macOS volumes are case-insensitive, so `~/library/Keychains` would otherwise not look like
 * `~/Library`. The native call returns the stored case.
 */
function canonical(path: string): string {
  try {
    return realpathSync.native(path)
  } catch {
    return path
  }
}

function inside(child: string, parent: string): string | undefined {
  const rel = relative(parent, child)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return rel
}

function formatBytes(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / (1024 * 1024))} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

export type VetResult = { ok: true; file: OutboundFile } | { ok: false; reason: string }

/** Decide whether `path` may be uploaded to the owner, and describe it for the adapter. */
export function vetOutboundFile(path: string, policy: OutboundFilePolicy, caption?: string): VetResult {
  if (!isAbsolute(path)) return { ok: false, reason: 'not an absolute path' }
  let real: string
  try {
    real = realpathSync.native(path)
  } catch {
    return { ok: false, reason: 'file not found' }
  }
  const info = statSync(real)
  if (!info.isFile()) return { ok: false, reason: 'not a file' }
  const name = basename(real)
  if (SECRET_NAME.test(name) || SECRET_NAME.test(basename(path))) return { ok: false, reason: 'looks like a key or credentials file' }

  const home = canonical(policy.home)
  const inHome = inside(real, home)
  if (inHome !== undefined) {
    const segments = inHome.split(sep)
    // Compared without case as well, in case a volume reports a spelling other than the stored one.
    if (segments[0]?.toLowerCase() === 'library') return { ok: false, reason: 'files in ~/Library are not sent' }
    if (segments.some((segment) => segment.startsWith('.'))) return { ok: false, reason: 'files in hidden folders are not sent' }
  } else if (!policy.extraRoots.some((root) => inside(real.toLowerCase(), canonical(root).toLowerCase()) !== undefined)) {
    return { ok: false, reason: 'only files in the home folder or a temp folder are sent' }
  }

  if (info.size === 0) return { ok: false, reason: 'the file is empty' }
  if (info.size > policy.maxBytes) return { ok: false, reason: `larger than the ${formatBytes(policy.maxBytes)} upload limit` }
  const mime = mimeForPath(real)
  return {
    ok: true,
    file: { path: real, name, mime, kind: mime.startsWith('image/') ? 'image' : 'file', bytes: info.size, identity: `${info.dev}:${info.ino}`, ...(caption ? { caption } : {}) }
  }
}

/**
 * Read the bytes of a vetted file through one descriptor, refusing if the path now names a
 * different file or its size changed. Vetting and uploading are seconds apart (the reply text goes
 * first), so without this a swapped-in symlink or a grown file would skip the checks.
 */
export function readVettedFile(file: OutboundFile): Buffer<ArrayBuffer> {
  const fd = openSync(file.path, 'r')
  try {
    const info = fstatSync(fd)
    if ((file.identity && `${info.dev}:${info.ino}` !== file.identity) || info.size !== file.bytes) {
      throw new Error(`${file.name} changed after it was checked`)
    }
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const read = readSync(fd, bytes, offset, bytes.length - offset, offset)
      if (read === 0) break
      offset += read
    }
    if (offset !== bytes.length) throw new Error(`${file.name} changed while it was read`)
    return bytes
  } finally {
    closeSync(fd)
  }
}
