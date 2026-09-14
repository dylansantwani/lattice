import type { MemoryScope, MemoryType } from '@shared/types'
import { contentTokens } from '../memory/similarity'

/**
 * Deterministic memory extraction — the free replacement for the distiller's model call.
 *
 * The old pass asked a model, once per completed run, "did anything durable come out of this?".
 * That is a real cost on every run, and most runs teach nothing. These rules cover the cases that
 * are *structurally* recognisable without understanding prose:
 *
 *   1. the user explicitly asking for something to be remembered / stating a standing preference
 *   2. a decision being made
 *   3. a durable environment fact (path, port, host, version)
 *   4. a warning / gotcha
 *   5. a procedure the run actually carried out (a command sequence)
 *
 * Precision over recall, on purpose: a missed nice-to-have costs nothing, a wrong memory costs
 * attention every turn it is injected. Anything subtler than this is left to the opt-in model pass
 * (`settings.selfLearningModelExtraction`), which now runs only when these rules find nothing.
 */

export interface RuleDraft {
  content: string
  type: MemoryType
  scope: MemoryScope
  confidence: number
  tags?: string[]
}

export const RULE_MIN_CHARS = 25
export const RULE_MAX_CHARS = 600
export const RULE_MAX_DRAFTS = 3
/** A procedure needs this many distinct commands before it is worth recording. */
export const RULE_MIN_WORKFLOW_STEPS = 3

const COMMAND_RE =
  /^\s*(?:\$ )?(?:sudo |brew |pnpm|npm|yarn|npx|node|python3?|pip3?|uv |git|curl|wget|ssh|scp|rsync|docker|kubectl|launchctl|sqlite3|defaults|chmod|ditto|cp |mv |rm |mkdir|tar |open |code |grep|awk|sed|jq|make )/
