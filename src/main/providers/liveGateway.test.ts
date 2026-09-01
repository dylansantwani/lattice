/**
 * Live integration tests against the user's real OmniRoute gateway. Opt-in — they cost real
 * tokens and need the gateway running:
 *
 *     LATTICE_LIVE=1 npx vitest run src/main/providers/liveGateway.test.ts
 *
 * Optionally target other models:
 *     LATTICE_LIVE_MODEL=cc/claude-fable-5 LATTICE_LIVE_MODEL2=openrouter/meta/muse-spark-1.2-contributor …
 *
 * Provider credentials come from LATTICE_LIVE_BASE / LATTICE_LIVE_KEY when set, otherwise from
 * the first enabled provider in the local Lattice settings DB — the same config the app uses.
 */
import { existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ProviderConfig, TurnTelemetry } from '@shared/types'
import { streamChat, type WireMessage, type WireTool } from './openaiCompat'
import { MEMORY_RECALL_NOTE } from '../runtime/runManager'

const LIVE = !!process.env.LATTICE_LIVE

function providerFromDb(): { baseUrl: string; apiKey: string } | null {
  const db = join(homedir(), 'Library/Application Support/Lattice/data/lattice.db')
  if (!existsSync(db)) return null
  try {
    // sqlite3 CLI keeps this file dependency-free; the settings row is tiny.
    const raw = execFileSync('sqlite3', [db, "SELECT value_json FROM settings WHERE key='app'"], {
      encoding: 'utf8'
    }).trim()
    const parsed = JSON.parse(raw) as { providers?: { baseUrl?: string; apiKey?: string; enabled?: boolean }[] }
    const p = parsed.providers?.find((x) => x.enabled && x.baseUrl)
    return p?.baseUrl ? { baseUrl: p.baseUrl, apiKey: p.apiKey ?? '' } : null
  } catch {
    return null
  }
}

function liveProvider(): ProviderConfig {
  const fromDb = providerFromDb()
  const baseUrl = process.env.LATTICE_LIVE_BASE ?? fromDb?.baseUrl ?? 'http://localhost:20128'
  const apiKey = process.env.LATTICE_LIVE_KEY ?? fromDb?.apiKey ?? ''
  return { id: 'live', label: 'live', kind: 'openai-compat', baseUrl, apiKey, enabled: true, promptCaching: true }
}

const MODEL = process.env.LATTICE_LIVE_MODEL ?? 'cc/claude-fable-5'
const MODEL2 = process.env.LATTICE_LIVE_MODEL2 ?? 'openrouter/meta/muse-spark-1.2-contributor'

/** A stable multi-KB system prompt (above every backend's minimum cacheable size), unique per run. */
function bigSystem(tag: string): string {
  return (
    `You are Lattice (live cache test ${tag} ${Date.now()}). Answer extremely briefly.\n` +
    'Stable filler establishing a realistic system-prompt size for the cache probe. '.repeat(90) +
    '\n\n' + MEMORY_RECALL_NOTE
  )
}

interface CallResult {
  text: string
  usage: Partial<TurnTelemetry>
  toolCalls: { name: string; args: string }[]
}

async function call(provider: ProviderConfig, messages: WireMessage[], tools: WireTool[] = []): Promise<CallResult> {
  let text = ''
  let usage: Partial<TurnTelemetry> = {}
  const toolCalls = new Map<number, { name: string; args: string }>()
  for await (const chunk of streamChat(provider, {
    model: MODEL,
    messages,
    tools,
    maxTokens: 60,
    cache: true,
    signal: AbortSignal.timeout(120000)
  })) {
    if (chunk.type === 'text') text += chunk.text
    if (chunk.type === 'usage') usage = { ...usage, ...chunk.usage }
    if (chunk.type === 'tool_call_delta') {
      const c = toolCalls.get(chunk.index) ?? { name: '', args: '' }
      if (chunk.name) c.name += chunk.name
      if (chunk.argsDelta) c.args += chunk.argsDelta
      toolCalls.set(chunk.index, c)
    }
  }
  return { text, usage, toolCalls: [...toolCalls.values()] }
}

