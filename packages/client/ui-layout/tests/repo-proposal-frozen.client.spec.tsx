// @vitest-environment jsdom
/**
 * The card's fence: a proposal that changes a frozen path, or changes or deletes a test main already
 * has, gets a problem and no passkey request; a NEW test file does not. The page's copy of the list
 * (spatial/aumlok/frozen-paths.ts) must equal deploy/ci/frozen-paths.mjs, entry for entry and judgement for judgement.
 * Beside wave4-lane-b.client.spec.tsx, which covers repoProposalProblems for .github/ (searched: `git grep repoProposalProblems`).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { RepoProposalCell } from '../src/client/spatial/portal/RepoProposalCell.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import * as page from '../src/client/spatial/aumlok/frozen-paths.ts'
import { class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { parseRepoProposal, repoProposalProblems, type RepoProposal } from '../src/client/spatial/aumlok/repo-proposal.ts'
// @ts-expect-error -- plain ES module with no type declarations; the spec compares its values only.
import * as deploy from '../../../../deploy/ci/frozen-paths.mjs'

const edge = deploy as typeof page

// The default door level is 'open'. The card's tests below pin the GUARDED level: the card reads
// REPO_DOOR_LEVEL from this module, so the module's level is set to 'guarded' here (its judgements keep their own
// default, the real one, which the equality test compares at both levels). The open card has its own tests at the end.
vi.mock('../src/client/spatial/aumlok/frozen-paths.ts', async importOriginal => ({
  ...(await importOriginal<typeof import('../src/client/spatial/aumlok/frozen-paths.ts')>()), REPO_DOOR_LEVEL: 'guarded',
}))
/** The edge's judgement returns { code, next } and takes its twin flag as an option; the page's returns the code only. */
type EdgeRefusal = (path: unknown, status: string, options: { twin: boolean }) => { code: string } | null
const edgeRefusal = (deploy as { proposalPathRefusal: EdgeRefusal }).proposalPathRefusal
const ORIGIN = 'http://localhost:3000'
const mergeBody = { action: 'merge_proposal', baseSha: 'a'.repeat(40), branch: 'auma/proposal/fence-card', headSha: 'b'.repeat(40), treeSha: 'c'.repeat(40) }
const proposalOf = async (changedFiles: readonly Record<string, unknown>[]): Promise<RepoProposal> => parseRepoProposal({
  schema: 'aukora.staged-repo-proposal.v1', branch: mergeBody.branch, title: 'Fence fixture', summary: null,
  baseSha: mergeBody.baseSha, headSha: mergeBody.headSha, treeSha: mergeBody.treeSha, changedFiles, ciStatus: 'passed', stagedAt: 1, mergeBody,
  binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
}) as RepoProposal
const problemsOf = async (changedFiles: readonly Record<string, unknown>[]): Promise<readonly string[]> =>
  (await repoProposalProblems(await proposalOf(changedFiles), ORIGIN)).problems

