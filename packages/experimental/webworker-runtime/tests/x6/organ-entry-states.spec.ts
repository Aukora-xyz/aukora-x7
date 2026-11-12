/**
 * Every HEAD entry says its state, read from its fiber's ACTUAL lifecycle.
 *
 * An earlier version let a Seed export's name differ from its entry id and then policed tool names inside the loader;
 * that was undone, because "running" was computed from the stored specifier
 * and config, not from the fiber. Naming is exactly main's again (export name equals entry id), so her
 * two misnamed organs (`auma-cortex` exporting `auma_cortex`, `seed-continuity` exporting `seed_continuity`) stay not
 * running, and SHE fixes them by staging corrected organs; this job makes the cause visible, with both names.
 *
 * Every spec here mounts her runtime into a REAL Cordis Context with DSH's REAL ToolsService (and the real
 * `@deepseek-ai/dsh-tools` defineTool), as her worker does; the stand-ins of jobs 3-4 proved the wrong thing.
 * Every answer is local (reserved `.invalid` origin, fake socket); no provider, owner approval or live DO is touched.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import type { BallEntryRecord, BallManifest } from '../../src/x6/ball-loader.ts'
import { FakeSocket, headManifestIdCanon, mountE4, sha256 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

const MIRROR = fileURLToPath(new URL('../../../../../mirror/home/', import.meta.url))
const stored = (sha: string): string => {
  const code = readFileSync(`${MIRROR}balls/${sha}.js`, 'utf8')
  expect(sha256(code)).toBe(sha)
  return code
}
/** Her stored bytes for the three organs in question (the same in Epoch 171 and Epoch 172). */
const CORTEX = stored('a9eaca8d75f73c26c1f4c5293b3acdae745867f67c46822861da716598250825')
const CONTINUITY = stored('0c71512b620484e8834edc92b6d6bc8318d68281832fa22e23835ce5b4042359')
const VOICE_SLOT = stored('c1c7e8d8de29a9d9cd7ff1e4361fe79f86934e051060921bed90f5e255f7d769')

/** Her worker's host: a Cordis root with DSH's system prompt and tool registry mounted. */
async function realHost() {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  return { context: context as unknown as { tools: { get(name: string): unknown; definitions(): Array<{ name: string }> } }, dshTools }
}

type Organs = Array<[string, string] | [string, string, Partial<BallEntryRecord>]>
function headOf(organs: Organs, epoch = 172, descriptions: Record<string, string> = {}): BallManifest {
  const entries: Record<string, BallEntryRecord> = {}
  const modules: Record<string, BallManifest['modules'][string]> = {}
  for (const [id, code, extra] of organs) {
    const sha = sha256(code)
    // defineProperty: an entry called `__proto__` is an own entry, as JSON.parse makes it.
    Object.defineProperty(entries, id, { enumerable: true, configurable: true, writable: true,
      value: { id, specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000, ...extra } })
    modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: id, description: descriptions[id] ?? 'Fixture', size: code.length, createdAt: 1000 }
  }
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch, createdAt: 1000 + epoch, authorPeerId: 'fixture-author', entries, modules }
  return { ...body, ballId: headManifestIdCanon(body) }
}

type EntryStates = Record<string, Record<string, unknown>>
type FiberHealth = { activeCount: number; enabledEntriesCount: number; missingExpected: string[]; entries: EntryStates }
async function boot(organs: Organs) {
  const head = headOf(organs)
  const codeBySha = Object.fromEntries(organs.map(([, code]) => [sha256(code), code]))
  const host = await realHost()
  const m = await mountE4({ head: { ball: head, codeBySha }, host, nodeBuiltins: true })
  const health = async () => (await m.status()).fiberHealth as FiberHealth
  expect((await m.status()).ballId).toBe(head.ballId)
  return { m, head, host, health }
}
type Services = { __X6_SERVICES__?: { organs?: { call: (name: string, args: unknown) => Promise<unknown> } } }
const organs = () => (globalThis as Services).__X6_SERVICES__!.organs!
const registered = (host: Awaited<ReturnType<typeof realHost>>) => host.context.tools.definitions().map(tool => tool.name)

