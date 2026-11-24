/**
 * Her held Linear core write on the owner's card. The card reads exactly the door's core (each action with
 * exactly its edge fields, judged by the edge's own rules), says what it does in one plain sentence, shows every byte that
 * leaves, and the bytes his passkey approves are the bytes the real Linear door (deploy/cloudflare/src/linear-door.mjs)
 * receives, binds (with the edge's own binding function, aumlok.mjs aumlokClass3Binding) and sends once. Linear, the passkey
 * and HEAD are local stand-ins; nothing real is called.
 */
import { describe, expect, it, vi } from 'vitest'
import { canonicalJson, type Class3Action } from '../src/client/spatial/aumlok/class3-approval.ts'
// @ts-expect-error The edge door is plain ESM without declarations; its action table and door are read here.
import * as untypedDoor from '../../../../deploy/cloudflare/src/linear-door.mjs'
// @ts-expect-error The edge's AUMLOK store is plain ESM; only its Class 3 binding function is used here.
import * as untypedAumlok from '../../../../deploy/cloudflare/src/aumlok.mjs'

// The passkey ceremony itself (approveClass3) is stood in for, as outward-cloudflare.client.spec.ts does; HEAD's store is
// modelled below (an approval covers one exact binding and is spent once: aumlok.mjs approvalFor). Everything else is real.
const approvals: Class3Action[] = []
let nextToken = 0
vi.mock('../src/client/spatial/aumlok/class3-approval.ts', async (original) => {
  const real = await original<typeof import('../src/client/spatial/aumlok/class3-approval.ts')>()
  return { ...real, approveClass3: async (action: Class3Action) => {
    approvals.push(action)
    nextToken += 1
    return { ok: true, token: `stand-in-approval-${String(nextToken)}`, expiresAt: Date.now() + 60_000, action, hostRemainingMs: 60_000, receivedAt: 0 }
  } }
})
const {
  approveAndSendOutward, LINEAR_CARD_ACTIONS, LINEAR_REQUEST_ID, linearWords, outwardMaybeSent, outwardWords, parseStagedOutward,
  STAGED_OUTWARD_SCHEMA,
} = await import('../src/client/spatial/aumlok/outward-class3.ts')

interface EdgeAction {
  kind: string
  fields: Record<string, (value: unknown) => boolean>
  required: string[]
  atLeastOne?: string[]
  core?: (input: Record<string, unknown>) => string | null
}
type LinearDoorHandle = (request: Request, env: object, options: object) => Promise<Response>
interface Door {
  LINEAR_ACTIONS: Record<string, EdgeAction>
  LINEAR_CORE: readonly string[]
  createLinearDoor: (options: { fetchImpl: typeof fetch; now?: () => number }) => LinearDoorHandle
}
const { LINEAR_ACTIONS, LINEAR_CORE, createLinearDoor } = untypedDoor as Door
const { aumlokClass3Binding } = untypedAumlok as { aumlokClass3Binding: (input: object) => Promise<Record<string, unknown>> }

const file = (body: unknown, more: Record<string, unknown> = {}) => JSON.stringify({ schema: STAGED_OUTWARD_SCHEMA, stagedAt: 1,
  tool: 'x6_linear', method: 'POST', pathname: '/_host/linear', body, ...more })
const RID = 'made-up-request-0001'
const UUID1 = '11111111-1111-4111-8111-111111111111'

