import { createParser, type EventSourceMessage } from 'eventsource-parser'
import type { ProviderConfig, ReasoningFidelity, TurnTelemetry } from '@shared/types'

export interface WireMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | WireContentPart[] | null
  tool_calls?: WireToolCall[]
  /** DeepSeek thinking-mode output; required when replaying assistant turns with tools. */
  reasoning_content?: string | null
  tool_call_id?: string
  name?: string
  /**
   * Message-level prompt-cache breakpoint. Only ever set by {@link withCacheBreakpoints}, and only
   * on `role:'tool'` messages — Anthropic requires a tool_result's cache_control to sit on the
   * block itself, which maps from the message level (not from a content part; see there).
   */
  cache_control?: CacheControl
}

export interface WireContentPart {
  type: 'text' | 'image_url'
  text?: string
  image_url?: { url: string }
}

export interface WireToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface WireTool {
  type: 'function'
  function: { name: string; description?: string; parameters: unknown }
}

export interface StreamRequest {
  model: string
  messages: WireMessage[]
  tools?: WireTool[]
  maxTokens?: number
  temperature?: number
  effort?: string
  /** inject Anthropic-style cache_control breakpoints on the stable prefix */
  cache?: boolean
  /**
   * Index into `messages` of the last message of the STABLE history prefix — the wire as it stood
   * when the turn started, before this run's tool rounds began appending. When caching is on, a
   * cache breakpoint is pinned here (in addition to the system block and the moving tail markers),
   * so every round reliably re-reads the whole conversation prefix even when a single round
   * appends more blocks than the provider's automatic prefix-lookback covers (a large parallel
   * tool batch plus image carriers can easily exceed ~20 blocks).
   */
  cacheAnchorIndex?: number
  signal: AbortSignal
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string; fidelity: ReasoningFidelity }
  | { type: 'tool_call_delta'; index: number; id?: string; name?: string; argsDelta?: string }
  | { type: 'usage'; usage: Partial<TurnTelemetry> }
  | { type: 'finish'; reason: string }
  /**
   * Emitted once, at stream end, when raw model tool-call control tokens (DeepSeek/DSML sentinels)
   * leaked into the text channel and were scrubbed (see {@link makeControlTokenStripper}). It means
   * the model almost certainly TRIED to call a tool but the gateway/route failed to convert it into
   * structured `tool_calls` — the call was destroyed in transit. The run loop uses this to recover
   * (nudge the model to re-issue the call) instead of finalizing a turn that announces an action it
   * never performed.
   */
  | { type: 'raw_tool_tokens'; count: number }

export class ProviderHttpError extends Error {
  constructor(
    public status: number,
    public body: string,
    /** The raw `Retry-After` header the endpoint sent, if any — obeyed by the retry policy. */
    public retryAfter?: string | null
  ) {
    super(`provider HTTP ${status}: ${body.slice(0, 400)}`)
  }
}

type CacheControl = { type: 'ephemeral' }

/** Whether a message can carry a cache_control marker: it has text content to attach it to. */
function stampable(msg: WireMessage): boolean {
  if (typeof msg.content === 'string') return msg.content.length > 0
  if (Array.isArray(msg.content)) return msg.content.some((p) => p.type === 'text' || p.type === 'image_url')
  return false
}

/**
 * Add Anthropic-style `cache_control` breakpoints so the gateway reuses the prompt prefix.
 * Providers that don't support caching ignore the extra field.
 *
 * Two rules, both load-bearing (verified live against the OmniRoute gateway):
 *
 * 1. EVERY message with content is normalized to parts form (`[{type:'text',text}]`), stamped or
 *    not. Stamping converts a message to parts form; if unstamped messages stayed plain strings,
 *    a message would FLAP between the two serializations as the moving tail markers passed over
 *    it turn-to-turn — and gateways hash the serialized bytes, so the flap breaks the prefix
 *    match at that position and zeroes the hit rate. Byte-stable form across requests is what
 *    turned a measured 0% turn-over-turn hit rate into 98% on the Claude routes.
 *
 * 2. Marker placement (max 4, exactly Anthropic's limit):
 *    - the system block — the long stable prefix shared by every request in the thread;
 *    - the LAST stampable message, whatever its role — including tool results, so each agentic
 *      round caches the accumulated transcript instead of re-processing the whole tool tail;
 *    - the second-to-last stampable message, as an anchor when a round appends more blocks than
 *      the provider's automatic prefix-lookback (~20) covers, e.g. a large parallel tool batch;
 *    - optionally (`stableAnchorIndex`) a STABLE marker at the end of the history prefix as the
 *      turn found it — unlike the two moving tail markers it stays put across every round of the
 *      turn, so the whole conversation prefix is re-read even when one round appends more blocks
 *      than the tail lookback covers (see below).
 *
 * 3. Placement WITHIN the target depends on role. For system/user/assistant the marker rides the
 *    last content part (a normal content block, where Anthropic accepts cache_control). For a
 *    `role:'tool'` message it must instead ride the MESSAGE level: that message maps to an
 *    Anthropic `tool_result` block, and Anthropic hard-rejects a marker nested inside its content
 *    — "cache_control may not be specified within `tool_result.content`. Instead, place it
 *    directly on `tool_result`" (HTTP 400). The gateway's literal translation carries a
 *    message-level field onto the `tool_result` block itself, which is exactly the legal spot.
 *
 * Re-stamping is idempotent: any pre-existing marker (message- or part-level) is dropped before
 * the current round's markers are placed, so feeding a stamped transcript back through never
 * accumulates blocks past the cap (which would 400 as "A maximum of 4 blocks with cache_control").
 */