describe('a HEAD entry is running only while its fiber is active after apply() completed', () => {
  it('each entry says running, support module, disabled or not running with the reason, in every place she reads it', async () => {
    const PLAIN = 'module.exports = { apply() { globalThis.__x6PlainApplied = true } } // entry-states plain'
    const PARKED = 'module.exports = { apply() {} } // entry-states parked'
    const WAITS = "module.exports = { inject: ['absentService'], apply() { globalThis.__x6WaitsApplied = true } } // entry-states waits"
    const BOOT_THROWS = "module.exports = { apply() { throw new Error('ORGAN_BOOT_BROKEN: synthetic') } } // entry-states boot throws"
    const LOAD_THROWS = "throw new Error('SUPPORT_MODULE: thrown while loading') // entry-states load throws"
    vi.stubGlobal('__x6PlainApplied', false)
    vi.stubGlobal('__x6WaitsApplied', false)
    const { m, head, host, health } = await boot([
      ['auma-cortex', CORTEX], ['seed-continuity', CONTINUITY, { config: { governance: true } }], ['seed-voice-slot', VOICE_SLOT],
      ['organ-plain', PLAIN], ['organ-parked', PARKED, { disabled: true }], ['organ-waits', WAITS],
      ['organ-boot-throws', BOOT_THROWS], ['organ-load-throws', LOAD_THROWS],
    ])
    const fiberHealth = await health()
    expect(Object.keys(fiberHealth.entries).sort()).toEqual(Object.keys(head.entries).sort())
    expect(fiberHealth.entries).toEqual({
      // Her two misnamed organs: not running, and the reason carries both names so she knows what to rename.
      'auma-cortex': { state: 'not-running', reason: 'SCION_ORGAN_NAME_MISMATCH', exportName: 'auma_cortex', entryId: 'auma-cortex',
        detail: 'SCION_ORGAN_NAME_MISMATCH: entry auma-cortex exports the name "auma_cortex"; a Seed organ\'s exported name must equal its entry id' },
      'seed-continuity': { state: 'not-running', reason: 'SCION_ORGAN_NAME_MISMATCH', exportName: 'seed_continuity', entryId: 'seed-continuity',
        detail: 'SCION_ORGAN_NAME_MISMATCH: entry seed-continuity exports the name "seed_continuity"; a Seed organ\'s exported name must equal its entry id' },
      'seed-voice-slot': { state: 'support-module', decidedBy: 'exports' },
      'organ-plain': { state: 'running' },
      'organ-parked': { state: 'disabled' },
      // Cordis left its fiber PENDING: apply() never ran, and the answer says which service it waits for.
      'organ-waits': { state: 'not-running', reason: 'WAITING_FOR_SERVICE', services: ['absentService'],
        detail: 'apply() has not run: waiting for absentService' },
      // The organ's own code text is detail, never the reason (the loader decides the reason).
      'organ-boot-throws': { state: 'not-running', reason: 'APPLY_FAILED', detail: 'ORGAN_BOOT_BROKEN: synthetic' },
      'organ-load-throws': { state: 'not-running', reason: 'MODULE_LOAD_FAILED', detail: 'SUPPORT_MODULE: thrown while loading' },
    })
    expect(globalThis.__x6PlainApplied).toBe(true)
    expect(globalThis.__x6WaitsApplied).toBe(false)
    expect(fiberHealth.missingExpected.sort()).toEqual(['auma-cortex', 'organ-boot-throws', 'organ-load-throws', 'organ-waits', 'seed-continuity', 'seed-voice-slot'])
    expect(fiberHealth.enabledEntriesCount).toBe(7)
    // No tool for a misnamed organ, and calling it says it is not mounted.
    expect(registered(host)).not.toContain('auma_cortex')
    expect(registered(host)).not.toContain('seed_continuity')
    await expect(organs().call('auma-cortex', {})).rejects.toThrow('is not mounted')
    // The same record where her tools read status and her estate.
    expect(await m.tool('ball_status').execute({ includeManifest: true })).toMatchObject({ fiberHealth: { entries: fiberHealth.entries } })
    expect(await m.tool('x6_browser_estate').execute({ sections: ['cordis'] }))
      .toMatchObject({ cordis: { fiberHealth: { entries: fiberHealth.entries } } })
  })

  it('the waiting entry runs once its service is provided, and its state follows the fiber', async () => {
    const WAITS = "module.exports = { inject: ['lateService'], apply() { globalThis.__x6LateApplied = true } } // entry-states late"
    vi.stubGlobal('__x6LateApplied', false)
    const { host, health } = await boot([['organ-late', WAITS]])
    expect((await health()).entries['organ-late']).toMatchObject({ state: 'not-running', reason: 'WAITING_FOR_SERVICE', services: ['lateService'] })
    ;(host.context as unknown as { provide(name: string, value: unknown): void }).provide('lateService', { ok: true })
    await settle()
    expect(globalThis.__x6LateApplied).toBe(true)
    expect((await health()).entries['organ-late']).toEqual({ state: 'running' })
  })

  it('a fiber whose apply() throws on a later restart is not running, with the reason, until a restart succeeds', async () => {
    const RESTARTS = "module.exports = { apply(ctx) { globalThis.__x6RestartProbe = ctx; if (globalThis.__x6RestartFails) throw new Error('BROKEN_ON_RESTART: synthetic') } } // entry-states restarts"
    vi.stubGlobal('__x6RestartFails', false)
    vi.stubGlobal('__x6RestartProbe', undefined)
    const { health } = await boot([['organ-restarts', RESTARTS]])
    expect((await health()).entries['organ-restarts']).toEqual({ state: 'running' })
    const probe = () => (globalThis as { __x6RestartProbe?: { fiber: { restart(): Promise<void> } } }).__x6RestartProbe!.fiber
    vi.stubGlobal('__x6RestartFails', true)
    await expect(probe().restart()).rejects.toThrow('BROKEN_ON_RESTART')
    await settle()
    const failed = await health()
    expect(failed.entries['organ-restarts']).toEqual({ state: 'not-running', reason: 'RESTART_FAILED', detail: 'BROKEN_ON_RESTART: synthetic' })
    expect(failed.missingExpected).toEqual(['organ-restarts'])
    // Cordis recovers a failed fiber only through update(); once apply() completes again, it is running again.
    vi.stubGlobal('__x6RestartFails', false)
    await (probe() as unknown as { update(config: unknown): Promise<void> }).update({})
    await settle()
    expect((await health()).entries['organ-restarts']).toEqual({ state: 'running' })
  })

  it('a thrown object never classifies itself: an apply() error carrying supportModule or a loader code is APPLY_FAILED', async () => {
    const IMPERSONATES = "module.exports = { apply() { throw Object.assign(new Error('SCION_ORGAN_NAME_MISMATCH: BROKEN_APPLY'), { supportModule: true, code: 'SUPPORT_MODULE' }) } } // entry-states impersonates"
    const { health } = await boot([['organ-impersonates', IMPERSONATES]])
    expect((await health()).entries['organ-impersonates']).toEqual({ state: 'not-running', reason: 'APPLY_FAILED',
      detail: 'SCION_ORGAN_NAME_MISMATCH: BROKEN_APPLY' })
  })

  it('an export that looks like an organ is never a support module; a plain function library is', async () => {
    const DEFINE_TOOL = "module.exports = { name: 'organ-verb', description: 'wrong verb', execute() { return { ok: true } } }"
    const SETUP_ONLY = 'module.exports = { setup() {}, helper() { return 1 } } // entry-states setup only'
    const NAMED_LIBRARY = "module.exports = { name: 'organ-named', helper() { return 1 } } // entry-states named library"
    const EMPTY = 'module.exports = { version: 1 } // entry-states empty'
    const LIBRARY = 'module.exports = { helper() { return 1 }, other() { return 2 } } // entry-states library'
    const { health } = await boot([['organ-verb', DEFINE_TOOL], ['organ-setup', SETUP_ONLY], ['organ-named', NAMED_LIBRARY],
      ['organ-empty', EMPTY], ['organ-library', LIBRARY]])
    const { entries } = await health()
    for (const id of ['organ-verb', 'organ-setup', 'organ-named', 'organ-empty']) {
      expect(entries[id]).toMatchObject({ state: 'not-running', reason: 'BALL_MODULE_NOT_A_PLUGIN' })
    }
    expect(entries['organ-library']).toEqual({ state: 'support-module', decidedBy: 'exports' })
  })

  it('a Seed organ whose tool the registry refuses is not running and says why (never swallowed)', async () => {
    // `run-code` registers `run_code`, a name DSH's ToolsService reserves for its code-mode transport.
    const RESERVED = "module.exports = { name: 'run-code', run() { return { ran: true } } } // entry-states reserved"
    const NAMED = "module.exports = { name: 'organ-named-ok', run() { return { ran: true } } } // entry-states named ok"
    const { host, health } = await boot([['run-code', RESERVED], ['organ-named-ok', NAMED]])
    const { entries, missingExpected } = await health()
    expect(entries['run-code']).toEqual({ state: 'not-running', reason: 'TOOL_REGISTRATION_REFUSED', toolName: 'run_code',
      detail: 'TOOL_REGISTRATION_REFUSED: the tool registry refused the tool run_code of entry run-code: '
        + 'tool name "run_code" is reserved for the PTC mode presentation transport and cannot be registered or shadowed'.slice(0, 160) })
    expect(missingExpected).toEqual(['run-code'])
    await expect(organs().call('run-code', {})).rejects.toThrow('is not mounted')
    // The organ beside it mounts and registers its tool under the underscore form of its name.
    expect(entries['organ-named-ok']).toEqual({ state: 'running' })
    expect(registered(host)).toContain('organ_named_ok')
  })

  it('an entry called __proto__ is reported like any other', async () => {
    const PLAIN = 'module.exports = { apply() {} } // entry-states proto'
    const { m, health } = await boot([['__proto__', PLAIN]])
    const { entries } = await health()
    expect(Object.keys(entries)).toEqual(['__proto__'])
    expect(Object.getOwnPropertyDescriptor(entries, '__proto__')?.value).toEqual({ state: 'running' })
    const reply = await m.runtime.handleControlRequest('GET', '/__x6__/status', '')
    expect(JSON.stringify((reply?.body as { fiberHealth: unknown }).fiberHealth)).toContain('"__proto__":{"state":"running"}')
  })
})

