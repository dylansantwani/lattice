/**
 * Provenance: every action and interruption records its source
 * (`user` | `agent` | `system` | `policy`). The log is append-only per session
 * and the tail is attached to action results so callers can audit why the
 * session is in its current state.
 */
import type { ProvenanceRecord } from '@lattice/computer-use-protocol'

export type ProvenanceSource = ProvenanceRecord['source']

export class ProvenanceLog {
  private records: ProvenanceRecord[] = []

  add(source: ProvenanceSource, kind: string, detail?: string): ProvenanceRecord {
    const record: ProvenanceRecord = {
      at: new Date().toISOString(),
      source,
      kind,
      ...(detail !== undefined ? { detail } : {})
    }
    this.records.push(record)
    return record
  }

  /** The most recent `limit` records (oldest first). */
  list(limit = 20): ProvenanceRecord[] {
    if (this.records.length <= limit) return [...this.records]
    return this.records.slice(this.records.length - limit)
  }

  clear(): void {
    this.records.length = 0
  }
}
