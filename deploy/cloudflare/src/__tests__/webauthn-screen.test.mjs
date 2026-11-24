/**
 * Job 11, THE AGREEMENT TABLE: the same malformed and mismatched WebAuthn answers fed to our screen (webauthn-screen.mjs)
 * and to the WebAuthn library ALONE (@simplewebauthn/server, its real verifyAuthenticationResponse and
 * verifyRegistrationResponse). The rule it holds: EVERY answer the library throws on is refused by the screen first (for
 * an assertion whose counter is not past the stored one: reported `stale`, the library's counter rule). So after a passing
 * screen a library throw can only mean the library disagreed or something broke, never a proof judged wrong, and
 * proofOutcome answers it unavailable. If a library upgrade starts throwing on something the screen lets through, a row
 * here fails: add that check to the screen. The screen may be stricter than the library (those rows are counted too).
 * Synthetic keys (node:crypto), no network, no storage.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, generateKeyPairSync, randomBytes, sign } from 'node:crypto'
import { verifyAuthenticationResponse, verifyRegistrationResponse } from '@simplewebauthn/server'
import { isoCBOR } from '@simplewebauthn/server/helpers'
import { SCREEN_POLICY, screenAssertion, screenRegistration } from '../webauthn-screen.mjs'

const ORIGIN = 'https://webauthn-screen.example.invalid'
const RP_ID = new URL(ORIGIN).hostname
const sha = value => createHash('sha256').update(value).digest()
const json64 = value => Buffer.from(JSON.stringify(value)).toString('base64url')

function es256() {
  const key = generateKeyPairSync('ec', { namedCurve: 'P-256' }), jwk = key.publicKey.export({ format: 'jwk' })
  return { key, id: randomBytes(32).toString('base64url'),
    publicKeyB64: Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]))).toString('base64url') }
}
function ed25519() {
  const key = generateKeyPairSync('ed25519'), jwk = key.publicKey.export({ format: 'jwk' })
  return { key, id: randomBytes(32).toString('base64url'),
    publicKeyB64: Buffer.from(isoCBOR.encode(new Map([[1, 1], [3, -8], [-1, 6], [-2, Buffer.from(jwk.x, 'base64url')]]))).toString('base64url') }
}

/** A get() answer; every field can be bent, and `bytes(auth)` rewrites the authenticator data before it is signed. */
function assertion(passkey, challenge, { type = 'webauthn.get', origin = ORIGIN, rpId = RP_ID, flags = 0x05, counter = 0, data = {}, auth: bytes = auth => auth, signer = passkey.key } = {}) {
  const clientDataJSON = json64({ type, challenge, origin, crossOrigin: false, ...data })
  const base = Buffer.alloc(37)
  sha(rpId).copy(base); base[32] = flags; base.writeUInt32BE(counter, 33)
  const auth = bytes(base)
  const signature = sign(signer.privateKey.asymmetricKeyType === 'ed25519' ? null : 'sha256', Buffer.concat([auth, sha(Buffer.from(clientDataJSON, 'base64url'))]), signer.privateKey).toString('base64url')
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, authenticatorData: auth.toString('base64url'), signature } }
}
/** A create() answer, attestation 'none'; every field can be bent. */
function registration(passkey, challenge, { type = 'webauthn.create', origin = ORIGIN, rpId = RP_ID, flags = 0x45, fmt = 'none', attStmt = new Map(), data = {}, key = passkey.publicKeyB64,
  credentialId = passkey.id, authData: bend = bytes => bytes, attestation: wrap = map => map } = {}) {
  const clientDataJSON = json64({ type, challenge, origin, crossOrigin: false, ...data })
  const idBytes = Buffer.from(credentialId, 'base64url'), head = Buffer.alloc(55)
  sha(rpId).copy(head); head[32] = flags; head.writeUInt16BE(idBytes.length, 53)
  const authData = bend(Buffer.concat([head, idBytes, Buffer.from(key, 'base64url')]))
  const attestationObject = Buffer.from(isoCBOR.encode(wrap(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]])))).toString('base64url')
  return { id: passkey.id, rawId: passkey.id, type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON, attestationObject, transports: ['internal'] } }
}
/** an ES256 COSE key of the right shape whose (x, y) is not a point of P-256 (x = y = 1). */
const offCurveKey = () => Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32, 0).fill(1, 31)], [-3, Buffer.alloc(32, 0).fill(1, 31)]]))).toString('base64url')
const withResponse = (credential, fields) => ({ ...credential, response: { ...credential.response, ...fields } })
const swapData = (credential, change) => {
  const data = JSON.parse(Buffer.from(credential.response.clientDataJSON, 'base64url').toString())
  return withResponse(credential, { clientDataJSON: Buffer.from(JSON.stringify(change(data))).toString('base64url') })
}

