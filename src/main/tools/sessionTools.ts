import type { ToolDefinition } from './types'
import {
  drainInbox,
  listSessions,
  resolveTarget,
  sendSessionMessage,
  unreadCount
} from '../runtime/sessionMessaging'
import { getSessionActivity, listSessionActivity } from '../runtime/sessionActivity'

/**
 * Inter-session messaging tools (Slice 9). They let the model discover other live sessions, send a
 * message to one, and pull its own inbox. "Session" is a thread; the caller's own session is
 * `ctx.threadMeta` — the sender identity and the inbox owner are both taken from there, so the model
 * never has to (and cannot) spoof another session's identity.
 *
 * These are `external_action` tools: `list_sessions`/`check_inbox` are R0 reads (available in every
 * mode/preset, including review/plan). `send_message` is a `submit` but deliberately **R0**: it only
 * ever reaches the user's own sessions and subagents inside this app — coordination, not an external
 * side effect — so it runs without an approval prompt under Auto (workspace) and Full, and in Plan
 * mode. (It was R1 originally, which parked every message on an approval card and made messaging
 * feel broken; Manual and Review still withhold it, as they do every non-read tool.)
 */

const MAX_BODY = 8 * 1024

const listSessionsTool: ToolDefinition = {
  name: 'list_sessions',
  description:
    'List the live sessions (threads) and subagents you can message, most-recently-active first. ' +
    'Each session has an id, title, model, whether it is currently running, and how many messages ' +
    'are waiting in its inbox; each subagent (your own background agents, or — if you are a subagent ' +
    'yourself — your siblings) has an id, name, and status. Use the id (or an exact title/name) as ' +
    'the `to` for send_message.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: () => 'List addressable sessions',
  async run(_args, ctx) {
    // A top-level run excludes itself from the directory; a subagent excludes nothing, so the thread
    // it runs under appears and can be messaged (the subagent is not that thread).
    const self = ctx.agentIdentity ? undefined : ctx.threadMeta.id
    const sessions = listSessions(self)
    // Live status for each, so the directory answers "which of these is busy, and with what"
    // rather than only "which of these exist". A private session contributes status but no detail.
    const live = new Map(listSessionActivity(self, { forObserver: true }).map((a) => [a.threadId, a]))
    const agents = ctx.listAgentPeers?.() ?? []
    return {
      count: sessions.length + agents.length,
      sessions: sessions.map((s) => {
        const a = live.get(s.threadId)
        return {
          id: s.threadId,
          title: s.title,
          model: s.model,
          running: s.running,
          unread: s.unread,
          ...(a ? { status: a.status, status_text: a.statusText } : {}),
          ...(a?.activity ? { doing: a.activity } : {}),
          ...(a?.agents ? { subagents_running: a.agents } : {}),
          ...(a?.jobs ? { jobs_running: a.jobs } : {})
        }
      }),
      ...(agents.length
        ? {
            agents: agents.map((a) => ({ id: a.agentId, name: a.name, status: a.status, kind: 'subagent' }))
          }
        : {})
    }
  }
}

const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description:
    'Send a message to another session (thread) or a live background subagent. `to` is the target ' +
    'session/agent id or its exact title/name (from list_sessions). A running target receives the ' +
    'message at its next safe point; an idle session is WOKEN with it as a new turn, so it acts on it ' +
    'right away. It needs no approval — use it freely to coordinate. To reply to a message you received, ' +
    'pass its sender id as `to` and set `reply_to` to the message id. You cannot message your own session.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string', description: 'Target session id, or its exact title.' },
      body: { type: 'string', description: 'The message to send.' },
      reply_to: { type: 'string', description: 'Optional id of the message this replies to.' }
    },
    required: ['to', 'body'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'submit',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => {
    const to = typeof args.to === 'string' ? args.to : '?'
    const body = typeof args.body === 'string' ? args.body : ''
    return `Message session ${to}: ${body.slice(0, 60)}`
  },
  async run(args, ctx) {
    const to = String(args.to ?? '')
    const body = String(args.body ?? '').trim()
    if (!body) return { ok: false, error: 'Message body is empty.' }
    if (body.length > MAX_BODY) {
      return { ok: false, error: `Message too long (${body.length} chars; max ${MAX_BODY}).` }
    }
    const replyTo = typeof args.reply_to === 'string' ? args.reply_to : undefined
    // Agent ids/names are resolved before thread titles. This keeps parent→child and sibling
    // messages on the live injection lane instead of accidentally treating an ephemeral agent as a
    // session and writing an unusable inbox row.
    const peer = ctx.messageAgentPeer?.(to, body)
    if (peer) {
      if (!peer.ok) return { ok: false, error: peer.error }
      const target = peer.name ? `"${peer.name}"` : peer.agentId
      return {
        ok: true,
        delivery: 'injected',
        to: peer.agentId,
        summary: `Message delivered into subagent ${target}; it will fold it in at its next safe point.`
      }
    }
    const identity = ctx.agentIdentity
    const result = sendSessionMessage({
      // An agent speaks on behalf of its parent thread, but the parent is a legal recipient because
      // the ephemeral agent itself is not the thread. Explicitly leaving selfThreadId undefined
      // prevents the broker's normal session self-send guard from rejecting that route.
      fromThreadId: identity?.parentThreadId ?? ctx.threadMeta.id,
      to,
      body,
      replyTo,
      ...(identity
        ? {
            fromLabel: identity.name ?? `agent ${identity.agentId.slice(-6)}`,
            fromKind: 'agent' as const,
            fromAgentId: identity.agentId,
            selfThreadId: undefined
          }
        : {})
    })
    if (!result.ok) return { ok: false, error: result.error }
    const where =
      result.delivery === 'injected'
        ? `delivered into "${result.toTitle}" (it is running now)`
        : result.delivery === 'woken'
          ? `delivered to "${result.toTitle}" — it was idle and has been woken to act on it now`
          : `left in "${result.toTitle}"'s inbox (it will see this on its next run)`
    return { ok: true, delivery: result.delivery, to: result.toThreadId, summary: `Message ${where}.` }
  }
}

