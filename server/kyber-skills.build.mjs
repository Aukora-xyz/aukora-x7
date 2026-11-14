/**
 * Build the shipped Kyber skills through the one skill encoder, no copy of it:
 * packages/experimental/webworker-runtime/src/x6/skill-record.ts (`aukora.skill.v1`, the cell ABI's canonical JSON).
 *   apps/web/public/cells/kyber/skills/countdown.json  the countdown record: the pinned `kyber-cpu` cell, the program
 *       countdown.rom.json and the weights by digest, and sixteen evidence cases from the ISA oracle
 *       (packages/experimental/webworker-runtime/tests/x6/kyber-isa.ts, the oracle the record names);
 *   apps/web/public/cells/kyber/skills/cord-echo.json  the cord-echo skill: the cord-echo record (docs/auma/cord-echo.md): the
 *       pinned `cord-echo` cell, op `cord.run`, the program cord-echo.program.json ({"profile":"fifo24"}), no weights, and
 *       three `cord.run` cases from genesis whose answers come from the TypeScript oracle in src/x6/cord-run.ts. The cases'
 *       checkpoints name the fixed skill CORD_CASE_SKILL (a record cannot contain its own id);
 *   apps/web/public/cells/kyber/skills/index.json      the index her `x6_skill list` reads: each shipped skill's id, name
 *       and the paths (under /cells/) of its record, program and weights.
 * Runs under tsx (the encoder is TypeScript):
 *   ./node_modules/.bin/tsx server/kyber-skills.build.mjs          (check: exit 1 if a checked-in file is stale)
 *   ./node_modules/.bin/tsx server/kyber-skills.build.mjs --write  (write both files)
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { artifactDigest, canonicalBytes, encodeSkill, skillId, verifySkill } from '../packages/experimental/webworker-runtime/src/x6/skill-record.ts'
import { countdownRecord } from '../packages/experimental/webworker-runtime/tests/x6/kyber-isa.ts'
import { CORD_CASE_SKILL, CORD_STATE_SCHEMA, cordGenesis, cordRunOracle } from '../packages/experimental/webworker-runtime/src/x6/cord-run.ts'

const CELLS = new URL('../apps/web/public/cells/', import.meta.url)
export const SKILL_INDEX_SCHEMA = 'aukora.skill-index.v1'
/** Paths are relative to /cells/ (served same-origin beside the cells). */
const COUNTDOWN = Object.freeze({ record: 'kyber/skills/countdown.json', program: 'kyber/skills/countdown.rom.json', weights: 'kyber/cpu-weights.json' })
export const INDEX_PATH = 'kyber/skills/index.json'
const CORD_ECHO = Object.freeze({ record: 'kyber/skills/cord-echo.json', program: 'kyber/skills/cord-echo.program.json' })
/** The three fixed segments of the cord-echo cases, each fed from genesis. */
export const CORD_ECHO_CASE_INPUTS = Object.freeze([
  Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]),
  Object.freeze(Array.from({ length: 30 }, (_, index) => index + 1)),
  Object.freeze(Array.from({ length: 48 }, (_, index) => (index * 7919 + 13) % 65521)),
])

/** The cord-echo record: the cell answers each case as the oracle does, or `x6_skill check cord-echo` says it differs. */
async function cordEchoRecord(read) {
  const cell = await artifactDigest(read('cord-echo.wasm'))
  const profileSha256 = await artifactDigest(read('cord/fifo24.profile.json'))
  const genesis = await cordGenesis(cell, CORD_CASE_SKILL, profileSha256)
  const cases = []
  for (const inputs of CORD_ECHO_CASE_INPUTS) {
    const input = { checkpoint: genesis, expect: { head: genesis.head, tick: 0 }, inputs: [...inputs], profile: 'fifo24' }
    cases.push({ op: 'cord.run', input, output: await cordRunOracle(genesis, inputs) })
  }
  return encodeSkill({ schema: 'aukora.skill.v1', name: 'cord-echo',
    cell: { kind: 'pinned', name: 'cord-echo', sha256: cell, abi: 1, ops: ['cord.genesis', 'cord.run', 'cord.info'] },
    op: 'cord.run', program: { digest: await artifactDigest(read(CORD_ECHO.program)) }, weights: null,
    state: { schema: CORD_STATE_SCHEMA }, evidence: { cases, oracle: 'cord-run.ts cordRunOracle (TypeScript, WebCrypto)' } })
}

/** The two files this script owns, built now from their sources: `{ path, bytes }`, path relative to /cells/. */
export async function buildKyberSkills() {
  const read = path => new Uint8Array(readFileSync(new URL(path, CELLS)))
  const cell = read('kyber-cpu.wasm'), program = read(COUNTDOWN.program), weights = read(COUNTDOWN.weights)
  const record = encodeSkill(countdownRecord({ cell: await artifactDigest(cell), program: await artifactDigest(program),
    weights: await artifactDigest(weights), scalars: 1329 }))
  const id = await skillId(record)
  // The record must verify against the very bytes it names before it is shipped.
  const verdict = await verifySkill(record, { cell, program, weights }, id)
  if (!verdict.ok) throw new Error(`countdown does not verify: ${verdict.code}`)
  const cord = await cordEchoRecord(read)
  const cordId = await skillId(cord)
  const cordVerdict = await verifySkill(cord, { cell: read('cord-echo.wasm'), program: read(CORD_ECHO.program) }, cordId)
  if (!cordVerdict.ok) throw new Error(`cord-echo does not verify: ${cordVerdict.code}`)
  const index = canonicalBytes({ schema: SKILL_INDEX_SCHEMA, skills: [{ id, name: 'countdown', ...COUNTDOWN }, { id: cordId, name: 'cord-echo', ...CORD_ECHO }] })
  return [{ path: COUNTDOWN.record, bytes: record, id }, { path: CORD_ECHO.record, bytes: cord, id: cordId }, { path: INDEX_PATH, bytes: index, id: null }]
}

/**
 * Whether each checked-in file is byte for byte what the build gives now.
 * @param {(path: string) => Uint8Array} [readShipped] - reads a checked-in file by its path under /cells/ (tests pass
 *   their own; default: the file in apps/web/public/cells).
 */
export async function checkKyberSkills(readShipped = path => new Uint8Array(readFileSync(new URL(path, CELLS)))) {
  return (await buildKyberSkills()).map(({ path, bytes }) => {
    let shipped = null
    try { shipped = readShipped(path) } catch { /* Missing is stale. */ }
    return { path, current: shipped !== null && Buffer.from(shipped).equals(Buffer.from(bytes)) }
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const write = process.argv.includes('--write')
  if (write) for (const { path, bytes } of await buildKyberSkills()) writeFileSync(new URL(path, CELLS), bytes)
  const checked = await checkKyberSkills()
  for (const { path, current } of checked) console.log(`${path.padEnd(32)} ${current ? 'current' : 'STALE'}`)
  for (const { path, id } of await buildKyberSkills()) if (id) console.log(`${path} id ${id}`)
  process.exit(checked.every(file => file.current) ? 0 : 1)
}