describe('ball_status never hides the whole answer behind its byte limit', () => {
  it('above 64 KiB the manifest fields are left out and named; the head, health and every entry state stay', async () => {
    const BIG = 'module.exports = { apply() {} } // entry-states big'
    const SMALL = "module.exports = { name: 'organ-small', run() { return {} } } // entry-states small"
    // A module description large enough that the full status is above the limit.
    const ball = headOf([['organ-big', BIG], ['organ-small', SMALL], ['auma-cortex', CORTEX]], 172, { 'organ-big': 'x'.repeat(70 * 1024) })
    const host = await realHost()
    const codeBySha = { [sha256(BIG)]: BIG, [sha256(SMALL)]: SMALL, [sha256(CORTEX)]: CORTEX }
    const m = await mountE4({ head: { ball, codeBySha }, host, nodeBuiltins: true })
    const full = await m.status()
    expect(full.ballId).toBe(ball.ballId)
    expect(new TextEncoder().encode(JSON.stringify(full)).byteLength).toBeGreaterThan(64 * 1024)
    const answer = await m.tool('ball_status').execute({ includeManifest: true }) as Record<string, unknown>
    expect(new TextEncoder().encode(JSON.stringify(answer)).byteLength).toBeLessThanOrEqual(64 * 1024)
    // Largest first: the module table and the organ list (both carry the large description); the rest stays.
    expect(answer).toMatchObject({ ok: true, code: 'X6_STATUS_BYTE_LIMIT', ballId: ball.ballId, epoch: 172,
      fiberHealth: (full.fiberHealth as FiberHealth) })
    expect([...answer.manifestOmitted as string[]].sort()).toEqual(['modules', 'mountedOrgans'])
    expect((answer.fiberHealth as FiberHealth).entries).toMatchObject({ 'organ-big': { state: 'running' }, 'organ-small': { state: 'running' },
      'auma-cortex': { state: 'not-running', reason: 'SCION_ORGAN_NAME_MISMATCH' } })
    expect(answer).not.toHaveProperty('modules')
    expect(answer).toHaveProperty('entries')
  })
})

