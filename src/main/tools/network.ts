import { BlockList, isIP } from 'node:net'
import { lookup as dnsLookup } from 'node:dns/promises'

/**
 * Network destinations that host-facing tools must never reach. This includes loopback, private,
 * link-local/cloud-metadata, and carrier-grade NAT ranges. The check happens before every request
 * (including redirects), so a web page cannot bounce a tool into the user's LAN.
 */
const PRIVATE_NETWORK_BLOCKLIST = new BlockList()
PRIVATE_NETWORK_BLOCKLIST.addRange('0.0.0.0', '0.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('10.0.0.0', '10.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('100.64.0.0', '100.127.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('127.0.0.0', '127.255.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('169.254.0.0', '169.254.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('172.16.0.0', '172.31.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addRange('192.168.0.0', '192.168.255.255', 'ipv4')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('::1', 128, 'ipv6')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('fc00::', 7, 'ipv6')
PRIVATE_NETWORK_BLOCKLIST.addSubnet('fe80::', 10, 'ipv6')
// Do not add ::ffff:0:0/96 here. Node's BlockList shares IPv4-mapped IPv6 addresses with the
// plain IPv4 space, so that rule would also block every public IPv4 address.

/** Reject a hostname that resolves to a local or otherwise non-public address. */
export async function assertPublicHost(hostname: string): Promise<void> {
  // URL#hostname keeps brackets around an IPv6 literal; isIP expects them removed.
  const host = hostname.replace(/^\[(.+)\]$/, '$1')
  if (host.toLowerCase() === 'localhost') throw new Error('Refusing to fetch from localhost.')
  const literalFamily = isIP(host)
  const addresses = literalFamily ? [{ address: host, family: literalFamily }] : await dnsLookup(host, { all: true })
  for (const { address, family } of addresses) {
    if (PRIVATE_NETWORK_BLOCKLIST.check(address, family === 6 ? 'ipv6' : 'ipv4')) {
      throw new Error(`Refusing to fetch from a private/internal network address (${address}).`)
    }
  }
}

/** Validate a user-provided web URL before it is resolved or fetched. */
export function parsePublicHttpUrl(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error(`Invalid URL: ${raw}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Unsupported URL scheme "${url.protocol}" — only http(s) URLs are allowed.`)
  }
  if (url.username || url.password) throw new Error('URLs with embedded credentials are not allowed.')
  return url
}

/**
 * Read a response body with a hard byte cap. Unlike relying on Content-Length, this also limits
 * chunked responses and cancels the stream as soon as the limit is crossed.
 */
export async function readBodyCapped(res: Response, maxBytes: number, label = 'Response'): Promise<Buffer> {
  const reader = res.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.byteLength > maxBytes) throw new Error(`${label} is too large (over ${maxBytes} bytes).`)
    return bytes
  }
  const chunks: Buffer[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) throw new Error(`${label} is too large (over ${maxBytes} bytes).`)
      chunks.push(Buffer.from(value))
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return Buffer.concat(chunks)
}

/** Read up to a cap, preserving a useful partial document instead of failing the whole fetch. */
export async function readBodyUpTo(
  res: Response,
  maxBytes: number
): Promise<{ bytes: Buffer; truncated: boolean }> {
  const reader = res.body?.getReader()
  if (!reader) {
    const bytes = Buffer.from(await res.arrayBuffer())
    return { bytes: bytes.subarray(0, maxBytes), truncated: bytes.byteLength > maxBytes }
  }
  const chunks: Buffer[] = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      const remaining = maxBytes - total
      if (remaining <= 0) {
        truncated = true
        break
      }
      const chunk = Buffer.from(value)
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining))
        total = maxBytes
        truncated = true
        break
      }
      chunks.push(chunk)
      total += chunk.byteLength
    }
  } finally {
    await reader.cancel().catch(() => {})
  }
  return { bytes: Buffer.concat(chunks), truncated }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/**
 * Fetch a public URL while validating every redirect target. Node's automatic redirect handling
 * would otherwise follow a public → localhost redirect after the initial host check.
 */
export async function fetchPublicUrl(
  initial: URL,
  opts: { signal: AbortSignal; headers?: Record<string, string>; maxRedirects?: number }
): Promise<{ response: Response; url: URL }> {
  const maxRedirects = opts.maxRedirects ?? 5
  let url = initial
  for (let redirect = 0; redirect <= maxRedirects; redirect += 1) {
    await assertPublicHost(url.hostname)
    const response = await fetch(url, { redirect: 'manual', signal: opts.signal, headers: opts.headers })
    if (!REDIRECT_STATUSES.has(response.status)) return { response, url }
    const location = response.headers.get('location')
    await response.body?.cancel().catch(() => {})
    if (!location) throw new Error(`Redirect from ${url} did not include a Location header.`)
    if (redirect === maxRedirects) throw new Error(`Too many redirects while fetching ${initial}.`)
    url = parsePublicHttpUrl(new URL(location, url).toString())
  }
  throw new Error(`Too many redirects while fetching ${initial}.`)
}