const WARNING_RE =
  /\b(doesn'?t work|won'?t work|silently|breaks?|fails?|must not|never (?:run|edit|delete|commit)|beware|gotcha|watch out|instead of|so don'?t|makes it worse)\b/i
const REMEMBER_RE =
  /^\s*(?:please\s+)?(remember|note|keep in mind|bear in mind|from now on|always|never|don'?t|do not|i prefer|i like|i want|make sure|going forward)\b/i
const DECISION_RE =
  /\b(we'?ll (?:use|keep|go with|do)|i'?ll (?:use|keep|go with)|let'?s (?:use|keep|do)|decided (?:to|that)|the plan is|stick with|going with)\b/i
const ENV_RE =
  /\b(lives? (?:at|in)|is (?:at|located)|runs? on|listens? on|serves? on|served on|stored (?:in|at)|configured (?:as|with)|points? (?:to|at)|installed (?:at|in)|hosted (?:at|on)|defaults? to)\b/i
const DURABLE_VALUE_RE = /(\/[A-Za-z0-9._/-]{3,}|:\d{2,5}\b|\b\d+(?:\.\d+)+\b|https?:\/\/\S+|\b[A-Za-z0-9-]+\.(?:local|lan|com|dev|io|ai|app)\b|\b[0-9a-f]{2}(?::[0-9a-f]{2}){3,}\b)/i

interface Turn {
  speaker: 'user' | 'assistant' | 'other'
  lines: string[]
}

/** Split a built transcript into speaker turns. Tolerant of "User:" / "Assistant:" / blank lines. */
function splitTurns(transcript: string): Turn[] {
  const turns: Turn[] = []
  let cur: Turn = { speaker: 'other', lines: [] }
  for (const raw of String(transcript || '').split('\n')) {
    const m = raw.match(/^\s*(user|assistant|system|tool)\s*:\s?(.*)$/i)
    if (m) {
      if (cur.lines.length) turns.push(cur)
      const who = m[1]!.toLowerCase()
      cur = { speaker: who === 'user' ? 'user' : who === 'assistant' ? 'assistant' : 'other', lines: m[2] ? [m[2]] : [] }
      continue
    }
    cur.lines.push(raw)
  }
  if (cur.lines.length) turns.push(cur)
  return turns
}

function sentences(text: string): string[] {
  return String(text)
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?;])\s+(?=[A-Z0-9"'(/])/))
    .map((s) => s.replace(/^[\s>*\-–•\d.)]+/, '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
}

function clean(text: string): string {
  let s = text.replace(/`{3}[a-z]*\n?/gi, '').replace(/\*\*|__/g, '').replace(/\s+/g, ' ').trim()
  s = s.replace(/^[-*•]\s*/, '')
  if (s.length > RULE_MAX_CHARS) s = s.slice(0, RULE_MAX_CHARS - 1).trimEnd() + '…'
  return s
}

function dedupe(drafts: RuleDraft[]): RuleDraft[] {
  const kept: RuleDraft[] = []
  const seen: Set<string>[] = []
  for (const d of drafts) {
    const toks = new Set(contentTokens(d.content))
    const dup = seen.some((prev) => {
      let inter = 0
      for (const t of prev) if (toks.has(t)) inter++
      const min = Math.min(prev.size, toks.size)
      return min > 0 && inter / min >= 0.8
    })
    if (!dup) {
      kept.push(d)
      seen.push(toks)
    }
  }
  return kept
}

/** Lines across the whole transcript, tagged with who said them. */
function allLines(turns: Turn[]): { speaker: Turn['speaker']; text: string }[] {
  return turns.flatMap((t) => t.lines.map((text) => ({ speaker: t.speaker, text })))
}

/**
 * A sentence that cannot stand on its own as a memory: a lead-in ending in a colon ("Three places
 * now explain themselves:"), a question, a bare pronoun subject that points back at something in the
 * conversation ("It's also the escape hatch…", "This one breaks…"), or a line that is mostly markup.
 * Each of these was a real row in the live store; none is usable in another conversation.
 */
export function isFragment(s: string): boolean {
  const t = s.trim()
  if (/[:,;(\-–—]$/.test(t)) return true
  if (/\?$/.test(t)) return true
  if (/^(it|it'?s|its|this|that|these|those|here|there|there'?s|now|also|then|so|which|and|but|or|because)\b/i.test(t)) return true
  if (/^(the|that|this) (one|other|first|second|last|same)\b/i.test(t)) return true
  const letters = t.replace(/[^a-z]/gi, '').length
  return letters < t.length * 0.5
}

export function extractDeterministic(transcript: string, opts: { max?: number } = {}): RuleDraft[] {
  const turns = splitTurns(transcript)
  const out: RuleDraft[] = []

  // Who may say what: a standing instruction is the USER's to give; a decision, a warning, or an
  // environment fact is only a memory when the ASSISTANT stated it as a finding. Before this, the
  // user's own bug report ("some doesnt work eg could not close watch http 501") was captured as a
  // durable "warning", auto-approved, and exported to the other agents the next morning.
  for (const { speaker, text } of allLines(turns)) {
    const line = text.trim()
    if (line.length < RULE_MIN_CHARS) continue
    for (const s of sentences(line)) {
      if (s.length < RULE_MIN_CHARS || isFragment(s)) continue
      if (speaker === 'user' && REMEMBER_RE.test(s)) {
        const standing = /\b(always|never|don'?t|do not|from now on|going forward|make sure|prefer|like|want)\b/i.test(s)
        out.push({ content: clean(s), type: standing ? 'preference' : 'fact', scope: 'user', confidence: 0.9 })
      } else if (speaker !== 'assistant') {
        continue
      } else if (DECISION_RE.test(s)) {
        out.push({ content: clean(s), type: 'decision', scope: 'workspace', confidence: 0.7 })
      } else if (WARNING_RE.test(s) && s.length >= 30) {
        out.push({ content: clean(s), type: 'warning', scope: 'workspace', confidence: 0.6 })
      } else if (ENV_RE.test(s) && DURABLE_VALUE_RE.test(s)) {
        out.push({ content: clean(s), type: 'environment', scope: 'workspace', confidence: 0.65 })
      }
    }
  }

  // ---- procedures: a real command sequence in the assistant's work
  const lines = allLines(turns)
  const cmds: string[] = []
  let heading = ''
  for (const { speaker, text } of lines) {
    const t = text.trim()
    if (COMMAND_RE.test(t) && t.length <= 200) {
      const norm = t.replace(/^\$ /, '').trim()
      if (cmds.at(-1) !== norm) cmds.push(norm)
    } else if (t && !COMMAND_RE.test(t) && t.length <= 140 && !/^(```|#{1,6}\s|\||\+|-{3,})/.test(t)) {
      heading = t
    }
  }
  const distinct = [...new Set(cmds)]
  if (distinct.length >= RULE_MIN_WORKFLOW_STEPS) {
    const quoted = heading.replace(/[`*_#]/g, '').replace(/\s+/g, ' ').trim()
    const trigger = quoted || 'Procedure carried out in this session'
    const steps = distinct.slice(0, 12).map((c, i) => `${i + 1}. \`${c}\``).join('\n')
    const gotcha = lines
      .map((l) => l.text.trim())
      .filter((t) => t.length >= 30 && WARNING_RE.test(t))
      .slice(0, 2)
      .map((t) => `- ${clean(t)}`)
      .join('\n')
    const body = `**Trigger:** ${trigger}\n\n**Steps**\n${steps}${gotcha ? `\n\n**Gotchas**\n${gotcha}` : ''}`
    out.push({
      content: body.length > RULE_MAX_CHARS ? body.slice(0, RULE_MAX_CHARS - 1).trimEnd() + '…' : body,
      type: 'workflow',
      scope: 'workspace',
      confidence: 0.75,
      tags: ['workflow'],
    })
  }

  // Highest-confidence first, deduped, capped.
  const ranked = out.sort((a, b) => b.confidence - a.confidence)
  return dedupe(ranked).slice(0, Math.max(1, opts.max ?? RULE_MAX_DRAFTS))
}
