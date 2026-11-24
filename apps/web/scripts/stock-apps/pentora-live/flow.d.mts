// Types for flow.mjs.
export declare const FLOW: {
  readonly T_MS: number
  readonly HISTORY_MS: number
  readonly HOLD_FLOOR: number
  readonly MARGIN: number
  readonly CONFIRM_FRAMES: number
  readonly REACH: number
  readonly PHASE_MS: number
}
export type FlowConstants = typeof FLOW
export declare const VALUE: { readonly IN: -1; readonly HOLD: 0; readonly OUT: 1 }
export type FlowValue = -1 | 0 | 1
export interface Levels { readonly mic?: number; readonly think?: number; readonly say?: number }
export interface History { push(t: number, v: unknown): void; at(t: number): number; readonly size: number }
export interface Histories { readonly mic: History; readonly think: History; readonly say: History }
export interface Amplitudes { readonly in: number; readonly hold: number; readonly out: number }
export declare function createHistory(keepMs?: number): History
export declare function amplitudes(shell: number, t: number, history: Histories, flow?: FlowConstants, cube?: number): Amplitudes
export declare function phaseCubeOf(cubes: readonly number[]): number
export declare function candidateOf(amp: Amplitudes): FlowValue
export interface Flow {
  readonly values: Int8Array
  readonly history: Histories
  step(t: number, levels: Levels): { readonly values: Int8Array; readonly changed: readonly number[] }
}
export declare function createFlow(shells: readonly number[], flow?: FlowConstants, phases?: readonly number[]): Flow
