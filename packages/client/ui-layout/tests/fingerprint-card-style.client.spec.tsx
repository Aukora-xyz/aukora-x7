// @vitest-environment jsdom
/**
 * Lane B5: the chat lane's "FINGERPRINT WAITING" card is drawn as a Spatial Portal card. This is its LOOK, pinned by what
 * the page carries: the primitives' classes and the card's own stylesheet on every part, no inline style but the scroll box
 * of an outward value, one gold primary before the quiet Inspect, every `data-fingerprint-*` hook where it was, and a
 * stylesheet that says an opaque surface, a focus ring and no motion. What the card DOES (the passkey, HEAD, the host) is in
 * r29-edge-e2e.client.spec.tsx, through the real Worker.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { base64url } from '../src/client/spatial/apps/identity/webauthn.ts'
import type { AumlokHostCall, AumlokPlatform } from '../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
import { STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA } from '../src/client/spatial/aumlok/outward-class3.ts'
import { FingerprintWaiting, type FingerprintWaitingProps } from '../src/client/spatial/portal/FingerprintWaiting.tsx'
import css from '../src/client/spatial/portal/FingerprintWaiting.module.css'
import { OUTWARD_APPROVES_EXACTLY } from '../src/client/spatial/portal/OutwardApprovalCell.tsx'
import { resetApprovalsForTests } from '../src/client/spatial/portal/touch-id-timing.ts'
import type { FileRead, WorkReader } from '../src/client/spatial/work/WorkSurface.tsx'

class FakeChannel { onmessage = null; close() {} }
class FakeSocket { onopen = null; onmessage = null; onclose = null; close() {} }
beforeEach(() => { vi.stubGlobal('BroadcastChannel', FakeChannel); vi.stubGlobal('WebSocket', FakeSocket) })
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); resetApprovalsForTests() })

const CSS_FILE = 'packages/client/ui-layout/src/client/spatial/portal/FingerprintWaiting.module.css'
const SHEET = ((): string => {
  const path = ['', '../../../'].map(prefix => resolve(process.cwd(), `${prefix}${CSS_FILE}`)).find(existsSync)
  if (path === undefined) throw new Error(`not found: ${CSS_FILE}`)
  return readFileSync(path, 'utf8')
})()
/** The declarations of the one rule whose selector is exactly this. */
const rule = (selector: string): string => {
  const at = SHEET.indexOf(`\n${selector} {`)
  if (at === -1) throw new Error(`no rule: ${selector}`)
  return SHEET.slice(at + selector.length + 3, SHEET.indexOf('}', at))
}

const ORIGIN = 'http://localhost:3000'
const sha = (c: string) => c.repeat(40)
const mergeBody = { action: 'merge_proposal', baseSha: sha('a'), branch: 'auma/proposal/fix-receipts-signer-policy', headSha: sha('b'), treeSha: sha('c') }
/** A repo proposal exactly as HEAD's contract says it, with the passkey terms of its own merge request: the card offers it. */
const proposalValue = async () => ({
  schema: 'aukora.staged-repo-proposal.v1', branch: mergeBody.branch, title: 'Enforce the checkpoint signer policy', summary: 'Ports the fixture rule.',
  baseSha: sha('a'), headSha: sha('b'), treeSha: sha('c'),
  changedFiles: [{ path: 'server/aura.test.mjs', status: 'modified', additions: 3, deletions: 0, t2Protected: false }],
  ciStatus: 'passed', stagedAt: Date.UTC(2026, 10, 11, 4), mergeBody,
  binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
})
const statusBody = (stagedRepoProposal: unknown) => ({ ok: true, ballId: 'd'.repeat(64), epoch: 167, staged: null, supersededStaged: null,
  stagedRepoProposal, lastPublishOutcome: null, peers: [] })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/**
 * HEAD as the card reads it: `/_head/promotion-status` holds the merge proposal until the host merges it. The host's answer
 * to the approved merge is the test's own (`merge`); every other route is absent.
 */
