/**
 * The silent acknowledgement. A thread may answer an automatic notice (a background job or agent
 * finishing) with exactly `NO_REPLY` when the notice changes nothing the person needs to hear. The
 * model still sees its own acknowledgement in history; readers show nothing, or a quiet marker,
 * and the text gateway sends nothing.
 */
export const NO_REPLY = 'NO_REPLY'

/** True when `text` is the silent acknowledgement (allowing surrounding whitespace or a trailing period). */
export function isSilentReply(text: string | undefined | null): boolean {
  return !!text && /^\s*NO_REPLY[\s.!]*$/.test(text)
}

/**
 * A reply with the token stripped, for a model that wrote words AND the token ("nothing new.
 * NO_REPLY"): the words are kept, the token never shown. Returns '' for a purely silent reply.
 */
export function withoutSilentToken(text: string): string {
  if (isSilentReply(text)) return ''
  return text.replace(/(^|\s)NO_REPLY[.!]?(?=\s|$)/g, '$1').replace(/[ \t]+$/gm, '').trim()
}
