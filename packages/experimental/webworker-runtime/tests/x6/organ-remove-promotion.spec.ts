/**
 * `stage_organ_remove_promotion` stages the removal of ONE ordinary organ for one Touch ID on the card.
 * The worker's copy of HEAD's rule (`organRemovalOf`) passes the shared vectors; the candidate keeps every other entry and
 * every module byte for byte; a governance organ, an unknown id and a head this tab cannot prove are refused with closed
 * codes; nothing is ever published by her. After the owner's approval lands, an open tab does not hot-swap (head_adopt says
 * one reload is needed), and a fresh boot on the new head has neither the organ nor its tool. Local fixture only.
 */
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import SystemPrompt from '../../../../core/system-prompt/src/index.ts'
import ToolRuntime, * as dshTools from '../../../../core/tools/src/index.ts'
import {
  buildOrganRemovePromotion, manifestStructureProblem, organRemovalOf, STAGED_HEAD_PROMOTION_PATH,
  type BallEntryRecord, type BallManifest,
} from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, headManifestIdCanon, liveHead, mountE4, ORGAN_A, sha256, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const vectorsPath = ['', '../../../../'].map(prefix => resolve(process.cwd(), `${prefix}server/organ-remove-rule.vectors.json`))
  .find(existsSync)
const vectors = JSON.parse(readFileSync(vectorsPath ?? 'server/organ-remove-rule.vectors.json', 'utf8')) as {
  schema: string
  previous: BallManifest
  cases: Array<{ name: string; candidate: unknown; expect: { organId: string; sha256: string } | null }>
}

describe('the worker rule passes the shared organ-removal vectors exactly', () => {
  it('reads the shared vectors file', () => {
    expect(vectors.schema).toBe('aukora.organ-remove-rule.vectors.v1')
    expect(vectors.cases.length).toBeGreaterThanOrEqual(15)
  })
  for (const item of vectors.cases) {
    it(item.name, () => { expect(organRemovalOf(vectors.previous, item.candidate)).toEqual(item.expect) })
  }
})

const deps = { authorPeerId: 'tab-promo1', now: 9000 }
/** The fixture head plus a declared-governance ordinary-looking organ. */
function headWithDeclared() {
  const live = liveHead()
  const code = 'module.exports = { apply() {} }; // promo1 quiet judge', sha = sha256(code)
  type Editable = Record<string, unknown> & { entries: Record<string, unknown>; modules: Record<string, unknown> }
  const body = JSON.parse(JSON.stringify(live.ball)) as Editable
  delete body.ballId
  body.entries['quiet-judge'] = { id: 'quiet-judge', specifier: `ball:${sha}`, config: {}, disabled: false, governance: true, previousSpecifiers: [], updatedAt: 1000 }
  body.modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: 'quiet-judge', description: 'x', size: code.length, createdAt: 1000 }
  return { ball: { ...body, ballId: headManifestIdCanon(body) } as unknown as BallManifest, codeBySha: { ...live.codeBySha, [sha]: code } }
}

