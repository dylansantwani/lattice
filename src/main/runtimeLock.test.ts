import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { acquireRuntimeLock, RuntimeLockError } from './runtimeLock'

const directories: string[] = []

function dataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lattice-runtime-lock-'))
  directories.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('acquireRuntimeLock', () => {
  it('exclusively acquires and releases the data-directory lock', async () => {
    const dir = dataDir()
    const lock = await acquireRuntimeLock(dir)
    await expect(acquireRuntimeLock(dir)).rejects.toMatchObject({
      name: 'RuntimeLockError',
      ownerPid: process.pid
    })
    await lock.release()
    expect(existsSync(join(dir, 'runtime.lock'))).toBe(false)
  })

  it('reclaims a stale PID lock', async () => {
    const dir = dataDir()
    const path = join(dir, 'runtime.lock')
    writeFileSync(path, '99999999 abandoned-token\n', { mode: 0o600 })
    const lock = await acquireRuntimeLock(dir)
    expect(lock.pid).toBe(process.pid)
    await lock.release()
  })

  it('does not reclaim a lock whose ownership cannot be established', async () => {
    const dir = dataDir()
    writeFileSync(join(dir, 'runtime.lock'), 'not-a-pid\n', { mode: 0o600 })
    await expect(acquireRuntimeLock(dir)).rejects.toBeInstanceOf(RuntimeLockError)
  })

  it('does not let an old lock release a replacement lock', async () => {
    const dir = dataDir()
    const lock = await acquireRuntimeLock(dir)
    writeFileSync(lock.path, `${process.pid} replacement-token\n`, { mode: 0o600 })
    await lock.release()
    expect(existsSync(lock.path)).toBe(true)
  })
})