export function withCacheBreakpoints(messages: WireMessage[], stableAnchorIndex?: number): WireMessage[] {
  const toParts = (msg: WireMessage, stamp: boolean): WireMessage => {
    // Copy content into parts form, dropping any inherited part-level marker (idempotency).
    const parts: (WireContentPart & { cache_control?: CacheControl })[] =
      typeof msg.content === 'string'
        ? [{ type: 'text', text: msg.content }]
        : Array.isArray(msg.content)
          ? msg.content.map((p) => {
              const { cache_control: _drop, ...rest } = p as WireContentPart & { cache_control?: CacheControl }
              return { ...rest }
            })
          : []
    // A message with no stampable content (e.g. an assistant tool_calls turn, content:null) is left
    // as-is except for shedding any inherited message-level marker.
    if (parts.length === 0) {
      const { cache_control: _mc, ...bare } = msg
      return bare
    }
    // Always shed a prior message-level marker; re-add it below only when this round stamps a tool.
    const { cache_control: _prev, ...base } = msg
    if (!stamp) return { ...base, content: parts as WireContentPart[] }
    if (msg.role === 'tool')
      return { ...base, content: parts as WireContentPart[], cache_control: { type: 'ephemeral' } }
    parts[parts.length - 1] = { ...parts[parts.length - 1]!, cache_control: { type: 'ephemeral' } }
    return { ...base, content: parts as WireContentPart[] }
  }
  const systemIndex = messages.findIndex((m) => m.role === 'system')
  const stampIndices = new Set<number>()
  for (let i = messages.length - 1; i >= 0 && stampIndices.size < 2; i--) {
    if (i === systemIndex) break
    if (stampable(messages[i]!)) stampIndices.add(i)
  }
  // Fourth marker (still under Anthropic's limit of 4): a STABLE anchor at the end of the history
  // prefix as it stood when the turn started. The tail markers above move as tool rounds append;
  // this one does not, so every round's request re-reads the whole conversation prefix even when a
  // single round appends more blocks than the provider's automatic prefix-lookback (~20) covers —
  // e.g. a large parallel tool batch plus its image-carrier messages. Walks back to the nearest
  // stampable message (an assistant tool_calls turn has content:null and can't hold a marker), and
  // is skipped when a tail marker already covers that position.
  if (stableAnchorIndex !== undefined) {
    for (let i = Math.min(stableAnchorIndex, messages.length - 1); i >= 0; i--) {
      if (i === systemIndex || stampIndices.has(i)) break
      if (stampable(messages[i]!)) {
        stampIndices.add(i)
        break
      }
    }
  }
  if (systemIndex >= 0 && stampable(messages[systemIndex]!)) stampIndices.add(systemIndex)
  return messages.map((m, i) => toParts(m, stampIndices.has(i)))
}

/**
 * A streaming scrubber for model control tokens that leak into the `content` channel.
 *
 * DeepSeek-family models (DeepSeek V3/V4, and the DSML tool-call format) emit native
 * function-call control tokens delimited by U+FF5C ('｜'), e.g. `<｜DSML｜tool_calls｜>` /
 * `<｜DSML｜invoke>` or the classic `<｜tool▁calls▁begin｜>` (with U+2581 '▁'). A correct
 * gateway parses these out of the raw model output and re-emits structured `tool_calls`.
 * Some gateway/model routes get this wrong and pass the raw sentinels through as literal
 * `delta.content` — observed live on `openrouter/deepseek/deepseek-v4-flash-0731`, where a
 * turn rendered `<｜DSML｜tool_calls</｜DSML｜invoke>` as visible text and stopped mid-sentence
 * when the model switched into a (dropped) tool-call block.
 *
 * U+FF5C never occurs in normal prose, so any `<…>`-style tag whose body is made of token
 * characters and contains U+FF5C is a stray sentinel. This scrubs them. It is purely
 * defensive: real tool calls still arrive structurally via `delta.tool_calls` and are
 * untouched. Statefulness matters because a sentinel can straddle two SSE chunks — a bare
 * `<` or a `｜`-bearing partial at a chunk boundary is held back until the next chunk (or
 * `flush()` at stream end) so it is never emitted as garbage nor mistaken for prose.
 */
const SENTINEL = /<\/?[A-Za-z0-9_｜▁]*｜[A-Za-z0-9_｜▁]*>?/g
const SENTINEL_TAIL = /<\/?[A-Za-z0-9_｜▁]*$/

export function makeControlTokenStripper(): {
  push(text: string): string
  flush(): string
  /** How many sentinels were scrubbed so far — >0 means the route dropped a raw tool-call block. */
  strippedCount(): number
} {
  let carry = ''
  let stripped = 0
  const scrub = (s: string): string =>
    s.replace(SENTINEL, () => {
      stripped += 1
      return ''
    })
  return {
    push(text: string): string {
      let s = carry + text
      carry = ''
      // Hold back a trailing partial that could be the head of a split sentinel: a lone `<`/`</`
      // (the split point right before the '｜'), or any run already carrying a '｜'. A plain
      // `<div` (no '｜') is NOT held, so ordinary markup streams through unchanged.
      const tail = s.match(SENTINEL_TAIL)
      if (tail) {
        const seg = tail[0]
        if (seg.includes('｜') || seg === '<' || seg === '</') {
          carry = seg
          s = s.slice(0, s.length - seg.length)
        }
      }
      return scrub(s)
    },
    flush(): string {
      const s = carry
      carry = ''
      return scrub(s)
    },
    strippedCount(): number {
      return stripped
    }
  }
}

type InlineThinkPart = { type: 'text' | 'reasoning'; text: string }

/**
 * Split open-model `<think>…</think>` output out of the visible content channel. OpenRouter's free
 * router can choose an upstream that does not populate `reasoning` / `reasoning_content`; several
 * of those models instead stream their private work inline, with either tag split across arbitrary
 * SSE chunks. Treating that stream as ordinary text leaked the whole thought into the transcript.
 *
 * This is intentionally a tiny streaming tokenizer rather than a per-chunk regexp. It keeps only a
 * possible partial tag (at most eight characters), emits all other prose immediately, and preserves
 * the exact order of visible and reasoning spans. Literal complete think tags are provider control
 * markup and are never shown to the user.
 */
