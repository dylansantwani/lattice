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
  // The reminder rides on every text because the latest message is what a model weighs most.
  return `[Texted via ${CHANNEL_LABELS[channel]} · ${when} · text back short and plain]`
}

export function isChannelMessage(text: string | undefined): boolean {
  if (!text) return false
  return HEADER_PREFIXES.some((prefix) => text.startsWith(prefix))
}

export function isVoiceMessage(text: string | undefined): boolean {
  return !!text && text.startsWith(HEADER_PREFIXES[1])
}

// ---------- rendering ----------

const FENCE = /^\s*(```|~~~)/

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

function lowerFirstWord(text: string): string {
  return /^[A-Z][a-z]/.test(text) ? text[0]!.toLowerCase() + text.slice(1) : text
}

/**
 * An approval as a text: what it wants to do in plain words, the exact command in monospace when
 * there is one (the owner should see what they are approving), and Yes / No / Always buttons.
 * Risk jargon ("R2") stays out; a destructive tier gets a warning sign instead.
 */
export function approvalPrompt(request: ApprovalRequest, options: { buttons?: boolean } = {}): { text: string; buttons: OutboundButton[][] } {
  const args = request.args && typeof request.args === 'object' ? (request.args as Record<string, unknown>) : {}
  const command = typeof args.command === 'string' ? args.command.replace(/\s+/g, ' ').trim() : ''
  const purpose = typeof args.purpose === 'string' ? args.purpose.trim() : ''
  const warn = request.riskTier === 'R3' ? '⚠️ ' : ''
  let text: string
  if (command) {
    const shown = command.length > 240 ? `${command.slice(0, 239)}…` : command
    const verb = args.background ? 'start this in the background' : 'run this'
    text = `${warn}ok to ${verb}?${purpose ? ` ${lowerFirstWord(purpose)}` : ''}\n\`${shown.replace(/`/g, "'")}\``
  } else {
    const summary = (request.summary?.trim() || request.tool).replace(/`/g, "'")
    text = `${warn}ok to ${lowerFirstWord(summary)}?`
  }
  if (options.buttons === false) text += '\n(reply yes, no, or always)'
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
  { name: 'new', description: "clear the slate (i still remember what matters)" },
  { name: 'stop', description: "stop what I'm doing" },
  { name: 'status', description: "what I'm up to" },
  { name: 'model', usage: '[name]', description: 'show or switch the model' },
  { name: 'remember', usage: '<fact>', description: 'save something to long-term memory' },
  { name: 'pair', description: 'link another app (e.g. iMessage + Telegram)' },
  { name: 'help', description: 'this list' }
]

export const HELP_TEXT = [
  "text me like a person. i run on your mac, so i can use the web, your files and your apps, and i remember things long term. send photos, files or voice notes too.",
  '',
  ...GATEWAY_COMMANDS.map((command) => `/${command.name}${command.usage ? ` ${command.usage}` : ''}: ${command.description}`)
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

export interface AssistantGoalOptions {
  persona?: string
  timeZone?: string
  /** Where inbound files land, so the model can open them by path. */
  inbox?: string
  /**
   * False when the runtime predates the `texting` reply style (the thread came back without it):
   * the goal then has to carry the texting voice itself, as best a goal can.
   */
  runtimeTexting?: boolean
}

/**
 * The owner-specific standing instructions for the assistant thread (its goal). The texting voice,
 * progress habits, notices and memory protocol live in the runtime's texting prompt; this adds who
 * the owner is and how this gateway delivers things.
 */
export function assistantGoal(ownerName: string, options: AssistantGoalOptions = {}): string {
  const name = ownerName.trim() || 'the owner'
  const lines = [
    `You are ${name}'s personal assistant. ${name} reaches you from their phone: Telegram or iMessage texts, and phone calls.${options.timeZone ? ` Their time zone is ${options.timeZone}.` : ''}`,
    `Every message from ${name} starts with a bracketed header naming the channel and their local time, like "[Texted via Telegram · Sat, Sep 12, 4:32 PM CDT]". Use it; never repeat it back.`,
    `A "(voice note)" line is something ${name} said out loud. Photos come attached${options.inbox ? `, and files ${name} sends are saved in ${options.inbox}` : ''}.`,
    'On a phone call (the header says "Phone call") answer in one to three spoken sentences with no formatting and never read out links. If the work will take more than a few seconds, say so and text the result.',
    `When ${name} tells you something durable about their life or someone in it (who a person is, relationship, birthday, school or work, preferences, how to reach them), save it right away with memory_save as one standalone statement at confidence 0.9. For people write it as "Person — <name> (<relationship>): <fact>".`,
    'Only files under the home folder or a temp folder can be sent to the phone, never anything in a hidden folder or ~/Library.'
  ]
  if (options.runtimeTexting === false) {
    lines.push(
      '',
      'Your final reply is texted back as is. Write like a friend texting: one to three short plain sentences, answer first, no markdown (no bold, headings, tables, bullet lists or code blocks). Separate texts with a blank line. Before a long task, say "on it" in one line, then work. Details only when asked.',
      'Messages starting with ⏳ or 🤖 are automatic notices from your own background work. If one changes nothing the owner needs to hear, reply with exactly NO_REPLY.',
      'To show an image, call show_image with its path. Before answering about people, plans or preferences, run memory_search.'
    )
  }
  if (options.persona?.trim()) lines.push('', `Standing instructions from ${name}:`, options.persona.trim())
  return lines.join('\n')
}
