// Rasterises the same geometry as icon.svg into assets/icon-180.png.
// The market listing requires a GitHub-hosted bitmap icon (SVG is rejected),
// so this keeps the PNG reproducible without adding an image dependency:
// plain node + zlib, 4x supersampling for clean edges at 96px display size.
// Run: node scripts/make-icon.mjs

import { mkdirSync, writeFileSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// 180x180 matches the sibling plugin's listing icon (dsh-aihot-radar/icon-180.png);
// the market shows icons at ~96px, so this is still ~1.9x.
const OUT = join(here, '..', 'assets', 'icon-180.png')
const SIZE = 180
const SS = 4 // supersampling factor
const W = SIZE * SS
const U = (SIZE / 64) * SS // supersample px per SVG unit

// ---- geometry (64-unit design space, mirrors icon.svg) ----------------------
function sdRoundRect(px, py, x, y, w, h, r) {
  const qx = Math.abs(px - (x + w / 2)) - (w / 2 - r)
  const qy = Math.abs(py - (y + h / 2)) - (h / 2 - r)
  const ax = Math.max(qx, 0), ay = Math.max(qy, 0)
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r
}

function cubic(p0, c1, c2, p1, n = 64) {
  const pts = []
  for (let i = 1; i <= n; i++) {
    const t = i / n, mt = 1 - t
    pts.push([
      mt * mt * mt * p0[0] + 3 * mt * mt * t * c1[0] + 3 * mt * t * t * c2[0] + t * t * t * p1[0],
      mt * mt * mt * p0[1] + 3 * mt * mt * t * c1[1] + 3 * mt * t * t * c2[1] + t * t * t * p1[1],
    ])
  }
  return pts
}

// Bell outline: closed path, drawn as a stroke (round caps/joins).
const bell = [
  [32, 14],
  ...cubic([32, 14], [24.5, 14], [20, 19.5], [20, 26.5]),
  ...cubic([20, 26.5], [20, 34.5], [16.5, 38.5], [16.5, 38.5]),
  [47.5, 38.5],
  ...cubic([47.5, 38.5], [47.5, 38.5], [44, 34.5], [44, 26.5]),
  ...cubic([44, 26.5], [44, 19.5], [39.5, 14], [32, 14]),
  [32, 14],
]

// Clapper: semicircle below the bell mouth.
const clapper = []
for (let i = 0; i <= 64; i++) {
  const th = Math.PI - Math.PI * (i / 64)
  clapper.push([32 + 4.5 * Math.cos(th), 45 + 4.5 * Math.sin(th)])
}

const bellMask = new Uint8Array(W * W)
const dotMask = new Uint8Array(W * W)

function stroke(mask, pts, halfUnits) {
  const half = halfUnits * U
  for (let i = 0; i < pts.length - 1; i++) {
    const X1 = pts[i][0] * U, Y1 = pts[i][1] * U
    const X2 = pts[i + 1][0] * U, Y2 = pts[i + 1][1] * U
    const x0 = Math.max(0, Math.floor(Math.min(X1, X2) - half))
    const x9 = Math.min(W - 1, Math.ceil(Math.max(X1, X2) + half))
    const y0 = Math.max(0, Math.floor(Math.min(Y1, Y2) - half))
    const y9 = Math.min(W - 1, Math.ceil(Math.max(Y1, Y2) + half))
    const dx = X2 - X1, dy = Y2 - Y1
    const len2 = dx * dx + dy * dy || 1
    for (let y = y0; y <= y9; y++) {
      const py = y + 0.5
      for (let x = x0; x <= x9; x++) {
        const px = x + 0.5
        let t = ((px - X1) * dx + (py - Y1) * dy) / len2
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const ex = X1 + t * dx - px, ey = Y1 + t * dy - py
        if (ex * ex + ey * ey <= half * half) mask[y * W + x] = 1
      }
    }
  }
}

function disc(mask, cx, cy, r) {
  const x0 = Math.max(0, Math.floor((cx - r) * U)), x9 = Math.min(W - 1, Math.ceil((cx + r) * U))
  const y0 = Math.max(0, Math.floor((cy - r) * U)), y9 = Math.min(W - 1, Math.ceil((cy + r) * U))
  for (let y = y0; y <= y9; y++) {
    for (let x = x0; x <= x9; x++) {
      const dx = (x + 0.5) / U - cx, dy = (y + 0.5) / U - cy
      if (dx * dx + dy * dy <= r * r) mask[y * W + x] = 1
    }
  }
}

stroke(bellMask, bell, 1.5)   // stroke-width 3
stroke(bellMask, clapper, 1.5)
disc(dotMask, 47, 14.5, 4.2) // notification dot, clear of the bell stroke

// ---- colour (same stops as icon.svg) ---------------------------------------
const hex = (s) => [parseInt(s.slice(1, 3), 16) / 255, parseInt(s.slice(3, 5), 16) / 255, parseInt(s.slice(5, 7), 16) / 255]
const BASE = [[0, hex('#101a30')], [0.55, hex('#0b1222')], [1, hex('#0e1628')]]
const GLOWS = [
  { cx: 53, cy: -4, r: 44, c: hex('#38bdf8'), a: [0.34, 0.1, 0] },
  { cx: 8, cy: 60, r: 38, c: hex('#5b8cff'), a: [0.26, 0.26, 0] },
  { cx: 47, cy: 14, r: 17, c: hex('#fbbf24'), a: [0.22, 0.22, 0] },
]
const BELL = hex('#7dd3fc')
const DOT = hex('#fbbf24')
const BORDER_A = 0.28

const stopAt = (stops, t) => {
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1], [t1, c1] = stops[i]
      const k = t1 === t0 ? 0 : (t - t0) / (t1 - t0)
      return [c0[0] + (c1[0] - c0[0]) * k, c0[1] + (c1[1] - c0[1]) * k, c0[2] + (c1[2] - c0[2]) * k]
    }
  }
  return stops[stops.length - 1][1]
}

