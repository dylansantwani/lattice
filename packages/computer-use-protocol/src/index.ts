/**
 * @lattice/computer-use-protocol — canonical wire contracts for the Lattice
 * Computer Use system. The JSON files in `schema/` are the cross-language
 * source of truth (TypeScript + Swift may generate/validate from them); the
 * types here are the hand-maintained TS mirror. This package contains NO
 * policy logic, NO OS calls, and NO model/provider code.
 */

export const PROTOCOL_VERSION = '1.0' as const
export type ProtocolVersion = typeof PROTOCOL_VERSION

// ---------------------------------------------------------------------------
// session.schema.json
// ---------------------------------------------------------------------------

export type SessionState =
  | 'idle'
  | 'observing'
  | 'proposing'
  | 'needs_permission'
  | 'needs_focus'
  | 'executing'
  | 'verifying'
  | 'user_has_control'
  | 'paused'
  | 'stale'
  | 'source_unavailable'
  | 'ended'

export type Mode = 'background_assist' | 'shared_control' | 'takeover'

export interface TargetRef {
  appId: string
  windowId?: string | null
}

export interface ActionLease {
  leaseId: string
  actionId: string
  generation: number
  target: TargetRef
  mode: Mode
  grantedAt: string
  expiresAt: string
}

export interface ProvenanceRecord {
  at: string
  source: 'user' | 'agent' | 'system' | 'policy'
  kind: string
  detail?: string
}

export interface ComputerUseSession {
  sessionId: string
  protocol: ProtocolVersion
  state: SessionState
  mode: Mode
  target: TargetRef
  generation: number
  createdAt: string
  updatedAt?: string
  lease?: ActionLease | null
  lastProvenance?: ProvenanceRecord | null
}

// ---------------------------------------------------------------------------
// app-state.schema.json
// ---------------------------------------------------------------------------

export interface AppInfo {
  id: string
  displayName?: string
  isRunning?: boolean
}