describe('buildOrganRemovePromotion: the plain removal HEAD records', () => {
  it('deletes only entries[id]; every other entry, every module and every root field kept; ids it canonically; ships no bytes', () => {
    const live = liveHead()
    const plan = buildOrganRemovePromotion(live, { id: 'organ-a' }, deps)
    expect(plan.ball.parentBallId).toBe(live.ball.ballId)
    expect(plan.ball.epoch).toBe(live.ball.epoch + 1)
    expect(plan.ball.ballId).toBe(headManifestIdCanon(plan.ball as unknown as Record<string, unknown>))
    expect(manifestStructureProblem(plan.ball)).toBeNull()
    expect(Object.keys(plan.ball.entries)).toEqual(['seed-pearl'])
    expect(plan.ball.entries['seed-pearl']).toEqual(live.ball.entries['seed-pearl'])
    expect(plan.ball.modules).toEqual(live.ball.modules)
    expect(plan.organ).toEqual({ organId: 'organ-a', sha256: sha256(ORGAN_A) })
    expect(organRemovalOf(live.ball, plan.ball)).toEqual(plan.organ)
    const envelope = JSON.parse(plan.text) as { body: { codeBySha: object; expectedParentBallId: string; expectedEpoch: number } }
    expect(envelope.body).toMatchObject({ codeBySha: {}, expectedParentBallId: live.ball.ballId, expectedEpoch: live.ball.epoch })
  })

  it.each([
    ['a fixed governance organ', liveHead, { id: 'seed-pearl' }, 'ORGAN_REMOVE_GOVERNANCE_REFUSED'],
    ['a declared governance organ', headWithDeclared, { id: 'quiet-judge' }, 'ORGAN_REMOVE_GOVERNANCE_REFUSED'],
    ['an id not in the head', liveHead, { id: 'organ-zz' }, 'ORGAN_REMOVE_UNKNOWN_ORGAN'],
    ['an id that is not lower kebab', liveHead, { id: 'Organ-A' }, 'ORGAN_REMOVE_INPUT_INVALID'],
    ['no id', liveHead, {}, 'ORGAN_REMOVE_INPUT_INVALID'],
    ['an extra key', liveHead, { id: 'organ-a', governance: false }, 'ORGAN_REMOVE_INPUT_INVALID'],
  ])('refuses %s', (_label, head, input, code) => {
    expect(() => buildOrganRemovePromotion(head(), input, deps)).toThrow(new RegExp(`^${code}`))
  })

  it('refuses a head it cannot prove current (its id is not the hash of its content)', () => {
    const live = liveHead()
    const tampered = { ball: { ...live.ball, entries: { ...live.ball.entries, 'organ-b': { ...live.ball.entries['organ-a'], id: 'organ-b' } as BallEntryRecord } } }
    expect(() => buildOrganRemovePromotion(tampered, { id: 'organ-a' }, deps)).toThrow(/^LIVE_HEAD_MANIFEST_HASH_MISMATCH/)
    expect(() => buildOrganRemovePromotion({ ball: null }, { id: 'organ-a' }, deps)).toThrow(/^LIVE_HEAD_INVALID/)
  })
})

describe('stage_organ_remove_promotion tool', () => {
  const stageAnswer = (organRemove: unknown) => (call: Call) => call.path === '/_head/stage' && call.method === 'POST'
    ? Response.json({ ok: true, staged: { state: 'awaiting_owner', stagedForOwner: true, ballId: (call.body as { body: { ball: { ballId: string } } }).body.ball.ballId,
      epoch: 8, tier: 'T2', governanceClass: 1, binding: null, organSet: null, ...(organRemove === undefined ? {} : { organRemove }) } })
    : null

  it('reads the live head, writes the review file, POSTs /_head/stage only, and returns HEAD\'s removal body', async () => {
    const vfs = new MemoryVfs()
    const organRemove = { schema: 'aukora.head-organ-remove.v1', organ: { organId: 'organ-a', sha256: sha256(ORGAN_A) } }
    const { tool, calls } = await mountE4({ vfs, respond: stageAnswer(organRemove) })
    calls.length = 0
    const result = await tool('stage_organ_remove_promotion').execute({ id: 'organ-a' }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, staged: true, edgeStaged: true, organ: { organId: 'organ-a', sha256: sha256(ORGAN_A) }, organRemove })
    expect((result.hops as Array<{ hop: string }>).map(hop => hop.hop)).toEqual(['live-head', 'built', 'local-staged', 'idb-flushed', 'edge-staged'])
    const lines = calls.map(call => `${call.method} ${call.path}`).filter(line => !line.includes('promotion-status') && !line.includes('facts'))
    expect(lines).toEqual(['GET /_head/ball', 'GET /cells/reflexes/touch-id-tier.json', 'POST /_head/stage'])
    // She never publishes or approves: no promote, no direct publish, no lease.
    expect(calls.some(call => ['/_head/promote', '/_head/lease'].includes(call.path) || (call.path === '/_head/ball' && call.method === 'POST'))).toBe(false)
    const written = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    expect(calls.find(call => call.path === '/_head/stage')!.body).toEqual(JSON.parse(written))
  })

  it('HEAD staging it without recording a removal is ORGAN_REMOVE_NOT_RECORDED', async () => {
    const { tool } = await mountE4({ vfs: new MemoryVfs(), respond: stageAnswer(undefined) })
    expect(await tool('stage_organ_remove_promotion').execute({ id: 'organ-a' }))
      .toMatchObject({ ok: false, staged: false, code: 'ORGAN_REMOVE_NOT_RECORDED', edgeStaged: true, organRemove: null })
  })

  it('a refused build (governance, unknown id) never touches the review file or HEAD', async () => {
    const vfs = new MemoryVfs()
    const { tool, calls } = await mountE4({ vfs, respond: stageAnswer(undefined) })
    calls.length = 0
    // A fixed governance id is stopped earlier still, by her runtime's own invocation gate (Class 3 needs the owner).
    await expect(tool('stage_organ_remove_promotion').execute({ id: 'seed-pearl' })).rejects.toThrow(/^CLASS3_OWNER_SIGNATURE_REQUIRED/)
    expect(await tool('stage_organ_remove_promotion').execute({ id: 'organ-zz' })).toMatchObject({ ok: false, code: 'ORGAN_REMOVE_UNKNOWN_ORGAN', failedHop: 'built' })
    expect(vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(false)
    expect(calls.some(call => call.path === '/_head/stage')).toBe(false)
  })
})

