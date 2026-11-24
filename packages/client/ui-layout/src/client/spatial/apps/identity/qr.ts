// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
// Encoding steps follow Project Nayuki's QR Code generator v1.8.0 (MIT License, Copyright (c) Project Nayuki,
// https://www.nayuki.io/page/qr-code-generator-library), the library the predecessor vendored as `vendor/qrcodegen`.
// Permission is hereby granted, free of charge, to any person obtaining a copy of that software, to deal in it without
// restriction, provided the copyright notice and this permission notice are included; it is provided "as is", without
// warranty of any kind.
/**
 * A QR Model 2 encoder for the identity card: byte mode, versions 1 to 40, the error-correction level boosted while the
 * data still fits, and the mask chosen by the standard penalty score. It matches Nayuki's `encodeBinary` module for
 * module (checked against the predecessor's vendored copy in scratch), rewritten in this repo's strict TypeScript so no
 * vendored file needs a type-check or lint opt-out.
 * @module apps/identity/qr
 */

export type QrEcc = 'L' | 'M' | 'Q' | 'H'

const ORDER: readonly QrEcc[] = ['L', 'M', 'Q', 'H']
const ORDINAL: Readonly<Record<QrEcc, number>> = { L: 0, M: 1, Q: 2, H: 3 }
const FORMAT_BITS: Readonly<Record<QrEcc, number>> = { L: 1, M: 0, Q: 3, H: 2 }

// Index 0 is padding; columns are versions 1..40; rows are L, M, Q, H.
const ECC_CODEWORDS_PER_BLOCK: readonly (readonly number[])[] = [
  [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28,
    28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
    26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30,
    28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28,
    30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
]
const NUM_ERROR_CORRECTION_BLOCKS: readonly (readonly number[])[] = [
  [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8,
    8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16,
    17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20,
    23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25,
    25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
]

const PENALTY_N1 = 3
const PENALTY_N2 = 3
const PENALTY_N3 = 40
const PENALTY_N4 = 10

const at = (values: readonly number[], index: number): number => values[index] ?? 0
const table = (rows: readonly (readonly number[])[], ecc: QrEcc, version: number): number => at(rows[ORDINAL[ecc]] ?? [], version)
const bit = (value: number, index: number): boolean => ((value >>> index) & 1) !== 0

function appendBits(value: number, length: number, bits: number[]): void {
  for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1)
}

function rawDataModules(version: number): number {
  let result = (16 * version + 128) * version + 64
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2
    result -= (25 * align - 10) * align - 55
    if (version >= 7) result -= 36
  }
  return result
}

function dataCodewords(version: number, ecc: QrEcc): number {
  return Math.floor(rawDataModules(version) / 8)
    - table(ECC_CODEWORDS_PER_BLOCK, ecc, version) * table(NUM_ERROR_CORRECTION_BLOCKS, ecc, version)
}

function rsMultiply(x: number, y: number): number {
  let z = 0
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d)
    z ^= ((y >>> i) & 1) * x
  }
  return z
}

function rsDivisor(degree: number): number[] {
  const result: number[] = Array.from({ length: degree - 1 }, () => 0)
  result.push(1)
  let root = 1
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = rsMultiply(at(result, j), root)
      if (j + 1 < result.length) result[j] = at(result, j) ^ at(result, j + 1)
    }
    root = rsMultiply(root, 0x02)
  }
  return result
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = divisor.map(() => 0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    divisor.forEach((coefficient, i) => { result[i] = at(result, i) ^ rsMultiply(coefficient, factor) })
  }
  return result
}

/** A finished code: `size` modules square; `dark(x, y)` reads one module (outside the grid is light). */
export interface QrCode {
  readonly version: number
  readonly ecc: QrEcc
  readonly mask: number
  readonly size: number
  dark(x: number, y: number): boolean
}

class Grid {
  readonly size: number
  readonly modules: boolean[]
  readonly fixed: boolean[]
  constructor(readonly version: number, readonly ecc: QrEcc) {
    this.size = version * 4 + 17
    this.modules = Array.from({ length: this.size * this.size }, () => false)
    this.fixed = Array.from({ length: this.size * this.size }, () => false)
  }

  get(x: number, y: number): boolean { return this.modules[y * this.size + x] === true }
  isFixed(x: number, y: number): boolean { return this.fixed[y * this.size + x] === true }
  set(x: number, y: number, dark: boolean): void { this.modules[y * this.size + x] = dark }
  setFixed(x: number, y: number, dark: boolean): void {
    this.modules[y * this.size + x] = dark
    this.fixed[y * this.size + x] = true
  }

  drawFunctionPatterns(): void {
    for (let i = 0; i < this.size; i++) {
      this.setFixed(6, i, i % 2 === 0)
      this.setFixed(i, 6, i % 2 === 0)
    }
    this.drawFinder(3, 3)
    this.drawFinder(this.size - 4, 3)
    this.drawFinder(3, this.size - 4)
    const positions = this.alignmentPositions()
    const count = positions.length
    for (let i = 0; i < count; i++) {
      for (let j = 0; j < count; j++) {
        if (!(i === 0 && j === 0 || i === 0 && j === count - 1 || i === count - 1 && j === 0)) {
          this.drawAlignment(at(positions, i), at(positions, j))
        }
      }
    }
    this.drawFormatBits(0)
    this.drawVersion()
  }

