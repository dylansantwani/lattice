/**
 * Text shaping for the gateway: the header stamped on each inbound message, markdown → what a
 * phone renders, fence-aware chunking, and the wording of approvals, questions and commands.
 * Pure functions — everything here is unit-tested without a runtime.
 */
import type { ApprovalRequest, AskRequest } from '@shared/types'
import { CHANNEL_LABELS, type ChannelId, type OutboundButton } from './types'

// ---------- inbound header ----------

const HEADER_PREFIXES = ['[Texted via ', '[Phone call · '] as const

/**
 * The bracketed line that opens every message the gateway puts into the assistant thread. It gives
 * the model the channel and the owner's local time, and marks the message as phone-originated so
 * delivery knows the conversation currently lives on the phone (see {@link isChannelMessage}).
 */
export function inboundHeader(channel: ChannelId, at: number, timeZone?: string): string {
  const when = new Intl.DateTimeFormat('en-US', {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {})
  }).format(new Date(at))
  if (channel === 'voice') {
    return `[Phone call · ${when} · answer in 1-3 short spoken sentences, no formatting]`
  }
  return `[Texted via ${CHANNEL_LABELS[channel]} · ${when}]`
}

export function isChannelMessage(text: string | undefined): boolean {
  if (!text) return false
  return HEADER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export function isVoiceMessage(text: string | undefined): boolean {
  return !!text && text.startsWith(HEADER_PREFIXES[1])
}

// ---------- markdown rendering ----------

const FENCE = /^\s*(```|~~~)/

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Inline markdown on one line of prose (never inside a code span). */
function inlineToHtml(line: string): string {
  const parts = line.split(/(`[^`\n]+`)/g)
  return parts
    .map((part) => {
      if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return `<code>${escapeHtml(part.slice(1, -1))}</code>`
      let out = escapeHtml(part)
      out = out.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => `<a href="${url.replace(/"/g, '&quot;')}">${label}</a>`)
      out = out.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/__([^_\n]+)__/g, '<b>$1</b>')
      out = out.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
      out = out.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1<i>$2</i>')
      out = out.replace(/~~([^~\n]+)~~/g, '<s>$1</s>')
      return out
    })
    .join('')
}

/**
 * Markdown → the HTML subset Telegram's `parse_mode: HTML` accepts (b, i, s, code, pre, a). Tables
 * and headings have no Telegram equivalent, so headings become bold lines and bullets become "•".
 */
