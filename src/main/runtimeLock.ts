import { chmod, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export interface RuntimeLock {
  readonly path: string
  readonly pid: number
  release(): Promise<void>
}

export class RuntimeLockError extends Error {
  constructor(
    readonly path: string,
    readonly ownerPid?: number
  ) {
    super(ownerPid === undefined ? `runtime lock is held: ${path}` : `runtime lock is held by pid ${ownerPid}: ${path}`)
    this.name = 'RuntimeLockError'
  }
}

/** True when the operating system still has a process with this PID. */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM means the process exists but belongs to another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

function parsePid(contents: string): number | undefined {
  const pid = Number.parseInt(contents.trim().split(/\s+/, 1)[0] ?? '', 10)
  return Number.isInteger(pid) && pid > 0 ? pid : undefined
}

/**
 * Acquires the single-writer lock for a Lattice data directory.
 *
 * A lock left behind by a dead process is reclaimed automatically. The returned release function
 * only removes a file that still contains this acquisition's token, so an old owner cannot delete
 * a lock obtained by a newer process.
 */
export async function acquireRuntimeLock(dataDir: string): Promise<RuntimeLock> {
  await mkdir(dataDir, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await chmod(dataDir, 0o700)
  const path = join(dataDir, 'runtime.lock')
  const token = `${process.pid} ${randomUUID()}\n`

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600)
      try {
        await handle.writeFile(token, 'utf8')
      } finally {
        await handle.close()
      }

      let released = false
      return {
        path,
        pid: process.pid,
        async release(): Promise<void> {
          if (released) return
          released = true
          try {
            if ((await readFile(path, 'utf8')) === token) await unlink(path)
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          }
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      let ownerPid: number | undefined
      try {
        ownerPid = parsePid(await readFile(path, 'utf8'))
      } catch (readError) {
        if ((readError as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw readError
      }
      // A corrupt or partially written lock cannot be proven stale. Leave it alone rather than
      // risking two writers; a caller can surface the path for manual recovery.
      if (ownerPid === undefined || isPidAlive(ownerPid)) throw new RuntimeLockError(path, ownerPid)
      try {
        await unlink(path)
      } catch (unlinkError) {
        if ((unlinkError as NodeJS.ErrnoException).code !== 'ENOENT') throw unlinkError
      }
    }
  }

  throw new RuntimeLockError(path)
}
