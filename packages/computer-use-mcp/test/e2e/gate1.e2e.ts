/**
 * Gate-1 — fake end-to-end loop (black-box MCP over stdio).
 *
 * Spawns the COMPILED server (`node bin/computer-use-mcp.mjs`) with
 * LATTICE_CU_TEST_HOOKS='1' and drives it with a real MCP SDK client
 * (@modelcontextprotocol/sdk Client + StdioClientTransport). No imports of
 * core/server source: this suite speaks only the frozen external contract.
 *
 * Acceptance criteria (docs/computer-use-cooperative-amendment.md,
 * "Co-use acceptance tests"; plan "Gate 1 — fake end-to-end loop"):
 *   - a fake MCP server can start a session,
 *   - return an image (MCP image content block; base64 stays out of the text),
 *   - execute an action (fresh observation per action),
 *   - pause on a simulated user event (user input wins; the pre-intervention
 *     generation becomes stale and has NO side effect),
 *   - reject a stale action,
 *   - resume with a FRESH observation (never replays the interrupted action),
 *   - stop cleanly (then unknown_session; server still healthy),
 *   - background_assist needs_focus is a structured outcome, NOT escalation
 *     (session mode unchanged, no observation/image).
 *
 * Documented compatibility helpers (the task brief allows ONE for the
 * observation; a symmetric one locates session fields):
 *   - extractObservation(): accepts the fresh AppState observation either as
 *     `{ observation: AppState }` or as a top-level AppState-shaped object
 *     (`app`/`axTree`/`generation` present).
 *   - sessionFields(): the server may carry session fields (sessionId, state,
 *     mode, generation) at the top level of the JSON payload or nested under a
 *     `session` object; this merges both (top level wins) so each field is
 *     asserted strictly against whichever location the server chose.
 * Everything else is asserted against the frozen contract exactly.
 */
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const pkgDir = dirname(dirname(fileURLToPath(import.meta.url)))
const BIN = join(pkgDir, 'bin', 'computer-use-mcp.mjs')
const HOOKS_ENV = { LATTICE_CU_TEST_HOOKS: '1' }

// ---------------------------------------------------------------------------
// MCP SDK import: try ESM subpath imports first (they resolve from the mcp
// package's node_modules symlink up to the repo root); fall back to
// createRequire anchored inside the mcp package.
// ---------------------------------------------------------------------------

type AnyObj = Record<string, unknown>

type CallResult = {
  /** The first text content block parsed as JSON (null when absent/not JSON). */
  json: AnyObj | null
  /** The full raw MCP result (content blocks, isError, ...). */
  raw: { content: Array<AnyObj>; isError?: boolean; [k: string]: unknown }
}

type ClientLike = {
  connect(t: unknown): Promise<void>
  close(): Promise<void>
  listTools(): Promise<{ tools: Array<{ name: string }> }>
  callTool(args: { name: string; arguments?: Record<string, unknown> }): Promise<{
    content: Array<AnyObj>
    isError?: boolean
    [k: string]: unknown
  }>
}

type TransportLike = { stderr: NodeJS.ReadableStream | null; [k: string]: unknown }