// Direction of the base gradient: (0,0) -> (0.3,1) in unit space.
const gLen = Math.hypot(0.3, 1)
const gx = 0.3 / gLen, gy = 1 / gLen

// ---- render ---------------------------------------------------------------
const pixels = new Uint8Array(SIZE * SIZE * 4)
const rowAcc = new Float32Array(SIZE * 4) // premultiplied sums for one output row

for (let y = 0; y < W; y++) {
  for (let x = 0; x < W; x++) {
    const u = (x + 0.5) / U
    const v = (y + 0.5) / U
    if (sdRoundRect(u, v, 0, 0, 64, 64, 15) > 0) continue // outside: stays transparent

    const t = (u * gx + v * gy) / 64
    let [r, g, b] = stopAt(BASE, t < 0 ? 0 : t > 1 ? 1 : t)

    for (const gl of GLOWS) {
      const d = Math.hypot(u - gl.cx, v - gl.cy) / gl.r
      if (d >= 1) continue
      const a = d <= 0.5 ? gl.a[0] + (gl.a[1] - gl.a[0]) * (d / 0.5) : gl.a[1] * (1 - (d - 0.5) / 0.5)
      r = gl.c[0] * a + r * (1 - a)
      g = gl.c[1] * a + g * (1 - a)
      b = gl.c[2] * a + b * (1 - a)
    }

    const idx = y * W + x
    if (bellMask[idx]) { r = BELL[0]; g = BELL[1]; b = BELL[2] }
    if (dotMask[idx]) { r = DOT[0]; g = DOT[1]; b = DOT[2] }
    if (Math.abs(sdRoundRect(u, v, 0.75, 0.75, 62.5, 62.5, 14.25)) <= 0.75) {
      r = BELL[0] * BORDER_A + r * (1 - BORDER_A)
      g = BELL[1] * BORDER_A + g * (1 - BORDER_A)
      b = BELL[2] * BORDER_A + b * (1 - BORDER_A)
    }

    const col = (x / SS) | 0
    const o = col * 4
    rowAcc[o] += r
    rowAcc[o + 1] += g
    rowAcc[o + 2] += b
    rowAcc[o + 3] += 1
  }

  if ((y + 1) % SS === 0) {
    const ro = ((y / SS) | 0) * SIZE * 4
    for (let c = 0; c < SIZE; c++) {
      const o = c * 4
      const a = rowAcc[o + 3] / (SS * SS)
      if (a > 0) {
        pixels[ro + o] = Math.round(Math.min(1, rowAcc[o] / (SS * SS)) * 255)
        pixels[ro + o + 1] = Math.round(Math.min(1, rowAcc[o + 1] / (SS * SS)) * 255)
        pixels[ro + o + 2] = Math.round(Math.min(1, rowAcc[o + 2] / (SS * SS)) * 255)
      }
      pixels[ro + o + 3] = Math.round(a * 255)
    }
    rowAcc.fill(0)
  }
}

// ---- PNG encode -----------------------------------------------------------
const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()
function crc32(buf) {
  let c = 0xffffffff
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
function chunk(type, data) {
  const head = Buffer.alloc(4)
  head.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([head, body, crc])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8  // bit depth
ihdr[9] = 6  // RGBA
const raw = Buffer.alloc((SIZE * 4 + 1) * SIZE)
for (let y = 0; y < SIZE; y++) {
  const off = y * (SIZE * 4 + 1)
  raw[off] = 0 // filter: none
  Buffer.from(pixels.buffer, y * SIZE * 4, SIZE * 4).copy(raw, off + 1)
}
const png = Buffer.concat([
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`icon: ${OUT} (${SIZE}x${SIZE}, ${png.length} bytes)`)
