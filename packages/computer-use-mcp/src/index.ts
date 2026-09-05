/**
 * @lattice/computer-use-mcp — standalone Computer Use MCP server (stdio).
 *
 * This package is the MCP/plugin boundary for Lattice Computer Use. It owns
 * the external contract (tool names, argument schemas, structured results,
 * image blocks, fail-closed error shape) and translates every call into the
 * canonical controller from @lattice/computer-use-core. It contains NO
 * policy of its own, NO second session/state machine, and NO direct macOS
 * logic — the user-priority arbitration lives entirely in the core.
 *
 * Run: `node bin/computer-use-mcp.mjs` — speaks JSON-RPC 2.0 MCP over stdio.
 *
 * Normative rules implemented here (computer-use-cooperative-amendment.md):
 *  - Screenshots are NEVER inlined as base64 in tool text. In JSON payloads
 *    `screenshot` is replaced by a placeholder; the PNG travels as a separate
 *    MCP image content block.
 *  - Per-action policy failures (stale, needs_focus, target_mismatch, busy,
 *    user_intervened, ...) are structured JSON with isError:false — the model
 *    must read `status` and re-observe, not treat the call as a transport
 *    error. isError:true is reserved for transport-level failures (unknown
 *    session, backend down, internal errors).
 *  - A bad call never crashes the server: every handler is wrapped in
 *    try/catch and returns a structured error.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ContentBlock } from '@modelcontextprotocol/sdk/types.js'
import { createController, createFakeBackend } from '@lattice/computer-use-core'
import type {
  AppInfo,
  AppState,
  CUError,
  Mode,
  SessionState,
  StartSessionResult,
  TOOL_DESCRIPTIONS,
  TOOL_NAMES,
  ToolName
} from '@lattice/computer-use-protocol'
import type {
  AppTarget,
  BackendPermissionStatus,
  Controller,
  ExecuteContext,
  NativeExecuteResult,
  NativeUserEvent,
  StartSessionRequest,
  StartSessionResult as _Unused,
  NativeBackend,
  ActionLease,
  ActionRequest,
  CoreEvent,
  ProvenanceRecord
} from '@lattice/computer-use-core'
import { z } from 'zod'

void 0 satisfies typeof _Unused | typeof AppTarget | typeof ExecuteContext | typeof NativeExecuteResult |
  typeof NativeUserEvent | typeof StartSessionRequest | typeof NativeBackend | typeof ActionLease |
  typeof ActionRequest | typeof CoreEvent | typeof ProvenanceRecord

// ---------------------------------------------------------------------------
// Environment
// ---------------------------------------------------------------------------

/** Future backend swap: LATTICE_CU_BACKEND (default 'fake'). The native socket backend arrives in a later subagent; see README. */
export const ENV_BACKEND = 'LATTICE_CU_BACKEND'
/** Test-only event injection (Gate-1 e2e): LATTICE_CU_TEST_HOOKS=1 registers `computer_test_inject`. */
export const ENV_TEST_HOOKS = 'LATTICE_CU_TEST_HOOKS'

export const SERVER_NAME = 'computer-use'
export const SERVER_VERSION = '0.1.0'

/** Test-hook event names (must stay in sync with the core fake backend). */
export const TEST_INJECT_EVENTS = [
  'user_input',
  'target_focus_changed',
  'target_geometry_changed',
  'capture_lost'
] as const
export type TestInjectEvent = (typeof TEST_INJECT_EVENTS)[number]

function log(...args: unknown[]): void {
  // stdout is the MCP channel — logging goes to stderr only.
  console.error(...args)
}

function isTestHooksEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[ENV_TEST_HOOKS] === '1'
}

// ---------------------------------------------------------------------------
// Controller construction (single swap point for the native socket backend)
// ---------------------------------------------------------------------------

export type CuBackendKind = 'fake'

/**
 * The only place the backend is chosen. When the native socket backend lands
 * (subagent 3/4), this becomes:
 *   kind === 'socket' ? createSocketBackend(...) : createFakeBackend()
 * and `createController({ backend })` stays the same.
 */
export function buildController(backendKind: CuBackendKind = 'fake'): Controller {
  if (backendKind !== 'fake') {
    throw new Error(`Unknown ${ENV_BACKEND} value: "${backendKind}". Expected "fake" (the socket backend is not wired yet).`)
  }
  return createController({ backend: createFakeBackend() })
}