/** The library alone: { threw, message } or { threw: false, verified }. */
const libraryOn = async run => {
  try { const answer = await run(); return { threw: false, verified: answer?.verified } } catch (error) { return { threw: true, message: String(error?.message ?? error) } }
}

const CHALLENGE = randomBytes(32).toString('base64url')
/** Each row: [name, build(passkey) -> answer, stored counter (default 0), expected screen refusal or 'pass' / 'stale', the library's expected answer]. */
const ASSERTION_ROWS = [
  ['genuine', p => assertion(p, CHALLENGE), 0, 'pass', 'verified'],
  ['a wrong signature (another key of the same algorithm): the only `wrong`', p => assertion(p, CHALLENGE, { signer: p.key.privateKey.asymmetricKeyType === 'ed25519' ? generateKeyPairSync('ed25519') : generateKeyPairSync('ec', { namedCurve: 'P-256' }) }), 0, 'pass', 'false'],
  ['a wrong challenge (the reviewer\'s made-up "X" x 43)', p => assertion(p, 'X'.repeat(43)), 0, 'challenge', 'throws'],
  ['a wrong challenge (random)', p => assertion(p, randomBytes(32).toString('base64url')), 0, 'challenge', 'throws'],
  ['a wrong origin', p => assertion(p, CHALLENGE, { origin: 'https://elsewhere.example.invalid' }), 0, 'origin', 'throws'],
  ['a look-alike origin', p => assertion(p, CHALLENGE, { origin: ORIGIN + '.evil.example' }), 0, 'origin', 'throws'],
  ['a wrong type (create)', p => assertion(p, CHALLENGE, { type: 'webauthn.create' }), 0, 'type', 'throws'],
  ['a wrong type (other)', p => assertion(p, CHALLENGE, { type: 'payment.get' }), 0, 'type', 'throws'],
  ['a wrong RP id', p => assertion(p, CHALLENGE, { rpId: 'elsewhere.example.invalid' }), 0, 'rp-id', 'throws'],
  ['user presence off', p => assertion(p, CHALLENGE, { flags: 0x04 }), 0, 'user-presence', 'throws'],
  ['user verification off', p => assertion(p, CHALLENGE, { flags: 0x01 }), 0, 'user-verification', 'throws'],
  ['both flags off', p => assertion(p, CHALLENGE, { flags: 0x00 }), 0, 'user-presence', 'throws'],
  ['backed up but not backup-eligible (flags 0x15, the reviewer\'s)', p => assertion(p, CHALLENGE, { flags: 0x15 }), 0, 'backup-state', 'throws'],
  ['backup-eligible and backed up (flags 0x1d, a synced passkey)', p => assertion(p, CHALLENGE, { flags: 0x1d }), 0, 'pass', 'verified'],
  ['truncated authenticator data (36 bytes)', p => assertion(p, CHALLENGE, { auth: bytes => bytes.subarray(0, 36) }), 0, 'malformed', 'throws'],
  ['authenticator data "AA"', p => withResponse(assertion(p, CHALLENGE), { authenticatorData: 'AA' }), 0, 'malformed', 'throws'],
  ['trailing bytes after the authenticator data', p => assertion(p, CHALLENGE, { auth: bytes => Buffer.concat([bytes, Buffer.from([0])]) }), 0, 'malformed', 'throws'],
  ['the extension flag with no extensions', p => assertion(p, CHALLENGE, { flags: 0x85 }), 0, 'malformed', 'throws'],
  ['the attested-data flag with nothing attested', p => assertion(p, CHALLENGE, { flags: 0x45 }), 0, 'malformed', 'throws'],
  ['another credential\'s id', p => { const answer = assertion(p, CHALLENGE), other = randomBytes(32).toString('base64url'); return { ...answer, id: other, rawId: other } }, 0, 'credential', 'any'],
  ['an empty id', p => ({ ...assertion(p, CHALLENGE), id: '', rawId: '' }), 0, 'malformed', 'throws'],
  ['rawId differing from id', p => ({ ...assertion(p, CHALLENGE), rawId: randomBytes(32).toString('base64url') }), 0, 'malformed', 'throws'],
  ['a credential type other than public-key', p => ({ ...assertion(p, CHALLENGE), type: 'password' }), 0, 'malformed', 'throws'],
  ['no response', p => { const { response: _response, ...rest } = assertion(p, CHALLENGE); return rest }, 0, 'malformed', 'throws'],
  ['clientDataJSON not base64url (+/)', p => withResponse(assertion(p, CHALLENGE), { clientDataJSON: '+/+/' }), 0, 'malformed', 'throws'],
  ['clientDataJSON not JSON', p => withResponse(assertion(p, CHALLENGE), { clientDataJSON: Buffer.from('not json').toString('base64url') }), 0, 'malformed', 'throws'],
  ['clientDataJSON the JSON null', p => withResponse(assertion(p, CHALLENGE), { clientDataJSON: Buffer.from('null').toString('base64url') }), 0, 'malformed', 'throws'],
  ['clientDataJSON a number', p => withResponse(assertion(p, CHALLENGE), { clientDataJSON: 42 }), 0, 'malformed', 'throws'],
  ['authenticatorData not base64url', p => withResponse(assertion(p, CHALLENGE), { authenticatorData: '!!!!' }), 0, 'malformed', 'throws'],
  ['signature not base64url', p => withResponse(assertion(p, CHALLENGE), { signature: '!!!!' }), 0, 'malformed', 'throws'],
  ['signature padded base64', p => withResponse(assertion(p, CHALLENGE), { signature: assertion(p, CHALLENGE).response.signature + '=' }), 0, 'malformed', 'any'],
  ['signature not DER', p => withResponse(assertion(p, CHALLENGE), { signature: randomBytes(64).toString('base64url') }), 0, 'malformed', 'any'],
  ['signature "AA"', p => withResponse(assertion(p, CHALLENGE), { signature: 'AA' }), 0, 'malformed', 'any'],
  ['a userHandle that is not a string', p => withResponse(assertion(p, CHALLENGE), { userHandle: 7 }), 0, 'malformed', 'throws'],
  ['a userHandle that is not base64url', p => withResponse(assertion(p, CHALLENGE), { userHandle: 'a+b/' }), 0, 'malformed', 'any'],
  ['a topOrigin (a cross-origin frame)', p => swapData(assertion(p, CHALLENGE), data => ({ ...data, topOrigin: 'https://frame.example.invalid' })), 0, 'malformed', 'throws'],
  ['crossOrigin with a topOrigin', p => swapData(assertion(p, CHALLENGE), data => ({ ...data, crossOrigin: true, topOrigin: 'https://frame.example.invalid' })), 0, 'malformed', 'throws'],
  ['a token binding that is not an object', p => swapData(assertion(p, CHALLENGE), data => ({ ...data, tokenBinding: 'present' })), 0, 'malformed', 'throws'],
  ['a token binding of an unknown status', p => swapData(assertion(p, CHALLENGE), data => ({ ...data, tokenBinding: { status: 'odd' } })), 0, 'malformed', 'throws'],
  ['a challenge that is not a string', p => swapData(assertion(p, CHALLENGE), data => ({ ...data, challenge: 7 })), 0, 'malformed', 'throws'],
  ['a counter behind the stored one (stored 5, sent 3)', p => assertion(p, CHALLENGE, { counter: 3 }), 5, 'stale', 'throws-counter'],
  ['a counter equal to the stored one (stored 5, sent 5)', p => assertion(p, CHALLENGE, { counter: 5 }), 5, 'stale', 'throws-counter'],
  ['a zero counter after a stored one (stored 5, sent 0)', p => assertion(p, CHALLENGE, { counter: 0 }), 5, 'stale', 'throws-counter'],
  ['a counter past the stored one (stored 5, sent 6)', p => assertion(p, CHALLENGE, { counter: 6 }), 5, 'pass', 'verified'],
]

