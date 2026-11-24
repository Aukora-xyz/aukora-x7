// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * AUMA'S EYES IN THE PAGE (Round 36). On the Mac, `/_host/eyes` drives a real headless browser. On the Cloudflare edge
 * there is none (it answers 501), so her worker asks the open page instead, over a same-origin BroadcastChannel
 * (`webworker-runtime/src/x6/page-eyes-bridge.ts`). This page answers with:
 *
 *   - a compact projection of the live DOM (viewport, focus, headings, visible controls with their boxes, a text summary,
 *     about 2 KB);
 *   - for `screenshot`, a PNG frame DRAWN from that projection (boxes and labels on the canvas), not a pixel capture: a
 *     page cannot photograph itself. It is stamped `epoch · build · time · sha256`, the sha256 being the projection's.
 *
 * A visible tab answers at once; a hidden one waits a little, so the tab the owner is looking at is the one she sees.
 * @module eyes/page-eyes
 */

export const EYES_CHANNEL = 'aukora-eyes/v1'
/**
 * Never seen by her eyes: the AUMLOK surface (where the seven words show, and are typed), anything marked
 * `data-private`, and password fields. Their text, names and boxes are left out of every projection and frame, also
 * when a selector names them or an element around them.
 */
export const PRIVATE_SUBTREES = '[data-aumlok-surface], [data-aumlok-tile-face], [data-aumlok-tile-input], [data-private], input[type="password"]'
const isPrivate = (element: Element): boolean => element.closest(PRIVATE_SUBTREES) !== null
/** An element's text with every private part removed (and no script or style source). */
function publicText(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll(`${PRIVATE_SUBTREES}, script, style, noscript, template`)) hidden.remove()
  return copy.textContent ?? ''
}
const PROJECTION_BYTES = 2400
const HIDDEN_DELAY_MS = 400

export interface EyesControl {
  readonly role: string
  readonly name: string
  /** [x, y, width, height] in CSS pixels, rounded. */
  readonly rect: readonly [number, number, number, number]
}
export interface EyesHeadingBox {
  readonly text: string
  readonly rect: readonly [number, number, number, number]
}
export interface EyesCanvasBox {
  readonly id: string
  readonly rect: readonly [number, number, number, number]
  readonly width: number
  readonly height: number
}
export interface EyesProjection {
  readonly url: string
  readonly title: string
  readonly viewport: { readonly width: number; readonly height: number; readonly dpr: number }
  readonly focused: string | null
  readonly headings: readonly string[]
  readonly headingBoxes?: readonly EyesHeadingBox[]
  readonly canvases?: readonly EyesCanvasBox[]
  readonly controls: readonly EyesControl[]
  readonly text: string
  readonly selector?: { readonly selector: string; readonly found: boolean; readonly rect?: EyesControl['rect']; readonly text?: string }
  /** Controls left out to stay near 2 KB. */
  readonly omittedControls: number
}

const clip = (value: string, max: number): string => {
  const flat = value.replace(/\s+/gu, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}
const rectOf = (element: Element): EyesControl['rect'] => {
  const box = element.getBoundingClientRect()
  return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)]
}
const visible = (element: Element, width: number, height: number): boolean => {
  const [x, y, w, h] = rectOf(element)
  return w > 0 && h > 0 && x < width && y < height && x + w > 0 && y + h > 0
}
const nameOf = (element: Element): string => clip(element.getAttribute('aria-label') ?? element.getAttribute('title')
  ?? (element as HTMLInputElement).placeholder ?? element.textContent ?? '', 60)
const roleOf = (element: Element): string => element.getAttribute('role') ?? element.tagName.toLowerCase()

/**
 * Project the live page.
 * @param doc - the document (tests pass their own).
 * @param view - its window.
 * @param selector - an optional CSS selector to report on.
 * @returns the projection, kept near 2 KB.
 */
