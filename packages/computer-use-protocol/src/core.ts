/**
 * @lattice/computer-use-protocol — core/controller interface.
 *
 * `ComputerUseController` is the single façade both control lanes use:
 * the standalone MCP server (subagent 2) and the in-process Lattice adapter.
 * `NativeBackend` is the process boundary to the signed macOS helper
 * (subagent 3/4); `fakeNative` (computer-use-core) is the deterministic
 * in-memory implementation every test path runs before live macOS.
 */
import type {
  Action,
  ActionLease,
  AppState,
  AppInfo,
  CoreEvent,
  CUError,
  Mode,
  ProvenanceRecord,
  SessionState,
  TargetRef,
  WindowInfo
} from './index.js'

// ---------------------------------------------------------------------------
// Native backend (the only thing that may touch the OS)
// ---------------------------------------------------------------------------

export interface AppTarget {
  app: AppInfo
  windows: WindowInfo[]
}

export interface ExecuteContext {
  lease: ActionLease
  target: TargetRef
  generation: number
  /** The last known observation, so backends can map element indices without re-walking. */
  lastObservation: AppState | null
}

export type NativeExecuteStatus =
  | 'ok'
  | 'focus_required'
  | 'permission_required'
  | 'source_unavailable'
  | 'cancelled'

export interface NativeExecuteResult {
  status: NativeExecuteStatus
  reason?: string
}

export interface BackendPermissionStatus {
  screenRecording: 'granted' | 'not_granted' | 'unknown'
  accessibility: 'granted' | 'not_granted' | 'unknown'
}

export interface NativeBackend {
  /** 'fake' (deterministic in-memory), 'socket' (signed helper), ... */
  readonly kind: string
  readonly ready: Promise<void>
  listApps(): Promise<AppTarget[]>
  /** Capture target-scoped state; throws CUError-compatible Error with a `cuCode` when unavailable. */
  observe(target: TargetRef, generation: number): Promise<AppState>
  execute(action: Action, ctx: ExecuteContext): Promise<NativeExecuteResult>
  /** Explicit focus of the target window (computer_focus / takeover path). */
  focusWindow(target: TargetRef): Promise<void>
  /**
   * Stream of user-plane events: physical input on/around the target,
   * focus changes, geometry changes, capture loss, permission changes.
   * The core converts these into lease revocations — the backend never
   * decides policy.
   */
  events(): AsyncIterable<NativeUserEvent>
  permissionStatus(): Promise<BackendPermissionStatus>
  shutdown(): Promise<void>
}

export type NativeUserEventKind =
  | 'user_input'
  | 'target_focus_changed'
  | 'target_geometry_changed'
  | 'target_ended'
  | 'capture_lost'
  | 'permission_changed'
  | 'helper_crash'

export interface NativeUserEvent {
  kind: NativeUserEventKind
  at: string
  target: TargetRef
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Core controller (session + arbitration + policy; no OS calls)
// ---------------------------------------------------------------------------

export interface StartSessionRequest {
  target: TargetRef
  mode?: Mode
  protocol?: string
}

export interface StartSessionResult {
  session: {
    sessionId: string
    state: SessionState
    mode: Mode
    target: TargetRef
    generation: number
  }
  observation: AppState
}

export interface ActionResultFull {
  ok: boolean
  /** Present on success: the fresh post-action observation. */
  observation?: AppState
  /** Present on success: the lease that was consumed. */
  lease?: ActionLease
  provenance?: ProvenanceRecord[]
  /** Present on failure: structured, machine-readable. */
  error?: CUError
}

export interface Controller {
  readonly backend: NativeBackend
  readonly version: string
  listApps(): Promise<AppTarget[]>
  startSession(req: StartSessionRequest): Promise<StartSessionResult>
  getSession(sessionId: string): {
    sessionId: string
    state: SessionState
    mode: Mode
    target: TargetRef
    generation: number
    lease: ActionLease | null
  } | null
  /** Active session count (for health). */
  sessionCount(): number
  getAppState(sessionId: string): Promise<AppState>
  executeAction(req: {
    sessionId: string
    generation: number
    action: Action
    expectedTarget?: { appId?: string; windowId?: string | null }
  }): Promise<ActionResultFull>
  pause(sessionId: string): Promise<{ state: SessionState }>
  resume(sessionId: string): Promise<{ state: SessionState; observation: AppState }>
  focus(sessionId: string): Promise<{ state: SessionState; observation: AppState }>
  stop(sessionId: string): Promise<{ state: SessionState }>
  /** Subscribe to canonical core events. Unsubscribe returned. */
  onEvent(listener: (e: CoreEvent) => void): () => void
  health(): Promise<{
    backend: string
    ready: boolean
    protocol: string
    sessions: number
    permissions: BackendPermissionStatus
  }>
  shutdown(): Promise<void>
}