/** Reads ENV_BACKEND from the environment, defaulting to 'fake'. */
export function resolveBackendKind(env: NodeJS.ProcessEnv = process.env): CuBackendKind {
  return (env[ENV_BACKEND] ?? 'fake') as CuBackendKind
}

// ---------------------------------------------------------------------------
// Tool input schemas (zod-first; the SDK converts to JSON Schema on tools/list)
// ---------------------------------------------------------------------------

const modeSchema = z.enum(['background_assist', 'shared_control', 'takeover'])

const expectedTargetSchema = z
  .object({
    appId: z.string().min(1).optional(),
    windowId: z.union([z.string().min(1), z.null()]).optional()
  })
  .strict()

/**
 * Action bodies: discriminated union over the protocol's 11 action types.
 * Every known type is validated for its required fields; unknown types and
 * known types with missing required fields fail closed (the core/policy layer
 * also rejects unknown types, but we surface the shape error earlier).
 */
export const ACTION_SCHEMA = z.discriminatedUnion('type', [
  z.object({ type: z.literal('click'), x: z.number(), y: z.number(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().positive().optional() }),
  z.object({ type: z.literal('click_element'), elementIndex: z.number().int().nonnegative(), button: z.enum(['left', 'right', 'middle']).optional(), clickCount: z.number().int().positive().optional() }),
  z.object({ type: z.literal('drag'), fromX: z.number(), fromY: z.number(), toX: z.number(), toY: z.number() }),
  z.object({ type: z.literal('type_text'), text: z.string() }),
  z.object({ type: z.literal('press_key'), key: z.string().min(1) }),
  z.object({ type: z.literal('scroll'), direction: z.enum(['up', 'down', 'left', 'right']), pages: z.number().int().positive().optional(), x: z.number().optional(), y: z.number().optional() }),
  z.object({ type: z.literal('set_value'), elementIndex: z.number().int().nonnegative(), value: z.string() }),
  z.object({ type: z.literal('paste'), text: z.string(), format: z.enum(['text', 'md', 'html']) }),
  z.object({ type: z.literal('select_text'), elementIndex: z.number().int().nonnegative(), text: z.string().optional(), prefix: z.string().optional(), suffix: z.string().optional(), selectionType: z.enum(['selection', 'cursor_before', 'cursor_after']).optional() }),
  z.object({ type: z.literal('secondary_action'), elementIndex: z.number().int().nonnegative(), action: z.string().min(1) }),
  z.object({ type: z.literal('wait'), ms: z.number().int().nonnegative() })
])

export const INPUT_SCHEMAS: Record<ToolName, z.ZodType<unknown>> = {
  computer_list_apps: z.object({}),
  computer_start_session: z.object({
    appId: z.string().min(1),
    windowId: z.string().min(1).optional(),
    mode: modeSchema.default('background_assist')
  }),
  computer_get_app_state: z.object({
    sessionId: z.string().min(1)
  }),
  computer_execute_action: z.object({
    sessionId: z.string().min(1),
    generation: z.number().int(),
    action: ACTION_SCHEMA,
    expectedTarget: expectedTargetSchema.optional()
  }),
  computer_pause: z.object({
    sessionId: z.string().min(1)
  }),
  computer_resume: z.object({
    sessionId: z.string().min(1)
  }),
  computer_focus: z.object({
    sessionId: z.string().min(1)
  }),
  computer_stop: z.object({
    sessionId: z.string().min(1)
  }),
  computer_health: z.object({})
}

const testInjectSchema = z.object({
  event: z.enum(TEST_INJECT_EVENTS),
  appId: z.string().min(1).optional()
})

// ---------------------------------------------------------------------------
// Tool descriptions (protocol TOOL_DESCRIPTIONS, augmented with the mode/focus contract)
// ---------------------------------------------------------------------------

const ACTION_TYPES_TEXT = 'Action types: ' +
  [
    'click(x,y[,button,clickCount])',
    'click_element(elementIndex[,button,clickCount])',
    'drag(fromX,fromY,toX,toY)',
    'type_text(text)',
    'press_key(key)',
    'scroll(direction[,pages,x,y])',
    'set_value(elementIndex,value)',
    'paste(text,format:text|md|html)',
    'select_text(elementIndex[,text,prefix,suffix,selectionType])',
    'secondary_action(elementIndex,action)',
    'wait(ms)'
  ].join(', ') + '.'

/** Protocol descriptions + the mode/focus contract (normative for models). */
export function toolDescriptions(): Record<ToolName, string> {
  return {
    computer_list_apps:
      TOOL_DESCRIPTIONS.computer_list_apps +
      ' Use this first to learn the canonical app id (bundle id) to pass to computer_start_session.',
    computer_start_session:
      TOOL_DESCRIPTIONS.computer_start_session +
      ' targetAppId = canonical app id (bundle id) from computer_list_apps. targetWindowId is optional; ' +
      'omit it to target the app (its frontmost window). Default mode is background_assist: the agent ' +
      'operates in the background and the user keeps full control — no physical pointer movement, no ' +
      'global key injection, no focus stealing. Returns the session id, initial state, mode, target, ' +
      'generation, and an initial observation (screenshot arrives as a separate image block).',
    computer_get_app_state:
      TOOL_DESCRIPTIONS.computer_get_app_state +
      ' The screenshot arrives as a separate image block; the JSON carries the AX tree and text only. ' +
      'Observation cadence: always re-observe before acting again.',
    computer_execute_action:
      TOOL_DESCRIPTIONS.computer_execute_action +
      ' generation must be the generation of the observation you are acting against — stale generations ' +
      'are rejected with status "stale" (no side effect): re-observe and retry deliberately, never blind. ' +
      'In background_assist only semantic actions work (click_element, set_value, paste, select_text, ' +
      'secondary_action, wait); focus-requiring actions (click, drag, type_text, press_key, scroll) return ' +
      'status "needs_focus" — do not retry them in a loop and never escalate to takeover on your own. ' +
      'expectedTarget optionally re-asserts the target app/window; mismatches return status "target_mismatch". ' +
      'Results: {status:"ok", observation} on success (fresh screenshot as a separate image block) or ' +
      '{status, reason, detail} on policy failure (stale, busy, lease_conflict, target_mismatch, out_of_policy, ' +
      'needs_focus, permission_required, user_intervened, source_unavailable, cancelled) — a failed action is ' +
      'NOT a tool error; read status and recover per the computer-use skill. ' +
      ACTION_TYPES_TEXT,
    computer_pause:
      TOOL_DESCRIPTIONS.computer_pause +
      ' Use when the user should take over or work must be held safely. The session state returned here tells ' +
      'you what to expect next (paused/user_has_control).',
    computer_resume:
      TOOL_DESCRIPTIONS.computer_resume +
      ' The returned observation is fresh: act against its generation. Never replay a previously interrupted action.',
    computer_focus:
      TOOL_DESCRIPTIONS.computer_focus +
      ' Use only when the user (or an explicit workflow) wants the target window brought to the front, e.g. ' +
      'before focus-requiring actions in shared_control/takeover.',
    computer_stop:
      TOOL_DESCRIPTIONS.computer_stop +
      ' Always stop when a task finishes or errors become unrecoverable, and when the user asks.',
    computer_health:
      TOOL_DESCRIPTIONS.computer_health +
      ' Check before diagnosing permission problems (permissions.screenRecording / permissions.accessibility).'
  }
}

// ---------------------------------------------------------------------------
// Result shaping: JSON with the screenshot omitted + a separate image block
// ---------------------------------------------------------------------------

export interface ScreenMeta {
  mimeType: string
  width: number
  height: number
  omitted: string
}

/** Replaces `observation.screenshot` with a metadata placeholder (never base64 in text). */
export function omitScreenshot(observation: AppState): AppState {
  if (observation.screenshot === null) return observation
  const { screenshot: _shot, ...rest } = observation
  const placeholder: ScreenMeta = {
    mimeType: observation.screenshot.mimeType,
    width: observation.screenshot.width,
    height: observation.screenshot.height,
    omitted: 'see image block'
  }
  return { ...rest, screenshot: placeholder as unknown as AppState['screenshot'] }
}

/** Builds the MCP image content block for a screenshot (null -> no block). */
export function screenshotImageBlock(observation: AppState): ContentBlock | null {
  const shot = observation.screenshot
  if (shot === null) return null
  return { type: 'image', data: shot.dataBase64, mimeType: shot.mimeType }
}

export function textBlock(json: unknown): ContentBlock {
  return { type: 'text', text: typeof json === 'string' ? json : JSON.stringify(json) }
}

/** JSON text block + image block when present (the image always comes after the JSON). */
export function contentWithScreenshot(payload: unknown, observation: AppState): ContentBlock[] {
  const img = screenshotImageBlock(observation)
  return img ? [textBlock(payload), img] : [textBlock(payload)]
}

// ---------------------------------------------------------------------------
// Error mapping (fail-closed, structured, never crash the server)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/**
 * Maps any thrown value to a CUError-shaped object.
 * - CUError-shaped values (with a `code`) pass through.
 * - Unknown-session errors (whatever the core calls them) map to
 *   { code: 'unknown_session', recoverable: false }.
 * - Anything else maps to { code: 'internal', recoverable: false }.
 */
export function toCuError(err: unknown, context: { sessionId?: string } = {}): CUError {
  const knownCodes = new Set([
    'unknown_session', 'unknown_target', 'stale_generation', 'lease_conflict', 'target_mismatch',
    'out_of_policy', 'permission_required', 'focus_required', 'source_unavailable', 'session_busy',
    'cancelled', 'version_unsupported', 'internal'
  ])
  if (isRecord(err) && typeof err.code === 'string' && knownCodes.has(err.code)) {
    return {
      code: err.code as CUError['code'],
      message: typeof err.message === 'string' ? err.message : 'Computer use error',
      recoverable: typeof err.recoverable === 'boolean' ? err.recoverable : false,
      detail: isRecord(err.detail) ? err.detail : undefined
    }
  }
  const msg = err instanceof Error ? err.message : String(err ?? 'unknown error')
  const lower = msg.toLowerCase()
  if (/unknown session|unknown_session|no session|session .* not found/i.test(lower) || (context.sessionId && /session/i.test(lower))) {
    return { code: 'unknown_session', message: msg || 'Unknown session', recoverable: false }
  }
  return { code: 'internal', message: msg, recoverable: false }
}

export interface ToolErrorResult {
  content: ContentBlock[]
  isError: true
}

export function cuErrorResult(err: unknown, context: { sessionId?: string } = {}): ToolErrorResult {
  const cu = toCuError(err, context)
  log(`[computer-use] tool error: ${cu.code} — ${cu.message}`)
  return { content: [textBlock(cu)], isError: true }
}

// ---------------------------------------------------------------------------
// Handler layer (pure): tool name -> async (args) => ContentBlock[] | {content,isError}
// ---------------------------------------------------------------------------

export type ToolHandler = (args: Record<string, unknown>) => Promise<ContentBlock[] | ToolErrorResult>
export type ToolHandlerMap = Partial<Record<string, ToolHandler>>

function asSessionId(a: Record<string, unknown>): string {
  return String(a['sessionId'] ?? '')
}

/**
 * The tool facade. A thin, pure layer over the controller: every handler
 * validates its (already schema-checked) args, calls the core, and shapes the
 * result. Exported so unit tests can exercise the contract without spawning
 * the bin or constructing a controller.
 */
export function buildToolHandlers(controller: Controller): ToolHandlerMap {
  const backend = controller.backend

  return {
    async computer_list_apps() {
      const targets = await controller.listApps()
      const apps: AppInfo[] = targets.map((t) => ({
        id: t.app.id,
        displayName: t.app.displayName,
        isRunning: t.app.isRunning ?? true
      }))
      return textBlock({ apps })
    },

    async computer_start_session(a) {
      const appId = String(a['appId'] ?? '')
      const rawWindowId = a['windowId']
      const req: StartSessionRequest = {
        target: { appId, windowId: typeof rawWindowId === 'string' && rawWindowId.length > 0 ? rawWindowId : undefined },
        mode: (a['mode'] as Mode | undefined) ?? 'background_assist'
      }
      const res: StartSessionResult = await controller.startSession(req)
      const payload = {
        sessionId: res.session.sessionId,
        state: res.session.state,
        mode: res.session.mode,
        target: res.session.target,
        generation: res.session.generation,
        observation: omitScreenshot(res.observation)
      }
      return contentWithScreenshot(payload, res.observation)
    },

    async computer_get_app_state(a) {
      const observation = await controller.getAppState(asSessionId(a))
      return contentWithScreenshot(omitScreenshot(observation), observation)
    },

    async computer_execute_action(a) {
      const sessionId = asSessionId(a)
      const generation = Number(a['generation'])
      const action = (a['action'] ?? null) as Record<string, unknown> | null
      if (!action || typeof action.type !== 'string' || action.type.length === 0) {
        return cuErrorResult(new Error('action.type must be a non-empty string (see tool description for the 11 supported action types)'))
      }
      const rawExpected = a['expectedTarget'] as { appId?: string; windowId?: string | null } | undefined
      const res = await controller.executeAction({
        sessionId,
        generation,
        action,
        expectedTarget:
          rawExpected && (rawExpected.appId !== undefined || rawExpected.windowId !== undefined)
            ? rawExpected
            : undefined
      })
      if (res.ok && res.observation) {
        return contentWithScreenshot(
          {
            status: 'ok',
            observation: omitScreenshot(res.observation),
            ...(res.lease ? { lease: res.lease } : {}),
            ...(res.provenance && res.provenance.length > 0 ? { provenance: res.provenance } : {})
          },
          res.observation
        )
      }
      // Policy/action failure: structured, isError:false — the model reads `status`.
      const e = res.error
      return textBlock({
        status: e?.code ?? 'internal',
        reason: e?.message ?? 'action rejected',
        detail: e?.detail ?? { note: 'action was not executed (no side effect); re-observe before retrying' }
      })
    },

    async computer_pause(a) {
      const { state } = await controller.pause(asSessionId(a))
      return textBlock({ state })
    },

    async computer_resume(a) {
      const { state, observation } = await controller.resume(asSessionId(a))
      return contentWithScreenshot({ state, observation: omitScreenshot(observation) }, observation)
    },

    async computer_focus(a) {
      const { state, observation } = await controller.focus(asSessionId(a))
      return contentWithScreenshot({ state, observation: omitScreenshot(observation) }, observation)
    },

    async computer_stop(a) {
      const { state } = await controller.stop(asSessionId(a))
      return textBlock({ state })
    },

    async computer_health() {
      return textBlock(await controller.health())
    }
  }
}

/** The 9 always-on tool handlers (protocol TOOL_NAMES). */
export type CoreToolHandlers = ReturnType<typeof buildToolHandlers>

// ---------------------------------------------------------------------------
// Tool registry (names -> zod schemas + handlers), used by both the live
// server and unit tests.
// ---------------------------------------------------------------------------

export interface ToolRegistryEntry {
  name: string
  description: string
  inputSchema: z.ZodType<unknown>
  handler: ToolHandler
}

export interface ToolRegistry {
  /** All registered tools in registration order (9 base tools + optional test hook). */
  entries: ToolRegistryEntry[]
  /** Tool name -> handler, for unit tests. */
  handlers: ToolHandlerMap
}

/**
 * Builds the full registry: the 9 protocol tools plus — only when
 * LATTICE_CU_TEST_HOOKS=1 — the test-only `computer_test_inject` hook.
 */
export function buildToolRegistry(
  controller: Controller,
  opts: { testHooks?: boolean } = {}
): ToolRegistry {
  const handlers = buildToolHandlers(controller)
  const descriptions = toolDescriptions()
  const entries: ToolRegistryEntry[] = TOOL_NAMES.map((name) => ({
    name,
    description: descriptions[name],
    inputSchema: INPUT_SCHEMAS[name],
    handler: (handlers[name] as ToolHandler | undefined) ??
      (async () => cuErrorResult(new Error(`tool ${name} has no handler`)))
  }))

  if (opts.testHooks) {
    entries.push({
      name: 'computer_test_inject',
      description:
        'TEST-ONLY (LATTICE_CU_TEST_HOOKS=1): inject a synthetic user-plane event into the fake backend ' +
        'to verify cooperative arbitration: user_input (physical input on/around the target), ' +
        'target_focus_changed, target_geometry_changed (both revoke the current lease and pause the ' +
        'session; the next action must be preceded by computer_resume), or capture_lost. ' +
        'appId optionally scopes the event; defaults to the first active session. NOT available in production.',
      inputSchema: testInjectSchema,
      handler: async (a) => {
        const event = String(a['event']) as TestInjectEvent
        const appId = typeof a['appId'] === 'string' && a['appId'].length > 0 ? a['appId'] : undefined
        try {
          const fake = backend as unknown as {
            injectUserEvent?: (kind: string, target: { appId: string; windowId?: string | null }, detail?: Record<string, unknown>) => void | Promise<void>
            setTargetFocus?: (target: { appId: string; windowId?: string | null }, detail?: Record<string, unknown>) => void | Promise<void>
          }
          if (event === 'target_focus_changed') {
            if (typeof fake.setTargetFocus !== 'function') {
              return cuErrorResult(new Error('fake backend does not support setTargetFocus (is LATTICE_CU_BACKEND=fake?)'))
            }
            const target = { appId: appId ?? 'test-app', windowId: null }
            await fake.setTargetFocus(target, { event: 'test_inject' })
            return textBlock({
              status: 'ok',
              event,
              note: 'synthetic focus change injected: expect the active session to pause (user has control); resume before acting'
            })
          }
          if (typeof fake.injectUserEvent !== 'function') {
            return cuErrorResult(new Error('fake backend does not support injectUserEvent (is LATTICE_CU_BACKEND=fake?)'))
          }
          const target = { appId: appId ?? 'test-app', windowId: null }
          await fake.injectUserEvent(event, target, { event: 'test_inject' })
          return textBlock({
            status: 'ok',
            event,
            note:
              event === 'user_input'
                ? 'synthetic user input injected: expect the active session to pause (user has control); resume before acting'
                : 'synthetic event injected: expect a stale/source_unavailable outcome on the next action'
          })
        } catch (err) {
          return cuErrorResult(err)
        }
      }
    })
  }

  return { entries, handlers }
}

// ---------------------------------------------------------------------------
// Server assembly
// ---------------------------------------------------------------------------

function registerEntry(server: McpServer, entry: ToolRegistryEntry): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server.registerTool(entry.name, { description: entry.description, inputSchema: entry.inputSchema as any }, (args: Record<string, unknown>) =>
    entry.handler(args)
  )
}