describe('the page keeps the same frozen list as the edge and CI', () => {
  it('every entry is equal', async () => {
    for (const name of ['FROZEN_DIRECTORIES', 'DECISION_6_FILES', 'FROZEN_FILES', 'FROZEN_ABSENT_FILES', 'FROZEN_ORGAN_IDS', 'FROZEN_ORGAN_FILES', 'FROZEN_TEST_DIRECTORIES',
      'FROZEN_TEST_FILES', 'OPEN_PATHS', 'OPEN_NEW_PATHS', 'CLOSED_INSIDE_OPEN', 'OPEN_INSIDE_CLOSED', 'CLOSED_NAMES', 'CLOSED_SEGMENTS'] as const) {
      expect([...page[name]], name).toEqual([...edge[name]])
    }
    expect(page.FROZEN_ORGAN_IDS).toHaveLength(16)
    // The one level line: the page's copy equals the edge's (read unmocked), and so do the levels kept built.
    const actual = await vi.importActual<typeof page>('../src/client/spatial/aumlok/frozen-paths.ts')
    expect(actual.REPO_DOOR_LEVEL).toBe((deploy as { REPO_DOOR_LEVEL: string }).REPO_DOOR_LEVEL)
    expect(actual.REPO_DOOR_LEVEL).toBe('open')
    expect([...page.REPO_DOOR_LEVELS]).toEqual([...(deploy as { REPO_DOOR_LEVELS: readonly string[] }).REPO_DOOR_LEVELS])
  })

  it('every judgement is equal, odd spellings included', () => {
    const paths = [...edge.FROZEN_FILES, ...edge.FROZEN_ORGAN_FILES, ...edge.FROZEN_TEST_FILES, '.github', '.github/workflows/x.yml', '.GitHub/x', 'deploy/ci', 'deploy/ci/x.mjs',
      'Deploy/CI/x', 'deploy//ci/x', 'deploy/ci./x', 'deploy/ci/x.', 'deploy/%2e%2e/x', 'deploy\\ci\\x', '/deploy/ci/x', './deploy/ci/x', 'deploy/../deploy/ci/x', ' deploy/ci/x',
      'deploy/cid/x', 'deploy/cloudflare/src/fixture.mjs', 'deploy/cloudflare/src/__tests__/old.test.mjs', 'Deploy/Cloudflare/src/__TESTS__/old.test.mjs',
      'packages/experimental/webworker-runtime/tests/x6/other.spec.ts', 'mirror/home/auma/seed/organs/seed-echo.js', 'docs/x.md', '', null, 7,
      // The open list, plain paths and case twins.
      'docs/auma/x.md', 'apps/web/src/a/b.tsx', 'apps/web/src/package.json', 'apps/web/src/vite.config.ts', 'apps/web/src/.env', 'apps/web/src/node_modules/x.js',
      'packages/client/ui-layout/src/x.ts', 'packages/client/ui-layout/tests/new.client.spec.tsx', 'packages/client/ui-layout/tests/helper.ts',
      'packages/experimental/webworker-runtime/src/storage/a.ts', 'packages/experimental/webworker-runtime/src/x6/scion.ts', 'deploy/cloudflare/src/sub/x.mjs',
      'deploy/cloudflare/src/__tests__/zz.test.mjs', 'deploy/cloudflare/src/__tests__/package.json', 'scripts/coverage-exempt.ts', 'server/x.mjs', 'tsconfig.base.json',
      'deploy/cloudflare/src/\u017figned-action.mjs', 'docs/auma/caf\u00e9.md', 'docs/auma/cafe\u0301.md', 'Deploy/cloudflare/src/x.mjs',
      // Review: case variants of closed names, and the judges the frozen files import.
      'packages/client/ui-layout/src/Package.json', 'apps/web/src/TSConfig.json', 'apps/web/src/Node_Modules/x.js', 'packages/experimental/webworker-runtime/src/Storage/a.ts',
      'deploy/cloudflare/src/proof-failure-rule.mjs', 'deploy/cloudflare/src/webauthn-screen.mjs', 'packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx',
      // Closed by default under deploy/ except her three doors; Markdown beside the page packages; agent instruction files.
      'deploy/cloudflare/src/crew-relay-tool.mjs', 'deploy/cloudflare/src/messages-store.mjs', 'deploy/cloudflare/src/world-holder.mjs', 'deploy/cloudflare/src/auma/x.mjs',
      'deploy/cloudflare/src/auma/sub/y.mjs', 'deploy/cloudflare/src/auma/package.json', 'deploy/cloudflare/src/__tests__/auma-x.test.mjs', 'deploy/cloudflare/src/__tests__/aumax.test.mjs',
      'packages/client/ui-layout/README.md', 'packages/client/ui-layout/AGENTS.md', 'packages/client/README.md', 'apps/web/NOTES.md', 'apps/web/tests/README.md',
      'apps/web/public/x/README.md', 'docs/auma/CLAUDE.md',
      // Review: Markdown opened by README name only; every agent instruction file closed by name.
      'apps/web/README.md', 'packages/client/ui-layout/README.zh.md', 'packages/client/ui-layout/AGENTS.override.md', 'packages/client/ui-layout/GEMINI.md',
      'packages/client/ui-layout/CLAUDE.local.md', 'packages/client/ui-layout/src/AGENTS.override.md',
      // Her thread sync files open, the rest of her storage closed (by the folder pattern since the fence).
      'packages/experimental/webworker-runtime/src/storage/thread-writer.ts', 'packages/experimental/webworker-runtime/src/storage/thread-sync.ts',
      'packages/experimental/webworker-runtime/src/storage/thread-sync-plan.ts', 'packages/experimental/webworker-runtime/src/storage/thread-store-types.ts',
      'packages/experimental/webworker-runtime/src/storage/idb-persist.ts', 'packages/experimental/webworker-runtime/src/storage/Memory.ts',
      'packages/experimental/webworker-runtime/src/storage/sub/x.ts', 'packages/experimental/webworker-runtime/src/storage/other.ts',
      // The folder closed by default again, the four open by exact, case-sensitive path.
      'packages/experimental/webworker-runtime/src/storage/brand-new-file.ts', 'packages/experimental/webworker-runtime/src/storage/x/y.ts',
      'packages/experimental/webworker-runtime/src/storage/Thread-Writer.ts', 'packages/experimental/webworker-runtime/src/storage/THREAD-SYNC.TS',
      'packages/experimental/webworker-runtime/src/storage/thread-writer.tsx', 'packages/experimental/webworker-runtime/src/worker-host.ts',
      'packages/experimental/webworker-runtime/src/x6/self-state.ts',
      // Review: a parent-folder case variant of the four.
      'packages/experimental/webworker-runtime/src/Storage/thread-writer.ts', 'packages/experimental/webworker-runtime/src/STORAGE/thread-sync.ts',
      // The judges' imports, the approval cards and the pins, closed by exact path in any case.
      ...['apps/identity/host.ts', 'apps/identity/webauthn.ts', 'aumlok/aumlok-ceremony.ts', 'portal/touch-id-timing.ts', 'portal/OrganSetCell.tsx',
        'portal/NightGrantCell.tsx', 'portal/OutwardApprovalCell.tsx', 'portal/CodeDiffRow.tsx', 'portal/organsetcell.tsx', 'apps/identity/WebAuthn.ts',
        // Independent read of an earlier commit: what those cards and the binding ceremony read.
        'aumlok/outward-class3.ts', 'aumlok/night-grant.ts', 'aumlok/organ-set.ts', 'portal/organ-code-diff.ts', 'aumlok/head-promotion.ts',
        'aumlok/aumlok-root.ts', 'aumlok/AUMLOK-Root.ts', 'aumlok/outward-sent.ts', 'aumlok/binding-bridge.ts']
        .map(name => `packages/client/ui-layout/src/client/spatial/${name}`),
      'packages/experimental/webworker-runtime/src/x6/scion-pins.ts', 'packages/experimental/webworker-runtime/src/x6/voice-organ-pins.ts',
      'packages/experimental/webworker-runtime/src/x6/Scion-Pins.ts', 'packages/client/ui-layout/src/client/spatial/apps/identity/devices.ts']
    // At both door levels, and at each one's default (the real line on both sides).
    paths.push('.env', 'server/.env', 'apps/web/src/.npmrc', 'server/owner-key.mjs', 'mirror/home/auma/private/x.md', 'deploy/cloudflare/src/secret.mjs',
      'apps/web/src/spatial-tokens.css', 'apps/web/node_modules/x.js', 'native/system/x.c', '.github/CODEOWNERS', 'AGENTS.md')
    type LevelRefusal = (path: unknown, status: string, options: { twin: boolean; level?: string }) => { code: string } | null
    const edgeLevelRefusal = deploy as { proposalPathRefusal: LevelRefusal }
    const edgeSecret = (deploy as { isSecretShapedRepoPath: (path: unknown) => boolean }).isSecretShapedRepoPath
    for (const path of paths) {
      expect(page.frozenJudgedForm(path), JSON.stringify(path)).toBe(edge.frozenJudgedForm(path))
      expect(page.isPlainRepoPath(path), JSON.stringify(path)).toBe(edge.isPlainRepoPath(path))
      expect(page.isSecretShapedRepoPath(path), JSON.stringify(path)).toBe(edgeSecret(path))
      expect(page.isFrozenRepoPath(path), JSON.stringify(path)).toBe(edge.isFrozenRepoPath(path))
      expect(page.isFrozenTestPath(path), JSON.stringify(path)).toBe(edge.isFrozenTestPath(path))
      for (const level of ['open', 'guarded'] as const) {
        expect(page.isFrozenRepoPath(path, level), `${JSON.stringify(path)} ${level}`).toBe(edge.isFrozenRepoPath(path, level))
        expect(page.isFrozenTestPath(path, level), `${JSON.stringify(path)} ${level}`).toBe(edge.isFrozenTestPath(path, level))
      }
      for (const status of ['added', 'modified', 'removed'] as const) {
        expect(page.isOpenRepoPath(path, status), `${JSON.stringify(path)} ${status}`).toBe(edge.isOpenRepoPath(path, status))
        for (const level of ['open', 'guarded'] as const) {
          expect(page.isOpenRepoPath(path, status, level), `${JSON.stringify(path)} ${status} ${level}`).toBe(edge.isOpenRepoPath(path, status, level))
        }
        for (const twin of [false, true]) {
          expect(page.proposalPathRefusal(path, status, twin), `${JSON.stringify(path)} ${status} ${String(twin)}`)
            .toBe(edgeRefusal(path, status, { twin })?.code ?? null)
          for (const level of ['open', 'guarded'] as const) {
            expect(page.proposalPathRefusal(path, status, twin, level), `${JSON.stringify(path)} ${status} ${String(twin)} ${level}`)
              .toBe(edgeLevelRefusal.proposalPathRefusal(path, status, { twin, level })?.code ?? null)
          }
        }
      }
    }
    const changed = ['Deploy/x.mjs', 'deploy/cloudflare/src/A.mjs', 'apps/x', 'docs/auma/a.md']
    expect(page.caseTwinPaths(changed, ['deploy/ci/a', 'deploy/cloudflare/src/a.mjs'], ['apps/x'])).toEqual(edge.caseTwinPaths(changed, ['deploy/ci/a', 'deploy/cloudflare/src/a.mjs'], ['apps/x']))
  })
})

