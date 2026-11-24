/**
 * Aukora X5: `sharp` subset over the browser's own codecs (createImageBitmap +
 * OffscreenCanvas), enough for the attachment pipeline: metadata(), rotate(),
 * toColourspace(), resize({width,height,fit:'inside',withoutEnlargement}), jpeg(),
 * webp(), png(), raw(), clone(), toBuffer({resolveWithObject}). Decoding applies
 * EXIF orientation, so metadata reports oriented dimensions and no orientation;
 * JPEG EXIF / PNG iCCP are reported so callers re-encode (which strips them).
 * Pixels are 8-bit sRGB(A).
 */
export const __esModule = true

type Format = 'png' | 'jpeg' | 'webp' | 'gif' | 'avif'
interface Info { format: string; width: number; height: number; channels: number; size: number }

function sniff(b: Uint8Array): Format | undefined {
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'png'
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg'
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return 'webp'
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'gif'
  if (b[4] === 0x66 && b[5] === 0x74 && b[6] === 0x79 && b[7] === 0x70) return 'avif'
  return undefined
}
const ascii = (b: Uint8Array, at: number, n: number): string => String.fromCharCode(...b.subarray(at, at + n))
function pngFacts(b: Uint8Array): { alpha: boolean; icc: boolean } {
  let alpha = b[25] === 4 || b[25] === 6
  let icc = false
  for (let at = 8; at + 8 <= b.length;) {
    const len = ((b[at] ?? 0) << 24 | (b[at + 1] ?? 0) << 16 | (b[at + 2] ?? 0) << 8 | (b[at + 3] ?? 0)) >>> 0
    const type = ascii(b, at + 4, 4)
    if (type === 'tRNS') alpha = true
    if (type === 'iCCP') icc = true
    if (type === 'IEND') break
    at += 12 + len
  }
  return { alpha, icc }
}
function jpegHasExif(b: Uint8Array): boolean {
  for (let at = 2; at + 4 < b.length && b[at] === 0xff;) {
    const marker = b[at + 1] ?? 0
    const len = ((b[at + 2] ?? 0) << 8) | (b[at + 3] ?? 0)
    if ((marker === 0xe1 && ascii(b, at + 4, 4) === 'Exif') || marker === 0xe2) return true
    if (marker === 0xda) break
    at += 2 + len
  }
  return false
}
function webpAlpha(b: Uint8Array): boolean {
  const chunk = ascii(b, 12, 4)
  if (chunk === 'VP8X') return ((b[20] ?? 0) & 0x10) !== 0
  if (chunk === 'VP8L') return true
  return false
}
function bad(message: string): Error { return new Error(`Input buffer contains unsupported image format (${message})`) }

class Pipeline {
  private target: { width?: number | undefined; height?: number | undefined; fit?: string; withoutEnlargement?: boolean } | undefined
  private output: { format: 'jpeg' | 'webp' | 'png' | 'raw'; quality?: number | undefined } | undefined
  constructor(private readonly input: Uint8Array) {}
  clone(): Pipeline { const p = new Pipeline(this.input); p.target = this.target; p.output = this.output; return p }
  rotate(): this { return this }
  toColourspace(): this { return this }
  toColorspace(): this { return this }
  withMetadata(): this { return this }
  keepMetadata(): this { return this }
  resize(a?: number | Record<string, unknown>, b?: number, c?: Record<string, unknown>): this {
    this.target = typeof a === 'object' && a !== null ? a as never : { width: a as number | undefined, height: b, ...(c ?? {}) }
    return this
  }
  jpeg(o: { quality?: number } = {}): this { this.output = { format: 'jpeg', quality: o.quality }; return this }
  webp(o: { quality?: number } = {}): this { this.output = { format: 'webp', quality: o.quality }; return this }
  png(): this { this.output = { format: 'png' }; return this }
  raw(): this { this.output = { format: 'raw' }; return this }

  private async decode(): Promise<ImageBitmap> {
    const format = sniff(this.input)
    if (format === undefined) throw bad('unknown signature')
    try {
      return await createImageBitmap(new Blob([this.input as BlobPart], { type: `image/${format}` }), { colorSpaceConversion: 'default' })
    } catch (error) {
      throw bad(error instanceof Error ? error.message : String(error))
    }
  }

  async metadata(): Promise<Record<string, unknown>> {
    const format = sniff(this.input)
    if (format === undefined) throw bad('unknown signature')
    const bitmap = await this.decode()
    const facts = format === 'png' ? pngFacts(this.input) : { alpha: format === 'webp' ? webpAlpha(this.input) : format === 'gif', icc: false }
    const meta = {
      format, width: bitmap.width, height: bitmap.height, space: 'srgb', depth: 'uchar', channels: facts.alpha ? 4 : 3,
      hasAlpha: facts.alpha, hasProfile: facts.icc, pages: 1, size: this.input.byteLength,
      ...(format === 'jpeg' && jpegHasExif(this.input) ? { exif: new Uint8Array(1) } : {}),
      ...(facts.icc ? { icc: new Uint8Array(1) } : {}),
    }
    bitmap.close()
    return meta
  }

  async toBuffer(options?: { resolveWithObject?: boolean }): Promise<unknown> {
    const bitmap = await this.decode()
    let width = bitmap.width
    let height = bitmap.height
    const t = this.target
    if (t !== undefined && (t.width !== undefined || t.height !== undefined)) {
      const sx = t.width === undefined ? Infinity : t.width / width
      const sy = t.height === undefined ? Infinity : t.height / height
      let scale = Math.min(sx, sy)
      if (t.withoutEnlargement === true) scale = Math.min(scale, 1)
      if (Number.isFinite(scale)) { width = Math.max(1, Math.round(width * scale)); height = Math.max(1, Math.round(height * scale)) }
    }
    const canvas = new OffscreenCanvas(width, height)
    const g = canvas.getContext('2d')
    if (g === null) throw new Error('sharp (worker): 2d canvas unavailable')
    g.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const out = this.output ?? { format: (sniff(this.input) === 'jpeg' ? 'jpeg' : 'png') as 'jpeg' | 'png' }
    let data: Uint8Array
    let channels = 4
    if (out.format === 'raw') {
      data = new Uint8Array(g.getImageData(0, 0, width, height).data.buffer)
    } else {
      const blob = await canvas.convertToBlob({ type: `image/${out.format}`, ...(out.quality === undefined ? {} : { quality: out.quality / 100 }) })
      data = new Uint8Array(await blob.arrayBuffer())
      channels = out.format === 'jpeg' ? 3 : 4
    }
    const B = (globalThis as unknown as { Buffer?: { from(u: Uint8Array): Uint8Array } }).Buffer
    const buffer = B === undefined ? data : B.from(data)
    const info: Info = { format: out.format, width, height, channels, size: data.byteLength }
    return options?.resolveWithObject === true ? { data: buffer, info } : buffer
  }
}

function sharp(input: Uint8Array | ArrayBuffer, _options?: unknown): Pipeline {
  return new Pipeline(input instanceof Uint8Array ? input : new Uint8Array(input))
}
Object.assign(sharp, { cache: () => undefined, concurrency: () => 1, simd: () => false, format: {}, versions: { sharp: 'worker-canvas' } })

export default sharp
