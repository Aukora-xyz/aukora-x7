/**
 * Auma's eyes where the host has none (Round 36). The `auma-eyes` organ asks `/_host/eyes`; on the Mac a headless browser
 * answers, but the Cloudflare edge answers 501. Then this worker asks the open page over a same-origin BroadcastChannel
 * (the page side is `ui-layout/src/client/spatial/eyes/page-eyes.ts`): the live DOM projection and, for `screenshot`, a PNG
 * frame drawn from it and stamped `epoch · build · time · sha256`. The frame is kept at `captures/latest.png` and in a
 * ring of the last twelve. The answer says `source: 'page'` and `frame: 'layout-drawing'`: it is not a pixel capture.
 * @module x6/page-eyes-bridge
 */
import type { Vfs } from '../storage/types.ts'
import { liveWriteSet } from './write-set-inventory.ts'

export const EYES_CHANNEL = 'aukora-eyes/v1'
/**
 * Lane E5 (meta-workspace): `/dsh/home/auma` is the home. `latest.png` and the projection are still mirrored into the
 * legacy `/dsh/home/auma-one` home, because pinned organs (`auma-eyes`) read and describe that path; the ring lives
 * only under `/dsh/home/auma`, and readers fall back to the legacy ring when the new one is empty.
 */
export const CAPTURE_PATHS = ['/dsh/home/auma/captures/latest.png', '/dsh/home/auma-one/captures/latest.png'] as const
export const PROJECTION_PATHS = ['/dsh/home/auma/captures/latest-projection.json', '/dsh/home/auma-one/captures/latest-projection.json'] as const
export const CAPTURE_RING_DIR = '/dsh/home/auma/captures/ring'
export const LEGACY_CAPTURE_RING_DIR = '/dsh/home/auma-one/captures/ring'
export const CAPTURE_RING_SIZE = 12
/** Host answers that mean "no eyes here", so the page is asked instead. */
const NO_HOST_EYES = new Set([404, 405, 501])

type Channel = Pick<BroadcastChannel, 'postMessage' | 'addEventListener' | 'removeEventListener' | 'close'>

/**
 * Ask the open page to look.
 * @param request - `{ action, selector }` as the organ sent them.
 * @param deps - the channel (tests pass their own), a request id, and how long to wait.
 * @returns the first page's answer, or null when no page answered in time.
 */
export async function askPageEyes(request: Record<string, unknown>, deps: {
  readonly channel?: Channel
  readonly id: string
  readonly timeoutMs?: number
}): Promise<Record<string, unknown> | null> {
  if (deps.channel === undefined && typeof BroadcastChannel !== 'function') return null
  const channel: Channel = deps.channel ?? new BroadcastChannel(EYES_CHANNEL)
  try {
    return await new Promise<Record<string, unknown> | null>((resolve) => {
      const timer = setTimeout(() => { done(null) }, deps.timeoutMs ?? 8000)
      const onMessage = (event: MessageEvent): void => {
        const data: unknown = event.data
        if (data !== null && typeof data === 'object' && !Array.isArray(data)
          && (data as Record<string, unknown>).t === 'eyes-answer' && (data as Record<string, unknown>).id === deps.id) {
          done(data as Record<string, unknown>)
        }
      }
      function done(value: Record<string, unknown> | null): void {
        clearTimeout(timer)
        channel.removeEventListener('message', onMessage as EventListener)
        resolve(value)
      }
      channel.addEventListener('message', onMessage as EventListener)
      channel.postMessage({ t: 'eyes-request', id: deps.id,
        action: request.action === 'screenshot' ? 'screenshot' : 'projection',
        ...(typeof request.selector === 'string' && request.selector !== '' ? { selector: request.selector.slice(0, 200) } : {}) })
    })
  } finally {
    if (deps.channel === undefined) channel.close()
  }
}

const ringFrames = (vfs: Vfs, dir: string): string[] => {
  try {
    if (!vfs.existsSync(dir)) return []
    return (vfs.readdirSync(dir) as string[]).filter(name => name.endsWith('.png')).sort()
  } catch { return [] }
}

/**
 * Read the capture ring: `/dsh/home/auma/captures/ring`, or the legacy `/dsh/home/auma-one` ring when the new one holds
 * no frame yet (read-only fallback; nothing is moved).
 * @returns the directory read, its frames oldest first, and whether it was the legacy ring.
 */
export function readCaptureRing(vfs: Vfs): { readonly dir: string; readonly frames: readonly string[]; readonly legacy: boolean } {
  const frames = ringFrames(vfs, CAPTURE_RING_DIR)
  if (frames.length > 0) return { dir: CAPTURE_RING_DIR, frames, legacy: false }
  const legacy = ringFrames(vfs, LEGACY_CAPTURE_RING_DIR)
  return legacy.length > 0
    ? { dir: LEGACY_CAPTURE_RING_DIR, frames: legacy, legacy: true }
    : { dir: CAPTURE_RING_DIR, frames: [], legacy: false }
}

