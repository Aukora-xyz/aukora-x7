/**
 * Her `x6_repo` action `withdraw_staged_head { ballId }` takes back the head candidate staged for
 * the owner (POST /_head/stage-withdraw, body exactly `{ ballId }`) and returns the edge's answer unchanged. Her review
 * file /dsh/home/auma/staged/head-promotion.json is hers: kept by default, removed only on `removeLocalFile: true` when the
 * edge withdrew that candidate and the file names the same ballId; the answer always says what became of it.
 * Local only: a reserved `.invalid` origin and the e4 fixture's local answers.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { classifyActionIrreversibility, STAGED_HEAD_PROMOTION_PATH } from '../../src/x6/ball-loader.ts'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

type J = Record<string, unknown>
afterEach(() => {
  FakeSocket.instances.length = 0
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const A = 'a'.repeat(64), B = 'b'.repeat(64)
const withdrawn = (ballId: string) => Response.json({ ok: true, withdrawn: true, ballId })

async function mount(answer: (call: Call) => Response) {
  const m = await mountE4({ respond: call => call.method === 'POST' && call.path === '/_head/stage-withdraw' ? answer(call) : null })
  m.calls.length = 0
  return m
}
const reviewFile = (m: Awaited<ReturnType<typeof mountE4>>, ballId: string): string => {
  const text = `${JSON.stringify({ schema: 'aukora.staged-head-promotion.v1', stagedAt: 1, body: { ball: { ballId, epoch: 8 } } }, null, 2)}\n`
  m.vfs.mkdirSync('/dsh/home/auma/staged', { recursive: true })
  m.vfs.writeFileSync(STAGED_HEAD_PROMOTION_PATH, text)
  return text
}
const sent = (calls: Call[]) => calls.filter(call => call.path === '/_head/stage-withdraw')

describe('withdraw_staged_head', () => {
  it('is advertised in the action list and the description, is the reversible class, and needs no fingerprint', async () => {
    const m = await mount(() => withdrawn(A))
    const repo = m.tool('x6_repo')
    expect((repo.parameters.action as { enum: string[] }).enum).toContain('withdraw_staged_head')
    expect(repo.description).toContain('`withdraw_staged_head` (`ballId` of the staged head candidate) takes back the head candidate staged for the owner')
    expect(repo.description).toContain('it publishes nothing and needs no fingerprint')
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'withdraw_staged_head', ballId: A })).toBe(1)
  })

  it('calls the route once with exactly { ballId }, same-origin, no approval, and returns the edge answer unchanged; her file stays by default', async () => {
    const m = await mount(() => withdrawn(A))
    const text = reviewFile(m, A)
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A }) as J
    expect(result).toEqual({ ok: true, withdrawn: true, ballId: A, action: 'withdraw_staged_head',
      localFile: { path: STAGED_HEAD_PROMOTION_PATH, state: 'kept' } })
    const calls = sent(m.calls)
    expect(calls).toHaveLength(1)
    expect(calls[0]!.body).toEqual({ ballId: A })
    expect(calls[0]!.credentials).toBe('same-origin')
    expect(calls[0]!.headers.has('x-x6-class3-approval')).toBe(false)
    expect(m.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(text)
  })

  it('removes her file only on the flag, after the edge withdrew, when the file names that ballId', async () => {
    const m = await mount(() => withdrawn(A))
    reviewFile(m, A)
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A, removeLocalFile: true }) as J
    expect(result).toMatchObject({ ok: true, withdrawn: true, localFile: { path: STAGED_HEAD_PROMOTION_PATH, state: 'removed' } })
    expect(m.vfs.existsSync(STAGED_HEAD_PROMOTION_PATH)).toBe(false)
  })

  it('keeps a file that names another candidate, even on the flag', async () => {
    const m = await mount(() => withdrawn(A))
    const text = reviewFile(m, B)
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A, removeLocalFile: true }) as J
    expect(result.localFile).toEqual({ path: STAGED_HEAD_PROMOTION_PATH, state: 'kept', reason: 'LOCAL_FILE_NAMES_ANOTHER_CANDIDATE' })
    expect(m.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(text)
  })

  it('a refusal comes back with the edge code unchanged and her file stays, flag or not', async () => {
    const m = await mount(() => Response.json({ ok: false, code: 'CANDIDATE_SUPERSEDED', status: 409, stagedBallId: B }, { status: 409 }))
    const text = reviewFile(m, A)
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A, removeLocalFile: true }) as J
    expect(result).toEqual({ ok: false, code: 'CANDIDATE_SUPERSEDED', status: 409, stagedBallId: B, action: 'withdraw_staged_head',
      localFile: { path: STAGED_HEAD_PROMOTION_PATH, state: 'kept', reason: 'NOT_WITHDRAWN_AT_EDGE' } })
    expect(m.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(text)
  })

  it('review B-M1: a candidate HEAD already published is not withdrawn, and her file of it is never removed', async () => {
    const m = await mount(() => Response.json({ ok: false, code: 'ALREADY_PUBLISHED', status: 409, ballId: A }, { status: 409 }))
    const text = reviewFile(m, A)
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A, removeLocalFile: true }) as J
    expect(result).toEqual({ ok: false, code: 'ALREADY_PUBLISHED', status: 409, ballId: A, action: 'withdraw_staged_head',
      localFile: { path: STAGED_HEAD_PROMOTION_PATH, state: 'kept', reason: 'NOT_WITHDRAWN_AT_EDGE' } })
    expect(m.vfs.readFileSync(STAGED_HEAD_PROMOTION_PATH, 'utf8')).toBe(text)
  })

  it('nothing staged at the edge and no file: both said', async () => {
    const m = await mount(() => Response.json({ ok: true, withdrawn: false, staged: null }))
    const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ballId: A }) as J
    expect(result).toEqual({ ok: true, withdrawn: false, staged: null, action: 'withdraw_staged_head',
      localFile: { path: STAGED_HEAD_PROMOTION_PATH, state: 'absent' } })
  })

  it.each([[{}], [{ ballId: 'x' }], [{ ballId: A.toUpperCase() }], [{ ballId: A, removeLocalFile: 'yes' }], [{ ballId: A, extra: 1 }]])(
    'a malformed request %j sends nothing', async (extra) => {
      const m = await mount(() => withdrawn(A))
      const result = await m.tool('x6_repo').execute({ action: 'withdraw_staged_head', ...extra }) as J
      expect(result).toMatchObject({ ok: false, code: 'STAGE_WITHDRAW_INVALID', sent: false })
      expect(sent(m.calls)).toHaveLength(0)
    })
})