/** One held write per core action, with the sentence the card says for it. */
const CORE: ReadonlyArray<readonly [Record<string, unknown>, string, string]> = [
  [{ action: 'issue_archive', requestId: RID, id: 'YOURTEAM-123' }, 'Archive issue YOURTEAM-123 in Linear.', 'Linear: archive issue YOURTEAM-123'],
  [{ action: 'issue_delete', requestId: RID, id: 'YOURTEAM-123' }, 'Delete issue YOURTEAM-123 from Linear. This cannot be undone.', 'Linear: delete issue YOURTEAM-123'],
  [{ action: 'document_delete', requestId: RID, id: 'doc-made-up-1' }, 'Delete document doc-made-up-1 from Linear. This cannot be undone.',
    'Linear: delete document doc-made-up-1'],
  [{ action: 'project_archive', requestId: RID, id: 'project-made-up-1' }, 'Archive project project-made-up-1 in Linear.', 'Linear: archive project project-made-up-1'],
  [{ action: 'project_delete', requestId: RID, id: 'project-made-up-1' }, 'Delete project project-made-up-1 from Linear. This cannot be undone.',
    'Linear: delete project project-made-up-1'],
  [{ action: 'team_delete', requestId: RID, id: UUID1 }, `Delete team ${UUID1} from Linear. This cannot be undone.`, `Linear: delete team ${UUID1}`],
  [{ action: 'project_settings', requestId: RID, id: 'project-made-up-1', name: 'New name', leadId: null, targetDate: '2026-12-01' },
    'Change project project-made-up-1\'s settings: lead, name and target date.', 'Linear: change project project-made-up-1\'s settings'],
  [{ action: 'team_settings', requestId: RID, id: 'team-made-up-1', private: true }, 'Change team team-made-up-1\'s settings: privacy.',
    'Linear: change team team-made-up-1\'s settings'],
  [{ action: 'team_member_add', requestId: RID, teamId: 'team-made-up-1', userId: 'user-made-up-1' }, 'Add person user-made-up-1 to team team-made-up-1.',
    'Linear: add person user-made-up-1 to team team-made-up-1'],
  [{ action: 'team_member_remove', requestId: RID, id: 'membership-made-up-1' }, 'Remove a person from a team in Linear: membership membership-made-up-1.',
    'Linear: remove membership membership-made-up-1'],
  [{ action: 'issue_update', requestId: RID, id: 'YOURTEAM-123', teamId: 'team-made-up-2' }, 'Move issue YOURTEAM-123 to team team-made-up-2.',
    'Linear: move issue YOURTEAM-123 to team team-made-up-2'],
  [{ action: 'issue_update', requestId: RID, id: 'YOURTEAM-123', teamId: 'team-made-up-2', title: 'Kept title', priority: 2 },
    'Move issue YOURTEAM-123 to team team-made-up-2. It also changes its priority and title.', 'Linear: move issue YOURTEAM-123 to team team-made-up-2'],
]

