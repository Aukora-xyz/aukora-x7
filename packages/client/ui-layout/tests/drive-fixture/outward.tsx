// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (c) 2026 The Aukora authors
/**
 * HER CLOUDFLARE ASKS ON THE OWNER'S CARD, FOR A REVIEWER'S EYES. `?outward=<name>` on the drive fixture page
 * puts ONE made-up staged Cloudflare request in her made-up home, and the page shows the REAL card
 * (`OutwardApprovalCell`, its real primitives and stylesheets, in the Sovereignty portal's "Waiting for your Touch ID"
 * grid, inside the real Spatial frame) through the real read and parse path (`readStagedOutward`, `parseStagedOutward`).
 *
 * The approve control runs the real approval code (`approveAndSendOutward`: the binding, the passkey step, the send) against
 * fakes that call nothing: the host's two passkey routes and the passkey sheet are stand-ins that echo the binding, and the
 * page's fetch for the send is a recorder that answers as the edge would. No passkey prompt, no network. Every id, host
 * and name is made up (zone `0123…`, host `home.example.org`).
 *
 * The `lin-*` names put ONE made-up held Linear core write (`x6_linear`, `/_host/linear`, no reason object)
 * in her home instead, for the same real card.
 *
 * The rest of the Sovereignty surface (HEAD, keys, receipts) needs a live host and is not mounted here.
 * @module drive-fixture/outward
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { canonicalJson, type Class3Action } from '../../src/client/spatial/aumlok/class3-approval.ts'
import type { AumlokHostCall, AumlokPlatform } from '../../src/client/spatial/aumlok/aumlok-ceremony.ts'
import { STAGED_OUTWARD_PATH, STAGED_OUTWARD_SCHEMA } from '../../src/client/spatial/aumlok/outward-class3.ts'
import { base64url } from '../../src/client/spatial/apps/identity/webauthn.ts'
import { OutwardApprovalCell } from '../../src/client/spatial/portal/OutwardApprovalCell.tsx'
import { AppHeader, AppSurface, FieldTable, Lead, PortalGrid, SectionLabel } from '../../src/client/spatial/primitives/index.ts'
import type { FileRead, WorkReader } from '../../src/client/spatial/work/WorkSurface.tsx'

const ZONE = '0123456789abcdef0123456789abcdef'
const RECORD = '89abcdef0123456789abcdef01234567'
const MODULE_CHARS = 60_000

/** A 60,000-character module, made up: plain lines of a Worker that answers one fixed text. */
function longModule(): string {
  const head = 'export default { fetch() { return new Response(LINES.join("\\n")) } }\nconst LINES = [\n'
  const line = '  "a made-up line of the fixture module, nothing in it is real",\n'
  const tail = ']\n'
  let body = ''
  while (head.length + body.length + line.length + tail.length <= MODULE_CHARS) body += line
  const text = head + body + tail
  return text + ' '.repeat(MODULE_CHARS - text.length)
}

/** One made-up ask: her staged request, the reason the edge gave, and how the fake edge answers the approved send. */
export interface OutwardFixtureAsk {
  /** Which door; Cloudflare when absent. */
  readonly door?: 'cloudflare' | 'linear'
  readonly body: Record<string, unknown>
  /** Cloudflare only: why the edge held it. A Linear ask has none (the action names the reason). */
  readonly protection?: Record<string, unknown>
  /** `sent`: the edge did it. `reason-changed`: the edge's own reason now differs. */
  readonly answer: 'sent' | 'reason-changed'
}

const LIN = 'made-up-request-0001'
/** Her held Linear writes, one per kind of core action, and the longest names the edge allows. */
const LINEAR_FIXTURES: Readonly<Record<string, OutwardFixtureAsk>> = {
  'lin-issue-delete': { door: 'linear', answer: 'sent', body: { action: 'issue_delete', requestId: LIN, id: 'YOURTEAM-123' } },
  'lin-issue-archive': { door: 'linear', answer: 'sent', body: { action: 'issue_archive', requestId: LIN, id: 'YOURTEAM-124' } },
  'lin-project-archive': { door: 'linear', answer: 'sent', body: { action: 'project_archive', requestId: LIN, id: 'made-up-project-0001' } },
  'lin-team-member-remove': { door: 'linear', answer: 'sent', body: { action: 'team_member_remove', requestId: LIN, id: 'made-up-membership-0001' } },
  'lin-issue-move': { door: 'linear', answer: 'sent', body: { action: 'issue_update', requestId: LIN, id: 'YOURTEAM-125', teamId: 'made-up-team-0002' } },
  'lin-long': { door: 'linear', answer: 'sent', body: { action: 'team_settings', requestId: 'r'.repeat(64), id: 'M' + 'a'.repeat(63),
    name: `Made-up team name ${'n'.repeat(238)}`, description: `A made-up team description. ${'d'.repeat(4068)}`, key: 'MADEUPKEYZ', private: true } },
}

