/**
 * What a phone actually shows. Models write markdown no matter what they are told, and a texting
 * app renders none of it: `**bold**` arrives with its asterisks, a table arrives as a wall of pipes,
 * and Telegram's HTML mode rejects a whole message over one stray `<`. So replies are rendered to
 * plain text here, and the little formatting worth keeping on Telegram rides as message entities
 * (offset/length spans next to the text) rather than markup, which cannot fail to parse:
 *
 *  - fenced code → monospace `pre`; inline code → tap-to-copy `code`
 *  - `[label](https://…)` → the label as a link (`text_link`), or `label (url)` where there are no entities
 *  - headings, emphasis, strikethrough, quotes and rules → just their words
 *  - tables → one line per row ("deepseek: 4,468 reqs · $16.02"), bullets → "•"
 *
 * {@link splitBubbles} then cuts a reply into a few short texts at paragraph breaks, the way a
 * person texts, instead of one long block.
 */

/** The Telegram MessageEntity subset the gateway emits. Offsets and lengths are UTF-16 units, like JS strings. */
export interface TextEntity {
  type: 'pre' | 'code' | 'text_link'
  offset: number
  length: number
  url?: string
  language?: string
}

export interface RenderedText {
  text: string
  entities: TextEntity[]
}

export type LinkStyle = 'entity' | 'inline'

const FENCE = /^\s*(```|~~~)/
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/
const TABLE_SEPARATOR = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/

/** Emphasis markers around words, never the underscores inside snake_case or a URL. */
function stripEmphasis(text: string): string {
  return text
    .replace(/\*\*\*([^*\n]+)\*\*\*/g, '$1')
    .replace(/\*\*([^*\n]+)\*\*/g, '$1')
    .replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, '$1$2')
    .replace(/(^|[\s(["'])\*(?!\s)([^*\n]+?)\*(?=[\s).,!?:;"'\]]|$)/g, '$1$2')
    .replace(/(^|[\s(["'])_(?!\s)([^_\n]+?)_(?=[\s).,!?:;"'\]]|$)/g, '$1$2')
    .replace(/~~([^~\n]+)~~/g, '$1')
}

/** One line of prose → text plus inline entities (offsets relative to the line). */
function renderInline(line: string, links: LinkStyle): RenderedText {
  let text = ''
  const entities: TextEntity[] = []
  for (const part of line.split(/(`[^`\n]+`)/g)) {
    if (!part) continue
    if (part.length > 2 && part.startsWith('`') && part.endsWith('`')) {
      const code = part.slice(1, -1)
      if (links === 'entity') entities.push({ type: 'code', offset: text.length, length: code.length })
      text += code
      continue
    }
    const prose = stripEmphasis(part)
    const link = /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g
    let last = 0
    for (let match = link.exec(prose); match; match = link.exec(prose)) {
      text += prose.slice(last, match.index)
      const label = match[1]!.trim()
      const url = match[2]!
      if (label === url || label.replace(/^https?:\/\//, '') === url.replace(/^https?:\/\//, '')) {
        text += url
      } else if (links === 'entity') {
        entities.push({ type: 'text_link', offset: text.length, length: label.length, url })
        text += label
      } else {
        text += `${label} (${url})`
      }
      last = match.index + match[0].length
    }
    text += prose.slice(last)
  }
  return { text, entities }
}

function splitRow(line: string): string[] {
  let body = line.trim()
  if (body.startsWith('|')) body = body.slice(1)
  if (body.endsWith('|') && !body.endsWith('\\|')) body = body.slice(0, -1)
  return body.split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, '|').trim())
}

function isTableRow(line: string | undefined): boolean {
  return !!line && line.includes('|') && /^\s*\|/.test(line)
}

/**
 * A markdown table as text lines. Two columns read as "key: value". Wider tables lead with the
 * first cell and label the rest with their headers, so no number loses its meaning.
 */
