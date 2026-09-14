import type { RunEvent } from '@shared/types'
import { buildTimeline, groupTimeline } from '@shared/view/runTimeline'
import { renderMarkdown } from './markdown'

export interface TranscriptOptions {
  color?: boolean
  showThinking?: boolean
}

export function transcriptLines(events: RunEvent[], options: TranscriptOptions = {}): string[] {
  const grouped = groupTimeline(buildTimeline(events))
  const lines: string[] = []
  for (const item of grouped) {
    if (item.kind === 'think' && !options.showThinking) continue
    if (item.kind === 'output') lines.push(renderMarkdown(item.text, options))
    else if (item.kind === 'think') lines.push(`⏺ ${item.text || 'Thinking…'}`)
    else if (item.kind === 'notice') lines.push(`⚠ ${item.text}`)
    else if (item.kind === 'tool') lines.push(`→ ${item.call.tool} ${item.call.ok === false ? '✗' : item.call.ok ? '✓' : '…'}`)
  }
  return lines.flatMap((line) => line.split('\n'))
}

export const renderTranscript = transcriptLines