export interface Frame {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowInfo {
  id: string
  title?: string
  bounds?: Frame
}

export interface Screenshot {
  mimeType: 'image/png'
  width: number
  height: number
  dataBase64: string
}

export interface AxNode {
  index: number
  role: string
  title?: string
  value?: string
  actions?: string[]
  frame?: Frame
  children?: AxNode[]
}

export interface AxTree {
  generation: number
  root: AxNode
}

export interface AppState {
  app: AppInfo
  window: WindowInfo | null
  focus: 'foreground' | 'background'
  screenshot: Screenshot | null
  axTree: AxTree | null
  text: string
  generation: number
  capturedAt: string
}

// ---------------------------------------------------------------------------
// action.schema.json
// ---------------------------------------------------------------------------

export interface ClickAction {
  type: 'click'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}
export interface ClickElementAction {
  type: 'click_element'
  elementIndex: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
}
export interface DragAction {
  type: 'drag'
  fromX: number
  fromY: number
  toX: number
  toY: number
}
export interface TypeTextAction {
  type: 'type_text'
  text: string
}
export interface PressKeyAction {
  type: 'press_key'
  key: string
}
export interface ScrollAction {
  type: 'scroll'
  direction: 'up' | 'down' | 'left' | 'right'
  pages?: number
  x?: number
  y?: number
}
export interface SetValueAction {
  type: 'set_value'
  elementIndex: number
  value: string
}
export interface PasteAction {
  type: 'paste'
  text: string
  format: 'text' | 'md' | 'html'
}
export interface SelectTextAction {
  type: 'select_text'
  elementIndex: number
  text?: string
  prefix?: string
  suffix?: string
  selectionType?: 'selection' | 'cursor_before' | 'cursor_after'
}
export interface SecondaryActionAction {
  type: 'secondary_action'
  elementIndex: number
  action: string
}
export interface WaitAction {
  type: 'wait'
  ms: number
}

export type Action =
  | ClickAction
  | ClickElementAction
  | DragAction
  | TypeTextAction
  | PressKeyAction
  | ScrollAction
  | SetValueAction
  | PasteAction
  | SelectTextAction
  | SecondaryActionAction
  | WaitAction

export const ACTION_TYPES: readonly string[] = [
  'click',
  'click_element',
  'drag',
  'type_text',
  'press_key',
  'scroll',
  'set_value',
  'paste',
  'select_text',
  'secondary_action',
  'wait'
]

/**
 * Action-level capability metadata (mirrored into the MCP tool descriptions so
 * model capability discovery is honest). `focusable` = true means the action
 * only has an effect when the target window is focused; in background_assist
 * the policy layer answers needs_focus instead of escalating.
 */
export const ACTION_METADATA: Record<
  string,
  { semantic: boolean; focusable: boolean; description: string }
> = {
  click: { semantic: false, focusable: true, description: 'Physical pointer click at window-relative coordinates. Requires foreground focus outside takeover mode.' },
  click_element: { semantic: true, focusable: false, description: 'Accessibility-press of a target element. Can run without focus in background_assist.' },
  drag: { semantic: false, focusable: true, description: 'Physical pointer drag. Requires foreground focus outside takeover mode.' },
  type_text: { semantic: false, focusable: true, description: 'Injects typed text into the focused text field. Requires foreground focus outside takeover mode.' },
  press_key: { semantic: false, focusable: true, description: 'Injects a key press. Requires foreground focus outside takeover mode.' },
  scroll: { semantic: false, focusable: true, description: 'Scrolls the target window. Requires foreground focus outside takeover mode.' },
  set_value: { semantic: true, focusable: false, description: 'Sets an AX value directly (fields, sliders). Can run without focus in background_assist.' },
  paste: { semantic: true, focusable: false, description: 'Pastes text through the AX value path without global clipboard or key injection.' },
  select_text: { semantic: true, focusable: false, description: 'Selects text via the accessibility tree. Can run without focus in background_assist.' },
  secondary_action: { semantic: true, focusable: false, description: 'Runs a named AX action (e.g. AXRaise, AXConfirm, AXShowMenu) on a target element.' },
  wait: { semantic: true, focusable: false, description: 'Pauses the action loop for N ms (settle policy). No native side effect.' }
}

/** The action's focus requirement given a mode. takeover allows everything; background_assist allows only semantic (non-focusable) actions. */
export function requiresFocus(action: { type: string }, mode: Mode): boolean {
  if (mode === 'takeover') return false
  const meta = ACTION_METADATA[action.type]
  return meta ? meta.focusable : true // unknown action types fail closed: assume focus required
}

export interface ActionRequest {
  sessionId: string
  /** The generation the caller based its decision on. Mismatch -> stale. */
  generation: number
  action: Action
  /** Optional re-assertion of target identity; mismatch -> target_mismatch. */
  expectedTarget?: { appId?: string; windowId?: string | null }
}

export type ActionFailureStatus =
  | 'stale'
  | 'busy'
  | 'lease_conflict'
  | 'target_mismatch'
  | 'out_of_policy'
  | 'needs_focus'
  | 'permission_required'
  | 'user_intervened'
  | 'source_unavailable'
  | 'cancelled'

export interface ActionOkResult {
  status: 'ok'
  /** Fresh observation AFTER the action (same shape as computer_get_app_state output). */
  observation: AppState
  lease?: ActionLease
  provenance?: ProvenanceRecord[]
}

export interface ActionFailResult {
  status: Extract<ActionFailureStatus, string>
  reason: string
  detail?: Record<string, unknown>
}

export type ActionResult = ActionOkResult | ActionFailResult

// ---------------------------------------------------------------------------
// event.schema.json
// ---------------------------------------------------------------------------

export type CoreEventKind =
  | 'session_started'
  | 'session_ended'
  | 'observation'
  | 'proposal'
  | 'lease_granted'
  | 'lease_revoked'
  | 'action_started'
  | 'action_completed'
  | 'action_failed'
  | 'user_intervention'
  | 'paused'
  | 'resumed'
  | 'focus_requested'
  | 'permission_required'
  | 'stale_detected'
  | 'source_unavailable'
  | 'cancelled'
  | 'error'

export interface CoreEvent {
  seq: number
  at: string
  sessionId: string
  kind: CoreEventKind
  payload: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// error.schema.json
// ---------------------------------------------------------------------------

export type CUErrorCode =
  | 'unknown_session'
  | 'unknown_target'
  | 'stale_generation'
  | 'lease_conflict'
  | 'target_mismatch'
  | 'out_of_policy'
  | 'permission_required'
  | 'focus_required'
  | 'source_unavailable'
  | 'session_busy'
  | 'cancelled'
  | 'version_unsupported'
  | 'internal'

export interface CUError {
  code: CUErrorCode
  message: string
  /** true = re-observe and the same call can succeed; false = the call must change. */
  recoverable: boolean
  detail?: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Tool surface (MCP façade + in-process Lattice adapter share this list)
// ---------------------------------------------------------------------------

export const TOOL_NAMES = [
  'computer_list_apps',
  'computer_start_session',
  'computer_get_app_state',
  'computer_execute_action',
  'computer_pause',
  'computer_resume',
  'computer_focus',
  'computer_stop',
  'computer_health'
] as const

export type ToolName = (typeof TOOL_NAMES)[number]

export const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
  computer_list_apps: 'List applications the native helper can target (canonical bundle ids). Read-only.',
  computer_start_session: 'Start a cooperative session scoped to one app (and optionally one window). mode defaults to background_assist; takeover is explicit-only and never an automatic fallback.',
  computer_get_app_state: 'Capture the target app/window: screenshot + accessibility tree + flattened text. Returns the session generation — always execute actions against the generation you just observed.',
  computer_execute_action: 'Execute one semantic action under an action lease at the observed generation. Stale generations, revoked leases, changed targets, and out-of-policy actions are rejected with no side effect. On success the result carries a fresh observation.',
  computer_pause: 'Revoke the current lease and clear queued work. Requires a fresh observation before the next action (resume).',
  computer_resume: 'Resume a paused session: grants nothing until a fresh observation is taken; the next action re-observes automatically if no generation is supplied.',
  computer_focus: 'Explicitly bring the target window to the foreground. The only path that may focus the target; the PiP image and PiP body must never trigger focus.',
  computer_stop: 'End the session: tear down the lease, stop capture, and release the target. Safe to call any time.',
  computer_health: 'Report server and native-backend status, protocol version, backend kind, and session counts.'
}

// ---------------------------------------------------------------------------
// Mode policy constants (normative per the cooperative amendment)
// ---------------------------------------------------------------------------

export const MODE_POLICY = {
  background_assist: {
    mayMovePhysicalPointer: false,
    mayInjectGlobalKeys: false,
    mayActivateFocus: false,
    default: true,
    description: 'Default mode. Capture the approved app/window only; prefer AX actions that do not activate the target; virtual cursor in PiP only. Actions needing foreground focus return needs_focus — never escalate silently.'
  },
  shared_control: {
    mayMovePhysicalPointer: true,
    mayInjectGlobalKeys: true,
    mayActivateFocus: true,
    default: false,
    description: 'User and agent may touch the same target. User input always wins: any user event revokes the lease and pauses at the next safe boundary; Resume re-observes and never replays.'
  },
  takeover: {
    mayMovePhysicalPointer: true,
    mayInjectGlobalKeys: true,
    mayActivateFocus: true,
    default: false,
    description: 'Explicit opt-in for workflows requiring foreground CGEvent input. Requires an always-visible Stop. NEVER an automatic fallback from background_assist.'
  }
} as const

export type ModePolicyKey = keyof typeof MODE_POLICY

// ---------------------------------------------------------------------------
// Session lifecycle helpers used across packages
// ---------------------------------------------------------------------------

/** States in which the session can take a new action (before lease granting). */
export const ACTIONABLE_STATES: ReadonlySet<SessionState> = new Set([
  'observing',
  'proposing',
  'verifying'
])

/** States that count as "active" for user-intervention purposes. */
export const ACTIVE_STATES: ReadonlySet<SessionState> = new Set([
  'observing',
  'proposing',
  'needs_permission',
  'needs_focus',
  'executing',
  'verifying',
  'paused'
])

export function isTerminalState(state: SessionState): boolean {
  return state === 'ended'
}

// Core façade + native-backend boundary types (Controller, NativeBackend,
// NativeUserEvent, ...). Additive re-export so dependents can import the
// whole contract from the package root.
export * from './core.js'