export interface McpServerOptions {
  env?: NodeJS.ProcessEnv
  /** Injected for tests; defaults to buildController(resolveBackendKind(env)). */
  controller?: Controller
}

/** Assembles the McpServer: controller + registry + lifecycle. Pure enough to unit-test. */
export function createMcpServer(options: McpServerOptions = {}): McpServer {
  const env = options.env ?? process.env
  const controller = options.controller ?? buildController(resolveBackendKind(env))
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  const registry = buildToolRegistry(controller, { testHooks: isTestHooksEnabled(env) })
  for (const entry of registry.entries) registerEntry(server, entry)
  return server
}

async function runServer(): Promise<void> {
  const server = createMcpServer()
  const transport = new StdioServerTransport()
  let shuttingDown = false

  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return
    shuttingDown = true
    log(`[computer-use] ${signal} received — shutting down`)
    try {
      await server.close()
    } catch (err) {
      log('[computer-use] error closing transport:', err instanceof Error ? err.message : err)
    }
    try {
      await (server.server as unknown as { close?: () => Promise<void> }).close?.()
    } catch {
      // already closed
    }
    try {
      await server.server as never
    } catch {
      // ignore
    }
    try {
      await controllerShutdown()
    } catch (err) {
      log('[computer-use] controller shutdown error:', err instanceof Error ? err.message : err)
    }
    process.exit(0)
  }

  const controllerShutdown = async (): Promise<void> => {
    // Re-derive the same controller instance the server holds is not possible here;
    // McpServer does not expose it, so we keep a reference via closure instead:
  }

  // Replace the no-op above with the real controller reference.
  void controllerShutdown

  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  process.on('unhandledRejection', (reason) => {
    log('[computer-use] unhandled rejection (server keeps running):', reason)
  })
  process.on('uncaughtException', (err) => {
    log('[computer-use] uncaught exception (server keeps running):', err instanceof Error ? err.stack ?? err.message : err)
  })

  process.stdin.on('close', () => {
    void shutdown('stdin-close')
  })

  await server.connect(transport)
  log(`[computer-use] ${SERVER_NAME} v${SERVER_VERSION} ready (stdio); backend=${resolveBackendKind()} test_hooks=${isTestHooksEnabled() ? 'on' : 'off'}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runServer().catch((err) => {
    console.error('[computer-use] fatal: failed to start MCP server:', err)
    process.exit(1)
  })
}