async function loadMcpSdk(): Promise<{
  Client: new (clientInfo: AnyObj, serverInfo: AnyObj) => ClientLike
  StdioClientTransport: new (o: Record<string, unknown>) => TransportLike
}> {
  // 1) Plain subpath imports (works when the SDK is hoisted or aliased).
  try {
    const [clientMod, stdioMod] = await Promise.all([
      import('@modelcontextprotocol/sdk/client'),
      import('@modelcontextprotocol/sdk/client/stdio'),
    ])
    if ((clientMod as AnyObj).Client && (stdioMod as AnyObj).StdioClientTransport) {
      return { Client: (clientMod as AnyObj).Client as never, StdioClientTransport: (stdioMod as AnyObj).StdioClientTransport as never }
    }
  } catch {
    /* fall through */
  }
  // 2) Resolve the real SDK location from the mcp package's node_modules and
  //    import the ESM entry points by absolute path. (The SDK's `./*` wildcard
  //    export does not add the missing file extension, so bare `.../client/stdio`
  //    is unresolvable in a bare node/vitest ESM context; `.../client` IS a
  //    declared subpath, so require.resolve gives us an anchor.)
  const req = createRequire(join(pkgDir, 'index.js'))
  const clientCjsPath = req.resolve('@modelcontextprotocol/sdk/client')
  const esmClientPath = clientCjsPath.replace(/dist\/cjs\/client\/index\.js$/, 'dist/esm/client/index.js')
  const esmStdioPath = clientCjsPath.replace(/dist\/cjs\/client\/index\.js$/, 'dist/esm/client/stdio.js')
  try {
    const [clientMod, stdioMod] = await Promise.all([import(esmClientPath), import(esmStdioPath)])
    if ((clientMod as AnyObj).Client && (stdioMod as AnyObj).StdioClientTransport) {
      return { Client: (clientMod as AnyObj).Client as never, StdioClientTransport: (stdioMod as AnyObj).StdioClientTransport as never }
    }
  } catch {
    /* fall through */
  }
  // 3) CommonJS fallback.
  const clientMod = req('@modelcontextprotocol/sdk/client') as AnyObj
  const stdioCjsPath = clientCjsPath.replace(/client\/index\.js$/, 'client/stdio.js')
  const stdioMod = req(stdioCjsPath) as AnyObj
  if (clientMod.Client && stdioMod.StdioClientTransport) {
    return { Client: clientMod.Client as never, StdioClientTransport: stdioMod.StdioClientTransport as never }
  }
  throw new Error('Could not load @modelcontextprotocol/sdk client (tried ESM subpath imports, resolved ESM paths, and createRequire from the mcp package).')
}

// ---------------------------------------------------------------------------
// Result helpers
// ---------------------------------------------------------------------------

function firstTextBlock(content: Array<AnyObj>): string | null {
  const block = content.find((b) => b && b.type === 'text' && typeof b.text === 'string')
  return block ? (block.text as string) : null
}

function parseCall(result: { content: Array<AnyObj>; isError?: boolean; [k: string]: unknown }): CallResult {
  const text = firstTextBlock(result.content)
  let json: AnyObj | null = null
  if (text !== null) {
    try {
      const v: unknown = JSON.parse(text)
      if (v !== null && typeof v === 'object' && !Array.isArray(v)) json = v as AnyObj
    } catch {
      json = null
    }
  }
  return { json, raw: result as CallResult['raw'] }
}

/** Documented compatibility helper (see file header). */
function extractObservation(json: AnyObj | null): AnyObj | null {
  if (!json) return null
  const nested = json.observation
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    const n = nested as AnyObj
    if ('axTree' in n || 'app' in n || 'generation' in n) return n
  }
  if ('axTree' in json || ('app' in json && 'generation' in json)) return json
  return null
}

/** Documented symmetric helper (see file header). */
function sessionFields(json: AnyObj | null): AnyObj {
  if (!json) return {}
  const nested = json.session
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return { ...(nested as AnyObj), ...json }
  }
  return json
}

/** Value of the Calculator Display AX node (pre-order index 1) in an observation. */
function displayValue(json: AnyObj | null): string {
  const obs = extractObservation(json) ?? json
  if (!obs) return '(no observation)'
  const axTree = obs.axTree as { root?: { children?: Array<AnyObj> } } | null | undefined
  const children = axTree?.root?.children
  if (!Array.isArray(children) || children.length === 0) return '(no axTree.root.children)'
  const display = children.find((n) => n.index === 1) ?? children[0]
  if (!display) return '(no display node)'
  return String(display.value ?? display.title ?? '(no value)')
}

/** True when a structured failure carries recoverable=true (top level or detail). */
function isRecoverable(json: AnyObj | null): boolean {
  if (!json) return false
  if (json.recoverable === true) return true
  const detail = json.detail
  return !!detail && typeof detail === 'object' && (detail as AnyObj).recoverable === true
}

