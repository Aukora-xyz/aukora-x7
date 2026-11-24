// Types for auma-live-trace.mjs (the source of /app/aura-trace.js).
import type { PentoraLiveOptions, TraceState } from './pentora-live/renderer.mjs'
export interface AuraTrace {
  readonly element: HTMLDivElement
  resize(): void
  setActive(value: boolean): void
  draw(elapsedMs: number, state: TraceState): void
  destroy(): void
}
export declare function createAuraTrace(options?: PentoraLiveOptions): AuraTrace
