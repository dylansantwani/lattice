/**
 * ULID-compatible id generator: 48-bit timestamp + 80 bits of randomness,
 * Crockford base32, lexicographically sortable. Works in main and renderer.
 */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function ulid(now = Date.now()): string {
  let ts = ''
  let t = now
  for (let i = 0; i < 10; i++) {
    ts = ALPHABET[t % 32] + ts
    t = Math.floor(t / 32)
  }
  const rand = new Uint8Array(16)
  crypto.getRandomValues(rand)
  let rnd = ''
  for (let i = 0; i < 16; i++) {
    rnd += ALPHABET[rand[i]! % 32]
  }
  return ts + rnd
}
