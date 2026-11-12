/**
 * Lane E6 task 3: the resident read-only capability index for auma-cortex (VOICE-OMNISCIENCE-BRIEF §0–§3, Tier A).
 * Unit level over `createCapabilityIndex`, then on the mounted runtime: Case 10 (a head change is visible on the very next
 * read), Case 8 (an unknown name is "no such surface"), frozen and non-mutating output, digest stability. Local fixtures only.
 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildCapabilityIndex, canonicalJson, createCapabilityIndex, lookupCapability, type CapabilitySource } from '../../src/x6/capability-index.ts'
import { FakeSocket, ORGAN_A2, headManifestIdCanon, mountE4, sha256 } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals() })
const settle = async () => { for (let i = 0; i < 20; i += 1) await new Promise(resolve => setTimeout(resolve, 0)) }

const source = (epoch: number, ballId = `ball-${String(epoch)}`): CapabilitySource => ({
  epoch, ballId,
  tools: [
    { name: 'x6_status', description: 'read status', parameters: {} },
    { name: 'x6_ball', description: 'ball ops', parameters: { action: { type: 'string', required: true, enum: ['list', 'put', 'promote'] } } },
    { name: 'x6_capability_index', parameters: { action: { type: 'string', enum: ['snapshot', 'lookup'] } } },
    { name: 'x6_estate_read', parameters: { action: { type: 'string', enum: ['list', 'read'] } } },
  ],
  entries: { 'organ-a': { specifier: 'ball:aa' }, 'seed-pearl': { specifier: 'ball:bb', disabled: false } },
  modules: { 'ball:aa': { sha256: 'a'.repeat(64), size: 10 }, 'ball:bb': { sha256: 'b'.repeat(64), size: 20 } },
})

describe('capability index (unit)', () => {
  it('declares no voice authority, flags mutating tools conservatively and is deeply frozen', () => {
    const index = buildCapabilityIndex(source(169), 1)
    expect(index).toMatchObject({ schema: 'aukora.capability-index.v1', voiceAuthority: 'none', mutating: false, epoch: 169, ballId: 'ball-169' })
    const byName = Object.fromEntries(index.registeredTools.map(tool => [tool.name, tool]))
    expect(byName.x6_ball).toMatchObject({ readOnly: false, mutating: true })
    expect(byName.x6_estate_read).toMatchObject({ readOnly: true, mutating: false })
    expect(byName.x6_capability_index).toMatchObject({ readOnly: true, mutating: false })
    expect(byName.x6_ball!.parameters).toEqual([{ name: 'action', type: 'string', required: true, enum: ['list', 'put', 'promote'] }])
    expect(index.organs).toEqual([
      { id: 'organ-a', specifier: 'ball:aa', sha256: 'a'.repeat(64), bytes: 10, disabled: false },
      { id: 'seed-pearl', specifier: 'ball:bb', sha256: 'b'.repeat(64), bytes: 20, disabled: false },
    ])
    expect(Object.isFrozen(index)).toBe(true)
    expect(Object.isFrozen(index.registeredTools[0]!.parameters)).toBe(true)
    expect(Object.isFrozen(index.organs[0])).toBe(true)
    expect(() => { (index as { epoch: number }).epoch = 1 }).toThrow()
    expect(() => { (index.registeredTools as unknown as unknown[]).push({}) }).toThrow()
  })

  it('digest is a stable SHA-256 over the canonical body: same state, same digest; any change, a new one', () => {
    const a = buildCapabilityIndex(source(169), 1), b = buildCapabilityIndex(source(169), 999)
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(b.digest).toBe(a.digest)
    const { digest: _d, computedAt: _c, ...body } = a
    expect(createHash('sha256').update(canonicalJson(body)).digest('hex')).toBe(a.digest)
    expect(buildCapabilityIndex(source(170), 1).digest).not.toBe(a.digest)
    const reordered = source(169); (reordered.tools as unknown[]).reverse()
    expect(buildCapabilityIndex(reordered, 1).digest).toBe(a.digest)
  })

  it('Case 10: a promotion is visible on the very next read (no stale epoch); reads in between cost no recompute', () => {
    let live = source(169)
    const cache = createCapabilityIndex(() => live)
    const first = cache.read()
    expect(cache.read()).toBe(first)
    expect(cache.stats().recomputes).toBe(1)
    live = source(170)
    const next = cache.read()
    expect(next.epoch).toBe(170)
    expect(next.ballId).toBe('ball-170')
    expect(next.digest).not.toBe(first.digest)
    expect(cache.stats().recomputes).toBe(2)
    // Same epoch number, different ball (head change without an epoch bump) also recomputes.
    live = source(170, 'fork-170')
    expect(cache.read().ballId).toBe('fork-170')
  })

  it('Case 8: an unknown name is "no such surface" with nothing invented; known names resolve exactly', () => {
    const index = buildCapabilityIndex(source(169), 1)
    const missing = lookupCapability(index, 'toolThatDoesNotExist')
    expect(missing).toEqual({ ok: false, code: 'NO_SUCH_SURFACE', name: 'toolThatDoesNotExist', message: 'no such surface',
      epoch: 169, ballId: 'ball-169', digest: index.digest })
    expect(Object.keys(missing)).not.toContain('tool')
    expect(lookupCapability(index, 'x6_bal')).toMatchObject({ code: 'NO_SUCH_SURFACE' })
    expect(lookupCapability(index, undefined)).toMatchObject({ code: 'NO_SUCH_SURFACE' })
    expect(lookupCapability(index, 'x6_ball')).toMatchObject({ ok: true, kind: 'tool', tool: { name: 'x6_ball', mutating: true } })
    expect(lookupCapability(index, 'organ-a')).toMatchObject({ ok: true, kind: 'organ', organ: { sha256: 'a'.repeat(64) } })
  })

  it('a fake index that caches forever is caught by the Case 10 check', () => {
    let live = source(169)
    const frozenOnce = buildCapabilityIndex(live, 1)
    const fake = { read: () => frozenOnce }
    live = source(170)
    expect(fake.read().epoch).not.toBe(live.epoch) // the broken implementation serves the stale epoch
    const real = createCapabilityIndex(() => live)
    expect(real.read().epoch).toBe(live.epoch)
  })
})

describe('capability index on the mounted runtime', () => {
  it('is registered read-only, reflects the live head, recomputes on a HEAD change, and reaches no write verb', async () => {
    const m = await mountE4()
    const status = await m.status()
    const tool = m.tool('x6_capability_index')
    const params = (tool as unknown as { parameters: { action: { enum: string[] } } }).parameters
    expect(params.action.enum).toEqual(['snapshot', 'lookup'])
    const before = await tool.execute({}, undefined) as ReturnType<typeof buildCapabilityIndex>
    expect(before).toMatchObject({ voiceAuthority: 'none', mutating: false, epoch: status.epoch, ballId: status.ballId })
    expect(before).toBe(m.runtime.capabilityIndex())
    expect(Object.isFrozen(before)).toBe(true)
    const names = before.registeredTools.map(item => item.name)
    expect(names).toContain('x6_capability_index')
    expect(names).toContain('x6_consult')
    expect(before.registeredTools.find(item => item.name === 'x6_capability_index')).toMatchObject({ readOnly: true, mutating: false })
    expect(before.organs.map(organ => organ.id)).toEqual(Object.keys(m.head.ball.entries).sort())
    expect(before.organs.every(organ => /^[a-f0-9]{64}$/.test(organ.sha256 ?? '') && typeof organ.bytes === 'number')).toBe(true)
    expect(await tool.execute({ action: 'lookup', name: 'toolThatDoesNotExist' }, undefined)).toMatchObject({ ok: false, code: 'NO_SUCH_SURFACE', message: 'no such surface' })
    // Any action other than lookup only reads the snapshot: nothing is written, staged or fetched.
    const callsBefore = m.calls.length
    const filesBefore = JSON.stringify(m.vfs.readdirSync('/dsh/home/balls'))
    for (const verb of ['promote', 'approve', 'stage', 'write', 'secret', 'put']) {
      expect(await tool.execute({ action: verb, name: 'x6_ball' }, undefined)).toBe(before)
    }
    expect(m.calls.length).toBe(callsBefore)
    expect(JSON.stringify(m.vfs.readdirSync('/dsh/home/balls'))).toBe(filesBefore)

    // Case 10 on the mount: HEAD moves to a new epoch; the next read returns it.
    const shaA2 = sha256(ORGAN_A2)
    const { ballId: _old, ...prior } = m.head.ball
    const body = { ...prior, parentBallId: m.head.ball.ballId, epoch: m.head.ball.epoch + 1,
      entries: { ...prior.entries, 'organ-a': { ...prior.entries['organ-a']!, specifier: `ball:${shaA2}`, previousSpecifiers: [prior.entries['organ-a']!.specifier] } },
      modules: { ...prior.modules, [shaA2]: { sha256: shaA2, specifier: `ball:${shaA2}`, name: 'organ-a', description: 'Synthetic v2', size: ORGAN_A2.length, createdAt: 1001 } } }
    const nextBall = { ...body, ballId: headManifestIdCanon(body as unknown as Record<string, unknown>) }
    m.head.ball = nextBall as typeof m.head.ball
    m.head.codeBySha[shaA2] = ORGAN_A2
    const socket = FakeSocket.instances.at(-1)!
    socket.open()
    socket.receive(JSON.stringify({ type: 'ball:commit', ball: { ballId: nextBall.ballId } }))
    // An open tab never hot-swaps to a head published elsewhere. It records the lag and
    // keeps running, and describing, the head it runs; one reload brings the published head.
    for (let i = 0; i < 50 && (await m.status()).headLag === null; i += 1) await settle()
    expect(await m.status()).toMatchObject({ ballId: status.ballId, headLag: { published: { ballId: nextBall.ballId } } })
    expect(m.runtime.capabilityIndex()).toBe(before)
    // The reload: a cold boot of the same tab store selects the published head, and the index's next read returns it.
    const reloaded = await mountE4({ vfs: m.vfs, head: m.head })
    expect((await reloaded.status()).ballId).toBe(nextBall.ballId)
    const after = reloaded.runtime.capabilityIndex()
    expect(after.epoch).toBe(nextBall.epoch)
    expect(after.ballId).toBe(nextBall.ballId)
    expect(after.digest).not.toBe(before.digest)
    expect(after.organs.find(organ => organ.id === 'organ-a')).toMatchObject({ sha256: shaA2, bytes: ORGAN_A2.length })
  })
})
