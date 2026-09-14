import type { ToolDefinition } from './types'
import { listThreadDigests } from '../store/eventStore'
import { isOrchestratorThread } from '../store/agents'
import { digestMatchScore } from '../runtime/threadDigest'

/**
 * `recall_threads`: the model-facing side of thread digests (see runtime/threadDigest.ts). Memory
 * answers "what do I know?"; this answers "what was I doing, and where?" — every conversation in the
 * workspace keeps a running ~80-word digest, and this searches them. Returns session ids so the
 * model can `peek_session` one for its recent turns and tool calls.
 */

function ago(deltaMs: number): string {
  const m = Math.max(0, Math.round(deltaMs / 60_000))
  if (m < 2) return 'just now'
  if (m < 60) return `${m}m ago`
  const h = Math.round(m / 60)
  if (h < 36) return `${h}h ago`
  return `${Math.round(h / 24)}d ago`
}

function keywords(text: string): Set<string> {
  return new Set(text.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length >= 3))
}

const recallThreadsTool: ToolDefinition = {
  name: 'recall_threads',
  description:
    'Find what other conversations in this workspace were about. Every thread keeps a short running ' +
    'digest (goal, what got done, decisions, open items, key references). With `query`, returns the ' +
    'digests that match it best; without one, the most recently active threads. Each result carries the ' +
    'session id — use peek_session with it to read that thread’s recent turns and tool calls, or ' +
    'send_message to continue the work there. Use this when the user refers to earlier work ("what were ' +
    'we doing yesterday", "continue the eBay thing") or before starting something that may already exist.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keywords to match against digests and titles. Omit for the most recent threads.' },
      limit: { type: 'number', description: 'How many to return (default 5, max 15).' }
    },
    additionalProperties: false
  },
  resource: 'filesystem',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => (typeof args.query === 'string' && args.query.trim() ? `Recall threads: ${args.query}` : 'Recall recent threads'),
  async run(args, ctx) {
    const query = typeof args.query === 'string' ? args.query.trim() : ''
    const limit = Math.max(1, Math.min(15, Number(args.limit) || 5))
    const now = Date.now()
    const all = listThreadDigests({
      workspaceId: ctx.workspace.id,
      excludeThreadId: ctx.threadMeta.id,
      includeAgents: isOrchestratorThread(ctx.threadMeta.id) || !!ctx.threadMeta.isAgent,
      limit: 200
    })
    let picked = all
    if (query) {
      const q = keywords(query)
      picked = all
        .map((d) => ({ d, score: digestMatchScore(q, d.digest, d.title) }))
        .filter((x) => x.score > 0)
        .sort((a, b) => b.score - a.score || b.d.updatedAt - a.d.updatedAt)
        .map((x) => x.d)
    }
    const items = picked.slice(0, limit).map((d) => ({
      session: d.threadId,
      title: d.title,
      updated: ago(now - d.updatedAt),
      ...(d.isAgent ? { kind: 'fleet agent' } : d.replyStyle === 'texting' ? { kind: 'phone/texting thread' } : {}),
      digest: d.digest
    }))
    return {
      count: items.length,
      items,
      ...(items.length === 0
        ? { note: query ? 'No digest matches those words; try fewer or different keywords, or omit query for recent threads.' : 'No other threads have a digest yet.' }
        : {})
    }
  }
}

export const historyTools: ToolDefinition[] = [recallThreadsTool]
