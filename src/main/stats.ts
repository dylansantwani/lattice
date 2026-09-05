/**
 * Main-process usage-statistics service.
 *
 * Gathers the raw material from the store (per-turn telemetry rows, tool-call events, failed turns),
 * the cached model catalog and the user's cost overrides, and folds them into one {@link StatsSnapshot}
 * via the shared aggregator. The snapshot backs both the in-app Usage page (over IPC) and the macOS
 * menu-bar widget: while the app is open we mirror the snapshot to `<userData>/stats.json` on a
 * throttled cadence, so LatticeBar can render Lattice's usage without the app exposing a port.
 *
 * Model pricing is read from the on-disk model cache only — never a live fetch — so recomputing the
 * snapshot on a timer can't turn into provider API traffic.
 */
import { app } from 'electron'
import { writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import type { ModelInfo } from '@shared/types'
import {
  buildStatsSnapshot,
  localZoneAbbrev,
  type StatsSnapshot,
  type StatsUsageInput
} from '@shared/statsSnapshot'
import * as store from './store/eventStore'

/** Path LatticeBar reads. Kept beside the DB dir, at the userData root, so it's easy to point at. */
export function statsFilePath(): string {
  return join(app.getPath('userData'), 'stats.json')
}

/** Every model Lattice knows about right now, from the on-disk cache (no network). */
function cachedModels(): ModelInfo[] {
  const providers = store.getSettings().providers
  const out: ModelInfo[] = []
  for (const p of providers) {
    const cached = store.getCachedModels(p.id)
    if (cached) out.push(...cached.models)
  }
  return out
}

/** Compute a fresh snapshot from the current store state. */
export function computeSnapshot(appOpen = true): StatsSnapshot {
  const usage: StatsUsageInput[] = store.listUsageRows().map((r) => ({
    threadId: r.threadId,
    threadTitle: r.threadTitle,
    model: r.model,
    createdAt: r.createdAt,
    telemetry: r.telemetry
  }))
  return buildStatsSnapshot({
    usage,
    tools: store.listToolEventStats(),
    failures: store.listFailedTurns(),
    models: cachedModels(),
    overrides: store.getSettings().costOverrides,
    tz: localZoneAbbrev(),
    appOpen
  })
}

// The `generatedAt`/`tz` fields change every tick, so change-detection compares the payload with
// those volatile fields stripped — an idle app then rewrites nothing to disk.
function stableJson(snap: StatsSnapshot): string {
  return JSON.stringify({ ...snap, generatedAt: 0 })
}

let lastStable = ''

/** Atomically write the snapshot to `stats.json` (temp file + rename, so a reader never sees a
 * half-written document). Best-effort: persistence here is a convenience, never load-bearing.
 * Returns true when it actually wrote (the content changed since last time or `force`). */
export function writeSnapshotFile(appOpen = true, force = false): boolean {
  try {
    const snap = computeSnapshot(appOpen)
    const stable = stableJson(snap)
    if (!force && stable === lastStable) return false
    lastStable = stable
    const path = statsFilePath()
    const tmp = `${path}.tmp`
    writeFileSync(tmp, JSON.stringify(snap))
    renameSync(tmp, path)
    return true
  } catch {
    /* disk full / permissions — the in-app page still works over IPC */
    return false
  }
}

let timer: ReturnType<typeof setInterval> | null = null

/**
 * Start mirroring the snapshot to disk: once now, then every `intervalMs`, writing only when the
 * usage actually changed since the last write. Call {@link stopStatsWriter} on quit to flush a
 * final snapshot marked `appOpen: false` (so LatticeBar can show the widget went "Off").
 */
export function startStatsWriter(intervalMs = 20_000): void {
  if (timer) return
  writeSnapshotFile(true, true)
  timer = setInterval(() => writeSnapshotFile(true), intervalMs)
  timer.unref?.()
}

/** Stop the writer and flush a final snapshot marked `appOpen: false`. */
export function stopStatsWriter(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  writeSnapshotFile(false, true)
}
