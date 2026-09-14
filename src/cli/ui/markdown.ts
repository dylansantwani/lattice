import { bold, dim, style } from './ansi'

/** Lightweight streaming-safe markdown treatment for the terminal client. */
export function renderMarkdown(markdown: string, options: { color?: boolean } = {}): string {
  const color = { color: options.color !== false }
  return markdown
    .split('\n')
    .map((line) => {
      if (/^#{1,6}\s/.test(line)) return bold(line.replace(/^#{1,6}\s+/, ''), color)
      if (/^```/.test(line)) return dim(line, color)
      return line
        .replace(/`([^`]+)`/g, (_match, code: string) => style(code, '7', color))
        .replace(/\*\*([^*]+)\*\*/g, (_match, text: string) => bold(text, color))
    })
    .join('\n')
}