describe('a frozen file on the card gives a problem and asks no passkey', () => {
  it('a free change has no problem', async () => {
    expect(await problemsOf([{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }, { path: 'deploy/cloudflare/src/__tests__/auma-her-new.test.mjs', status: 'added' },
      { path: 'mirror/home/auma/seed/organs/seed-echo.js', status: 'modified' }, { path: 'packages/client/ui-layout/README.md', status: 'modified' }])).toEqual([])
    // Any other edge module is outside the paths a proposal may change.
    const closed = await problemsOf([{ path: 'deploy/cloudflare/src/messages-store.mjs', status: 'modified' }])
    expect(closed).toHaveLength(1); expect(closed[0]).toContain('outside the paths a proposal may change')
    // MUST 1b: her own edge folder takes NEW files only; a change to one main has is closed.
    expect(await problemsOf([{ path: 'deploy/cloudflare/src/auma/her-module.mjs', status: 'added' }])).toEqual([])
    for (const status of ['modified', 'removed'] as const) {
      const own = await problemsOf([{ path: 'deploy/cloudflare/src/auma/her-module.mjs', status }])
      expect(own, status).toHaveLength(1); expect(own[0], status).toContain('outside the paths a proposal may change')
    }
  })

  it('the judge, the ledger, the checks, the pins and the decision-6 files: changed, added, deleted or renamed either way', async () => {
    for (const file of [
      { path: 'deploy/ci/frozen-paths.mjs', status: 'modified' },
      { path: 'deploy/ci/new-check.mjs', status: 'added' },
      { path: 'mirror/home/auma/seed/organs/seed-judge.js', status: 'removed' },
      { path: 'mirror/home/auma/seed/receipts.v3.jsonl', status: 'modified' },
      { path: 'mirror/home/auma/HEAD.json', status: 'modified' },
      { path: 'packages/experimental/webworker-runtime/src/x6/ball-loader.ts', status: 'modified' },
      { path: 'packages/experimental/webworker-runtime/src/x6/wasm-cells.ts', status: 'modified' },
      { path: 'packages/experimental/webworker-runtime/src/x6/cell-journal.ts', status: 'modified' },
      { path: 'packages/experimental/webworker-runtime/src/x6/cell-handoff.ts', status: 'modified' },
      { path: 'deploy/cloudflare/src/head-do.mjs', status: 'modified' },
      { path: 'server/scrub.mjs', previousPath: 'server/build-preview.mjs', status: 'renamed' },
      { path: 'deploy/cloudflare/src/worker.mjs', previous_filename: 'deploy/cloudflare/src/old-worker.mjs', status: 'renamed' },
    ]) {
      const problems = await problemsOf([{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }, file])
      expect(problems, JSON.stringify(file)).toHaveLength(1)
      expect(problems[0], JSON.stringify(file)).toContain('only a person with repo write')
      expect(problems[0], JSON.stringify(file)).toContain(file.path)
    }
  })

  it('a case variant of a frozen path is frozen; beside a real folder of the same letters it is a case twin first', async () => {
    const alone = await problemsOf([{ path: 'Deploy/CI/x.mjs', status: 'added' }])
    expect(alone).toHaveLength(1); expect(alone[0]).toContain('only a person with repo write')
    const beside = await problemsOf([{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }, { path: 'Deploy/CI/x.mjs', status: 'added' }])
    expect(beside).toHaveLength(1); expect(beside[0]).toContain('not plain'); expect(beside[0]).toContain('Deploy/CI/x.mjs')
  })

  it('a test main already has: an edit, a delete or a rename out is refused; a NEW test file is not', async () => {
    for (const file of [
      { path: 'deploy/cloudflare/src/__tests__/repo-brokers.test.mjs', status: 'modified' },
      { path: 'deploy/cloudflare/src/__tests__/repo-brokers.test.mjs', status: 'removed' },
      { path: 'packages/experimental/webworker-runtime/tests/x6/large-store-boot.spec.ts', status: 'modified' },
      { path: 'deploy/cloudflare/src/auma/moved.mjs', previousPath: 'deploy/cloudflare/src/__tests__/old.test.mjs', status: 'renamed' },
    ]) expect((await problemsOf([file])).join(' | '), JSON.stringify(file)).toContain('a test main already has')
    expect(await problemsOf([{ path: 'deploy/cloudflare/src/__tests__/auma-her-new.test.mjs', status: 'added' },
      { path: 'packages/experimental/webworker-runtime/tests/x6/her-boot.spec.ts', status: 'added' }])).toEqual([])
  })

  it('a name that is not plain, a case twin and a path outside the open list each give a problem; open paths none', async () => {
    for (const [file, words] of [
      [{ path: 'deploy/cloudflare/src/\u017figned-action.mjs', status: 'added' }, 'not plain'],
      [{ path: 'docs/auma/cafe\u0301.md', status: 'added' }, 'not plain'],
      [{ path: 'server/fixture.mjs', status: 'modified' }, 'outside the paths a proposal may change'],
      [{ path: 'deploy/cloudflare/src/__tests__/test-helper.mjs', status: 'added' }, 'outside the paths a proposal may change'],
      [{ path: 'packages/client/ui-layout/tests/wave4-lane-b.client.spec.tsx', status: 'modified' }, 'outside the paths a proposal may change'],
      [{ path: 'deploy/cloudflare/src/__tests__/package.json', status: 'added' }, 'only a person with repo write'],
      [{ path: 'scripts/coverage-exempt.ts', status: 'modified' }, 'only a person with repo write'],
    ] as const) {
      const problems = await problemsOf([{ path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }, file])
      expect(problems, JSON.stringify(file)).toHaveLength(1)
      expect(problems[0], JSON.stringify(file)).toContain(words)
      expect(problems[0], JSON.stringify(file)).toContain(file.path)
    }
    const twins = await problemsOf([{ path: 'deploy/cloudflare/src/Crew-relay-tool.mjs', status: 'added' }, { path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }])
    expect(twins).toHaveLength(1); expect(twins[0]).toContain('not plain')
    expect(await problemsOf([{ path: 'docs/auma/note.md', status: 'added' }, { path: 'apps/web/src/spatial/x.tsx', status: 'modified' },
      { path: 'packages/client/ui-layout/tests/her-new.client.spec.tsx', status: 'added' }, { path: 'deploy/cloudflare/src/crew-relay-tool.mjs', status: 'modified' }])).toEqual([])
  })

  it('.github/ keeps its own problem, said once', async () => {
    const problems = await problemsOf([{ path: '.github/workflows/x.yml', status: 'added' }])
    expect(problems).toHaveLength(1)
    expect(problems[0]).toContain('under .github/')
  })
})

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

