/** Synthetic repository tooling tests. Every host response is local; no providers or owner approvals are exercised. */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, mountX6BallRuntime, STAGED_OUTWARD_PATH, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'

const ORIGIN = 'https://repo-fixture.invalid'
const A = 'auma/proposal/receipts-fix'
const B = 'auma/sandbox/second-fix'
const BASE = 'a'.repeat(40)
const SHA = 'b'.repeat(40)
const TREE = 'c'.repeat(40)
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

describe('Wave 4 repository tool declarations and admission', () => {
  it('advertises every route and no authentication or approval input', async () => {
    const { repo, github } = await mounted()
    expect(repo.parameters.action).toMatchObject({ enum: expect.arrayContaining(['search', 'compare_files', 'branch_create', 'branch_delete', 'stage_proposal', 'merge_proposal', 'draft_discard']) })
    for (const key of ['query', 'regex', 'caseSensitive', 'maxMatches', 'leftPath', 'rightPath', 'leftSource', 'rightSource', 'ref', 'contextLines',
      'branch', 'fromSha', 'title', 'summary', 'baseSha', 'headSha', 'treeSha', 'expectedHeadSha']) expect(repo.parameters).toHaveProperty(key)
    for (const tool of [repo, github]) for (const key of ['approvalToken', 'headers', 'authorization', 'ownerSession', 'token']) expect(tool.parameters).not.toHaveProperty(key)
    expect(github.description).toContain('actions/jobs/<jobId>/logs')
  })

  it('keeps reads Class 0, private source edits Class 1, and every merge Class 3', () => {
    for (const action of ['search', 'compare_files', 'read', 'diff']) expect(classifyActionIrreversibility({ tool: 'x6_repo', action, branch: A })).toBe(0)
    for (const action of ['branch_create', 'branch_delete', 'write', 'edit', 'commit', 'stage_proposal']) {
      expect(classifyActionIrreversibility({ tool: 'x6_repo', action, branch: A, path: 'server/receipts-history.mjs' })).toBe(1)
    }
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'write', path: 'server/receipts-history.mjs' })).toBe(2)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'draft_discard', branch: A, path: 'server/receipts-history.mjs' })).toBe(1)
    for (const branch of [A, 'main', undefined]) expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'merge_proposal', branch, ownerApproved: true })).toBe(3)
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'write', branch: A, path: 'docs/private-key.md' })).toBe(4)
  })

  it('permits escaped branch queries only for the repository Actions run GET reader', async () => {
    const { github, calls } = await mounted()
    const endpoint = 'repos/your_org_x/your-node/actions/runs?branch=auma%2Fproposal%2Freceipts-fix&per_page=10'
    await github.execute({ action: 'api', method: 'GET', endpoint })
    expect(calls[0]?.body).toEqual({ action: 'api', method: 'GET', endpoint })
    expect(classifyActionIrreversibility({ tool: 'x6_github', action: 'api', endpoint: endpoint + '&head_sha=' + SHA })).toBe(0)
    for (const more of [
      { endpoint: endpoint.replace('/actions/runs', '/contents') },
      { endpoint: endpoint + '&token=private' },
      { endpoint: endpoint + '&branch=auma%2Fsandbox%2Fother-fix' },
      { endpoint: endpoint.replace('%2Fproposal', '%252Fproposal') },
      { endpoint, body: {} }, { endpoint, method: 'POST' },
    ]) expect(classifyActionIrreversibility({ tool: 'x6_github', action: 'api', ...more })).toBe(3)
    for (const path of ['actions/runs/12/jobs', 'actions/jobs/34/logs']) {
      expect(classifyActionIrreversibility({ tool: 'x6_github', action: 'api', method: 'GET', endpoint: 'repos/your_org_x/your-node/' + path })).toBe(0)
    }
  })

  it('forwards exact read and owner-session requests without passkey transport', async () => {
    const { repo, calls } = await mounted()
    const reads = [
      { action: 'search', query: 'policy', regex: false, caseSensitive: true, prefix: 'server', branch: A, maxMatches: 200 },
      { action: 'compare_files', leftPath: 'server/a.mjs', rightPath: '/dsh/home/auma/a.mjs', leftSource: 'github', rightSource: 'mirror', ref: A, contextLines: 3 },
      { action: 'diff', branch: A, base: BASE },
    ]
    for (const args of reads) await repo.execute(args)
    for (const args of [{ action: 'branch_create', branch: A, fromSha: BASE }, { action: 'stage_proposal', branch: A, title: 'Fix receipt policy', summary: 'Tests pass.' },
      { action: 'branch_delete', branch: B }]) {
      await repo.execute(args)
      expect(calls.at(-1)?.body).toEqual({ ...args, ownerSession: true })
    }
    expect(calls.slice(0, reads.length).map(call => call.body)).toEqual(reads)
    for (const { request } of calls) {
      expect(request.credentials).toBe('same-origin')
      expect(request.headers.has('authorization')).toBe(false)
      expect(request.headers.has('x-x6-class3-approval')).toBe(false)
    }
  })

  it('refuses merges locally and rejects authority arguments before any request or review artifact', async () => {
    const { repo, github, calls, vfs } = await mounted()
    const body = { action: 'merge_proposal', baseSha: BASE, branch: A, headSha: SHA, treeSha: TREE }
    expect(await repo.execute(body)).toMatchObject({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED', ownerCardRequired: true, sent: false })
    for (const invalid of [{ ...body, baseSha: 'bad' }, { ...body, extra: true }, { ...body, branch: 'main' }]) {
      expect(await repo.execute(invalid)).toMatchObject({ ok: false, code: 'REPO_PROPOSAL_INVALID', sent: false })
    }
    for (const key of ['approvalToken', 'class3Approval', 'headers', 'authorization', 'ownerJwt', 'credentials', 'token', 'ownerSession']) {
      await expect(repo.execute({ ...body, [key]: 'synthetic-private' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
      await expect(github.execute({ action: 'status', [key]: 'synthetic-private' })).rejects.toThrow('BROKER_AUTHORITY_INPUT_REFUSED')
    }
    expect(calls).toHaveLength(0)
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
  })

  it('exposes the HeadDO proposal and outcome through promotion_status', async () => {
    const { repo, state } = await mounted()
    state.proposal = { schema: 'aukora.staged-repo-proposal.v1', branch: A, headSha: SHA }
    expect(await repo.execute({ action: 'promotion_status' })).toMatchObject({ stagedRepoProposal: state.proposal, lastRepoMergeOutcome: { ok: true, commitSha: SHA } })
  })
})

describe('Wave 4 caller-owned branch drafts', () => {
  it('isolates private branches and main and pins each private commit to its acknowledged base', async () => {
    const { repo, calls } = await mounted()
    for (const [branch, content] of [[A, 'private-a'], [B, 'private-b'], ['main', 'main-doc']]) {
      await repo.execute({ action: 'write', branch, path: 'docs/note.md', content })
    }
    for (const [branch, content] of [[A, 'private-a'], ['main', 'main-doc'], [B, 'private-b']]) {
      await repo.execute({ action: 'commit', branch, message: 'Save branch' })
      expect(calls.at(-1)?.body).toEqual({ action: 'commit', branch, message: 'Save branch', ownerSession: true,
        changes: [{ path: 'docs/note.md', content }], ...(branch === 'main' ? {} : { expectedHeadSha: BASE }) })
    }
    // Still refused; the refusal names the branch rule instead of a Pearl qualification fault.
    await expect(repo.execute({ action: 'commit', branch: 'main', message: 'No bypass', expectedHeadSha: BASE }))
      .rejects.toThrow('REPO_BRANCH_FORM_REFUSED: commit with expectedHeadSha is accepted only on auma/sandbox/<slug> or auma/proposal/<slug>')
  })

  it('reads and edits a private draft locally, then revalidates the write against its base', async () => {
    const { repo, calls } = await mounted()
    await repo.execute({ action: 'write', branch: A, path: 'server/receipts.mjs', content: 'alpha beta' })
    expect(await repo.execute({ action: 'read', branch: A, path: 'server/receipts.mjs', offset: 6, length: 4 }))
      .toMatchObject({ content: 'beta', source: 'caller-draft', scope: 'caller', baseSha: BASE, staged: true })
    expect(calls).toHaveLength(1)
    await repo.execute({ action: 'edit', branch: A, path: 'server/receipts.mjs', oldString: 'beta', newString: 'gamma' })
    expect(calls.at(-1)?.body).toEqual({ action: 'write', branch: A, path: 'server/receipts.mjs', content: 'alpha gamma', ownerSession: true, expectedHeadSha: BASE })
    expect(await repo.execute({ action: 'read', branch: A, path: 'server/receipts.mjs' })).toMatchObject({ content: 'alpha gamma' })
    await expect(repo.execute({ action: 'edit', branch: A, path: 'server/receipts.mjs', oldString: 'missing', newString: 'x' })).rejects.toThrow('REPO_EDIT_TARGET_NOT_FOUND')
    await expect(repo.execute({ action: 'read', branch: A, path: 'server/receipts.mjs', offset: -1 })).rejects.toThrow('REPO_BYTE_RANGE_INVALID')
  })

  it('does not replace a successful draft after refusal, dry run, bad acknowledgement or changed base', async () => {
    const { repo, calls, state, vfs } = await mounted()
    const write = { action: 'write', branch: A, path: 'server/fix.mjs', content: 'original' }
    await repo.execute(write)
    const good = state.respond
    state.respond = () => Response.json({ ok: false, code: 'CLASS3_WEBAUTHN_REQUIRED' }, { status: 403 })
    expect(await repo.execute({ ...write, content: 'refused' })).toMatchObject({ stagedForOwner: false })
    expect(vfs.existsSync(STAGED_OUTWARD_PATH)).toBe(false)
    state.respond = good
    await repo.execute({ ...write, content: 'dry', dryRun: true })
    state.respond = () => Response.json({ ok: true, staged: true, content: 'bad-ack' })
    await expect(repo.execute({ ...write, content: 'bad-ack' })).rejects.toThrow('REPO_DRAFT_ACK_INVALID')
    state.respond = () => Response.json({ ok: true, staged: true, scope: 'caller', content: 'new-base', baseSha: SHA })
    await expect(repo.execute({ ...write, content: 'new-base' })).rejects.toThrow('REPO_DRAFT_BASE_CHANGED')
    const before = calls.length
    await expect(repo.execute({ action: 'commit', branch: A, message: 'stale', expectedHeadSha: SHA })).rejects.toThrow('REPO_DRAFT_BASE_CHANGED')
    expect(calls).toHaveLength(before)
    state.respond = good
    await repo.execute({ action: 'commit', branch: A, message: 'Retain original' })
    expect(calls.at(-1)?.body.changes).toEqual([{ path: write.path, content: 'original' }])
  })

  it('keeps drafts after a failed commit and removes them only after successful deletion', async () => {
    const { repo, calls, state } = await mounted()
    await repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'retain' })
    const good = state.respond
    state.respond = () => Response.json({ ok: false, code: 'REPO_BRANCH_MOVED' }, { status: 409 })
    await repo.execute({ action: 'commit', branch: A, message: 'Fails' })
    expect(await repo.execute({ action: 'read', branch: A, path: 'server/fix.mjs' })).toMatchObject({ content: 'retain', source: 'caller-draft' })
    state.respond = good
    await repo.execute({ action: 'branch_delete', branch: A })
    await repo.execute({ action: 'commit', branch: A, message: 'No retained changes' })
    expect(calls.at(-1)?.body).not.toHaveProperty('changes')
    expect(calls.at(-1)?.body).not.toHaveProperty('expectedHeadSha')
  })

  it('keeps unrelated drafts after an explicit partial commit, without silently rebasing them', async () => {
    const { repo, calls } = await mounted()
    for (const path of ['server/one.mjs', 'server/two.mjs']) await repo.execute({ action: 'write', branch: A, path, content: path })
    await repo.execute({ action: 'commit', branch: A, message: 'Only one', changes: [{ path: 'server/one.mjs', content: 'server/one.mjs' }] })
    await repo.execute({ action: 'commit', branch: A, message: 'Still on old base' })
    expect(calls.at(-1)?.body).toMatchObject({ expectedHeadSha: BASE, changes: [{ path: 'server/two.mjs', content: 'server/two.mjs' }] })
  })

  it('removes the original draft after a successful single-step edit commit', async () => {
    const { repo, calls } = await mounted()
    await repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'old' })
    await repo.execute({ action: 'edit', branch: A, path: 'server/fix.mjs', oldString: 'old', newString: 'new', message: 'Commit new' })
    await repo.execute({ action: 'commit', branch: A, message: 'No old draft' })
    expect(calls.at(-1)?.body).not.toHaveProperty('changes')
  })

  it('does not retain a failed network write or an HTTP error claiming ok', async () => {
    const { repo, calls, state } = await mounted()
    const good = state.respond
    state.respond = () => { throw new Error('Synthetic network failure') }
    await expect(repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'never' })).rejects.toThrow('Synthetic network failure')
    state.respond = () => Response.json({ ok: true, content: 'never', staged: true, scope: 'caller', baseSha: BASE }, { status: 500 })
    await repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'never' })
    state.respond = good
    await repo.execute({ action: 'commit', branch: A, message: 'No retained write' })
    expect(calls.at(-1)?.body).not.toHaveProperty('changes')
  })

  it('bounds branch count and retained bytes without replacing earlier drafts', async () => {
    const { repo } = await mounted()
    for (let i = 0; i < 8; i++) await repo.execute({ action: 'write', branch: `auma/sandbox/branch-${i}`, path: 'server/fix.mjs', content: 'retained' })
    await expect(repo.execute({ action: 'write', branch: 'auma/sandbox/branch-8', path: 'server/fix.mjs', content: 'overflow' })).rejects.toThrow('REPO_DRAFT_LIMIT_EXCEEDED')
    await expect(repo.execute({ action: 'write', branch: 'auma/sandbox/branch-0', path: 'server/fix.mjs', content: 'é'.repeat(262145) })).rejects.toThrow('REPO_SOURCE_FILE_LIMIT_EXCEEDED')
    expect(await repo.execute({ action: 'read', branch: 'auma/sandbox/branch-0', path: 'server/fix.mjs' })).toMatchObject({ content: 'retained' })
  })

  it('reads, stages, edits and commits a core source file larger than 400 KiB', async () => {
    const { repo, calls, state } = await mounted()
    const path = 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts'
    const content = '/*' + 'é'.repeat(204800) + '*/\nconst marker = "old";\n'
    const good = state.respond
    state.respond = body => body.action === 'read' ? Response.json({ ok: true, path, branch: A, content, source: 'github-branch' }) : good(body)
    expect(await repo.execute({ action: 'read', branch: A, path, length: 524288 })).toMatchObject({ content, source: 'github-branch' })
    await repo.execute({ action: 'write', branch: A, path, content })
    expect(await repo.execute({ action: 'read', branch: A, path, length: 524288 })).toMatchObject({ content, source: 'caller-draft' })
    await repo.execute({ action: 'edit', branch: A, path, oldString: '"old"', newString: '"new"' })
    await repo.execute({ action: 'commit', branch: A, message: 'Save large source' })
    expect(calls.at(-1)?.body).toMatchObject({ expectedHeadSha: BASE, changes: [{ path, content: content.replace('"old"', '"new"') }] })
  })

  it('accepts exactly 1 MiB of private draft content and bounds individual files and assembled commits', async () => {
    const { repo, calls } = await mounted()
    const content = 'é'.repeat(262144)
    for (const path of ['server/one.mjs', 'server/two.mjs']) await repo.execute({ action: 'write', branch: A, path, content })
    await expect(repo.execute({ action: 'write', branch: A, path: 'server/three.mjs', content: 'x' })).rejects.toThrow('REPO_DRAFT_LIMIT_EXCEEDED')
    const before = calls.length
    await expect(repo.execute({ action: 'commit', branch: B, message: 'Too large', changes: [
      { path: 'server/one.mjs', content }, { path: 'server/two.mjs', content }, { path: 'server/three.mjs', content: 'x' },
    ] })).rejects.toThrow('REPO_COMMIT_LIMIT_EXCEEDED')
    expect(calls).toHaveLength(before)
    await repo.execute({ action: 'commit', branch: A, message: 'Exactly at limit' })
    expect(calls.at(-1)?.body.changes).toEqual([{ path: 'server/one.mjs', content }, { path: 'server/two.mjs', content }])
  })

  it('bounds escaped request envelopes and cancels oversized streamed responses without replacing drafts', async () => {
    const { repo, calls, state } = await mounted()
    await expect(repo.execute({ action: 'search', query: '\u0000'.repeat(1024 * 1024 + 8192) })).rejects.toThrow('REPO_REQUEST_LIMIT_EXCEEDED')
    expect(calls).toHaveLength(0)
    await repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'retained' })
    let cancelled = false
    state.respond = () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1)) },
      cancel() { cancelled = true },
    }))
    await expect(repo.execute({ action: 'write', branch: A, path: 'server/fix.mjs', content: 'oversized-ack' })).rejects.toThrow('REPO_RESPONSE_LIMIT_EXCEEDED')
    expect(cancelled).toBe(true)
    expect(await repo.execute({ action: 'read', branch: A, path: 'server/fix.mjs' })).toMatchObject({ content: 'retained' })
  })

  it('accepts a broker diff envelope near 8 MiB including duplicated patch and stdout fields', async () => {
    const { repo, state } = await mounted()
    const patch = 'x'.repeat(4 * 1024 * 1024 - 128)
    const response = { ok: true, files: [{ path: 'server/fix.mjs', patch }], stdout: patch }
    expect(new TextEncoder().encode(JSON.stringify(response)).byteLength).toBeLessThanOrEqual(8 * 1024 * 1024)
    state.respond = () => Response.json(response)
    expect(await repo.execute({ action: 'diff', branch: A, base: BASE })).toEqual(response)
  })

  it('recovers from an advanced branch by explicitly discarding stale local drafts, without deleting the branch', async () => {
    const { repo, calls, state } = await mounted()
    let remoteHead = BASE
    state.respond = (body) => {
      if (body.expectedHeadSha !== undefined && body.expectedHeadSha !== remoteHead) return Response.json({ ok: false, code: 'REPO_HEAD_CONFLICT' }, { status: 409 })
      if (body.action === 'commit') { remoteHead = SHA; return Response.json({ ok: true, commitSha: SHA }) }
      if (body.action === 'read') return Response.json({ ok: true, content: 'current remote source', branch: A, headSha: remoteHead })
      return Response.json({ ok: true, content: body.content, staged: true, scope: 'caller', baseSha: remoteHead })
    }
    for (const path of ['server/one.mjs', 'server/two.mjs']) await repo.execute({ action: 'write', branch: A, path, content: path })
    await repo.execute({ action: 'commit', branch: A, message: 'Only one', changes: [{ path: 'server/one.mjs', content: 'server/one.mjs' }] })
    expect(await repo.execute({ action: 'commit', branch: A, message: 'Stale remaining draft' })).toMatchObject({ code: 'REPO_HEAD_CONFLICT' })
    await expect(repo.execute({ action: 'commit', branch: A, expectedHeadSha: SHA, message: 'No silent rebase' })).rejects.toThrow('REPO_DRAFT_BASE_CHANGED')
    const before = calls.length
    expect(await repo.execute({ action: 'draft_discard', branch: A, path: 'server/two.mjs' })).toEqual({ ok: true, action: 'draft_discard', branch: A, scope: 'caller', discardedFiles: 1, remoteChanged: false })
    expect(calls).toHaveLength(before)
    expect(await repo.execute({ action: 'read', branch: A, path: 'server/two.mjs' })).toMatchObject({ content: 'current remote source', headSha: SHA })
    await repo.execute({ action: 'write', branch: A, path: 'server/two.mjs', content: 'restaged against current source', expectedHeadSha: SHA })
    await repo.execute({ action: 'commit', branch: A, message: 'Recovered' })
    expect(calls.at(-1)?.body).toMatchObject({ expectedHeadSha: SHA, changes: [{ path: 'server/two.mjs', content: 'restaged against current source' }] })
    expect(calls.some(call => call.body.action === 'branch_delete')).toBe(false)
  })

  it('discards only an explicitly named private branch and refuses main or omitted branches', async () => {
    const { repo, calls } = await mounted()
    for (const branch of [A, B, 'main']) await repo.execute({ action: 'write', branch, path: 'docs/note.md', content: branch })
    const before = calls.length
    await expect(repo.execute({ action: 'draft_discard', branch: 'main' })).rejects.toThrow('REPO_DRAFT_DISCARD_INVALID')
    await expect(repo.execute({ action: 'draft_discard' })).rejects.toThrow('REPO_DRAFT_DISCARD_INVALID')
    expect(await repo.execute({ action: 'draft_discard', branch: A })).toMatchObject({ discardedFiles: 1, remoteChanged: false })
    expect(calls).toHaveLength(before)
    expect(await repo.execute({ action: 'read', branch: B, path: 'docs/note.md' })).toMatchObject({ content: B, source: 'caller-draft' })
    await repo.execute({ action: 'commit', message: 'Main remains' })
    expect(calls.at(-1)?.body.changes).toEqual([{ path: 'docs/note.md', content: 'main' }])
    await expect(repo.execute({ action: 'draft_discard', branch: '../../main' })).rejects.toThrow('REPO_DRAFT_DISCARD_INVALID')
  })
})
