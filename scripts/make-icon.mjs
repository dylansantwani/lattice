/**
 * Generates the Lattice app icon (build/icon.png, 1024×1024) with no dependencies.
 *
 * The mark is the app's identity: a 3×3 lattice of nodes wired orthogonally, in the UI's violet
 * (--violet #8e87d8), on the app canvas colour (#131313) inside a macOS-proportioned squircle.
 * Three nodes and thick edges keep it legible down to the 16px Finder/Spotlight size.
 *
 * Rendered with 4× supersampling and written as a plain RGBA PNG via node:zlib, so the icon is
 * reproducible from source and needs no binary asset checked in.
 */
import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SIZE = 1024
const SS = 4 // supersample factor
const N = SIZE * SS

// macOS icon grid: the art occupies ~824/1024 of the canvas, centred.
const CONTENT = 824 / 1024
const half = (N * CONTENT) / 2
const cx = N / 2
const cy = N / 2

const hex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)]
const BG_TOP = hex('#20201f')   // --panel
const BG_BOT = hex('#0e0e0e')   // --surface-lowest
const VIOLET = hex('#8e87d8')   // --violet
const VIOLET_SOFT = hex('#aaa5e9')

const buf = Buffer.alloc(N * N * 4) // RGBA, transparent outside the squircle

// Superellipse (squircle) — n=5 is close to Apple's continuous corner.
const SQUIRCLE_N = 5
const inSquircle = (x, y) => {
  const dx = Math.abs(x - cx) / half
  const dy = Math.abs(y - cy) / half
  return Math.pow(dx, SQUIRCLE_N) + Math.pow(dy, SQUIRCLE_N) <= 1
}

// --- lattice geometry (in unit space, -1..1 within the content box) ---
const GRID = [-0.62, 0, 0.62]
const NODE_R = 0.155
const CENTER_R = 0.20
const EDGE_W = 0.072

const nodes = []
for (const gy of GRID) for (const gx of GRID) nodes.push({ x: gx, y: gy, center: gx === 0 && gy === 0 })

const edges = []
for (const g of GRID) {
  edges.push({ x1: GRID[0], y1: g, x2: GRID[2], y2: g }) // rows
  edges.push({ x1: g, y1: GRID[0], x2: g, y2: GRID[2] }) // columns
}

// distance from point to segment, in unit space
const distSeg = (px, py, e) => {
  const vx = e.x2 - e.x1, vy = e.y2 - e.y1
  const wx = px - e.x1, wy = py - e.y1
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const dx = px - (e.x1 + t * vx), dy = py - (e.y1 + t * vy)
  return Math.sqrt(dx * dx + dy * dy)
}

for (let y = 0; y < N; y++) {
  for (let x = 0; x < N; x++) {
    const o = (y * N + x) * 4
    if (!inSquircle(x + 0.5, y + 0.5)) continue

    // background vertical gradient
    const t = y / N
    let r = BG_TOP[0] + (BG_BOT[0] - BG_TOP[0]) * t
    let g = BG_TOP[1] + (BG_BOT[1] - BG_TOP[1]) * t
    let b = BG_TOP[2] + (BG_BOT[2] - BG_TOP[2]) * t

    // unit coords within the content box
    const ux = (x + 0.5 - cx) / half
    const uy = (y + 0.5 - cy) / half

    // edges first, then nodes on top
    let onEdge = false
    for (const e of edges) { if (distSeg(ux, uy, e) <= EDGE_W) { onEdge = true; break } }
    if (onEdge) { r = VIOLET[0] * 0.72; g = VIOLET[1] * 0.72; b = VIOLET[2] * 0.72 }

    for (const n of nodes) {
      const d = Math.hypot(ux - n.x, uy - n.y)
      const rad = n.center ? CENTER_R : NODE_R
      if (d <= rad) {
        const c = n.center ? VIOLET_SOFT : VIOLET
        ;[r, g, b] = c
        break
      }
    }

    buf[o] = r; buf[o + 1] = g; buf[o + 2] = b; buf[o + 3] = 255
  }
}

// --- box-downsample N -> SIZE with alpha-correct averaging ---
const out = Buffer.alloc(SIZE * SIZE * 4)
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const o = (((y * SS + sy) * N) + (x * SS + sx)) * 4
        const al = buf[o + 3] / 255
        r += buf[o] * al; g += buf[o + 1] * al; b += buf[o + 2] * al; a += al
      }
    }
    const n = SS * SS
    const o = (y * SIZE + x) * 4
    out[o] = a > 0 ? Math.round(r / a) : 0
    out[o + 1] = a > 0 ? Math.round(g / a) : 0
    out[o + 2] = a > 0 ? Math.round(b / a) : 0
    out[o + 3] = Math.round((a / n) * 255)
  }
}

// --- PNG encode ---
const crcTable = (() => {
  const t = new Int32Array(256)
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c }
  return t
})()
const crc32 = (b) => { let c = -1; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0 }
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}
const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0); ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const dest = join(dirname(dirname(fileURLToPath(import.meta.url))), 'build', 'icon.png')
mkdirSync(dirname(dest), { recursive: true })
writeFileSync(dest, png)
console.log(`wrote ${dest} (${SIZE}×${SIZE}, ${(png.length / 1024).toFixed(1)} kB)`)
