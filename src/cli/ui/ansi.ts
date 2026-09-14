const ESC = '\u001b['

export interface AnsiOptions {
  color?: boolean
}

export function style(text: string, code: string, options: AnsiOptions = {}): string {
  return options.color === false ? text : `${ESC}${code}m${text}${ESC}0m`
}

export const bold = (text: string, options?: AnsiOptions): string => style(text, '1', options)
export const dim = (text: string, options?: AnsiOptions): string => style(text, '2', options)
export const red = (text: string, options?: AnsiOptions): string => style(text, '31', options)
export const green = (text: string, options?: AnsiOptions): string => style(text, '32', options)
export const yellow = (text: string, options?: AnsiOptions): string => style(text, '33', options)

export function stripAnsi(text: string): string {
  return text.replace(/[\u001b\u009b][[\]()#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g, '')
}

export function visibleWidth(text: string): number {
  return [...stripAnsi(text)].length
}

export function truncate(text: string, width: number): string {
  if (width <= 0) return ''
  if (visibleWidth(text) <= width) return text
  return [...stripAnsi(text)].slice(0, Math.max(0, width - 1)).join('') + '…'
}