const hitRate = (u: Partial<TurnTelemetry>): number =>
  u.tokensIn ? (u.cacheReadTokens ?? 0) / u.tokensIn : 0

describe.runIf(LIVE)('live gateway — prompt caching through the real request path', () => {
  it(
    `${MODEL}: turn-over-turn hit rate ≥ 85% from turn 2`,
    async () => {
      const provider = liveProvider()
      const wire: WireMessage[] = [{ role: 'system', content: bigSystem('turns') }]
      const rates: number[] = []
      for (let t = 1; t <= 3; t++) {
        wire.push({ role: 'user', content: `Reply with just the number ${t}.` })
        const r = await call(provider, wire)
        rates.push(hitRate(r.usage))
        wire.push({ role: 'assistant', content: r.text || String(t) })
      }
      console.log(`[live] ${MODEL} turn hit rates: ${rates.map((r) => `${Math.round(r * 100)}%`).join(' ')}`)
      expect(rates[1]).toBeGreaterThanOrEqual(0.85)
      expect(rates[2]).toBeGreaterThanOrEqual(0.85)
    },
    600000
  )

  it(
    `${MODEL}: agentic tool-round tail is cached (the round-2 read)`,
    async () => {
      const provider = liveProvider()
      const wire: WireMessage[] = [
        { role: 'system', content: bigSystem('tools') },
        { role: 'user', content: 'Acknowledge with OK.' }
      ]
      const r1 = await call(provider, wire)
      wire.push({ role: 'assistant', content: r1.text || 'OK' })
      wire.push({ role: 'user', content: 'Acknowledge again with OK.' })
      wire.push({
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'live_c1', type: 'function', function: { name: 'probe', arguments: '{}' } }]
      })
      wire.push({
        role: 'tool',
        tool_call_id: 'live_c1',
        name: 'probe',
        content: JSON.stringify({ ok: true, data: 'tool output '.repeat(120) })
      })
      const r2 = await call(provider, wire)
      const rate = hitRate(r2.usage)
      console.log(`[live] ${MODEL} tool-round hit: ${Math.round(rate * 100)}% (read ${r2.usage.cacheReadTokens} of ${r2.usage.tokensIn})`)
      // The prior turn's prefix (system + turn 1) must be served from cache even though the
      // request now ends in a tool-result tail — the case the last-user-only stamping broke.
      expect(rate).toBeGreaterThanOrEqual(0.5)
      expect(r2.usage.cacheReadTokens ?? 0).toBeGreaterThan(0)
    },
    600000
  )

  it(
    `${MODEL2}: cache telemetry is reported (hit rate is upstream-dependent, logged only)`,
    async () => {
      const provider = liveProvider()
      const wire: WireMessage[] = [{ role: 'system', content: bigSystem('m2') }]
      const rates: number[] = []
      for (let t = 1; t <= 4; t++) {
        wire.push({ role: 'user', content: `Reply with just the number ${t}.` })
        let usage: Partial<TurnTelemetry> = {}
        let text = ''
        for await (const chunk of streamChat(provider, {
          model: MODEL2,
          messages: wire,
          maxTokens: 30,
          cache: true,
          signal: AbortSignal.timeout(120000)
        })) {
          if (chunk.type === 'text') text += chunk.text
          if (chunk.type === 'usage') usage = { ...usage, ...chunk.usage }
        }
        rates.push(hitRate(usage))
        expect(usage.tokensIn ?? 0).toBeGreaterThan(0) // telemetry must flow for the UI chips
        wire.push({ role: 'assistant', content: text || String(t) })
      }
      console.log(
        `[live] ${MODEL2} turn hit rates: ${rates.map((r) => `${Math.round(r * 100)}%`).join(' ')} ` +
          '(this upstream load-balances replicas; per-turn hits vary server-side)'
      )
    },
    600000
  )
})