export function makeInlineThinkSplitter(): {
  push(text: string): InlineThinkPart[]
  flush(): InlineThinkPart[]
} {
  const OPEN = '<think>'
  const CLOSE = '</think>'
  let carry = ''
  let mode: InlineThinkPart['type'] = 'text'

  const scan = (incoming: string, final: boolean): InlineThinkPart[] => {
    const source = carry + incoming
    carry = ''
    const out: InlineThinkPart[] = []
    const emit = (type: InlineThinkPart['type'], text: string): void => {
      if (!text) return
      const previous = out[out.length - 1]
      if (previous?.type === type) previous.text += text
      else out.push({ type, text })
    }
    let i = 0
    while (i < source.length) {
      const next = source.indexOf('<', i)
      if (next < 0) {
        emit(mode, source.slice(i))
        break
      }
      emit(mode, source.slice(i, next))
      const tail = source.slice(next)
      const lower = tail.toLowerCase()
      if (lower.startsWith(OPEN)) {
        mode = 'reasoning'
        i = next + OPEN.length
        continue
      }
      if (lower.startsWith(CLOSE)) {
        mode = 'text'
        i = next + CLOSE.length
        continue
      }
      const partial = !final && (OPEN.startsWith(lower) || CLOSE.startsWith(lower))
      if (partial) {
        carry = tail
        break
      }
      emit(mode, '<')
      i = next + 1
    }
    return out
  }

  return {
    push: (text) => scan(text, false),
    flush: () => scan('', true)
  }
}

// ---------- dropped-tool-call salvage ----------

/** Cap on raw content retained for salvage — one reply's text, never unbounded. */
const RAW_CAPTURE_MAX = 256 * 1024

export interface SalvagedToolCall {
  name: string
  /** The call's argument object, as the JSON text extracted from the raw stream. */
  args: string
}

/**
 * Extract one balanced JSON object starting at `start` (which must be `{`), string- and
 * escape-aware so braces inside string values don't break the balance. Returns the exact source
 * slice, or null when the object never closes.
 */
function extractJsonObject(s: string, start: number): string | null {
  if (s[start] !== '{') return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < s.length; i++) {
    const c = s[i]!
    if (esc) {
      esc = false
      continue
    }
    if (inStr) {
      if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}') {
      depth--
      if (depth === 0) return s.slice(start, i + 1)
    }
  }
  return null
}

/** True when `json` parses to a plain object — the only valid shape for tool arguments. */
function isArgsObject(json: string): boolean {
  try {
    const parsed = JSON.parse(json) as unknown
    return !!parsed && typeof parsed === 'object' && !Array.isArray(parsed)
  } catch {
    return false
  }
}

/**
 * Walk `s` with a bracket stack (string- and escape-aware). Reports the stack of closers still owed
 * at the end, or the first structural fault: a closer of the wrong kind (the captured DeepSeek
 * calls wrote `]` where an inner object's `}` was due), a closer with nothing open, or a cut inside
 * a string.
 */
type BracketScan = { ok: true; owed: string[] } | { ok: false; fault: string }
function scanBrackets(s: string): BracketScan {
  const stack: string[] = []
  let inStr = false
  let esc = false
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') {
      const want = stack[stack.length - 1]
      if (want === undefined) return { ok: false, fault: `a stray "${c}" at position ${i} closes nothing (every container was already closed)` }
      if (want !== c) {
        const open = want === '}' ? 'object' : 'array'
        return { ok: false, fault: `a "${c}" at position ${i} arrives while an ${open} is still open — a "${want}" is missing somewhere before it` }
      }
      stack.pop()
    }
  }
  if (inStr) return { ok: false, fault: 'the text ends inside an unterminated string' }
  return { ok: true, owed: stack.reverse() }
}

/**
 * Append the closers a complete-looking object left off its END. Models sometimes finish a tool
 * call — a clean `finish_reason: tool_calls`, every value written — but stop one or two closers
 * early. Appending them invents no content: every key and value is the model's own, and with no
 * mismatch anywhere the placement is unambiguous. Bounded so it never fabricates from a real
 * truncation: the scan must end OUTSIDE a string, the last non-space character must itself be a
 * closer (the model wrote a terminator and stopped), at most `MAX_AUTOCLOSE` closers are added,
 * and the result must parse to an object.
 *
 * Deliberately NOT repaired: a closer of the wrong kind mid-stream. The captured DeepSeek batch
 * calls end `..."tool": "abrowser_eval"}], "tool": "mcp__…"}]}` — the inner `args` object was
 * never closed before `, "tool"`. A bracket-stack repair can only insert the `}` where the
 * mismatch is detected (before the final `]`), which yields VALID JSON with the WRONG structure
 * (`tool` lands inside `args`, so the call still fails, now with a baffling schema message). Only
 * the model knows where the brace belongs, so that shape stays unrecoverable and the run loop
 * hands the model the real fault (see {@link scanBrackets}) to fix itself.
 */
const MAX_AUTOCLOSE = 4
function autocloseJsonObject(s: string): string | null {
  const trimmed = s.trim()
  if (trimmed[0] !== '{') return null
  const last = trimmed[trimmed.length - 1]
  if (last !== '}' && last !== ']') return null
  const scan = scanBrackets(trimmed)
  if (!scan.ok || scan.owed.length === 0 || scan.owed.length > MAX_AUTOCLOSE) return null
  const closed = trimmed + scan.owed.join('')
  return isArgsObject(closed) ? closed : null
}

export type CoercedToolArgs = {
  /** Object JSON safe to put on the wire. `{}` when nothing could be recovered. */
  text: string
  /** `valid`: input was already object JSON (returned byte-for-byte). `repaired`: recovered by
   * unwrapping quotes, trimming trailing junk, or auto-closing. `unrecoverable`: floored to `{}`. */
  kind: 'valid' | 'repaired' | 'unrecoverable'
  /** For `unrecoverable`: why the raw text could not be read as an object (JSON.parse's message). */
  issue?: string
}

