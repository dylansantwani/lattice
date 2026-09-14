import { bold, dim, green, red, truncate, visibleWidth, yellow, type AnsiOptions } from './ansi'

export interface FrameBlock {
  kind?: 'user' | 'assistant' | 'tool' | 'notice' | 'thinking'
  text: string
}

export interface ViewModel {
  header?: string
  blocks: FrameBlock[]
  todos?: string[]
  composer?: string
  status?: string
  color?: boolean
}

function wrap(text: string, width: number): string[] {
  const out: string[] = []
  for (const source of text.split('\n')) {
    if (!source) { out.push(''); continue }
    let rest = source
    while (visibleWidth(rest) > width) {
      const cut = rest.slice(0, width + 1).lastIndexOf(' ')
      const at = cut > Math.floor(width / 2) ? cut : width
      out.push(rest.slice(0, at))
      rest = rest.slice(at).trimStart()
    }
    out.push(rest)
  }
  return out
}

/** Pure terminal frame renderer. It never reads stdin, writes stdout, or moves the cursor. */
export function renderFrame(model: ViewModel, width: number): string[] {
  const color: AnsiOptions = { color: model.color !== false }
  const inner = Math.max(20, width)
  const lines: string[] = []
  if (model.header) lines.push(bold(truncate(model.header, inner), color))
  for (const block of model.blocks) {
    const prefix = block.kind === 'user' ? '› ' : block.kind === 'tool' ? '→ ' : block.kind === 'thinking' ? '⏺ ' : block.kind === 'notice' ? '⚠ ' : '⏺ '
    const decorate = block.kind === 'notice' ? red : block.kind === 'tool' ? dim : block.kind === 'thinking' ? yellow : (value: string) => value
    for (const line of wrap(block.text, Math.max(1, inner - prefix.length))) lines.push(decorate(prefix + line, color))
  }
  if (model.todos?.length) lines.push(dim(model.todos.join('  '), color))
  lines.push('─'.repeat(inner))
  lines.push(`› ${model.composer ?? ''}`)
  if (model.status) lines.push(dim(model.status, color))
  return lines
}

export const frame = renderFrame