/** The fifteen names the page takes as `?outward=<name>`: nine Cloudflare asks and six Linear ones. */
export const OUTWARD_FIXTURES: Readonly<Record<string, OutwardFixtureAsk>> = {
  'cf-dns': { answer: 'sent', protection: { family: 'P1', reason: 'live-zone' },
    body: { action: 'api', method: 'PATCH', path: `/zones/${ZONE}/dns_records/${RECORD}`,
      body: { type: 'A', name: 'home.example.org', content: '192.0.2.10', proxied: true, ttl: 1 } } },
  'cf-switch': { answer: 'sent', protection: { family: 'P1', reason: 'account-switch' },
    body: { action: 'api', method: 'POST', path: '/accounts/{account}/rulesets',
      body: { kind: 'custom', name: 'made-up rules', phase: 'http_request_firewall_custom',
        rules: [{ action: 'block', expression: '(ip.src eq 192.0.2.1)', description: 'made-up rule' }] } } },
  'cf-storage': { answer: 'sent', protection: { family: 'P1', reason: 'bound-storage' },
    body: { action: 'api', method: 'DELETE', path: '/accounts/{account}/r2/buckets/home-example-archive' } },
  'cf-secret': { answer: 'sent', protection: { family: 'P2', reason: 'app-secret' },
    body: { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/home-example/secrets',
      body: { name: 'MADE_UP_SIGNING_SECRET', text: 'made-up-fixture-value', type: 'secret_text' } } },
  'cf-zone-delete': { answer: 'sent', protection: { family: 'P3', reason: 'zone-deletion' },
    body: { action: 'api', method: 'DELETE', path: `/zones/${ZONE}` } },
  'cf-charge': { answer: 'sent', protection: { family: 'P4', reason: 'registrar-renewal', also: [{ family: 'P1', reason: 'live-domain' }] },
    body: { action: 'api', method: 'PUT', path: '/accounts/{account}/registrar/domains/example.org', body: { auto_renew: true } } },
  'cf-unresolved': { answer: 'sent', protection: { family: 'P1', reason: 'live-facts-unresolved' },
    body: { action: 'api', method: 'PATCH', path: '/accounts/{account}/workers/scripts/home-example/script-settings',
      body: { logpush: true } } },
  'cf-long': { answer: 'sent', protection: { family: 'P1', reason: 'live-worker' },
    body: { action: 'api', method: 'PUT', path: '/accounts/{account}/workers/scripts/home-example', bodyKind: 'multipart', parts: [
      { name: 'metadata', contentType: 'application/json', json: { main_module: 'worker.js', compatibility_date: '2026-11-01' } },
      { name: 'worker.js', filename: 'worker.js', contentType: 'application/javascript+module', text: longModule() },
    ] } },
  'cf-changed': { answer: 'reason-changed', protection: { family: 'P1', reason: 'live-zone' },
    body: { action: 'api', method: 'PATCH', path: `/zones/${ZONE}/settings/ssl`, body: { value: 'full' } } },
  ...LINEAR_FIXTURES,
}

/** The staged file her worker would write for an ask (compact JSON, as `stageOutward` writes it). */
export function stagedFileOf(ask: OutwardFixtureAsk, stagedAt = 1_762_940_000_000): string {
  if (ask.door === 'linear') {
    return JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt, tool: 'x6_linear', method: 'POST', pathname: '/_host/linear', body: ask.body })
  }
  return JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt, tool: 'x6_cloudflare', method: 'POST', pathname: '/_host/cloudflare',
    body: ask.body, protection: ask.protection })
}

/** What the approve control handed the fakes: each binding the passkey was asked for, and each send. */
export interface OutwardRecord {
  readonly bindings: Class3Action[]
  readonly sends: Array<{ readonly url: string; readonly method: string; readonly text: string; readonly canonical: string }>
}

/** One page's run of one ask: the reader of her home, the fakes, and their record. */
export interface OutwardRun {
  readonly name: string
  readonly ask: OutwardFixtureAsk
  readonly reader: WorkReader
  readonly sessionId: SessionId
  readonly ceremony: { readonly call: AumlokHostCall; readonly platform: AumlokPlatform }
  readonly fetchImpl: typeof fetch
  readonly record: OutwardRecord
  /** Told after each thing the fakes record (the page shows the record). */
  readonly onRecord: (listener: () => void) => () => void
}