export function projectPage(doc: Document, view: Window, selector?: string): EyesProjection {
  const width = view.innerWidth, height = view.innerHeight
  const headingNodes = [...doc.querySelectorAll('h1, h2, h3, [role="heading"]')]
    .filter(element => !isPrivate(element) && visible(element, width, height))
    .slice(0, 12)
  const headings = headingNodes.map(element => clip(element.textContent ?? '', 80)).filter(Boolean)
  const headingBoxes: EyesHeadingBox[] = headingNodes
    .map(element => ({ text: clip(element.textContent ?? '', 80), rect: rectOf(element) }))
    .filter(item => Boolean(item.text))
  const canvases: EyesCanvasBox[] = [...doc.querySelectorAll('canvas')]
    .filter(element => !isPrivate(element) && visible(element, width, height))
    .slice(0, 6)
    .map(element => ({
      id: clip(element.id || element.getAttribute('aria-label') || element.getAttribute('data-testid') || 'canvas', 60),
      rect: rectOf(element),
      width: (element as HTMLCanvasElement).width || 0,
      height: (element as HTMLCanvasElement).height || 0,
    }))
  const all = [...doc.querySelectorAll('button, a[href], input, textarea, select, [role="button"], [role="tab"], [contenteditable="true"]')]
    .filter(element => !isPrivate(element) && visible(element, width, height))
    .map(element => ({ role: roleOf(element), name: nameOf(element), rect: rectOf(element) }))
  const active = doc.activeElement
  const focused = active === null || active === doc.body ? null : isPrivate(active) ? 'a private field' : `${roleOf(active)} ${nameOf(active)}`.trim()
  let picked: EyesProjection['selector']
  if (typeof selector === 'string' && selector.trim() !== '') {
    let found: Element | null = null
    try { found = doc.querySelector(selector) } catch { found = null }
    picked = found === null || isPrivate(found) ? { selector: clip(selector, 200), found: false }
      : { selector: clip(selector, 200), found: true, rect: rectOf(found), text: clip(publicText(found), 200) }
  }
  const text = doc.body === null ? '' : clip(publicText(doc.body), 600)
  let controls = all.slice(0, 60)
  const build = (): EyesProjection => ({
    url: view.location.href, title: clip(doc.title, 120), viewport: { width, height, dpr: view.devicePixelRatio || 1 },
    focused, headings,
    ...(headingBoxes.length > 0 ? { headingBoxes } : {}),
    ...(canvases.length > 0 ? { canvases } : {}),
    controls, text, ...(picked === undefined ? {} : { selector: picked }), omittedControls: all.length - controls.length,
  })
  let projection = build()
  while (controls.length > 0 && new TextEncoder().encode(JSON.stringify(projection)).byteLength > PROJECTION_BYTES) {
    controls = controls.slice(0, Math.floor(controls.length * 0.8))
    projection = build()
  }
  return projection
}

export const sha256Hex = async (text: string): Promise<string> =>
  [...new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))]
    .map(byte => byte.toString(16).padStart(2, '0')).join('')

/** The facts the frame is stamped with. */
export interface EyesStamp {
  readonly epoch: string
  readonly build: string
  readonly at: string
  readonly sha256: string
}
export const stampWords = (stamp: EyesStamp): string => `epoch ${stamp.epoch} · ${stamp.build} · ${stamp.at} · sha256 ${stamp.sha256}`

/**
 * Draw a projection as a PNG: the page's background, each control's box and label, the headings, and the stamp.
 * @param projection - what to draw.
 * @param stamp - the watermark.
 * @param doc - the document whose canvas draws it.
 * @returns base64 PNG bytes, or null when this page cannot draw.
 */
export function drawFrame(projection: EyesProjection, stamp: EyesStamp, doc: Document): string | null {
  const canvas = doc.createElement('canvas')
  const scale = Math.min(1, 1280 / Math.max(1, projection.viewport.width))
  canvas.width = Math.max(1, Math.round(projection.viewport.width * scale))
  canvas.height = Math.max(1, Math.round(projection.viewport.height * scale)) + 28
  const g = canvas.getContext('2d')
  if (g === null) return null
  g.fillStyle = '#111520'
  g.fillRect(0, 0, canvas.width, canvas.height)
  g.font = '12px ui-sans-serif, system-ui, sans-serif'
  g.textBaseline = 'top'
  projection.headings.forEach((heading, index) => {
    g.fillStyle = '#c9d6ff'
    g.fillText(heading, 8, 8 + index * 16, canvas.width - 16)
  })
  for (const control of projection.controls) {
    const [x, y, w, h] = control.rect.map(value => value * scale) as [number, number, number, number]
    g.strokeStyle = control.role === 'a' ? '#7fb2ff' : '#e4c46b'
    g.strokeRect(x + 0.5, y + 0.5, w, h)
    g.fillStyle = '#e8ecf5'
    g.fillText(control.name || control.role, x + 3, y + 2, Math.max(8, w - 6))
  }
  if (projection.selector?.rect !== undefined) {
    const [x, y, w, h] = projection.selector.rect.map(value => value * scale) as [number, number, number, number]
    g.strokeStyle = '#ff6b6b'
    g.lineWidth = 2
    g.strokeRect(x, y, w, h)
  }
  g.fillStyle = '#05070c'
  g.fillRect(0, canvas.height - 28, canvas.width, 28)
  g.fillStyle = '#9fb0d0'
  g.fillText(stampWords(stamp), 8, canvas.height - 21, canvas.width - 16)
  const url = canvas.toDataURL('image/png')
  return url.startsWith('data:image/png;base64,') ? url.slice('data:image/png;base64,'.length) : null
}

