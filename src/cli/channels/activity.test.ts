import { describe, expect, it } from 'vitest'
import type { RunEvent } from '@shared/types'
import { cleanSegment, describeToolActivity, imagesFromToolResult, progressUpdateText, segmentKey, segmentsFromEvents, splitRunText } from './activity'

let seq = 0
function ev(body: RunEvent['body'], agent?: string): RunEvent {
  seq += 1
  return { id: `e${seq}`, runId: 'r', threadId: 't', seq, ts: seq, body, ...(agent ? { agent } : {}) } as RunEvent
}

describe('describeToolActivity', () => {
  it('uses the purpose a shell command carries, lowercased but keeping names', () => {
    expect(describeToolActivity('shell', { command: 'ssh pve bash -s', purpose: 'Verify imports completed' })).toBe('verify imports completed')
    expect(describeToolActivity('start_job', { command: 'ssh pve ls' })).toBe('working on a remote machine')
    expect(describeToolActivity('shell', { command: '/usr/bin/grep -r x .' })).toBe('running grep')
    expect(describeToolActivity('shell', { purpose: 'eBay listing check' })).toBe('eBay listing check')
  })

  it('names hosts, queries and files, never raw arguments', () => {
    expect(describeToolActivity('web_search', { query: 'deepseek balance api' })).toBe('searching the web for deepseek balance api')
    expect(describeToolActivity('web_search', { query: 'HBO Max price per month 2026 "with ads" "Standard" site:hbomax.com' })).toBe('searching the web for HBO Max price per month 2026 with ads Standard')
    expect(describeToolActivity('web_fetch', { url: 'https://www.sellercentral.amazon.com/imaging?token=SECRET' })).toBe('reading sellercentral.amazon.com')
    expect(describeToolActivity('fs_read', { paths: ['/Users/d/notes/plan.md'] })).toBe('looking through plan.md')
    expect(describeToolActivity('mcp__latchkey__latchkey_open', { url: 'https://ebay.com/sh/ovw' })).toBe('opening ebay.com')
    expect(describeToolActivity('browser_screenshot', {})).toBe('looking at the screen')
    expect(describeToolActivity('mcp__bambu__get_status', { printer: 'x1c' })).toBe('using bambu')
  })

  it('looks inside a batch and stays quiet for bookkeeping tools', () => {
    expect(describeToolActivity('batch', { calls: [{ tool: 'web_search', args: { query: 'proton m247' } }] })).toBe('searching the web for proton m247')
    expect(describeToolActivity('todo_write', { todos: [] })).toBeUndefined()
    expect(describeToolActivity('memory_save', { content: 'x' })).toBeUndefined()
    expect(describeToolActivity('job_status', {})).toBeUndefined()
  })
})

describe('progressUpdateText', () => {
  it('varies with each update and says what is happening', () => {
    const texts = [0, 1, 2, 3].map((count) => progressUpdateText('reading ebay.com', 185_000, count))
    expect(new Set(texts).size).toBe(4)
    expect(texts[0]).toBe('still on it, reading ebay.com')
    expect(texts[2]).toBe('3 min in and still working, reading ebay.com')
    expect(progressUpdateText(undefined, 40_000, 0)).toBe('still on it')
  })
})

describe('splitRunText', () => {
  it('splits a run where it called tools and keeps the streaming tail open', () => {
    const events = [
      ev({ type: 'text.delta', text: 'on it, ' }),
      ev({ type: 'text.delta', text: 'checking.' }),
      ev({ type: 'tool.proposed', callId: 'c', tool: 'web_fetch', args: {}, riskTier: 'R0' } as RunEvent['body']),
      ev({ type: 'tool.started', callId: 'c', tool: 'web_fetch', args: {} } as RunEvent['body']),
      ev({ type: 'text.delta', text: '$1.32 left' })
    ]
    expect(splitRunText(events)).toEqual({ closed: ['on it, checking.'], open: '$1.32 left' })
    expect(segmentsFromEvents(events)).toEqual(['on it, checking.', '$1.32 left'])
  })

  it('ignores subagent text and drops a rewound attempt', () => {
    const events = [
      ev({ type: 'text.delta', text: 'sub says hi' }, 'agent1'),
      ev({ type: 'text.delta', text: 'broken half' }),
      ev({ type: 'retry', attempt: 1, reason: 'socket', rewound: true } as RunEvent['body']),
      ev({ type: 'text.delta', text: 'clean answer' })
    ]
    expect(segmentsFromEvents(events)).toEqual(['clean answer'])
  })
})

describe('segments as texts', () => {
  it('removes the silent token and compares ignoring markdown and case', () => {
    expect(cleanSegment('NO_REPLY')).toBe('')
    expect(cleanSegment('nothing new there. NO_REPLY')).toBe('nothing new there.')
    expect(segmentKey('**Done**  now')).toBe(segmentKey('done now'))
  })
})

describe('imagesFromToolResult', () => {
  it('pulls the image out of show_image, show_image_data and fetch_image results only', () => {
    expect(imagesFromToolResult('show_image', { type: 'image', mimeType: 'image/png', data: 'AAAA', path: '/tmp/x.png', caption: 'the captcha' })).toEqual([
      { mime: 'image/png', data: 'AAAA', path: '/tmp/x.png', caption: 'the captcha' }
    ])
    expect(imagesFromToolResult('show_image_data', { type: 'image', mimeType: 'image/jpeg', data: 'data:image/jpeg;base64,BBBB' })).toEqual([{ mime: 'image/jpeg', data: 'BBBB' }])
    expect(imagesFromToolResult('fetch_image', { type: 'image', data: 'CCCC', url: 'https://x' })).toEqual([{ mime: 'image/png', data: 'CCCC' }])
    expect(imagesFromToolResult('mcp__browser__screenshot', { type: 'image', data: 'DDDD' })).toEqual([])
    expect(imagesFromToolResult('show_image', { error: 'nope' })).toEqual([])
  })
})