describe('the card itself', () => {
  it('a frozen file: the problem is shown, there is no approve button, and nothing asks the passkey', async () => {
    const proposal = await proposalOf([{ path: 'mirror/home/auma/seed/organs/seed-judge.js', status: 'modified', additions: 1, deletions: 1, t2Protected: true }])
    const calls: string[] = []
    const fetchImpl = (async (url: string) => {
      calls.push(url)
      const body = url === '/_head/promotion-status' ? { ok: true, staged: null, stagedRepoProposal: { schema: 'aukora.staged-repo-proposal.v1', ...proposal } } : { ok: false, code: 'NOT_FOUND' }
      return new Response(JSON.stringify(body), { status: url === '/_head/promotion-status' ? 200 : 404, headers: { 'content-type': 'application/json' } })
    }) as unknown as typeof fetch
    const { container } = render(<RepoProposalCell active round={0} ownerBound fetchImpl={fetchImpl} />)
    await waitFor(() => { expect(container.querySelector('[data-sovereignty-portal="repo-proposal"]')).not.toBeNull() })
    const head = container.querySelector('[data-sovereignty-portal="repo-proposal"] button.ak-portal__head')
    if (head instanceof HTMLButtonElement && head.getAttribute('aria-expanded') !== 'true') fireEvent.click(head)
    await waitFor(() => { expect(container.querySelector('[data-repo-proposal-problems]')?.textContent).toContain('only a person with repo write') })
    expect(container.querySelector('[data-repo-proposal-approve]')).toBeNull()
    expect(container.textContent).toContain('CANNOT MERGE')
    expect(calls.every(url => url === '/_head/promotion-status')).toBe(true)
  })
})

