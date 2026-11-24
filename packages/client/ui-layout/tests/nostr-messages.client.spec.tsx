// @vitest-environment jsdom
/**
 * Round 11: Nostr Messages reads the node's /aukora-messages/* routes, and never claims more than the node reported.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import {
  deliveryOf, mlsStateOf, parseContacts, parseSent, parseThread, readMessagesHost, signatureOf, signsWithBip340, tierOf,
  type MessagesFetch,
} from '../src/client/spatial/apps/messages/messages-client.ts'
import { deliveryText, NostrMessagesSurface, signatureText, tierPill } from '../src/client/spatial/apps/messages/NostrMessagesSurface.tsx'
import { SAMPLE_CONVERSATIONS, type Conversation } from '../src/client/spatial/apps/messages/sample-conversations.ts'

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

const MLS = { groupId: 'g1', epoch: 3, cipherSuite: 'MLS_128_DHKEMX25519_AES128GCM_SHA256_Ed25519', memberPubkeys: ['a'.repeat(64)] }
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const live: Conversation = { id: 'c', name: 'C', preview: '', at: '', pinned: false, unread: false, archived: false, sample: false, turns: [] }

describe('Marmot MLS is claimed only with complete group state', () => {
  it('accepts the full state and refuses any missing part', () => {
    expect(mlsStateOf(MLS)).toEqual(MLS)
    expect(mlsStateOf({ ...MLS, groupId: '' })).toBeNull()
    expect(mlsStateOf({ ...MLS, epoch: -1 })).toBeNull()
    expect(mlsStateOf({ ...MLS, epoch: 1.5 })).toBeNull()
    expect(mlsStateOf({ ...MLS, cipherSuite: undefined })).toBeNull()
    expect(mlsStateOf({ ...MLS, memberPubkeys: [] })).toBeNull()
  })
  it('pills: MARMOT MLS with state, a plain warning without it', () => {
    expect(tierPill({ ...live, tier: 'marmot-mls', mls: MLS })?.text).toBe('MARMOT MLS')
    expect(tierPill({ ...live, tier: 'marmot-mls', mls: null })?.text).toBe('MARMOT · NO MLS STATE')
    expect(tierPill({ ...live, tier: 'microverse-local' })?.text).toBe('MICROVERSE')
    expect(tierPill({ ...live, tier: 'macroverse-nip44-dm' })?.text).toBe('NIP-44 DM')
    expect(tierPill({ ...live, sample: true })?.text).toBe('SAMPLE')
    expect(tierPill(live)).toBeNull()
  })
})

describe('a turn is delivered to a relay only with a relay acknowledgement', () => {
  it('reads the node words', () => {
    expect(deliveryOf({ delivery: 'microverse-local' })).toEqual({ kind: 'microverse-local' })
    expect(deliveryOf({ delivery: 'macroverse-relay' })).toEqual({ kind: 'unknown' })
    expect(deliveryOf({ delivery: 'macroverse-relay', relayAcks: ['wss://relay.example'] }))
      .toEqual({ kind: 'relay-acknowledged', relays: ['wss://relay.example'] })
    expect(deliveryOf({ delivery: { status: 'failed', detail: 'no relay' } })).toEqual({ kind: 'not-delivered', detail: 'no relay' })
  })
  it('says where it went in words', () => {
    expect(deliveryText({ kind: 'microverse-local' })).toMatch(/kept in the microverse.*not sent to a relay/)
    expect(deliveryText({ kind: 'relay-acknowledged', relays: ['wss://r'] })).toBe('delivered to 1 relay: wss://r')
  })
})

describe('parsing the routes', () => {
  it('contacts.json: identity, relay, conversations and contacts, tolerant of field names', () => {
    const host = parseContacts({
      identity: { npub: 'npub1x', pubkey: 'b'.repeat(64) },
      relay: { connected: false },
      conversations: [
        { id: 'auma-pearl', title: 'Auma · Pearl channel', tier: 'microverse-local', updatedAt: 1_700_000_000 },
        { conversationId: 'grp', name: 'Swarm', protocol: 'marmot-mls', group: MLS },
        { name: 'no id' },
      ],
      contacts: [{ npub: 'npub1peer', name: 'Peer', protocol: 'nip44-dm' }],
    })
    expect(host?.npub).toBe('npub1x')
    expect(host?.relay.connected).toBe(false)
    expect(host?.conversations.map(c => [c.id, c.tier, c.mls === null])).toEqual([
      ['auma-pearl', 'microverse-local', true],
      ['grp', 'marmot-mls', false],
      ['npub1peer', 'macroverse-nip44-dm', true],
    ])
  })
  it('thread: your turns by direction or by your pubkey; send: the stored event and its delivery', () => {
    const mine = 'c'.repeat(64)
    const turns = parseThread({ events: [
      { id: 'e1', pubkey: mine, content: 'hi', created_at: 1_700_000_000, delivery: 'microverse-local' },
      { id: 'e2', pubkey: 'd'.repeat(64), content: 'hello' },
    ] }, mine)
    expect(turns?.map(t => [t.from, t.delivery.kind])).toEqual([['you', 'microverse-local'], ['them', 'unknown']])
    expect(parseSent({ ok: true, event: { id: 'e3', content: 'x', created_at: 1 }, delivery: 'microverse-local' })?.delivery)
      .toEqual({ kind: 'microverse-local' })
    expect(tierOf({ tier: 'local' })).toBe('microverse-local')
  })
  it('an unserved route (404 or the app page) is unreachable; a JSON error is refused', async () => {
    const page: MessagesFetch = async () => new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } })
    expect((await readMessagesHost(page)).kind).toBe('unreachable')
    expect((await readMessagesHost(async () => new Response('x', { status: 404 }))).kind).toBe('unreachable')
    expect((await readMessagesHost(async () => { throw new TypeError('offline') })).kind).toBe('unreachable')
    expect((await readMessagesHost(async () => json({ ok: false, error: 'boom' }, 500))).kind).toBe('refused')
    expect((await readMessagesHost(async () => json({ conversations: [] }))).kind).toBe('ok')
  })
})

describe('the surface shows SAMPLE only when the node cannot be reached', () => {
  const owner = { activeSurface: 'messages', openSurface: () => {}, closeSurface: () => {} } as unknown as PropsRuntime<'shell.surface'>
  it('unreachable node: the samples, each labelled SAMPLE', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('Maya')).toBeTruthy() })
    expect(screen.getAllByText('SAMPLE').length).toBeGreaterThanOrEqual(SAMPLE_CONVERSATIONS.filter(c => !c.archived).length)
  })
  it('reachable node with nothing yet: an empty list, no samples', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ identity: { npub: 'npub1x' }, relay: { connected: false }, conversations: [] })))
    render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('No conversations on this node yet.')).toBeTruthy() })
    expect(screen.queryByText('Maya')).toBeNull()
    expect(screen.queryByText('SAMPLE')).toBeNull()
    expect(screen.getAllByText('NO RELAY').length).toBeGreaterThan(0)
  })
  it('live rows carry their tier pill', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ conversations: [
      { id: 'p', name: 'Auma · Pearl channel', tier: 'microverse-local' },
      { id: 'g', name: 'Swarm', protocol: 'marmot-mls', mls: MLS },
      { id: 'h', name: 'Half group', protocol: 'marmot-mls' },
    ] })))
    render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('Auma · Pearl channel')).toBeTruthy() })
    expect(screen.getAllByText('MICROVERSE').length).toBeGreaterThan(0)
    expect(screen.getByText('MARMOT MLS')).toBeTruthy()
    expect(screen.getByText('MARMOT · NO MLS STATE')).toBeTruthy()
    expect(screen.queryByText('SAMPLE')).toBeNull()
  })
})

describe('Round 12: BIP-340 signing is claimed only as the node reports it, with the whole event shape', () => {
  const PUB = 'e'.repeat(64)
  const SIGNED = { id: 'f'.repeat(64), pubkey: PUB, sig: 'a'.repeat(128), idScheme: 'nip01-schnorr/v1', signatureStatus: 'signed' }
  it('a signed turn needs the nip01-schnorr id scheme, a 64-hex id and pubkey and a 128-hex sig', () => {
    expect(signatureOf(SIGNED)).toEqual({ status: 'signed', idScheme: 'nip01-schnorr/v1' })
    expect(signatureOf({ ...SIGNED, signatureStatus: 'verified' }).status).toBe('verified')
    expect(signatureOf({ ...SIGNED, sig: null }).status).toBe('malformed')
    expect(signatureOf({ ...SIGNED, sig: 'a'.repeat(127) }).status).toBe('malformed')
    expect(signatureOf({ ...SIGNED, idScheme: 'aukora.messages.local/v1' }).status).toBe('malformed')
    expect(signatureOf({ ...SIGNED, id: 'not-hex' }).status).toBe('malformed')
    expect(signatureOf({ ...SIGNED, signatureStatus: 'invalid' }).status).toBe('invalid')
    expect(signatureOf({ ...SIGNED, sig: null, signatureStatus: 'unavailable', idScheme: 'aukora.messages.local/v1' }).status).toBe('unsigned')
    expect(signatureOf({}).status).toBe('unreported')
    expect(signatureOf({ signatureStatus: 'pending' }).status).toBe('unreported')
    expect(signatureText({ status: 'unreported', idScheme: null })).toBe('signature not reported by the node')
    expect(signatureText({ status: 'signed', idScheme: null })).toMatch(/as the node reports \(not checked in this tab\)/)
  })
  it('thread and send carry each turn\'s signature', () => {
    const turns = parseThread({ events: [{ ...SIGNED, content: 'hi', delivery: 'microverse-local' }, { content: 'old', signatureStatus: 'unavailable' }] }, PUB)
    expect(turns?.map(t => [t.from, t.signature.status])).toEqual([['you', 'signed'], ['them', 'unsigned']])
    expect(parseSent({ ok: true, event: { ...SIGNED, content: 'x', created_at: 1 }, delivery: 'microverse-local' })?.signature.status).toBe('signed')
  })
  it('identity: SIGNED only with an npub and signing bip340-schnorr', () => {
    const host = parseContacts({ identity: { npub: 'npub1x', pubkey: PUB, signing: 'bip340-schnorr' }, conversations: [] })
    expect(host?.signing).toBe('bip340-schnorr')
    expect(host === null ? false : signsWithBip340(host)).toBe(true)
    expect(signsWithBip340({ npub: null, signing: 'bip340-schnorr' })).toBe(false)
    expect(signsWithBip340({ npub: 'npub1x', signing: 'ed25519' })).toBe(false)
    expect(signsWithBip340({ npub: 'npub1x', signing: null })).toBe(false)
  })
  const owner = { activeSurface: 'messages', openSurface: () => {}, closeSurface: () => {} } as unknown as PropsRuntime<'shell.surface'>
  it('the node row shows NIP-01 · BIP-340 SIGNED when the node reports it, and not otherwise', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ identity: { npub: 'npub1x', pubkey: PUB, signing: 'bip340-schnorr' }, conversations: [] })))
    render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('NIP-01 · BIP-340 SIGNED')).toBeTruthy() })
    cleanup()
    vi.stubGlobal('fetch', vi.fn(async () => json({ identity: { npub: 'npub1x', pubkey: PUB }, conversations: [] })))
    render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('No conversations on this node yet.')).toBeTruthy() })
    expect(screen.queryByText('NIP-01 · BIP-340 SIGNED')).toBeNull()
  })
  it('a signed turn says so in its tooltip and data-signature, with no text added inside the bubble', async () => {
    vi.stubGlobal('fetch', vi.fn(async (input: string) => (input.endsWith('contacts.json')
      ? json({ identity: { npub: 'npub1x', pubkey: PUB, signing: 'bip340-schnorr' }, conversations: [{ id: 'p', name: 'Pearl', tier: 'microverse-local' }] })
      : json({ events: [{ ...SIGNED, content: 'hello', delivery: 'microverse-local' }] }))))
    const { container } = render(<NostrMessagesSurface {...owner} />)
    await waitFor(() => { expect(screen.getByText('Pearl')).toBeTruthy() })
    screen.getByText('Pearl').click()
    await waitFor(() => { expect(container.querySelector('.x5-message-turn[data-signature="signed"]')).toBeTruthy() })
    const turn = container.querySelector('.x5-message-turn[data-signature="signed"]')
    expect(turn?.getAttribute('title')).toContain('BIP-340 signature, as the node reports')
    expect(turn?.textContent).toBe('hello')
  })
})
