/**
 * A small QR Code (Model 2) encoder, so `lattice channels setup telegram` can put the pairing link on
 * screen as something a phone camera opens, without a dependency.
 *
 * Byte mode, versions 1–10 (up to 213 bytes at level M; a t.me deep link is about 50), all eight
 * masks scored with the standard penalty rules. Layout follows ISO/IEC 18004; the block tables are
 * the standard ones, cross-checked in the tests against the published data capacities.
 */

export type QrEcc = 'L' | 'M'

const MAX_VERSION = 10
/** Index = version; entry 0 unused. */
const ECC_PER_BLOCK: Record<QrEcc, number[]> = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
}
const ECC_BLOCKS: Record<QrEcc, number[]> = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5]
}
const FORMAT_ECC_BITS: Record<QrEcc, number> = { L: 1, M: 0 }

/** Modules available for data and error correction once function patterns are placed. */
export function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const alignments = Math.floor(version / 7) + 2
    result -= (25 * alignments - 10) * alignments - 55
    if (version >= 7) result -= 36
  }
  return result
}

export function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8) - ECC_PER_BLOCK[ecc][version]! * ECC_BLOCKS[ecc][version]!
}

function gfMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z & 0xff
}

export function reedSolomonDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0)
  result[degree - 1] = 1
  let root = 1
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < result.length; j += 1) {
      result[j] = gfMultiply(result[j]!, root)
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!
    }
    root = gfMultiply(root, 0x02)
  }
  return result
}

export function reedSolomonRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0)
  for (const byte of data) {
    const factor = byte ^ result.shift()!
    result.push(0)
    divisor.forEach((coefficient, index) => {
      result[index]! ^= gfMultiply(coefficient, factor)
    })
  }
  return result
}

function bit(value: number, index: number): boolean {
  return ((value >>> index) & 1) !== 0
}

class QrMatrix {
  readonly size: number
  readonly modules: boolean[][]
  readonly reserved: boolean[][]

