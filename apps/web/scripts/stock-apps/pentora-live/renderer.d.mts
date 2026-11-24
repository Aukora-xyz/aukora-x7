// Types for renderer.mjs.
import type { Packet } from './packets.mjs'
export declare const TOKENS: readonly (readonly [string, readonly [number, number, number]])[]
export declare const PROJECTION: {
  readonly VIEW: number
  readonly SPAN: number
  readonly TILT: number
  readonly PERSPECTIVE: number
  readonly START_ANGLE: number
  readonly FIGURE_SHARE: number
  readonly FIGURE_MAX_PX: number
  readonly DPR_MAX: number
}
export declare const CORE: readonly [number, number, number]
export declare const LIT_CORE: number
export declare const CANVAS: { readonly MARGIN: number; readonly SIDE_MAX_PX: number }
export declare const LIGHT: { readonly BOUND: number; readonly BUDGET: number; readonly BIN: number }
export declare const LIT_ALPHA: number
export declare const PACKET_ALPHA: { readonly flow: number; readonly orbit: number }
export type Stops = readonly (readonly [number, number])[]
export declare const SPRITE_STOPS: { readonly glow: Stops; readonly packet: Stops; readonly core: Stops; readonly heart: Stops }
export declare function profileAt(stops: Stops, u: number): number
export declare function project(point: readonly [number, number, number], angle: number, tilt: number, roll: number, breath: number): [number, number, number, number]
export declare function figureSize(width: number): number
export declare function readTokens(win: unknown, doc: unknown): number[][]
export interface PentoraLiveOptions {
  readonly document?: Document
  readonly window?: unknown
  readonly requestAnimationFrame?: (callback: (now: number) => void) => number
  readonly cancelAnimationFrame?: (id: number) => void
  readonly now?: () => number
  readonly getContext?: (canvas: HTMLCanvasElement) => unknown
  readonly box?: Element
}
export interface TraceState { readonly color?: unknown; readonly mic?: number; readonly say?: number; readonly think?: number }
export interface PentoraLiveStats {
  readonly frames: number
  readonly cores: number
  readonly heart: number
  readonly strokes: number
  readonly packets: number
  readonly packetsDrawn: number
  readonly lit: number
  readonly lastMs: number
  readonly meanMs: number
}
export interface PentoraLive {
  readonly element: HTMLCanvasElement
  readonly canvas: HTMLCanvasElement
  readonly stats: PentoraLiveStats
  readonly sprites: {
    readonly glow: readonly HTMLCanvasElement[]
    readonly packet: readonly HTMLCanvasElement[]
    readonly core: readonly HTMLCanvasElement[]
    readonly heart: readonly HTMLCanvasElement[]
  }
  resize(): void
  setActive(value: boolean): void
  draw(elapsedMs: number, state: TraceState): void
  destroy(): void
  inspect(): {
    readonly values: Int8Array
    readonly packets: readonly Packet[]
    readonly still: boolean
    readonly running: boolean
    readonly frame: number
    readonly angle: number
    readonly work: number
    readonly size: readonly [number, number, number]
    readonly layout: { readonly side: number; readonly left: number; readonly top: number; readonly backing: number }
    at(g: number): readonly [number, number, number]
  }
}
export declare function createPentoraLive(options?: PentoraLiveOptions): PentoraLive
