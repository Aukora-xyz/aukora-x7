/** x6_repo `apply_patch`, the tool half. Every host response is local; no provider or owner approval is exercised.
 * The mount harness is repo-actions.spec.ts's (a spec exports nothing, so it is repeated here). */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, mountX6BallRuntime, repoBranchFormRefusal, STAGED_OUTWARD_PATH, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { voiceVerdict, VOICE_SWITCH_TABLE } from '../../src/x6/voice-read-only.ts'

const ORIGIN = 'https://repo-fixture.invalid'
const A = 'auma/proposal/receipts-fix'
const B = 'auma/sandbox/second-fix'
const BASE = 'a'.repeat(40)
const SHA = 'b'.repeat(40)
const hash = (text: string): string => createHash('sha256').update(text).digest('hex')
type Args = Record<string, unknown>
interface Tool { name: string; description: string; parameters: Record<string, unknown>; execute(args: Args): Promise<unknown> }
interface Call { request: Request; body: Args }
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

async function mounted() {
  const source = 'module.exports = { apply() {} }', sha = hash(source)
  const seed: BallManifest = { version: 'x6.1-ball/v1', ballId: '', parentBallId: null, epoch: 1, createdAt: 1000, authorPeerId: 'synthetic',
    entries: { fixture: { id: 'fixture', specifier: `ball:${sha}`, config: {}, disabled: false, previousSpecifiers: [], updatedAt: 1000 } },
    modules: { [sha]: { sha256: sha, specifier: `ball:${sha}`, name: 'fixture', description: 'Synthetic', size: source.length, createdAt: 1000 } } }
  const data: BallManifest = { ...seed, ballId: hash(JSON.stringify({
    version: seed.version, parentBallId: seed.parentBallId, epoch: seed.epoch,
    entries: Object.values(seed.entries), modules: Object.values(seed.modules) })) }
  const vfs = new MemoryVfs(), definitions = new Map<string, Tool>(), services = new Map<string, unknown>(), calls: Call[] = []
  const tools = { register(value: unknown) {
    const tool = value as Tool
    definitions.set(tool.name, tool)
    return () => { definitions.delete(tool.name) }
  } }
  const state = { respond: (body: Args): Response => Response.json(body.action === 'write' || body.action === 'edit'
    ? { ok: true, content: body.content ?? 'edited', staged: true, scope: 'caller', baseSha: BASE }
    : { ok: true }), proposal: null as Args | null }
  vi.stubGlobal('location', { origin: ORIGIN })
  vi.stubGlobal('BroadcastChannel', undefined)
  vi.stubGlobal('WebSocket', undefined)
  vi.stubGlobal('__X6_SERVICES__', {})
  vi.stubGlobal('__X6_BALL__', undefined)
  vi.stubGlobal('__X6_BUILD_IDENTITY__', undefined)
  vi.stubGlobal('fetch', async (resource: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(resource, init), url = new URL(request.url)
    if (url.origin !== ORIGIN) throw new Error('External network is forbidden')
    if (url.pathname === '/_head/ball' && request.method === 'GET') return Response.json({ ok: true, ball: data, codeBySha: { [sha]: source } })
    if (url.pathname === '/_head/lease' && request.method === 'POST') {
      const body = await request.json() as Args
      return Response.json({ ok: true, ballId: data.ballId,
        lease: { ownerPeerId: body.ownerPeerId, generation: 1, expiresAt: Date.now() + 30000 } })
    }
    if (url.pathname === '/_head/promotion-status') return Response.json({ ok: true, stagedRepoProposal: state.proposal, lastRepoMergeOutcome: { ok: true, commitSha: SHA } })
    if (!['/_host/repo', '/_host/github'].includes(url.pathname)) throw new Error('Unexpected request: ' + url.pathname)
    const body = await request.json() as Args
    calls.push({ request, body })
    return state.respond(body)
  })
  const context = { tools, get: (name: string) => services.get(name),
    provide: (name: string, value?: unknown) => { services.set(name, value) },
    plugin: async () => ({ dispose() {} }), effect: (register: () => () => void) => { cleanups.push(register()) } }
  const loader = new WorkerModuleLoader({ vfs, staticModules: { '@deepseek-ai/dsh-tools': () => ({ defineTool: (value: unknown) => value }) } })
  await mountX6BallRuntime(context, vfs, loader)
  const repo = definitions.get('x6_repo')!, github = definitions.get('x6_github')!
  return { repo, github, vfs, calls, state }
}

