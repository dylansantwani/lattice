import { describe, expect, it } from 'vitest'
import type { ApprovalRequest, AskRequest } from '@shared/types'
import {
  approvalPrompt,
  askPrompt,
  assistantGoal,
  chunkMarkdown,
  extractLocalFileRefs,
  GATEWAY_COMMANDS,
  HELP_TEXT,
  inboundHeader,
  isChannelMessage,
  isVoiceMessage,
  parseApprovalReply,
  parseCommand,
  resolveAskAnswer,
  speakable
} from './format'

const AT = Date.UTC(2026, 8, 12, 21, 32)

describe('inbound header', () => {
  it('names the channel and the local time, and is recognizable afterwards', () => {
    const header = inboundHeader('telegram', AT, 'America/Chicago')
    expect(header).toBe('[Texted via Telegram · Sat, Sep 12, 4:32 PM CDT · text back short and plain]')
    expect(isChannelMessage(`${header}\nhey`)).toBe(true)
    expect(isVoiceMessage(header)).toBe(false)
  })

  it('marks phone calls as spoken turns', () => {
    const header = inboundHeader('voice', AT, 'America/Chicago')
    expect(header).toBe('[Phone call · Sat, Sep 12, 4:32 PM CDT · answer in 1-3 short spoken sentences, no formatting]')
    expect(header).toContain('spoken sentences')
    expect(isVoiceMessage(header)).toBe(true)
    expect(isChannelMessage(header)).toBe(true)
  })

  it('does not mistake desktop-typed text for a channel message', () => {
    expect(isChannelMessage('[Texted] nope')).toBe(false)
    expect(isChannelMessage('fix the build')).toBe(false)
    expect(isChannelMessage(undefined)).toBe(false)
  })
})

describe('speakable', () => {
  it('strips syntax a voice would read out', () => {
    expect(speakable('**Sure**, check `npm` at [the site](https://x.y)')).toBe('Sure, check npm at the site')
  })
})

describe('chunkMarkdown', () => {
  it('returns short text as one chunk and nothing for blank text', () => {
    expect(chunkMarkdown('hello', 100)).toEqual(['hello'])
    expect(chunkMarkdown('   ', 100)).toEqual([])
  })

  it('splits on paragraph boundaries within the budget', () => {
    const paragraphs = Array.from({ length: 6 }, (_, index) => `Paragraph ${index} ${'x'.repeat(60)}`)
    const chunks = chunkMarkdown(paragraphs.join('\n\n'), 200)
    expect(chunks.length).toBeGreaterThan(1)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(200)
    expect(chunks.join('\n\n').replace(/\s+/g, ' ')).toBe(paragraphs.join('\n\n').replace(/\s+/g, ' '))
  })

  it('hard-splits a single oversized paragraph at word boundaries', () => {
    const words = Array.from({ length: 200 }, (_, index) => `word${index}`).join(' ')
    const chunks = chunkMarkdown(words, 120)
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(120)
    expect(chunks.join(' ').split(/\s+/)).toEqual(words.split(' '))
  })

  it('closes and reopens a code fence that spans chunks', () => {
    const code = Array.from({ length: 40 }, (_, index) => `line ${index} ${'y'.repeat(20)}`).join('\n\n')
    const chunks = chunkMarkdown(`intro\n\n\`\`\`\n${code}\n\`\`\`\n\noutro`, 300)
    expect(chunks.length).toBeGreaterThan(2)
    for (const chunk of chunks) {
      const fences = chunk.split('\n').filter((line) => line.trim().startsWith('```')).length
      expect(fences % 2).toBe(0)
      expect(chunk.length).toBeLessThanOrEqual(300)
    }
  })
})

describe('approvals and questions', () => {
  const approval = { id: 'ap1', runId: 'r', threadId: 't', callId: 'c', tool: 'shell', args: {}, summary: 'Run `rm -rf build`', resource: 'shell', action: 'execute', riskTier: 'R2' } as unknown as ApprovalRequest

  it('parses natural yes/no/always replies and ignores everything else', () => {
    for (const yes of ['y', 'Yes', 'ok', 'go ahead', 'approve', '👍', 'yes!']) expect(parseApprovalReply(yes)).toBe('allow')
    for (const no of ['n', 'No', 'nope', 'deny', 'cancel', '👎']) expect(parseApprovalReply(no)).toBe('deny')
    expect(parseApprovalReply('always')).toBe('always')
    expect(parseApprovalReply('yes but first check the logs')).toBeUndefined()
  })

  it('offers yes/no/always buttons that carry the request id', () => {
    const prompt = approvalPrompt(approval)
    expect(prompt.text).toBe("ok to run 'rm -rf build'?")
    expect(prompt.buttons[0]!.map((button) => button.data)).toEqual(['lat:ap:allow:ap1', 'lat:ap:deny:ap1', 'lat:ap:always:ap1'])
  })

  it('shows a shell command in plain words plus the exact command, without risk jargon', () => {
    const shell = { ...approval, args: { command: "curl -s -m 20 'https://wttr.in/Naperville?format=j1' | python3 -c \"\nimport sys,json\"", purpose: 'Get current Naperville weather' } } as unknown as ApprovalRequest
    const prompt = approvalPrompt(shell)
    expect(prompt.text).toBe("ok to run this? get current Naperville weather\n`curl -s -m 20 'https://wttr.in/Naperville?format=j1' | python3 -c \" import sys,json\"`")
    expect(prompt.text).not.toContain('R2')
    const risky = approvalPrompt({ ...shell, riskTier: 'R3', args: { command: 'rm -rf ~/old', background: true } } as unknown as ApprovalRequest, { buttons: false })
    expect(risky.text).toBe('⚠️ ok to start this in the background?\n`rm -rf ~/old`\n(reply yes, no, or always)')
  })

  it('numbers choice questions and maps a typed number back to the option', () => {
    const ask = { id: 'q1', runId: 'r', threadId: 't', callId: 'c', question: 'Which flight?', kind: 'choice', options: [{ label: '8am' }, { label: '2pm', recommended: true }] } as AskRequest
    const prompt = askPrompt(ask)
    expect(prompt.text).toContain('1. 8am')
    expect(prompt.text).toContain('2. 2pm (recommended)')
    expect(prompt.buttons.map((row) => row[0]!.data)).toEqual(['lat:ask:q1:1', 'lat:ask:q1:2'])
    expect(resolveAskAnswer(ask, '2')).toBe('2pm')
    expect(resolveAskAnswer(ask, 'neither, the red-eye')).toBe('neither, the red-eye')
  })

  it('normalizes confirm answers to yes/no', () => {
    const ask = { id: 'q2', runId: 'r', threadId: 't', callId: 'c', question: 'Send it?', kind: 'confirm' } as AskRequest
    expect(resolveAskAnswer(ask, 'yep')).toBe('yes')
    expect(resolveAskAnswer(ask, 'nah')).toBe('no')
  })
})

