import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpServerStatus } from '@shared/types'
import type { ToolContext, ToolDefinition } from '../tools/types'
import { listMcpConfigs } from '../store/eventStore'
import { cachedContextLength } from '../providers/registry'
import { scaleContextCap } from '@shared/contextScale'
import { shapeMcpResult } from './resultShape'

const CONNECT_TIMEOUT_MS = 15000

/** Same budget as built-in command output (48KB baseline, 8KB floor), scaled to the model's window. */
const MCP_OUTPUT_FULL = 48 * 1024
const MCP_OUTPUT_MIN = 8 * 1024
export function mcpOutputCap(ctx: Pick<ToolContext, 'effectiveModel' | 'threadMeta'>): number {
  return scaleContextCap(cachedContextLength(ctx.effectiveModel ?? ctx.threadMeta.model), MCP_OUTPUT_FULL, MCP_OUTPUT_MIN)
}

function withTimeout<T>(promise: Promise<T>, ms: number, onTimeout: () => string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(onTimeout())), ms)
    promise.then(
      (v) => {
        clearTimeout(timer)
        resolve(v)
      },
      (e) => {
        clearTimeout(timer)
        reject(e)
      }
    )
  })
}

interface LiveServer {
  config: McpServerConfig
  client: Client | null
  status: McpServerStatus
}

const servers = new Map<string, LiveServer>()

/** Sanitize a server label + tool name into a stable, model-safe tool id. */
function toolId(serverId: string, name: string): string {
  const safeServer = serverId.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 24)
  return `mcp__${safeServer}__${name}`.slice(0, 64)
}

function makeTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
  if (config.transport === 'http') {
    if (!config.url) throw new Error('HTTP MCP server requires a url')
    return new StreamableHTTPClientTransport(new URL(config.url))
  }
  if (!config.command) throw new Error('stdio MCP server requires a command')
  // Defensive env hygiene before spawning a plain `node` child from Electron: drop vars that
  // can make a child Node misbehave if they happen to be present — NODE_OPTIONS (may carry a
  // dev/loader `--import`) and ELECTRON_RUN_AS_NODE / other ELECTRON_*. Mirrors the MCP SDK's
  // own default-environment approach.
  const BLOCK = new Set(['NODE_OPTIONS', 'ELECTRON_RUN_AS_NODE'])
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (BLOCK.has(k) || k.startsWith('ELECTRON_')) continue
    env[k] = v
  }
  return new StdioClientTransport({
    command: config.command,
    args: config.args ?? [],
    env: { ...env, ...(config.env ?? {}) },
    stderr: 'pipe'
  })
}

/** Connect (or reconnect) a single server and refresh its tool list + status. */
async function connectServer(config: McpServerConfig): Promise<LiveServer> {
  const existing = servers.get(config.id)
  if (existing?.client) {
    await existing.client.close().catch(() => {})
  }
  const live: LiveServer = {
    config,
    client: null,
    status: { id: config.id, connected: false, tools: [] }
  }
  servers.set(config.id, live)

  if (!config.enabled) return live

  const started = Date.now()
  let stderrBuf = ''
  try {
    const client = new Client({ name: 'lattice', version: '0.1.0' }, { capabilities: {} })
    const transport = makeTransport(config)
    const connectPromise = client.connect(transport)
    // capture the child's stderr so a boot failure isn't swallowed by a silent hang
    const stderrStream = (transport as { stderr?: { on(ev: string, cb: (d: unknown) => void): void } }).stderr
    stderrStream?.on('data', (d) => {
      stderrBuf += String(d)
    })
    await withTimeout(
      connectPromise,
      CONNECT_TIMEOUT_MS,
      () => `connect timed out after ${CONNECT_TIMEOUT_MS}ms${stderrBuf ? `: ${stderrBuf.slice(-300)}` : ''}`
    )
    const { tools } = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, () => 'listTools timed out')
    live.client = client
    live.status = {
      id: config.id,
      connected: true,
      latencyMs: Date.now() - started,
      tools: tools.map((t) => ({ name: t.name, description: t.description, schema: t.inputSchema }))
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    live.status = { id: config.id, connected: false, tools: [], error: message }
    console.error(`[mcp] ${config.label} failed to connect: ${message}`)
  }
  return live
}

/** Connect every enabled server. Called on startup and after config changes. */
export async function initMcp(): Promise<void> {
  const configs = listMcpConfigs()
  await Promise.all(configs.map((config) => connectServer(config).catch(() => {})))
  // drop live entries for servers that were deleted from config
  for (const id of [...servers.keys()]) {
    if (!configs.some((c) => c.id === id)) {
      await servers.get(id)?.client?.close().catch(() => {})
      servers.delete(id)
    }
  }
}

/** Reconnect a single server after its config was added or edited. */
export async function reconnectServer(id: string): Promise<McpServerStatus> {
  const config = listMcpConfigs().find((c) => c.id === id)
  if (!config) {
    await servers.get(id)?.client?.close().catch(() => {})
    servers.delete(id)
    return { id, connected: false, tools: [] }
  }
  const live = await connectServer(config)
  return live.status
}

export async function disconnectServer(id: string): Promise<void> {
  await servers.get(id)?.client?.close().catch(() => {})
  servers.delete(id)
}

export function mcpStatuses(): { config: McpServerConfig; status: McpServerStatus }[] {
  return listMcpConfigs().map((config) => ({
    config,
    status: servers.get(config.id)?.status ?? { id: config.id, connected: false, tools: [] }
  }))
}

/** Build ToolDefinitions for every connected, enabled tool not denied by policy. */
export function mcpTools(): ToolDefinition[] {
  const defs: ToolDefinition[] = []
  for (const live of servers.values()) {
    if (!live.client || !live.config.enabled || !live.status.connected) continue
    const policy = live.config.toolPolicy ?? {}
    for (const tool of live.status.tools) {
      if (policy[tool.name] === 'deny') continue
      const client = live.client
      const schema = (tool.schema as Record<string, unknown>) ?? { type: 'object', properties: {} }
      defs.push({
        name: toolId(live.config.id, tool.name),
        description: `[${live.config.label}] ${tool.description ?? tool.name}`,
        parameters: schema,
        resource: 'mcp',
        action: 'execute',
        riskTier: 'R2',
        allowedInPlan: false,
        mcpServerId: live.config.id,
        serverLabel: live.config.label,
        summarize: (a) => `${live.config.label} · ${tool.name}(${Object.keys(a).slice(0, 3).join(', ')})`,
        async run(args, ctx) {
          const res = await client.callTool({ name: tool.name, arguments: args })
          // Parsed once, clipped to the model's window — see ./resultShape.ts for what this used to cost.
          return shapeMcpResult(res, mcpOutputCap(ctx))
        }
      })
    }
  }
  return defs
}

export async function shutdownMcp(): Promise<void> {
  await Promise.all([...servers.values()].map((s) => s.client?.close().catch(() => {})))
  servers.clear()
}