describe('her held Linear write on the owner\'s card', () => {
  it('reads every core action and says it in one plain sentence, a deletion always saying it cannot be undone', () => {
    for (const [body, sentence, summary] of CORE) {
      const staged = parseStagedOutward(file(body))
      expect(staged, JSON.stringify(body)).not.toBeNull()
      expect(staged).toMatchObject({ tool: 'x6_linear', pathname: '/_host/linear', method: 'POST', body, approved: body, canonical: canonicalJson(body) })
      expect(staged?.protection).toBeUndefined()
      const words = outwardWords(staged!)
      expect([words.summary, words.rows[0]]).toEqual([summary, ['does', sentence]])
      if (String(body.action).endsWith('_delete')) expect(sentence.endsWith(' This cannot be undone.')).toBe(true)
      expect(sentence).not.toMatch(/token/iu)
    }
    // Every action the card reads has a sentence of its own.
    for (const action of Object.keys(LINEAR_CARD_ACTIONS)) expect(linearWords({ action, id: 'x' }).sentence).not.toContain('does not know')
  })

  it('shows every field that leaves as a row, in the order of the bytes approved, and the request\'s size', () => {
    const body = { action: 'project_settings', requestId: RID, id: 'project-made-up-1', name: 'New name', memberIds: ['user-a', 'user-b'],
      description: 'Line one\nline two', leadId: null }
    const staged = parseStagedOutward(file(body))!
    expect(outwardWords(staged).rows).toEqual([
      ['does', 'Change project project-made-up-1\'s settings: description, lead, members and name.'],
      ['action', 'project_settings'],
      ['requestId', RID],
      ['description', 'Line one\nline two'],
      ['id', 'project-made-up-1'],
      ['leadId', 'null'],
      ['memberIds', '[\n  "user-a",\n  "user-b"\n]'],
      ['name', 'New name'],
      ['request', `POST /_host/linear · ${String(new TextEncoder().encode(canonicalJson(body)).byteLength)} bytes`],
    ])
    expect(outwardMaybeSent(staged)).toBe('It may have gone out: check Linear before approving it again.')
  })

  it('the longest allowed names are shown whole in the rows, and the sentence stays bounded', () => {
    const id = 'A' + 'b'.repeat(63), name = 'N'.repeat(256), description = 'd'.repeat(4096)
    const staged = parseStagedOutward(file({ action: 'team_settings', requestId: 'r'.repeat(64), id, name, description, key: 'ABCDEFGHIJ' }))!
    const rows = new Map(outwardWords(staged).rows)
    expect([rows.get('name'), rows.get('description'), rows.get('id'), rows.get('requestId')]).toEqual([name, description, id, 'r'.repeat(64)])
    expect(rows.get('does')).toBe(`Change team ${id}'s settings: description, key and name.`)
    expect(rows.get('does')!.length).toBeLessThan(160)
  })

  it('offers nothing else: an open write, a read, an unknown action, a bad requestId, an extra key, a value the edge refuses', () => {
    const bad: unknown[] = [
      { action: 'comment', requestId: RID, issue: 'YOURTEAM-1', body: 'x' }, { action: 'issue_create', requestId: RID, teamId: 't', title: 'x' },
      { action: 'issue_update', requestId: RID, id: 'YOURTEAM-1', title: 'not a move' }, { action: 'label_create', requestId: RID, name: 'x' },
      { action: 'teams' }, { action: 'issue', id: 'YOURTEAM-1', requestId: RID }, { action: 'graphql', requestId: RID, query: '{ viewer { id } }' },
      { action: 'workspace_settings', requestId: RID }, { action: 'made_up', requestId: RID, id: 'x' },
      { action: 'issue_delete', id: 'YOURTEAM-1' }, { action: 'issue_delete', requestId: 'short-1', id: 'YOURTEAM-1' },
      { action: 'issue_delete', requestId: 'r'.repeat(65), id: 'YOURTEAM-1' }, { action: 'issue_delete', requestId: 'has space in it 0001', id: 'YOURTEAM-1' },
      { action: 'issue_delete', requestId: RID, id: 'YOURTEAM-1', extra: 1 }, { action: 'issue_delete', requestId: RID, id: 'YOURTEAM-1', query: 'x' },
      { action: 'issue_delete', requestId: RID }, { action: 'issue_delete', requestId: RID, id: 'A' + 'b'.repeat(64) },
      { action: 'issue_delete', requestId: RID, id: '-starts-with-dash' }, { action: 'issue_delete', requestId: RID, id: 7 },
      { action: 'team_settings', requestId: RID, id: 't', name: 'N'.repeat(257) }, { action: 'team_settings', requestId: RID, id: 't' },
      { action: 'team_settings', requestId: RID, id: 't', name: 'two\nlines' }, { action: 'team_settings', requestId: RID, id: 't', key: 'lower' },
      { action: 'team_settings', requestId: RID, id: 't', description: 'd'.repeat(4097) },
      { action: 'project_settings', requestId: RID, id: 'p', memberIds: ['a', 'a'] }, { action: 'project_settings', requestId: RID, id: 'p', startDate: '2026-13-45' },
      { action: 'team_member_add', requestId: RID, teamId: 't' }, { action: 'issue_update', requestId: RID, id: 'YOURTEAM-1', teamId: 't', priority: 9 },
      JSON.parse(`{ "action": "issue_delete", "requestId": "${RID}", "id": "YOURTEAM-1", "__proto__": { "x": 1 } }`) as unknown,
    ]
    for (const body of bad) expect(parseStagedOutward(file(body)), JSON.stringify(body)).toBeNull()
    const ok = { action: 'issue_delete', requestId: RID, id: 'YOURTEAM-1' }
    expect(parseStagedOutward(file(ok))).not.toBeNull()
    // The wrong door, the wrong tool, a reason field: not offered either.
    expect(parseStagedOutward(file(ok, { pathname: '/_host/cloudflare' }))).toBeNull()
    expect(parseStagedOutward(file(ok, { tool: 'x6_github' }))).toBeNull()
    expect(parseStagedOutward(file(ok, { protection: { family: 'P3', reason: 'zone-deletion' } }))).toBeNull()
    expect(parseStagedOutward(file(ok, { method: 'DELETE' }))).toBeNull()
  })

  it('parity with the edge: the same core, the same fields, the same rules (fails when linear-door.mjs drifts)', () => {
    const card = Object.keys(LINEAR_CARD_ACTIONS)
    expect(card.filter(name => name !== 'issue_update').sort()).toEqual([...LINEAR_CORE].sort())
    // issue_update is core only as a move: the edge's own rule says so.
    expect([LINEAR_ACTIONS.issue_update?.core?.({ teamId: 't' }), LINEAR_ACTIONS.issue_update?.core?.({ title: 'x' })]).toEqual(['team-move', null])
    expect(String(LINEAR_REQUEST_ID)).toBe('/^[A-Za-z0-9_-]{16,64}$/u')
    const samples: unknown[] = [undefined, null, true, false, 0, 2, 4, 5, -1, 1.5, '', ' ', 'x', 'YOURTEAM-123', 'aum', 'YOURTEAM', 'ABCDEFGHIJK', 'A_B',
      'a'.repeat(64), 'a'.repeat(65), '-x', 'x y', 'x\ny', 'x\r', 'x\u0000', '2026-12-01', '2026-02-30', '2026-13-01', '26-1-1', UUID1,
      'N'.repeat(256), 'N'.repeat(257), 'N'.repeat(512), 'N'.repeat(513), 'd'.repeat(4096), 'd'.repeat(4097), 'd'.repeat(61_440), 'd'.repeat(61_441),
      [], ['a'], ['a', 'a'], ['a', 'b'], Array.from({ length: 25 }, (_, i) => `id-${String(i)}`), Array.from({ length: 26 }, (_, i) => `id-${String(i)}`),
      [7], {}, { id: 'x' }]
    for (const name of card) {
      const edge = LINEAR_ACTIONS[name]!, mine = LINEAR_CARD_ACTIONS[name]!
      expect([name, edge.kind]).toEqual([name, 'write'])
      expect([name, Object.keys(mine.fields).sort()]).toEqual([name, Object.keys(edge.fields).sort()])
      expect([name, [...mine.required].sort()]).toEqual([name, [...edge.required].sort()])
      expect([name, [...(mine.atLeastOne ?? [])].sort()]).toEqual([name, [...(edge.atLeastOne ?? [])].sort()])
      for (const field of Object.keys(edge.fields)) {
        for (const sample of samples) {
          expect([name, field, sample, mine.fields[field]!(sample)]).toEqual([name, field, sample, edge.fields[field]!(sample)])
        }
      }
    }
  })
})