const REG_CHALLENGE = randomBytes(32).toString('base64url')
const REGISTRATION_ROWS = [
  ['genuine', p => registration(p, REG_CHALLENGE), 'pass', 'verified'],
  ['a wrong challenge', p => registration(p, 'X'.repeat(43)), 'challenge', 'throws'],
  ['a wrong origin', p => registration(p, REG_CHALLENGE, { origin: 'https://elsewhere.example.invalid' }), 'origin', 'throws'],
  ['a wrong type (get)', p => registration(p, REG_CHALLENGE, { type: 'webauthn.get' }), 'type', 'throws'],
  ['a wrong RP id', p => registration(p, REG_CHALLENGE, { rpId: 'elsewhere.example.invalid' }), 'rp-id', 'throws'],
  ['user presence off', p => registration(p, REG_CHALLENGE, { flags: 0x44 }), 'user-presence', 'throws'],
  ['user verification off', p => registration(p, REG_CHALLENGE, { flags: 0x41 }), 'user-verification', 'throws'],
  ['backed up but not backup-eligible (flags 0x55, the reviewer\'s)', p => registration(p, REG_CHALLENGE, { flags: 0x55 }), 'backup-state', 'throws'],
  ['backup-eligible and backed up (flags 0x5d, a synced passkey)', p => registration(p, REG_CHALLENGE, { flags: 0x5d }), 'pass', 'verified'],
  // The library registers it ('none' imports no key) and then throws on every assertion for it (its key import refuses the
  // point): refused here where it enters. Stricter than the library, by design.
  ['an ES256 key whose point is not on P-256', p => registration(p, REG_CHALLENGE, { key: offCurveKey() }), 'malformed', 'verified'],
  ['the attested-data flag off', p => registration(p, REG_CHALLENGE, { flags: 0x05 }), 'malformed', 'throws'],
  ['truncated authenticator data', p => registration(p, REG_CHALLENGE, { authData: bytes => bytes.subarray(0, 36) }), 'malformed', 'throws'],
  ['trailing bytes after the key', p => registration(p, REG_CHALLENGE, { authData: bytes => Buffer.concat([bytes, Buffer.from([0])]) }), 'malformed', 'throws'],
  ['a packed attestation (another format)', p => registration(p, REG_CHALLENGE, { fmt: 'packed' }), 'unsupported', 'throws'],
  ['an unknown attestation format', p => registration(p, REG_CHALLENGE, { fmt: 'made-up' }), 'unsupported', 'throws'],
  ['a "none" statement that is not empty', p => registration(p, REG_CHALLENGE, { attStmt: new Map([['sig', Buffer.from([1])]]) }), 'malformed', 'throws'],
  ['an RS256 key (another algorithm)', p => registration(p, REG_CHALLENGE, { key: Buffer.from(isoCBOR.encode(new Map([[1, 3], [3, -257], [-1, Buffer.alloc(256, 1)], [-2, Buffer.from([1, 0, 1])]]))).toString('base64url') }), 'unsupported', 'throws'],
  ['a key with no algorithm', p => registration(p, REG_CHALLENGE, { key: Buffer.from(isoCBOR.encode(new Map([[1, 2], [-1, 1]]))).toString('base64url') }), 'malformed', 'throws'],
  ['an attestation object that is not a map', p => withResponse(registration(p, REG_CHALLENGE), { attestationObject: Buffer.from(isoCBOR.encode([1, 2])).toString('base64url') }), 'malformed', 'throws'],
  ['an attestation object that is not CBOR', p => withResponse(registration(p, REG_CHALLENGE), { attestationObject: Buffer.from([0xff, 0xff]).toString('base64url') }), 'malformed', 'throws'],
  ['authData that is not bytes', p => registration(p, REG_CHALLENGE, { attestation: map => new Map([...map, ['authData', 'text']]) }), 'malformed', 'throws'],
  ['a credential id other than the answer\'s', p => registration(p, REG_CHALLENGE, { credentialId: randomBytes(32).toString('base64url') }), 'malformed', 'any'],
  ['an empty id', p => ({ ...registration(p, REG_CHALLENGE), id: '', rawId: '' }), 'malformed', 'throws'],
  ['rawId differing from id', p => ({ ...registration(p, REG_CHALLENGE), rawId: randomBytes(32).toString('base64url') }), 'malformed', 'throws'],
  ['a credential type other than public-key', p => ({ ...registration(p, REG_CHALLENGE), type: 'password' }), 'malformed', 'throws'],
  ['clientDataJSON not JSON', p => withResponse(registration(p, REG_CHALLENGE), { clientDataJSON: Buffer.from('not json').toString('base64url') }), 'malformed', 'throws'],
  ['attestationObject not base64url', p => withResponse(registration(p, REG_CHALLENGE), { attestationObject: '!!!!' }), 'malformed', 'any'],
  ['a token binding of an unknown status', p => swapData(registration(p, REG_CHALLENGE), data => ({ ...data, tokenBinding: { status: 'odd' } })), 'malformed', 'throws'],
  ['crossOrigin true', p => swapData(registration(p, REG_CHALLENGE), data => ({ ...data, crossOrigin: true })), 'cross-origin', 'any'],
  ['a transports list with an unknown name', p => withResponse(registration(p, REG_CHALLENGE), { transports: ['carrier-pigeon'] }), 'malformed', 'any'],
]

