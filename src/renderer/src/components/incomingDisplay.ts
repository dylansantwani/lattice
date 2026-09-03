/**
 * What the transcript shows for a user-role turn delivered by a subagent, another session, or a
 * background shell command. The persisted text opens with a machine-written lead-in addressed to
 * the model ("🤖 Background agent "X" finished. Its result is below — fold it into what you are
 * doing…"); the model still reads it verbatim, but the human already sees the sender in the card's
 * header, so echoing the instruction sentence is pure noise. Only lead-ins that carry no information
 * beyond the header are dropped — a failure reason or a shell exit status stays visible.
 */
const REDUNDANT_LEAD_INS: RegExp[] = [
  // runManager.formatAgentCompletion, success variant
  /^🤖 Background agent (?:"[^"\n]*"|\(id [^)\n]+\)) finished\. Its result is below[^\n]*\n\n/u,
  // sessionMessaging.formatIncomingMessage: sender + "To reply, use send_message with to:…"
  /^📨 Message from (?:session|subagent) "[^"\n]*" \([^)\n]*\)\. To reply, use send_message with to:"[^"\n]*"\.\n\n/u
]

/**
 * Instruction sentences addressed to the model that ride inside an otherwise informative lead-in
 * (a job completion keeps "has failed (exit 1) — purpose (`cmd`)", which the human wants, but not
 * "fold it into what you are doing…"). Removed wherever they appear in the first paragraph.
 */
const MODEL_INSTRUCTIONS: RegExp[] = [
  / Its full output is below; fold it into what you are doing, or, if you were waiting on it to answer the user, do so now\./u,
  / Its result is below — fold it into what you are doing, or, if you were waiting on it to answer the user, do so now\./u,
  / Fold this into what you are doing\./u
]

export function incomingDisplayText(text: string): string {
  for (const re of REDUNDANT_LEAD_INS) {
    const m = re.exec(text)
    if (m) {
      const rest = text.slice(m[0].length)
      // Never blank the card: an empty body would leave the header floating over nothing.
      return rest.trim() ? rest : text
    }
  }
  const firstBreak = text.indexOf('\n\n')
  const head = firstBreak === -1 ? text : text.slice(0, firstBreak)
  let trimmedHead = head
  for (const re of MODEL_INSTRUCTIONS) trimmedHead = trimmedHead.replace(re, '')
  if (trimmedHead === head) return text
  return trimmedHead + (firstBreak === -1 ? '' : text.slice(firstBreak))
}

/** Above this many characters (or lines) an incoming card arrives folded, showing only its preview. */
export const INCOMING_FOLD_CHARS = 320
export const INCOMING_FOLD_LINES = 4

/**
 * Whether an incoming card should arrive collapsed. A subagent's report or a long command's output
 * would otherwise shove the whole conversation up the screen the moment it lands; the reader gets
 * a one-line preview and opens it on demand. A short inter-session note stays open — folding a
 * single sentence behind a click would be pure friction.
 */
export function incomingCollapsedByDefault(displayText: string): boolean {
  const t = displayText.trim()
  if (t.length > INCOMING_FOLD_CHARS) return true
  return t.split('\n').filter((l) => l.trim()).length > INCOMING_FOLD_LINES
}

/**
 * A single plain-text line for a folded card's header: the first non-empty line with markdown
 * furniture (heading marks, emphasis, code ticks, list bullets, link syntax) stripped, clipped to
 * `max` characters on a word boundary.
 */
export function incomingPreview(displayText: string, max = 120): string {
  const first = displayText.split('\n').find((l) => l.trim() && !/^\s*(?:---+|```|\|)/.test(l))
  if (!first) return ''
  const plain = first
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+|\d+[.)]\s+|>\s+)/, '')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/(\*\*|__|~~|`)/g, '')
    .replace(/(^|\s)[*_](?=\S)|(?<=\S)[*_](?=\s|$)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
  if (plain.length <= max) return plain
  const cut = plain.slice(0, max)
  const atWord = cut.lastIndexOf(' ')
  return `${(atWord > max * 0.6 ? cut.slice(0, atWord) : cut).trimEnd()}…`
}

/** "12 lines" / "1 line" — the size hint beside a folded card's preview. */
export function incomingSizeHint(displayText: string): string {
  const n = displayText.split('\n').filter((l) => l.trim()).length
  return `${n} line${n === 1 ? '' : 's'}`
}