const checkInboxTool: ToolDefinition = {
  name: 'check_inbox',
  description:
    'Read messages other sessions have sent to you and mark them read. Returns the unread messages ' +
    'oldest-first (the order to act on them), each with the sender id and title so you can reply with ' +
    'send_message. Call this when you want to pick up messages that arrived while you were idle.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: () => 'Check session inbox',
  async run(_args, ctx) {
    // A background subagent has no durable inbox of its own. Parent/sibling messages arrive on its
    // live injection queue and are folded into the next model boundary; never drain the parent
    // thread's durable inbox on the subagent's behalf.
    if (ctx.agentIdentity) {
      return {
        count: 0,
        messages: [],
        note: 'Subagent messages are delivered live; there is no separate subagent inbox to drain.'
      }
    }
    const remaining = unreadCount(ctx.threadMeta.id)
    const messages = drainInbox(ctx.threadMeta.id)
    return {
      count: messages.length,
      messages: messages.map((m) => ({
        id: m.id,
        from: m.fromThreadId,
        fromTitle: m.fromTitle,
        replyTo: m.replyTo,
        sentAt: m.createdAt,
        body: m.body
      })),
      ...(messages.length === 0 ? { note: remaining === 0 ? 'Inbox empty.' : undefined } : {})
    }
  }
}

/**
 * Read-only observation of another session. The counterpart to `send_message`: instead of asking a
 * session what it is doing (and waiting for it to answer), look. Everything the observer may see is
 * decided in `sessionActivity.ts` — hidden reasoning is never included, secrets are redacted, tool
 * arguments are summarized rather than dumped, and a session the user marked private returns status
 * only. Nothing here can change the observed session in any way.
 */
const peekSessionTool: ToolDefinition = {
  name: 'peek_session',
  description:
    'Look at what another session is doing right now, read-only: its status (running / waiting on ' +
    'the user / idle / failed), the tool it is running, its recent turns, its recent tool calls, and ' +
    'anything it is parked on waiting for a human. Use it to coordinate without interrupting — check ' +
    'whether a session you delegated to is still working, or stuck on an approval — instead of ' +
    'messaging it and waiting for a reply. You cannot see another session\'s hidden reasoning, and a ' +
    'session marked private reports only whether it is busy.',
  parameters: {
    type: 'object',
    properties: {
      session: { type: 'string', description: 'Target session id, or its exact title (from list_sessions).' }
    },
    required: ['session'],
    additionalProperties: false
  },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: (args) => `Peek at session ${typeof args.session === 'string' ? args.session : '?'}`,
  async run(args, ctx) {
    const target = String(args.session ?? '').trim()
    if (!target) return { ok: false, error: 'Provide a session id or title (see list_sessions).' }
    // A subagent may look at the thread it runs under; a top-level run may not peek at itself (it
    // already knows, and it would be a confusing recursion in its own context).
    const resolved = resolveTarget(target, ctx.agentIdentity ? undefined : ctx.threadMeta.id)
    if ('error' in resolved) return { ok: false, error: resolved.error }
    const activity = getSessionActivity(resolved.threadId, { forObserver: true })
    if (!activity) return { ok: false, error: `Session not found: ${target}` }
    if (activity.withheld) {
      return {
        ok: true,
        id: activity.threadId,
        title: activity.title,
        status: activity.status,
        running: activity.running,
        withheld: activity.withheld
      }
    }
    return {
      ok: true,
      id: activity.threadId,
      title: activity.title,
      model: activity.model,
      mode: activity.mode,
      status: activity.status,
      status_text: activity.statusText,
      ...(activity.activity ? { doing: activity.activity } : {}),
      ...(activity.goal ? { goal: activity.goal } : {}),
      subagents_running: activity.agents,
      jobs_running: activity.jobs,
      waiting_on_user: [
        ...activity.pending.approvals.map((a) => `approval: ${a.tool} — ${a.summary}`),
        ...activity.pending.asks.map((a) => `question: ${a.question}`)
      ],
      recent_tools: activity.tools.map((t) => ({
        tool: t.tool,
        status: t.status,
        ...(t.durationMs != null ? { ms: t.durationMs } : {}),
        ...(t.summary ? { note: t.summary } : {})
      })),
      recent_messages: activity.messages.map((m) => ({
        role: m.role,
        at: m.createdAt,
        ...(m.from ? { from: m.from } : {}),
        text: m.text
      })),
      note: 'Read-only view. Hidden reasoning is never shown and secrets are redacted.'
    }
  }
}

export const sessionMessagingTools: ToolDefinition[] = [
  listSessionsTool,
  sendMessageTool,
  checkInboxTool,
  peekSessionTool
]
