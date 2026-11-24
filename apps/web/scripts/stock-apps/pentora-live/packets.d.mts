// Types for packets.mjs.
import type { Lattice } from './lattice.mjs'
export declare const PACKETS: {
  readonly CAP: number
  readonly PER_LINE: number
  readonly FLOW_MS: number
  readonly ORBIT_MS: number
  readonly ORBIT_START: number
  readonly ORBIT_KEEP: number
  readonly ORBIT_EVERY_MS: number
  readonly ORBIT_STEPS: number
}
export interface Packet {
  readonly kind: 'flow' | 'orbit'
  readonly line: number
  readonly dir: 1 | -1
  readonly t: number
  readonly value: -1 | 0 | 1
  readonly hop: number
  readonly cube: number
  readonly steps: number
}
export interface Packets {
  readonly list: readonly Packet[]
  emitChange(g: number, value: number): number
  step(dtMs: number, think: number): void
  clear(): void
  setStill(value: boolean): void
  onLine(line: number): number
  readonly size: number
}
export declare function createPackets(lattice: Lattice, options?: { readonly cap?: number; readonly still?: boolean; readonly perLine?: number }): Packets