const PASSKEY: Awaited<ReturnType<AumlokPlatform['passkey']>> = { id: 'Zml4dHVyZS1wYXNza2V5', rawId: 'Zml4dHVyZS1wYXNza2V5',
  type: 'public-key', authenticatorAttachment: 'platform',
  response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA', userHandle: null }, clientExtensionResults: {} }

/**
 * Make the run for one name.
 * @param name - one of `OUTWARD_FIXTURES`.
 * @returns the run, or null for a name that is not one.
 */
export function outwardRunOf(name: string): OutwardRun | null {
  const ask = Object.hasOwn(OUTWARD_FIXTURES, name) ? OUTWARD_FIXTURES[name] : undefined
  if (ask === undefined) return null
  const file = stagedFileOf(ask)
  const record: OutwardRecord = { bindings: [], sends: [] }
  const listeners = new Set<() => void>()
  const told = (): void => { for (const listener of [...listeners]) listener() }
  // Her home, as this window's reader gives it: the one staged file, nothing else.
  const reader: WorkReader = {
    whole: async (_session, path): Promise<FileRead> => (path === STAGED_OUTWARD_PATH ? { ok: true, text: file } : { ok: false, reason: 'not-found' }),
  }
  // The host's two passkey routes, as a bound host answers: the challenge echoes the binding, the approval carries it.
  let binding: unknown = null
  const call: AumlokHostCall = async (route, _signal, sent) => {
    if (route === '/_host/aumlok/challenge') {
      binding = sent?.binding
      record.bindings.push(binding as Class3Action)
      told()
      return { kind: 'live', route, body: { ok: true, phase: 'PENDING_ASSERTION', challengeId: 'approve-fixture-0001', purpose: 'approve',
        binding, publicKey: { challenge: base64url(new Uint8Array(32).fill(6)), rpId: 'localhost', userVerification: 'required',
          allowCredentials: [{ type: 'public-key', id: PASSKEY.id }] } } }
    }
    return { kind: 'live', route, body: { ok: true, phase: 'BOUND', bound: true, approvalToken: base64url(new Uint8Array(32).fill(9)),
      expiresAt: 1_800_000_000_000, binding, lastVerifiedAt: 1_799_999_900_000 } }
  }
  const platform: AumlokPlatform = { passkeyBlocker: () => null, passkey: async () => PASSKEY, nodeKeys: async () => true }
  // The send: recorded, never made. The fake edge answers as the real one does for this ask.
  const fetchImpl: typeof fetch = async (resource, init) => {
    const text = typeof init?.body === 'string' ? init.body : ''
    let canonical = ''
    try { canonical = canonicalJson(JSON.parse(text)) } catch { canonical = '' }
    const url = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url
    record.sends.push({ url, method: init?.method ?? 'GET', text, canonical })
    told()
    if (ask.answer === 'reason-changed') {
      return Response.json({ ok: false, code: 'CLOUDFLARE_REASON_CHANGED', protection: { family: 'P2', reason: 'app-secret' } }, { status: 409 })
    }
    // The Linear door's answer to an approved core write (linear-door.mjs), with made-up ids.
    if (ask.door === 'linear') {
      return Response.json({ ok: true, action: ask.body.action, level: 'open', requestId: ask.body.requestId, result: {}, approved: 'made-up' })
    }
    const method = typeof ask.body.method === 'string' ? ask.body.method : ''
    return Response.json({ ok: true, action: 'api', method, path: ask.body.path, status: 200, success: true, result: { id: 'made-up-result' } })
  }
  return {
    name, ask, reader, sessionId: 'made-up-session' as SessionId, ceremony: { call, platform }, fetchImpl, record,
    onRecord: (listener) => { listeners.add(listener); return () => { listeners.delete(listener) } },
  }
}

/**
 * The Sovereignty portal's "Waiting for your Touch ID" grid with the real outward card in it, over one run. `cf-changed`
 * approves once by itself when the card is ready, so the page opens on the card after the edge answered.
 */
export function OutwardPortal({ run }: { readonly run: OutwardRun }): ReactNode {
  const [, setSeen] = useState(0)
  useEffect(() => run.onRecord(() => { setSeen(n => n + 1) }), [run])
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (run.ask.answer !== 'reason-changed') return
    let done = false
    const timer = setInterval(() => {
      const button = root.current?.querySelector<HTMLButtonElement>('[data-outward-approve]')
      if (done || button == null || button.disabled) return
      done = true
      clearInterval(timer)
      button.click()
    }, 50)
    return () => { clearInterval(timer) }
  }, [run])
  const sends = run.record.sends
  return (
    <div ref={root} data-outward-fixture={run.name} style={{ height: '100%' }}>
      <AppSurface active data-sovereignty-surface="">
        <AppHeader eyebrow="Everything the system governs" title="Sovereignty" tone="blue"
          badges={[{ text: 'FIXTURE · MADE-UP REQUEST', tone: 'muted', title: 'Nothing on this page is real, and nothing leaves it' }]} />
        <section data-sovereignty-waiting="">
          <SectionLabel>Waiting for your Touch ID</SectionLabel>
          <PortalGrid open>
            <OutwardApprovalCell active round={0} reader={run.reader} sessionId={run.sessionId} ownerBound
              ceremony={run.ceremony} fetchImpl={run.fetchImpl} />
          </PortalGrid>
        </section>
        <section data-outward-fixture-record="">
          <SectionLabel>Fixture only: what the approve control handed the stand-in edge</SectionLabel>
          {sends.length === 0
            ? <Lead>Nothing yet. Approving here asks no passkey and sends nothing: a stand-in records it.</Lead>
            : (
              <FieldTable rows={sends.map((send, index) => [`send ${String(index + 1)} (${send.method} ${send.url})`,
                <span key={String(index)} data-outward-fixture-send="" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                  {send.canonical.length > 2000 ? `${send.canonical.slice(0, 2000)}… (${String(send.canonical.length)} characters in all)` : send.canonical}
                </span>] as const)} />
            )}
        </section>
      </AppSurface>
    </div>
  )
}