test('job 11 AGREEMENT TABLE, assertions (ES256 and Ed25519): every answer the library throws on is refused by the screen first; only a passing screen reaches the library', async t => {
  const tally = { rows: 0, libraryThrows: 0, screenRefusals: 0, stricter: 0 }
  for (const [kind, passkey] of [['ES256', es256()], ['Ed25519', ed25519()]]) {
    for (const [name, build, storedCounter, expected, library] of ASSERTION_ROWS) {
      if (kind === 'Ed25519' && /not DER/.test(name)) continue
      const answer = build(passkey)
      const stored = { id: passkey.id, publicKeyB64: passkey.publicKeyB64, counter: storedCounter }
      const screened = await screenAssertion(answer, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID, stored })
      const lib = await libraryOn(() => verifyAuthenticationResponse({ response: answer, expectedChallenge: CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        expectedType: 'webauthn.get', requireUserVerification: true, credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKeyB64, 'base64url'), counter: storedCounter } }))
      const label = `${kind}: ${name}: screen ${JSON.stringify(screened)}, library ${JSON.stringify(lib)}`
      tally.rows++
      // THE RULE: a library throw is always met by a screen refusal first (or, for its counter rule, by `stale`).
      if (lib.threw) {
        tally.libraryThrows++
        assert.ok(screened.pass === false || (screened.stale === true && /^Response counter value \d+ was lower than expected \d+$/.test(lib.message)), label)
      }
      if (screened.pass === false) tally.screenRefusals++
      if (screened.pass === false && !lib.threw) tally.stricter++
      // The row's own expectation (so a screen that refuses for the wrong reason is caught too).
      if (expected === 'pass') assert.deepEqual([screened.pass, screened.stale], [true, false], label)
      else if (expected === 'stale') assert.deepEqual([screened.pass, screened.stale], [true, true], label)
      else assert.deepEqual([screened.pass, screened.refusal], [false, expected], label)
      if (library === 'verified') assert.deepEqual([lib.threw, lib.verified], [false, true], label)
      else if (library === 'false') assert.deepEqual([lib.threw, lib.verified], [false, false], label)
      else if (library === 'throws') assert.equal(lib.threw, true, label)
      else if (library === 'throws-counter') assert.match(lib.message ?? '', /^Response counter value/, label)
    }
  }
  t.diagnostic(`assertion rows ${String(tally.rows)}: library throws ${String(tally.libraryThrows)}, screen refusals ${String(tally.screenRefusals)}, screen stricter than the library ${String(tally.stricter)}`)
  assert.ok(tally.libraryThrows >= 50, JSON.stringify(tally))
})