// ---- the bytes he approves are the bytes the real door binds and sends once ------------------------------------------
const ORIGIN = 'https://linear-card.example.invalid'
const ENV = { OWNER_EMAIL: 'owner@example.invalid', LINEAR_API_KEY: 'made-up-linear-key-for-the-card-spec-01', LINEAR_DOOR_LEVEL: 'open' }
const ACCESS = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600, session: 'made-up-session' }

/** HEAD's approvals, as aumlok.mjs approvalFor keeps them: one exact binding per approval, spent once, refused otherwise. */
function headStandIn() {
  const issued = new Map<string, { binding: string; consumed: boolean }>()
  return {
    issue: (token: string, action: Class3Action) => { issued.set(token, { binding: canonicalJson(action), consumed: false }) },
    consume: (token: string | null, binding: Record<string, unknown>) => {
      const approval = token === null ? undefined : issued.get(token)
      if (approval === undefined || approval.consumed || approval.binding !== canonicalJson(binding)) {
        throw Object.assign(new Error('CLASS3_WEBAUTHN_REQUIRED'), { code: 'CLASS3_WEBAUTHN_REQUIRED', status: 403 })
      }
      approval.consumed = true
      return { ok: true, binding: JSON.parse(approval.binding) as unknown, expiresAt: Date.now() + 60_000 }
    },
  }
}

/** One isolate's door, behind a page fetch that posts to it as the browser would; Linear is a recorder. */
function edge(head: ReturnType<typeof headStandIn>, tamper: (text: string) => string = text => text) {
  const linear: Array<{ query: string; variables: unknown }> = []
  const door = createLinearDoor({ fetchImpl: (async (_url: unknown, init: { body: string }) => {
    const sent = JSON.parse(init.body) as { query: string; variables: unknown }
    linear.push(sent)
    return Response.json({ data: { issueDelete: { success: true }, teamMembershipDelete: { success: true } } })
  }) as unknown as typeof fetch })
  const answers: Array<{ status: number; body: Record<string, unknown> }> = []
  const fetchImpl: typeof fetch = async (resource, init) => {
    const headers = new Headers(init?.headers)
    const path = typeof resource === 'string' ? resource : resource instanceof URL ? resource.href : resource.url
    const request = new Request(new URL(path, ORIGIN), { method: init?.method ?? 'GET',
      body: tamper(typeof init?.body === 'string' ? init.body : ''),
      headers: { 'content-type': headers.get('content-type') ?? '', origin: ORIGIN, 'sec-fetch-site': 'same-origin',
        'x-x6-class3-approval': headers.get('x-x6-class3-approval') ?? '' } })
    // The Worker's edgeClass3: HEAD consumes the approval for the binding the edge computes from the body it holds.
    const authorizeClass3 = async (input: unknown) => head.consume(request.headers.get('x-x6-class3-approval'),
      await aumlokClass3Binding({ audience: new URL(request.url).origin, method: request.method, pathname: new URL(request.url).pathname,
        body: input }))
    const response = await door(request, ENV, { access: ACCESS, authorizeClass3 })
    const answer = { status: response.status, body: await response.clone().json() as Record<string, unknown> }
    answers.push(answer)
    return response
  }
  return { fetchImpl, linear, answers }
}

