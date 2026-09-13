import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ app: { getPath: () => mkdtempSync(join(tmpdir(), 'lattice-bridge-dedupe-')) } }))

import { dedupeExportable, duplicateScore } from './bridge'
import type { MemoryItem } from '@shared/types'

const mem = (id: string, content: string): MemoryItem =>
  ({
    id,
    scope: 'workspace',
    scopeId: 'ws',
    type: 'reference',
    content,
    author: 'model',
    confidence: 0.7,
    sensitivity: 'normal',
    createdAt: 1,
    updatedAt: 1,
    useCount: 0,
  }) as unknown as MemoryItem

describe('duplicateScore', () => {
  it('scores restatements of one fact high', () => {
    const a = 'goldrush runs on Proxmox LXC container CT 148 at 10.0.0.155 and sweeps every 2 hours'
    const b = 'The goldrush agent runs in the Proxmox container CT 148 (10.0.0.155), sweeping every 2 hours'
    expect(duplicateScore(a, b)).toBeGreaterThanOrEqual(0.5)
  })

  it('keeps unrelated facts apart even when they share a topic word', () => {
    const a = 'The user runs local LLMs on an RTX 5080 with 16GB VRAM as GGUF quants'
    const b = 'Printables and Cults3D return 403 Just a moment to non-browser sessions'
    expect(duplicateScore(a, b)).toBeLessThan(0.3)
  })
})

describe('dedupeExportable', () => {
  it('collapses four restatements of one fact into a single exported memory', () => {
    const out = dedupeExportable([
      mem('01A', 'goldrush runs on Proxmox LXC container CT 148 and sweeps Amazon niches every 2 hours'),
      mem('01B', 'goldrush runs on the Proxmox LXC container CT 148, sweeping Amazon niches every 2 hours'),
      mem('01C', 'goldrush sweeps Amazon niches every 2 hours on Proxmox LXC container CT 148'),
      mem('01D', 'goldrush on Proxmox container CT 148 sweeps Amazon niches every 2 hours, dashboards on 8081'),
    ])
    expect(out.kept).toHaveLength(1)
    expect(out.dropped).toHaveLength(3)
  })

  it('keeps the longest restatement as the survivor', () => {
    const short = 'the quokka cron runs every 15 minutes'
    const long = 'the quokka cron runs every 15 minutes on the build host, and writes its log to /var/log/quokka.log'
    const out = dedupeExportable([mem('01A', short), mem('01B', long)])
    expect(out.kept[0]!.content).toBe(long)
    expect(out.dropped[0]!.content).toBe(short)
  })

  it('keeps distinct facts', () => {
    const out = dedupeExportable([
      mem('01A', 'the user runs local LLMs on an RTX 5080 with 16GB of VRAM'),
      mem('01B', 'LMDesign is a pnpm monorepo at /Users/dylan/LMDesign with an Electron desktop app'),
      mem('01C', 'Printables and Cults3D return 403 to non-browser sessions, so STL links cannot be verified'),
    ])
    expect(out.kept).toHaveLength(3)
    expect(out.dropped).toHaveLength(0)
  })
})