describe('parseCommand', () => {
  it('parses commands with and without arguments, including Telegram @bot suffixes', () => {
    expect(parseCommand('/new')).toEqual({ name: 'new', arg: '' })
    expect(parseCommand('/model  deepseek v4 ')).toEqual({ name: 'model', arg: 'deepseek v4' })
    expect(parseCommand('/start@LatticeBot 123456')).toEqual({ name: 'start', arg: '123456' })
    expect(parseCommand('/remember Sam\'s birthday\nis May 3')).toEqual({ name: 'remember', arg: "Sam's birthday\nis May 3" })
  })

  it('does not treat paths or prose as commands', () => {
    expect(parseCommand('/Users/dylan/file.txt')).toBeUndefined()
    expect(parseCommand('what is /new')).toBeUndefined()
  })
})

describe('assistantGoal', () => {
  it('names the owner, explains the envelope, the memory format, and ends with their instructions', () => {
    const goal = assistantGoal('Dylan', { persona: 'Call me D.', timeZone: 'America/Chicago', inbox: '/Users/d/LatticeAssistant/Inbox' })
    expect(goal).toContain("You are Dylan's personal assistant")
    expect(goal).toContain('America/Chicago')
    expect(goal).toContain('[Texted via Telegram')
    expect(goal).toContain('/Users/d/LatticeAssistant/Inbox')
    expect(goal).toContain('Person — <name> (<relationship>)')
    expect(goal.endsWith('Call me D.')).toBe(true)
    // The texting voice lives in the runtime's texting prompt, not here.
    expect(goal).not.toContain('NO_REPLY')
  })

  it('carries the texting voice itself for a runtime that predates texting threads', () => {
    const goal = assistantGoal('Dylan', { runtimeTexting: false })
    expect(goal).toContain('no markdown')
    expect(goal).toContain('NO_REPLY')
    expect(goal).toContain('show_image')
  })
})

describe('local file references in replies', () => {
  it('pulls out images and links to absolute paths and leaves the words', () => {
    const { text, refs } = extractLocalFileRefs('Here is the chart:\n\n![Weekly sales](/Users/me/LatticeAssistant/chart.png)\n\nFull [report](file:///Users/me/My%20Report.pdf) attached.')
    expect(text).toBe('Here is the chart:\n\nFull report attached.')
    expect(refs).toEqual([
      { path: '/Users/me/LatticeAssistant/chart.png', label: 'Weekly sales', image: true },
      { path: '/Users/me/My Report.pdf', label: 'report', image: false }
    ])
  })

  it('ignores web links, relative paths, and anything inside code', () => {
    const markdown = 'See [docs](https://example.com/a.png) and [notes](notes.md).\n`![x](/tmp/in-code.png)`\n```\n![y](/tmp/in-fence.png)\n```'
    const { text, refs } = extractLocalFileRefs(markdown)
    expect(refs).toEqual([])
    expect(text).toBe(markdown)
  })

  it('accepts angle-bracketed paths with spaces', () => {
    expect(extractLocalFileRefs('![](</tmp/screen shot.png>)').refs).toEqual([{ path: '/tmp/screen shot.png', label: '', image: true }])
  })

  it('keeps balanced parentheses in bare paths and any character inside angle brackets', () => {
    const { text, refs } = extractLocalFileRefs('Two copies: ![a](/Users/me/Desktop/Screenshot (1).png) and [b](</tmp/odd name) (draft).pdf>). Done.')
    expect(refs).toEqual([
      { path: '/Users/me/Desktop/Screenshot (1).png', label: 'a', image: true },
      { path: '/tmp/odd name) (draft).pdf', label: 'b', image: false }
    ])
    expect(text).toBe('Two copies:  and b. Done.')
  })
})

describe('gateway commands', () => {
  it('builds the help text from the same list Telegram shows in its menu', () => {
    for (const command of GATEWAY_COMMANDS) expect(HELP_TEXT).toContain(`/${command.name}`)
    expect(HELP_TEXT).toContain('/model [name]: show or switch the model')
    expect(GATEWAY_COMMANDS.every((command) => /^[a-z]{1,32}$/.test(command.name))).toBe(true)
  })

  it('tells the assistant which files can reach the phone', () => {
    expect(assistantGoal('Dylan')).toContain('never anything in a hidden folder or ~/Library')
  })
})