// ---- after the owner's approval: no hot swap in an open tab; a fresh boot has neither the organ nor its tool ----
async function realHost() {
  const context = new Context()
  await context.plugin(SystemPrompt, {})
  await context.plugin(ToolRuntime)
  return { context: context as unknown as { tools: { get(name: string): unknown; definitions(): Array<{ name: string }> } }, dshTools }
}
const registered = (host: Awaited<ReturnType<typeof realHost>>) => host.context.tools.definitions().map(tool => tool.name)
const KEEP = "module.exports = { name: 'organ-keep', run() { return { ran: 'keep' } } } // promo1 remove keep"
const GONE = "module.exports = { name: 'organ-gone', run() { return { ran: 'gone' } } } // promo1 remove gone"
function bootHead(): { ball: BallManifest; codeBySha: Record<string, string> } {
  const entries: Record<string, BallEntryRecord> = {}, modules: Record<string, BallManifest['modules'][string]> = {}
  for (const [id, code] of [['organ-keep', KEEP], ['organ-gone', GONE]] as const) {
    const sha = sha256(code)
    entries[id] = { id, specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
    modules[sha] = { sha256: sha, specifier: `ball:${sha}`, name: id, description: 'Fixture', size: code.length, createdAt: 1000 }
  }
  const body = { version: 'x6.1-ball/v1' as const, parentBallId: 'f'.repeat(64), epoch: 172, createdAt: 1072, authorPeerId: 'fixture-author', entries, modules }
  return { ball: { ...body, ballId: headManifestIdCanon(body) }, codeBySha: { [sha256(KEEP)]: KEEP, [sha256(GONE)]: GONE } }
}

describe('a removal approved on the card, seen from her tabs', () => {
  it('an open tab keeps running what it booted and head_adopt says one reload is needed; a fresh boot on the new head has neither the organ nor its tool', async () => {
    const before = bootHead()
    const plan = buildOrganRemovePromotion(before, { id: 'organ-gone' }, deps)
    // What HEAD serves once the owner's approval landed: the new head, every module still carried.
    const after = { ball: plan.ball, codeBySha: before.codeBySha }
    let published = before
    const openHost = await realHost()
    const open = await mountE4({ head: before, host: openHost, nodeBuiltins: true,
      respond: call => call.method === 'GET' && call.path === '/_head/ball' ? Response.json({ ok: true, ball: published.ball, codeBySha: published.codeBySha }) : null })
    expect(registered(openHost)).toEqual(expect.arrayContaining(['organ_keep', 'organ_gone']))
    published = after
    const adopt = await open.tool('head_adopt').execute({}) as Record<string, unknown>
    expect(adopt).toMatchObject({ ok: true, adopted: false, alreadyCurrent: false,
      running: { ballId: before.ball.ballId, epoch: 172 }, published: { ballId: plan.ball.ballId, epoch: 173 } })
    expect(String(adopt.say)).toContain('One reload brings her.')
    expect((await open.status()).ballId).toBe(before.ball.ballId)
    FakeSocket.instances.length = 0
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    // The reload: a fresh boot selects the published head.
    const freshHost = await realHost()
    const fresh = await mountE4({ head: after, host: freshHost, nodeBuiltins: true })
    expect((await fresh.status()).ballId).toBe(plan.ball.ballId)
    const health = (await fresh.status()).fiberHealth as { entries: Record<string, unknown> }
    expect(Object.keys(health.entries)).toEqual(['organ-keep'])
    expect(registered(freshHost)).toContain('organ_keep')
    expect(registered(freshHost)).not.toContain('organ_gone')
    // Her own staging, promotion and rollback tools are built-ins of her runtime, not organs: still there without it.
    for (const name of ['stage_organ_remove_promotion', 'stage_organ_set_promotion', 'stage_organ_promotion', 'x6_repo', 'head_adopt']) {
      expect(registered(freshHost)).toContain(name)
    }
  })
})