  drawFormatBits(mask: number): void {
    const data = FORMAT_BITS[this.ecc] << 3 | mask
    let rem = data
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537)
    const bits = (data << 10 | rem) ^ 0x5412
    for (let i = 0; i <= 5; i++) this.setFixed(8, i, bit(bits, i))
    this.setFixed(8, 7, bit(bits, 6))
    this.setFixed(8, 8, bit(bits, 7))
    this.setFixed(7, 8, bit(bits, 8))
    for (let i = 9; i < 15; i++) this.setFixed(14 - i, 8, bit(bits, i))
    for (let i = 0; i < 8; i++) this.setFixed(this.size - 1 - i, 8, bit(bits, i))
    for (let i = 8; i < 15; i++) this.setFixed(8, this.size - 15 + i, bit(bits, i))
    this.setFixed(8, this.size - 8, true)
  }

  drawVersion(): void {
    if (this.version < 7) return
    let rem = this.version
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25)
    const bits = this.version << 12 | rem
    for (let i = 0; i < 18; i++) {
      const dark = bit(bits, i)
      const a = this.size - 11 + i % 3
      const b = Math.floor(i / 3)
      this.setFixed(a, b, dark)
      this.setFixed(b, a, dark)
    }
  }

  drawFinder(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const distance = Math.max(Math.abs(dx), Math.abs(dy))
        const xx = x + dx
        const yy = y + dy
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) this.setFixed(xx, yy, distance !== 2 && distance !== 4)
      }
    }
  }

  drawAlignment(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) this.setFixed(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1)
    }
  }

  alignmentPositions(): number[] {
    if (this.version === 1) return []
    const count = Math.floor(this.version / 7) + 2
    const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2
    const result = [6]
    for (let position = this.size - 7; result.length < count; position -= step) result.splice(1, 0, position)
    return result
  }

  addEccAndInterleave(data: readonly number[]): number[] {
    const blocksCount = table(NUM_ERROR_CORRECTION_BLOCKS, this.ecc, this.version)
    const blockEccLength = table(ECC_CODEWORDS_PER_BLOCK, this.ecc, this.version)
    const rawCodewords = Math.floor(rawDataModules(this.version) / 8)
    const shortBlocks = blocksCount - rawCodewords % blocksCount
    const shortBlockLength = Math.floor(rawCodewords / blocksCount)
    const divisor = rsDivisor(blockEccLength)
    const blocks: number[][] = []
    for (let i = 0, k = 0; i < blocksCount; i++) {
      const block = data.slice(k, k + shortBlockLength - blockEccLength + (i < shortBlocks ? 0 : 1))
      k += block.length
      const ecc = rsRemainder(block, divisor)
      if (i < shortBlocks) block.push(0)
      blocks.push(block.concat(ecc))
    }
    const result: number[] = []
    const width = blocks[0]?.length ?? 0
    for (let i = 0; i < width; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortBlockLength - blockEccLength || j >= shortBlocks) result.push(at(block, i))
      })
    }
    return result
  }

  drawCodewords(data: readonly number[]): void {
    let i = 0
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5
      for (let vertical = 0; vertical < this.size; vertical++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j
          const upward = ((right + 1) & 2) === 0
          const y = upward ? this.size - 1 - vertical : vertical
          if (!this.isFixed(x, y) && i < data.length * 8) {
            this.set(x, y, bit(at(data, i >>> 3), 7 - (i & 7)))
            i++
          }
        }
      }
    }
  }

  applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        if (!this.isFixed(x, y) && maskInverts(mask, x, y)) this.set(x, y, !this.get(x, y))
      }
    }
  }

  penalty(): number {
    let result = 0
    for (let line = 0; line < 2; line++) {
      for (let a = 0; a < this.size; a++) {
        let runDark = false
        let run = 0
        const history = [0, 0, 0, 0, 0, 0, 0]
        for (let b = 0; b < this.size; b++) {
          const dark = line === 0 ? this.get(b, a) : this.get(a, b)
          if (dark === runDark) {
            run++
            if (run === 5) result += PENALTY_N1
            else if (run > 5) result++
          } else {
            this.addHistory(run, history)
            if (!runDark) result += this.countFinderPatterns(history) * PENALTY_N3
            runDark = dark
            run = 1
          }
        }
        result += this.terminateAndCount(runDark, run, history) * PENALTY_N3
      }
    }
    for (let y = 0; y < this.size - 1; y++) {
      for (let x = 0; x < this.size - 1; x++) {
        const dark = this.get(x, y)
        if (dark === this.get(x + 1, y) && dark === this.get(x, y + 1) && dark === this.get(x + 1, y + 1)) result += PENALTY_N2
      }
    }
    const darkCount = this.modules.reduce((sum, dark) => sum + (dark ? 1 : 0), 0)
    const total = this.size * this.size
    const k = Math.ceil(Math.abs(darkCount * 20 - total * 10) / total) - 1
    return result + k * PENALTY_N4
  }

  countFinderPatterns(history: readonly number[]): number {
    const n = at(history, 1)
    const core = n > 0 && at(history, 2) === n && at(history, 3) === n * 3 && at(history, 4) === n && at(history, 5) === n
    return (core && at(history, 0) >= n * 4 && at(history, 6) >= n ? 1 : 0)
      + (core && at(history, 6) >= n * 4 && at(history, 0) >= n ? 1 : 0)
  }

  terminateAndCount(runDark: boolean, length: number, history: number[]): number {
    let run = length
    if (runDark) {
      this.addHistory(run, history)
      run = 0
    }
    this.addHistory(run + this.size, history)
    return this.countFinderPatterns(history)
  }

  addHistory(length: number, history: number[]): void {
    const first = history[0] === 0
    history.pop()
    history.unshift(first ? length + this.size : length)
  }
}