test('job 11 AGREEMENT TABLE, registrations: every answer the library throws on is refused by the screen first', async t => {
  const tally = { rows: 0, libraryThrows: 0, screenRefusals: 0, stricter: 0 }
  for (const [kind, passkey] of [['ES256', es256()], ['Ed25519', ed25519()]]) {
    for (const [name, build, expected, library] of REGISTRATION_ROWS) {
      const answer = build(passkey)
      const screened = await screenRegistration(answer, { challenge: REG_CHALLENGE, origin: ORIGIN, rpId: RP_ID })
      const lib = await libraryOn(() => verifyRegistrationResponse({ response: answer, expectedChallenge: REG_CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
        expectedType: 'webauthn.create', requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -8] }))
      const label = `${kind}: ${name}: screen ${JSON.stringify(screened)}, library ${JSON.stringify(lib)}`
      tally.rows++
      if (lib.threw) { tally.libraryThrows++; assert.equal(screened.pass, false, label) }
      if (screened.pass === false) tally.screenRefusals++
      if (screened.pass === false && !lib.threw) tally.stricter++
      if (expected === 'pass') assert.equal(screened.pass, true, label)
      else assert.deepEqual([screened.pass, screened.refusal], [false, expected], label)
      if (library === 'verified') assert.deepEqual([lib.threw, lib.verified], [false, true], label)
      else if (library === 'throws') assert.equal(lib.threw, true, label)
    }
  }
  t.diagnostic(`registration rows ${String(tally.rows)}: library throws ${String(tally.libraryThrows)}, screen refusals ${String(tally.screenRefusals)}, screen stricter than the library ${String(tally.stricter)}`)
  assert.ok(tally.libraryThrows >= 30, JSON.stringify(tally))
})