describe.runIf(LIVE)('live gateway — on-demand memory recall behavior', () => {
  const memorySearchTool: WireTool = {
    type: 'function',
    function: {
      name: 'memory_search',
      description:
        'Keyword search over saved memory. Matches any word in the query, ranked by how many ' +
        'query words a memory contains.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
    }
  }

  it(
    `${MODEL}: calls memory_search when asked something that depends on stored context`,
    async () => {
      const provider = liveProvider()
      const r = await call(
        provider,
        [
          { role: 'system', content: bigSystem('recall') },
          { role: 'user', content: 'What did I say my preferred deploy target was?' }
        ],
        [memorySearchTool]
      )
      const called = r.toolCalls.map((c) => c.name)
      console.log(`[live] ${MODEL} recall tool calls: ${JSON.stringify(called)} args=${JSON.stringify(r.toolCalls)}`)
      expect(called).toContain('memory_search')
    },
    600000
  )

  it(
    `${MODEL}: does NOT search memory for a question that cannot depend on stored context`,
    async () => {
      const provider = liveProvider()
      const r = await call(
        provider,
        [
          { role: 'system', content: bigSystem('norecall') },
          { role: 'user', content: 'What is 17 * 23? Reply with just the number.' }
        ],
        [memorySearchTool]
      )
      const called = r.toolCalls.map((c) => c.name)
      console.log(`[live] ${MODEL} no-recall tool calls: ${JSON.stringify(called)} text=${r.text.trim()}`)
      expect(called).not.toContain('memory_search')
    },
    600000
  )
})

describe.runIf(LIVE)('live gateway — deferred tool discovery behavior', () => {
  it(
    `${MODEL}: calls find_tools when the task needs a capability outside the core set`,
    async () => {
      const { findToolsTool } = await import('../runtime/toolCatalog')
      const { toWireTool, describeTools } = await import('../runtime/runManager')
      const provider = liveProvider()
      const coreDesc = describeTools([findToolsTool])
      const r = await call(
        provider,
        [
          { role: 'system', content: bigSystem('discover') + '\n\n' + coreDesc },
          { role: 'user', content: 'Take a screenshot of the page currently open in my browser.' }
        ],
        [toWireTool(findToolsTool)]
      )
      const called = r.toolCalls.map((c) => c.name)
      console.log(`[live] ${MODEL} discovery calls: ${JSON.stringify(r.toolCalls)}`)
      expect(called).toContain('find_tools')
    },
    600000
  )
})

describe.runIf(LIVE)('live gateway — self-learning distillation', () => {
  it(
    `${MODEL}: distills a durable preference from a transcript as parseable JSON`,
    async () => {
      const { buildLearnPrompt, parseLearnings } = await import('../runtime/selfLearn')
      const provider = liveProvider()
      const transcript = [
        'User: From now on always deploy my apps to Fly.io, never Vercel — I moved everything there.',
        'Assistant: Understood — Fly.io is your deploy target going forward.',
        'User: Great. Also ship the api service first when both changed.',
        'Assistant: Noted: deploy order is api before web when both have changes.'
      ].join('\n\n')
      let out = ''
      for await (const chunk of streamChat(provider, {
        model: MODEL,
        messages: [{ role: 'user', content: buildLearnPrompt(transcript) }],
        maxTokens: 600,
        cache: false,
        signal: AbortSignal.timeout(120000)
      })) {
        if (chunk.type === 'text') out += chunk.text
      }
      const drafts = parseLearnings(out)
      console.log(`[live] ${MODEL} distilled ${drafts.length} learning(s): ${JSON.stringify(drafts)}`)
      expect(drafts.length).toBeGreaterThanOrEqual(1)
      expect(drafts.some((d) => /fly\.io/i.test(d.content))).toBe(true)
      for (const d of drafts) {
        expect(d.confidence).toBeGreaterThanOrEqual(0)
        expect(d.confidence).toBeLessThanOrEqual(1)
        expect(d.content.length).toBeGreaterThan(0)
      }
    },
    600000
  )
})

// Keep vitest happy when the suite is skipped (no LATTICE_LIVE): at least one always-on test.
describe('liveGateway helpers', () => {
  it('hitRate is 0 when no tokens are reported', () => {
    expect(hitRate({})).toBe(0)
    expect(hitRate({ tokensIn: 100, cacheReadTokens: 90 })).toBe(0.9)
  })

  it('reads provider config from the app DB or env without throwing', () => {
    expect(() => liveProvider()).not.toThrow()
    const p = liveProvider()
    expect(p.baseUrl).toMatch(/^https?:\/\//)
  })
})
