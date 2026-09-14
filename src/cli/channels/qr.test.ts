import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { dataCodewords, encodeQr, reedSolomonDivisor, reedSolomonRemainder, renderQrForTerminal, renderQrSvg } from './qr'

function fingerprint(modules: boolean[][]): string {
  return createHash('sha256').update(modules.map((row) => row.map((dark) => (dark ? '1' : '0')).join('')).join('\n')).digest('hex').slice(0, 16)
}

describe('QR encoder', () => {
  it('uses the published data capacities for versions 1-10', () => {
    // ISO/IEC 18004 Table 7, data codewords per version.
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((version) => dataCodewords(version, 'L'))).toEqual([19, 34, 55, 80, 108, 136, 156, 194, 232, 274])
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((version) => dataCodewords(version, 'M'))).toEqual([16, 28, 44, 64, 86, 108, 124, 154, 182, 216])
  })

  it('computes Reed-Solomon error correction like the spec example', () => {
    // The worked "01234567" 1-M example from ISO/IEC 18004 Annex I.
    const data = [0x10, 0x20, 0x0c, 0x56, 0x61, 0x80, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11, 0xec, 0x11]
    expect(reedSolomonRemainder(data, reedSolomonDivisor(10))).toEqual([0xa5, 0x24, 0xd4, 0xc1, 0xed, 0x36, 0xc7, 0x87, 0x2c, 0x55])
  })

  it('picks the smallest version that fits and draws the finder patterns', () => {
    const modules = encodeQr('https://t.me/LatticeDylanBot?start=123456')
    expect(modules).toHaveLength(29) // version 3
    const finder = ['1111111', '1000001', '1011101', '1011101', '1011101', '1000001', '1111111']
    const read = (x0: number, y0: number): string[] => finder.map((_, dy) => modules[y0 + dy]!.slice(x0, x0 + 7).map((dark) => (dark ? '1' : '0')).join(''))
    expect(read(0, 0)).toEqual(finder)
    expect(read(22, 0)).toEqual(finder)
    expect(read(0, 22)).toEqual(finder)
    expect(modules[29 - 8]![8]).toBe(true) // the always-dark module
  })

  it('matches matrices that a real scanner decoded', () => {
    // Each of these was rendered to PNG and read back with macOS CoreImage's CIDetector (QR), which
    // returned the input text exactly. They cover one block, several blocks, version information
    // (7+), 16-bit length fields (10), and both levels.
    expect(fingerprint(encodeQr('https://t.me/LatticeDylanBot?start=123456', 'M'))).toBe('785aa9393e99b07f')
    expect(fingerprint(encodeQr(`${'L'.repeat(100)} version seven or so`, 'M'))).toBe('99c95d9d3938a2a1')
    expect(fingerprint(encodeQr(`https://example.com/${'q'.repeat(190)}`, 'M'))).toBe('88a0a390c14303cd')
    expect(fingerprint(encodeQr('x'.repeat(150), 'L'))).toBe('1b893491bd8934e7')
  })

  it('refuses text beyond version 10', () => {
    expect(() => encodeQr('z'.repeat(300))).toThrow(/too long/)
  })

  it('renders for a terminal in explicit colors, two module rows per line', () => {
    const modules = encodeQr('hi')
    const text = renderQrForTerminal(modules, 2)
    const lines = text.split('\n')
    expect(lines).toHaveLength(Math.ceil((modules.length + 4) / 2))
    expect(lines[0]).toContain('[107m')
    expect(lines.every((line) => line.endsWith('[0m'))).toBe(true)
  })

  it('renders an SVG with one rect per dark module', () => {
    const modules = encodeQr('hi')
    const dark = modules.flat().filter(Boolean).length
    const svg = renderQrSvg(modules)
    expect(svg.startsWith('<svg')).toBe(true)
    expect(svg.match(/<rect x=/g)).toHaveLength(dark)
  })
})
