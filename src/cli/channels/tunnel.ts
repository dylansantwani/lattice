/**
 * Public reachability for the phone endpoint without an account or a domain: a Cloudflare quick
 * tunnel (`cloudflared tunnel --url …`) prints a random https://*.trycloudflare.com URL. The URL
 * changes every time the tunnel restarts, so when a Vapi assistant is configured the gateway
 * re-points that assistant's custom-LLM URL at each new address.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'
import type { Logger } from './types'

const QUICK_TUNNEL_URL = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i

export function findCloudflared(): string | undefined {
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).map((dir) => join(dir, 'cloudflared')),
    join(homedir(), '.local/bin/cloudflared'),
    '/opt/homebrew/bin/cloudflared',
    '/usr/local/bin/cloudflared'
  ]
  return candidates.find((path) => path && existsSync(path))
}

export function parseQuickTunnelUrl(output: string): string | undefined {
  return QUICK_TUNNEL_URL.exec(output)?.[0]
}

export class QuickTunnel {
  private child: ChildProcess | null = null
  private stopped = false
  url?: string

  constructor(
    private readonly port: number,
    private readonly log: Logger,
    private readonly onUrl: (url: string) => void
  ) {}

  start(): void {
    const binary = findCloudflared()
    if (!binary) {
      this.log('tunnel: cloudflared not found; install it (brew install cloudflared) or expose the voice port yourself')
      return
    }
    this.stopped = false
    const child = spawn(binary, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${this.port}`], { stdio: ['ignore', 'pipe', 'pipe'] })
    this.child = child
    let seen = ''
    const scan = (chunk: Buffer): void => {
      if (this.url && seen.length > 8192) return
      seen = (seen + chunk.toString('utf8')).slice(-8192)
      const url = parseQuickTunnelUrl(seen)
      if (url && url !== this.url) {
        this.url = url
        this.log(`tunnel: voice endpoint is public at ${url}/chat/completions`)
        this.onUrl(url)
      }
    }
    child.stdout?.on('data', scan)
    child.stderr?.on('data', scan)
    let restartScheduled = false
    const restart = (why: string): void => {
      this.child = null
      this.url = undefined
      if (this.stopped || restartScheduled) return
      restartScheduled = true
      this.log(`tunnel: ${why}; restarting in 30s`)
      setTimeout(() => {
        if (!this.stopped) this.start()
      }, 30_000)
    }
    // Without an 'error' listener a spawn failure (EACCES, a quarantined binary) is an uncaught
    // exception that takes the whole gateway down. 'exit' may or may not follow an 'error'.
    child.on('error', (error) => restart(`could not run cloudflared (${error.message})`))
    child.on('exit', (code) => restart(`cloudflared exited (${code})`))
  }

  stop(): void {
    this.stopped = true
    this.child?.kill('SIGTERM')
    this.child = null
  }
}

/**
 * Point a Vapi assistant's custom LLM at `baseUrl`. Reads the assistant first and PATCHes the whole
 * model block back so provider, model name and system messages survive.
 */
export async function pointVapiAssistant(options: { apiKey: string; assistantId: string; baseUrl: string; fetchImpl?: typeof fetch }): Promise<void> {
  const fetchImpl = options.fetchImpl ?? fetch
  const endpoint = `https://api.vapi.ai/assistant/${encodeURIComponent(options.assistantId)}`
  const headers = { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' }
  const current = await fetchImpl(endpoint, { headers })
  if (!current.ok) throw new Error(`Vapi GET assistant failed: HTTP ${current.status} ${await current.text()}`)
  const assistant = (await current.json()) as { model?: Record<string, unknown> }
  const model = { ...(assistant.model ?? {}), provider: 'custom-llm', model: (assistant.model?.model as string | undefined) ?? 'lattice-assistant', url: options.baseUrl }
  const patched = await fetchImpl(endpoint, { method: 'PATCH', headers, body: JSON.stringify({ model }) })
  if (!patched.ok) throw new Error(`Vapi PATCH assistant failed: HTTP ${patched.status} ${await patched.text()}`)
}