/**
 * Coerce a tool call's `arguments` string into text that parses as a JSON object — the only shape
 * Anthropic accepts for `tool_use.input`. A non-object value ("", a bare string, an array, or a
 * truncated/quote-wrapped fragment) makes Anthropic hard-400 the WHOLE request with
 * `messages.N.content.0.tool_use.input: Input should be an object`. Because a thread replays its
 * full tool transcript every turn, a single malformed call — e.g. a partial arguments buffer that
 * got persisted, or a quote-wrapped fragment from a non-conforming route — permanently wedges that
 * conversation: every send fails identically. Neutralizing it here, at the one point every outgoing
 * request passes through, un-wedges already-poisoned threads with no store surgery and stops any
 * malformed call from ever reaching the model, whatever produced it.
 *
 * Repairs are conservative — never guess at truncated content (auto-closing a fragment cut
 * mid-string would fabricate arguments): keep valid object text byte-for-byte (so healthy calls
 * stay cache-identical), unwrap one layer of stray surrounding quotes, take a balanced object
 * followed by trailing junk, or append the closers a complete-looking object left off its end (see
 * {@link autocloseJsonObject}); anything else becomes `{}`. An empty object is the safe floor for
 * the WIRE — but callers that execute the call should not act on it blindly: `kind` says whether
 * the floor was hit, so the run loop can hand the model the real parse failure instead of a
 * misleading "required field missing" from validating `{}` (which is exactly what kept DeepSeek
 * re-sending the same brace-short batch call: it was told `calls` was missing, not that its JSON
 * was unbalanced, so it never changed anything).
 */
