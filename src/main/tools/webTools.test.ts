import { afterEach, describe, expect, it, vi } from 'vitest'
import { extractReadablePage, parseBingRss, webFetchTool, webSearchTool } from './webTools'
import type { ToolContext } from './types'

// Keep page-fetch tests deterministic while still exercising the public-host check.
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
}))

const ctx: ToolContext = {
  threadMeta: { id: 'thread-1', workspaceId: 'workspace-1' } as ToolContext['threadMeta'],
  workspace: { id: 'workspace-1', name: 'test', roots: ['/tmp'] } as ToolContext['workspace'],
  runId: 'run-1',
  signal: new AbortController().signal
}

afterEach(() => {
  vi.unstubAllGlobals()
})

const rss = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <item>
    <title><![CDATA[First &amp; Best]]></title>
    <link>https://example.com/first?a=1&amp;b=2</link>
    <description><![CDATA[An <b>important</b> result &amp; summary.]]></description>
    <pubDate>Tue, 01 Sep 2026 12:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Second result</title>
    <link>https://example.org/second</link>
    <description>Another result</description>
  </item>
  <item>
    <title>Not a web URL</title>
    <link>ftp://example.net/file</link>
  </item>
</channel></rss>`

describe('parseBingRss', () => {
  it('extracts safe HTTP(S) result fields and decodes markup/entities', () => {
    expect(parseBingRss(rss)).toEqual([
      {
        title: 'First & Best',
        url: 'https://example.com/first?a=1&b=2',
        snippet: 'An important result & summary.',
        publishedAt: 'Tue, 01 Sep 2026 12:00:00 GMT'
      },
      { title: 'Second result', url: 'https://example.org/second', snippet: 'Another result' }
    ])
  })

  it('caps results and rejects non-RSS responses', () => {
    expect(parseBingRss(rss, 1)).toHaveLength(1)
    expect(() => parseBingRss('<html><body>blocked</body></html>')).toThrow(/unexpected response/)
  })
})

describe('extractReadablePage', () => {
  it('keeps readable page text while dropping executable and hidden blocks', () => {
    const page = extractReadablePage(`
      <html><head><title> A &amp; B </title><style>body{display:none}</style></head>
      <body><!-- hidden --><main><h1>Hello</h1><p>Useful <strong>source</strong>.</p>
      <script>alert('ignore')</script><svg><text>ignore</text></svg></main></body></html>
    `)
    expect(page.title).toBe('A & B')
    expect(page.text).toContain('Hello')
    expect(page.text).toContain('Useful source.')
    expect(page.text).not.toContain('display:none')
    expect(page.text).not.toContain('alert')
    expect(page.text).not.toContain('ignore')
  })
})

describe('web_search tool', () => {
  it('queries the fixed Bing RSS endpoint and returns structured results', async () => {
    const fetchMock = vi.fn(async () => new Response(rss, { status: 200, headers: { 'content-type': 'application/rss+xml' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = (await webSearchTool.run({ query: 'electron web tools', max_results: 4 }, ctx)) as {
      query: string
      provider: string
      results: unknown[]
      note: string
    }
    expect(result.query).toBe('electron web tools')
    expect(result.provider).toBe('Bing')
    expect(result.results).toHaveLength(2)
    expect(result.note).toMatch(/untrusted/i)
    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>
    const [requestUrl, init] = calls[0]!
    expect(requestUrl.toString()).toContain('format=rss')
    expect(requestUrl.searchParams.get('q')).toBe('electron web tools')
    expect(requestUrl.searchParams.get('count')).toBe('4')
    expect(init.redirect).toBe('error')
  })

  it('rejects a blank query before making a request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(webSearchTool.run({ query: '  ' }, ctx)).rejects.toThrow(/non-empty/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('web_fetch tool', () => {
  it('fetches a public page with validated redirects and returns bounded readable text', async () => {
    const html = '<html><head><title>Docs</title></head><body><main><h1>Hello</h1><p>Source text.</p></main></body></html>'
    const fetchMock = vi.fn(async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
    vi.stubGlobal('fetch', fetchMock)

    const result = (await webFetchTool.run({ url: 'https://example.com/docs', max_chars: 1_000 }, ctx)) as {
      url: string
      ok: boolean
      status: number
      title?: string
      content: string
      truncated: boolean
    }
    expect(result.url).toBe('https://example.com/docs')
    expect(result.ok).toBe(true)
    expect(result.status).toBe(200)
    expect(result.title).toBe('Docs')
    expect(result.content).toContain('Source text.')
    expect(result.truncated).toBe(false)
    const calls = fetchMock.mock.calls as unknown as Array<[URL, RequestInit]>
    expect(calls[0]![1].redirect).toBe('manual')
  })

  it('rejects local and non-http URLs before any network request', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    await expect(webFetchTool.run({ url: 'http://127.0.0.1:8080/' }, ctx)).rejects.toThrow(/private\/internal/)
    await expect(webFetchTool.run({ url: 'file:///etc/passwd' }, ctx)).rejects.toThrow(/only http\(s\)/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('reports an HTTP error status as a result instead of failing the call', async () => {
    const fetchMock = vi.fn(
      async () => new Response('Not Found', { status: 404, statusText: 'Not Found', headers: { 'content-type': 'text/plain' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = (await webFetchTool.run({ url: 'https://example.com/robots.txt' }, ctx)) as {
      ok: boolean
      status: number
      statusText: string
      content: string
      note: string
    }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(404)
    expect(result.statusText).toBe('Not Found')
    expect(result.content).toBe('Not Found')
    expect(result.note).toMatch(/404/)
  })

  it('keeps an HTML error page readable and bounded', async () => {
    const body = `<html><head><title>Blocked</title></head><body><p>Rate limited. ${'x'.repeat(5_000)}</p></body></html>`
    const fetchMock = vi.fn(
      async () => new Response(body, { status: 429, statusText: 'Too Many Requests', headers: { 'content-type': 'text/html' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = (await webFetchTool.run({ url: 'https://example.com/api' }, ctx)) as {
      ok: boolean
      status: number
      content: string
      truncated: boolean
    }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(429)
    expect(result.content).toContain('Rate limited.')
    expect(result.content.length).toBeLessThanOrEqual(2_001)
    expect(result.truncated).toBe(true)
  })

  it('reports an error status even when the error body is not readable text', async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(Buffer.from([0, 1, 2]), { status: 503, statusText: 'Service Unavailable', headers: { 'content-type': 'application/octet-stream' } })
    )
    vi.stubGlobal('fetch', fetchMock)

    const result = (await webFetchTool.run({ url: 'https://example.com/down' }, ctx)) as {
      ok: boolean
      status: number
      content: string
      note: string
    }
    expect(result.ok).toBe(false)
    expect(result.status).toBe(503)
    expect(result.content).toBe('')
    expect(result.note).toMatch(/no readable body/)
  })

  it('does not pass binary responses into the model context', async () => {
    const fetchMock = vi.fn(async () => new Response(Buffer.from([0, 1, 2]), { status: 200, headers: { 'content-type': 'application/pdf' } }))
    vi.stubGlobal('fetch', fetchMock)
    await expect(webFetchTool.run({ url: 'https://example.com/file.pdf' }, ctx)).rejects.toThrow(/non-readable/)
  })
})
