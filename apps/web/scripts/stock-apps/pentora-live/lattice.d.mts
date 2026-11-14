// Types for lattice.mjs (plain JS so that only esbuild and vitest follow its import into ui-layout's tables.ts).
export declare const HEART: 55
export declare const SHELL: { readonly CORNER: 0; readonly EDGE: 1; readonly FACE: 2; readonly HEART: 3 }
export type Shell = 0 | 1 | 2
export type Family = 'edge' | 'cross' | 'spoke'
export interface LatticeCell {
  readonly index: number
  readonly g: number
  readonly shell: Shell
  readonly cubes: readonly number[]
  readonly point: readonly [number, number, number]
}
export interface LatticeLine {
  readonly index: number
  readonly family: Family
  readonly cube: number
  /** The outer end (lower shell). */
  readonly a: number
  /** The inner end (higher shell, or the heart). */
  readonly b: number
}
export interface OrbitStep { readonly line: number; readonly dir: 1 | -1 }
export interface Lattice {
  readonly heart: 55
  readonly cells: readonly LatticeCell[]
  readonly cellOf: ReadonlyMap<number, number>
  readonly lines: readonly LatticeLine[]
  readonly inward: ReadonlyMap<number, readonly number[]>
  readonly outward: ReadonlyMap<number, readonly number[]>
  readonly cornerEdges: ReadonlyMap<number, readonly number[]>
  readonly orbits: readonly (readonly OrbitStep[])[]
  readonly cubeCount: number
}
export interface CubeTable {
  readonly edges: readonly (readonly [number, number])[]
  readonly edgeMidpoints: readonly number[]
  readonly faceCentres: readonly number[]
  readonly corners: readonly number[]
}
export declare function buildLattice(cubes?: readonly CubeTable[], cornerCells?: readonly number[]): Lattice
export declare const LATTICE: Lattice
export declare function pointAt(g: number): readonly [number, number, number]