/** Read the epoch and build to stamp with: HEAD's epoch, and the edge's build (the Mac reports none here). */
async function readStampFacts(fetchImpl: typeof fetch): Promise<{ epoch: string; build: string }> {
  const json = async (path: string): Promise<Record<string, unknown> | null> => {
    try {
      const response = await fetchImpl(path, { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(2000) })
      const body: unknown = response.ok ? await response.json() : null
      return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
    } catch { return null }
  }
  // HEAD's metadata only (`?meta=1`: the manifest and lease, never the module bodies), on the edge and the Mac alike.
  const [lease, health] = await Promise.all([json('/_head/ball?meta=1'), json('/api/health')])
  const epoch = Number.isSafeInteger(lease?.epoch) && (lease?.epoch as number) >= 0 ? String(lease?.epoch) : '—'
  const build = typeof health?.buildSha === 'string' && /^[0-9a-f]{7,40}$/u.test(health.buildSha) ? health.buildSha.slice(0, 12) : 'build —'
  return { epoch, build }
}

/** One answer to the worker. */
export interface EyesAnswer {
  readonly t: 'eyes-answer'
  readonly id: string
  readonly ok: boolean
  readonly source: 'page'
  readonly projection?: EyesProjection
  readonly frame?: 'layout-drawing'
  readonly pngBase64?: string
  readonly watermark?: EyesStamp
  readonly error?: string
}

export interface PageEyesDependencies {
  readonly doc: Document
  readonly view: Window
  readonly fetchImpl: typeof fetch
  readonly now: () => Date
  readonly draw?: typeof drawFrame
}

/**
 * Answer one eyes request from the worker.
 * @param data - the request (anything else gets no answer).
 * @param deps - the page, its fetch and clock.
 * @returns the answer, or null when the message is not an eyes request.
 */
export async function answerEyes(data: unknown, deps: PageEyesDependencies): Promise<EyesAnswer | null> {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return null
  const request = data as Record<string, unknown>
  if (request.t !== 'eyes-request' || typeof request.id !== 'string' || !/^[A-Za-z0-9-]{1,64}$/u.test(request.id)) return null
  const id = request.id
  const action = request.action === undefined ? 'projection' : request.action
  if (action !== 'projection' && action !== 'screenshot') return { t: 'eyes-answer', id, ok: false, source: 'page', error: 'EYES_ACTION_INVALID' }
  const selector = typeof request.selector === 'string' && request.selector.length <= 200 ? request.selector : undefined
  try {
    const projection = projectPage(deps.doc, deps.view, selector)
    if (action === 'projection') return { t: 'eyes-answer', id, ok: true, source: 'page', projection }
    const facts = await readStampFacts(deps.fetchImpl)
    const watermark: EyesStamp = { ...facts, at: deps.now().toISOString(), sha256: await sha256Hex(JSON.stringify(projection)) }
    const pngBase64 = (deps.draw ?? drawFrame)(projection, watermark, deps.doc)
    return pngBase64 === null
      ? { t: 'eyes-answer', id, ok: true, source: 'page', projection, watermark, error: 'EYES_FRAME_UNAVAILABLE' }
      : { t: 'eyes-answer', id, ok: true, source: 'page', projection, frame: 'layout-drawing', pngBase64, watermark }
  } catch (error) {
    return { t: 'eyes-answer', id, ok: false, source: 'page', error: `EYES_PAGE_FAILED: ${error instanceof Error ? error.message : String(error)}`.slice(0, 200) }
  }
}

/**
 * Let her worker see this page: answer eyes requests on the same-origin channel while the page is open.
 * @param deps - the page (defaults to this one); `channel` for tests.
 * @returns stop listening.
 */
export function installPageEyes(deps?: Partial<PageEyesDependencies> & { readonly channel?: BroadcastChannel }): () => void {
  if (deps?.channel === undefined && typeof BroadcastChannel !== 'function') return () => {}
  const channel = deps?.channel ?? new BroadcastChannel(EYES_CHANNEL)
  const page: PageEyesDependencies = { doc: deps?.doc ?? document, view: deps?.view ?? window,
    fetchImpl: deps?.fetchImpl ?? ((input, init) => globalThis.fetch(input, init)), now: deps?.now ?? (() => new Date()),
    ...(deps?.draw === undefined ? {} : { draw: deps.draw }) }
  let stopped = false
  const onMessage = (event: MessageEvent): void => {
    const hidden = page.doc.visibilityState === 'hidden'
    void (async () => {
      if (hidden) await new Promise(resolve => setTimeout(resolve, HIDDEN_DELAY_MS))
      const answer = await answerEyes(event.data, page)
      if (answer !== null && !stopped) channel.postMessage(answer)
    })()
  }
  channel.addEventListener('message', onMessage)
  return () => {
    stopped = true
    channel.removeEventListener('message', onMessage)
    if (deps?.channel === undefined) channel.close()
  }
}
