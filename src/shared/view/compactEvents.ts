import type { RunEvent, RunEventBody } from '../types'

/**
 * Compact a thread's run events for a remote client that only needs to RENDER them.
 *
 * The event log is written for replay fidelity: every streamed reasoning/text chunk, every partial
 * tool-argument snapshot (`tool.drafting`), every live-output snapshot (`tool.progress`). On a
 * settled run none of that carries anything the transcript shows — the timeline builder
 * concatenates the deltas and keeps only a call's final state — yet it is most of the bytes. Measured
 * on live threads (2026-09-11): 40–60% of events were `tool.drafting`, and the phone's 2,000-event
 * window came to 2.5–4 MB of JSON per thread open, over the Mac's uplink, decoded on the phone.
 *
 * Rules, all lossless for rendering (the Swift and TS timeline builders produce the same result):
 *  - consecutive `reasoning.delta` events of one run merge into one (text concatenated, first
 *    `startedAt` kept, last `fidelity` kept); the same for consecutive `text.delta`;
 *  - `tool.drafting` is dropped for a call that later reached `tool.proposed`/`tool.started`/
 *    `tool.result`/`tool.denied` (the final args replace the drafts); a call still drafting keeps
 *    only its LAST draft;
 *  - `tool.progress` is dropped for a call that has a `tool.result`; a still-running call keeps only
 *    its last snapshot;
 *  - a `tool.result` whose serialized result exceeds `maxResultChars` is replaced by a clipped
 *    string result plus `truncated: true` and the original size, so a 200 KB command output does
 *    not ride along with the snapshot (the desktop keeps the full row);
 *  - everything else (run.started/completed, usage, errors, asks, steers, compaction, retry) is kept.
 *
 * Events keep their ids/seq/ts, so the client's dedupe-by-id reducer and later live pushes stay
 * consistent: a pushed `tool.drafting` for a NEW call is unaffected, and a re-fetch after a socket
 * drop replaces the whole window anyway.
 */
export interface CompactOptions {
  /** Clip a tool result's serialized form beyond this many characters (default 16 000). */
  maxResultChars?: number
}

const DEFAULT_MAX_RESULT_CHARS = 16_000

type ToolBody = Extract<RunEventBody, { type: `tool.${string}` }>
const isTool = (b: RunEventBody): b is ToolBody => b.type.startsWith('tool.')

export function compactRunEvents(events: RunEvent[], opts: CompactOptions = {}): RunEvent[] {
  const maxResult = opts.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS

  // Pass 1: which calls settled (final args known) and which have a result.
  const settledArgs = new Set<string>()
  const hasResult = new Set<string>()
  const lastDraft = new Map<string, string>()
  const lastProgress = new Map<string, string>()
  for (const ev of events) {
    const b = ev.body
    if (!isTool(b)) continue
    const key = `${ev.agent ?? ''}|${b.callId}`
    if (b.type === 'tool.drafting') lastDraft.set(key, ev.id)
    else if (b.type === 'tool.progress') lastProgress.set(key, ev.id)
    else if (b.type === 'tool.proposed' || b.type === 'tool.started' || b.type === 'tool.denied' || b.type === 'tool.result') {
      settledArgs.add(key)
      if (b.type === 'tool.result') hasResult.add(key)
    }
  }

  // Pass 2: merge delta runs and drop superseded snapshots.
  const out: RunEvent[] = []
  // The open merged delta per (run, agent): merging only within one run and one lane keeps a
  // subagent's reasoning apart from the parent's and never crosses a run boundary.
  let openKind: 'reasoning' | 'text' | null = null
  let openLane = ''
  let open: RunEvent | null = null
  const closeOpen = (): void => {
    if (open) out.push(open)
    open = null
    openKind = null
  }
  for (const ev of events) {
    const b = ev.body
    const lane = `${ev.runId}|${ev.agent ?? ''}`
    if (b.type === 'reasoning.delta' || b.type === 'text.delta') {
      const kind = b.type === 'reasoning.delta' ? 'reasoning' : 'text'
      if (open && openKind === kind && openLane === lane) {
        // Extend the open merged event; keep its identity (id/seq/ts of the first chunk).
        const ob = open.body as Extract<RunEventBody, { type: 'reasoning.delta' }> | Extract<RunEventBody, { type: 'text.delta' }>
        const merged: RunEventBody =
          b.type === 'reasoning.delta' && ob.type === 'reasoning.delta'
            ? { ...ob, text: ob.text + b.text, fidelity: b.fidelity }
            : { ...(ob as Extract<RunEventBody, { type: 'text.delta' }>), text: ob.text + b.text }
        open = { ...(open as RunEvent), body: merged }
        continue
      }
      closeOpen()
      open = { ...ev, body: { ...b } }
      openKind = kind
      openLane = lane
      continue
    }
    closeOpen()
    if (isTool(b)) {
      const key = `${ev.agent ?? ''}|${b.callId}`
      if (b.type === 'tool.drafting') {
        if (settledArgs.has(key)) continue
        if (lastDraft.get(key) !== ev.id) continue
      } else if (b.type === 'tool.progress') {
        if (hasResult.has(key)) continue
        if (lastProgress.get(key) !== ev.id) continue
      } else if (b.type === 'tool.result' && b.result !== undefined) {
        const text = typeof b.result === 'string' ? b.result : safeStringify(b.result)
        if (text.length > maxResult) {
          out.push({
            ...ev,
            body: {
              ...b,
              result: `${text.slice(0, maxResult)}\n… [${text.length - maxResult} more chars; full result on the desktop]`,
              truncated: true,
              fullChars: text.length
            } as RunEventBody
          })
          continue
        }
      }
    }
    out.push(ev)
  }
  closeOpen()
  return out
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v) ?? String(v)
  } catch {
    return String(v)
  }
}
