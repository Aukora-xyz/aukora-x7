/** x6_repo `apply_patch`, the tool half. Every host response is local; no provider or owner approval is exercised.
 * The mount harness is repo-actions.spec.ts's (a spec exports nothing, so it is repeated here). */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, mountX6BallRuntime, repoBranchFormRefusal, STAGED_OUTWARD_PATH, type BallManifest } from '../../src/x6/ball-loader.ts'
import { WorkerModuleLoader } from '../../src/module-system/module-loader.ts'
import { MemoryVfs } from '../../src/storage/memory.ts'
import { voiceVerdict, VOICE_SWITCH_TABLE } from '../../src/x6/voice-read-only.ts'
import { draftHunk } from '../../src/x6/repo-echo.ts'

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
    // An edge answer without `changes` (this one) is kept whole and says the facts were not available.
    expect(await repo.execute(args)).toEqual({ ok: true, action: 'apply_patch', branch: A, head: SHA, files: [{ path: 'docs/auma/a.md', status: 'modified' }], echo: 'file', echoNote: 'facts_unavailable' })
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

// ---- HANDS block begin: a branch edit answers with the facts and the hunk, not the whole file ----
describe('x6_repo branch writes answer with the hunk, not the whole file', () => {
  const FILE = 'x'.repeat(37 * 1024) + '\nold line\n'
  const NEW = 'x'.repeat(37 * 1024) + '\nnew line\n'
  const CHANGES = [{ path: 'docs/auma/a.md', status: 'modified', oldBlobSha: 'c'.repeat(40), newBlobSha: 'd'.repeat(40), oldBytes: FILE.length, newBytes: NEW.length,
    linesAdded: 1, linesRemoved: 1, hunk: '--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ -1,2 +1,2 @@\n xx\n-old line\n+new line\n', hunkOmittedBytes: 0 }]
  const staged = (body: Args) => Response.json({ ok: true, action: body.action, branch: A, path: 'docs/auma/a.md', content: NEW, baseSha: BASE,
    bytesWritten: NEW.length, staged: true, scope: 'caller', changes: CHANGES })

  it('says in its description what an edit returns, and offers echo with three closed values', async () => {
    const { repo } = await mounted()
    expect(repo.description).toContain('instead of the whole file')
    expect((repo.parameters.echo as { enum: string[] }).enum).toEqual(['hunk', 'file', 'none'])
  })

  it('by default keeps the whole file as her draft but answers with the facts and the hunk; echo never reaches the edge', async () => {
    const { repo, calls, state } = await mounted()
    state.respond = staged
    const answer = await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'old line', newString: 'new line' }) as Args
    expect(answer).toEqual({ ok: true, action: 'edit', branch: A, path: 'docs/auma/a.md', baseSha: BASE, bytesWritten: NEW.length, staged: true, scope: 'caller', echo: 'hunk', changes: CHANGES })
    expect(JSON.stringify(answer).length).toBeLessThan(1024)
    expect(await repo.execute({ action: 'read', branch: A, path: 'docs/auma/a.md' })).toMatchObject({ content: NEW, source: 'caller-draft' })
    await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'new line', newString: 'third line', echo: 'none' })
    expect(calls.map(call => Object.hasOwn(call.body, 'echo'))).toEqual([false, false])
  })

  it('echo "file" answers exactly as before; echo "none" keeps only the facts', async () => {
    const { repo, state } = await mounted()
    state.respond = staged
    const { changes: _changes, ...before } = await staged({ action: 'edit' }).json() as Args
    expect(await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'old line', newString: 'new line', echo: 'file' })).toEqual(before)
    state.respond = body => Response.json({ ok: true, action: body.action, branch: A, commit: SHA, commitSha: SHA, headSha: SHA, paths: ['docs/auma/a.md'], stdout: SHA, stderr: '', changes: CHANGES })
    const facts = CHANGES.map(({ hunk: _hunk, hunkOmittedBytes: _omitted, ...rest }) => rest)
    expect(await repo.execute({ action: 'commit', branch: A, message: 'm', changes: [{ path: 'docs/auma/a.md', content: NEW }], echo: 'none' }))
      .toEqual({ ok: true, action: 'commit', branch: A, commit: SHA, commitSha: SHA, headSha: SHA, paths: ['docs/auma/a.md'], stdout: SHA, stderr: '', changes: facts })
  })

  it('refuses an unknown echo with a closed code before anything is sent; a refusal from the edge is untouched', async () => {
    const { repo, calls, state } = await mounted()
    for (const echo of ['diff', true, 1, null, 'HUNK']) {
      expect(await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'a', newString: 'b', echo }))
        .toEqual({ ok: false, code: 'REPO_ECHO_INVALID', sent: false, allowed: ['hunk', 'file', 'none'] })
    }
    expect(calls).toHaveLength(0)
    state.respond = () => Response.json({ ok: false, code: 'REPO_EDIT_TARGET_NOT_FOUND', content: 'kept as sent' }, { status: 409 })
    await expect(Promise.resolve(repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'a', newString: 'b' })).catch((error: unknown) => ({ thrown: String(error) })))
      .resolves.not.toHaveProperty('echo')
  })
})