  constructor(readonly version: number) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
    this.reserved = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false))
  }

  setFunction(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark
    this.reserved[y]![x] = true
  }

  drawFunctionPatterns(ecc: QrEcc): void {
    for (let i = 0; i < this.size; i += 1) {
      this.setFunction(6, i, i % 2 === 0)
      this.setFunction(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)
    const positions = this.alignmentPositions()
    const last = positions.length - 1
    positions.forEach((x, i) => {
      positions.forEach((y, j) => {
        if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return
        for (let dy = -2; dy <= 2; dy += 1) {
          for (let dx = -2; dx <= 2; dx += 1) this.setFunction(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
        }
      })
    })
    this.drawFormat(ecc, 0) // reserve the area; redrawn with the chosen mask
    this.drawVersion()
  }

  private drawFinder(cx: number, cy: number): void {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const x = cx + dx
        const y = cy + dy
        if (x < 0 || y < 0 || x >= this.size || y >= this.size) continue
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        this.setFunction(x, y, distance !== 2 && distance !== 4)
      }
    }
  }

  alignmentPositions(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2
    const result = [6]
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position)
    return result
  }

  drawFormat(ecc: QrEcc, mask: number): void {
    const data = (FORMAT_ECC_BITS[ecc] << 3) | mask
    let remainder = data
    for (let i = 0; i < 10; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 9) * 0x537)
    const bits = ((data << 10) | remainder) ^ 0x5412
    for (let i = 0; i <= 5; i += 1) this.setFunction(8, i, bit(bits, i))
    this.setFunction(8, 7, bit(bits, 6))
    this.setFunction(8, 8, bit(bits, 7))
    this.setFunction(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i += 1) this.setFunction(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i += 1) this.setFunction(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i += 1) this.setFunction(8, this.size - 15 + i, bit(bits, i))
    this.setFunction(8, this.size - 8, true) // the always-dark module
  }

  private drawVersion(): void {
    if (this.version < 7) return
    let remainder = this.version
    for (let i = 0; i < 12; i += 1) remainder = (remainder << 1) ^ ((remainder >>> 11) * 0x1f25)
    const bits = (this.version << 12) | remainder
    for (let i = 0; i < 18; i += 1) {
      const dark = bit(bits, i)
      const a = this.size - 11 + (i % 3)
      const b = Math.floor(i / 3)
      this.setFunction(a, b, dark)
      this.setFunction(b, a, dark)
    }
  }

  drawCodewords(codewords: number[]): void {
    let index = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical += 1) {
        for (let j = 0; j < 2; j += 1) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (this.reserved[y]![x] || index >= codewords.length * 8) continue
          this.modules[y]![x] = bit(codewords[index >>> 3]!, 7 - (index & 7))
          index += 1
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y += 1) {
      for (let x = 0; x < this.size; x += 1) {
        if (this.reserved[y]![x]) continue
        let invert: boolean
        switch (mask) {
          case 0: invert = (x + y) % 2 === 0; break
          case 1: invert = y % 2 === 0; break
          case 2: invert = x % 3 === 0; break
          case 3: invert = (x + y) % 3 === 0; break
          case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break
          case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break
          case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break
          default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
        }
        if (invert) this.modules[y]![x] = !this.modules[y]![x]
      }
    }
  }

  /** ISO/IEC 18004 penalty: long runs, 2×2 blocks, finder look-alikes, and dark/light imbalance. */
  penalty(): number {
    const { size, modules } = this
    let score = 0
    const lines: boolean[][] = [...modules, ...Array.from({ length: size }, (_, x) => modules.map((row) => row[x]!))]
    for (const line of lines) {
      let run = 1
      for (let i = 1; i <= size; i += 1) {
        if (i < size && line[i] === line[i - 1]) {
          run += 1
          continue
        }
        if (run >= 5) score += 3 + (run - 5)
        run = 1
      }
      const text = line.map((dark) => (dark ? '1' : '0')).join('')
      for (const pattern of ['10111010000', '00001011101']) {
        for (let at = text.indexOf(pattern); at >= 0; at = text.indexOf(pattern, at + 1)) score += 40
      }
    }
    let dark = 0
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        if (modules[y]![x]) dark += 1
        if (x + 1 < size && y + 1 < size) {
          const color = modules[y]![x]
          if (modules[y]![x + 1] === color && modules[y + 1]![x] === color && modules[y + 1]![x + 1] === color) score += 3
        }
      }
    }
    score += Math.floor(Math.abs((dark * 100) / (size * size) - 50) / 5) * 10
    return score
  }
}

function encodeData(bytes: Uint8Array, version: number, ecc: QrEcc): number[] {
  const bits: number[] = []
  const push = (value: number, length: number): void => {
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, version <= 9 ? 8 : 16)
  for (const byte of bytes) push(byte, 8)
  const capacityBits = dataCodewords(version, ecc) * 8
  push(0, Math.min(4, capacityBits - bits.length))
  push(0, (8 - (bits.length % 8)) % 8)
  const codewords: number[] = []
  for (let i = 0; i < bits.length; i += 8) codewords.push(bits.slice(i, i + 8).reduce((acc, value) => (acc << 1) | value, 0))
  for (let pad = 0xec; codewords.length < dataCodewords(version, ecc); pad ^= 0xec ^ 0x11) codewords.push(pad)
  return codewords
}

function addErrorCorrection(data: number[], version: number, ecc: QrEcc): number[] {
  const blocks = ECC_BLOCKS[ecc][version]!
  const eccLength = ECC_PER_BLOCK[ecc][version]!
  const rawCodewords = Math.floor(rawDataModules(version) / 8)
  const shortBlocks = blocks - (rawCodewords % blocks)
  const shortLength = Math.floor(rawCodewords / blocks)
  const divisor = reedSolomonDivisor(eccLength)
  // Every block is laid out at the long length, data first and error correction last, so a short
  // block carries one unused slot right after its data; interleaving skips that slot.
  const all: number[][] = []
  let offset = 0
  for (let i = 0; i < blocks; i += 1) {
    const chunk = data.slice(offset, offset + shortLength - eccLength + (i < shortBlocks ? 0 : 1))
    offset += chunk.length
    const block = new Array<number>(shortLength + 1).fill(0)
    chunk.forEach((byte, index) => {
      block[index] = byte
    })
    reedSolomonRemainder(chunk, divisor).forEach((byte, index) => {
      block[shortLength + 1 - eccLength + index] = byte
    })
    all.push(block)
  }
  const result: number[] = []
  for (let i = 0; i <= shortLength; i += 1) {
    all.forEach((block, j) => {
      if (i !== shortLength - eccLength || j >= shortBlocks) result.push(block[i]!)
    })
  }
  return result
}

