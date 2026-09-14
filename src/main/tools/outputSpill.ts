import { mkdir, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomUUID } from 'node:crypto'

/**
 * Where oversized tool output is spilled when it has to be truncated for the model. The truncation
 * marker names the exact file, so the model can page through the remainder with fs_read or grep it —
 * the cut is recoverable instead of a dead end. The permission broker's containment check treats
 * this directory as readable even though it sits outside the workspace roots (see runManager),
 * because everything in it is output the model's own tool calls already produced.
 */
export function spillDir(): string {
  return join(tmpdir(), 'lattice-spill')
}

/** Spill files older than this are pruned opportunistically on the next spill. */
export const SPILL_MAX_AGE_MS = 24 * 60 * 60 * 1000

/** Delete spill files past {@link SPILL_MAX_AGE_MS}. Exported for tests. */
export async function pruneStaleSpills(dir = spillDir(), now = Date.now()): Promise<void> {
  const cutoff = now - SPILL_MAX_AGE_MS
  for (const name of await readdir(dir)) {
    const path = join(dir, name)
    try {
      if ((await stat(path)).mtimeMs < cutoff) await unlink(path)
    } catch {
      // Already gone (a concurrent prune or manual cleanup) — nothing to do.
    }
  }
}

/** Write `text` to a fresh spill file and return its absolute path. */
export async function spillOutput(text: string, label = 'shell'): Promise<string> {
  const dir = spillDir()
  await mkdir(dir, { recursive: true })
  void pruneStaleSpills(dir).catch(() => {})
  const path = join(dir, `${label}-${randomUUID().slice(0, 8)}.txt`)
  await writeFile(path, text, 'utf8')
  return path
}