describe('an old edge keeps the whole file; a draft edit shows the edit she just made', () => {
  const FILE = 'one\ntwo\nthree\nfour\nfive\nsix\nseven\neight\nnine\nten\n'
  const head = (body: Args) => ({ path: 'docs/auma/a.md', status: 'modified', oldBlobSha: 'c'.repeat(40), newBlobSha: 'd'.repeat(40), oldBytes: FILE.length,
    newBytes: typeof body.content === 'string' ? body.content.length : 0, linesAdded: 9, linesRemoved: 9, hunk: '--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ from the branch head @@\n', hunkOmittedBytes: 0 })

  it('old edge (no changes) + new tab: the staged edit answers exactly as before plus echo "file" and the closed note; the draft is kept', async () => {
    const { repo, state } = await mounted()
    const answerOf = (body: Args): Args => ({ ok: true, action: body.action, branch: A, path: 'docs/auma/a.md', content: 'edited\n', baseSha: BASE, bytesWritten: 7, staged: true, scope: 'caller' })
    state.respond = body => Response.json(answerOf(body))
    for (const echo of [undefined, 'hunk', 'none']) {
      expect(await repo.execute({ action: 'edit', branch: B, path: 'docs/auma/a.md', oldString: 'x', newString: 'y', ...(echo ? { echo } : {}) }))
        .toEqual({ ...answerOf({ action: 'edit' }), echo: 'file', echoNote: 'facts_unavailable' })
      await repo.execute({ action: 'draft_discard', branch: B })
    }
    expect(await repo.execute({ action: 'edit', branch: B, path: 'docs/auma/a.md', oldString: 'x', newString: 'y', echo: 'file' })).toEqual(answerOf({ action: 'edit' }))
    expect(await repo.execute({ action: 'read', branch: B, path: 'docs/auma/a.md' })).toMatchObject({ content: 'edited\n', source: 'caller-draft' })
  })

  it('new edge + echo "file" (the old-shaped call): the whole file, no changes', async () => {
    const { repo, state } = await mounted()
    state.respond = body => Response.json({ ok: true, action: body.action, branch: A, path: 'docs/auma/a.md', content: body.content ?? FILE, baseSha: BASE, bytesWritten: 1, staged: true, scope: 'caller', changes: [head(body)] })
    expect(await repo.execute({ action: 'write', branch: A, path: 'docs/auma/a.md', content: FILE, echo: 'file' }))
      .toEqual({ ok: true, action: 'write', branch: A, path: 'docs/auma/a.md', content: FILE, baseSha: BASE, bytesWritten: 1, staged: true, scope: 'caller' })
  })

  it('with her previous draft held, the hunk is the edit she just made (hunkFrom "draft"); the facts stay the edge\'s; no draft keeps the edge hunk', async () => {
    const { repo, state } = await mounted()
    state.respond = body => Response.json({ ok: true, action: body.action, branch: A, path: 'docs/auma/a.md', content: body.content ?? FILE, baseSha: BASE, bytesWritten: 1, staged: true, scope: 'caller', changes: [head(body)] })
    const first = await repo.execute({ action: 'write', branch: A, path: 'docs/auma/a.md', content: FILE }) as { changes: Args[] }
    expect(first.changes[0]).toEqual(head({ content: FILE }))
    const second = await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'nine\n', newString: 'NINE\n' }) as { changes: Args[] }
    const after = FILE.replace('nine\n', 'NINE\n')
    expect(second.changes[0]).toEqual({ ...head({ content: after }), hunk: draftHunk(FILE, after, 'docs/auma/a.md'), hunkOmittedBytes: 0, hunkFrom: 'draft' })
    expect(second.changes[0]?.hunk).toBe('--- a/docs/auma/a.md\n+++ b/docs/auma/a.md\n@@ -6,5 +6,5 @@\n six\n seven\n eight\n-nine\n+NINE\n ten\n')
    const dashes = await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'NINE\n', newString: '----BEGIN RSA PRIVATE KEY-----\n' }) as { changes: Args[] }
    expect(dashes.changes[0]?.hunk).toContain('+----BEGIN RSA PRIVATE KEY-----\n')
    // Removing that line puts a `-` marker in front of four dashes: a key header the screen would refuse.
    const pem = await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: '----BEGIN RSA PRIVATE KEY-----\n', newString: 'nine\n' }) as { changes: Args[] }
    expect(pem.changes[0]).toMatchObject({ hunk: null, hunkReason: 'withheld', hunkFrom: 'draft' })
    const none = await repo.execute({ action: 'edit', branch: A, path: 'docs/auma/a.md', oldString: 'ten\n', newString: 'TEN\n', echo: 'none' }) as { changes: Args[] }
    expect(Object.keys(none.changes[0] ?? {}).filter(key => key.startsWith('hunk'))).toEqual([])
    expect(none.changes[0]).toMatchObject({ newBlobSha: 'd'.repeat(40), linesAdded: 9 })
  })
})
// ---- HANDS block end ----