/** Encode `text` (UTF-8) as a QR matrix: rows of modules, `true` = dark. `forceMask` is for tests. */
export function encodeQr(text: string, ecc: QrEcc = 'M', forceMask?: number): boolean[][] {
  const bytes = new TextEncoder().encode(text)
  let version = 1
  while (version <= MAX_VERSION && 4 + (version <= 9 ? 8 : 16) + bytes.length * 8 > dataCodewords(version, ecc) * 8) version += 1
  if (version > MAX_VERSION) throw new Error(`text is too long for a QR code here (${bytes.length} bytes)`)
  const codewords = addErrorCorrection(encodeData(bytes, version, ecc), version, ecc)
  let best: { mask: number; score: number } | undefined = forceMask === undefined ? undefined : { mask: forceMask, score: 0 }
  for (let mask = 0; mask < 8 && forceMask === undefined; mask += 1) {
    const matrix = new QrMatrix(version)
    matrix.drawFunctionPatterns(ecc)
    matrix.drawCodewords(codewords)
    matrix.applyMask(mask)
    matrix.drawFormat(ecc, mask)
    const score = matrix.penalty()
    if (!best || score < best.score) best = { mask, score }
  }
  const matrix = new QrMatrix(version)
  matrix.drawFunctionPatterns(ecc)
  matrix.drawCodewords(codewords)
  matrix.applyMask(best!.mask)
  matrix.drawFormat(ecc, best!.mask)
  return matrix.modules
}

/**
 * Terminal rendering with half blocks and explicit black/white colors, so the code scans on dark and
 * light terminal themes alike. Two module rows per text line keeps it square-ish and small.
 */
export function renderQrForTerminal(modules: boolean[][], quiet = 2): string {
  const size = modules.length + quiet * 2
  const dark = (x: number, y: number): boolean => {
    const mx = x - quiet
    const my = y - quiet
    return mx >= 0 && my >= 0 && mx < modules.length && my < modules.length && modules[my]![mx]!
  }
  const BLACK_FG = '\u001b[30m'
  const WHITE_FG = '\u001b[97m'
  const BLACK_BG = '\u001b[40m'
  const WHITE_BG = '\u001b[107m'
  const RESET = '\u001b[0m'
  const lines: string[] = []
  for (let y = 0; y < size; y += 2) {
    let line = ''
    for (let x = 0; x < size; x += 1) {
      const top = dark(x, y)
      const bottom = y + 1 < size ? dark(x, y + 1) : false
      line += `${top ? BLACK_FG : WHITE_FG}${bottom ? BLACK_BG : WHITE_BG}▀`
    }
    lines.push(`${line}${RESET}`)
  }
  return lines.join('\n')
}

/** A standalone SVG of the code (for a page, a file, or a chat attachment). */
export function renderQrSvg(modules: boolean[][], { quiet = 4, scale = 8 }: { quiet?: number; scale?: number } = {}): string {
  const size = (modules.length + quiet * 2) * scale
  const rects: string[] = []
  modules.forEach((row, y) => {
    row.forEach((isDark, x) => {
      if (isDark) rects.push(`<rect x="${(x + quiet) * scale}" y="${(y + quiet) * scale}" width="${scale}" height="${scale}"/>`)
    })
  })
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" shape-rendering="crispEdges"><rect width="100%" height="100%" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>`
}
