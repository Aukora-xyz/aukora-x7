/**
 * Lane E4 task 4: stage_proposal is admitted only from `auma/proposal/<slug>`; `auma/sandbox/*`, main and anything else
 * are refused with a typed error before any host request. Synthetic host only.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AUMA_PROPOSAL_BRANCH_RE, AUMA_REPO_BRANCH_FORMS, classifyActionIrreversibility, isAumaProposalBranch, repoBranchFormRefusal } from '../../src/x6/ball-loader.ts'
import { FakeSocket, mountE4, type Call } from './e4-fixture.ts'

afterEach(() => { FakeSocket.instances.length = 0; vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('proposal branch guard', () => {
  it('matches the Sovereignty card\'s AUMA_PROPOSAL_BRANCH exactly', () => {
    expect(AUMA_PROPOSAL_BRANCH_RE.source).toBe('^auma\\/proposal\\/[a-z0-9][a-z0-9._-]{1,60}$')
    for (const ok of ['auma/proposal/receipts-fix', 'auma/proposal/a1', 'auma/proposal/epoch-168.seed_continuity']) expect(isAumaProposalBranch(ok)).toBe(true)
    for (const bad of ['auma/sandbox/receipts-fix', 'main', 'auma/proposal/', 'auma/proposal/x', 'auma/proposal/-lead', 'auma/proposal/Upper',
      'auma/proposal/a/b', 'auma/proposal/' + 'a'.repeat(62), 'refs/heads/auma/proposal/fix', undefined, 7]) expect(isAumaProposalBranch(bad)).toBe(false)
  })

  it('the guard sits in admission itself, so no wrapper path can forward a sandbox proposal', () => {
    // Classification is unchanged (Class 1 owner-session); refusal is a separate typed admission rule.
    expect(classifyActionIrreversibility({ tool: 'x6_repo', action: 'stage_proposal', branch: 'auma/proposal/receipts-fix' })).toBe(1)
  })

  it('x6_repo stage_proposal refuses sandbox and main before any request; proposal branches still reach the host', async () => {
    const { tool, calls } = await mountE4({ respond: (call: Call) => call.path === '/_host/repo' ? Response.json({ ok: true, staged: true }) : null })
    const repo = tool('x6_repo')
    calls.length = 0
    for (const branch of ['auma/sandbox/receipts-fix', 'main', 'feature/x', undefined]) {
      await expect(repo.execute({ action: 'stage_proposal', ...(branch ? { branch } : {}), title: 'Fix' })).rejects.toThrow('REPO_PROPOSAL_BRANCH_REFUSED')
    }
    expect(calls.filter(call => call.path === '/_host/repo')).toEqual([])
    await repo.execute({ action: 'stage_proposal', branch: 'auma/proposal/receipts-fix', title: 'Fix' })
    expect(calls.filter(call => call.path === '/_host/repo').map(call => call.body)).toEqual([
      { action: 'stage_proposal', branch: 'auma/proposal/receipts-fix', title: 'Fix', ownerSession: true }])
  })
})

/**
 * A branch name x6_repo does not accept was refused as PEARL_QUALIFICATION_MISSING_OR_STALE, which sent
 * her hunting a Pearl fault that does not exist. The refusal now names its cause and the allowed forms; the same calls
 * are refused and the same calls reach the host.
 */