const headWithMerge = async (merge: () => Response = () => json({ ok: false, code: 'NOT_FOUND' }, 404)) => {
  let staged: unknown = await proposalValue()
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    if (url === '/_head/promotion-status') return json(statusBody(staged))
    if (url === '/_host/repo' && init?.method === 'POST') {
      const answer = merge()
      if (answer.ok) staged = null
      return answer
    }
    return json({ ok: false, code: 'NOT_FOUND' }, 404)
  }) as unknown as typeof fetch
  return fetchImpl
}
/** A host with no promotion route (the Mac): the card reads her home alone. */
const noHead = (async () => json({ ok: false, code: 'NOT_FOUND' }, 404)) as unknown as typeof fetch

const PASSKEY: Awaited<ReturnType<AumlokPlatform['passkey']>> = { id: 'Y3JlZGVudGlhbC1pZC0wMQ', rawId: 'Y3JlZGVudGlhbC1pZC0wMQ', type: 'public-key',
  authenticatorAttachment: 'platform', response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null },
  clientExtensionResults: {} }
const platformOf = (blocker: string | null): AumlokPlatform =>
  ({ passkeyBlocker: () => blocker, passkey: async () => PASSKEY, nodeKeys: async () => true })
/** The host's two passkey routes, answering as a bound host does: the challenge echoes the binding, the approval carries it. */
const approvingCall: AumlokHostCall = async (route, _signal, body) => {
  if (route === '/_host/aumlok/challenge') {
    return { kind: 'live', route, body: { ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-0001', purpose: 'approve',
      intentHash: 'f'.repeat(64), binding: body?.binding, publicKey: { challenge: base64url(new Uint8Array(32).fill(6)), rpId: 'localhost',
        userVerification: 'required', allowCredentials: [{ type: 'public-key', id: PASSKEY.id }] } } }
  }
  return { kind: 'live', route, body: { ok: true, phase: 'BOUND', bound: true, approvalToken: base64url(new Uint8Array(32).fill(9)),
    expiresAt: 1_800_000_000_000, binding: await class3Action({ audience: ORIGIN, method: 'POST', pathname: '/_host/repo', body: mergeBody }),
    lastVerifiedAt: 1_799_999_900_000 } }
}

/** Her staged GitHub issue with a long text, as her worker stages it. */
const LONG_TEXT = Array.from({ length: 60 }, (_, index) => `Line ${String(index + 1)} of her issue, kept whole.`).join('\n')
const outwardFile = JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: Date.UTC(2026, 10, 11, 5), tool: 'x6_github', method: 'POST',
  pathname: '/_host/github', body: { action: 'api', method: 'POST', endpoint: 'repos/your_org_x/your-node/issues',
    body: { title: 'Lane B5: the card as a Portal card', body: LONG_TEXT } } })
const homeWithOutward: WorkReader = {
  whole: async (_session: unknown, path: string): Promise<FileRead> =>
    (path === STAGED_OUTWARD_PATH ? { ok: true, text: outwardFile } : { ok: false, reason: 'not-found' }),
}

