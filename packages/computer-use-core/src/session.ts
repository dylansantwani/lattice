/**
 * Session identity and lifecycle. A session is scoped to exactly one
 * (appId, optional windowId) target and carries the observation generation
 * counter, the current action lease, the cooperative state, and provenance.
 */
import type {
  ActionLease,
  AppState,
  Mode,
  SessionState,
  TargetRef
} from '@lattice/computer-use-protocol'
import { randomUUID } from 'node:crypto'
import { ProvenanceLog } from './provenance.js'

/** Why a lease was revoked (used in provenance and diagnostics). */
export type LeaseRevokeReason =
  | 'user_input'
  | 'target_focus_changed'
  | 'target_geometry_changed'
  | 'capture_lost'
  | 'target_ended'
  | 'permission_changed'
  | 'helper_crash'
  | 'ManualPause'
  | 'Superseded'

export interface SessionRecord {
  readonly sessionId: string
  readonly createdAt: string
  readonly target: TargetRef
  readonly mode: Mode
  state: SessionState
  /** Monotonic observation generation; actions must match this exactly. */
  generation: number
  lease: ActionLease | null
  /** True while a backend execute call is in flight. */
  executing: boolean
  lastObservation: AppState | null
  readonly provenance: ProvenanceLog
}

export class SessionManager {
  private readonly sessions = new Map<string, SessionRecord>()

  create(target: TargetRef, mode: Mode): SessionRecord {
    const session: SessionRecord = {
      sessionId: randomUUID(),
      createdAt: new Date().toISOString(),
      target: { appId: target.appId, windowId: target.windowId ?? null },
      mode,
      state: 'idle',
      generation: 0,
      lease: null,
      executing: false,
      lastObservation: null,
      provenance: new ProvenanceLog()
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  get(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId)
  }

  remove(sessionId: string): boolean {
    return this.sessions.delete(sessionId)
  }

  count(): number {
    return this.sessions.size
  }

  /** All live sessions scoped to a given app (used by arbitration). */
  forApp(appId: string): SessionRecord[] {
    const out: SessionRecord[] = []
    for (const s of this.sessions.values()) {
      if (s.target.appId === appId) out.push(s)
    }
    return out
  }
}