test('job 11: the screen is our own code: it uses no key and no verifier (no crypto.subtle.verify, no import), and its own hash failing is `unavailable`, never a refusal', async t => {
  const passkey = es256()
  const verify = t.mock.method(crypto.subtle, 'verify', () => assert.fail('the screen must not verify'))
  const importKey = t.mock.method(crypto.subtle, 'importKey', () => assert.fail('the screen must not import a key'))
  const stored = { id: passkey.id, publicKeyB64: passkey.publicKeyB64, counter: 0 }
  for (const [, build] of ASSERTION_ROWS) await screenAssertion(build(passkey), { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID, stored })
  for (const [, build] of REGISTRATION_ROWS) await screenRegistration(build(passkey), { challenge: REG_CHALLENGE, origin: ORIGIN, rpId: RP_ID })
  assert.deepEqual([verify.mock.callCount(), importKey.mock.callCount()], [0, 0])
  verify.mock.restore(); importKey.mock.restore()
  const digest = t.mock.method(crypto.subtle, 'digest', () => { throw new Error('digest down') })
  assert.deepEqual(await screenAssertion(assertion(passkey, CHALLENGE), { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID, stored }), { pass: false, refusal: 'unavailable' })
  assert.deepEqual(await screenRegistration(registration(passkey, REG_CHALLENGE), { challenge: REG_CHALLENGE, origin: ORIGIN, rpId: RP_ID }), { pass: false, refusal: 'unavailable' })
  digest.mock.restore()
  assert.deepEqual(SCREEN_POLICY, ['type', 'challenge', 'origin', 'rp-id', 'user-presence', 'user-verification', 'backup-state'])
})