const mount = (props: Partial<FingerprintWaitingProps> & { readonly fetchImpl: typeof fetch }) => {
  const openSovereignty = vi.fn()
  const view = render(<FingerprintWaiting openSovereignty={openSovereignty} {...props} />)
  const card = () => view.container.querySelector<HTMLElement>('[data-fingerprint-waiting]')
  const part = (hook: string) => card()?.querySelector<HTMLElement>(`[data-fingerprint-${hook}]`) ?? null
  return { ...view, openSovereignty, card, part, kind: () => card()?.getAttribute('data-fingerprint-waiting') }
}
const classes = (element: Element | null | undefined): string[] => [...(element?.classList ?? [])]
/** Whether `first` comes before `second` in the page. */
const before = (first: Element | null, second: Element | null): boolean => first !== null && second !== null
  && (first.compareDocumentPosition(second) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0

describe('Lane B5: the Fingerprint card is a Spatial Portal card', () => {
  it('a waiting merge: the gold portal frame, ONE gold primary before the quiet Inspect, no inline style anywhere', async () => {
    const chat = mount({ fetchImpl: await headWithMerge() })
    await waitFor(() => { expect(chat.kind()).toBe('merge') })
    const card = chat.card() as HTMLElement
    // THE CARD: the primitives' portal frame in the gold tone, placed and made opaque by its own stylesheet.
    expect(card.tagName).toBe('ASIDE')
    expect(card.getAttribute('aria-label')).toBe('Fingerprint waiting')
    expect(classes(card)).toEqual(['ak-portal', 'ak-tone-gold', css.card])
    expect(card.hasAttribute('style')).toBe(false)
    // THE TWO BUTTONS: real buttons, the primitives' action pill; the approval is the one primary, and it comes first.
    const approve = chat.part('approve') as HTMLButtonElement
    const inspect = chat.part('inspect') as HTMLButtonElement
    expect([approve.tagName, approve.type, approve.textContent]).toEqual(['BUTTON', 'button', 'Approve with Touch ID'])
    expect([inspect.tagName, inspect.type, inspect.textContent]).toEqual(['BUTTON', 'button', 'Inspect in Sovereignty'])
    expect(classes(approve)).toEqual(['ak-action', css.primary])
    expect(classes(inspect)).toEqual(['ak-action', css.secondary])
    expect(approve.hasAttribute('style') || inspect.hasAttribute('style')).toBe(false)
    expect(card.querySelectorAll(`.${String(css.primary)}`).length).toBe(1)
    expect(before(approve, inspect)).toBe(true)
    expect(approve.parentElement).toBe(inspect.parentElement)
    expect(classes(approve.parentElement)).toEqual(['ak-actionrow', css.actions])
    // The head: the tile, the eyebrow, and a quiet × that is a real, named button.
    const head = card.firstElementChild as HTMLElement
    expect(classes(head)).toEqual([css.head])
    expect(head.querySelector('.ak-icon-tile svg')).not.toBeNull()
    expect(classes(head.querySelector('strong'))).toEqual([css.eyebrow])
    expect(head.querySelector('strong')?.textContent).toBe('FINGERPRINT WAITING')
    const dismiss = chat.part('dismiss') as HTMLButtonElement
    expect([dismiss.tagName, dismiss.type, dismiss.getAttribute('aria-label'), dismiss.textContent]).toEqual(['BUTTON', 'button', 'Hide for now', '×'])
    expect(classes(dismiss)).toEqual([css.dismiss])
    expect(dismiss.parentElement).toBe(head)
    // One thing waits: no count.
    expect(chat.part('count')).toBeNull()
    // What waits, as the card's title line, above the buttons.
    const line = chat.part('line') as HTMLElement
    expect(line.textContent).toBe(`Merge ${mergeBody.branch} → main · CI green`)
    expect(classes(line)).toEqual([css.line])
    expect(before(line, approve)).toBe(true)
    // NOTHING IS STYLED INLINE: every colour and spacing is the stylesheet's.
    expect(card.querySelectorAll('[style]').length).toBe(0)
    // Inspect still opens Sovereignty; × still hides the card.
    fireEvent.click(inspect)
    expect(chat.openSovereignty).toHaveBeenCalledTimes(1)
    fireEvent.click(dismiss)
    expect(chat.card()).toBeNull()
  })

  it('outcome lines are toned by state: blue while working, red refused, gold unclear, mint done; each keeps its hook and place', async () => {
    const outcomeOf = (chat: ReturnType<typeof mount>) => chat.part('outcome') as HTMLElement
    // WORKING, then REFUSED: the host's challenge is held open, then refuses.
    let answer: (value: Awaited<ReturnType<AumlokHostCall>>) => void = () => {}
    const held: AumlokHostCall = () => new Promise((done) => { answer = done })
    const refusing = mount({ fetchImpl: await headWithMerge(), ceremony: { call: held, platform: platformOf(null) } })
    await waitFor(() => { expect(refusing.kind()).toBe('merge') })
    fireEvent.click(refusing.part('approve') as HTMLButtonElement)
    await waitFor(() => { expect(outcomeOf(refusing)?.getAttribute('data-fingerprint-outcome')).toBe('working') })
    const working = outcomeOf(refusing)
    expect(working.textContent).toBe('Waiting for Touch ID…')
    expect([working.getAttribute('role'), working.hasAttribute('data-fingerprint-settled'), working.hasAttribute('style')]).toEqual(['status', false, false])
    expect(classes(working)).toEqual(['ak-quote', 'ak-tone-blue', css.outcome])
    // While it works: the button waits, there is no ×, and the working line is below the buttons.
    expect((refusing.part('approve') as HTMLButtonElement).disabled).toBe(true)
    expect(refusing.part('dismiss')).toBeNull()
    expect(before(refusing.part('inspect'), working)).toBe(true)
    answer({ kind: 'refused', route: '/_host/aumlok/challenge', status: 403, code: 'AUMLOK_NOT_BOUND', message: 'not bound' })
    await waitFor(() => { expect(outcomeOf(refusing)?.getAttribute('data-fingerprint-outcome')).toBe('refused') })
    const refused = outcomeOf(refusing)
    expect(refused.textContent).toBe('Not approved: class3:AUMLOK_NOT_BOUND')
    expect([refused.getAttribute('role'), refused.hasAttribute('data-fingerprint-settled'), refused.hasAttribute('style')]).toEqual(['status', true, false])
    expect(classes(refused)).toEqual(['ak-quote', 'ak-tone-red', css.outcome])
    // The settled outcome is above the item's line, the line above the buttons, the approval before Inspect.
    expect(before(refused, refusing.part('line'))).toBe(true)
    expect(before(refusing.part('line'), refusing.part('approve'))).toBe(true)
    expect(before(refusing.part('approve'), refusing.part('inspect'))).toBe(true)
    expect(refusing.card()?.querySelectorAll('[style]').length).toBe(0)
    refusing.unmount()
    resetApprovalsForTests()

    // UNCLEAR: the host's challenge route fails outright.
    const failing: AumlokHostCall = async () => { throw new Error('offline') }
    const unclear = mount({ fetchImpl: await headWithMerge(), ceremony: { call: failing, platform: platformOf(null) } })
    await waitFor(() => { expect(unclear.kind()).toBe('merge') })
    fireEvent.click(unclear.part('approve') as HTMLButtonElement)
    await waitFor(() => { expect(outcomeOf(unclear)?.getAttribute('data-fingerprint-outcome')).toBe('unclear') })
    expect(outcomeOf(unclear).textContent).toBe('No clear answer (offline). Check Sovereignty.')
    expect(classes(outcomeOf(unclear))).toEqual(['ak-quote', 'ak-tone-gold', css.outcome])
    unclear.unmount()
    resetApprovalsForTests()

    // DONE: the passkey approves, and the host says main is at the approved head.
    const done = mount({ fetchImpl: await headWithMerge(() => json({ ok: true, commitSha: mergeBody.headSha })),
      ceremony: { call: approvingCall, platform: platformOf(null) } })
    await waitFor(() => { expect(done.kind()).toBe('merge') })
    fireEvent.click(done.part('approve') as HTMLButtonElement)
    await waitFor(() => { expect(outcomeOf(done)?.getAttribute('data-fingerprint-outcome')).toBe('done') })
    expect(outcomeOf(done).textContent).toBe(`Merged: main is now ${mergeBody.headSha.slice(0, 12)} (${mergeBody.branch}).`)
    expect(classes(outcomeOf(done))).toEqual(['ak-quote', 'ak-tone-mint', css.outcome])
    // Nothing waits now: the card is the outcome alone, with Inspect and no approval.
    await waitFor(() => { expect(done.kind()).toBe('outcome') })
    expect(done.part('approve')).toBeNull()
    expect(classes(done.part('inspect'))).toEqual(['ak-action', css.secondary])
  })

  it('her outward request: a field list with every byte, each value its own scroll box; two waiting is a pill', async () => {
    // HEAD holds the merge and her home holds her request: two wait, and the merge is shown first.
    const both = mount({ fetchImpl: await headWithMerge(), reader: homeWithOutward, sessionId: 's1' as SessionId })
    await waitFor(() => { expect(both.card()?.textContent).toContain('· 2 waiting') })
    expect(both.kind()).toBe('merge')
    const count = both.part('count') as HTMLElement
    expect(count.textContent).toBe('· 2 waiting')
    expect(classes(count)).toEqual([css.count])
    expect(count.parentElement).toBe(both.card()?.firstElementChild)
    const pill = count.querySelector('.ak-pill') as HTMLElement
    expect(classes(pill)).toEqual(['ak-pill', 'ak-tone-gold'])
    expect(pill.textContent).toBe('2 waiting')
    expect(both.card()?.querySelectorAll('[style]').length).toBe(0)
    both.unmount()

    const chat = mount({ fetchImpl: noHead, reader: homeWithOutward, sessionId: 's1' as SessionId })
    await waitFor(() => { expect(chat.kind()).toBe('outward') })
    expect(chat.part('line')?.textContent).toBe('GitHub: a new issue in your_org_x/your-node')
    const rows = chat.part('outward-rows') as HTMLElement
    expect(classes(rows)).toEqual([css.rows])
    // The words over the rows, then the primitives' field table.
    expect([rows.firstElementChild?.tagName, rows.firstElementChild?.className, rows.firstElementChild?.textContent])
      .toEqual(['P', 'ak-lead', OUTWARD_APPROVES_EXACTLY])
    const table = rows.querySelector('dl') as HTMLElement
    expect(classes(table)).toEqual(['ak-fields', css.fields])
    const fields = [...rows.querySelectorAll<HTMLElement>('[data-fingerprint-outward-row]')]
    expect(fields.map(field => field.getAttribute('data-fingerprint-outward-row'))).toEqual(['posts', 'title', 'text', 'request'])
    for (const field of fields) {
      // One row is one name and one value, together under the table.
      expect(field.parentElement).toBe(table)
      expect(classes(field)).toEqual([css.field])
      expect([...field.children].map(child => child.tagName)).toEqual(['DT', 'DD'])
      expect(field.querySelector('dt')?.textContent).toBe(field.getAttribute('data-fingerprint-outward-row'))
      const value = field.querySelector('dd') as HTMLElement
      expect(value.hasAttribute('data-fingerprint-outward-value')).toBe(true)
      expect(classes(value)).toEqual([css.value])
      // THE SCROLL BOX, and nothing else, is on the element: past 180px it scrolls, line breaks kept.
      expect(value.getAttribute('style')).toBe('max-height: 180px; overflow: auto; white-space: pre-wrap;')
    }
    // NOTHING IS CUT: the whole long text is in its box.
    expect(rows.querySelector('[data-fingerprint-outward-row="text"] [data-fingerprint-outward-value]')?.textContent).toBe(LONG_TEXT)
    expect(rows.querySelector('[data-fingerprint-outward-row="title"] [data-fingerprint-outward-value]')?.textContent)
      .toBe('Lane B5: the card as a Portal card')
    // Only those boxes carry a style; the rows are above the one gold button, which says it sends.
    expect([...(chat.card()?.querySelectorAll('[style]') ?? [])].every(element => element.hasAttribute('data-fingerprint-outward-value'))).toBe(true)
    const approve = chat.part('approve') as HTMLButtonElement
    expect(approve.textContent).toBe('Approve with Touch ID and Send')
    expect(classes(approve)).toEqual(['ak-action', css.primary])
    expect(before(chat.part('line'), rows) && before(rows, approve) && before(approve, chat.part('inspect'))).toBe(true)
  })

  it('the stylesheet: an opaque surface at the top of the thread stack, a gold primary, a focus ring, and nothing that moves', () => {
    // Every class the card carries is a rule in the file.
    for (const name of ['card', 'head', 'eyebrow', 'count', 'sep', 'dismiss', 'line', 'outcome', 'rows', 'fields', 'field', 'value', 'actions',
      'primary', 'secondary']) {
      expect(css[name], name).toBeTruthy()
      expect(SHEET, name).toMatch(new RegExp(`\\.${name}[ :,.\\[{>]`, 'u'))
    }
    // THE CARD'S RULE outweighs `.ak-portal:hover` (two classes): it names the element and its hook.
    const card = rule('aside.card[data-fingerprint-waiting]')
    // Where it was: absolute at the top of the thread stack, over the lane's corner controls; 12px down unless the compact
    // frame sets its corner clearance (then below the corner band: spatial-header-flow.client.spec.tsx).
    for (const declaration of ['position: absolute;', 'top: var(--dsh-compact-corner-clearance, 12px);', 'left: 12px;', 'right: 12px;', 'z-index: 40;']) {
      expect(card).toContain(declaration)
    }
    // OPAQUE: a solid colour (three channels, no alpha), and nothing that lets the chat through.
    expect(card).toMatch(/background-color: rgb\(\d+, \d+, \d+\);/u)
    expect(card).not.toMatch(/opacity|backdrop-filter|background(-color)?: (transparent|rgba|none)/u)
    // The open portal's ring, in the card's tone.
    expect(card).toContain('border-color: color-mix(in srgb, var(--ak-tone, var(--ak-gold)) 70%, transparent);')
    // It never runs past the lane: it scrolls inside itself.
    expect(card).toContain('max-height: calc(100% - var(--dsh-compact-corner-clearance, 12px) - 12px);')
    expect(card).toContain('overflow-y: auto;')
    // ONE GOLD PRIMARY: filled with the tone, dark words on it; the secondary is a hairline pill.
    expect(rule('.card .primary')).toContain('background: var(--ak-tone, var(--ak-gold));')
    expect(rule('.card .primary')).toMatch(/\n {2}color: rgb\(\d+, \d+, \d+\);/u)
    expect(rule('.card .secondary')).toContain('border-color: var(--ak-hairline); background: transparent;')
    expect(SHEET).not.toMatch(/\.secondary[^{]*\{[^}]*background: var\(--ak-(tone|gold)/u)
    // KEYBOARD: every control shows a ring when the keyboard reaches it.
    const focus = rule('.card .primary:focus-visible, .card .secondary:focus-visible, .card .dismiss:focus-visible, .card .value:focus-visible')
    expect(focus).toContain('outline: 2px solid var(--ak-tone, var(--ak-gold));')
    expect(focus).toContain('outline-offset: 3px;')
    expect(SHEET).not.toMatch(/outline: (none|0)/u)
    // An outcome is toned through the tone its class sets.
    expect(rule('.card .outcome')).toContain('var(--ak-tone, var(--ak-muted))')
    // REDUCED MOTION: nothing is animated at all, and the hover easing stops.
    expect(SHEET).not.toMatch(/animation|@keyframes|[^-]transform:/u)
    const still = /@media \(prefers-reduced-motion: reduce\) \{\s*([^{}]*) \{ transition: none; \}/u.exec(SHEET)?.[1]
    expect(still).toBe('.card .dismiss, .card .primary, .card .secondary')
  })
})
