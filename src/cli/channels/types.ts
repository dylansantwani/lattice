/**
 * Shared shapes for the text gateway (`lattice channels`): messaging apps and a phone line that
 * reach one long-lived Lattice assistant thread.
 *
 * An adapter only moves bytes — it normalizes a platform's inbound message into
 * {@link InboundMessage} and knows how to send text back. Everything that decides what a message
 * means (who may talk, which thread, approvals, delivery) lives in the router.
 */

export type ChannelId = 'telegram' | 'imessage' | 'voice'

export const CHANNEL_LABELS: Record<ChannelId, string> = {
  telegram: 'Telegram',
  imessage: 'iMessage',
  voice: 'Phone call'
}

export interface InboundAttachment {
  /** Absolute path of the downloaded file in the gateway's media directory. */
  path: string
  name: string
  mime: string
  kind: 'image' | 'audio' | 'file'
}

export interface InboundMessage {
  channel: ChannelId
  /** Opaque, stable id to reply into (Telegram chat id, Photon space id). */
  conversationId: string
  /** Stable sender identity checked against the owner allowlist (Telegram user id, phone/email). */
  senderId: string
  senderName?: string
  /** Platform message id — dedupes redelivery and targets reactions. */
  messageId: string
  text: string
  attachments: InboundAttachment[]
  receivedAt: number
  /** A tapped inline button (Telegram) answering an approval or question. */
  callback?: { data: string }
}

export interface OutboundButton {
  label: string
  data: string
}

export interface SendOptions {
  /** Rows of inline buttons, where the platform supports them. */
  buttons?: OutboundButton[][]
}

/** A local file the assistant hands the owner (a screenshot, a chart, a PDF). */
export interface OutboundFile {
  /** Absolute, already vetted by the router. */
  path: string
  name: string
  mime: string
  kind: 'image' | 'file'
  bytes: number
  /** `dev:ino` at vetting time; the upload refuses a file that has since been swapped. */
  identity?: string
  caption?: string
}

export interface ChannelStatus {
  connected: boolean
  /** Bot username, iMessage line, … — whatever tells the owner where to text. */
  identity?: string
  detail?: string
  lastError?: string
}

export interface ChannelAdapter {
  readonly id: ChannelId
  /** Longest single bubble the platform accepts comfortably; the router chunks to this. */
  readonly maxMessageChars: number
  /** Markdown flavor the adapter renders: Telegram converts to HTML, everything else gets plain text. */
  readonly format: 'telegram-html' | 'plain'
  /** Set when the platform's typing indicator lapses on its own (Telegram: ~5s) so the router re-arms it. */
  readonly typingTtlMs?: number
  start(sink: (message: InboundMessage) => void): Promise<void>
  stop(): Promise<void>
  send(conversationId: string, text: string, options?: SendOptions): Promise<void>
  /** Show or clear a typing indicator. Adapters whose indicator expires re-arm via the router. */
  typing?(conversationId: string, on: boolean): Promise<void>
  react?(conversationId: string, messageId: string, emoji: string): Promise<void>
  /** Upload a file into the conversation. Adapters without it get the file's name as text instead. */
  sendFile?(conversationId: string, file: OutboundFile): Promise<void>
  /** Largest upload the platform accepts. */
  readonly maxUploadBytes?: number
  status(): ChannelStatus
}

export interface Logger {
  (message: string): void
}