describe('the approved Linear write at the real door', () => {
  it('is held with nothing sent; his approval of the card\'s bytes is the binding the edge computes; it is sent once', async () => {
    const head = headStandIn()
    const body = { action: 'issue_delete', requestId: 'made-up-request-chain-01', id: UUID1 }
    const { fetchImpl, linear, answers } = edge(head)
    // Held: her own POST, without an approval, sends nothing to Linear.
    const held = await fetchImpl('/_host/linear', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    expect([held.status, (await held.json() as Record<string, unknown>).code]).toEqual([403, 'CLASS3_WEBAUTHN_REQUIRED'])
    expect(linear).toEqual([])
    // His approval: issued for exactly the binding the card asked for, then sent by the card.
    const staged = parseStagedOutward(file(body))!
    let token = ''
    const sendWithIssued: typeof fetch = async (resource, init) => {
      token = new Headers(init?.headers).get('x-x6-class3-approval') ?? ''
      head.issue(token, approvals.at(-1)!)
      return fetchImpl(resource, init)
    }
    const outcome = await approveAndSendOutward(staged, ORIGIN, { signal: new AbortController().signal }, sendWithIssued)
    expect(outcome).toMatchObject({ kind: 'sent', words: 'Sent.' })
    expect(approvals.at(-1)).toEqual(await aumlokClass3Binding({ audience: ORIGIN, method: 'POST', pathname: '/_host/linear', body }))
    expect(linear).toHaveLength(1)
    expect(linear[0]?.variables).toEqual({ id: UUID1 })
    expect(answers.at(-1)).toMatchObject({ status: 200, body: { ok: true, action: 'issue_delete', approved: 'delete' } })
    // The same approval again, at another isolate (no memory of the first answer): refused by HEAD, nothing sent.
    const other = edge(head)
    const again = await other.fetchImpl('/_host/linear', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-x6-class3-approval': token } })
    expect([again.status, (await again.json() as Record<string, unknown>).code]).toEqual([403, 'CLASS3_WEBAUTHN_REQUIRED'])
    expect(other.linear).toEqual([])
    // In the same isolate the same request answers its first result, and Linear is not called twice.
    const repeat = await fetchImpl('/_host/linear', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-x6-class3-approval': token } })
    expect(await repeat.json()).toMatchObject({ ok: true, repeated: true })
    expect(linear).toHaveLength(1)
  })

  it('a write that went out but whose answer the door withheld is never called "Not sent"', async () => {
    const body = { action: 'project_settings', requestId: 'made-up-request-chain-03', id: 'project-made-up-1', targetDate: '2026-12-01' }
    const staged = parseStagedOutward(file(body))!
    const withheld: typeof fetch = () => Promise.resolve(Response.json({ ok: false, code: 'LINEAR_ANSWER_WITHHELD', outcome: 'written' }, { status: 502 }))
    const outcome = await approveAndSendOutward(staged, ORIGIN, { signal: new AbortController().signal }, withheld)
    expect(outcome.kind).toBe('unknown')
    expect(outcome.words).toBe(`The host answered LINEAR_ANSWER_WITHHELD. ${outwardMaybeSent(staged)}`)
  })

  it('a body changed after his approval is refused, nothing is sent, and the approval is not spent by it', async () => {
    const head = headStandIn()
    const body = { action: 'team_member_remove', requestId: 'made-up-request-chain-02', id: 'membership-made-up-1' }
    // Between his approval and the edge, one field of the bytes changes: another membership.
    const changed = edge(head, text => text.replace('membership-made-up-1', 'membership-made-up-2'))
    const staged = parseStagedOutward(file(body))!
    let token = ''
    const outcome = await approveAndSendOutward(staged, ORIGIN, { signal: new AbortController().signal }, async (resource, init) => {
      token = new Headers(init?.headers).get('x-x6-class3-approval') ?? ''
      head.issue(token, approvals.at(-1)!)
      return changed.fetchImpl(resource, init)
    })
    expect(outcome).toMatchObject({ kind: 'refused', words: 'Not sent: the host refused it (CLASS3_WEBAUTHN_REQUIRED).' })
    expect(changed.linear).toEqual([])
    // The approval still covers only the bytes he read: those, unchanged, go out once.
    const clean = edge(head)
    const sent = await clean.fetchImpl('/_host/linear', { method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-x6-class3-approval': token } })
    expect(sent.status).toBe(200)
    expect(clean.linear).toHaveLength(1)
    expect(clean.linear[0]?.variables).toEqual({ id: 'membership-made-up-1' })
  })
})