/** The recoverable field (top level or detail), if present. */
function recoverableValue(json: AnyObj | null): boolean | undefined {
  if (!json) return undefined
  if (typeof json.recoverable === 'boolean') return json.recoverable
  const detail = json.detail
  if (detail && typeof detail === 'object' && typeof (detail as AnyObj).recoverable === 'boolean') {
    return (detail as AnyObj).recoverable as boolean
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Fixture: one spawned server for the whole suite (per the task brief:
// beforeAll starts the client, connects, listTools). Every test starts its own
// fresh session and stops it at the end — except tests 4 → 5 → 6, which share
// one session to exercise the pause → stale → resume → stop chain.
// ---------------------------------------------------------------------------

let client: ClientLike | null = null
let transport: TransportLike | null = null
let serverStderr = ''

function stopChildForced(): Promise<void> {
  const proc = (transport as AnyObj | null)?._process as import('node:child_process').ChildProcess | null | undefined
  if (!proc || proc.exitCode !== null) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const force = setTimeout(() => {
      try { proc.kill('SIGKILL') } catch { /* already dead */ }
    }, 3000)
    proc.once('exit', () => {
      clearTimeout(force)
      resolve()
    })
    try { proc.kill('SIGTERM') } catch { /* already dead */ }
  })
}

/** Records what the server actually reported (values land in the handoff report). */
const observed: Record<string, unknown> = {}

describe('Gate 1 — fake end-to-end loop (black-box MCP over stdio)', () => {
  beforeAll(async () => {
    serverStderr = ''
    const { Client, StdioClientTransport } = await loadMcpSdk()
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN],
      env: { ...process.env, ...HOOKS_ENV },
      stderr: 'pipe',
    }) as unknown as TransportLike
    const stderrStream = transport.stderr
    if (stderrStream) {
      stderrStream.setEncoding('utf8')
      stderrStream.on('data', (d: string) => {
        serverStderr += d
      })
    }
    client = new Client({ name: 'gate1-e2e', version: '0.0.0' }, transport as never)
    await client.connect(transport as never)

    const tools = await client.listTools()
    const names = tools.tools.map((t) => t.name)
    const required = [
      'computer_list_apps',
      'computer_start_session',
      'computer_get_app_state',
      'computer_execute_action',
      'computer_pause',
      'computer_resume',
      'computer_focus',
      'computer_stop',
      'computer_health',
    ]
    for (const name of required) {
      expect(names, `listTools must expose '${name}'; got tools: ${JSON.stringify(names)}`).toContain(name)
    }
    expect(names, `LATTICE_CU_TEST_HOOKS=1 must also expose computer_test_inject; got tools: ${JSON.stringify(names)}`).toContain('computer_test_inject')
  }, 60000)

  afterAll(async () => {
    try {
      if (client) await client.close()
    } catch {
      /* already closed */
    } finally {
      client = null
      await stopChildForced()
      transport = null
    }
  }, 60000)

  function callTool(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    if (!client) throw new Error('client not connected')
    return client
      .callTool({ name, arguments: args })
      .then((r) => parseCall(r as CallResult['raw']))
  }

  function startSession(extra: Record<string, unknown> = {}): Promise<CallResult> {
    return callTool('computer_start_session', { appId: 'com.apple.calculator', ...extra })
  }

  it('lists apps', async () => {
    const { json, raw } = await callTool('computer_list_apps')
    expect(json, `computer_list_apps returned non-JSON text: ${JSON.stringify(raw.content)}`).not.toBeNull()
    const apps = json!.apps ?? json!.applications ?? json!.list
    expect(Array.isArray(apps), `computer_list_apps must include an app list array; got: ${JSON.stringify(raw.content)}`).toBe(true)
    const calc = (apps as Array<AnyObj>).find((a) => a.id === 'com.apple.calculator')
    expect(
      calc,
      `computer_list_apps must include com.apple.calculator with its canonical id (not just a display name); got: ${JSON.stringify(apps)}`
    ).toBeTruthy()
  })

  it('full happy loop', async () => {
    const start = await startSession()
    const s = sessionFields(start.json)
    expect(start.json, `start_session returned non-JSON text: ${JSON.stringify(start.raw.content)}`).not.toBeNull()
    expect(typeof s.sessionId === 'string' && (s.sessionId as string).length > 0, `start_session must return a non-empty sessionId; got: ${JSON.stringify(start.json)}`).toBe(true)
    expect(s.state, `start_session must leave the session in 'observing'; got state=${String(s.state)} in ${JSON.stringify(start.json)}`).toBe('observing')
    expect(s.mode, `start_session without mode must default to 'background_assist'; got ${String(s.mode)} in ${JSON.stringify(start.json)}`).toBe('background_assist')
    expect(typeof s.generation === 'number' && (s.generation as number) >= 1, `start_session must return generation as a number >= 1; got: ${JSON.stringify(s)}`).toBe(true)
    const sessionId = s.sessionId as string

    // Screenshot arrives as an MCP image content block; base64 stays OUT of text.
    const imageBlock = start.raw.content.find((b) => b && b.type === 'image')
    expect(imageBlock, `start_session result must contain an MCP image content block; got: ${JSON.stringify(start.raw.content)}`).toBeTruthy()
    expect(imageBlock!.mimeType, `image block mimeType must be 'image/png'; got ${String(imageBlock!.mimeType)}`).toBe('image/png')
    expect(typeof imageBlock!.data === 'string' && (imageBlock!.data as string).length > 0, `image block must carry non-empty base64 data; got: ${JSON.stringify(imageBlock)}`).toBe(true)
    const textPayload = firstTextBlock(start.raw.content) ?? ''
    expect(textPayload, `screenshot base64 (${(imageBlock!.data as string).slice(0, 24)}...) must NOT be embedded in the tool text payload`).not.toContain(imageBlock!.data as string)

    // The JSON observation's screenshot is replaced by {omitted:'see image block'}.
    const startObs = extractObservation(start.json)
    expect(startObs, `start_session must include an AppState observation; got: ${JSON.stringify(start.json)}`).not.toBeNull()
    expect(
      (startObs!.screenshot as AnyObj | null)?.omitted,
      `observation.screenshot must be replaced by {omitted:'see image block'}; got: ${JSON.stringify(startObs!.screenshot)}`
    ).toBe('see image block')

    // get_app_state advances the generation.
    const state = await callTool('computer_get_app_state', { sessionId })
    const st = sessionFields(state.json)
    expect(state.json, `get_app_state returned non-JSON text: ${JSON.stringify(state.raw.content)}`).not.toBeNull()
    expect(typeof st.generation === 'number' && (st.generation as number) > (s.generation as number), `get_app_state must return a generation strictly greater than start_session's (${s.generation}); got: ${JSON.stringify(state.json)}`).toBe(true)

    // Calculator: 7 (index 2) → + (5) → 8 (3) → = (6). Each action runs at the
    // generation of the observation it was decided on. Display must end '15'.
    let gen = st.generation as number
    const press = async (elementIndex: number, label: string): Promise<AnyObj> => {
      const res = await callTool('computer_execute_action', {
        sessionId,
        generation: gen,
        action: { type: 'click_element', elementIndex },
      })
      expect(res.json, `execute_action(${label}) returned non-JSON text: ${JSON.stringify(res.raw.content)}`).not.toBeNull()
      expect(res.json!.status, `execute_action(${label}) must have status 'ok'; got: ${JSON.stringify(res.json)}`).toBe('ok')
      expect(res.raw.isError, `execute_action(${label}) 'ok' must NOT be an MCP error; raw=${JSON.stringify(res.raw)}`).toBeFalsy()
      const obs = extractObservation(res.json)
      expect(obs, `execute_action(${label}) 'ok' must carry a fresh observation; got: ${JSON.stringify(res.json)}`).not.toBeNull()
      expect(typeof obs!.generation === 'number' && (obs!.generation as number) >= 1, `execute_action(${label}) observation must carry a generation; got: ${JSON.stringify(obs)}`).toBe(true)
      gen = obs!.generation as number
      return obs!
    }

    await press(2, '7')
    const afterPlus = await press(5, '+')
    expect(displayValue(afterPlus), `after pressing '+', Display should show the pending expression (contains '+'); got '${displayValue(afterPlus)}'`).toContain('+')
    await press(3, '8')
    const final = await press(6, '=')
    expect(displayValue(final), `after 7 + 8 =, Display must be '15'; got '${displayValue(final)}'`).toBe('15')

    const stop = await callTool('computer_stop', { sessionId })
    expect(stop.raw.isError, `computer_stop must not error: ${JSON.stringify(stop.raw)}`).toBeFalsy()
  })

  it('needs_focus is not escalation', async () => {
    const start = await startSession()
    const s = sessionFields(start.json)
    expect(typeof s.sessionId === 'string' && (s.sessionId as string).length > 0, `start_session must return a non-empty sessionId; got: ${JSON.stringify(start.json)}`).toBe(true)
    const sessionId = s.sessionId as string
    expect(s.mode, `fresh session must be 'background_assist'; got ${String(s.mode)}`).toBe('background_assist')

    const res = await callTool('computer_execute_action', {
      sessionId,
      generation: s.generation,
      action: { type: 'click', x: 10, y: 10 },
    })
    expect(res.json, `execute_action returned non-JSON text: ${JSON.stringify(res.raw.content)}`).not.toBeNull()
    expect(res.raw.isError, `needs_focus must be a structured tool result, NOT an MCP error; got isError=${res.raw.isError} raw=${JSON.stringify(res.raw)}`).toBeFalsy()
    expect(res.json!.status, `background_assist coordinate click must yield status 'needs_focus' (no silent escalation); got: ${JSON.stringify(res.json)}`).toBe('needs_focus')
    expect(String(res.json!.reason ?? ''), `needs_focus reason must mention focus; got reason=${JSON.stringify(res.json!.reason)} in ${JSON.stringify(res.json)}`).toMatch(/focus/i)
    expect(extractObservation(res.json), `needs_focus payload must NOT carry an observation; got: ${JSON.stringify(res.json)}`).toBeNull()
    expect(
      res.raw.content.some((b) => b && b.type === 'image'),
      `needs_focus payload must NOT contain an MCP image block; got: ${JSON.stringify(res.raw.content)}`
    ).toBe(false)

    // The session did NOT change mode (no escalation).
    const state = await callTool('computer_get_app_state', { sessionId })
    const st = sessionFields(state.json)
    expect(state.json, `get_app_state after needs_focus returned non-JSON text: ${JSON.stringify(state.raw.content)}`).not.toBeNull()
    expect(st.mode, `needs_focus must NOT change the session mode; mode=${String(st.mode)} in ${JSON.stringify(state.json)}`).toBe('background_assist')

    await callTool('computer_stop', { sessionId })
  })

  it('user intervention pauses and invalidates', async () => {
    const start = await startSession({ mode: 'shared_control' })
    const s = sessionFields(start.json)
    expect(typeof s.sessionId === 'string' && (s.sessionId as string).length > 0, `start_session must return a non-empty sessionId; got: ${JSON.stringify(start.json)}`).toBe(true)
    const sessionId = s.sessionId as string
    expect(s.mode, `start_session(mode:'shared_control') must return mode shared_control; got ${String(s.mode)} in ${JSON.stringify(start.json)}`).toBe('shared_control')
    // Shared with the next two tests (resume, stop).
    interventionSession = sessionId

    const before = await callTool('computer_get_app_state', { sessionId })
    const beforeFields = sessionFields(before.json)
    const g = beforeFields.generation as number
    expect(before.json, `get_app_state returned non-JSON text: ${JSON.stringify(before.raw.content)}`).not.toBeNull()
    expect(typeof g === 'number' && g >= 1, `pre-injection generation must be a number >= 1; got: ${JSON.stringify(before.json)}`).toBe(true)
    const displayBefore = displayValue(before.json)

    const inj = await callTool('computer_test_inject', { event: 'user_input', appId: 'com.apple.calculator' })
    expect(inj.raw.isError, `computer_test_inject(user_input) must not be an MCP error; got: ${JSON.stringify(inj.raw)}`).toBeFalsy()

    const after = await callTool('computer_get_app_state', { sessionId })
    const afterFields = sessionFields(after.json)
    expect(after.json, `get_app_state (post-injection) returned non-JSON text: ${JSON.stringify(after.raw.content)}`).not.toBeNull()
    const st = String(afterFields.state)
    observed.userPlaneState = st
    expect(
      st === 'paused' || st === 'user_has_control',
      `after a user_input event the session must be 'paused' or 'user_has_control'; got state='${st}' in ${JSON.stringify(after.json)}`
    ).toBe(true)
    expect(
      typeof afterFields.generation === 'number' && (afterFields.generation as number) > g,
      `user intervention must invalidate the session generation (was ${g}); got ${JSON.stringify(afterFields.generation)} in ${JSON.stringify(after.json)}`
    ).toBe(true)

    // The OLD generation G is now stale — recoverable, no side effect.
    const stale = await callTool('computer_execute_action', {
      sessionId,
      generation: g,
      action: { type: 'click_element', elementIndex: 2 },
    })
    expect(stale.json, `execute_action(old generation) returned non-JSON text: ${JSON.stringify(stale.raw.content)}`).not.toBeNull()
    expect(stale.raw.isError, `a stale generation must be a structured (non-isError) failure; got isError=${stale.raw.isError} raw=${JSON.stringify(stale.raw)}`).toBeFalsy()
    expect(stale.json!.status, `execute_action with the pre-intervention generation must be status 'stale'; got: ${JSON.stringify(stale.json)}`).toBe('stale')
    expect(isRecoverable(stale.json), `a stale result must be recoverable (re-observe and retry); got: ${JSON.stringify(stale.json)}`).toBe(true)

    // No side effect: the Display is unchanged by the rejected action.
    const check = await callTool('computer_get_app_state', { sessionId })
    expect(check.json, `get_app_state (post-stale) returned non-JSON text: ${JSON.stringify(check.raw.content)}`).not.toBeNull()
    expect(
      displayValue(check.json),
      `the stale action must have NO side effect (Display was '${displayBefore}' before it); got '${displayValue(check.json)}'`
    ).toBe(displayBefore)

    // Record for the resume test's strict checks.
    observed.staleGeneration = g
    observed.staleDisplay = displayBefore
  })

  it('resume re-observes, never replays', async () => {
    expect(
      interventionSession,
      `previous test must have left a live shared_control session; got '${interventionSession}' (server stderr: ${serverStderr.slice(0, 500)})`
    ).toBeTruthy()
    const sessionId = interventionSession!
    const g = observed.staleGeneration as number
    expect(typeof g === 'number', `previous test must have recorded the pre-intervention generation; observed=${JSON.stringify(observed)}`).toBe(true)
    const displayWhenStale = observed.staleDisplay as string

    const resume = await callTool('computer_resume', { sessionId })
    expect(resume.json, `computer_resume returned non-JSON text: ${JSON.stringify(resume.raw.content)}`).not.toBeNull()
    expect(resume.raw.isError, `computer_resume must not be an MCP error; raw=${JSON.stringify(resume.raw)}`).toBeFalsy()
    const resumed = sessionFields(resume.json)
    expect(resumed.state, `resume must leave the session in 'observing'; got state=${String(resumed.state)} in ${JSON.stringify(resume.json)}`).toBe('observing')
    const obs = extractObservation(resume.json)
    expect(obs, `resume must return a FRESH observation (it re-observes); got: ${JSON.stringify(resume.json)}`).not.toBeNull()
    expect(
      typeof resumed.generation === 'number' && (resumed.generation as number) > g,
      `resume generation (${JSON.stringify(resumed.generation)}) must be strictly greater than the stale one (${g}); got: ${JSON.stringify(resume.json)}`
    ).toBe(true)

    // Resume must NOT replay the interrupted action: Display right after
    // resume is still what it was when the stale action was rejected.
    const displayAtResume = displayValue(resume.json)
    expect(
      displayAtResume,
      `resume must not replay the interrupted action (Display was '${displayWhenStale}' when the stale press was rejected); got '${displayAtResume}'`
    ).toBe(displayWhenStale)

    // The loop continues after a real user interruption: act at the NEW generation.
    const act = await callTool('computer_execute_action', {
      sessionId,
      generation: resumed.generation,
      action: { type: 'click_element', elementIndex: 2 },
    })
    expect(act.json, `post-resume execute_action returned non-JSON text: ${JSON.stringify(act.raw.content)}`).not.toBeNull()
    expect(act.json!.status, `post-resume action at the fresh generation must be 'ok' (the loop continues); got: ${JSON.stringify(act.json)}`).toBe('ok')
    const finalDisplay = displayValue(act.json)
    expect(finalDisplay, `post-resume '7' press must land (Display should end in '7'); got '${finalDisplay}'`).endsWith('7')
    if (displayWhenStale === '') {
      expect(finalDisplay, `with an empty pre-intervention Display, one fresh '7' press must show exactly '7' (no replay); got '${finalDisplay}'`).toBe('7')
    }
  })

  it('stop tears down', async () => {
    expect(
      interventionSession,
      `previous tests must have left a live shared_control session; got '${interventionSession}' (server stderr: ${serverStderr.slice(0, 500)})`
    ).toBeTruthy()
    const sessionId = interventionSession!

    const stop = await callTool('computer_stop', { sessionId })
    expect(stop.json, `computer_stop returned non-JSON text: ${JSON.stringify(stop.raw.content)}`).not.toBeNull()
    const st = String(sessionFields(stop.json).state)
    expect(st === 'ended', `computer_stop must end the session (state 'ended'); got: ${JSON.stringify(stop.json)}`).toBe(true)

    // Everything else on that session now fails with unknown_session (isError).
    const getState = await callTool('computer_get_app_state', { sessionId })
    expect(getState.raw.isError, `get_app_state after stop must be isError=true; got: ${JSON.stringify(getState.raw)}`).toBe(true)
    const stateCode = getState.json?.code ?? (getState.json?.error as AnyObj | undefined)?.code
    expect(stateCode, `get_app_state after stop must carry code 'unknown_session'; got: ${JSON.stringify(getState.raw)}`).toBe('unknown_session')

    const act = await callTool('computer_execute_action', {
      sessionId,
      generation: 1,
      action: { type: 'click_element', elementIndex: 2 },
    })
    expect(
      act.raw.isError === true || act.json?.status !== 'ok',
      `execute_action after stop must fail (isError or a structured non-ok failure); got: ${JSON.stringify(act.raw)}`
    ).toBe(true)
    expect(
      act.raw.isError === true,
      `execute_action after stop must be a transport-level unknown_session error (isError=true); got: ${JSON.stringify(act.raw)}`
    ).toBe(true)

    // Child still healthy: health works, and this server's session count dropped.
    const health = await callTool('computer_health')
    expect(health.json, `computer_health after stop returned non-JSON text: ${JSON.stringify(health.raw.content)}`).not.toBeNull()
    expect(health.json!.ready, `server must still be ready after a session stop; got: ${JSON.stringify(health.json)}`).toBe(true)
    expect(typeof health.json!.sessions === 'number', `health.sessions must be a number; got: ${JSON.stringify(health.json)}`).toBe(true)
    expect(
      (health.json!.sessions as number) === 0,
      `after stop, this server's session count must drop to 0 (every other test session was stopped); got: ${JSON.stringify(health.json)}`
    ).toBe(true)
  })

  it('health + protocol', async () => {
    const { json, raw } = await callTool('computer_health')
    expect(json, `computer_health returned non-JSON text: ${JSON.stringify(raw.content)}`).not.toBeNull()
    expect(json!.backend, `health.backend must be 'fake' on the deterministic backend; got: ${JSON.stringify(json)}`).toBe('fake')
    expect(json!.protocol, `health.protocol must be '1.0'; got: ${JSON.stringify(json)}`).toBe('1.0')
    expect(json!.ready, `health.ready must be true; got: ${JSON.stringify(json)}`).toBe(true)
    expect(typeof json!.sessions === 'number', `health.sessions must be a number; got: ${JSON.stringify(json)}`).toBe(true)
  })

  it('stale generation is rejected BEFORE side effects', async () => {
    const start = await startSession()
    const s = sessionFields(start.json)
    expect(typeof s.sessionId === 'string' && (s.sessionId as string).length > 0, `start_session must return a non-empty sessionId; got: ${JSON.stringify(start.json)}`).toBe(true)
    const sessionId = s.sessionId as string

    const g1 = await callTool('computer_get_app_state', { sessionId })
    const g = sessionFields(g1.json).generation as number
    expect(g1.json, `get_app_state #1 returned non-JSON text: ${JSON.stringify(g1.raw.content)}`).not.toBeNull()
    expect(typeof g === 'number' && g >= 1, `get_app_state #1 must return a generation >= 1; got: ${JSON.stringify(g1.json)}`).toBe(true)
    const g2 = await callTool('computer_get_app_state', { sessionId })
    const gNext = sessionFields(g2.json).generation as number
    expect(typeof gNext === 'number' && gNext > g, `a second get_app_state must advance the generation (G=${g}); got G+1=${gNext} in ${JSON.stringify(g2.json)}`).toBe(true)

    const res = await callTool('computer_execute_action', {
      sessionId,
      generation: g,
      action: { type: 'click_element', elementIndex: 2 },
    })
    expect(res.json, `execute_action returned non-JSON text: ${JSON.stringify(res.raw.content)}`).not.toBeNull()
    expect(res.raw.isError, `a superseded generation must be a structured (non-isError) failure; got isError=${res.raw.isError} raw=${JSON.stringify(res.raw)}`).toBeFalsy()
    expect(res.json!.status, `execute_action with a superseded generation must be status 'stale' (rejected before side effects); got: ${JSON.stringify(res.json)}`).toBe('stale')
    expect(isRecoverable(res.json), `a stale result must be recoverable (re-observe and retry); got: ${JSON.stringify(res.json)}`).toBe(true)

    const check = await callTool('computer_get_app_state', { sessionId })
    expect(check.json, `get_app_state (post-stale) returned non-JSON text: ${JSON.stringify(check.raw.content)}`).not.toBeNull()
    expect(displayValue(check.json), `the stale action must have NO side effect (Display must be empty/unchanged); got '${displayValue(check.json)}'`).toBe('')

    await callTool('computer_stop', { sessionId })
  })

  it('target_mismatch', async () => {
    const start = await startSession()
    const s = sessionFields(start.json)
    expect(typeof s.sessionId === 'string' && (s.sessionId as string).length > 0, `start_session must return a non-empty sessionId; got: ${JSON.stringify(start.json)}`).toBe(true)
    const sessionId = s.sessionId as string

    const res = await callTool('computer_execute_action', {
      sessionId,
      generation: s.generation,
      action: { type: 'click_element', elementIndex: 2 },
      expectedTarget: { appId: 'com.apple.TextEdit' },
    })
    expect(res.json, `execute_action returned non-JSON text: ${JSON.stringify(res.raw.content)}`).not.toBeNull()
    expect(res.raw.isError, `target_mismatch must be a structured (non-isError) failure; got isError=${res.raw.isError} raw=${JSON.stringify(res.raw)}`).toBeFalsy()
    expect(res.json!.status, `an expectedTarget naming a different app must yield status 'target_mismatch'; got: ${JSON.stringify(res.json)}`).toBe('target_mismatch')
    // Record the actual value (spec: recoverable is expected to be false-ish —
    // the call itself must change). Only assert it when the field is present.
    const rec = recoverableValue(res.json)
    observed.targetMismatchRecoverable = rec
    if (rec !== undefined) {
      expect(rec, `target_mismatch must not be recoverable (the call must change); got recoverable=${JSON.stringify(rec)} in ${JSON.stringify(res.json)}`).toBe(false)
    }

    const check = await callTool('computer_get_app_state', { sessionId })
    expect(check.json, `get_app_state (post-mismatch) returned non-JSON text: ${JSON.stringify(check.raw.content)}`).not.toBeNull()
    expect(displayValue(check.json), `target_mismatch must have NO side effect (Display must be empty); got '${displayValue(check.json)}'`).toBe('')

    await callTool('computer_stop', { sessionId })
  })
})

// Cross-test session shared by the pause → resume → stop chain (tests 4–6).
let interventionSession: string | undefined
