/**
 * Cooperative state machine (amendment §"Cooperative state machine and UX"):
 *
 *   idle → observing → proposing
 *                       ├─ needs permission → observing
 *                       ├─ needs focus      → user decision
 *                       └─ executing → verifying → observing
 *   Any active state ── user event ──→ user_has_control (→ paused)
 *   Any active state ── stale/source unavailable ──→ recoverable stop
 *   Any active state ── Stop ──→ ended
 *
 * The machine rejects illegal transitions loudly — the controller routes all
 * mutation through here so there is exactly one definition of "allowed".
 */
import type { SessionState } from '@lattice/computer-use-protocol'

export interface Transition {
  from: SessionState
  to: SessionState
  reason?: string
}

/** Allowed edges. Anything not listed throws IllegalTransitionError. */
const EDGES: ReadonlyMap<SessionState, ReadonlySet<SessionState>> = new Map([
  ['idle', new Set<SessionState>(['observing', 'ended'])],
  [
    'observing',
    new Set<SessionState>(['proposing', 'executing', 'paused', 'user_has_control', 'stale', 'source_unavailable', 'ended'])
  ],
  [
    'proposing',
    new Set<SessionState>(['needs_permission', 'needs_focus', 'executing', 'observing', 'paused', 'user_has_control', 'ended'])
  ],
  [
    'needs_permission',
    new Set<SessionState>(['observing', 'executing', 'paused', 'user_has_control', 'ended'])
  ],
  [
    'needs_focus',
    new Set<SessionState>(['observing', 'executing', 'paused', 'user_has_control', 'ended'])
  ],
  [
    'executing',
    new Set<SessionState>(['verifying', 'observing', 'paused', 'user_has_control', 'source_unavailable', 'ended'])
  ],
  [
    'verifying',
    new Set<SessionState>(['observing', 'executing', 'paused', 'user_has_control', 'ended'])
  ],
  // user_has_control is the "user is driving" holding state; only an explicit
  // resume moves back, spawning a fresh observation.
  [
    'user_has_control',
    new Set<SessionState>(['observing', 'paused', 'ended'])
  ],
  [
    'paused',
    new Set<SessionState>(['observing', 'user_has_control', 'ended'])
  ],
  // stale/source_unavailable are recoverable stop states: a fresh observation
  // or an operator retry moves the session back to observing.
  [
    'stale',
    new Set<SessionState>(['observing', 'paused', 'ended'])
  ],
  [
    'source_unavailable',
    new Set<SessionState>(['observing', 'ended'])
  ],
  ['ended', new Set<SessionState>([])]
])

export class IllegalTransitionError extends Error {
  override name = 'IllegalTransitionError'
  constructor(from: SessionState, to: SessionState) {
    super(`Illegal session-state transition: ${from} → ${to}`)
  }
}

export function canTransition(from: SessionState, to: SessionState): boolean {
  if (from === to) return true // no-op transitions are always legal
  return EDGES.get(from)?.has(to) ?? false
}

/**
 * Assert and return the new state. Throws IllegalTransitionError if the edge
 * does not exist — silent state drift is how arbitration bugs hide, so the
 * machine is strict even though the controller only asks for legal moves.
 */
export function transition(from: SessionState, to: SessionState, reason?: string): SessionState {
  if (from === to) return from
  if (!canTransition(from, to)) {
    throw new IllegalTransitionError(from, to)
  }
  void reason // callers may attach context; the log lives in provenance
  return to
}