export function tableToLines(rows: string[][]): string[] {
  if (rows.length === 0) return []
  const [header, ...body] = rows
  const headers = header!.map((cell) => stripEmphasis(cell).replace(/`/g, ''))
  if (body.length === 0) return [headers.filter(Boolean).join(' · ')]
  return body.map((row) => {
    const cells = row.map((cell) => cell.trim())
    const lead = cells[0] ?? ''
    const rest = cells.slice(1).flatMap((cell, index) => {
      if (!cell || cell === '—' || cell === '-') return []
      const label = headers[index + 1] ?? ''
      if (cells.length === 2 || !label) return [cell]
      return [`${label} ${cell}`]
    })
    if (!lead) return rest.join(' · ')
    return rest.length ? `${lead}: ${rest.join(' · ')}` : lead
  })
}

/** Markdown → what a texting app should display. See the file comment for the rules. */
export function renderText(markdown: string, links: LinkStyle = 'entity'): RenderedText {
  let text = ''
  const entities: TextEntity[] = []
  let blankPending = false

  const pushLine = (line: RenderedText): void => {
    if (!line.text.trim() && line.entities.length === 0) {
      if (text) blankPending = true
      return
    }
    if (text) text += blankPending ? '\n\n' : '\n'
    blankPending = false
    for (const entity of line.entities) entities.push({ ...entity, offset: entity.offset + text.length })
    text += line.text
  }

  const lines = markdown.replace(/\r\n?/g, '\n').split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const raw = lines[index]!
    if (FENCE.test(raw)) {
      const language = raw.trim().replace(/^(```|~~~)/, '').trim().split(/\s+/)[0] ?? ''
      const body: string[] = []
      index += 1
      while (index < lines.length && !FENCE.test(lines[index]!)) body.push(lines[index++]!)
      while (body.length && !body[body.length - 1]!.trim()) body.pop()
      while (body.length && !body[0]!.trim()) body.shift()
      if (body.length === 0) continue
      const code = body.join('\n')
      pushLine({
        text: code,
        entities: links === 'entity' ? [{ type: 'pre', offset: 0, length: code.length, ...(language ? { language } : {}) }] : []
      })
      continue
    }
    if (isTableRow(raw) && TABLE_SEPARATOR.test(lines[index + 1] ?? '')) {
      const rows = [splitRow(raw)]
      index += 2
      while (index < lines.length && isTableRow(lines[index])) rows.push(splitRow(lines[index++]!))
      index -= 1
      for (const row of tableToLines(rows)) pushLine(renderInline(row, links))
      continue
    }
    if (RULE.test(raw)) continue
    let line = raw.replace(/\s+$/, '')
    const heading = /^\s{0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line)
    if (heading) line = heading[1]!
    line = line.replace(/^\s*>\s?/, '')
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (bullet) line = `${bullet[1]}• ${bullet[2]}`
    // A line that is nothing but a markdown image or an html break carries no words.
    line = line.replace(/<br\s*\/?>/gi, '')
    pushLine(renderInline(line, links))
  }
  return { text, entities }
}

/**
 * Paragraphs of a reply as separate texts, at most `maxBubbles` of them: short neighbours merge
 * first, so a one-line lead-in stays with what it introduces only when there are too many pieces.
 * Code fences never split. Each bubble is still subject to the platform's length limit.
 */
export function splitBubbles(markdown: string, maxBubbles = 4): string[] {
  const paragraphs: string[] = []
  let current: string[] = []
  let inFence = false
  for (const line of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence
    if (!inFence && !line.trim()) {
      if (current.length) paragraphs.push(current.join('\n'))
      current = []
      continue
    }
    current.push(line)
  }
  if (current.length) paragraphs.push(current.join('\n'))
  const pieces = paragraphs.filter((paragraph) => renderText(paragraph, 'inline').text.trim())
  const limit = Math.max(1, maxBubbles)
  while (pieces.length > limit) {
    let best = 0
    for (let index = 1; index < pieces.length - 1; index += 1) {
      if (pieces[index]!.length + pieces[index + 1]!.length < pieces[best]!.length + pieces[best + 1]!.length) best = index
    }
    pieces.splice(best, 2, `${pieces[best]}\n\n${pieces[best + 1]}`)
  }
  return pieces
}