// ── EVERY FLAG COMBINATION. The six flags the library reads (UP 0x01,
// UV 0x04, BE 0x08, BS 0x10, AT 0x40, ED 0x80), all 64 combinations, each a genuinely signed (assertion) or well-formed
// (registration) answer whose authenticator data really carries what its flags say (attested data when AT, an extension
// map when ED). Every combination the library rejects is refused by the screen first. ──
const FLAG_BITS = Object.freeze({ UP: 0x01, UV: 0x04, BE: 0x08, BS: 0x10, AT: 0x40, ED: 0x80 })
const EXTENSIONS = Buffer.from(isoCBOR.encode(new Map([['credProtect', 1]])))
const flagCombinations = () => Array.from({ length: 64 }, (_, index) => Object.values(FLAG_BITS).reduce((flags, bit, position) => (index >> position) & 1 ? flags | bit : flags, 0))
const flagName = flags => Object.entries(FLAG_BITS).filter(([, bit]) => flags & bit).map(([name]) => name).join('+') || 'none'
const attested = passkey => {
  const idBytes = Buffer.from(passkey.id, 'base64url'), head = Buffer.alloc(18)
  head.writeUInt16BE(idBytes.length, 16)
  return Buffer.concat([head, idBytes, Buffer.from(passkey.publicKeyB64, 'base64url')])
}
/** What the screen must answer for a combination: the first rule the flags break, in the screen's order, or 'pass'. */
const expectedForFlags = (flags, ceremony) => {
  if (ceremony === 'registration' && !(flags & FLAG_BITS.AT)) return 'malformed'
  if (!(flags & FLAG_BITS.UP)) return 'user-presence'
  if (!(flags & FLAG_BITS.UV)) return 'user-verification'
  if ((flags & FLAG_BITS.BS) && !(flags & FLAG_BITS.BE)) return 'backup-state'
  return 'pass'
}