describe('x6_repo names the branch rule when the branch is the only reason it refuses', () => {
  const SHA = 'a'.repeat(40)
  it('repoBranchFormRefusal answers only where the branch alone decides', () => {
    expect(AUMA_REPO_BRANCH_FORMS).toBe('auma/sandbox/<slug> or auma/proposal/<slug> (slug: lowercase a-z 0-9 . _ -, 2..61 characters)')
    for (const branch of ['feature/x', 'main', 'auma/sandbox/X', 'auma/other/fix', undefined]) {
      for (const action of ['branch_create', 'branch_delete']) {
        expect(repoBranchFormRefusal({ action, branch })).toMatch(new RegExp(`^REPO_BRANCH_FORM_REFUSED: ${action} is accepted only on auma/sandbox/<slug> or auma/proposal/<slug>`))
      }
      for (const action of ['write', 'edit', 'commit']) {
        expect(repoBranchFormRefusal({ action, branch, expectedHeadSha: SHA })).toMatch(new RegExp(`^REPO_BRANCH_FORM_REFUSED: ${action} with expectedHeadSha`))
        // Without a pin a write to main is an owner-session write the host stages; the branch is not a refusal there.
        expect(repoBranchFormRefusal({ action, branch })).toBeNull()
      }
    }
    expect(repoBranchFormRefusal({ action: 'branch_create', branch: 'feature/x' })).toContain('got "feature/x"')
    expect(repoBranchFormRefusal({ action: 'branch_create' })).toContain('got no branch (main)')
    for (const branch of ['auma/sandbox/fix-1', 'auma/proposal/fix-1']) {
      for (const action of ['branch_create', 'branch_delete', 'write', 'edit', 'commit']) {
        expect(repoBranchFormRefusal({ action, branch })).toBeNull()
        expect(repoBranchFormRefusal({ action, branch, expectedHeadSha: SHA })).toBeNull()
      }
    }
    // idempotencyKey is refused on every branch, so it is not the branch's refusal; other actions are not its business.
    expect(repoBranchFormRefusal({ action: 'commit', branch: 'main', expectedHeadSha: SHA, idempotencyKey: 'k' })).toBeNull()
    expect(repoBranchFormRefusal({ action: 'branch_create', branch: 'main', expectedHeadSha: SHA })).toBeNull()
    for (const action of ['read', 'diff', 'stage_proposal', 'merge_proposal', 'draft_discard']) expect(repoBranchFormRefusal({ action, branch: 'main' })).toBeNull()
  })

  it('the mounted tool refuses the same calls, with the branch rule as code and the allowed forms in the answer', async () => {
    const { tool, calls } = await mountE4({ respond: (call: Call) => call.path === '/_host/repo' ? Response.json({ ok: true, staged: true, scope: 'caller' }) : null })
    const repo = tool('x6_repo')
    calls.length = 0
    const branchRule = [
      { action: 'branch_create', branch: 'feature/x' },
      { action: 'branch_delete', branch: 'main' },
      { action: 'branch_create', branch: 'auma/review/x' },
      { action: 'write', branch: 'main', path: 'docs/a.md', content: 'x', expectedHeadSha: SHA },
      { action: 'edit', branch: 'feature/x', path: 'docs/a.md', oldString: 'a', newString: 'b', expectedHeadSha: SHA },
      { action: 'commit', branch: 'main', message: 'm', expectedHeadSha: SHA },
    ]
    for (const args of branchRule) {
      const refused = await repo.execute(args).then(() => null, (error: unknown) => error as Error & { code?: string; allowed?: string })
      expect(refused, JSON.stringify(args)).not.toBeNull()
      expect(refused!.message).toMatch(/^REPO_BRANCH_FORM_REFUSED: /)
      expect(refused!.message).toContain(AUMA_REPO_BRANCH_FORMS)
      expect(refused!.message).not.toContain('PEARL_QUALIFICATION')
      expect(refused).toMatchObject({ code: 'REPO_BRANCH_FORM_REFUSED', allowed: AUMA_REPO_BRANCH_FORMS })
    }
    // A real qualification fault keeps its own refusal.
    await expect(repo.execute({ action: 'commit', branch: 'auma/sandbox/fix-1', message: 'm', idempotencyKey: 'k-1' }))
      .rejects.toThrow('PEARL_QUALIFICATION_MISSING_OR_STALE')
    expect(calls.filter(call => call.path === '/_host/repo')).toEqual([])
    // Widen nothing: the allowed forms reach the host exactly as before.
    await repo.execute({ action: 'branch_create', branch: 'auma/sandbox/fix-1' })
    await repo.execute({ action: 'branch_delete', branch: 'auma/proposal/fix-1' })
    expect(calls.filter(call => call.path === '/_host/repo').map(call => call.body)).toEqual([
      { action: 'branch_create', branch: 'auma/sandbox/fix-1', ownerSession: true },
      { action: 'branch_delete', branch: 'auma/proposal/fix-1', ownerSession: true },
    ])
  })
})
