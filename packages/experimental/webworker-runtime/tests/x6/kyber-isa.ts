/**
 * The Kyber Kernel ISA as a plain oracle (test tree only), written from the report's description of the machine
 *: four-bit registers a and b, a three-bit pc, a halt bit, eight ROM words of ten bits. No
 * circuit, no weights: a switch on the opcode. Also the cell's documented checkpoint check, and the countdown skill's
 * program and evidence, derived here so the spec can rebuild the shipped record from this oracle byte for byte.
 */
import type { SkillCase, SkillRecord } from '../../src/x6/skill-record.ts'

export const KYBER_STATE_SCHEMA = 'aukora.kyber-cpu.state.v1'
export const KYBER_ORACLE = 'kyber-isa.v0: packages/experimental/webworker-runtime/tests/x6/kyber-isa.ts'
export const KYBER_MAX_STEPS = 4096

export interface KyberState { readonly a: number; readonly b: number; readonly halted: number; readonly pc: number }
export interface KyberRun { readonly halted: number; readonly state: KyberState; readonly stepsTaken: number }

/** Opcodes, in the report's order. */
export const OP = Object.freeze({ INC0: 0, ADD01: 1, XOR01: 2, DEC1: 3, JNZ1: 4, MOVI0: 5, HALT: 6, SWAP: 7 })

/** One ROM word: op[0:3] | imm[3:7] | target[7:10]. */
export const word = (op: number, imm = 0, target = 0): number => op | (imm << 3) | (target << 7)
export const pack = (s: KyberState): number => s.a | (s.b << 4) | (s.pc << 8) | (s.halted << 11)
export const unpack = (v: number): KyberState => ({ a: v & 15, b: (v >> 4) & 15, halted: (v >> 11) & 1, pc: (v >> 8) & 7 })

/**
 * One transition of the packed state.
 * @param packed - a | b<<4 | pc<<8 | halted<<11.
 * @param rom - eight words.
 * @returns the next packed state.
 */
export function isaStep(packed: number, rom: readonly number[]): number {
  const current = unpack(packed)
  const pc = current.pc
  let { a, b, halted } = current
  if (halted) return packed
  const instruction = rom[pc] ?? 0
  const op = instruction & 7, imm = (instruction >> 3) & 15, target = instruction >> 7
  let next = (pc + 1) & 7
  switch (op) {
    case OP.INC0: a = (a + 1) & 15; break
    case OP.ADD01: a = (a + b) & 15; break
    case OP.XOR01: a ^= b; break
    case OP.DEC1: b = (b + 15) & 15; break
    case OP.JNZ1: if (b !== 0) next = target; break
    case OP.MOVI0: a = imm; break
    case OP.HALT: next = pc; halted = 1; break
    default: [a, b] = [b, a]
  }
  return pack({ a, b, halted, pc: next })
}

/**
 * Run until halted or `steps` transitions, from `stepsTaken` already taken.
 * @returns the run's end.
 */
export function isaRun(state: KyberState, rom: readonly number[], steps: number, stepsTaken = 0): KyberRun {
  let packed = pack(state), taken = stepsTaken
  while (taken < steps && ((packed >> 11) & 1) === 0) {
    packed = isaStep(packed, rom)
    taken += 1
  }
  return { halted: (packed >> 11) & 1, state: unpack(packed), stepsTaken: taken }
}

const mix = (h: number, x: number): number => Math.imul(h ^ x, 16777619)

/**
 * The checkpoint check as kyber-cpu.wat documents it: a 32-bit mix of ROM, packed state, steps and stepsTaken under the
 * constant "KYBE" (0x4B594245), with a final avalanche. A checksum, not authentication.
 */
export function kyberCheck(rom: readonly number[], state: KyberState, steps: number, stepsTaken: number): number {
  let h = 0x4b594245
  for (const value of rom) h = mix(h, value)
  h = mix(mix(mix(h, pack(state)), steps), stepsTaken)
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

/**
 * Countdown: a := 0, then while b != 0 { b -= 1; a += 1 }, halt. From b = n it halts with a = n, b = 0 after 3n + 3
 * steps (3 when n = 0, at pc 2; otherwise at pc 6).
 */
export const COUNTDOWN_ROM: readonly number[] = Object.freeze([
  word(OP.MOVI0, 0), word(OP.JNZ1, 0, 3), word(OP.HALT), word(OP.DEC1),
  word(OP.INC0), word(OP.JNZ1, 0, 3), word(OP.HALT), word(OP.HALT),
])
export const COUNTDOWN_STEPS = 64

/** Sixteen evidence cases, b = 0..15 (a = 15 - b, overwritten by the program), each a `cpu.run` call and its answer. */
export function countdownCases(): SkillCase[] {
  return Array.from({ length: 16 }, (_, b) => {
    const state = { a: 15 - b, b, halted: 0, pc: 0 }
    return {
      op: 'cpu.run',
      input: { rom: [...COUNTDOWN_ROM], state, steps: COUNTDOWN_STEPS },
      output: isaRun(state, COUNTDOWN_ROM, COUNTDOWN_STEPS),
    }
  })
}

/** The countdown skill record, from the oracle and the three artifact digests. */
export function countdownRecord(digests: { cell: string; program: string; weights: string; scalars: number }): SkillRecord {
  return {
    schema: 'aukora.skill.v1',
    name: 'countdown',
    cell: { kind: 'pinned', name: 'kyber-cpu', sha256: digests.cell, abi: 1, ops: ['cpu.step', 'cpu.run', 'cpu.resume'] },
    op: 'cpu.run',
    program: { digest: digests.program },
    weights: { digest: digests.weights, scalars: digests.scalars },
    state: { schema: KYBER_STATE_SCHEMA },
    evidence: { cases: countdownCases(), oracle: KYBER_ORACLE },
  }
}
