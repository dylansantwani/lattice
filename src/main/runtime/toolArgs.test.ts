import { describe, expect, it } from 'vitest'
import { describeUnparseableArgs, executableToolArgs } from './toolArgs'

// Verbatim DeepSeek V4 flash output captured from OmniRoute's call log on 2026-09-11 (run
// 01M294GM7HJ344QM5W3NZRZ3K0): finish_reason tool_calls, every value written, one closing brace
// short — the inner MCP-batch `args` object is never closed before `"tool"`.
const BRACE_SHORT_BATCH = "{\"parallel\": true, \"calls\": [{\"args\": {\"command\": \"find \\\"$HOME/Downloads\\\" \\\"$HOME/Desktop\\\" \\\"$HOME/Pictures\\\" \\\"$HOME/Documents\\\" -maxdepth 5 -type f \\\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' -o -iname '*.webp' -o -iname '*.stl' -o -iname '*.3mf' -o -iname '*.step' -o -iname '*.psd' \\\\) 2>/dev/null | grep -iE 'vinyl|shelf|lounge|mini|record|3d|print' | head -40; echo '--- newest images in Downloads/Desktop ---'; find \\\"$HOME/Downloads\\\" \\\"$HOME/Desktop\\\" -maxdepth 3 -type f \\\\( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' -o -iname '*.heic' \\\\) -newermt '2026-05-01' -exec ls -la {} \\\\; 2>/dev/null | head -25\", \"purpose\": \"Hunt for original product photos and 3D source files\"}, \"tool\": \"shell\"}, {\"args\": {\"calls\": [{\"args\": {\"url\": \"https://sellercentral.amazon.com/performance/account/health/product-policies\", \"session\": \"sc\"}, \"tool\": \"abrowser_open\"}, {\"args\": {\"actions\": [{\"do\": \"wait\", \"ms\": 4500}], \"session\": \"sc\"}, \"tool\": \"abrowser_act\"}, {\"args\": {\"js\": \"(()=>{const rows=[...document.querySelectorAll('.ahd-product-policy-table-row')];const out=rows.map(r=>{const imgs=[...r.querySelectorAll('img')].map(i=>(i.src||'').replace(/^.*\\\\/images\\\\/I\\\\//,'').split('.')[0]).filter(Boolean);return {txt:(r.innerText||'').replace(/\\\\s+/g,' ').slice(0,140),imgs:imgs}}).filter(o=>/copyright/i.test(o.txt));return {copyrightRows:out,allImgCount:document.querySelectorAll('img').length};})()\", \"session\": \"sc\"}, \"tool\": \"abrowser_eval\"}], \"tool\": \"mcp__abrowser__abrowser_batch\"}]}"

describe('executableToolArgs — what a tool call runs with', () => {
  it('runs valid JSON as-is', () => {
    expect(executableToolArgs('{"a":1}')).toBe('{"a":1}')
  })

  it('runs a call that only left closers off its end as the auto-closed object (same text as the wire)', () => {
    expect(executableToolArgs('{"calls": [{"tool": "shell", "args": {"command": "ls"}')).toBe('{"calls": [{"tool": "shell", "args": {"command": "ls"}}]}')
  })

  it('passes the captured mid-stream brace miss through RAW, so the model is told the real fault', () => {
    expect(executableToolArgs(BRACE_SHORT_BATCH)).toBe(BRACE_SHORT_BATCH)
    let err: unknown
    try {
      JSON.parse(BRACE_SHORT_BATCH)
    } catch (e) {
      err = e
    }
    const msg = describeUnparseableArgs('batch', BRACE_SHORT_BATCH, err)
    expect(msg).toContain('Invalid arguments for batch')
    expect(msg).toMatch(/a "\]" at position 1533 arrives while an object is still open/)
    expect(msg).toContain('Received 1535 characters ending in: …')
    expect(msg).toContain('"tool": "mcp__abrowser__abrowser_batch"}]}')
    expect(msg).not.toContain('is required')
  })

  it('passes an unrecoverable buffer through RAW so execution fails on the real text, not on {}', () => {
    const cut = '{"calls": [{"tool": "shell", "args": {"command": "ls'
    expect(executableToolArgs(cut)).toBe(cut)
  })

  it('runs a genuinely empty buffer as {} (schema "required" is the honest error there)', () => {
    expect(executableToolArgs('')).toBe('{}')
    expect(executableToolArgs('   ')).toBe('{}')
  })
})

describe('describeUnparseableArgs — the denial the model reads', () => {
  it('names the tool, the parser message, the size, the tail, and how to fix it', () => {
    const cut = '{"calls": [{"tool": "shell", "args": {"command": "ls'
    let err: unknown
    try {
      JSON.parse(cut)
    } catch (e) {
      err = e
    }
    const msg = describeUnparseableArgs('batch', cut, err)
    expect(msg).toContain('Invalid arguments for batch')
    expect(msg).toContain('not a valid JSON object')
    expect(msg).toContain(`Received ${cut.length} characters`)
    expect(msg).toContain(cut) // short input: the whole thing is the tail
    expect(msg).toContain('balanced, complete JSON')
    // Never the misleading schema message the {} floor used to produce.
    expect(msg).not.toContain('is required')
  })

  it('keeps only the last 160 characters of a long buffer, with an ellipsis', () => {
    const long = '{"x": "' + 'a'.repeat(1000) + '"'
    const msg = describeUnparseableArgs('shell', long, new Error('boom'))
    expect(msg).toContain('…' + long.slice(-160))
    expect(msg).not.toContain('a'.repeat(200))
  })
})