/** The newest kept frame's path: the `/dsh/home/auma` copy first, then the legacy one; null when neither exists. */
export function latestCapturePath(vfs: Vfs): string | null {
  for (const path of CAPTURE_PATHS) { try { if (vfs.existsSync(path)) return path } catch { /* next */ } }
  return null
}

const decodeBase64 = (text: string): Uint8Array => Uint8Array.from(atob(text), char => char.charCodeAt(0))

/**
 * Keep one frame: `latest.png` in both homes, and the ring (oldest dropped past twelve).
 * @param vfs - her filesystem.
 * @param pngBase64 - the frame.
 * @param stamp - its watermark (`at` and `sha256` name the ring file).
 * @returns the ring file's path.
 */
export function keepCapture(vfs: Vfs, pngBase64: string, stamp: { readonly at?: unknown; readonly sha256?: unknown }): string {
  const bytes = decodeBase64(pngBase64)
  if (bytes.byteLength < 8 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) throw new Error('EYES_FRAME_NOT_PNG')
  for (const path of CAPTURE_PATHS) {
    vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
    vfs.writeFileSync(path, bytes)
  }
  vfs.mkdirSync(CAPTURE_RING_DIR, { recursive: true })
  const at = typeof stamp.at === 'string' ? stamp.at.replace(/[^0-9TZ]/gu, '') : String(Date.now())
  const sha = typeof stamp.sha256 === 'string' && /^[0-9a-f]{64}$/u.test(stamp.sha256) ? stamp.sha256.slice(0, 12) : 'unstamped'
  const path = `${CAPTURE_RING_DIR}/${at}-${sha}.png`
  vfs.writeFileSync(path, bytes)
  const frames = (vfs.readdirSync(CAPTURE_RING_DIR) as string[]).filter(name => name.endsWith('.png')).sort()
  for (const name of frames.slice(0, Math.max(0, frames.length - CAPTURE_RING_SIZE))) vfs.rmSync(`${CAPTURE_RING_DIR}/${name}`, { force: true })
  return path
}

/**
 * The host's eyes, or the page's when the host has none.
 * @param host - the host call (`/_host/eyes`).
 * @param body - the organ's request body.
 * @param deps - her filesystem, the channel, the id and wait.
 * @returns the host's own answer, or the page's as a 200 JSON answer, or 200 `{ ok: false, code: 'EYES_NO_PAGE' }`.
 */
export async function eyesWithPageFallback(host: () => Promise<Response>, body: string | undefined, deps: {
  readonly vfs?: () => Vfs | undefined
  readonly channel?: Channel
  readonly id: string
  readonly timeoutMs?: number
}): Promise<Response> {
  const answer = await host()
  if (!NO_HOST_EYES.has(answer.status)) return answer
  void answer.body?.cancel().catch(() => {})
  let request: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(body ?? '{}')
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) request = parsed as Record<string, unknown>
  } catch { /* the default look */ }
  const seen = await askPageEyes(request, deps)
  if (seen === null) {
    // 200 with ok:false, so the organ (which throws on any non-2xx) hands her the code and the reason.
    return Response.json({ ok: false, code: 'EYES_NO_PAGE', hostStatus: answer.status,
      error: 'The host has no eyes here and no open page answered. Open the app in a tab and ask again.' })
  }
  const { t: _t, id: _id, ...rest } = seen
  let captured: string | undefined
  let captureError: string | undefined
  let projectionSaved: string | undefined
  const rawVfs = deps.vfs?.()
  // Lane E6 (G1 live): captures are recorded and classified as they are written.
  const vfs = rawVfs === undefined ? undefined : liveWriteSet.wrap(rawVfs, 'page-eyes-bridge')
  if (rest.projection !== null && typeof rest.projection === 'object' && vfs !== undefined) {
    try {
      const payload = JSON.stringify({
        projection: rest.projection,
        watermark: rest.watermark ?? null,
        capturedAt: Date.now(),
      }, null, 2) + '\n'
      const bytes = new TextEncoder().encode(payload)
      for (const path of PROJECTION_PATHS) {
        vfs.mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true })
        vfs.writeFileSync(path, bytes)
      }
      projectionSaved = PROJECTION_PATHS[0]
    } catch {}
  }
  if (typeof rest.pngBase64 === 'string' && vfs !== undefined) {
    try { captured = keepCapture(vfs, rest.pngBase64, (rest.watermark ?? {}) as Record<string, unknown>) } catch (error) {
      captureError = error instanceof Error ? error.message : String(error)
    }
  }
  // Said in the answer itself: the organ's own description still speaks of a screenshot.
  const note = rest.frame === 'layout-drawing'
    ? 'Seen through the open page: the PNG is a drawing of the page layout (boxes and labels), not a pixel screenshot. '
      + 'The AUMLOK surface and private fields are left out.'
    : 'Seen through the open page. The AUMLOK surface and private fields are left out.'
  return Response.json({ ...rest, note, hostStatus: answer.status,
    ...(projectionSaved === undefined ? {} : { projectionPath: projectionSaved }),
    ...(captured === undefined ? {} : { ringPath: captured, capturePath: CAPTURE_PATHS[0] }),
    ...(captureError === undefined ? {} : { captureError }) })
}
