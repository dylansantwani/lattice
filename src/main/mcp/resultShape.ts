/**
 * The shape an MCP tool result takes on its way to the model.
 *
 * An MCP `tools/call` result is `{ content: Block[], structuredContent?, isError? }`, and most servers
 * (latchkey, openbrowser, most stdio tools) put their real payload in ONE text block that is itself
 * pretty-printed JSON. Passed through as-is, that payload reached the model badly:
 *
 *  - twice — the manager returned `normalizeToolOutcome(res)`, which spreads the result AND nests it
 *    again under `result`, so `content` appeared at two depths of the same object;
 *  - escaped twice over — `appendToolResults` JSON-stringifies the whole outcome, so a JSON document
 *    inside a text block became `"{\n  \"ok\": true,\n  \"ran\": 4, …"`: every newline, indent and quote
 *    paid for again as escapes;
 *  - unbounded — built-in tools clip to a context-scaled cap, MCP results did not.
 *
 * Measured on real latchkey batch results in lattice.db (2026-09-12): 1,494 chars of tool text became
 * 3,557 chars on the wire (2.4×). For a 128k local model driving a browser, that is the difference
 * between a long session and a compaction every few pages.
 *
 * `shapeMcpResult` returns what the model actually needs: the parsed JSON payload as a real object (so
 * it serializes once, compactly), or the plain text; non-text blocks (images, resources) untouched so
 * {@link extractToolResultImages} still lifts screenshots into a vision message; `isError` + `error`
 * so the run loop's outcome normalization reports the tool's own message; and a head+tail clip at the
 * caller's cap that tells the model how to ask for less rather than silently cutting.
 */

export interface McpContentBlock {
  type?: string
  text?: string
  [key: string]: unknown
}

export interface ShapedMcpResult {
  /** the tool's JSON payload, parsed (present when the text was a JSON document, or structuredContent) */
  data?: unknown
  /** the tool's plain-text payload (present when the text was not JSON, or when a payload was clipped) */
  text?: string
  /** non-text content blocks (images, embedded resources), passed through for image extraction */
  content?: McpContentBlock[]
  isError?: true
  error?: string
  /** set when the payload exceeded the cap and was clipped to head + tail */
  truncated?: { originalChars: number; keptChars: number }
}

const CLIP_HEAD_SHARE = 0.7

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  const t = text.trim()
  if (!t || (t[0] !== '{' && t[0] !== '[')) return { ok: false }
  try {
    return { ok: true, value: JSON.parse(t) }
  } catch {
    return { ok: false }
  }
}

/** Keep the head and tail of an oversized payload with an explicit, actionable marker in between. */
export function clipHeadTail(text: string, maxChars: number): { text: string; clipped: boolean } {
  if (text.length <= maxChars) return { text, clipped: false }
  const omitted = text.length - maxChars
  const marker =
    `\n…[${omitted} chars omitted from this tool result to protect the context window. ` +
    `Ask the tool for less instead of re-running the same call: a narrower selector or scope, ` +
    `a smaller max_chars/limit, or an offset/page.]…\n`
  const room = Math.max(0, maxChars - marker.length)
  const head = Math.floor(room * CLIP_HEAD_SHARE)
  const tail = room - head
  return { text: text.slice(0, head) + marker + (tail > 0 ? text.slice(text.length - tail) : ''), clipped: true }
}

export function shapeMcpResult(res: unknown, maxChars: number): ShapedMcpResult {
  const source = (typeof res === 'object' && res !== null ? res : { content: [{ type: 'text', text: String(res ?? '') }] }) as {
    content?: unknown
    structuredContent?: unknown
    isError?: unknown
    toolResult?: unknown
  }
  const blocks: McpContentBlock[] = Array.isArray(source.content) ? (source.content as McpContentBlock[]) : []
  const textParts = blocks.filter((b) => b && b.type === 'text' && typeof b.text === 'string').map((b) => b.text as string)
  const other = blocks.filter((b) => b && b.type !== 'text')
  const out: ShapedMcpResult = {}

  let data: unknown
  let text: string | undefined
  if (source.structuredContent !== undefined && source.structuredContent !== null) {
    // The spec has servers mirror structuredContent into a text block; the structure is the payload.
    data = source.structuredContent
  } else if (textParts.length === 1) {
    const only = textParts[0] as string
    const parsed = tryParseJson(only)
    if (parsed.ok) data = parsed.value
    else text = only
  } else if (textParts.length > 1) {
    text = textParts.join('\n')
  } else if (source.toolResult !== undefined) {
    // legacy compatibility result shape
    data = source.toolResult
  }

  if (data !== undefined) {
    const serialized = JSON.stringify(data)
    if (serialized !== undefined && serialized.length > maxChars) {
      const clip = clipHeadTail(serialized, maxChars)
      out.text = clip.text
      out.truncated = { originalChars: serialized.length, keptChars: clip.text.length }
    } else {
      out.data = data
    }
  } else if (text !== undefined) {
    const clip = clipHeadTail(text, maxChars)
    out.text = clip.text
    if (clip.clipped) out.truncated = { originalChars: text.length, keptChars: clip.text.length }
  }
  if (other.length) out.content = other

  if (source.isError === true) {
    out.isError = true
    const message = out.text ?? (out.data !== undefined ? JSON.stringify(out.data) : '')
    // short: the full message is already in text/data, and the outcome carries `error` alongside it
    out.error = message ? message.slice(0, 300) : 'Tool reported an error.'
  }
  return out
}
