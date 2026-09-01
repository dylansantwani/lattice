import type { ToolDefinition } from './types'
import {
  drainInbox,
  listSessions,
  sendSessionMessage,
  unreadCount
} from '../runtime/sessionMessaging'

/**
 * Inter-session messaging tools (Slice 9). They let the model discover other live sessions, send a
 * message to one, and pull its own inbox. "Session" is a thread; the caller's own session is
 * `ctx.threadMeta` — the sender identity and the inbox owner are both taken from there, so the model
 * never has to (and cannot) spoof another session's identity.
 *
 * These are `external_action` tools: `list_sessions`/`check_inbox` are R0 reads (available in every
 * mode/preset, including review/plan), while `send_message` is an R1 `submit` — allowed outright
 * under Full, approval-gated under Auto (workspace), and denied under Manual/Review and in Plan mode,
 * matching how the run manager gates other side effects.
 */

const MAX_BODY = 8 * 1024

const listSessionsTool: ToolDefinition = {
  name: 'list_sessions',
  description:
    'List the other live sessions (threads) you can message, most-recently-active first. Each entry ' +
    'has an id, title, model, whether it is currently running, and how many messages are waiting in ' +
    'its inbox. Use the id (or an exact title) as the `to` for send_message.',
  parameters: { type: 'object', properties: {}, additionalProperties: false },
  resource: 'external_action',
  action: 'read',
  riskTier: 'R0',
  allowedInPlan: true,
  summarize: () => 'List addressable sessions',
  async run(_args, ctx) {
    const sessions = listSessions(ctx.threadMeta.id)
    return {
      count: sessions.length,
      sessions: sessions.map((s) => ({
        id: s.threadId,
        title: s.title,
        model: s.model,
        running: s.running,
        unread: s.unread
      }))
    }
  }
}

const sendMessageTool: ToolDefinition = {
  name: 'send_message',
  description:
    'Send a message to another session (thread). `to` is the target session id or its exact title ' +
    '(from list_sessions). If the target is running, the message is injected into its work at the next ' +
    'safe point; if it is idle, it waits in the target inbox until that session next runs (or its user ' +
    'opens it). To reply to a message you received, pass its sender id as `to` and set `reply_to` to ' +
    'the message id. You cannot message your own session.',
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
  riskTier: 'R1',
  allowedInPlan: false,
  summarize: (args) => {
    const to = typeof args.to === 'string' ? args.to : '?'
    const body = typeof args.body === 'string' ? args.body : ''
    return `Message session ${to}: ${body.slice(0, 60)}`
  },
  async run(args, ctx) {
    const to = String(args.to ?? '')
    const body = String(args.body ?? '')
    if (body.length > MAX_BODY) {
      return { ok: false, error: `Message too long (${body.length} chars; max ${MAX_BODY}).` }
    }
    const replyTo = typeof args.reply_to === 'string' ? args.reply_to : undefined
    const result = sendSessionMessage({ fromThreadId: ctx.threadMeta.id, to, body, replyTo })
    if (!result.ok) return { ok: false, error: result.error }
    const where =
      result.delivery === 'injected'
        ? `delivered into "${result.toTitle}" (it is running now)`
        : `left in "${result.toTitle}"'s inbox (it is idle; it will see this on its next run)`
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

export const sessionMessagingTools: ToolDefinition[] = [listSessionsTool, sendMessageTool, checkInboxTool]
