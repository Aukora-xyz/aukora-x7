/**
 * Lane E4 task 1: `stage_organ_promotion` builds the one-organ candidate HEAD accepts (verbatim clone, normalized entry,
 * hash-verified module, parent/epoch+1, canonical manifestIdCanon id, zero riders), writes the review file, flushes and
 * POSTs /_head/stage with same-origin credentials, and types every failure. Local fixture only; nothing live.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildOrganPromotion, manifestStructureProblem, STAGED_HEAD_PROMOTION_PATH } from '../../src/x6/ball-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { FakeSocket, headManifestIdCanon, liveHead, mountE4, ORGAN_A, ORGAN_A2, PEARL_V2, putBall, sha256, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

const deps = (codes: Record<string, string> = {}) => ({ authorPeerId: 'tab-e4', now: 5000, readCode: (sha: string) => codes[sha] ?? null })

describe('buildOrganPromotion: the candidate HEAD would accept', () => {
  it('clones the live head verbatim, changes only entries[id], and ids it with HEAD\'s manifestIdCanon', () => {
    const live = liveHead()
    const sha2 = sha256(ORGAN_A2)
    const plan = buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 }))
    expect(plan.ball.parentBallId).toBe(live.ball.ballId)
    expect(plan.ball.epoch).toBe(live.ball.epoch + 1)
    expect(plan.ball.authorPeerId).toBe('tab-e4')
    expect(plan.ball.ballId).toBe(headManifestIdCanon(plan.ball as unknown as Record<string, unknown>))
    expect(manifestStructureProblem(plan.ball)).toBeNull()
    expect(plan.changedEntryIds).toEqual(['organ-a'])
    expect(plan.ball.entries['seed-pearl']).toEqual(live.ball.entries['seed-pearl'])
    for (const [sha, meta] of Object.entries(live.ball.modules)) expect(plan.ball.modules[sha]).toEqual(meta)
    expect(plan.entry).toMatchObject({ id: 'organ-a', specifier: `ball:${sha2}`, disabled: false, config: {},
      previousSpecifiers: [live.ball.entries['organ-a']!.specifier] })
    expect(plan.ball.modules[sha2]).toMatchObject({ sha256: sha2, specifier: `ball:${sha2}`, name: 'organ-a', size: ORGAN_A2.length, createdAt: 5000 })
    expect(plan.envelope).toMatchObject({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 5000,
      body: { codeBySha: { [sha2]: ORGAN_A2 }, expectedParentBallId: live.ball.ballId, expectedEpoch: 7 } })
    expect(Object.keys(plan.envelope.body.codeBySha)).toEqual([sha2])
    expect(plan.tier).toBe('T1')
    expect(plan.governanceClass).toBe(1)
  })

  it('normalizes a malformed target entry: id, boolean disabled, object config, resolvable previousSpecifiers', () => {
    const live = liveHead()
    const shaA = sha256(ORGAN_A), sha2 = sha256(ORGAN_A2)
    // A historically malformed entry (no id, string disabled, null config, dangling previous specifier).
    const broken = { specifier: `ball:${shaA}`, disabled: 'no', config: null, previousSpecifiers: ['ball:' + '9'.repeat(64), `ball:${shaA}`, 7], updatedAt: 1 }
    const body = { ...live.ball, entries: { ...live.ball.entries, 'organ-a': broken } } as Record<string, unknown>
    delete body.ballId
    const malformed = { ball: { ...body, ballId: headManifestIdCanon(body) }, codeBySha: live.codeBySha }
    expect(manifestStructureProblem(malformed.ball)).toEqual({ code: 'INVALID_ENTRY', at: 'organ-a' })
    const plan = buildOrganPromotion(malformed, { id: 'organ-a', specifier: sha2 }, deps({ [sha2]: ORGAN_A2 }))
    expect(plan.entry.id).toBe('organ-a')
    expect(plan.entry.disabled).toBe(false)
    expect(plan.entry.config).toEqual({})
    expect(plan.entry.previousSpecifiers).toEqual([`ball:${shaA}`])
    for (const specifier of plan.entry.previousSpecifiers) expect(plan.ball.modules[specifier.slice(5)]).toBeDefined()
    expect(plan.normalized).toEqual(expect.arrayContaining(['specifier:ball-prefix', 'config:default-empty-object', 'disabled:default-false',
      'previousSpecifiers:dropped-unresolvable:1']))
    expect(manifestStructureProblem(plan.ball)).toBeNull()
    expect(plan.ball.ballId).toBe(headManifestIdCanon(plan.ball as unknown as Record<string, unknown>))
  })

  it('honours explicit config and disabled, and a brand-new organ defaults to {} / false with an empty history', () => {
    const live = liveHead()
    const sha2 = sha256(ORGAN_A2)
    const fresh = buildOrganPromotion(live, { id: 'organ-new', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 }))
    expect(fresh.entry).toMatchObject({ id: 'organ-new', config: {}, disabled: false, previousSpecifiers: [] })
    expect(fresh.changedEntryIds).toEqual(['organ-new'])
    const tuned = buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}`, config: { depth: 2 }, disabled: true }, deps({ [sha2]: ORGAN_A2 }))
    expect(tuned.entry).toMatchObject({ config: { depth: 2 }, disabled: true })
  })

  it('classifies a governance organ as Class 3 / T2 and still stages exactly one entry', () => {
    const live = liveHead()
    const sha = sha256(PEARL_V2)
    const plan = buildOrganPromotion(live, { id: 'seed-pearl', specifier: `ball:${sha}` }, deps({ [sha]: PEARL_V2 }))
    expect(plan.governanceClass).toBe(3)
    expect(plan.tier).toBe('T2')
    expect(plan.changedEntryIds).toEqual(['seed-pearl'])
  })

  it('types every refusal and never falls back', () => {
    const live = liveHead()
    const sha2 = sha256(ORGAN_A2), shaA = sha256(ORGAN_A)
    const code = (fn: () => unknown): string => { try { fn(); return 'NO_THROW' } catch (error) { return (error as Error).message.split(':')[0]! } }
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}` }, deps()))).toBe('ORGAN_PROMOTION_CODE_MISSING')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 + ' tampered' })))).toBe('BALL_CODE_HASH_MISMATCH')
    expect(code(() => buildOrganPromotion(live, { id: 'Organ_A', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 })))).toBe('ORGAN_PROMOTION_ID_INVALID')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: 'npm:left-pad' }, deps()))).toBe('ORGAN_PROMOTION_SPECIFIER_INVALID')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}`, disabled: 'yes' }, deps({ [sha2]: ORGAN_A2 })))).toBe('ORGAN_PROMOTION_DISABLED_INVALID')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}`, config: [1] }, deps({ [sha2]: ORGAN_A2 })))).toBe('ORGAN_PROMOTION_CONFIG_INVALID')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${sha2}`, config: { ownerSecret: 'x' } }, deps({ [sha2]: ORGAN_A2 })))).toBe('ORGAN_PROMOTION_PRIVATE_METADATA_REFUSED')
    expect(code(() => buildOrganPromotion(live, { id: 'organ-a', specifier: `ball:${shaA}` }, deps()))).toBe('ORGAN_PROMOTION_NO_CHANGE')
    const forged = { ball: { ...live.ball, epoch: 99 }, codeBySha: live.codeBySha }
    expect(code(() => buildOrganPromotion(forged, { id: 'organ-a', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 })))).toBe('LIVE_HEAD_MANIFEST_HASH_MISMATCH')
    const badBytes = { ball: live.ball, codeBySha: { [shaA]: ORGAN_A + 'x' } }
    expect(code(() => buildOrganPromotion(badBytes, { id: 'organ-a', specifier: `ball:${sha2}` }, deps({ [sha2]: ORGAN_A2 })))).toBe('BALL_CODE_HASH_MISMATCH')
  })

  it('manifestStructureProblem mirrors HEAD validateManifestStructure codes', () => {
    const live = liveHead()
    expect(manifestStructureProblem(live.ball)).toBeNull()
    expect(manifestStructureProblem({ ...live.ball, version: 'x' })?.code).toBe('INVALID_MANIFEST')
    type Loose = { entries: Record<string, Record<string, unknown>>; modules: Record<string, Record<string, unknown>> }
    const missing = JSON.parse(JSON.stringify(live.ball)) as Loose
    missing.entries['organ-a']!.previousSpecifiers = ['ball:' + 'e'.repeat(64)]
    expect(manifestStructureProblem(missing)).toEqual({ code: 'MODULE_MISSING', at: 'organ-a' })
    const badModule = JSON.parse(JSON.stringify(live.ball)) as Loose
    const first = Object.keys(badModule.modules)[0]!
    badModule.modules[first]!.specifier = 'ball:' + '0'.repeat(64)
    expect(manifestStructureProblem(badModule)).toEqual({ code: 'INVALID_MODULE', at: first })
  })
})

describe('stage_organ_promotion tool: one call, every hop', () => {
  const stageOk = (call: Call) => call.path === '/_head/stage' && call.method === 'POST'
    ? Response.json({ ok: true, staged: { state: 'awaiting_owner', stagedForOwner: true, ballId: (call.body as { body: { ball: { ballId: string } } }).body.ball.ballId,
      epoch: 8, tier: 'T2', governanceClass: 3, binding: { organId: 'seed-pearl' } } })
    : null

  it('fetches the live head, writes the review file, POSTs /_head/stage same-origin with the exact bytes, and returns typed hops', async () => {
    const vfs = new MemoryVfs()
    const sha = putBall(vfs, PEARL_V2)
    const { tool, calls } = await mountE4({ vfs, respond: stageOk })
    calls.length = 0
    const result = await tool('stage_organ_promotion').execute({ id: 'seed-pearl', specifier: `ball:${sha}` }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: true, edgeStaged: true, entryId: 'seed-pearl', governanceClass: 3, tier: 'T2', epoch: 8,
      changedEntries: ['seed-pearl'], binding: { organId: 'seed-pearl' }, transitionKind: 'head.stage' })
    expect(String(result.operationId)).toMatch(/^op-/)
    expect((result.hops as Array<{ hop: string; ok: boolean }>).map(hop => hop.hop)).toEqual(['live-head', 'built', 'local-staged', 'idb-flushed', 'edge-staged'])
    expect(calls.map(call => `${call.method} ${call.path}`).filter(line => !line.includes('promotion-status') && !line.includes('facts')))
      .toEqual(['GET /_head/ball', 'POST /_head/stage'])
    const post = calls.find(call => call.path === '/_head/stage')!
    expect(post.credentials).toBe('same-origin')
    expect(post.headers.get('x-x6-operation-id')).toBe(result.operationId)
    expect(post.headers.has('authorization')).toBe(false)
    const written = vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    expect(post.body).toEqual(JSON.parse(written))
    expect(result.stagedSha256).toBe(sha256(written))
    type Envelope = { schema: string; body: { ball: Record<string, unknown>; codeBySha: Record<string, string>; expectedEpoch: number } }
    const envelope = JSON.parse(written) as Envelope
    expect(envelope.schema).toBe('aukora.staged-head-promotion.v1')
    expect(envelope.body.ball.ballId).toBe(headManifestIdCanon(envelope.body.ball))
    expect(envelope.body.codeBySha).toEqual({ [sha]: PEARL_V2 })
    expect(envelope.body.expectedEpoch).toBe(7)
  })

  it('a 409 from HEAD is a typed failure with the file retained, not a silent success', async () => {
    const vfs = new MemoryVfs()
    const sha = putBall(vfs, ORGAN_A2)
    const { tool } = await mountE4({ vfs, respond: call => call.path === '/_head/stage'
      ? Response.json({ ok: false, code: 'CANDIDATE_ALREADY_STAGED', stagedBallId: 'a'.repeat(64) }, { status: 409 }) : null })
    const result = await tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}` }) as Record<string, unknown>
    expect(result).toMatchObject({ ok: false, code: 'CANDIDATE_ALREADY_STAGED', failedHop: 'edge-staged', edgeStaged: false, stageStatus: 409 })
    expect(vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(true)
  })

  it('network failure on /_head/stage and on /_head/ball are typed', async () => {
    const vfs = new MemoryVfs()
    const sha = putBall(vfs, ORGAN_A2)
    const { tool } = await mountE4({ vfs, respond: (call) => { if (call.path === '/_head/stage') throw new TypeError('Failed to fetch'); return null } })
    expect(await tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}` }))
      .toMatchObject({ ok: false, code: 'HEAD_STAGE_UNREACHABLE', failedHop: 'edge-staged' })
    vi.unstubAllGlobals()
    FakeSocket.instances.length = 0
    let fail = false
    const second = await mountE4({ vfs: new MemoryVfs(), respond: call => (fail && call.path === '/_head/ball') ? Response.json({ ok: false }, { status: 503 }) : null })
    fail = true
    expect(await second.tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}` }))
      .toMatchObject({ ok: false, code: 'HEAD_FETCH_HTTP_503', failedHop: 'live-head' })
  })

  it('refuses riders, bad bytes and a different review file without its exact sha', async () => {
    const vfs = new MemoryVfs()
    const sha = putBall(vfs, ORGAN_A2)
    vfs.writeFileSync(`/dsh/home/balls/${'d'.repeat(64)}.js`, 'not the bytes')
    const { tool, head } = await mountE4({ vfs, respond: stageOk })
    expect(await tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${'d'.repeat(64)}` }))
      .toMatchObject({ ok: false, code: 'BALL_CODE_HASH_MISMATCH', failedHop: 'built', edgeStaged: false })
    // A different, still-valid candidate is under review: never clobbered silently.
    const other = buildOrganPromotion(head, { id: 'organ-new', specifier: `ball:${sha}` }, { authorPeerId: 'x', now: 1, readCode: () => ORGAN_A2 })
    vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, other.text)
    const refused = await tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}` }) as Record<string, unknown>
    expect(refused).toMatchObject({ ok: false, code: 'STAGED_PROMOTION_REVIEW_CONFLICT', existingStagedSha256: sha256(other.text) })
    const replaced = await tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}`, expectedStagedSha256: sha256(other.text) })
    expect(replaced).toMatchObject({ ok: true, edgeStaged: true })
    await expect(tool('stage_organ_promotion').execute({ id: 'organ-a', specifier: `ball:${sha}`, approvalToken: 'x' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
  })
})