test('every combination of UP, UV, BE, BS, AT and ED, both ceremonies, ES256 and Ed25519: every combination the library rejects is refused by the screen first', async t => {
  const tally = { rows: 0, libraryThrows: 0, screenRefusals: 0, backupState: 0, libraryAfterPassingScreen: 0 }
  for (const [kind, passkey] of [['ES256', es256()], ['Ed25519', ed25519()]]) {
    const stored = { id: passkey.id, publicKeyB64: passkey.publicKeyB64, counter: 0 }
    for (const flags of flagCombinations()) {
      const tail = bytes => Buffer.concat([bytes, flags & FLAG_BITS.AT ? attested(passkey) : Buffer.alloc(0), flags & FLAG_BITS.ED ? EXTENSIONS : Buffer.alloc(0)])
      const get = assertion(passkey, CHALLENGE, { flags, auth: tail })
      // A registration's attested data is there only when AT says so (as an authenticator writes it).
      const create = registration(passkey, REG_CHALLENGE, { flags, authData: bytes => Buffer.concat([flags & FLAG_BITS.AT ? bytes : bytes.subarray(0, 37), flags & FLAG_BITS.ED ? EXTENSIONS : Buffer.alloc(0)]) })
      for (const [ceremony, screened, lib] of [
        ['assertion', await screenAssertion(get, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID, stored }),
          await libraryOn(() => verifyAuthenticationResponse({ response: get, expectedChallenge: CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: RP_ID, expectedType: 'webauthn.get',
            requireUserVerification: true, credential: { id: passkey.id, publicKey: Buffer.from(passkey.publicKeyB64, 'base64url'), counter: 0 } }))],
        ['registration', await screenRegistration(create, { challenge: REG_CHALLENGE, origin: ORIGIN, rpId: RP_ID }),
          await libraryOn(() => verifyRegistrationResponse({ response: create, expectedChallenge: REG_CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: RP_ID,
            expectedType: 'webauthn.create', requireUserPresence: true, requireUserVerification: true, supportedAlgorithmIDs: [-7, -8] }))],
      ]) {
        const label = `${kind} ${ceremony} flags 0x${flags.toString(16).padStart(2, '0')} (${flagName(flags)}): screen ${JSON.stringify(screened)}, library ${JSON.stringify(lib)}`
        tally.rows++
        if (lib.threw) { tally.libraryThrows++; assert.equal(screened.pass, false, label) }
        if (screened.pass === false) tally.screenRefusals++
        if (screened.refusal === 'backup-state') tally.backupState++
        if (screened.pass === true && lib.threw) tally.libraryAfterPassingScreen++
        const expected = expectedForFlags(flags, ceremony)
        if (expected === 'pass') {
          assert.deepEqual([screened.pass, lib.threw, lib.verified], [true, false, true], label)
        } else {
          assert.deepEqual([screened.pass, screened.refusal], [false, expected], label)
          assert.equal(lib.threw, true, `${label}: the library rejects it too`)
        }
      }
    }
  }
  t.diagnostic(`flag rows ${String(tally.rows)}: library throws ${String(tally.libraryThrows)}, screen refusals ${String(tally.screenRefusals)}, refused as backup-state ${String(tally.backupState)}, library throws after a passing screen ${String(tally.libraryAfterPassingScreen)}`)
  assert.deepEqual([tally.rows, tally.libraryThrows, tally.libraryAfterPassingScreen], [256, 220, 0], JSON.stringify(tally))
})

test('a stored ES256 key that is not a point of P-256 (the library\'s key import throws on it after a passing screen) is refused by the assertion screen; a usable one is not', async () => {
  const passkey = es256()
  const answer = assertion(passkey, CHALLENGE)
  for (const [name, publicKeyB64, expected] of [['the real key', passkey.publicKeyB64, 'pass'], ['x = y = 1', offCurveKey(), 'credential'],
    ['x = y = 0', Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.alloc(32)], [-3, Buffer.alloc(32)]]))).toString('base64url'), 'credential'],
    ['y = p (out of the field)', Buffer.from(isoCBOR.encode(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(isoCBOR.decodeFirst(Buffer.from(passkey.publicKeyB64, 'base64url')).get(-2))],
      [-3, Buffer.from('ffffffff00000001000000000000000000000000ffffffffffffffffffffffff', 'hex')]]))).toString('base64url'), 'credential']]) {
    const screened = await screenAssertion(answer, { challenge: CHALLENGE, origin: ORIGIN, rpId: RP_ID, stored: { id: passkey.id, publicKeyB64, counter: 0 } })
    const lib = await libraryOn(() => verifyAuthenticationResponse({ response: answer, expectedChallenge: CHALLENGE, expectedOrigin: ORIGIN, expectedRPID: RP_ID, expectedType: 'webauthn.get',
      requireUserVerification: true, credential: { id: passkey.id, publicKey: Buffer.from(publicKeyB64, 'base64url'), counter: 0 } }))
    const label = `${name}: screen ${JSON.stringify(screened)}, library ${JSON.stringify(lib)}`
    if (expected === 'pass') assert.deepEqual([screened.pass, lib.verified], [true, true], label)
    else assert.deepEqual([screened.pass, screened.refusal, lib.threw], [false, expected, true], label)
  }
})