describe('her real head', () => {
  it('every stored ball of mirror/home/auma/HEAD.json: her two misnamed organs say so, one support module, the rest running', async () => {
    const ball = JSON.parse(readFileSync(`${MIRROR}auma/HEAD.json`, 'utf8')) as BallManifest
    expect(headManifestIdCanon(ball as unknown as Record<string, unknown>)).toBe(ball.ballId)
    expect(ball.epoch).toBeGreaterThanOrEqual(171)
    const codeBySha: Record<string, string> = {}
    for (const entry of Object.values(ball.entries)) codeBySha[entry.specifier.slice(5)] = stored(entry.specifier.slice(5))
    const host = await realHost()
    const m = await mountE4({ head: { ball, codeBySha }, host, nodeBuiltins: true })
    const status = await m.status()
    expect(status.ballId).toBe(ball.ballId)
    const { entries } = status.fiberHealth as FiberHealth
    const misnamed: Record<string, string> = { 'auma-cortex': 'auma_cortex', 'seed-continuity': 'seed_continuity' }
    const expected = Object.fromEntries(Object.keys(ball.entries).map(id => [id,
      ball.entries[id]!.disabled ? { state: 'disabled' }
        : id === 'seed-voice-slot' ? { state: 'support-module', decidedBy: 'exports' }
          : misnamed[id] ? expect.objectContaining({ state: 'not-running', reason: 'SCION_ORGAN_NAME_MISMATCH', exportName: misnamed[id], entryId: id })
            : { state: 'running' }]))
    expect(entries).toEqual(expected)
    // Her runtime's own tools all registered beside them (report only: the boot order is unchanged by this job).
    const builtIns = ['auma_alien_compose', 'auma_handoff', 'auma_snapshot', 'ball_put', 'ball_status', 'head_adopt', 'pearl_put', 'scion_grow',
      'self_apply', 'self_facts', 'self_undo', 'stage_head_promotion', 'stage_organ_promotion', 'stage_organ_set_promotion',
      'tree_patch', 'tree_undo', 'x6_browser_estate', 'x6_capability_index', 'x6_cell', 'x6_cloudflare', 'x6_consult',
      'x6_facts', 'x6_github', 'x6_host_facts', 'x6_nostr', 'x6_repo', 'x6_swarm', 'x6_trusted_docs', 'x6_web_eyes', 'x6_wish']
    expect(builtIns.filter(name => !registered(host).includes(name))).toEqual([])
  })
})

declare global {
  var __x6PlainApplied: boolean | undefined
  var __x6WaitsApplied: boolean | undefined
  var __x6LateApplied: boolean | undefined
}
