// A file of an earlier repository, pointed at x6.1's port of the Pentora figure. Auma Live
// imports `createAuraTrace` from `/app/aura-trace.js`; this is that module's source. Plain JS on purpose: the web
// project typechecks `scripts/`, and this file reaches into another project, which only esbuild should follow.
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { PentoraFigure } from '../../../../packages/client/ui-layout/src/client/spatial/aura/PentoraFigure.tsx'
import { absentHealth } from '../../../../packages/client/ui-layout/src/client/spatial/aura/model.ts'

export function createAuraTrace() {
  const element = document.createElement('div')
  element.className = 'alv-aura-trace'
  element.setAttribute('aria-hidden', 'true')
  const root = createRoot(element)
  const live = { current: { pulses: [], working: false } }
  const health = absentHealth()
  let active = true
  const render = () => root.render(createElement(PentoraFigure, { view: health, active, focus: null, live }))
  render()
  return {
    element,
    resize() {},
    setActive(value) { active = value; render() },
    draw(_elapsedMs, state) {
      live.current.working = Math.max(state.mic, state.say, state.think) > 0.02
    },
    destroy() { root.unmount() },
  }
}
