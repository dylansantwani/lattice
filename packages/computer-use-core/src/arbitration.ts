/**
 * Arbitration: the user plane has priority over the control plane.
 *
 * Rules (normative, from the amendment):
 *  - Any user-plane event (physical input, target focus change, geometry
 *    change, capture loss, permission change, helper crash) directed at or
 *    around the target revokes the session's live lease, invalidates the
 *    current generation, clears queued work, and parks the session in
 *    `user_has_control` (source_unavailable for capture/permission/helper
 *    loss).
 *  - Resume is never a replay: it grants nothing until a fresh observation is
 *    taken (handled by the controller; arbitration only enforces the parking
 *    and invalidation).
 */
import type { LeaseRevokeReason, SessionRecord } from './session.js'
import type { NativeUserEvent } from '@lattice/computer-use-protocol'
import { ACTIVE_STATES } from '@lattice/computer-use-protocol'
// (NativeUserEvent arrives via the package-root re-export of core.ts.)
import { transition } from './stateMachine.js'

export interface ArbitrationOutcome {
  /** Whether the event actually changed the session (idempotence). */
  changed: boolean
  /** State the session was parked in, if it was parked. */
  parkedIn?: SessionRecord['state']
  /** Generation after invalidation. */
  generation: number
}

function revokeLease(session: SessionRecord, reason: LeaseRevokeReason): void {
  if (session.lease !== null) {
    session.lease = null
    session.provenance.add('system', 'lease_revoked', reason)
  }
}

/**
 * Apply one user-plane event to a session. Called by the controller with the
 * session lock held. Only touches ACTIVE sessions; an already-ended session
 * ignores the event.
 */
export function applyUserEvent(session: SessionRecord, event: NativeUserEvent): ArbitrationOutcome {
  if (session.state === 'ended') {
    return { changed: false, generation: session.generation }
  }
  if (!ACTIVE_STATES.has(session.state) && session.state !== 'stale' && session.state !== 'source_unavailable') {
    return { changed: false, generation: session.generation }
  }

  const detail = `${event.kind}${event.detail ? ` ${JSON.stringify(event.detail)}` : ''}`

  switch (event.kind) {
    case 'user_input':
    case 'target_focus_changed':
    case 'target_geometry_changed': {
      // Revoke the lease, invalidate the generation (subsequent actions at the
      // old generation are stale), park the session.
      revokeLease(session, event.kind)
      if (session.state !== 'user_has_control') {
        session.state = transition(session.state, 'user_has_control', event.kind)
      }
      session.generation += 1 // invalidate every outstanding generation
      session.provenance.add('user', 'intervention', detail)
      return { changed: true, parkedIn: 'user_has_control', generation: session.generation }
    }
    case 'capture_lost':
    case 'target_ended':
    case 'permission_changed':
    case 'helper_crash': {
      revokeLease(session, event.kind)
      session.state = transition(session.state, 'source_unavailable', event.kind)
      session.generation += 1
      session.provenance.add('system', 'source_unavailable', detail)
      return { changed: true, parkedIn: 'source_unavailable', generation: session.generation }
    }
  }
}

/** Pause: revoke the lease, park at a safe boundary. Idempotent. */
export function pauseSession(session: SessionRecord): SessionRecord['state'] {
  if (session.state === 'ended') return 'ended'
  revokeLease(session, 'ManualPause')
  if (session.state === 'user_has_control') return 'user_has_control'
  session.state = transition(session.state, 'paused', 'manual pause')
  session.provenance.add('system', 'paused', 'client requested pause')
  return session.state
}