describe('the card at the open door level', () => {
  const openProblems = async (changedFiles: readonly Record<string, unknown>[]): Promise<readonly string[]> =>
    (await repoProposalProblems(await proposalOf(changedFiles), ORIGIN, 'open')).problems

  it('the six the owner named, the workflows and a test main has: no problem, so his passkey is asked', async () => {
    expect(await openProblems([
      { path: 'deploy/cloudflare/src/worker.mjs', status: 'modified', t2Protected: true },
      { path: '.github/workflows/proposal-checks.yml', status: 'modified', t2Protected: true },
      { path: 'deploy/ci/frozen-paths.mjs', status: 'modified', t2Protected: true },
      { path: 'deploy/cloudflare/src/__tests__/repo-brokers.test.mjs', status: 'removed', t2Protected: true },
      { path: 'packages/client/ui-layout/src/client/spatial/portal/RepoProposalCell.tsx', status: 'modified' },
      { path: 'packages/experimental/webworker-runtime/src/storage/idb-persist.ts', status: 'modified' },
      { path: 'server/scrub.mjs', previousPath: 'server/build-preview.mjs', status: 'renamed' },
    ])).toEqual([])
  })

  it('a credential-shaped path, a name that is not plain and a case twin still give a problem; the terms are still checked', async () => {
    const secret = await openProblems([{ path: 'server/.env', status: 'added' }])
    expect(secret).toHaveLength(1); expect(secret[0]).toContain('server/.env'); expect(secret[0]).toContain('credential file')
    const plain = await openProblems([{ path: 'deploy/cloudflare/src/\u017figned-action.mjs', status: 'added' }])
    expect(plain).toHaveLength(1); expect(plain[0]).toContain('not plain')
    const twins = await openProblems([{ path: 'deploy/cloudflare/src/Worker.mjs', status: 'added' }, { path: 'deploy/cloudflare/src/worker.mjs', status: 'modified' }])
    expect(twins).toHaveLength(1); expect(twins[0]).toContain('not plain')
    for (const words of [secret, plain, twins]) expect(words.join(' ')).not.toMatch(/token/iu)
    const proposal = await proposalOf([{ path: 'deploy/cloudflare/src/worker.mjs', status: 'modified' }])
    const wrong = { ...proposal, binding: { ...proposal.binding, bodySha256: 'e'.repeat(64) } }
    expect((await repoProposalProblems(wrong, ORIGIN, 'open')).problems).toEqual(['the passkey terms HEAD recorded are not the hash of the merge request it serves, so nothing is asked'])
  })
})