function maskInverts(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0: return (x + y) % 2 === 0
    case 1: return y % 2 === 0
    case 2: return x % 3 === 0
    case 3: return (x + y) % 3 === 0
    case 4: return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0
    case 5: return x * y % 2 + x * y % 3 === 0
    case 6: return (x * y % 2 + x * y % 3) % 2 === 0
    default: return ((x + y) % 2 + x * y % 3) % 2 === 0
  }
}

/**
 * Encode bytes as a QR code in byte mode.
 * @param data - the exact bytes the code carries.
 * @param minimum - the lowest error-correction level; it is raised while the data still fits the same version.
 * @returns the finished code.
 * @throws RangeError when the bytes do not fit version 40 at the minimum level.
 */
export function encodeQrBytes(data: Uint8Array, minimum: QrEcc = 'M'): QrCode {
  let version = 1
  let used = 0
  for (; ; version++) {
    used = 4 + (version < 10 ? 8 : 16) + data.length * 8
    if (used <= dataCodewords(version, minimum) * 8) break
    if (version >= 40) throw new RangeError('qr:data-too-long')
  }
  let ecc = minimum
  for (const next of ORDER.slice(ORDINAL[minimum] + 1)) if (used <= dataCodewords(version, next) * 8) ecc = next
  const bits: number[] = []
  appendBits(0x4, 4, bits)
  appendBits(data.length, version < 10 ? 8 : 16, bits)
  for (const byte of data) appendBits(byte, 8, bits)
  const capacity = dataCodewords(version, ecc) * 8
  appendBits(0, Math.min(4, capacity - bits.length), bits)
  appendBits(0, (8 - bits.length % 8) % 8, bits)
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) appendBits(pad, 8, bits)
  const codewords: number[] = Array.from({ length: bits.length / 8 }, () => 0)
  bits.forEach((value, i) => { codewords[i >>> 3] = at(codewords, i >>> 3) | value << (7 - (i & 7)) })

  const grid = new Grid(version, ecc)
  grid.drawFunctionPatterns()
  grid.drawCodewords(grid.addEccAndInterleave(codewords))
  let mask = 0
  let lowest = Number.POSITIVE_INFINITY
  for (let candidate = 0; candidate < 8; candidate++) {
    grid.applyMask(candidate)
    grid.drawFormatBits(candidate)
    const score = grid.penalty()
    if (score < lowest) {
      mask = candidate
      lowest = score
    }
    grid.applyMask(candidate)
  }
  grid.applyMask(mask)
  grid.drawFormatBits(mask)
  const size = grid.size
  const modules = grid.modules.slice()
  return {
    version, ecc, mask, size,
    dark: (x, y) => x >= 0 && x < size && y >= 0 && y < size && modules[y * size + x] === true,
  }
}

/**
 * A QR image as an SVG data URL: dark modules on a light plate with the standard four-module quiet zone (the predecessor's
 * `contactQrDataUrl` look).
 * @param text - the exact text the code carries, UTF-8 encoded.
 * @param minimum - the lowest error-correction level (the predecessor's contact card used Q).
 * @returns `data:image/svg+xml,...`.
 */
export function qrSvgDataUrl(text: string, minimum: QrEcc = 'Q'): string {
  const code = encodeQrBytes(new TextEncoder().encode(text), minimum)
  const border = 4
  const size = code.size + border * 2
  const path: string[] = []
  for (let y = 0; y < code.size; y++) {
    for (let x = 0; x < code.size; x++) if (code.dark(x, y)) path.push(`M${String(x + border)},${String(y + border)}h1v1h-1z`)
  }
  const box = String(size)
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${box} ${box}" width="${box}" height="${box}" shape-rendering="crispEdges">`
    + `<rect width="100%" height="100%" fill="#f4f3f8"/><path d="${path.join('')}" fill="#151322"/></svg>`
  return `data:image/svg+xml,${encodeURIComponent(svg)}`
}