export function coerceToolArgs(raw: string | undefined | null): CoercedToolArgs {
  if (typeof raw === 'string' && isArgsObject(raw)) return { text: raw, kind: 'valid' }
  if (typeof raw !== 'string' || raw.trim() === '') return { text: '{}', kind: 'unrecoverable', issue: 'no arguments were sent' }
  const trimmed = raw.trim()
  // Strip one layer of stray wrapping quotes (straight or smart) some routes add around the JSON.
  const unwrapped = /^(['"‘’“”]).*\1$/s.test(trimmed) ? trimmed.slice(1, -1).trim() : trimmed
  if (isArgsObject(unwrapped)) return { text: unwrapped, kind: 'repaired' }
  // A balanced object with trailing junk after it (extra tokens, a stray sentinel): take the object.
  const braceAt = unwrapped.indexOf('{')
  if (braceAt >= 0) {
    const obj = extractJsonObject(unwrapped, braceAt)
    if (obj && isArgsObject(obj)) return { text: obj, kind: 'repaired' }
    const closed = autocloseJsonObject(unwrapped.slice(braceAt))
    if (closed) return { text: closed, kind: 'repaired' }
  }
  let issue: string
  try {
    const parsed = JSON.parse(unwrapped) as unknown
    issue = Array.isArray(parsed) ? 'top-level value is an array, not an object' : `top-level value is ${typeof parsed}, not an object`
  } catch (err) {
    issue = err instanceof Error ? err.message : String(err)
    // Name the structural fault when there is one — the parser's "expected , or }" says where it
    // gave up, not WHY; "a ] arrives while an object is still open" is what the model can act on.
    const scan = scanBrackets(unwrapped)
    if (!scan.ok) issue += `; ${scan.fault}`
  }
  return { text: '{}', kind: 'unrecoverable', issue }
}

/** Wire-safe object JSON for a tool call's `arguments` (see {@link coerceToolArgs}). */
export function sanitizeToolArgs(raw: string | undefined | null): string {
  return coerceToolArgs(raw).text
}

/** Return `messages` with every tool call's `arguments` guaranteed to be object JSON (see
 * {@link sanitizeToolArgs}). Returns the same array/objects when nothing needed fixing, so a
 * request of already-valid calls stays byte-identical and keeps its prompt-cache prefix. */
function sanitizeMessagesToolArgs(messages: WireMessage[]): WireMessage[] {
  let changed = false
  const out = messages.map((m) => {
    if (!m.tool_calls?.length) return m
    let msgChanged = false
    const calls = m.tool_calls.map((tc) => {
      const fixed = sanitizeToolArgs(tc.function.arguments)
      if (fixed === tc.function.arguments) return tc
      msgChanged = true
      return { ...tc, function: { ...tc.function, arguments: fixed } }
    })
    if (!msgChanged) return m
    changed = true
    return { ...m, tool_calls: calls }
  })
  return changed ? out : messages
}

/**
 * Recover tool calls a broken route emitted as RAW control tokens in the text channel instead of
 * structured `tool_calls` (the DeepSeek/DSML leak — see {@link makeControlTokenStripper}). Without
 * this, the model's call is destroyed in transit and the turn ends announcing work it never did;
 * the stall nudge can retry, but on a route that ALWAYS leaks, retrying just leaks again. Parsing
 * the call back out of the raw text is the permanent fix.
 *
 * Two recognizers, in order:
 *  1. The documented classic DeepSeek framing:
 *     `<｜tool▁call▁begin｜>function<｜tool▁sep｜>NAME\n\`\`\`json\n{...}\n\`\`\`<｜tool▁call▁end｜>`
 *  2. A generic sentinel-adjacent form covering DSML variants whose exact framing differs by
 *     release: an OFFERED tool name appearing shortly after a U+FF5C sentinel character, followed
 *     within a short window by a balanced, parseable JSON object.
 *
 * Both accept only names in `offeredTools` (the request's real tool list) and only argument text
 * that parses as a JSON object, so prose can virtually never produce a false call — it would have
 * to mention an exact tool id beside a ｜ control character AND be followed by valid JSON args.
 * Results come back in stream order. Exported for tests.
 */
export function salvageRawToolCalls(raw: string, offeredTools: string[]): SalvagedToolCall[] {
  if (!raw || offeredTools.length === 0) return []
  const offered = new Set(offeredTools)
  const found: (SalvagedToolCall & { at: number; end: number })[] = []
  const overlaps = (s: number, e: number): boolean => found.some((f) => s < f.end && e > f.at)

  const classic = /<｜tool▁call▁begin｜>([\s\S]*?)<｜tool▁call▁end｜>/g
  for (let m; (m = classic.exec(raw)); ) {
    const seg = m[1]!
    const name = /<｜tool▁sep｜>\s*([\w.\-]+)/.exec(seg)?.[1]
    if (!name || !offered.has(name)) continue
    const braceAt = seg.indexOf('{')
    if (braceAt < 0) continue
    const json = extractJsonObject(seg, braceAt)
    if (!json || !isArgsObject(json)) continue
    found.push({ name, args: json, at: m.index, end: m.index + m[0].length })
  }

  for (const name of offered) {
    let from = 0
    while (true) {
      const at = raw.indexOf(name, from)
      if (at < 0) break
      from = at + name.length
      // Sentinel proximity: the name must sit just after a ｜ control character — plain prose
      // mentioning a tool never qualifies.
      if (!raw.slice(Math.max(0, at - 120), at).includes('｜')) continue
      const gap = raw.slice(at + name.length, at + name.length + 200)
      const rel = gap.indexOf('{')
      if (rel < 0) continue
      const braceAt = at + name.length + rel
      const json = extractJsonObject(raw, braceAt)
      if (!json || !isArgsObject(json)) continue
      const end = braceAt + json.length
      if (overlaps(at, end)) continue
      found.push({ name, args: json, at, end })
    }
  }

  return found.sort((a, b) => a.at - b.at).map(({ name, args }) => ({ name, args }))
}

/** The `usage` object shape we read from an OpenAI-compatible stream (with cache extensions). */
interface RawUsage {
  prompt_tokens?: number
  completion_tokens?: number
  reasoning_tokens?: number
  completion_tokens_details?: { reasoning_tokens?: number }
  prompt_tokens_details?: { cached_tokens?: number }
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  cost?: number
}

/**
 * Map a provider `usage` object to canonical turn telemetry.
 *
 * Cache-token accounting is deliberately careful because backends disagree on how
 * `prompt_tokens` relates to cache activity:
 *   - Anthropic-style: `prompt_tokens` EXCLUDES freshly-written cache tokens
 *     (`cache_creation_input_tokens`) but INCLUDES cache reads. A cold turn reports a tiny
 *     `prompt_tokens` (e.g. 12) alongside a large `cache_creation_input_tokens` (e.g. 3146).
 *   - OpenAI-style: cached tokens are folded into `prompt_tokens` and no write count is
 *     reported; `prompt_tokens_details.cached_tokens` carries the read count.
 * Adding the write count back onto `prompt_tokens` yields the true total input processed in
 * both cases, so `tokensIn` (context budget, cost, and the cache-hit denominator) stays honest
 * even on the cache-write turn. `cacheReadTokens`/`cacheWriteTokens` stay `undefined` (not 0)
 * when the backend omits them, so the UI can tell "no cache activity" from "zero reads".
 */
export function mapUsage(u: RawUsage): Partial<TurnTelemetry> {
  const cacheReadTokens = u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens
  const cacheWriteTokens = u.cache_creation_input_tokens
  const tokensIn =
    typeof u.prompt_tokens === 'number' ? u.prompt_tokens + (cacheWriteTokens ?? 0) : undefined
  return {
    tokensIn,
    tokensOut: u.completion_tokens,
    tokensReasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens,
    cacheReadTokens,
    cacheWriteTokens,
    costUsd: u.cost
  }
}

/**
 * Stream a chat completion from an OpenAI-compatible endpoint (OmniRoute).
 * Yields canonical chunks; caller assembles messages/tool calls.
 *
 * EAGER: the HTTP request is fired at CALL time, not at first `next()`. An async generator's body
 * only runs when consumption starts, which serialized the caller's remaining pre-consume work
 * (context-budget recompute, event writes) in front of the network round trip on every round.
 * Splitting "open the stream" from "consume it" lets the run loop start the request first and do
 * that work inside the latency shadow.
 */
export function streamChat(provider: ProviderConfig, req: StreamRequest): AsyncGenerator<StreamChunk> {
  const resPromise = openChatStream(provider, req)
  // Parked until the caller starts consuming; the same rejection re-surfaces from the generator's
  // first next(), so this guard only prevents an unhandledRejection if consumption never begins.
  resPromise.catch(() => {})
  return consumeChatStream(resPromise, req)
}

/**
 * Per-model workarounds learned from a backend's 400s, so a quirk costs one failed request per
 * process instead of one per round:
 *  - `noReasoningEffort`: the backend rejects `reasoning_effort` outright (a non-thinking model on
 *    Ollama's OpenAI endpoint) — omit it from then on.
 *  - `flatContent`: the backend only accepts `content` as a plain string (Ollama's native chat
 *    struct: "cannot unmarshal array into Go struct field ChatRequest.messages.content of type
 *    string") — the prompt-cache breakpoints that turn content into parts must be flattened away.
 *  - `noAssistantPrefill`: the backend refuses a request whose last message is the assistant's
 *    ("This model does not support assistant message prefill. The conversation must end with a user
 *    message." — observed on the Claude Code OAuth lane). Continuing a reply then has to be ASKED
 *    for in a trailing user turn instead of implied by the prefill; see {@link CONTINUE_INSTRUCTION}.
 *  - `noDisableReasoning`: the backend takes a reasoning tier but rejects being told NOT to think
 *    (`reasoning_effort: none` on a model whose tiers start at `low`, e.g. opus-5). Kept apart from
 *    `noReasoningEffort` on purpose: only the `none` we send for "no thinking" is dropped, so an
 *    explicitly chosen `high` still reaches a model that merely dislikes `none`.
 *  - `noParallelToolCalls`: the backend 400s on the `parallel_tool_calls` field we send with every
 *    tool-bearing request — omit it from then on (the model then batches, or not, per its default).
 * Keyed by model id; reset with {@link resetProviderQuirks} (tests).
 */
interface ModelQuirks {
  noReasoningEffort?: boolean
  flatContent?: boolean
  noAssistantPrefill?: boolean
  noDisableReasoning?: boolean
  noParallelToolCalls?: boolean
}
const providerQuirks = new Map<string, ModelQuirks>()
export function resetProviderQuirks(): void {
  providerQuirks.clear()
}
function quirksFor(model: string): ModelQuirks {
  let q = providerQuirks.get(model)
  if (!q) {
    q = {}
    providerQuirks.set(model, q)
  }
  return q
}

/** A 400 that means "this backend wants string content, not content parts". */
const FLAT_CONTENT_400 = /cannot unmarshal array into Go struct field .*content|content must be a string|content.*(?:expected|must be).*string/i
/** A 400 that means "this backend rejects reasoning_effort for this model". */
// Also OpenRouter's router models ("Reasoning is mandatory for this endpoint and cannot be
// disabled") — the `none` we send to switch thinking off is what they refuse.
const REASONING_EFFORT_400 = /does not support (thinking|reasoning)|reasoning[_ ]?effort|reasoning is mandatory|reasoning .*cannot be disabled/i
/** A 400 that means "this backend will not take a trailing assistant message". */
const PREFILL_400 = /assistant (message )?prefill|must end with a user message|last message must be (from )?(the )?user/i
/** A 400 that means "this backend rejects the `parallel_tool_calls` field". */
const PARALLEL_TOOL_CALLS_400 = /parallel[_ ]?tool[_ ]?calls/i

/**
 * What we ask for instead when a backend refuses assistant prefill. Prefill is the better mechanism
 * — the model literally continues the sentence it was in the middle of — so this is the fallback,
 * not the default. It is worded to forbid the two failure modes that make a resumed reply worse than
 * a restarted one: repeating what was already said, and starting over with a fresh preamble.
 */
export const CONTINUE_INSTRUCTION =
  'Continue your previous message from exactly where it stopped — it was cut off mid-flow. Do not ' +
  'repeat any part of it, do not start over, and do not add a preamble, apology, or summary of what ' +
  'you already said. Resume from the last character as if you had never paused.'

/**
 * Turn a prefill-shaped wire (…, assistant: partial) into one a prefill-refusing backend accepts
 * (…, assistant: partial, user: "continue"). A wire that does not end with an assistant message is
 * returned unchanged, so this is safe to apply unconditionally once the quirk is known.
 */
export function withContinuationNudge(messages: WireMessage[]): WireMessage[] {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant' || last.tool_calls?.length) return messages
  return [...messages, { role: 'user', content: CONTINUE_INSTRUCTION }]
}

/**
 * Collapse every text-only content-part array back to a plain string (joining the parts) and drop
 * cache_control markers, for a backend that cannot read parts. A message carrying a non-text part
 * (an image) is left alone — there is no string form for it. Exported for tests.
 */
export function flattenContentParts(messages: WireMessage[]): WireMessage[] {
  return messages.map((m) => {
    const { cache_control: _mc, ...rest } = m
    if (!Array.isArray(m.content)) return rest
    if (m.content.some((p) => p.type !== 'text')) return rest
    return { ...rest, content: m.content.map((p) => p.text ?? '').join('') }
  })
}

/** Build the request body and open the SSE response, including the reasoning_effort 400 retry. */
async function openChatStream(provider: ProviderConfig, req: StreamRequest): Promise<Response> {
  // Guarantee every tool call's arguments is object JSON before serialization — a single malformed
  // call otherwise hard-400s the whole request and wedges the thread on every replay (see
  // {@link sanitizeToolArgs}). Runs before cache breakpoints so the anchor index still lines up.
  const quirks = quirksFor(req.model)
  // A backend already known to refuse assistant prefill gets the continuation asked for in a user
  // turn from the start, so resuming a reply costs one request rather than a 400 plus a retry.
  const requested = quirks.noAssistantPrefill ? withContinuationNudge(req.messages) : req.messages
  const safeMessages = sanitizeMessagesToolArgs(requested)
  const withCache = req.cache && !quirks.flatContent
  const body: Record<string, unknown> = {
    model: req.model,
    messages: withCache
      ? withCacheBreakpoints(safeMessages, req.cacheAnchorIndex)
      : quirks.flatContent
        ? flattenContentParts(safeMessages)
        : safeMessages,
    stream: true,
    stream_options: { include_usage: true }
  }
  if (req.tools?.length) {
    body.tools = req.tools
    // Ask for parallel tool calls explicitly. The OpenAI-compat default varies by backend, and a
    // model emitting one call per round re-bills the whole transcript once per call — measured on a
    // DeepSeek session at 1.26 calls/round, that was most of a 251M-input-token bill. A backend
    // that 400s on the field gets it dropped and remembered via the quirk retry below.
    if (!quirks.noParallelToolCalls) body.parallel_tool_calls = true
  }
  if (req.maxTokens) body.max_tokens = req.maxTokens
  if (req.temperature !== undefined) body.temperature = req.temperature
  // A chosen tier is sent as-is. Everything else — "off", and NO PREFERENCE AT ALL — is sent
  // EXPLICITLY as `none`: a request with no reasoning_effort is not "no thinking" to a gateway,
  // OmniRoute fills in the model's default effort when the field is absent. Measured on
  // claude-sonnet-5 with a 17-token prompt, that substitution cost 1364ms → 3148ms to first visible
  // text, so an omitted field silently bought seconds of thinking nobody asked for (on every title,
  // drift and compaction pass among others). A backend that rejects the field outright, or rejects
  // only being told not to think, is handled by the retry + quirk memos below.
  const disablingReasoning = !req.effort || req.effort === 'off'
  if (!quirks.noReasoningEffort && !(disablingReasoning && quirks.noDisableReasoning)) {
    body.reasoning_effort = disablingReasoning ? 'none' : req.effort
  }
  // OpenRouter-native extension: without it, OpenRouter (whether hit directly or through a
  // gateway that proxies to it, e.g. OmniRoute's `openrouter/…` routes) omits `usage.cost` from
  // the response entirely, forcing the caller onto the less-accurate list-price estimate. Scoped
  // to openrouter/-routed models — an unrecognized top-level field has caused hard 400s on other
  // strict OpenAI-compatible backends (see the `reasoning_effort` retry below).
  if (req.model.startsWith('openrouter/')) body.usage = { include: true }

  const doFetch = (): Promise<Response> =>
    fetch(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.apiKey}`,
        ...provider.headers
      },
      body: JSON.stringify(body),
      signal: req.signal
    })

  let res = await doFetch()

  // Some strict backends HARD-REJECT `reasoning_effort` for a model that can't think, with a 400
  // like `"qwen3-coder:30b" does not support thinking` (observed on Ollama's OpenAI endpoint),
  // instead of ignoring the field the way most gateways do. This bites whenever a reasoning tier
  // is still selected as the user switches to a non-reasoning model. Rather than force the effort
  // selector to track the model, drop `reasoning_effort` and retry once. We retry ONLY when we
  // actually sent it and the error is specifically about thinking/reasoning support, so this can
  // never suppress reasoning on a model that supports it (those never 400 here) and a genuine 400
  // still surfaces unchanged.
  if (res.status === 400) {
    const errText = await res.text().catch(() => '')
    if ('reasoning_effort' in body && REASONING_EFFORT_400.test(errText)) {
      delete body.reasoning_effort
      // Remember the NARROWEST thing the backend actually refused. A 400 on the `none` we send for
      // "no thinking" only proves this model has no off switch (its tiers may start at `low`) — it
      // must not condemn every future request to an omitted field, which would hand the gateway's
      // default effort back to a thread that explicitly asked for `high`.
      if (disablingReasoning) quirks.noDisableReasoning = true
      else quirks.noReasoningEffort = true
      res = await doFetch()
    } else if (PREFILL_400.test(errText) && Array.isArray(body.messages)) {
      // This backend will not continue a trailing assistant message; ask for the continuation in a
      // user turn instead, remember it for this model, and retry once.
      body.messages = withContinuationNudge(body.messages as WireMessage[])
      quirks.noAssistantPrefill = true
      res = await doFetch()
    } else if (FLAT_CONTENT_400.test(errText) && Array.isArray(body.messages)) {
      // The backend cannot read content parts (Ollama-backed routes): flatten the cache-breakpoint
      // parts back to strings, remember it for this model, and retry once.
      body.messages = flattenContentParts(body.messages as WireMessage[])
      quirks.flatContent = true
      res = await doFetch()
    } else if ('parallel_tool_calls' in body && PARALLEL_TOOL_CALLS_400.test(errText)) {
      // A strict backend that rejects the field outright: drop it, remember it for this model, and
      // retry once. Only taken when we actually sent the field, so an unrelated 400 that happens to
      // mention tool calls still surfaces unchanged.
      delete body.parallel_tool_calls
      quirks.noParallelToolCalls = true
      res = await doFetch()
    } else {
      throw new ProviderHttpError(400, errText)
    }
  }

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new ProviderHttpError(res.status, text, res.headers.get('retry-after'))
  }
  return res
}

/** Consume an opened SSE response into canonical chunks (see {@link streamChat}). */
async function* consumeChatStream(resPromise: Promise<Response>, req: StreamRequest): AsyncGenerator<StreamChunk> {
  const res = await resPromise
  const queue: StreamChunk[] = []
  let done = false
  let latestUsage: Partial<TurnTelemetry> | null = null
  const stripControlTokens = makeControlTokenStripper()
  // Only OpenRouter's free router is known to multiplex private reasoning into the visible
  // content channel with <think> control tags. Treating those strings as control markup for every
  // OpenAI-compatible backend corrupts legitimate prose/code (and an unmatched opening tag hides
  // the rest of the answer), so keep the fallback scoped to the route that actually needs it.
  const splitInlineThinking = req.model === 'openrouter/free' ? makeInlineThinkSplitter() : null
  const queueInlineContent = (content: string): void => {
    if (!splitInlineThinking) {
      queue.push({ type: 'text', text: content })
      return
    }
    for (const part of splitInlineThinking.push(content)) {
      queue.push(
        part.type === 'reasoning'
          ? { type: 'reasoning', text: part.text, fidelity: 'raw' }
          : { type: 'text', text: part.text }
      )
    }
  }
  // Raw (pre-strip) content capture, bounded, for salvaging a tool call a broken route emitted as
  // raw control tokens instead of structured tool_calls (see salvageRawToolCalls).
  let rawContent = ''
  let sawStructuredToolCall = false
  // An error the gateway reported INSIDE a 200 SSE body (`data: {"error":{...}}`) instead of as an
  // HTTP status. OpenRouter's free pool does this for upstream rate limits/capacity, and until it
  // was captured here the chunk simply had no `choices` and was dropped — the round then ended
  // empty and the turn finished as if the model had chosen to say nothing. Raised after the stream
  // drains so it flows through the same retry/classification path as an HTTP-level failure.
  // Held on an object so the assignment inside the parser callback is not narrowed away by
  // control-flow analysis at the post-drain read below.
  const streamError: { value: { status: number; body: string } | null } = { value: null }

  const parser = createParser({
    onEvent(event: EventSourceMessage) {
      if (event.data === '[DONE]') {
        done = true
        return
      }
      let json: any
      try {
        json = JSON.parse(event.data)
      } catch {
        return
      }
      if (json.error) {
        const e = json.error
        const code = typeof e?.code === 'number' ? e.code : typeof e?.status === 'number' ? e.status : undefined
        const nested = typeof e?.metadata?.raw === 'string' ? ` ${e.metadata.raw}` : ''
        const body = (typeof e?.message === 'string' ? e.message : JSON.stringify(e)) + nested
        // A rate-limit/cooldown reported inside the stream carries no numeric HTTP code of its own
        // (OpenRouter's free pool sends `type:"rate_limit_error"`, `code:"model_cooldown"` — a
        // string, not a number). Without this it fell through to the 502 default below and surfaced
        // as a generic "Provider error (HTTP 500)", bypassing the model_cooldown classification
        // (gated on 429) that explains the wait and tells the user to pick another model. Map it to
        // 429 so it lands there; the endpoint-retry policy already declines to redo a cooldown.
        const rateLimited =
          e?.type === 'rate_limit_error' || e?.code === 'model_cooldown' || /cooling down/i.test(body)
        streamError.value = {
          // No status of its own means the gateway broke mid-response: treat it as a 502 so the
          // retry policy redoes the round rather than surfacing it as a permanent 4xx.
          status: code != null && code >= 400 && code <= 599 ? code : rateLimited ? 429 : 502,
          // For a cooldown, forward the whole error object (not just its message) so the classifier
          // can read the structured `model` / `reset_seconds` fields and tell the user the exact
          // model and wait; the plain message alone would make it fall back to "Try again later."
          body: rateLimited ? JSON.stringify(e) + nested : body
        }
        return
      }
      if (json.usage) {
        // Latest-wins, emitted once at stream end: some gateways report a cumulative running
        // total on EVERY chunk when include_usage is set — queueing each one would let the
        // caller sum them and inflate token counts by the number of usage events.
        latestUsage = mapUsage(json.usage)
      }
      const choice = json.choices?.[0]
      if (!choice) return
      const delta = choice.delta ?? {}
      // Reasoning arrives in three shapes across backends: `reasoning_content` (DeepSeek-style),
      // `reasoning` (OpenRouter-style), or ONLY inside `reasoning_details` entries with the
      // plain fields null (observed live on openrouter/meta routes — dropping these made the
      // model look frozen through its whole reasoning phase). Prefer the plain fields; fall
      // back to concatenating detail texts/summaries only when both are absent, so content
      // duplicated across shapes is never double-counted.
      let reasoningText = delta.reasoning_content ?? delta.reasoning
      if (typeof reasoningText !== 'string' || reasoningText.length === 0) {
        if (Array.isArray(delta.reasoning_details)) {
          reasoningText = delta.reasoning_details
            .map((d: { text?: unknown; summary?: unknown }) =>
              typeof d?.text === 'string' ? d.text : typeof d?.summary === 'string' ? d.summary : ''
            )
            .join('')
        }
      }
      if (typeof reasoningText === 'string' && reasoningText.length > 0) {
        queue.push({ type: 'reasoning', text: reasoningText, fidelity: 'raw' })
      }
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        if (rawContent.length < RAW_CAPTURE_MAX) rawContent += delta.content
        const cleaned = stripControlTokens.push(delta.content)
        if (cleaned) queueInlineContent(cleaned)
      }
      if (Array.isArray(delta.tool_calls)) {
        sawStructuredToolCall = true
        for (const tc of delta.tool_calls) {
          queue.push({
            type: 'tool_call_delta',
            index: tc.index ?? 0,
            id: tc.id ?? undefined,
            name: tc.function?.name ?? undefined,
            argsDelta: tc.function?.arguments ?? undefined
          })
        }
      }
      if (choice.finish_reason) {
        queue.push({ type: 'finish', reason: choice.finish_reason })
      }
    }
  })

  // openChatStream verified res.body; TypeScript loses that across the promise boundary.
  const reader = res.body!.getReader()
  const decoder = new TextDecoder()
  try {
    while (!done) {
      const { value, done: rdone } = await reader.read()
      if (rdone) break
      parser.feed(decoder.decode(value, { stream: true }))
      while (queue.length) yield queue.shift()!
    }
    // Flush the decoder's buffered tail (a body can end mid-codepoint) before the final drain.
    parser.feed(decoder.decode())
    while (queue.length) yield queue.shift()!
    // Emit any text held back as a possible partial control-token at the last chunk boundary.
    const tail = stripControlTokens.flush()
    if (tail) queueInlineContent(tail)
    if (splitInlineThinking) {
      for (const part of splitInlineThinking.flush()) {
        queue.push(
          part.type === 'reasoning'
            ? { type: 'reasoning', text: part.text, fidelity: 'raw' }
            : { type: 'text', text: part.text }
        )
      }
    }
    while (queue.length) yield queue.shift()!
    // A mangled tool-call stream (raw DSML/DeepSeek sentinels scrubbed from the text channel):
    // first try to SALVAGE the dropped call(s) by parsing them out of the raw text — validated
    // against the tools this request actually offered — and hand them to the caller as ordinary
    // tool_call_delta chunks, so the round executes them as if the route had worked. Only when
    // nothing can be recovered is the raw_tool_tokens signal emitted for the stall-recovery nudge.
    const strippedSentinels = stripControlTokens.strippedCount()
    if (strippedSentinels > 0) {
      const offered = (req.tools ?? []).map((t) => t.function.name)
      const salvaged = sawStructuredToolCall ? [] : salvageRawToolCalls(rawContent, offered)
      if (salvaged.length > 0) {
        for (let i = 0; i < salvaged.length; i++) {
          const call = salvaged[i]!
          yield {
            type: 'tool_call_delta',
            index: i,
            id: `salvaged_${i}_${Math.random().toString(36).slice(2, 8)}`,
            name: call.name,
            argsDelta: call.args
          }
        }
      } else {
        yield { type: 'raw_tool_tokens', count: strippedSentinels }
      }
    }
    if (latestUsage) yield { type: 'usage', usage: latestUsage }
    // The body carried an error payload: fail the round with it (after draining whatever partial
    // content arrived, which the run loop rewinds) so the reason is retried and, if it persists,
    // reported — instead of vanishing into a silently empty reply.
    if (streamError.value) throw new ProviderHttpError(streamError.value.status, streamError.value.body)
  } finally {
    // Cancel before releasing: a consumer that breaks out early (title/compaction helpers cap
    // output mid-stream) must tear the HTTP stream down, not leave it draining until GC.
    reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
