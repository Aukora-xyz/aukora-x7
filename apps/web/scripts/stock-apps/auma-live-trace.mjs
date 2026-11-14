// The source of `/app/aura-trace.js`: the living Pentora behind Auma Live's voice field (pentora-live/renderer.mjs).
// Auma Live imports `createAuraTrace` and calls it with nothing; the seam is unchanged:
//   { element, resize(), setActive(v), draw(elapsedMs, { color, mic, say, think }), destroy() }
// The element keeps the class `alv-aura-trace`, `aria-hidden="true"` and no pointer events, behind the orb, the
// transcript and the controls. Plain JS on purpose: the web project typechecks `scripts/`, and the lattice reaches
// into another project, which only esbuild should follow. No React.
import './pentora-live/pentora-live.css'
import { createPentoraLive } from './pentora-live/renderer.mjs'

/** @param options - only for tests and the harness: the browser globals createPentoraLive accepts. */
export function createAuraTrace(options = {}) {
  const doc = options.document ?? document
  const element = doc.createElement('div')
  element.className = 'alv-aura-trace alv-pentora-live'
  element.setAttribute('aria-hidden', 'true')
  // The figure is centred in this layer's box (the whole field), on a canvas only as large as the figure and its glow.
  const live = createPentoraLive({ ...options, document: doc, box: element })
  element.append(live.element)
  return {
    element,
    resize() { live.resize() },
    setActive(value) { live.setActive(value) },
    draw(elapsedMs, state) { live.draw(elapsedMs, state) },
    destroy() { live.destroy() },
  }
}