export function markdownToTelegramHtml(markdown: string): string {
  const out: string[] = []
  let code: string[] | null = null
  let lang = ''
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      if (code) {
        out.push(`<pre><code${lang ? ` class="language-${escapeHtml(lang)}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`)
        code = null
      } else {
        code = []
        lang = line.trim().replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] ?? ''
      }
      continue
    }
    if (code) {
      code.push(line)
      continue
    }
    const heading = /^\s{0,3}#{1,6}\s+(.*)$/.exec(line)
    if (heading) {
      out.push(`<b>${inlineToHtml(heading[1]!.trim())}</b>`)
      continue
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) {
      out.push(`${bullet[1]}• ${inlineToHtml(bullet[2]!)}`)
      continue
    }
    const quote = /^\s*>\s?(.*)$/.exec(line)
    if (quote) {
      out.push(`<i>${inlineToHtml(quote[1]!)}</i>`)
      continue
    }
    out.push(inlineToHtml(line))
  }
  // An unterminated fence (the model stopped mid-block) still renders as code.
  if (code) out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`)
  return out.join('\n')
}

/** Markdown → plain text for iMessage/SMS and speech: keep the words, drop the syntax. */
export function markdownToPlain(markdown: string): string {
  const out: string[] = []
  let inCode = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(line)
      continue
    }
    let text = line
    text = text.replace(/^\s{0,3}#{1,6}\s+/, '')
    text = text.replace(/^(\s*)[-*+]\s+/, '$1• ')
    text = text.replace(/^\s*>\s?/, '')
    text = text.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_m, label: string, url: string) => (label === url ? url : `${label} (${url})`))
    text = text.replace(/\*\*([^*\n]+)\*\*/g, '$1').replace(/__([^_\n]+)__/g, '$1')
    text = text.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/g, '$1$2')
    text = text.replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/g, '$1$2')
    text = text.replace(/~~([^~\n]+)~~/g, '$1')
    text = text.replace(/`([^`\n]+)`/g, '$1')
    // Markdown table separator rows carry no words.
    if (/^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/.test(text)) continue
    out.push(text)
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** Streaming speech cleanup for one delta: strip syntax that would be read aloud. */
export function speakable(delta: string): string {
  return delta.replace(/```[a-z]*|`|\*\*|__|^#{1,6}\s+/gim, '').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
}

// ---------- chunking ----------

function hardSplit(text: string, max: number): string[] {
  const pieces: string[] = []
  let rest = text
  while (rest.length > max) {
    const window = rest.slice(0, max)
    const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. ') + 1, window.lastIndexOf(' '))
    const at = cut > max * 0.5 ? cut : max
    pieces.push(rest.slice(0, at).trimEnd())
    rest = rest.slice(at).trimStart()
  }
  if (rest) pieces.push(rest)
  return pieces
}

/**
 * Split markdown into bubbles of at most `max` characters, preferring paragraph, then line, then
 * sentence boundaries. A split inside a fenced code block closes the fence in one bubble and
 * reopens it in the next, so each bubble renders on its own.
 */
export function chunkMarkdown(markdown: string, max: number): string[] {
  const text = markdown.trim()
  if (!text) return []
  if (text.length <= max) return [text]
  const budget = Math.max(64, max - 8) // room to close/reopen a fence
  const blocks = text.split(/\n{2,}/)
  const chunks: string[] = []
  let current = ''
  let openFence: string | null = null

  const flush = (): void => {
    if (!current.trim()) return
    let body = current.trimEnd()
    if (openFence) body += `\n${openFence}`
    chunks.push(body)
    current = openFence ? `${openFence}\n` : ''
  }

  for (const block of blocks) {
    const pieces = block.length > budget ? hardSplit(block, budget) : [block]
    for (const piece of pieces) {
      const candidate = current ? `${current}${current.endsWith('\n') ? '' : '\n\n'}${piece}` : piece
      if (candidate.length > budget && current.trim()) {
        flush()
        current = current ? `${current}${piece}` : piece
      } else {
        current = candidate
      }
      for (const line of piece.split('\n')) {
        if (FENCE.test(line)) openFence = openFence ? null : line.trim().slice(0, 3)
      }
    }
  }
  if (current.trim()) chunks.push(current.trimEnd())
  return chunks
}

// ---------- approvals, questions, commands ----------

const YES = /^(y|yes|yep|yeah|yup|ok|okay|sure|approve|approved|allow|go|go ahead|do it|👍|✅)[.!]*$/i
const NO = /^(n|no|nope|nah|deny|denied|stop|cancel|don't|dont|👎|❌)[.!]*$/i
const ALWAYS = /^(always|always allow|a)[.!]*$/i

export type ApprovalReply = 'allow' | 'deny' | 'always'

export function parseApprovalReply(text: string): ApprovalReply | undefined {
  const value = text.trim()
  if (ALWAYS.test(value)) return 'always'
  if (YES.test(value)) return 'allow'
  if (NO.test(value)) return 'deny'
  return undefined
}

export const APPROVAL_CALLBACK_PREFIX = 'lat:ap:'
export const ASK_CALLBACK_PREFIX = 'lat:ask:'

export function approvalPrompt(request: ApprovalRequest): { text: string; buttons: OutboundButton[][] } {
  const summary = request.summary?.trim() || request.tool
  const text = `Approval needed (${request.riskTier}): ${summary}\n\nReply yes, no, or always.`
  return {
    text,
    buttons: [[
      { label: 'Yes', data: `${APPROVAL_CALLBACK_PREFIX}allow:${request.id}` },
      { label: 'No', data: `${APPROVAL_CALLBACK_PREFIX}deny:${request.id}` },
      { label: 'Always', data: `${APPROVAL_CALLBACK_PREFIX}always:${request.id}` }
    ]]
  }
}

export function askPrompt(request: AskRequest): { text: string; buttons: OutboundButton[][] } {
  if (request.kind === 'confirm') {
    return {
      text: `${request.question}\n\nReply yes or no.`,
      buttons: [[
        { label: 'Yes', data: `${ASK_CALLBACK_PREFIX}${request.id}:yes` },
        { label: 'No', data: `${ASK_CALLBACK_PREFIX}${request.id}:no` }
      ]]
    }
  }
  if (request.kind === 'choice' && request.options?.length) {
    const lines = request.options.map((option, index) => `${index + 1}. ${option.label}${option.recommended ? ' (recommended)' : ''}`)
    return {
      text: `${request.question}\n\n${lines.join('\n')}\n\nReply with a number or your own answer.`,
      buttons: request.options.slice(0, 8).map((option, index) => [{ label: option.label.slice(0, 60), data: `${ASK_CALLBACK_PREFIX}${request.id}:${index + 1}` }])
    }
  }
  return { text: request.question, buttons: [] }
}

/** Map a typed or tapped answer onto what the `ask_user` tool expects. */
export function resolveAskAnswer(request: AskRequest, raw: string): string {
  const text = raw.trim()
  if (request.kind === 'confirm') {
    const reply = parseApprovalReply(text)
    if (reply === 'allow' || reply === 'always') return 'yes'
    if (reply === 'deny') return 'no'
    return text
  }
  if (request.kind === 'choice' && request.options?.length && /^\d+$/.test(text)) {
    const option = request.options[Number(text) - 1]
    if (option) return option.label
  }
  return text
}

export interface ParsedCommand {
  name: string
  arg: string
}

/** `/model gpt-5` → { name: 'model', arg: 'gpt-5' }. Telegram's `/cmd@BotName` form is accepted. */
export function parseCommand(text: string): ParsedCommand | undefined {
  const match = /^\/([a-z]+)(?:@[\w_]+)?(?:\s+([\s\S]*))?$/i.exec(text.trim())
  if (!match) return undefined
  return { name: match[1]!.toLowerCase(), arg: (match[2] ?? '').trim() }
}

/** Gateway commands: the help text and Telegram's "/" menu are both built from this list. */
export const GATEWAY_COMMANDS: ReadonlyArray<{ name: string; usage?: string; description: string }> = [
  { name: 'new', description: 'start a fresh conversation' },
  { name: 'stop', description: "stop what I'm doing" },
  { name: 'status', description: "what I'm up to" },
  { name: 'model', usage: '[name]', description: 'show or switch the model' },
  { name: 'remember', usage: '<fact>', description: 'save something to long-term memory' },
  { name: 'pair', description: 'link another app (e.g. iMessage + Telegram)' },
  { name: 'help', description: 'this list' }
]

export const HELP_TEXT = [
  'Text me like a person. I keep long-term memory and can use the web, files and tools. Send a photo, a file or a voice note and I will look at it.',
  '',
  ...GATEWAY_COMMANDS.map((command) => `/${command.name}${command.usage ? ` ${command.usage}` : ''} — ${command.description}`)
].join('\n')

// ---------- outbound files ----------

export interface LocalFileRef {
  path: string
  label: string
  /** Written as an image (`![…](…)`) rather than a link. */
  image: boolean
}

/**
 * Find markdown images and links that point at local files (`![chart](/tmp/chart.png)`,
 * `[report](file:///Users/me/report.pdf)`) outside code, and return the text with those references
 * taken out. That markdown is how the assistant hands the owner a file; whether each file may
 * actually be sent is the router's call.
 */
export function extractLocalFileRefs(markdown: string): { text: string; refs: LocalFileRef[] } {
  const refs: LocalFileRef[] = []
  const out: string[] = []
  let inFence = false
  for (const line of markdown.split('\n')) {
    if (FENCE.test(line)) {
      inFence = !inFence
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const parts = line.split(/(`[^`\n]+`)/g)
    const rewritten = parts
      .map((part) => {
        if (part.length > 1 && part.startsWith('`') && part.endsWith('`')) return part
        // Destination is either <anything but ">"> or a bare path whose parentheses balance, so
        // "Screenshot (1).png" survives; spaces are tolerated because models write them unescaped.
        return part.replace(/(!?)\[([^\]\n]*)\]\(\s*(?:<((?:file:\/\/)?\/[^>\n]+)>|((?:file:\/\/)?\/(?:[^()\n]|\([^()\n]*\))+?))\s*\)/g, (_match, bang: string, label: string, angled: string | undefined, bare: string | undefined) => {
          let path = (angled ?? bare ?? '').trim()
          if (path.startsWith('file://')) {
            try {
              path = decodeURIComponent(path.slice('file://'.length))
            } catch {
              path = path.slice('file://'.length)
            }
          }
          refs.push({ path, label: label.trim(), image: bang === '!' })
          // A link keeps its words in the sentence; an image has none worth keeping.
          return bang === '!' ? '' : label.trim()
        })
      })
      .join('')
    out.push(rewritten)
  }
  const text = out
    .map((line) => line.replace(/[ \t]+$/, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return { text, refs }
}

// ---------- assistant contract ----------

/**
 * The standing instructions for the assistant thread. They ride in the thread's goal, which
 * Lattice places in the system prompt on every turn.
 */
export function assistantGoal(ownerName: string, persona?: string): string {
  const name = ownerName.trim() || 'the owner'
  const lines = [
    `Be ${name}'s always-on personal assistant, reached by text message (Telegram or iMessage) and by phone call. Every message starts with a bracketed header naming the channel and ${name}'s local time; use it, never repeat it.`,
    '',
    'Replying:',
    '- Your final reply is texted back verbatim. Write like a sharp friend texting: short plain sentences, answer first. No tables or headings; a short list only when it clearly helps.',
    '- On a phone call, answer in one to three spoken sentences with no formatting, and never read out URLs. If the work will take more than a few seconds, say so and text the result.',
    '- For longer jobs, just do the work with your tools and reply once with the outcome.',
    '- To send a file or image (a screenshot, a chart, a PDF you made or found), put a markdown link to its absolute path in your reply, like ![chart](/Users/me/LatticeAssistant/chart.png). It arrives as an attachment. Only files under the home folder or a temp folder are sent, never anything in a hidden folder or ~/Library.',
    '- Photos, files and voice notes from the owner arrive as attachments or a "(voice note)" transcript.',
    '',
    `Memory (you are the long-term memory for ${name}'s life):`,
    '- Before answering anything about people, plans, preferences or earlier conversations, run memory_search.',
    `- When ${name} shares a durable fact about their life or about someone in it (who a person is, relationship, birthday, school or work, preferences, how to reach them), save it with memory_save as one standalone statement at confidence 0.9. For people, write it as "Person — <name> (<relationship>): <fact>".`,
    '- Do not save one-off tasks, small talk, or anything that expires within a day.',
    '',
    'Acting:',
    '- Use web_search, web_fetch and the browser tools for anything on the web instead of guessing.',
    '- Ask first before anything irreversible or outward-facing: sending messages or email, purchases, posting, deleting.',
    '- Never put passwords, API keys or verification codes in a reply.'
  ]
  if (persona?.trim()) lines.push('', 'Standing instructions from the owner:', persona.trim())
  return lines.join('\n')
}
