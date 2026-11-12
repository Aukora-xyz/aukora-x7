/** Synthetic promotion review tests. No browser, selected-head writes, secrets or network. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, classifyEntryGovernance, mountX6BallRuntime, serializeStagedHeadPromotion,
  STAGED_HEAD_PROMOTION_PATH, STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA, type BallEntryRecord, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const hash = (value: string): string => createHash('sha256').update(value).digest('hex')
const manifestId = (ball: BallManifest): string => hash(JSON.stringify({
  version: ball.version, parentBallId: ball.parentBallId, epoch: ball.epoch,
  entries: Object.keys(ball.entries).sort().map(id => ball.entries[id]),
  modules: Object.keys(ball.modules).sort().map(sha => ball.modules[sha]) }))
const identified = (ball: BallManifest): BallManifest => ({ ...ball, ballId: manifestId(ball) })

async function serverCanonicalId(ball: BallManifest): Promise<string> {
  const source: unknown = await import(new URL('../../../../../deploy/cloudflare/src/head-do.mjs', import.meta.url).href)
  if (!source || typeof source !== 'object' || !('manifestIdCanon' in source) || typeof source.manifestIdCanon !== 'function') {
    throw new Error('Server canonical manifest helper is unavailable')
  }
  const id: unknown = await Reflect.apply(source.manifestIdCanon, undefined, [ball])
  if (typeof id !== 'string') throw new Error('Server canonical manifest helper did not return an ID')
  return id
}

function fixture(id = 'seed-pearl', config: Record<string, unknown> = {}) {
  const original = 'module.exports = { apply() {} }; // version 1', candidate = 'module.exports = { apply() {} }; // version 2'
  const originalSha = hash(original), candidateSha = hash(candidate)
  const meta = (sha: string, source: string) => ({ sha256: sha, specifier: `ball:${sha}`, name: id, description: 'Synthetic module', size: Buffer.byteLength(source), createdAt: 1000 })
  const entry: BallEntryRecord = { id, specifier: `ball:${originalSha}`, config, disabled: false, previousSpecifiers: [], updatedAt: 1000 }
  const previous = identified({ version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 162, createdAt: 1000, authorPeerId: 'prior-author',
    entries: { [id]: entry }, modules: { [originalSha]: meta(originalSha, original) } })
  const ball = identified({ ...previous, parentBallId: previous.ballId, epoch: 163, authorPeerId: 'review-author', createdAt: 2000,
    entries: { [id]: { ...entry, specifier: `ball:${candidateSha}`, previousSpecifiers: [entry.specifier], updatedAt: 2000 } },
    modules: { ...previous.modules, [candidateSha]: meta(candidateSha, candidate) } })
  const input = { ball, codeBySha: { [originalSha]: original, [candidateSha]: candidate },
    expectedParentBallId: previous.ballId, expectedEpoch: previous.epoch }
  return { previous, input, originalSha, candidateSha }
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mountedFixture(id = 'seed-pearl', config: Record<string, unknown> = {}, encoding: 'legacy' | 'canonical' = 'legacy', trackEffects = false) {
  const data = fixture(id, config), vfs = new MemoryVfs()
  if (encoding === 'canonical') {
    const previous = { ...data.previous,
      extraMetadata: { labels: ['synthetic', null, true, 1.5], nested: { z: 2, a: 1 } },
      entries: { ...data.previous.entries, 'seed-sibling': { ...data.previous.entries[id]!, id: 'seed-sibling', config: { retained: true } } } }
    data.previous = { ...previous, ballId: await serverCanonicalId(previous) }
    data.input = { ...data.input, expectedParentBallId: data.previous.ballId,
      ball: identified({ ...data.input.ball, parentBallId: data.previous.ballId,
        entries: { ...data.input.ball.entries, 'seed-sibling': previous.entries['seed-sibling'] } }) }
  }
  const provided = new Map<string, unknown>(), requests: Request[] = []
  let activations = 0
  type Tool = {
    name: string
    description: string
    parameters: Record<string, unknown>
    execute(args: unknown, context?: unknown): Promise<unknown>
  }
  class Tools {
    readonly registry = new Map<string, Tool>()
    register(definition: unknown) {
      const tool = definition as Tool
      this.registry.set(tool.name, tool)
      return () => { this.registry.delete(tool.name) }
    }
    get(name: string) { return this.registry.get(name) }
    definitions() { return [...this.registry.values()] }
  }
  const tools = new Tools()
  const disposers: Array<() => void> = []
  const context = { tools,
    ...(trackEffects ? { effect: (register: () => () => void) => { disposers.push(register()) } } : {}),
    get: (name: string) => provided.get(name),
    provide: (name: string, value?: unknown) => { provided.set(name, value) },
    plugin: async () => { activations++; return { dispose() {} } } }
  vi.stubGlobal('location', { origin: 'https://stage-fixture.invalid' })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    requests.push(request)
    if (url.origin !== 'https://stage-fixture.invalid') throw new Error('External network is forbidden')
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: data.previous, codeBySha: data.input.codeBySha })
    if (url.pathname === '/_head/lease' && request.method === 'POST') {
      const input = await request.json() as { ownerPeerId: string }
      return Response.json({ ok: true, ballId: data.previous.ballId,
        lease: { ownerPeerId: input.ownerPeerId, generation: 1, expiresAt: Date.now() + 30000 } })
    }
    throw new Error('Unexpected network effect: ' + request.method + ' ' + url.pathname)
  })
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  const runtime = await mountX6BallRuntime(context, vfs, loader)
  const stage = (input: unknown) => runtime.handleControlRequest('POST', '/__x6__/stage-head-promotion', JSON.stringify(input))
  return { ...data, vfs, tools, runtime, stage, requests,
    dispose: () => { for (const dispose of disposers.reverse()) dispose() },
    get activations() { return activations } }
}

describe('Round 24 inert governance review serialization', () => {
  it('preserves the exact candidate and CAS fields, excluding leases, approvals and qualification claims', () => {
    const { previous, input } = fixture()
    const text = serializeStagedHeadPromotion(previous, { ...input, writerLease: { ownerPeerId: 'expired', generation: 42 },
      approvalToken: 'synthetic-private-token', qualificationId: 'synthetic-stale-qualification', headers: { authorization: 'synthetic-owner-secret' }, path: '/other/path' }, 3000)
    const result: unknown = JSON.parse(text)
    expect(result).toEqual({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 3000, body: input })
    expect(result).toHaveProperty('body.ball.authorPeerId', 'review-author')
    expect(result).not.toHaveProperty('body.writerLease')
    for (const privateValue of ['synthetic-private-token', 'synthetic-stale-qualification', 'synthetic-owner-secret', '/other/path']) expect(text).not.toContain(privateValue)
    expect(STAGED_HEAD_PROMOTION_PATH).toBe('/dsh/home/auma/staged/head-promotion.json')
    expect(input.ball.ballId).toBe(manifestId(input.ball))
  })

  it('refuses stale parents, epochs, module bytes, missing historical modules and changed manifest hashes', () => {
    const { previous, input, originalSha, candidateSha } = fixture()
    for (const body of [
      { ...input, expectedParentBallId: '0'.repeat(64) }, { ...input, expectedEpoch: 161 },
      { ...input, ball: { ...input.ball, parentBallId: '0'.repeat(64) } },
      { ...input, ball: { ...input.ball, epoch: 164 } }, { ...input, ball: { ...input.ball, ballId: '0'.repeat(64) } },
      { ...input, ball: { ...input.ball, authorPeerId: '../invalid' } },
      { ...input, codeBySha: { ...input.codeBySha, [candidateSha]: 'modified bytes' } },
      { ...input, codeBySha: { [candidateSha]: input.codeBySha[candidateSha] } },
      { ...input, codeBySha: { [originalSha]: input.codeBySha[originalSha] } },
      { ...input, ball: { ...input.ball, modules: { [candidateSha]: input.ball.modules[candidateSha] } } },
    ]) expect(() => serializeStagedHeadPromotion(previous, body, 3000)).toThrow(/STAGED_PROMOTION_/)
  })

  it('refuses private or claimed-authority metadata inside the hash-bound candidate rather than silently stripping it', () => {
    const { previous, input } = fixture()
    for (const key of ['approvalToken', 'privateKey', 'ownerSecret', 'recoveryPhrase', 'qualificationId', 'authorization', 'credentials']) {
      const ball = identified({ ...input.ball, entries: { 'seed-pearl': { ...input.ball.entries['seed-pearl']!, config: { nested: { [key]: 'synthetic-secret' } } } } })
      expect(() => serializeStagedHeadPromotion(previous, { ...input, ball }, 3000)).toThrow('STAGED_PROMOTION_PRIVATE_METADATA_REFUSED')
    }
    expect(() => serializeStagedHeadPromotion(previous, { ...input, ball: { ...input.ball, approved: true } }, 3000)).toThrow('STAGED_PROMOTION_METADATA_REFUSED')
  })

  it('requires exactly one governance change, including an existing declarative flag removed in the candidate', () => {
    const { previous, input } = fixture('future-policy', { governance: true })
    const removedFlag = identified({ ...input.ball, entries: { 'future-policy': { ...input.ball.entries['future-policy']!, config: { governance: false } } } })
    const staged: unknown = JSON.parse(serializeStagedHeadPromotion(previous, { ...input, ball: removedFlag }, 3000))
    expect(staged).toHaveProperty('body.ball', removedFlag)
    const ordinary = fixture('seed-calculator')
    expect(() => serializeStagedHeadPromotion(ordinary.previous, ordinary.input, 3000)).toThrow('STAGED_PROMOTION_SINGLE_GOVERNANCE_REQUIRED')
    const added = identified({ ...input.ball, entries: { ...input.ball.entries,
      'seed-memory': { ...input.ball.entries['future-policy']!, id: 'seed-memory' } } })
    expect(() => serializeStagedHeadPromotion(previous, { ...input, ball: added }, 3000)).toThrow('STAGED_PROMOTION_SINGLE_GOVERNANCE_REQUIRED')
  })

  it('caps the complete UTF-8 review descriptor at 4 MiB independently from the larger publish request limit', () => {
    const { previous, input, candidateSha } = fixture()
    expect(() => serializeStagedHeadPromotion(previous, { ...input, codeBySha: { ...input.codeBySha, [candidateSha]: 'é'.repeat(2 * 1024 * 1024) } }, 3000))
      .toThrow('STAGED_PROMOTION_BYTE_LIMIT')
  })
})

describe('Round 29 canonical manifest compatibility', () => {
  it.each(['legacy', 'canonical'] as const)('snapshots a %s selected head without changing restore or Class 1 authority', async (encoding) => {
    const value = await mountedFixture('seed-calculator', {}, encoding)
    const headText = value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')
    const beforeActivations = value.activations
    await expect(value.tools.get('auma_snapshot')!.execute({ action: 'list' }))
      .resolves.toMatchObject({ ok: true, snapshots: [{ ballId: value.previous.ballId }] })
    await expect(value.tools.get('auma_snapshot')!.execute({ action: 'create' }))
      .resolves.toMatchObject({ ok: true, ballId: value.previous.ballId })
    const snapshot = JSON.parse(value.vfs.readFileSync('/dsh/home/auma/snapshots/LATEST.json', 'utf8') as string) as { ball: BallManifest }
    expect(snapshot.ball).toEqual(value.previous)
    await expect(value.tools.get('auma_snapshot')!.execute({ action: 'restore' }))
      .rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
    await expect(value.runtime.treePatch({ id: 'seed-calculator', specifier: `ball:${value.candidateSha}` }))
      .rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
    await expect(value.runtime.treeUndo({ id: 'seed-calculator' }))
      .rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
    expect(value.vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(false)
    expect(value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')).toBe(headText)
    expect(value.activations).toBe(beforeActivations)
  })

  it.each(['legacy', 'canonical'] as const)('stages a canonical governance candidate from a %s parent with all sibling fields retained', async (encoding) => {
    const value = await mountedFixture('future-policy', { governance: true }, encoding)
    const headText = value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')
    const beforeActivations = value.activations
    await expect(value.runtime.treePatch({ id: 'future-policy', specifier: `ball:${value.candidateSha}` }))
      .rejects.toThrow('CLASS3_WEBAUTHN_REQUIRED')
    const staged = JSON.parse(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string) as { body: { ball: BallManifest } }
    const ball = staged.body.ball
    expect(ball.ballId).toBe(await serverCanonicalId(ball))
    expect(ball.ballId).not.toBe(manifestId(ball))
    expect(ball.parentBallId).toBe(value.previous.ballId)
    expect(ball.authorPeerId).toBe(value.runtime.status().peerId)
    expect(ball.entries['seed-sibling']).toEqual(value.previous.entries['seed-sibling'])
    expect(staged.body).not.toHaveProperty('qualificationId')
    expect(staged.body).not.toHaveProperty('approvalToken')
    expect(value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')).toBe(headText)
    expect(value.activations).toBe(beforeActivations)
    expect(value.requests.every(request => !(new URL(request.url).pathname === '/_head/ball' && request.method === 'POST'))).toBe(true)
  })

  it('refuses altered author, timestamp, unknown metadata and sibling history under an unchanged canonical snapshot ID', async () => {
    const value = await mountedFixture('seed-calculator', {}, 'canonical')
    const path = '/dsh/home/auma/snapshots/LATEST.json'
    const text = value.vfs.readFileSync(path, 'utf8') as string
    const snapshot = JSON.parse(text) as { ball: BallManifest }
    const sibling = snapshot.ball.entries['seed-sibling']!
    const variants = [
      { ...snapshot.ball, authorPeerId: 'altered-author' },
      { ...snapshot.ball, createdAt: snapshot.ball.createdAt + 1 },
      { ...snapshot.ball, extraMetadata: { replaced: true } },
      { ...snapshot.ball, entries: { ...snapshot.ball.entries, 'seed-sibling': { ...sibling, updatedAt: sibling.updatedAt + 1 } } },
    ]
    for (const ball of variants) {
      value.vfs.writeFileSync(path, JSON.stringify({ ...snapshot, ball }))
      await expect(value.tools.get('auma_snapshot')!.execute({ action: 'restore' }))
        .rejects.toThrow('SNAPSHOT_MANIFEST_HASH_MISMATCH')
    }
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
  })

  it('retains supplied canonical candidate bytes and refuses changed metadata instead of re-identifying them', async () => {
    const { previous, input } = fixture()
    const ball = { ...input.ball, ballId: await serverCanonicalId(input.ball) }
    const staged: unknown = JSON.parse(serializeStagedHeadPromotion(previous, { ...input, ball }, 3000))
    expect(staged).toHaveProperty('body.ball', ball)
    for (const changed of [{ ...ball, authorPeerId: 'altered-author' }, { ...ball, createdAt: ball.createdAt + 1 }]) {
      expect(() => serializeStagedHeadPromotion(previous, { ...input, ball: changed }, 3000))
        .toThrow('STAGED_PROMOTION_MANIFEST_HASH_MISMATCH')
    }
  })

  it('preserves an existing legacy review when a freshly generated canonical candidate would replace it', async () => {
    const value = await mountedFixture()
    expect(await value.stage(value.input)).toMatchObject({ status: 200, body: { staged: true } })
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')
    await expect(value.runtime.treePatch({ id: 'seed-pearl', specifier: `ball:${value.candidateSha}` }))
      .rejects.toThrow('STAGED_PROMOTION_REVIEW_CONFLICT')
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(before)
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
  })
})

describe('Round 24 runtime governance classification', () => {
  it('classifies all eight fixed organs and every selected entry explicitly', () => {
    for (const id of ['seed-receipts', 'seed-superagent', 'seed-pearl', 'seed-aura', 'seed-predict', 'seed-recall', 'seed-memory', 'auma-body-map']) {
      expect(classifyEntryGovernance(id, { config: { governance: false } })).toBe(3)
      expect(classifyEntryGovernance(`${id}:${'a'.repeat(64)}`)).toBe(3)
      expect(classifyActionIrreversibility({ action: 'tree_patch', id })).toBe(3)
    }
    const { previous } = fixture('future-policy', { governance: true })
    const entries = { ...previous.entries, 'seed-calculator': { ...previous.entries['future-policy']!, id: 'seed-calculator', config: {} } }
    expect(Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, classifyEntryGovernance(id, entry)])))
      .toEqual({ 'future-policy': 3, 'seed-calculator': 1 })
    expect(classifyActionIrreversibility({ action: 'tree_patch', id: 'future-policy', config: { governance: false } }, entries)).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'future-policy', action: 'mutate' }, entries)).toBe(3)
  })

  it('admits absent/false declarations as ordinary but refuses malformed declarations as governance', () => {
    expect(classifyEntryGovernance('future-policy', { config: {} })).toBe(1)
    expect(classifyEntryGovernance('future-policy', { governance: false, config: { governance: false } })).toBe(1)
    for (const value of [true, null, 'false', 0, {}, undefined]) {
      expect(classifyEntryGovernance('future-policy', { governance: value })).toBe(3)
      expect(classifyEntryGovernance('future-policy', { config: { governance: value } })).toBe(3)
    }
  })
})

describe('Round 24 mounted review writer', () => {
  it('writes through the registered inert tool without activating, selecting, publishing or claiming persistence', async () => {
    const value = await mountedFixture()
    const headText = value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')
    const beforeCalls = value.requests.length, beforeActivations = value.activations
    const flush = vi.spyOn(value.vfs, 'flush').mockRejectedValue(new Error('synthetic persistence failure'))
    const result = await value.tools.get('stage_head_promotion')!.execute({ body: value.input })
    expect(result).toMatchObject({ ok: true, staged: true, ownerApproval: false, qualified: false, localSaved: false, remoteSaved: false })
    const staged: unknown = JSON.parse(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string)
    expect(staged).toHaveProperty('body', value.input)
    expect(value.runtime.status().entryGovernanceClasses).toEqual({ 'seed-pearl': 3 })
    expect(value.vfs.readFileSync('/dsh/home/balls/HEAD.json', 'utf8')).toBe(headText)
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
    expect(value.requests).toHaveLength(beforeCalls)
    expect(value.activations).toBe(beforeActivations)
    expect(value.vfs.existsSync('/dsh/home/auma/seed/receipts.v3.jsonl')).toBe(false)
    expect(flush).not.toHaveBeenCalled()
    await expect(value.vfs.flush()).rejects.toThrow('synthetic persistence failure')
    expect(result).toMatchObject({ localSaved: false, remoteSaved: false })
  })

  it('serializes competing candidates and requires the exact previous review digest before replacement', async () => {
    const value = await mountedFixture()
    const alternativeBall = identified({ ...value.input.ball, entries: { 'seed-pearl': { ...value.input.ball.entries['seed-pearl']!, config: { revision: 2 } } } })
    const alternative = { ...value.input, ball: alternativeBall }
    const [first, second] = await Promise.all([value.stage(value.input), value.stage(alternative)])
    expect(first?.status).toBe(200)
    expect(second).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_REVIEW_CONFLICT' } })
    const firstText = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    expect(await value.stage(value.input)).toMatchObject({ status: 200, body: { idempotent: true, stagedSha256: hash(firstText) } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(firstText)
    expect(await value.stage({ ...alternative, expectedStagedSha256: '0'.repeat(64) })).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_REVIEW_CONFLICT' } })
    expect(await value.stage({ ...alternative, expectedStagedSha256: hash(firstText) }))
      .toMatchObject({ status: 200, body: { idempotent: false } })
    const replacedText = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    const replaced: unknown = JSON.parse(replacedText)
    expect(replaced).toHaveProperty('body.ball', alternativeBall)
    expect(await value.stage(value.input)).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_REVIEW_CONFLICT' } })
    expect(await value.stage({ ...value.input, expectedStagedSha256: hash(firstText) })).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_REVIEW_CONFLICT' } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(replacedText)
  })

  it('preserves the existing review on stale parent, invalid module, oversize request and VFS write failure', async () => {
    const value = await mountedFixture()
    await value.stage(value.input)
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    for (const input of [{ ...value.input, expectedParentBallId: '0'.repeat(64) },
      { ...value.input, codeBySha: { ...value.input.codeBySha, [value.candidateSha]: 'incorrect bytes' } }]) {
      expect(await value.stage(input)).toMatchObject({ status: 400, body: { ok: false } })
      expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(before)
    }
    expect(await value.runtime.handleControlRequest('POST', '/__x6__/stage-head-promotion', ' '.repeat(4 * 1024 * 1024 + 1)))
      .toMatchObject({ status: 413, body: { code: 'STAGED_PROMOTION_BYTE_LIMIT' } })
    const ball = identified({ ...value.input.ball, entries: { 'seed-pearl': { ...value.input.ball.entries['seed-pearl']!, config: { revision: 2 } } } })
    vi.spyOn(value.vfs, 'writeFileSync').mockImplementationOnce(() => { throw new Error('synthetic VFS write refusal') })
    expect(await value.stage({ ...value.input, ball, expectedStagedSha256: hash(before) })).toMatchObject({ status: 400, body: { error: 'synthetic VFS write refusal' } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(before)
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
  })

  it('stages a directly attempted governance patch before refusing activation and still blocks registered mutators', async () => {
    const value = await mountedFixture('future-policy', { governance: true })
    const beforeActivations = value.activations
    await expect(value.tools.get('tree_patch')!.execute({ id: 'future-policy', specifier: `ball:${value.candidateSha}`, config: { governance: false } }))
      .rejects.toThrow('CLASS3_OWNER_SIGNATURE_REQUIRED')
    expect(value.vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(false)
    await expect(value.runtime.treePatch({ id: 'future-policy', specifier: `ball:${value.candidateSha}` })).rejects.toMatchObject({ notApplied: true })
    const staged: unknown = JSON.parse(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string)
    expect(staged).toHaveProperty('body.ball.entries.future-policy.specifier', `ball:${value.candidateSha}`)
    expect(staged).not.toHaveProperty('body.writerLease')
    expect(staged).toHaveProperty('body.ball.parentBallId', value.previous.ballId)
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
    expect(value.runtime.status().entryGovernanceClasses).toEqual({ 'future-policy': 3 })
    expect(value.activations).toBe(beforeActivations)
    expect(value.requests.every(request => !(new URL(request.url).pathname === '/_head/ball' && request.method === 'POST'))).toBe(true)
  })

  it('refuses a hard-linked review target without modifying any linked file', async () => {
    const value = await mountedFixture()
    await value.stage(value.input)
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    const other = '/dsh/home/auma/staged/other.json'
    value.vfs.linkSync(STAGED_HEAD_PROMOTION_PATH, other)
    expect(await value.stage(value.input)).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_TARGET_NOT_PRIVATE' } })
    const ball = identified({ ...value.input.ball, entries: { 'seed-pearl': { ...value.input.ball.entries['seed-pearl']!, config: { revision: 2 } } } })
    expect(await value.stage({ ...value.input, ball, expectedStagedSha256: hash(before) })).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_TARGET_NOT_PRIVATE' } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(before)
    expect(value.vfs.readFileSync(other, 'utf8')).toBe(before)
  })

  it('requires an exact digest to replace malformed existing review bytes without retaining their metadata', async () => {
    const value = await mountedFixture()
    value.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
    const invalid = JSON.stringify({ schema: 'wrong-schema', approvalToken: 'synthetic-invalid-metadata', body: value.input })
    value.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, invalid)
    expect(await value.stage(value.input)).toMatchObject({ status: 400, body: { error: 'STAGED_PROMOTION_REVIEW_CONFLICT' } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(invalid)
    expect(await value.stage({ ...value.input, expectedStagedSha256: hash(invalid) }))
      .toMatchObject({ status: 200, body: { idempotent: false } })
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).not.toContain('synthetic-invalid-metadata')
  })

  it('refuses the old bearer bridge before parsing or writing anything', async () => {
    const value = await mountedFixture()
    const beforeCalls = value.requests.length
    const write = vi.spyOn(value.vfs, 'writeFileSync')
    for (const text of ['{invalid JSON', JSON.stringify({ approvalToken: 'synthetic-private-bearer' })]) {
      expect(await value.runtime.handleControlRequest('POST', '/__x6__/governance-approval', text))
        .toEqual({ status: 403, body: { ok: false, code: 'CLASS3_PRIVATE_TRANSPORT_UNAVAILABLE' } })
    }
    expect(write).not.toHaveBeenCalled()
    expect(value.requests).toHaveLength(beforeCalls)
  })
})

describe('Round 36: outward Class 3 requests wait for the owner\'s passkey', () => {
  it('stages the exact GitHub post the edge refused without the passkey; repository writes stay refused in the worker', async () => {
    const value = await mountedFixture()
    const sent: Array<{ path: string; body: unknown }> = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init), url = new URL(request.url)
      sent.push({ path: url.pathname, body: await request.json() })
      if (url.pathname === '/_host/github') return Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', macFallback: false }, { status: 403 })
      throw new Error('Unexpected network effect: ' + url.pathname)
    })
    const post = { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues', body: { title: 'A finding', body: 'Details.' } }
    const answer = await value.tools.get('x6_github')!.execute(post)
    expect(answer).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', stagedForOwner: true, stagedPath: STAGED_OUTWARD_PATH, sent: false })
    expect(sent).toEqual([{ path: '/_host/github', body: post }])
    const staged = JSON.parse(value.vfs.readFileSync(STAGED_OUTWARD_PATH, 'utf8') as string) as Record<string, unknown>
    expect(staged).toMatchObject({ schema: STAGED_OUTWARD_SCHEMA, tool: 'x6_github', method: 'POST', pathname: '/_host/github', body: post })

    // A publication to main is not staged by the worker: its own gate still refuses it before any request.
    await expect(value.tools.get('x6_repo')!.execute({ action: 'write', path: 'apps/web/src/x.ts', content: 'y',
      expectedHeadSha: 'a'.repeat(40), idempotencyKey: 'auma-publish-0001', message: 'Add x' })).rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
    expect(sent).toHaveLength(1)
  })
})

describe('Round 37: Auma runs her Wasm cells through x6_cell', () => {
  it('lists the 24 pinned cells and computes with one, fetched same-origin and admitted in her runtime', async () => {
    const value = await mountedFixture()
    const { readFile } = await import('node:fs/promises')
    const fetched: string[] = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL) => {
      const url = new URL(String(resource))
      fetched.push(url.href)
      if (url.origin !== 'https://stage-fixture.invalid' || !url.pathname.startsWith('/cells/')) throw new Error('Unexpected network effect: ' + url.href)
      return new Response(await readFile(new URL('../../../../../apps/web/public' + url.pathname, import.meta.url)))
    })
    const cell = value.tools.get('x6_cell')!
    const listed = await cell.execute({ action: 'list' }) as { ok: boolean; cells: { cell: string }[] }
    expect(listed.ok).toBe(true)
    expect(listed.cells).toHaveLength(25)
    expect(fetched).toEqual([])
    expect(await cell.execute({ action: 'compute', cell: 'nostr-core', op: 'nostr.ping' }))
      .toMatchObject({ ok: true, cell: 'nostr-core', result: { pong: true, version: 1 } })
    expect(await cell.execute({ action: 'compute', cell: 'seed-judge', op: 'seed.platform', input: { platform: 'browser' } }))
      .toMatchObject({ ok: true, result: { code: 0 } })
    expect(fetched).toEqual(['https://stage-fixture.invalid/cells/nostr-core.wasm', 'https://stage-fixture.invalid/cells/seed-judge.wasm'])
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'compute' })).toBe(0)
    expect(classifyActionIrreversibility({ tool: 'x6_cell', action: 'list' })).toBe(0)
  })
})



describe('Wave 3 promotion transport and classification', () => {
  it.each(['write', 'edit', 'commit'])('exempts only documentation filenames from history classification for %s', (action) => {
    for (const path of ['docs/receipts.md', 'docs/architecture/dag-history.md', 'NORTH-STAR-checkpoint.md']) {
      expect(classifyActionIrreversibility({ tool: 'x6_repo', action, path })).toBe(1)
    }
    for (const path of ['receipts.v3.jsonl', 'docs/receipts.json', 'docs/../history.md', '/docs/history.md', 'src/history.md']) {
      expect(classifyActionIrreversibility({ tool: 'x6_repo', action, path })).toBe(2)
    }
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action, path: 'docs/private-key-history.md' })).toBe(4)
    expect(classifyActionIrreversibility({ tool: 'seed-receipts', action, path: 'docs/history.md' })).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'push', path: 'docs/history.md' })).toBe(3)
  })

  it.each(['success', 'refused', 'malformed', 'network'])('reports %s staging without claiming promotion or approval', async (outcome) => {
    const value = await mountedFixture('future-policy', { governance: true }, 'canonical')
    await value.stage(value.input)
    const originalFetch = globalThis.fetch
    const uploads: Request[] = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      if (new URL(request.url).pathname !== '/_head/stage') return originalFetch(resource, init)
      uploads.push(request)
      if (outcome === 'network') throw new Error('synthetic network failure')
      if (outcome === 'malformed') return new Response('{invalid')
      if (outcome === 'refused') return Response.json({ ok: false, code: 'STAGE_REFUSED' }, { status: 409 })
      return Response.json({ ok: true, staged: { state: 'awaiting_owner', binding: { ballId: value.input.ball.ballId } } })
    })
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    const result = await value.tools.get('x6_repo')!.execute({ action: 'promote_staged' })
    expect(result).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', tier: 'T2', requiresPasskey: true,
      edgeStaged: outcome === 'success', stagedForOwner: outcome === 'success' })
    expect(uploads).toHaveLength(1)
    expect(await uploads[0]!.json()).toEqual(JSON.parse(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string))
    const originalEnvelope = JSON.parse(before) as { stagedAt: number }
    expect(JSON.parse(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string)).toHaveProperty('stagedAt', originalEnvelope.stagedAt)
    expect(value.requests.filter(request => request.method === 'POST')).toEqual([])
    expect(value.runtime.status().ballId).toBe(value.previous.ballId)
    if (outcome === 'refused') expect(result).toMatchObject({ stageError: 'STAGE_REFUSED', stageStatus: 409 })
    if (outcome === 'malformed') expect(result).toMatchObject({ stageError: 'HEAD_STAGE_NOT_ACKNOWLEDGED' })
    // Lane E4: transport failures are typed; the raw message is kept as detail.
    if (outcome === 'network') expect(result).toMatchObject({ stageError: 'HEAD_STAGE_UNREACHABLE', stageDetail: 'synthetic network failure' })
  })

  it('preserves an already canonical local envelope exactly and stops before upload if local staging fails', async () => {
    const value = await mountedFixture('future-policy', { governance: true }, 'canonical')
    const ball = { ...value.input.ball, ballId: await serverCanonicalId(value.input.ball) }
    await value.stage({ ...value.input, ball })
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8') as string
    const originalFetch = globalThis.fetch
    const uploads: Request[] = []
    vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(resource, init)
      if (new URL(request.url).pathname !== '/_head/stage') return originalFetch(resource, init)
      uploads.push(request)
      return Response.json({ ok: true, staged: { state: 'awaiting_owner' } })
    })
    expect(await value.tools.get('x6_repo')!.execute({ action: 'promote_staged' })).toMatchObject({ edgeStaged: true })
    expect(await uploads[0]!.json()).toEqual(JSON.parse(before))
    const write = value.vfs.writeFileSync.bind(value.vfs)
    vi.spyOn(value.vfs, 'writeFileSync').mockImplementation((path, ...args) => {
      if (path === STAGED_HEAD_PROMOTION_PATH) throw new Error('synthetic stage write failure')
      write(path, ...args)
    })
    expect(await value.tools.get('x6_repo')!.execute({ action: 'promote_staged' }))
      .toMatchObject({ ok: false, code: 'LOCAL_STAGE_WRITE_FAILED', edgeStaged: false, stagedForOwner: false })
    expect(uploads).toHaveLength(1)
  })

  it('never posts a stage during a T2 dry run', async () => {
    const value = await mountedFixture('future-policy', { governance: true })
    await value.stage(value.input)
    const before = value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')
    expect(await value.tools.get('x6_repo')!.execute({ action: 'promote_staged', dryRun: true }))
      .toMatchObject({ dryRun: true, committed: false, tier: 'T2', authCode: 'CLASS3_WEBAUTHN_REQUIRED' })
    expect(value.requests.filter(request => request.method === 'POST')).toEqual([])
    expect(value.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(before)
  })

  it.each([[true, false, 't1-session'], [true, true, 'consumed'], [true, 'true', 't1-session'],
    [true, 1, 't1-session'], [true, undefined, 't1-session'], [false, false, 'refused']])(
    'reports authorization outcome for success=%s token=%s', async (ok, hasApprovalToken, expected) => {
      const value = await mountedFixture()
      const originalFetch = globalThis.fetch
      vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (new URL(new Request(resource, init).url).pathname === '/_head/promotion-status') return Response.json({ lastPublishOutcome: { ok, hasApprovalToken } })
        return originalFetch(resource, init)
      })
      expect(await value.tools.get('x6_repo')!.execute({ action: 'promotion_status' })).toMatchObject({ lastAuthorizationOutcome: expected })
    })
})


async function mountedConsultFixture() {
  const value = await mountedFixture('seed-pearl', {}, 'legacy', true)
  const controller = new AbortController(), exec = { agent: {}, signal: controller.signal }
  const requests: Request[] = []
  let generation = 0
  const transport = {
    transcript: async (input: Record<string, unknown>): Promise<Response> => {
      if (input.action === 'turn_start') generation++
      return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation,
        status: input.action === 'turn_start' ? 'running' : input.action === 'turn_abandon' ? 'abandoned' : 'completed' } })
    },
    door: async (_request: Request): Promise<Response> => Response.json({ choices: [{ message: { content: 'synthetic answer' } }] }),
  }
  const originalFetch = globalThis.fetch
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), pathname = new URL(request.url).pathname
    if (pathname === '/_head/transcript') return await transport.transcript(await request.json() as Record<string, unknown>)
    if (pathname.startsWith('/door/')) { requests.push(request); return await transport.door(request) }
    return originalFetch(resource, init)
  })
  const run = async (name: string, args: Record<string, unknown>, execution: unknown = exec): Promise<unknown> => {
    const tool = value.tools.get(name)
    if (!tool) throw new Error('Mounted tool missing: ' + name)
    return await tool.execute(args, execution)
  }
  const transcript = (subAction: string, turnId = 'owned-A', execution: unknown = exec) =>
    run('x6_repo', { action: 'transcript', subAction, turn_id: turnId }, execution)
  return { ...value, exec, controller, transport, requests, run, transcript }
}

const consultInput = { provider: 'deepseek', model: 'deepseek-chat', prompt: 'synthetic', parentTurnId: 'spoofed', turn_id: 'spoofed' }

describe('mounted consult parent ownership and cancellation', () => {
  it('uses an acknowledged agent parent for repeated consults and both swarm forms with distinct request IDs', async () => {
    const value = await mountedConsultFixture()
    try {
      // A manual x6_transcript parent is still honoured (Lane E5 only adds acquisition when none is live).
      await value.transcript('turn_start')
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ ok: true })
      expect(await value.run('x6_consult', { ...consultInput, prompt: 'second consult' })).toMatchObject({ ok: true })
      // Lane E5: another agent never borrows this parent; it acquires its own.
      expect(await value.run('x6_consult', consultInput, { ...value.exec, agent: {} })).toMatchObject({ ok: true })
      expect(await value.run('x6_consult', consultInput, { agent: value.exec.agent })).toMatchObject({ code: 'CONSULT_PARENT_TURN_REQUIRED' })
      expect(await value.run('x6_swarm', { tasks: [{ ...consultInput }, { ...consultInput, prompt: 'worker two' }] })).toMatchObject({ ok: true })
      expect(await value.run('x6_swarm', { targets: [{ provider: 'deepseek', model: 'deepseek-chat' }], prompt: 'synthetic' })).toMatchObject({ ok: true })
      expect(value.requests).toHaveLength(6)
      const parents = value.requests.map(request => request.headers.get('x-x6-turn-id'))
      expect(parents.filter(id => id === 'owned-A')).toHaveLength(5)
      expect(parents[2]).toMatch(/^chat-[0-9a-f-]{36}$/)
      const ids = value.requests.map(request => request.headers.get('x-x6-request-id'))
      expect(ids.every(id => typeof id === 'string' && /^[0-9a-f-]{36}$/.test(id))).toBe(true)
      expect(new Set(ids).size).toBe(6)
      await value.transcript('turn_complete')
      // Lane E5: the completed parent is never reused; a live caller turn acquires a fresh one instead of refusing.
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ ok: true })
      expect(value.requests).toHaveLength(7)
      expect(value.requests[6]!.headers.get('x-x6-turn-id')).toMatch(/^chat-[0-9a-f-]{36}$/)
      expect(value.requests[6]!.headers.get('x-x6-turn-id')).not.toBe(parents[2])
    } finally { value.dispose() }
  })

  it.each(['failed', 'replayed', 'other-tab', 'other-turn', 'terminal', 'invalid-generation', 'read', 'aborted-start'] as const)
  ('does not acquire consult ownership from a %s transcript response', async (variant) => {
    const value = await mountedConsultFixture()
    try {
      value.transport.transcript = async input => Response.json({ ok: variant !== 'failed', replayed: variant === 'replayed', turn: {
        turn_id: variant === 'other-turn' ? 'someone-else' : input.turn_id,
        tab_id: variant === 'other-tab' ? 'another-tab' : input.tab_id,
        generation: variant === 'invalid-generation' ? 0 : 1,
        status: variant === 'terminal' ? 'completed' : 'running',
      } }, { status: variant === 'failed' ? 409 : 200 })
      if (variant === 'aborted-start') value.controller.abort()
      await value.transcript(variant === 'read' ? 'read' : 'turn_start')
      const result = await value.run('x6_consult', consultInput, { ...value.exec, signal: new AbortController().signal })
      if (variant === 'read') {
        // Lane E5: a read binds nothing, so the consult acquires its own acknowledged parent.
        expect(result).toMatchObject({ ok: true })
        expect(value.requests[0]!.headers.get('x-x6-turn-id')).toMatch(/^chat-[0-9a-f-]{36}$/)
        return
      }
      // Lane E5: its own acquisition gets the same unacceptable acknowledgement (or a stale generation) and fails closed.
      expect(result).toMatchObject({ code: 'CONSULT_PARENT_TURN_REQUIRED' })
      expect(value.requests).toHaveLength(0)
    } finally { value.dispose() }
  })

  it('cannot rebind a newer parent from a late acknowledgement of an older start', async () => {
    const value = await mountedConsultFixture(), entered = Promise.withResolvers<undefined>(), oldReply = Promise.withResolvers<Response>()
    try {
      value.transport.transcript = async (input) => {
        if (input.turn_id === 'owned-A') { entered.resolve(undefined); return await oldReply.promise }
        return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation: 2, status: 'running' } })
      }
      const oldStart = value.transcript('turn_start')
      await entered.promise
      await value.transcript('turn_start', 'owned-B')
      oldReply.resolve(Response.json({ ok: true, turn: { turn_id: 'owned-A', tab_id: value.runtime.status().peerId, generation: 1, status: 'running' } }))
      await oldStart
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ ok: true })
      expect(value.requests[0]!.headers.get('x-x6-turn-id')).toBe('owned-B')
    } finally { value.dispose() }
  })

  it('does not resurrect a parent when its start acknowledgement arrives after its completion', async () => {
    const value = await mountedConsultFixture(), entered = Promise.withResolvers<undefined>()
    const startReply = Promise.withResolvers<Response>()
    try {
      value.transport.transcript = async (input) => {
        if (input.action === 'turn_start') { entered.resolve(undefined); return await startReply.promise }
        return Response.json({ ok: true, turn: { turn_id: input.turn_id, tab_id: input.tab_id, generation: 1, status: 'completed' } })
      }
      const start = value.transcript('turn_start')
      await entered.promise
      await value.transcript('turn_complete')
      startReply.resolve(Response.json({ ok: true, turn: { turn_id: 'owned-A', tab_id: value.runtime.status().peerId, generation: 1, status: 'running' } }))
      await start
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ code: 'CONSULT_PARENT_TURN_REQUIRED' })
      expect(value.requests).toHaveLength(0)
    } finally { value.dispose() }
  })

  it.each(['caller', 'abandon', 'complete', 'replacement', 'dispose'] as const)
  ('aborts an in-flight consult on %s and suppresses a late provider answer', async (cause) => {
    const value = await mountedConsultFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      await value.transcript('turn_start')
      value.transport.door = async () => { entered.resolve(undefined); await release.promise; return Response.json({ choices: [{ message: { content: 'late answer' } }] }) }
      const pending = value.run('x6_consult', consultInput)
      await entered.promise
      if (cause === 'caller') value.controller.abort()
      else if (cause === 'dispose') value.dispose()
      else await value.transcript(cause === 'replacement' ? 'turn_start' : cause === 'complete' ? 'turn_complete' : 'turn_abandon', cause === 'replacement' ? 'owned-B' : 'owned-A')
      expect(value.requests[0]!.signal.aborted).toBe(true)
      release.resolve(undefined)
      expect(await pending).toMatchObject({ ok: false, answers: [{ ok: false, text: null, code: 'CONSULT_CANCELLED' }] })
      expect(value.requests).toHaveLength(1)
    } finally { release.resolve(undefined); value.dispose() }
  })

  it('removes a completed swarm task answer when its sibling remains pending during cancellation', async () => {
    const value = await mountedConsultFixture(), firstBody = Promise.withResolvers<undefined>()
    const secondEntered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      await value.transcript('turn_start')
      value.transport.door = async (request) => {
        const input = await request.json() as { messages: Array<{ content: string }> }
        if (input.messages[0]!.content === 'pending task') { secondEntered.resolve(undefined); await release.promise }
        const response = Response.json({ choices: [{ message: { content: 'completed sibling secret' } }] })
        if (input.messages[0]!.content === 'completed task') {
          const read = response.json.bind(response)
          response.json = async () => { const body: unknown = await read(); firstBody.resolve(undefined); return body }
        }
        return response
      }
      const pending = value.run('x6_swarm', { tasks: [{ ...consultInput, prompt: 'completed task' }, { ...consultInput, prompt: 'pending task' }] })
      await Promise.all([firstBody.promise, secondEntered.promise])
      // Drain the fulfilled worker's promise chain while the second worker remains explicitly held.
      await new Promise<void>(resolve => setImmediate(resolve))
      value.controller.abort()
      release.resolve(undefined)
      const result = await pending
      expect(result).toMatchObject({ ok: false, workers: [
        { ok: false, answers: [{ ok: false, text: null, code: 'CONSULT_CANCELLED' }] },
        { ok: false, answers: [{ ok: false, text: null, code: 'CONSULT_CANCELLED' }] },
      ] })
      expect(JSON.stringify(result)).not.toContain('completed sibling secret')
    } finally { release.resolve(undefined); value.dispose() }
  })

  it.each(['tasks', 'council'] as const)('propagates cancellation to every in-flight %s swarm member', async (mode) => {
    const value = await mountedConsultFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    try {
      await value.transcript('turn_start')
      value.transport.door = async () => {
        if (value.requests.length === 2) entered.resolve(undefined)
        await release.promise
        return Response.json({ choices: [{ message: { content: 'late answer' } }] })
      }
      const args = mode === 'tasks' ? { tasks: [consultInput, consultInput] }
        : { targets: [consultInput, consultInput], prompt: 'synthetic' }
      const pending = value.run('x6_swarm', args)
      await entered.promise
      value.controller.abort()
      expect(value.requests).toHaveLength(2)
      expect(value.requests.every(request => request.signal.aborted)).toBe(true)
      release.resolve(undefined)
      const result = await pending
      expect(result).toMatchObject(mode === 'tasks'
        ? { ok: false, workers: [{ answers: [{ code: 'CONSULT_CANCELLED' }] }, { answers: [{ code: 'CONSULT_CANCELLED' }] }] }
        : { ok: false, answers: [{ code: 'CONSULT_CANCELLED' }, { code: 'CONSULT_CANCELLED' }] })
      expect(JSON.stringify(result)).not.toContain('late answer')
    } finally { release.resolve(undefined); value.dispose() }
  })
})

interface ConsultEdgeStorage {
  get(key: string): Promise<unknown>
  put(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<boolean>
  list(options?: { prefix?: string; limit?: number }): Promise<Map<string, unknown>>
  getAlarm(): Promise<null>
  setAlarm(): Promise<void>
  deleteAlarm(): Promise<void>
  transaction<T>(operation: (view: ConsultEdgeStorage) => Promise<T>): Promise<T>
}

async function consultEdgeFixture(networkFetch: typeof fetch) {
  let data = new Map<string, unknown>(), tail: Promise<unknown> = Promise.resolve()
  const view = (current: () => Map<string, unknown>): ConsultEdgeStorage => ({
    get: async key => structuredClone(current().get(key)),
    put: async (key, value) => { current().set(key, structuredClone(value)) },
    delete: async key => current().delete(key),
    list: async ({ prefix = '', limit = Infinity } = {}) => new Map([...current()].filter(([key]) => key.startsWith(prefix))
      .sort(([a], [b]) => a.localeCompare(b)).slice(0, limit).map(([key, value]) => [key, structuredClone(value)])),
    getAlarm: async () => null, setAlarm: async () => {}, deleteAlarm: async () => {},
    transaction: async (operation) => {
      const pending = tail.then(async () => {
        const copy = structuredClone(data), result = await operation(view(() => copy))
        data = copy
        return result
      })
      tail = pending.catch(() => {})
      return await pending
    },
  })
  const storage = view(() => data)
  // The JavaScript edge modules are loaded through their real exports, with only provider transport replaced.
  const headModule: {
    X61HeadDurableObject: new (
      state: { storage: ConsultEdgeStorage; getWebSockets(): never[] },
      env: Record<string, unknown>,
      options: { networkFetch: typeof fetch },
    ) => {
      fetch(request: Request): Promise<Response>
      store: {
        bootstrapPrepare(input: unknown): Promise<{ ok: boolean }>
        bootstrapCommit(seedId: string, mirror: unknown): Promise<{ ok: boolean }>
      }
    }
    BOOTSTRAP_VERSION: string
    canonicalBootstrap(input: unknown): string
    digest(input: string): Promise<string>
  } = await import(new URL('../../../../../deploy/cloudflare/src/head-do.mjs', import.meta.url).href)
  const workerModule: {
    createWorker(options: { verifyAccess(): Promise<{ type: string; email: string; expires: number }>; networkFetch: typeof fetch }): {
      fetch(request: Request, env: Record<string, unknown>): Promise<Response>
    }
  } = await import(new URL('../../../../../deploy/cloudflare/src/worker.mjs', import.meta.url).href)
  const dataFixture = fixture('seed-calculator'), ball = { ...dataFixture.previous, ballId: await serverCanonicalId(dataFixture.previous) }
  const payload = { version: headModule.BOOTSTRAP_VERSION, ball,
    codeBySha: { [dataFixture.originalSha]: dataFixture.input.codeBySha[dataFixture.originalSha] },
    mirror: { entryCount: 0, batchDigests: [] } }
  const seedId = await headModule.digest(headModule.canonicalBootstrap(payload))
  const env: Record<string, unknown> = { PUBLIC_HOST: 'stage-fixture.invalid', OWNER_EMAIL: 'owner@example.invalid',
    OWNER_PUBLIC_KEY_HEX: '11'.repeat(32), AUMLOK_CUSTODY_PEPPER: '22'.repeat(32), DEEPSEEK_API_KEY: 'synthetic-key',
    PROVIDER_BUDGET_WINDOW_MS: '60000', PROVIDER_BUDGET_REQUESTS: '20', PROVIDER_BUDGET_TOKENS: '100000', PROVIDER_MAX_OUTPUT_TOKENS: '8192' }
  const head = new headModule.X61HeadDurableObject({ storage, getWebSockets: () => [] }, env, { networkFetch })
  const mirrorStatus = { ok: true, phase: 'ready', seedId, ballId: ball.ballId, epoch: ball.epoch, entryCount: 0, nextBatch: 0, batchCount: 0 }
  expect((await head.store.bootstrapPrepare({ ...payload, seedId })).ok).toBe(true)
  expect((await head.store.bootstrapCommit(seedId, mirrorStatus)).ok).toBe(true)
  env.HEAD = { idFromName: () => 'synthetic-head', get: () => head }
  env.MIRROR = { idFromName: () => 'synthetic-mirror', get: () => ({ fetch: async (request: Request) => {
    if (new URL(request.url).pathname !== '/_mirror/bootstrap-status') throw new Error('Unexpected mirror request')
    return Response.json(mirrorStatus)
  } }) }
  const worker = workerModule.createWorker({ networkFetch,
    verifyAccess: async () => ({ type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }) })
  const send = async (request: Request): Promise<Response> => {
    const headers = new Headers(request.headers)
    headers.set('origin', 'https://stage-fixture.invalid')
    headers.set('sec-fetch-site', 'same-origin')
    return await worker.fetch(new Request(request, { headers }), env)
  }
  const post = async (path: string, input: unknown): Promise<Response> => await send(new Request('https://stage-fixture.invalid' + path,
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input) }))
  return { storage, send, post }
}

describe('mounted consult through the edge Worker and HeadDO', () => {
  it('keeps repeated requests distinct under one parent and fences cancellation without a real provider', async () => {
    const value = await mountedConsultFixture(), entered = Promise.withResolvers<undefined>(), release = Promise.withResolvers<undefined>()
    let networkCalls = 0, hold = false
    const networkSignals: Array<AbortSignal | null | undefined> = []
    const edge = await consultEdgeFixture(async (_resource, init) => {
      networkCalls++
      networkSignals.push(init?.signal)
      if (hold) { entered.resolve(undefined); await release.promise }
      return Response.json({ choices: [{ message: { content: 'synthetic edge answer' } }] })
    })
    try {
      value.transport.transcript = async input => await edge.post('/_head/transcript', input)
      value.transport.door = async request => await edge.send(request)
      expect(await value.transcript('turn_start')).toMatchObject({ ok: true })
      const first = await value.run('x6_consult', consultInput)
      expect(first, JSON.stringify(first)).toMatchObject({ ok: true })
      expect(await value.run('x6_consult', { ...consultInput, prompt: 'different request' })).toMatchObject({ ok: true })
      expect(networkCalls).toBe(2)
      const requestIds = value.requests.map(request => request.headers.get('x-x6-request-id'))
      expect(new Set(requestIds).size).toBe(2)
      for (const requestId of requestIds) {
        expect(await edge.storage.get('head:turn-journal:turn:' + requestId)).toMatchObject({ parentTurnId: 'owned-A' })
      }
      hold = true
      const pending = value.run('x6_consult', consultInput)
      await entered.promise
      // Cancel on the server alone: the runtime retains its local parent until a transcript acknowledgement.
      expect((await edge.post('/_host/voice', { action: 'barge_in', turnId: 'owned-A' })).status).toBe(200)
      expect(networkSignals[2]?.aborted).toBe(true)
      release.resolve(undefined)
      expect(await pending).toMatchObject({ ok: false })
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ ok: false })
      expect(networkCalls).toBe(3)
      expect(await value.transcript('turn_start')).toMatchObject({ ok: false, code: 'TURN_ALREADY_CANCELLED' })
      hold = false
      expect(await value.transcript('turn_start', 'owned-B')).toMatchObject({ ok: true })
      expect(await value.run('x6_consult', consultInput)).toMatchObject({ ok: true })
      expect(networkCalls).toBe(4)
      expect(value.requests.at(-1)!.headers.get('x-x6-turn-id')).toBe('owned-B')
    } finally { release.resolve(undefined); value.dispose() }
  })
})