const PATCH = 'diff --git a/docs/auma/a.md b/docs/auma/a.md\nindex 1111111..2222222 100644\n--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ -1 +1 @@\n-one\n+ONE\n'

describe('x6_repo apply_patch', () => {
  it('advertises apply_patch with its patch field, and still no authority input', async () => {
    const { repo } = await mounted()
    const actions = (repo.parameters.action as { enum: string[] }).enum
    for (const action of ['apply_patch', 'commit']) expect(actions).toContain(action)
    for (const key of ['patch', 'baseSha', 'message', 'branch']) expect(repo.parameters).toHaveProperty(key)
    for (const key of ['approvalToken', 'headers', 'authorization', 'ownerSession', 'token']) expect(repo.parameters).not.toHaveProperty(key)
    expect(repo.description).toContain('`apply_patch` brings a change home')
  })

  it('is classed as her commit: 1 on her own branch, and refused from a look-only voice turn as commit is', () => {
    for (const branch of [A, B]) {
      expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'apply_patch', branch, baseSha: BASE, patch: PATCH, message: 'm' }))
        .toBe(classifyActionIrreversibility({ tool: 'x6_repo', action: 'commit', branch, message: 'm' }))
      expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'apply_patch', branch, path: 'server/receipts-history.mjs' })).toBe(1)
    }
    expect(Object.keys(VOICE_SWITCH_TABLE.x6_repo?.values ?? {})).toContain('read')
    expect(Object.keys(VOICE_SWITCH_TABLE.x6_repo?.values ?? {})).not.toContain('apply_patch')
    for (const action of ['apply_patch', 'commit']) {
      expect(voiceVerdict({ tool: 'x6_repo', args: { action, branch: A, baseSha: BASE, patch: PATCH, message: 'm' }, origin: { kind: 'builtin' } })).toEqual(expect.any(String))
    }
  })

  it('forwards the four fields with the owner session to /_host/repo and returns the edge answer unchanged', async () => {
    const { repo, calls, state } = await mounted()
    state.respond = () => Response.json({ ok: true, action: 'apply_patch', branch: A, head: SHA, files: [{ path: 'docs/auma/a.md', status: 'modified' }] })
    const args = { action: 'apply_patch', branch: A, baseSha: BASE, patch: PATCH, message: 'Bring the change home' }
    expect(await repo.execute(args)).toEqual({ ok: true, action: 'apply_patch', branch: A, head: SHA, files: [{ path: 'docs/auma/a.md', status: 'modified' }] })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.body).toEqual({ ...args, ownerSession: true })
    expect(calls[0]?.request.headers.has('x-x6-class3-approval')).toBe(false)
    expect(calls[0]?.request.credentials).toBe('same-origin')
  })

  it('never sends main or another branch, and says which branches it takes', async () => {
    const { repo, calls, vfs } = await mounted()
    for (const branch of ['main', undefined, 'feature/x']) {
      await expect(repo.execute({ action: 'apply_patch', branch, baseSha: BASE, patch: PATCH, message: 'm' })).rejects.toThrow('REPO_BRANCH_FORM_REFUSED: apply_patch')
    }
    expect(repoBranchFormRefusal({ action: 'apply_patch', branch: 'main' })).toContain('auma/sandbox/<slug> or auma/proposal/<slug>')
    expect(repoBranchFormRefusal({ action: 'apply_patch', branch: A })).toBeNull()
    expect(calls).toHaveLength(0)
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })

  it('a refusal from the edge reaches her as sent and stages no card', async () => {
    const { repo, vfs, state } = await mounted()
    state.respond = () => Response.json({ ok: false, code: 'PATCH_CONTEXT_MISMATCH', path: 'docs/auma/a.md', hunk: 1, macFallback: false }, { status: 409 })
    expect(await repo.execute({ action: 'apply_patch', branch: A, baseSha: BASE, patch: PATCH, message: 'm' }))
      .toEqual({ ok: false, code: 'PATCH_CONTEXT_MISMATCH', path: 'docs/auma/a.md', hunk: 1, macFallback: false })
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })
})
