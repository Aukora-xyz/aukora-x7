/**
 * THE ONE RULE, STRUCTURAL. Unit tests of proof-failure-rule.mjs's two functions, and a SOURCE SCAN that keeps
 * the rule true for the next coder: in every file of deploy/cloudflare/src that takes part in owner identity,
 *   (a) every call of a verification primitive sits inside the callback handed to `proofOutcome(...)`, and
 *   (b) no budget field is written, and no gate failure recorded, anywhere but proof-failure-rule.mjs.
 * The scan parses each file with the TypeScript compiler's JavaScript parser (no regular-expression guessing about
 * strings, comments or regex literals), follows aliases (renamed and namespace imports, variables, destructuring, bind,
 * bracket access), and requires proofOutcome's first argument to be a function literal that itself checks something.
 * Self-tests feed it every walk-around earlier reviews found and require that each is caught.
 * Two more rules (scanSource, kinds 'catch' and 'verifier'):
 *   (c) NO CATCH COUNTS OR MAKES A WRONG. Inside any catch handler (a `catch` clause's block, a `.catch(fn)` callback, a
 *       `.then(_, fn)` rejection callback) there may be no call of a COUNTING function and no WRONG-MAKER, and no object
 *       literal `{ kind: 'wrong' }`. Counting functions: countFailure and relayWrong, and every function of the same file
 *       (a declaration, or a variable set to a function literal) whose body calls one of them, followed to a fixed point
 *       (so `miss = wrong => countFailure(...)` is one). Wrong-makers: relayedWrong, and every function whose body holds
 *       an object literal `kind: 'wrong'` or calls a wrong-maker, to a fixed point (so proof-failure-rule.mjs's own
 *       `wrong(reason)` is one). An exception is never a checked-wrong proof.
 *   (d) THE CALLBACK RETURNS THE VERIFIER'S OWN RESULT. proofOutcome's callback is an arrow or function whose result is,
 *       exactly, a verifier call (or the code-hash comparison): an expression body that is that call (parentheses and
 *       `await` aside), or a block of variable declarations ending in the one `return` of that call. `!!await verify()`,
 *       `Boolean(...)`, `(... ) === false ? ... : ...`, `.verified`, `.then(...)`, and a callback that checks and then returns
 *       a constant are all violations (each would let the callback decide the verdict instead of the verifier).
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import ts from 'typescript'
import { DEVICE_CODE_MISSES, PROOF_FAILURES, clearFailures, countFailure, proofError, proofIs, proofOf, proofOutcome, relayWrong, relayedWrong, settleProof, withProof } from '../proof-failure-rule.mjs'

const SRC = new URL('..', import.meta.url).pathname

// ── Unit: proofOutcome ────────────────────────────────────────────────────────────────────────────────────────────
/** Every answer the brief names. Only `true` is ok and only `false` is wrong; everything else reached no verdict. */
const ANSWERS = [
  ['true', () => true, 'ok'], ['false', () => false, 'wrong'], ['undefined', () => undefined, 'unavailable'], ['null', () => null, 'unavailable'],
  ['{}', () => ({}), 'unavailable'], ['[]', () => [], 'unavailable'], ['1', () => 1, 'unavailable'], ['0', () => 0, 'unavailable'],
  ['\'\'', () => '', 'unavailable'], ['\'true\'', () => 'true', 'unavailable'],
  ['a throw', () => { throw new Error('backend down') }, 'unavailable'], ['a rejection', () => Promise.reject(new Error('backend down')), 'unavailable'],
]

test('proofOutcome: only a strict true is ok, only a strict false is wrong; every other answer, a throw and a rejection are unavailable', async () => {
  for (const [name, answer, kind] of ANSWERS) {
    const outcome = await proofOutcome(answer, { code: 'AUMLOK_PROOF_INVALID' })
    assert.equal(outcome.kind, kind, name)
    assert.ok(Object.isFrozen(outcome), name)
    assert.ok(proofIs(outcome, kind), name)
    if (kind === 'wrong') assert.deepEqual([outcome.code, outcome.status], ['AUMLOK_PROOF_INVALID', 403])
    if (kind === 'unavailable') assert.deepEqual([outcome.code, outcome.status], ['AUMLOK_UNAVAILABLE', 503])
  }
})

test('proofOutcome, WebAuthn judge: the library result\'s `verified` must be the boolean; on true its info must say UV; EVERY throw is unavailable (its own verdict throws too)', async () => {
  const info = { authenticationInfo: { userVerified: true, newCounter: 1 } }
  for (const [name, verified, kind] of ANSWERS.slice(0, 10).map(([name, answer, kind]) => [name, answer(), kind])) {
    const outcome = await proofOutcome(async () => ({ verified, ...info }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })
    assert.equal(outcome.kind, kind, `verified: ${name}`)
  }
  for (const result of [undefined, null, {}, [], true, 'x']) {
    assert.equal((await proofOutcome(async () => result, { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })).kind, 'unavailable', JSON.stringify(result))
  }
  assert.equal((await proofOutcome(async () => ({ verified: true, authenticationInfo: { userVerified: false } }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })).kind, 'unavailable')
  // Job 11 MUST: the library throws for challenge, origin, RP id, type, flags and counter BEFORE its signature operation.
  // None of those throws is a signature checked and wrong: every one is unavailable (503), under both WebAuthn judges.
  const throws = [
    () => { throw new Error('Response counter value 3 was lower than expected 5') },
    () => { throw new Error('Unexpected authentication response challenge "a", expected "b"') },
    () => { throw new Error('Unexpected registration response type "webauthn.get", expected "webauthn.create"') },
    () => { throw new Error('User not present during authentication') },
    () => { throw new Error('User verification required, but user could not be verified') },
    () => { throw new Error('User presence was required, but user was not present') },
    () => { throw Object.assign(new Error('x'), { code: 'UNEXPECTED_RP_ID' }) },
    () => { throw Object.assign(new Error('x'), { code: 'UNEXPECTED_ORIGIN' }) },
    () => Promise.reject(new Error('Unexpected authentication response challenge "a", expected "b"')),
    () => { throw new Error('crypto backend down') },
  ]
  for (const judge of ['webauthn-authentication', 'webauthn-registration', 'boolean']) {
    for (const [index, run] of throws.entries()) {
      const outcome = await proofOutcome(run, { code: 'AUMLOK_PROOF_INVALID', judge })
      assert.deepEqual([outcome.kind, outcome.code, outcome.status], ['unavailable', 'AUMLOK_UNAVAILABLE', 503], `${judge}, throw ${String(index)}`)
    }
  }
  // The only `wrong` a WebAuthn judge gives: the library's own strict `verified: false`.
  const checkedWrong = await proofOutcome(async () => ({ verified: false }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })
  assert.deepEqual([checkedWrong.kind, checkedWrong.reason], ['wrong', 'verdict'])
})

test('nothing outside the module can make an outcome: a look-alike object is no outcome, and countFailure and clearFailures throw for anything but the real thing', async () => {
  const wrong = await proofOutcome(async () => false, { code: 'AUMLOK_PROOF_INVALID' })
  const ok = await proofOutcome(async () => ({ verified: true, authenticationInfo: { userVerified: true } }), { code: 'AUMLOK_PROOF_INVALID', judge: 'webauthn-authentication' })
  const unavailable = await proofOutcome(async () => ({}), { code: 'AUMLOK_PROOF_INVALID' })
  const lookalike = { ...wrong }, frozen = Object.freeze({ kind: 'wrong', code: 'AUMLOK_PROOF_INVALID', status: 403, reason: 'verdict' })
  const state = () => ({ failures: 0, failedAt: [], nextAllowedAt: 0, phraseFailures: 0, phraseFailedAt: [], phraseNextAllowedAt: 0 })
  const limits = { hardLockFailures: 10, backoffMs: 1000 }
  for (const fake of [lookalike, frozen, ok, unavailable, null, undefined, { code: 'AUMLOK_PROOF_INVALID', status: 403 }]) {
    assert.equal(proofIs(fake, 'wrong'), false)
    assert.throws(() => countFailure(fake, { kind: 'aumlok', state: state(), at: 1, limits }), { code: 'PROOF_RULE_VIOLATION' })
    assert.throws(() => countFailure(fake, { kind: 'device-code', pending: { misses: 0 } }), { code: 'PROOF_RULE_VIOLATION' })
    assert.equal(proofOf(withProof({}, fake)), null, 'only a branded wrong outcome travels with a refusal')
  }
  // The real one counts, in exactly the budget its listed code names.
  const counted = state()
  countFailure(wrong, { kind: 'aumlok', state: counted, at: 5000, limits })
  assert.deepEqual([counted.failures, counted.failedAt, counted.nextAllowedAt, counted.phraseFailures], [1, [5000], 6000, 0])
  // A wrong outcome whose code no budget lists cannot move one.
  const session = await proofOutcome(async () => false, { code: 'AUMLOK_SESSION_INVALID' })
  assert.throws(() => countFailure(session, { kind: 'aumlok', state: state(), at: 1, limits }), { code: 'PROOF_RULE_VIOLATION' })
  assert.throws(() => countFailure(session, { kind: 'gate', store: { recordFailure: () => assert.fail('gate written') }, subject: 's' }), { code: 'PROOF_RULE_VIOLATION' })
  assert.throws(() => countFailure(session, { kind: 'device-code', pending: { misses: 0 } }), { code: 'PROOF_RULE_VIOLATION' })
  // clearFailures needs a verified passkey: a boolean ok (a MAC, a signature) or anything else throws.
  const boolOk = await proofOutcome(async () => true, { code: 'AUMLOK_PROOF_INVALID' })
  for (const fake of [boolOk, wrong, unavailable, { ...ok }]) assert.throws(() => clearFailures(fake, state()), { code: 'PROOF_RULE_VIOLATION' })
  const reset = { ...state(), failures: 3, failedAt: [1, 2, 3], nextAllowedAt: 9 }
  clearFailures(ok, reset)
  assert.deepEqual([reset.failures, reset.failedAt, reset.nextAllowedAt], [0, [], 0])
  // A refusal carries its outcome by identity; a copy of it carries nothing.
  const error = proofError(wrong)
  assert.equal(proofOf(error), wrong)
  assert.equal(proofOf(Object.assign(new Error('AUMLOK_PROOF_INVALID'), { code: 'AUMLOK_PROOF_INVALID', status: 403 })), null)
  assert.throws(() => settleProof(wrong), error2 => proofOf(error2) === wrong && error2.status === 403)
  assert.throws(() => settleProof(unavailable), error2 => proofOf(error2) === null && error2.status === 503 && error2.code === 'AUMLOK_UNAVAILABLE')
  assert.deepEqual(DEVICE_CODE_MISSES, ['AUMLOK_DEVICE_CODE_INVALID', 'AUMLOK_PROOF_INVALID'])
  assert.equal(PROOF_FAILURES.length, 6)
})

// ── The source scan ───────────────────────────────────────────────────────────────────────────────────────────────
/**
 * The files that take part in owner identity (sessions, sign-in, the AUMLOK ceremonies and their budgets, HEAD's owner
 * gate, Class 3 and signed actions, the owner's JWT login, enrolment approval, passkey devices).
 */
const IDENTITY_FILES = ['access.mjs', 'aumlok.mjs', 'enrollment-approval.mjs', 'gate-lockout.mjs', 'head-do.mjs', 'owner-grant-policy.mjs',
  'passkey-devices.mjs', 'proof-failure-rule.mjs', 'signed-action.mjs', 'webauthn-screen.mjs', 'worker.mjs']
/** Files that call a verifier but are not owner identity: no owner budget is reachable from them (said why). */
const NOT_IDENTITY = {
  'cold-archive.mjs': 'backup checkpoints: an archive refusal (400), no owner budget, no session',
  'messages-store.mjs': 'Nostr event signatures (schnorr) in the message store: no owner budget, no session',
}
/**
 * The verification primitives in this codebase, by the callee's source text:
 *   crypto.subtle.verify (HMAC, Ed25519, ECDSA, RSASSA: every WebCrypto check, including the session, sign-in, pepper,
 *   recovery and invite-code MACs), the WebAuthn library's verifyAuthenticationResponse and verifyRegistrationResponse,
 *   Ed25519 and ML-DSA verify (ml_dsa65.verify, ed25519.verify), schnorr.verify, the hybrid backend table's members
 *   (backends.ed25519 / backends.mlDsa65), and timingSafeEqual.
 */
// (The primitives' canonical names: VERIFIER_NAME below, reached through aliases.)
/** A hash comparison used as a proof check: the add-device code's remainder (its SHA-256 against the stored one). */
const PROOF_COMPARISON = /(?:^|\.)codeHash$/
/** A table of verifier BACKENDS: its members are themselves verifiers, called only through proofOutcome (checked above). */
const BACKEND_TABLES = { 'owner-grant-policy.mjs': ['HYBRID_SIGNATURE_BACKENDS'] }
/** The budget fields: AUMLOK's two budgets and backoffs, HEAD's gate entry, the add-device code's misses. */
const BUDGET_FIELDS = new Set(['failures', 'failedAt', 'nextAllowedAt', 'phraseFailures', 'phraseFailedAt', 'phraseNextAllowedAt', 'misses', 'lockedUntil'])
/** The file where (b) holds by definition: the counting function lives there. */
const COUNTING_FILE = 'proof-failure-rule.mjs'
/**
 * THE GATE STORE ITSELF (gate-lockout.mjs createGateLockout and its durable adapter): the representation countFailure's
 * gate ledger writes through `recordFailure`. Its writes are the store's own; who may CALL recordFailure is checked in
 * every file. recordSuccess (a reset after a completed request) is the store's other entry.
 */
const STORE_FILES = new Set(['gate-lockout.mjs'])
/** Store plumbing: forwarding a store method to the store, never deciding to count. Exact source lines. */
const STORE_PLUMBING = {
  'head-do.mjs': ["const direct = Object.fromEntries([['checkSubject', 'check'], ['recordFailure', 'failure'], ['recordSuccess', 'success']]"],
}
/**
 * A COPY, NOT A COUNT: the Worker's isolate shield remembers a lock HEAD's durable gate already REPORTED
 * (createIsolateShield `locked`, from the durable answer's own Retry-After), so it can refuse sooner what HEAD would refuse
 * anyway. It never counts anything. Exact source text.
 */
const MIRRORS = { 'worker.mjs': ['value.lockedUntil = until'] }
/**
 * OPEN: nothing. The owner JWT and Access JWT checks (access.mjs) run through proofOutcome, and HEAD's owner-login
 * gate records a failure only through countFailure, from the Worker's closed field (relayedWrong). An entry here must be
 * listed EXACTLY, with a one-line reason: a new violation anywhere fails, and fixing a listed one fails until it is removed.
 */
const OPEN = []
/**
 * THE RELAY (proof-failure-rule.mjs relayWrong / relayedWrong): the one outcome that crosses from the Worker to HEAD. Each
 * end is allowed at exactly one site (the exact source line's start); any other call of either is a violation, and so is
 * the claim's text anywhere but proof-failure-rule.mjs.
 */
const RELAY_SITES = {
  relayWrong: { 'worker.mjs': ["const failed = await ask('failure', relayWrong(judged.outcome))"] },
  relayedWrong: { 'head-do.mjs': ["const relayed = isObject(input) && input.action === 'failure' ? relayedWrong(input.proof) : null"] },
}
const RELAY_CLAIMS = [relayWrong(await proofOutcome(() => false, { code: 'OWNER_LOGIN_SIGNATURE_INVALID' }))]

/**
 * VERIFIERS BY WHAT THEY ARE, NOT BY HOW THEY ARE SPELLED (job 10 review). Every expression is reduced to a canonical
 * dotted name: imports are followed through renames (`import { verifyAuthenticationResponse as check }`) and namespaces
 * (`import * as lib`), variables and destructured bindings through what they were set to (`const s = crypto.subtle`,
 * `const { verify } = crypto.subtle`, `const v = crypto.subtle.verify.bind(crypto.subtle)`), `globalThis.` / `self.` are
 * dropped, bracket access with a literal key is a member, and bracket access with any other key on a verifier holder is
 * `[*]` (a member that cannot be read by name, so treated as a verifier).
 */
const VERIFIER_NAME = /(?:^|\.)subtle\.(?:verify|\[\*\])$|^(?:verifyAuthenticationResponse|verifyRegistrationResponse)$|^(?:ml_dsa65|ed25519|schnorr)\.(?:verify|\[\*\])$|^backends\.(?:ed25519|mlDsa65|\[\*\])$|(?:^|\.)timingSafeEqual$/
/** Objects whose members are verifiers (an alias to one of these is followed too). */
const HOLDER_NAME = /^(?:crypto|crypto\.subtle|subtle|ed25519|ml_dsa65|schnorr|backends)$/
const GLOBALS = new Set(['globalThis', 'self', 'window'])
const unwrap = node => {
  for (;;) {
    if (ts.isParenthesizedExpression(node) || ts.isNonNullExpression(node) || ts.isAwaitExpression(node)) node = node.expression
    else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.CommaToken) node = node.right
    else return node
  }
}
const literalKey = node => ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) ? node.text : ts.isNumericLiteral(node) ? node.text : null
function canonicalOf(input, aliases) {
  const node = unwrap(input)
  if (ts.isIdentifier(node)) return aliases.has(node.text) ? aliases.get(node.text) : node.text
  const member = (base, key) => base === null ? null : base === '' || GLOBALS.has(base) ? key : `${base}.${key}`
  if (ts.isPropertyAccessExpression(node)) return member(canonicalOf(node.expression, aliases), node.name.text)
  if (ts.isElementAccessExpression(node)) return member(canonicalOf(node.expression, aliases), literalKey(node.argumentExpression) ?? '[*]')
  // A bound verifier is the verifier.
  if (ts.isCallExpression(node)) {
    const callee = canonicalOf(node.expression, aliases)
    return callee?.endsWith('.bind') ? callee.slice(0, -'.bind'.length) : null
  }
  return null
}
const followed = name => name !== null && (VERIFIER_NAME.test(name) || HOLDER_NAME.test(name) || name === 'proofOutcome' || name === 'relayWrong' || name === 'relayedWrong' || name === '')
/** Every alias in one file (by name, file-wide: a name ever bound to a verifier or a holder is that thing everywhere). */
function aliasesOf(file) {
  const aliases = new Map()
  const bindPattern = (pattern, base) => {
    for (const element of pattern.elements) {
      if (!ts.isBindingElement(element) || element.dotDotDotToken) continue
      const key = element.propertyName ? (literalKey(element.propertyName) ?? element.propertyName.getText()) : element.name.getText()
      const target = base === null ? null : base === '' || GLOBALS.has(base) ? key : `${base}.${key}`
      if (ts.isIdentifier(element.name)) { if (followed(target) && target !== '') aliases.set(element.name.text, target) }
      else if (ts.isObjectBindingPattern(element.name)) bindPattern(element.name, target)
    }
  }
  for (let pass = 0; pass < 4; pass++) {
    const visit = node => {
      if (ts.isImportSpecifier(node)) {
        const imported = (node.propertyName ?? node.name).text
        if (imported !== node.name.text) aliases.set(node.name.text, imported)
      }
      if (ts.isNamespaceImport(node)) aliases.set(node.name.text, '')
      if (ts.isVariableDeclaration(node) && node.initializer) {
        const target = canonicalOf(node.initializer, aliases)
        if (ts.isIdentifier(node.name) && followed(target) && target !== '' && target !== node.name.text) aliases.set(node.name.text, target)
        if (ts.isObjectBindingPattern(node.name)) bindPattern(node.name, target)
      }
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const target = canonicalOf(node.right, aliases)
        if (followed(target) && target !== '' && target !== node.left.text) aliases.set(node.left.text, target)
      }
      ts.forEachChild(node, visit)
    }
    visit(file)
  }
  return aliases
}
/** An identifier that names something here (a declaration, a key, a property name) rather than reading a value. */
function declaresOnly(node) {
  const parent = node.parent
  return (ts.isPropertyAccessExpression(parent) && parent.name === node) || ts.isImportSpecifier(parent) || ts.isImportClause(parent) || ts.isNamespaceImport(parent)
    || ts.isExportSpecifier(parent) || (ts.isVariableDeclaration(parent) && parent.name === node) || (ts.isParameter(parent) && parent.name === node)
    || (ts.isBindingElement(parent) && (parent.name === node || parent.propertyName === node)) || (ts.isPropertyAssignment(parent) && parent.name === node)
    || ((ts.isFunctionDeclaration(parent) || ts.isFunctionExpression(parent) || ts.isMethodDeclaration(parent) || ts.isClassDeclaration(parent)) && parent.name === node)
    || (ts.isLabeledStatement(parent) && parent.label === node)
}

/** True if `node` sits inside the function literal handed as the first argument to a `proofOutcome(...)` call. */
function insideProofOutcome(node, aliases) {
  for (let child = node, parent = node.parent; parent; child = parent, parent = parent.parent) {
    if (ts.isCallExpression(parent) && canonicalOf(parent.expression, aliases) === 'proofOutcome' && parent.arguments[0] === child
      && (ts.isArrowFunction(child) || ts.isFunctionExpression(child)) && child !== node) return true
  }
  return false
}
function insideBackendTable(node, tables) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (ts.isVariableDeclaration(parent) && tables.includes(parent.name.getText())) return true
  }
  return false
}
const budgetName = target => ts.isPropertyAccessExpression(target) ? target.name.getText()
  : ts.isElementAccessExpression(target) ? literalKey(target.argumentExpression) : null
const zeroLiteral = node => (ts.isNumericLiteral(node) && node.text === '0') || (ts.isArrayLiteralExpression(node) && node.elements.length === 0)
const ASSIGNMENTS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken, ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])
const MUTATORS = new Set(['push', 'splice', 'pop', 'shift', 'unshift', 'fill', 'sort', 'reverse', 'copyWithin'])
const MERGERS = new Set(['Object.assign', 'Object.defineProperties'])
const SETTERS = new Set(['Reflect.set', 'Reflect.defineProperty', 'Object.defineProperty'])
/**
 * A budget field created at zero is fine only where a record is really CREATED: an object literal with no spread (a new
 * code, a fresh store) that is not merged into an existing object; or a MIGRATION DEFAULT, an `Object.assign(x, {...})`
 * guarded by `if (!Object.hasOwn(x, '<budget field>'))` on the same target (the field is added only where it is absent).
 * Anything else at zero is a reset: `Object.assign(state, { failures: 0 })`, `{ ...state, failures: 0 }`.
 */
function realInitialisation(literal, aliases) {
  if (literal.properties.some(property => ts.isSpreadAssignment(property))) return false
  const call = ts.isCallExpression(literal.parent) ? literal.parent : null
  if (call === null || !MERGERS.has(canonicalOf(call.expression, aliases) ?? '')) return true
  const statement = call.parent
  const guard = ts.isExpressionStatement(statement) && ts.isIfStatement(statement.parent) ? statement.parent.expression : null
  if (guard === null || !ts.isPrefixUnaryExpression(guard) || guard.operator !== ts.SyntaxKind.ExclamationToken || !ts.isCallExpression(guard.operand)) return false
  const [target, field] = guard.operand.arguments
  return canonicalOf(guard.operand.expression, aliases) === 'Object.hasOwn' && target?.getText() === call.arguments[0]?.getText()
    && field !== undefined && BUDGET_FIELDS.has(literalKey(field) ?? '') && call.arguments.indexOf(literal) === 1
}

/** A function literal or declaration's name in its file (a declaration, or a variable set to a function literal), or null. */
const functionName = node => {
  if (ts.isFunctionDeclaration(node) && node.name) return node.name.text
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && node.parent.initializer === node && ts.isIdentifier(node.parent.name)) return node.parent.name.text
  return null
}
const wrongLiteral = node => ts.isObjectLiteralExpression(node) && node.properties.some(property => ts.isPropertyAssignment(property)
  && (literalKey(property.name) ?? property.name.getText()) === 'kind' && literalKey(property.initializer) === 'wrong')
/**
 * Job 11 rule (c)'s two sets for one file, to a fixed point: COUNTING functions (countFailure, relayWrong, and every
 * function here whose body calls one) and WRONG-MAKERS (relayedWrong, and every function here whose body holds a
 * `{ kind: 'wrong' }` literal or calls one).
 * the sets hold NAMES AS VALUES, and every way a value travels in
 * a file is followed, to the same fixed point. The review makes that one mechanism, `flowInto`, used by
 * every binding form:
 *   - a variable or member set to a value (`const f = wrong`, `x = countFailure`, `holder.w = wrong`, `f ||= wrong`,
 *     `f ??= wrong`, `f &&= wrong`);
 *   - object and ARRAY literals, nested to any depth, hold their members (`{ inner: { wrong } }`, `[unavailable, wrong]`,
 *     `{ ['w']: wrong }`, a computed key that cannot be read is the member `[*]`, which matches any key), spread too;
 *   - destructuring of every shape, in declarations, ASSIGNMENTS (`({ wrong: f } = { wrong })`, `[f] = [wrong]`),
 *     PARAMETERS (`({ w }) => ...`, `([w]) => ...`, nested), with DEFAULTS (`{ f = wrong }`, `(fn = wrong) => ...`), holes
 *     and rests (a rest of an array holds any element as `[*]`);
 *   - a value handed to a function of this file (`run(wrong)`, through `.call` / `.apply` and spread arguments): its
 *     parameter holds it, inside that function only (a table per function, `params`), holders included;
 *   - `for (const f of list)` binds each element; `Object.assign(...)` / `Object.freeze(...)` hold their arguments' members;
 *   - a function's RESULT: `${name}()` holds what its returns hold (`const pick = () => wrong; pick()(...)`), and a function
 *     literal used as a value is counting or a maker by its own body (`h(() => wrong('verdict'))`);
 *   - `a ? wrong : b`, `a || wrong`, `a ?? wrong`.
 * Member access is normalised by canonicalOf (dot, bracket with a string or template literal, escapes as the parser reads
 * them, `?.`), and `f.call(...)` / `f.apply(...)` reach `f`. Names deeper than MAX_DEPTH segments are not followed (a
 * self-holding literal would otherwise grow forever); inspectHandler fails closed on what this cannot name.
 * @returns {{ counting: Set<string>, makers: Set<string>, kindOf: (node: ts.Node) => { counting: boolean, makers: boolean } }}
 */
const MAX_DEPTH = 8
function countingAndWrongMakers(file, aliases, seed = { counting: [], makers: [] }) {
  const counting = new Set(['countFailure', 'relayWrong', ...seed.counting]), makers = new Set(['relayedWrong', ...seed.makers])
  const sets = { counting, makers }
  /** Per table, the stored names that hold a `[*]` (the only ones another spelling can match). */
  const wild = new Map()
  const functions = [], byName = new Map(), params = new Map()
  const collect = node => {
    const name = functionName(node)
    if (name !== null) { functions.push([name, node]); byName.set(name, [...(byName.get(name) ?? []), node]) }
    ts.forEachChild(node, collect)
  }
  collect(file)
  const NONE = Object.freeze({ counting: false, makers: false }), MAKER = Object.freeze({ counting: false, makers: true })
  const either = (a, b) => ({ counting: a.counting || b.counting, makers: a.makers || b.makers })
  const isLogical = node => ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)
  const isFunctionValue = node => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isMethodDeclaration(node)
  /** A stored dotted name against a looked-up one, segment by segment; `[*]` (a key that cannot be read) matches any. */
  const segmentsMatch = (stored, wanted) => {
    const a = stored.split('.'), b = wanted.split('.')
    return a.length === b.length && a.every((part, index) => part === b[index] || part === '[*]' || b[index] === '[*]')
  }
  /** What a name is in one table (the file's sets, or one function's parameters). */
  const named = (name, where = sets) => {
    if (name === null || name === '') return NONE
    const wanted = [name, name.replace(/\.(?:call|apply)$/, '')]
    // Only a name with `[*]` on either side can match another spelling: look through all names only when asked for one.
    const candidates = kind => wanted.some(each => each.includes('[*]')) ? where[kind] : (wild.get(where)?.[kind] ?? [])
    const has = kind => wanted.some(each => where[kind].has(each)) || [...candidates(kind)].some(stored => wanted.some(each => segmentsMatch(stored, each)))
    return { counting: has('counting'), makers: has('makers') }
  }
  /** The parameter tables of the functions around `node`, innermost first. */
  const scopesOf = node => {
    const tables = []
    for (let scope = node.parent; scope; scope = scope.parent) { const own = params.get(scope); if (own) tables.push(own) }
    return tables
  }
  const tableOf = fn => { if (!params.has(fn)) params.set(fn, { counting: new Set(), makers: new Set() }); return params.get(fn) }
  /** A name as seen from `at`: the file's sets and the parameters of every function around it. */
  const lookup = (name, at) => scopesOf(at).reduce((kinds, table) => either(kinds, named(name, table)), named(name))
  /** What a function literal's body does: calls a counting function, makes a wrong. */
  const bodyKinds = fn => {
    let kinds = NONE
    const visit = node => {
      if (ts.isCallExpression(node)) kinds = either(kinds, kindOf(node.expression))
      if (wrongLiteral(node)) kinds = either(kinds, MAKER)
      ts.forEachChild(node, visit)
    }
    visit(fn.body ?? fn)
    return kinds
  }
  /** A function's own results (its returns, not those of functions inside it): the expressions. */
  const returnsOf = fn => {
    if (fn.body && !ts.isBlock(fn.body)) return [fn.body]
    const out = []
    const visit = node => {
      if (node !== fn.body && (isFunctionValue(node) || ts.isFunctionDeclaration(node))) return
      if (ts.isReturnStatement(node) && node.expression) out.push(node.expression)
      ts.forEachChild(node, visit)
    }
    if (fn.body) visit(fn.body)
    return out
  }
  /**
   * canonicalOf, and also a member chain rooted at a call of a named function: `pick()` is `pick()`, `box().wrong` is
   * `box().wrong` (the function's results are bound to `name()` by the flow below).
   */
  const nameOf = input => {
    const plain = canonicalOf(input, aliases)
    if (plain !== null) return plain
    const keys = []
    let node = unwrap(input)
    for (;;) {
      if (ts.isPropertyAccessExpression(node)) { keys.unshift(node.name.text); node = unwrap(node.expression) }
      else if (ts.isElementAccessExpression(node)) { keys.unshift(literalKey(node.argumentExpression) ?? '[*]'); node = unwrap(node.expression) }
      else break
    }
    if (!ts.isCallExpression(node)) return null
    const callee = canonicalOf(node.expression, aliases)
    return callee === null ? null : [`${callee.replace(/\.(?:call|apply)$/, '')}()`, ...keys].join('.')
  }
  const kindOf = input => {
    const node = unwrap(input)
    if (ts.isConditionalExpression(node)) return either(kindOf(node.whenTrue), kindOf(node.whenFalse))
    if (isLogical(node)) return either(kindOf(node.left), kindOf(node.right))
    if (isFunctionValue(node)) return bodyKinds(node)
    return lookup(nameOf(node), node)
  }
  let changed = true
  const addTo = (where, kinds, name) => {
    if (name === null || name === '' || name.split('.').length > MAX_DEPTH) return
    for (const kind of ['counting', 'makers']) if (kinds[kind] && !where[kind].has(name)) { where[kind].add(name); changed = true; if (name.includes('[*]')) { if (!wild.has(where)) wild.set(where, { counting: new Set(), makers: new Set() }); wild.get(where)[kind].add(name) } }
  }
  /** Every member `from` carries (in the file's sets or a parameter table around `at`), copied under `to`. */
  const copyMembers = (from, to, where, at) => {
    if (from === null || from === '' || to === null) return
    const prefix = from.split('.')
    for (const table of [sets, ...scopesOf(at)]) {
      for (const kind of ['counting', 'makers']) {
        for (const stored of [...table[kind]]) {
          const parts = stored.split('.')
          if (parts.length > prefix.length && segmentsMatch(parts.slice(0, prefix.length).join('.'), from)) addTo(where, kind === 'counting' ? { counting: true, makers: false } : MAKER, [to, ...parts.slice(prefix.length)].join('.'))
        }
      }
    }
  }
  const keyOf = property => property.name === undefined ? null : ts.isComputedPropertyName(property.name) ? (literalKey(property.name.expression) ?? '[*]') : (literalKey(property.name) ?? property.name.text ?? null)
  /** A literal's entries: [key, value node, spread?]. */
  const entriesOf = literal => {
    if (ts.isArrayLiteralExpression(literal)) {
      return literal.elements.flatMap((element, index) => ts.isOmittedExpression(element) ? [] : ts.isSpreadElement(element) ? [[null, element.expression, true]] : [[String(index), element, false]])
    }
    return literal.properties.flatMap(property => ts.isShorthandPropertyAssignment(property) ? [[property.name.text, property.name, false]]
      : ts.isPropertyAssignment(property) ? [[keyOf(property) ?? '[*]', property.initializer, false]]
      : ts.isSpreadAssignment(property) ? [[null, property.expression, true]]
      : ts.isMethodDeclaration(property) ? [[keyOf(property) ?? '[*]', property, false]] : [])
  }
  const isLiteral = node => ts.isObjectLiteralExpression(node) || ts.isArrayLiteralExpression(node)
  const HOLDING_CALLS = new Set(['Object.assign', 'Object.freeze'])
  /**
   * THE ONE FLOW: the value at `keys` inside expression `input` is bound to the name `target` in table `where` (the
   * file's sets, or one function's parameters): its own kinds, and every member it carries.
   */
  const flowInto = (where, target, input, keys = []) => {
    if (target === null || target === '' || target.split('.').length > MAX_DEPTH) return
    const node = unwrap(input)
    if (ts.isConditionalExpression(node)) { flowInto(where, target, node.whenTrue, keys); flowInto(where, target, node.whenFalse, keys); return }
    if (isLogical(node)) { flowInto(where, target, node.left, keys); flowInto(where, target, node.right, keys); return }
    if (ts.isCallExpression(node) && HOLDING_CALLS.has(canonicalOf(node.expression, aliases) ?? '')) { for (const argument of node.arguments) flowInto(where, target, argument, keys); return }
    if (isLiteral(node)) {
      const [key, ...rest] = keys
      for (const [entryKey, value, spread] of entriesOf(node)) {
        if (spread) flowInto(where, target, value, keys)
        else if (keys.length === 0) flowInto(where, `${target}.${entryKey}`, value)
        else if (key === '[*]' || entryKey === '[*]' || entryKey === key) flowInto(where, target, value, rest)
      }
      return
    }
    const base = nameOf(node)
    const from = base === null ? null : [base, ...keys].join('.')
    addTo(where, keys.length === 0 ? kindOf(node) : lookup(from, node), target)
    copyMembers(from, target, where, node)
  }
  /** A binding name (identifier, object or array pattern) bound to `sources` ([{ node, keys }]). */
  const bind = (name, sources, where) => {
    if (ts.isIdentifier(name)) { for (const { node, keys } of sources) flowInto(where, name.text, node, keys); return }
    const array = ts.isArrayBindingPattern(name)
    name.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element)) return
      if (element.dotDotDotToken) {
        if (!array) bind(element.name, sources, where)
        else if (ts.isIdentifier(element.name)) for (const { node, keys } of sources) flowInto(where, `${element.name.text}.[*]`, node, [...keys, '[*]'])
        return
      }
      const key = array ? String(index) : element.propertyName
        ? (ts.isComputedPropertyName(element.propertyName) ? (literalKey(element.propertyName.expression) ?? '[*]') : (literalKey(element.propertyName) ?? element.propertyName.text))
        : ts.isIdentifier(element.name) ? element.name.text : null
      if (key === null || key === undefined) return
      const inner = sources.map(({ node, keys }) => ({ node, keys: [...keys, key] }))
      if (element.initializer) inner.push({ node: element.initializer, keys: [] })
      bind(element.name, inner, where)
    })
  }
  /** An assignment target (identifier, member, or an object or array literal used as a pattern) bound to `sources`. */
  const bindAssign = (input, sources) => {
    let target = unwrap(input)
    if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) { sources = [...sources, { node: target.right, keys: [] }]; target = unwrap(target.left) }
    const under = key => sources.map(({ node, keys }) => ({ node, keys: [...keys, key] }))
    if (ts.isObjectLiteralExpression(target)) {
      for (const property of target.properties) {
        if (ts.isSpreadAssignment(property)) bindAssign(property.expression, sources)
        else if (ts.isShorthandPropertyAssignment(property)) bindAssign(property.name, property.objectAssignmentInitializer ? [...under(property.name.text), { node: property.objectAssignmentInitializer, keys: [] }] : under(property.name.text))
        else if (ts.isPropertyAssignment(property)) bindAssign(property.initializer, under(keyOf(property) ?? '[*]'))
      }
      return
    }
    if (ts.isArrayLiteralExpression(target)) {
      target.elements.forEach((element, index) => {
        if (ts.isOmittedExpression(element)) return
        if (ts.isSpreadElement(element)) { const rest = canonicalOf(element.expression, aliases); for (const { node, keys } of sources) flowInto(sets, rest === null ? null : `${rest}.[*]`, node, [...keys, '[*]']) }
        else bindAssign(element, under(String(index)))
      })
      return
    }
    for (const { node, keys } of sources) flowInto(sets, canonicalOf(target, aliases), node, keys)
  }
  const isFunctionLiteral = node => ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)
  const calleeFunctions = callee => {
    const node = unwrap(callee)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return [node]
    const name = canonicalOf(node, aliases)
    return name === null ? [] : (byName.get(name.replace(/\.(?:call|apply)$/, '')) ?? []).filter(isFunctionLiteral)
  }
  const ASSIGNS = new Set([ts.SyntaxKind.EqualsToken, ts.SyntaxKind.BarBarEqualsToken, ts.SyntaxKind.QuestionQuestionEqualsToken, ts.SyntaxKind.AmpersandAmpersandEqualsToken])
  while (changed) {
    changed = false
    for (const [name, fn] of functions) { addTo(sets, bodyKinds(fn), name); for (const result of returnsOf(fn)) flowInto(sets, `${name}()`, result) }
    const flow = node => {
      if (ts.isVariableDeclaration(node) && node.initializer) bind(node.name, [{ node: node.initializer, keys: [] }], sets)
      if (ts.isBinaryExpression(node) && ASSIGNS.has(node.operatorToken.kind)) bindAssign(node.left, [{ node: node.right, keys: [] }])
      if (ts.isForOfStatement(node)) {
        const each = [{ node: node.expression, keys: ['[*]'] }]
        if (ts.isVariableDeclarationList(node.initializer)) for (const declaration of node.initializer.declarations) bind(declaration.name, each, sets)
        else bindAssign(node.initializer, each)
      }
      if (ts.isParameter(node) && node.initializer) bind(node.name, [{ node: node.initializer, keys: [] }], tableOf(node.parent))
      if (ts.isCallExpression(node)) {
        const callee = unwrap(node.expression)
        const method = ts.isPropertyAccessExpression(callee) ? callee.name.text : null
        const forwarded = method === 'call' || method === 'apply'
        const args = forwarded ? node.arguments.slice(1) : [...node.arguments]
        const spreadAt = args.findIndex(argument => ts.isSpreadElement(argument))
        const sourcesAt = index => method === 'apply' ? (args[0] === undefined ? [] : [{ node: args[0], keys: [String(index)] }])
          : spreadAt !== -1 && index >= spreadAt ? [...(index < args.length && !ts.isSpreadElement(args[index]) ? [{ node: args[index], keys: [] }] : []), ...args.slice(spreadAt).filter(argument => ts.isSpreadElement(argument)).map(argument => ({ node: argument.expression, keys: ['[*]'] }))]
          : args[index] === undefined ? [] : [{ node: args[index], keys: [] }]
        for (const fn of calleeFunctions(node.expression)) {
          fn.parameters.forEach((parameter, index) => {
            if (parameter.dotDotDotToken) {
              if (ts.isIdentifier(parameter.name)) for (let rest = index; rest < Math.max(args.length, index + 1); rest++) for (const { node: value, keys } of sourcesAt(rest)) flowInto(tableOf(fn), `${parameter.name.text}.[*]`, value, keys)
              return
            }
            bind(parameter.name, sourcesAt(index), tableOf(fn))
          })
        }
      }
      ts.forEachChild(node, flow)
    }
    flow(file)
  }
  return { counting, makers, kindOf }
}
/**
 * the counting functions and wrong-makers another file EXPORTS, by exported name (declarations, `export {
 * a as b }`, `export ... from`, `export *`), followed through that file's own imports. proofOutcome is never seeded into
 * another file: it is THE JUDGE, and a wrong it makes is a verifier's verdict (rule (d) keeps its callback honest).
 */
const JUDGE = new Set(['proofOutcome'])
const EXPORTS_SEEN = new Map()
function exportsOf(name, sources, visiting = new Set()) {
  const none = { counting: new Set(), makers: new Set() }
  if (visiting.has(name)) return none
  const memo = name + '\0' + Object.keys(sources ?? {}).sort().map(key => key + '=' + sources[key]).join('\0')
  if (!EXPORTS_SEEN.has(memo)) EXPORTS_SEEN.set(memo, exportsOfUncached(name, sources, visiting))
  return EXPORTS_SEEN.get(memo)
}
function exportsOfUncached(name, sources, visiting) {
  const none = { counting: new Set(), makers: new Set() }
  const text = sources?.[name] ?? (readdirSync(SRC).includes(name) ? readFileSync(join(SRC, name), 'utf8') : null)
  if (text === null) return none
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const aliases = aliasesOf(file)
  const { counting, makers } = countingAndWrongMakers(file, aliases, importedSeed(file, sources, new Set([...visiting, name])))
  const out = { counting: new Set(), makers: new Set() }
  const give = (local, exported, from = { counting, makers }) => {
    if (from.counting.has(local)) out.counting.add(exported)
    if (from.makers.has(local)) out.makers.add(exported)
  }
  const exported = node => node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)
  for (const statement of file.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && exported(statement)) give(statement.name.text, statement.name.text)
    if (ts.isVariableStatement(statement) && exported(statement)) {
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) give(declaration.name.text, declaration.name.text)
    }
    if (ts.isExportDeclaration(statement)) {
      const from = statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier) && /^\.\/[^/]+\.mjs$/.test(statement.moduleSpecifier.text)
        ? exportsOf(statement.moduleSpecifier.text.slice(2), sources, new Set([...visiting, name])) : null
      if (statement.moduleSpecifier && from === null) continue
      if (!statement.exportClause && from !== null) { for (const kind of ['counting', 'makers']) for (const each of from[kind]) out[kind].add(each) }
      else if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) give((specifier.propertyName ?? specifier.name).text, specifier.name.text, from ?? { counting, makers })
      }
    }
  }
  for (const judge of JUDGE) { out.counting.delete(judge); out.makers.delete(judge) }
  return out
}
/** The names this file imports from another file of SRC that are counting functions or wrong-makers there. */
function importedSeed(file, sources, visiting = new Set([file.fileName])) {
  const seed = { counting: [], makers: [] }
  for (const statement of file.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier) || !/^\.\/[^/]+\.mjs$/.test(statement.moduleSpecifier.text)) continue
    const clause = statement.importClause?.namedBindings
    if (!clause) continue
    const theirs = exportsOf(statement.moduleSpecifier.text.slice(2), sources, visiting)
    for (const kind of ['counting', 'makers']) {
      // A namespace import's members read as their own names (aliasesOf maps the namespace to '').
      if (ts.isNamespaceImport(clause)) for (const each of theirs[kind]) seed[kind].push(each, `${clause.name.text}.${each}`)
      else for (const specifier of clause.elements) {
        const imported = (specifier.propertyName ?? specifier.name).text
        if (theirs[kind].has(imported)) seed[kind].push(imported, specifier.name.text)
      }
    }
  }
  return seed
}
/** Job 11 rule (c)'s handlers: a catch clause's block, a `.catch(fn)` callback, a `.then(_, fn)` rejection callback. */
const catchHandlers = node => {
  if (ts.isCatchClause(node)) return [node.block]
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
    const method = node.expression.name.text, handler = method === 'catch' ? node.arguments[0] : method === 'then' ? node.arguments[1] : undefined
    if (handler !== undefined && (ts.isArrowFunction(handler) || ts.isFunctionExpression(handler) || ts.isIdentifier(handler) || ts.isPropertyAccessExpression(handler) || ts.isElementAccessExpression(handler))) return [handler]
  }
  return []
}
/**
 * Job 11 rule (d): the callback's result is the verifier's own (a verifier call, or the code-hash comparison), nothing made
 * from it. An expression body is that call; a block is variable declarations ending in its one `return` of that call.
 */
function returnsVerifierResult(fn, aliases) {
  const own = expression => {
    const node = unwrap(expression)
    if (ts.isCallExpression(node)) return VERIFIER_NAME.test(canonicalOf(node.expression, aliases) ?? '')
    return ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsEqualsEqualsToken
      && (PROOF_COMPARISON.test(node.left.getText()) || PROOF_COMPARISON.test(node.right.getText()))
  }
  if (!ts.isBlock(fn.body)) return own(fn.body)
  const statements = fn.body.statements, last = statements.at(-1)
  if (!last || !ts.isReturnStatement(last) || !last.expression || !own(last.expression) || !statements.slice(0, -1).every(statement => ts.isVariableStatement(statement))) return false
  let returns = 0
  const visit = node => {
    if (node !== fn.body && (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node))) return
    if (ts.isReturnStatement(node)) returns++
    ts.forEachChild(node, visit)
  }
  visit(fn.body)
  return returns === 1
}

/**
 * The violations in one file's source. `verifier`: a verification primitive referenced (called, read, bound, destructured)
 * outside proofOutcome's callback; a proofOutcome whose first argument is not a function literal; a proofOutcome callback
 * that checks nothing (it would brand an answer no verifier gave). `budget`: a budget field written (assigned,
 * incremented, mutated, set by Reflect or defineProperty, created with anything but 0 or [], created by shorthand, reset
 * through a spread or a merge), a gate failure recorded or requested, or the relay used or spelled outside its one site.
 * @param {string} name The file's name (decides the counting file, store files, plumbing, backend tables, relay sites).
 * @param {string} text Its source.
 * @returns {Array<[string, string, string]>} [name, kind, the offending expression's source text].
 */
export function scanSource(name, text, sources = {}) {
  const file = ts.createSourceFile(name, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const found = [], tables = BACKEND_TABLES[name] ?? [], plumbing = STORE_PLUMBING[name] ?? []
  const counting = name === COUNTING_FILE, store = STORE_FILES.has(name)
  const aliases = aliasesOf(file)
  const { kindOf } = countingAndWrongMakers(file, aliases, importedSeed(file, { ...sources, [name]: text }))
  const reaches = node => { const kinds = kindOf(node); return kinds.counting || kinds.makers }
  const lineOf = node => text.split('\n')[file.getLineAndCharacterOfPosition(node.getStart()).line].trim()
  const allowedVerifier = node => insideProofOutcome(node, aliases) || insideBackendTable(node, tables)
  const verifierAt = node => {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      if (!VERIFIER_NAME.test(canonicalOf(node, aliases) ?? '')) return false
      // Report the outermost verifier reference only (`crypto.subtle.verify` once, not again as part of `.call`).
      return true
    }
    if (ts.isIdentifier(node) && !declaresOnly(node)) return VERIFIER_NAME.test(canonicalOf(node, aliases) ?? '')
    if (ts.isShorthandPropertyAssignment(node)) return VERIFIER_NAME.test(canonicalOf(node.name, aliases) ?? '')
    return false
  }
  const checksSomething = fn => {
    let checks = false
    const visit = node => {
      if (verifierAt(node) || (ts.isBinaryExpression(node) && (PROOF_COMPARISON.test(node.left.getText()) || PROOF_COMPARISON.test(node.right.getText())))) checks = true
      if (!checks) ts.forEachChild(node, visit)
    }
    visit(fn.body)
    return checks
  }
  /**
   * FAIL CLOSED on a callee nobody can name. Inside a catch handler, a call is a finding when its
   * callee is reached by a key that cannot be read (`outcomes['wr' + 'ong'](...)`, `holder[key](...)`), when it is a member
   * of a value that is neither a name nor a literal of plain constants (`[wrong][0](...)`, `[pick()][0](...)`,
   * `new Box().wrong(...)`), or when it hangs off `Object.assign(...)` / `Object.freeze(...)` (they hand back their
   * arguments). A name, `this`, a function of this file's result (`pick()(...)`, `box().wrong(...)`, read through what it
   * returns) and a method of a literal of constants (`['A', 'B'].includes(code)`, `/^X/.test(code)`) are named.
   * NOT FOLLOWED (said, not hidden): what a function OUTSIDE this file hands back (`reader.cancel().catch(...)`, `String(x)
   * .slice(...)`): a value of this file stored into an outside object earlier and fetched back in a catch is not seen.
   */
  const constantLiteral = node => ts.isStringLiteral(node) || ts.isNumericLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isRegularExpressionLiteral(node)
    || [ts.SyntaxKind.TrueKeyword, ts.SyntaxKind.FalseKeyword, ts.SyntaxKind.NullKeyword].includes(node.kind)
    || (ts.isArrayLiteralExpression(node) && node.elements.every(element => constantLiteral(unwrap(element))))
  const unnamedCallee = callee => {
    let node = unwrap(callee)
    if (ts.isConditionalExpression(node)) return unnamedCallee(node.whenTrue) || unnamedCallee(node.whenFalse)
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(node.operatorToken.kind)) return unnamedCallee(node.left) || unnamedCallee(node.right)
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node)) return false
    for (;;) {
      if (ts.isPropertyAccessExpression(node)) node = unwrap(node.expression)
      else if (ts.isElementAccessExpression(node)) { if (literalKey(node.argumentExpression) === null) return true; node = unwrap(node.expression) }
      else break
    }
    if (ts.isIdentifier(node) || [ts.SyntaxKind.ThisKeyword, ts.SyntaxKind.SuperKeyword, ts.SyntaxKind.ImportKeyword].includes(node.kind) || constantLiteral(node)) return false
    if (ts.isCallExpression(node)) return ['Object.assign', 'Object.freeze'].includes(canonicalOf(node.expression, aliases) ?? '') || unnamedCallee(node.expression)
    return true
  }
  // Job 11 rule (c): inside any catch handler, no counting call, no wrong-maker, no `{ kind: 'wrong' }` (in every file).
  // nor any REFERENCE to one (handed on, `Reflect.apply(wrong, ...)`, `[wrong]`, `{ wrong }`),
  // nor a call of a callee nobody can name (unnamedCallee).
  const inspectHandler = handler => {
    const visitHandler = node => {
      if (ts.isCallExpression(node) && (reaches(node.expression) || unnamedCallee(node.expression))) found.push([name, 'catch', node.getText()])
      if (node === handler && !ts.isBlock(node) && !ts.isArrowFunction(node) && !ts.isFunctionExpression(node) && reaches(node)) found.push([name, 'catch', node.getText()])
      if (node !== handler && ((ts.isIdentifier(node) && !declaresOnly(node)) || ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && reaches(node)) found.push([name, 'catch', node.getText()])
      if (wrongLiteral(node)) found.push([name, 'catch', node.getText()])
      ts.forEachChild(node, visitHandler)
    }
    visitHandler(handler)
  }
  const visit = node => {
    for (const handler of catchHandlers(node)) inspectHandler(handler)
    if (verifierAt(node) && !allowedVerifier(node)) {
      // A shorthand `{ verify }` reports once (its name is also an identifier).
      if (!(ts.isIdentifier(node) && ts.isShorthandPropertyAssignment(node.parent))) found.push([name, 'verifier', node.getText()])
    }
    // `const { verify } = crypto.subtle` (or any destructuring that takes a verifier out of a holder).
    if (ts.isBindingElement(node) && ts.isIdentifier(node.name) && VERIFIER_NAME.test(aliases.get(node.name.text) ?? '') && !allowedVerifier(node)) {
      const declaration = node.parent.parent
      if (ts.isVariableDeclaration(declaration) && declaration.initializer && canonicalOf(declaration.initializer, aliases) !== null) found.push([name, 'verifier', node.getText()])
    }
    if (ts.isCallExpression(node)) {
      const callee = canonicalOf(node.expression, aliases)
      if (callee === 'proofOutcome' && !counting) {
        const run = node.arguments[0]
        if (!run || !(ts.isArrowFunction(run) || ts.isFunctionExpression(run))) found.push([name, 'verifier', node.getText()])
        else if (!checksSomething(run)) found.push([name, 'verifier', node.getText()])
        // Job 11 rule (d): the verifier's own result, returned as it is.
        else if (!returnsVerifierResult(run, aliases)) found.push([name, 'verifier', node.getText()])
      }
      for (const end of ['relayWrong', 'relayedWrong']) {
        if (callee === end && !counting && !(RELAY_SITES[end][name] ?? []).some(line => lineOf(node).startsWith(line))) found.push([name, 'budget', node.getText()])
      }
      if (!counting && !store && /(?:^|\.)recordFailure$/.test(callee ?? node.expression.getText()) && !plumbing.some(line => lineOf(node).startsWith(line))) found.push([name, 'budget', node.getText()])
      // A gate failure REQUESTED (an action argument 'failure') needs the relay's claim beside it.
      if (!counting && !store && node.arguments.some(argument => literalKey(argument) === 'failure')
        && !node.arguments.some(argument => ts.isCallExpression(argument) && canonicalOf(argument.expression, aliases) === 'relayWrong')) found.push([name, 'budget', node.getText()])
      if (!counting && !store && ts.isPropertyAccessExpression(node.expression) && MUTATORS.has(node.expression.name.getText())
        && BUDGET_FIELDS.has(budgetName(node.expression.expression) ?? '')) found.push([name, 'budget', node.getText()])
      if (!counting && !store && SETTERS.has(callee ?? '') && BUDGET_FIELDS.has(literalKey(node.arguments[1] ?? node) ?? '')) found.push([name, 'budget', node.getText()])
    }
    if (ts.isBinaryExpression(node) && [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken].includes(node.operatorToken.kind)
      && (PROOF_COMPARISON.test(node.left.getText()) || PROOF_COMPARISON.test(node.right.getText())) && !insideProofOutcome(node, aliases)) found.push([name, 'verifier', node.getText()])
    if (!counting && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) && RELAY_CLAIMS.some(claim => node.text.includes(claim))) found.push([name, 'budget', node.getText()])
    if (!counting && !store) {
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) && BUDGET_FIELDS.has(budgetName(node.left) ?? '')
        && !(MIRRORS[name] ?? []).includes(node.getText())) found.push([name, 'budget', node.getText()])
      // A destructuring assignment whose targets include a budget field (`[state.failures] = ...`, `({ a: state.misses } = ...)`).
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && (ts.isArrayLiteralExpression(node.left) || ts.isObjectLiteralExpression(node.left))) {
        const targets = []
        const collect = child => { if ((ts.isPropertyAccessExpression(child) || ts.isElementAccessExpression(child)) && BUDGET_FIELDS.has(budgetName(child) ?? '')) targets.push(child); ts.forEachChild(child, collect) }
        collect(node.left)
        if (targets.length) found.push([name, 'budget', node.getText()])
      }
      if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.operator)
        && BUDGET_FIELDS.has(budgetName(node.operand) ?? '')) found.push([name, 'budget', node.getText()])
      // A record CREATED with a budget field: only at zero, and only at a real initialisation site (realInitialisation).
      if (ts.isPropertyAssignment(node) && BUDGET_FIELDS.has(literalKey(node.name) ?? node.name.getText()) && ts.isObjectLiteralExpression(node.parent)
        && !(zeroLiteral(node.initializer) && realInitialisation(node.parent, aliases))) found.push([name, 'budget', node.getText()])
      // A budget field by shorthand (`{ ...state, failures }`): its value cannot be read here, so it is never a creation at zero.
      if (ts.isShorthandPropertyAssignment(node) && BUDGET_FIELDS.has(node.name.text)) found.push([name, 'budget', node.getText()])
      // A computed key that cannot be read by name, in a literal beside a spread or merged into an object (a hidden reset).
      if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name) && literalKey(node.name.expression) === null && ts.isObjectLiteralExpression(node.parent)
        && !realInitialisation(node.parent, aliases)) found.push([name, 'budget', node.getText()])
      if (ts.isPropertyAssignment(node) && ts.isComputedPropertyName(node.name) && BUDGET_FIELDS.has(literalKey(node.name.expression) ?? '') && ts.isObjectLiteralExpression(node.parent)
        && !(zeroLiteral(node.initializer) && realInitialisation(node.parent, aliases))) found.push([name, 'budget', node.getText()])
      // Dynamic writes (`state[count] = ...`) cannot be read by name: refused outright in identity files.
      if (ts.isBinaryExpression(node) && ASSIGNMENTS.has(node.operatorToken.kind) && ts.isElementAccessExpression(node.left)
        && literalKey(node.left.argumentExpression) === null
        && /^(?:state|entry|pending|record)$/.test(node.left.expression.getText())) found.push([name, 'budget', node.getText()])
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  return found
}

const read = name => readFileSync(join(SRC, name), 'utf8')

test('every file in deploy/cloudflare/src that calls a verification primitive is classified: owner identity (scanned) or not, with the reason', () => {
  const calling = readdirSync(SRC).filter(name => name.endsWith('.mjs')).filter(name => {
    const file = ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
    let calls = false
    const aliases = aliasesOf(file)
    const visit = node => { if (ts.isCallExpression(node) && VERIFIER_NAME.test(canonicalOf(node.expression, aliases) ?? '')) calls = true; if (!calls) ts.forEachChild(node, visit) }
    visit(file)
    return calls
  }).sort()
  const unclassified = calling.filter(name => !IDENTITY_FILES.includes(name) && !Object.hasOwn(NOT_IDENTITY, name))
  assert.deepEqual(unclassified, [], 'a file calls a verifier and is in neither list: decide whether it takes part in owner identity')
  for (const name of IDENTITY_FILES) assert.ok(readdirSync(SRC).includes(name), name)
})

test('THE SCAN: in every owner-identity file, verifiers are called only inside proofOutcome, and budgets move only in proof-failure-rule.mjs (open items listed exactly)', () => {
  const found = IDENTITY_FILES.flatMap(name => scanSource(name, read(name)))
  const key = ([name, kind, text]) => `${name} ${kind} ${text.replace(/\s+/g, ' ')}`
  assert.deepEqual(found.map(key).sort(), OPEN.map(key).sort())
})

test('THE SCAN BITES: a bare `if (await crypto.subtle.verify(...))` and a direct `state.failures++` added to aumlok.mjs are both caught; so are the other forms', () => {
  const source = read('aumlok.mjs')
  assert.deepEqual(scanSource('aumlok.mjs', source), [])
  const anchor = 'export const AUMLOK_STORAGE_KEY'
  assert.ok(source.includes(anchor))
  const inject = code => source.replace(anchor, code + '\n' + anchor)
  const cases = [
    ['a bare verify in an if', "async function bare(key, sig, data) { if (await crypto.subtle.verify('HMAC', key, sig, data)) return 1 }", 'verifier'],
    ['a direct failures++', 'function direct(state) { state.failures++ }', 'budget'],
    ['a verify beside proofOutcome, not in its callback', "async function beside(key, sig, data) { const v = await crypto.subtle.verify('Ed25519', key, sig, data); return proofOutcome(async () => v, { code: 'X' }) }", 'verifier'],
    ['the WebAuthn library called bare', 'async function lib(r) { return (await verifyAuthenticationResponse(r)).verified }', 'verifier'],
    ['a code-hash comparison outside proofOutcome', 'function code(pending, codeHash) { return pending.codeHash === codeHash }', 'verifier'],
    ['a miss counted by hand', 'function miss(pending) { pending.misses += 1 }', 'budget'],
    ['a history pushed', 'function push(state, at) { state.failedAt.push(at) }', 'budget'],
    ['a lock set', 'function lock(entry) { entry.lockedUntil = Date.now() + 1 }', 'budget'],
    ['a dynamic budget write', "function dyn(state, count) { state[count] = 1 }", 'budget'],
    ['a gate failure recorded', 'async function gate(store, subject) { return store.recordFailure(subject) }', 'budget'],
    ['a record created with a non-zero budget', 'const seeded = () => ({ failures: 3 })', 'budget'],
  ]
  for (const [name, code, kind] of cases) {
    const found = scanSource('aumlok.mjs', inject(code))
    assert.equal(found.length >= 1, true, name)
    assert.ok(found.every(([, foundKind]) => foundKind === kind), `${name}: ${JSON.stringify(found)}`)
  }
  // Inside proofOutcome's callback the same call is fine; a fresh record at zero is fine.
  assert.deepEqual(scanSource('aumlok.mjs', inject("async function fine(key, sig, data) { return proofOutcome(() => crypto.subtle.verify('HMAC', key, sig, data), { code: 'X' }) }")), [])
  assert.deepEqual(scanSource('aumlok.mjs', inject('const fresh = () => ({ failures: 0, failedAt: [], misses: 0 })')), [])
})

test('THE SCAN BITES an earlier review\'s walk-arounds: renamed, namespaced, destructured, bracketed and bound verifiers; a verdict computed before proofOutcome; shorthand, spread, merged and Reflect budget writes; the relay outside its site', () => {
  const source = read('aumlok.mjs'), anchor = 'export const AUMLOK_STORAGE_KEY'
  const inject = code => source.replace(anchor, code + '\n' + anchor)
  const claim = RELAY_CLAIMS[0]
  const cases = [
    // Verifiers, however they are reached.
    ['a renamed WebAuthn import', "import { verifyAuthenticationResponse as check } from '@simplewebauthn/server'\nasync function renamed(r) { return (await check(r)).verified }", 'verifier'],
    ['a namespace import', "import * as webauthn from '@simplewebauthn/server'\nasync function spaced(r) { return (await webauthn.verifyRegistrationResponse(r)).verified }", 'verifier'],
    ['a renamed noble import', "import { ed25519 as curve } from '@noble/curves/ed25519'\nfunction noble(s, m, k) { return curve.verify(s, m, k) }", 'verifier'],
    ['verify destructured from crypto.subtle', "async function pulled(k, s, d) { const { verify } = crypto.subtle; return verify.call(crypto.subtle, 'HMAC', k, s, d) }", 'verifier'],
    ['verify destructured and renamed', "async function renamedPull(k, s, d) { const { verify: v } = crypto.subtle; return v('HMAC', k, s, d) }", 'verifier'],
    ['subtle destructured from crypto', "async function holder(k, s, d) { const { subtle } = crypto; return subtle.verify('HMAC', k, s, d) }", 'verifier'],
    ['subtle by alias', "async function aliased(k, s, d) { const box = globalThis.crypto.subtle; return box.verify('HMAC', k, s, d) }", 'verifier'],
    ['bracket access', "async function bracket(k, s, d) { return crypto.subtle['verify']('HMAC', k, s, d) }", 'verifier'],
    ['a computed member of subtle', "async function computed(k, s, d, m) { return crypto['subtle'][m]('HMAC', k, s, d) }", 'verifier'],
    ['a bound verifier', "const bound = crypto.subtle.verify.bind(crypto.subtle)\nasync function useBound(k, s, d) { return bound('HMAC', k, s, d) }", 'verifier'],
    ['verification run before proofOutcome', "async function early(k, s, d) { return proofOutcome(await crypto.subtle.verify('HMAC', k, s, d), { code: 'X' }) }", 'verifier'],
    ['a callback that is not a function literal', "async function handed(run) { return proofOutcome(run, { code: 'X' }) }", 'verifier'],
    ['a callback that checks nothing (a brand without a verifier)', "async function minted() { return proofOutcome(() => false, { code: 'AUMLOK_PROOF_INVALID' }) }", 'verifier'],
    ['proofOutcome renamed, verification outside it', "import { proofOutcome as judge } from './proof-failure-rule.mjs'\nasync function judged(k, s, d) { const v = await crypto.subtle.verify('HMAC', k, s, d); return judge(() => v, { code: 'X' }) }", 'verifier'],
    // Budgets, however they are written.
    ['a shorthand budget in a spread', 'function shorthand(state) { const failures = state.failures + 1; return { ...state, failures } }', 'budget'],
    ['a shorthand budget in Object.assign', 'function shorthandAssign(state) { const failures = 9; Object.assign(state, { failures }) }', 'budget'],
    ['a reset through Object.assign', 'function reset(state) { Object.assign(state, { failures: 0, failedAt: [], nextAllowedAt: 0 }) }', 'budget'],
    ['a reset through a spread', 'function resetSpread(state) { return { ...state, failures: 0 } }', 'budget'],
    ['a reset through Object.assign with a guard on another field', "function wrongGuard(state) { if (!Object.hasOwn(state, 'devices')) Object.assign(state, { failures: 0 }) }", 'budget'],
    ['an increment through Object.assign', 'function bump(state) { Object.assign(state, { failures: state.failures + 1 }) }', 'budget'],
    ['Reflect.set', "function reflected(state) { Reflect.set(state, 'failures', 0) }", 'budget'],
    ['Object.defineProperty', "function defined(state) { Object.defineProperty(state, 'misses', { value: 0 }) }", 'budget'],
    ['a destructuring assignment', 'function destructured(state, next) { [state.failures] = next }', 'budget'],
    ['a template-literal key', 'function templated(state) { state[`failures`] = 0 }', 'budget'],
    ['a computed reset key beside a spread', "function hidden(state, key) { return { ...state, [key]: 0 } }", 'budget'],
    // The relay: only at its one site each, and its text nowhere else.
    ['relayedWrong outside HEAD\'s gate route', "async function relay(store, s, p) { return countFailure(relayedWrong(p), { kind: 'gate', store, subject: s }) }", 'budget'],
    ['relayWrong outside the login door', 'function claimed(o) { return relayWrong(o) }', 'budget'],
    ['the claim spelled out', `const forged = { action: 'failure', proof: ${JSON.stringify(claim)} }`, 'budget'],
    ['a gate failure requested without the relay', "async function asked(ask) { return ask('failure') }", 'budget'],
  ]
  for (const [name, code, kind] of cases) {
    const found = scanSource('aumlok.mjs', inject(code))
    assert.equal(found.length >= 1, true, name)
    assert.ok(found.every(([, foundKind]) => foundKind === kind), `${name}: ${JSON.stringify(found)}`)
  }
  // The real initialisation sites stay allowed: a migration default guarded by its own absent field, a fresh literal.
  assert.deepEqual(scanSource('aumlok.mjs', inject("function migrate(state) { if (!Object.hasOwn(state, 'phraseFailures')) Object.assign(state, { phraseFailures: 0, phraseFailedAt: [] }) }")), [])
  assert.deepEqual(scanSource('aumlok.mjs', inject('function fresh2() { const record = { misses: 0, lockedUntil: 0 }; return record }')), [])
  // The relay's two sites are allowed exactly where they are, and only there.
  assert.deepEqual(scanSource('worker.mjs', read('worker.mjs')), [])
  assert.deepEqual(scanSource('head-do.mjs', read('head-do.mjs')), [])
  assert.ok(scanSource('head-do.mjs', read('head-do.mjs').replace('relayedWrong(input.proof) : null', 'relayedWrong(input.proof) : relayedWrong(input.other)')).length >= 1)
  // relayedWrong reads exactly the claim, nothing near it.
  assert.equal(proofIs(relayedWrong(claim), 'wrong'), true)
  for (const near of [undefined, null, '', claim + ' ', claim.toUpperCase(), { claim }, [claim], 'OWNER_LOGIN_SIGNATURE_INVALID']) assert.equal(relayedWrong(near), null, JSON.stringify(near))
})

test('THE SCAN BITES rule (c): a catch that counts, relays or makes a wrong outcome is caught, however it is reached; the old exception-to-wrong line of proofOutcome is caught', () => {
  const aumlok = read('aumlok.mjs'), anchor = 'export const AUMLOK_STORAGE_KEY'
  const inject = code => aumlok.replace(anchor, code + '\n' + anchor)
  const cases = [
    ['countFailure in a catch block', "async function counted(state, at, outcome) { try { settleProof(outcome) } catch (error) { countFailure(proofOf(error), { kind: 'aumlok', state, at, limits: AUMLOK_LIMITS }) } }"],
    ['a local helper that counts, called in a catch block', "const tally = (outcome, state, at) => countFailure(outcome, { kind: 'aumlok', state, at, limits: AUMLOK_LIMITS })\nasync function viaHelper(state, at, outcome) { try { settleProof(outcome) } catch (error) { tally(proofOf(error), state, at) } }"],
    ['a helper two steps from countFailure', "const inner = (o, p) => countFailure(o, { kind: 'device-code', pending: p })\nconst outer = (o, p) => inner(o, p)\nasync function deep(o, p) { try { settleProof(o) } catch (e) { return outer(proofOf(e), p) } }"],
    ['a promise .catch that counts', "function promised(p, pending) { return p.catch(error => countFailure(proofOf(error), { kind: 'device-code', pending })) }"],
    ['a .then rejection callback that counts', "function rejected(p, pending) { return p.then(null, error => countFailure(proofOf(error), { kind: 'device-code', pending })) }"],
    ['a catch block that makes a wrong-looking outcome literal', "async function minted(run) { try { return await run() } catch (error) { return Object.freeze({ kind: 'wrong', code: 'AUMLOK_PROOF_INVALID', status: 403 }) } }"],
  ]
  for (const [name, code] of cases) {
    const found = scanSource('aumlok.mjs', inject(code))
    assert.ok(found.some(([, kind]) => kind === 'catch'), `${name}: ${JSON.stringify(found)}`)
  }
  // The exact line job 11 removed from proofOutcome (the library's selected throws branded `wrong`), put back: caught.
  const rule = read('proof-failure-rule.mjs')
  assert.deepEqual(scanSource('proof-failure-rule.mjs', rule).filter(([, kind]) => kind === 'catch'), [])
  const reverted = rule.replace('try { answer = await run() } catch (_error) { return unavailable() }',
    "try { answer = await run() } catch (error) { if (judge !== 'boolean' && /^Unexpected/.test(String(error?.message))) return wrong('verdict'); return unavailable() }")
  assert.notEqual(reverted, rule, 'the anchor line is in proof-failure-rule.mjs')
  const caught = scanSource('proof-failure-rule.mjs', reverted)
  assert.ok(caught.some(([, kind, text]) => kind === 'catch' && text.startsWith('wrong(')), JSON.stringify(caught))
  // Reading a branded outcome in a catch (proofOf) and counting it AFTER the catch is the allowed shape.
  assert.deepEqual(scanSource('aumlok.mjs', inject("async function after(state, at, outcome) { let judged = null; try { settleProof(outcome) } catch (error) { judged = proofOf(error) } if (judged !== null) countFailure(judged, { kind: 'aumlok', state, at, limits: AUMLOK_LIMITS }) }")), [])
})

test('THE SCAN BITES rule (d), the review\'s finding: a verifier result transformed before proofOutcome sees it is caught (!!await, Boolean, a ternary on === false, .verified, .then, a check then a constant)', () => {
  const aumlok = read('aumlok.mjs'), anchor = 'export const AUMLOK_STORAGE_KEY'
  const inject = code => aumlok.replace(anchor, code + '\n' + anchor)
  const cases = [
    ['the reviewer\'s !!await mutation', "async function coerced(k, s, d) { return proofOutcome(async () => !!await crypto.subtle.verify('HMAC', k, s, d), { code: 'X' }) }"],
    ['Boolean(...)', "async function boxed(k, s, d) { return proofOutcome(async () => Boolean(await crypto.subtle.verify('HMAC', k, s, d)), { code: 'X' }) }"],
    ['=== false ? ... : ...', "async function flipped(k, s, d) { return proofOutcome(async () => (await crypto.subtle.verify('HMAC', k, s, d)) === false ? false : true, { code: 'X' }) }"],
    ['the reviewer\'s check-then-constant callback', "async function constant(k, s, d) { return proofOutcome(async () => { await crypto.subtle.verify('HMAC', k, s, d); return false }, { code: 'X' }) }"],
    ['an if that returns constants', "async function branched(k, s, d) { return proofOutcome(async () => { if (await crypto.subtle.verify('HMAC', k, s, d)) return true; return false }, { code: 'X' }) }"],
    ['the result passed through a variable (not returned as it is)', "async function kept(k, s, d) { return proofOutcome(async () => { const ok = await crypto.subtle.verify('HMAC', k, s, d); return ok }, { code: 'X' }) }"],
    ['the library result\'s .verified', "async function field(r) { return proofOutcome(async () => (await verifyAuthenticationResponse(r)).verified, { code: 'X', judge: 'webauthn-authentication' }) }"],
    ['a .then on the verifier', "async function chained(r) { return proofOutcome(() => verifyAuthenticationResponse(r).then(answer => ({ ...answer, verified: true })), { code: 'X', judge: 'webauthn-authentication' }) }"],
    ['a comma after the verifier', "async function comma(k, s, d) { return proofOutcome(async () => (await crypto.subtle.verify('HMAC', k, s, d), true), { code: 'X' }) }"],
    ['the code-hash comparison negated', "async function negated(pending, codeHash) { return proofOutcome(async () => !(pending.codeHash !== codeHash), { code: 'X' }) }"],
  ]
  for (const [name, code] of cases) {
    const found = scanSource('aumlok.mjs', inject(code))
    assert.ok(found.some(([, kind]) => kind === 'verifier'), `${name}: ${JSON.stringify(found)}`)
  }
  // The verifier's own result, returned as it is, stays allowed (an expression body; declarations then the one return).
  for (const fine of [
    "async function plain(k, s, d) { return proofOutcome(() => crypto.subtle.verify('HMAC', k, s, d), { code: 'X' }) }",
    "async function imported(raw, s, d) { return proofOutcome(async () => crypto.subtle.verify('Ed25519', await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']), s, d), { code: 'X' }) }",
    "async function declared(raw, s, d) { return proofOutcome(async () => { const key = await crypto.subtle.importKey('raw', raw, 'Ed25519', false, ['verify']); return crypto.subtle.verify('Ed25519', key, s, d) }, { code: 'X' }) }",
    "async function library(r) { return proofOutcome(() => verifyAuthenticationResponse(r), { code: 'X', judge: 'webauthn-authentication' }) }",
    "async function compared(pending, codeHash) { return proofOutcome(async () => pending.codeHash === codeHash, { code: 'X' }) }",
  ]) assert.deepEqual(scanSource('aumlok.mjs', inject(fine)), [], fine)
})

// ── rule (c) follows ALIASES of the counting function and of the
// wrong-maker, and normalises member access. The reviewer's two mutations first, then every other way a value travels. ──
test('THE SCAN BITES rule (c) through aliases: the reviewer\'s `const fromException = wrong` and `outcomes[\'wrong\'](...)`, escapes, destructuring, member and parameter aliases, call/apply, re-exports', () => {
  const rule = read('proof-failure-rule.mjs')
  const line = 'try { answer = await run() } catch (_error) { return unavailable() }'
  assert.ok(rule.includes(line), 'the anchor line is in proof-failure-rule.mjs')
  const inRule = replacement => scanSource('proof-failure-rule.mjs', rule.replace(line, replacement))
  const ruleCases = [
    ['the reviewer\'s: an alias of wrong called in the catch', "const fromException = wrong\n  try { answer = await run() } catch (_error) { return fromException('verdict') }"],
    ['the reviewer\'s: a bracketed call of a holder of wrong', "const outcomes = { wrong }\n  try { answer = await run() } catch (_error) { return outcomes['wrong']('verdict') }"],
    ['a renamed holder member, dot access', "const outcomes = { w: wrong }\n  try { answer = await run() } catch (_error) { return outcomes.w('verdict') }"],
    ['a hex escape in the bracket', "const outcomes = { wrong }\n  try { answer = await run() } catch (_error) { return outcomes['\\x77rong']('verdict') }"],
    ['a unicode escape in the member name', "const outcomes = { wrong }\n  try { answer = await run() } catch (_error) { return outcomes.\\u0077rong('verdict') }"],
    ['a template-literal key and optional call', "const outcomes = { wrong }\n  try { answer = await run() } catch (_error) { return outcomes?.[`wrong`]?.('verdict') }"],
    ['a computed literal key in the holder', "const outcomes = { ['w']: wrong }\n  try { answer = await run() } catch (_error) { return outcomes.w('verdict') }"],
    ['an alias of an alias, by assignment', "let first, second\n  first = wrong; second = first\n  try { answer = await run() } catch (_error) { return second('verdict') }"],
    ['wrong.call', "try { answer = await run() } catch (_error) { return wrong.call(null, 'verdict') }"],
    ['a ternary choosing wrong', "try { answer = await run() } catch (_error) { return (answer ? unavailable : wrong)('verdict') }"],
  ]
  for (const [name, replacement] of ruleCases) {
    const found = inRule(replacement)
    assert.ok(found.some(([, kind]) => kind === 'catch'), `${name}: ${JSON.stringify(found)}`)
  }
  const aumlok = read('aumlok.mjs'), anchor = 'export const AUMLOK_STORAGE_KEY'
  const inject = (code, sources) => scanSource('aumlok.mjs', aumlok.replace(anchor, code + '\n' + anchor), sources)
  const count = "(proofOf(error), { kind: 'device-code', pending })"
  const cases = [
    ['countFailure aliased', `const tallyOne = countFailure\nfunction a1(pending, o) { try { settleProof(o) } catch (error) { tallyOne${count} } }`],
    ['destructured from a holder', `const rules = { count: countFailure }\nfunction a2(pending, o) { try { settleProof(o) } catch (error) { const { count } = rules; count${count} } }`],
    ['destructured and renamed from a literal', `const { c: tallied } = { c: countFailure }\nfunction a3(pending, o) { try { settleProof(o) } catch (error) { tallied${count} } }`],
    ['set as a member, called by bracket', `const box = {}\nbox.c = countFailure\nfunction a4(pending, o) { try { settleProof(o) } catch (error) { box['c']${count} } }`],
    ['spread from a holder', `const rules = { count: countFailure }\nconst more = { ...rules }\nfunction a5(pending, o) { try { settleProof(o) } catch (error) { more.count${count} } }`],
    ['handed to a function as a parameter', `function runSafely(fn, pending, o) { try { settleProof(o) } catch (error) { return fn${count} } }\nconst used = (pending, o) => runSafely(countFailure, pending, o)`],
    ['handed through .call to a parameter', `function runCall(fn, pending, o) { try { settleProof(o) } catch (error) { return fn${count} } }\nconst usedCall = (pending, o) => runCall.call(null, countFailure, pending, o)`],
    ['countFailure.apply', `function a6(pending, o) { try { settleProof(o) } catch (error) { countFailure.apply(null, [proofOf(error), { kind: 'device-code', pending }]) } }`],
    ['a .catch handed a holder member', `const rules = { count: countFailure }\nfunction a7(p) { return p.catch(rules.count) }`],
    ['a wrong-maker of this file aliased', "const mint = () => ({ kind: 'wrong', code: 'AUMLOK_PROOF_INVALID', status: 403 })\nconst minted = mint\nfunction a8(run) { try { return run() } catch (error) { return minted() } }"],
    ['relayedWrong aliased through a holder', "const relay = { r: relayedWrong }\nfunction a9(input) { try { return JSON.parse(input) } catch (error) { return relay['r'](input) } }"],
  ]
  for (const [name, code] of cases) {
    const found = inject(code)
    assert.ok(found.some(([, kind]) => kind === 'catch'), `${name}: ${JSON.stringify(found)}`)
  }
  // RE-EXPORTS: proof-failure-rule.mjs exporting countFailure or its own `wrong` under another name, imported here.
  const exporting = rule + '\nexport { countFailure as tallyAll }\nexport const mintWrong = reason => ({ kind: \'wrong\', code: \'AUMLOK_PROOF_INVALID\', status: 403, reason })\n'
  for (const [name, code] of [
    ['a re-exported countFailure, imported by name', `import { tallyAll } from './proof-failure-rule.mjs'\nfunction r1(pending, o) { try { settleProof(o) } catch (error) { tallyAll${count} } }`],
    ['a re-exported countFailure, renamed on import', `import { tallyAll as quietly } from './proof-failure-rule.mjs'\nfunction r2(pending, o) { try { settleProof(o) } catch (error) { quietly${count} } }`],
    ['through a namespace import, bracketed', `import * as rule from './proof-failure-rule.mjs'\nfunction r3(pending, o) { try { settleProof(o) } catch (error) { rule['tallyAll']${count} } }`],
    ['an exported wrong-maker', "import { mintWrong } from './proof-failure-rule.mjs'\nfunction r4(run) { try { return run() } catch (error) { return mintWrong('verdict') } }"],
  ]) {
    const found = inject(code, { 'proof-failure-rule.mjs': exporting })
    assert.ok(found.some(([, kind]) => kind === 'catch'), `${name}: ${JSON.stringify(found)}`)
  }
  // Still allowed: aliases used OUTSIDE a catch; a parameter handed something else; proofOutcome (the judge) in a catch.
  for (const fine of [
    `const tallyOne = countFailure\nfunction f1(pending, o) { let judged = null; try { settleProof(o) } catch (error) { judged = proofOf(error) } if (judged !== null) tallyOne(judged, { kind: 'device-code', pending }) }`,
    `function runSafely(fn, o) { try { settleProof(o) } catch (error) { return fn(error) } }\nconst f2 = o => runSafely(error => error.code, o)`,
    "async function f3(r) { try { return await r() } catch (error) { return proofOutcome(() => verifyAuthenticationResponse(r), { code: 'X', judge: 'webauthn-authentication' }) } }",
  ]) assert.deepEqual(inject(fine), [], fine)
  // And the real files stay clean (THE SCAN above), proof-failure-rule.mjs included.
  assert.deepEqual(scanSource('proof-failure-rule.mjs', rule).filter(([, kind]) => kind === 'catch'), [])
})

// ── the aliases the first pass still let through, inside the brief's own categories
// (array destructuring, destructuring by assignment, logical assignment, default and destructured parameters, nested
// holders) and outside them (a call result, an array index, Reflect.apply, Object.assign, for...of, a computed key).
// Each replaces the same anchor line of proof-failure-rule.mjs as the test above; every one must be a 'catch' finding. ──
test('THE SCAN BITES rule (c): array and assignment destructuring, logical assignment, default and destructured parameters, nested holders, call results, indexes, Reflect.apply, Object.assign, for...of, computed keys', () => {
  const rule = read('proof-failure-rule.mjs')
  const line = 'try { answer = await run() } catch (_error) { return unavailable() }'
  assert.ok(rule.includes(line), 'the anchor line is in proof-failure-rule.mjs')
  const inRule = replacement => scanSource('proof-failure-rule.mjs', rule.replace(line, replacement))
  const tail = "try { answer = await run() } catch (_error) { return CALL }"
  const at = (setup, call) => (setup ? setup + '\n  ' : '') + tail.replace('CALL', call)
  const cases = [
    // The reviewer's six, inside the brief's categories.
    ['array destructuring', at('const [fromException] = [wrong]', "fromException('verdict')")],
    ['destructuring by assignment', at('let f; ({ wrong: f } = { wrong })', "f('verdict')")],
    ['logical assignment ??=', at('let f; f ??= wrong', "f('verdict')")],
    ['a default parameter', at('const h = (fn = wrong) => fn(\'verdict\')', 'h()')],
    ['a destructured parameter', "const h = ({ w }) => { try { return run() } catch (_e) { return w('verdict') } }; h({ w: wrong })\n  " + line],
    ['a nested holder', at('const outer = { inner: { wrong } }', "outer.inner.wrong('verdict')")],
    // The reviewer's others, outside the brief's list.
    ['a call result (a function that returns wrong)', at('const pick = () => wrong', "pick()('verdict')")],
    ['an array index', at('', "[wrong][0]('verdict')")],
    ['Reflect.apply', at('', "Reflect.apply(wrong, null, ['verdict'])")],
    ['Object.assign, inline', at('', "Object.assign({}, { wrong }).wrong('verdict')")],
    ['for...of over a literal', "for (const f of [wrong]) { try { answer = await run() } catch (_error) { return f('verdict') } }"],
    ['a computed key', at('const outcomes = { wrong }', "outcomes['wr' + 'ong']('verdict')")],
    // The same families, one step further.
    ['logical assignment ||=', at('let f = null; f ||= wrong', "f('verdict')")],
    ['logical assignment &&=', at('let f = unavailable; f &&= wrong', "f('verdict')")],
    ['array destructuring with a hole and a rest', at('const [, ...others] = [unavailable, wrong]', "others[0]('verdict')")],
    ['array destructuring by assignment', at('let f; [f] = [wrong]', "f('verdict')")],
    ['a default in a destructuring pattern', at('const { missing: f = wrong } = {}', "f('verdict')")],
    ['a nested destructured parameter', "const h = ({ a: { w } }) => { try { return run() } catch (_e) { return w('verdict') } }; h({ a: { w: wrong } })\n  " + line],
    ['an array parameter', "const h = ([w]) => { try { return run() } catch (_e) { return w('verdict') } }; h([wrong])\n  " + line],
    ['a parameter holding a nested holder', "const h = p => { try { return run() } catch (_e) { return p.inner.w('verdict') } }; h({ inner: { w: wrong } })\n  " + line],
    ['a holder of a holder by name', at('const inner = { wrong }; const outer = { inner }', "outer.inner.wrong('verdict')")],
    ['an array holder, indexed', at('const list = [unavailable, wrong]', "list[1]('verdict')")],
    ['for...of over a held array', "const list = [wrong]\n  for (const f of list) { try { answer = await run() } catch (_error) { return f('verdict') } }"],
    ['Object.assign held outside the catch', at('const merged = Object.assign({}, { wrong })', "merged.wrong('verdict')")],
    ['wrong handed to another function in the catch', at('const relay = fn => fn', "relay(wrong)('verdict')")],
    ['a member of a call result', at('const box = () => ({ wrong })', "box().wrong('verdict')")],
    ['a function literal that counts, handed as a parameter', "const h = fn => { try { return run() } catch (_e) { return fn() } }; h(() => wrong('verdict'))\n  " + line],
  ]
  assert.equal(cases.length, 27)
  const missed = cases.filter(([, replacement]) => !inRule(replacement).some(([, kind]) => kind === 'catch')).map(([name]) => name)
  assert.deepEqual(missed, [], `missed ${String(missed.length)} of ${String(cases.length)}`)
  // Still allowed: the real proofOutcome (unavailable in the catch), and a catch that reads plain values and names.
  assert.deepEqual(inRule(line).filter(([, kind]) => kind === 'catch'), [])
  const aumlok = read('aumlok.mjs'), anchor = 'export const AUMLOK_STORAGE_KEY'
  for (const fine of [
    "function g1(run) { try { return run() } catch (error) { return { code: String(error?.message ?? error).slice(0, 80), at: Date.now() } } }",
    "function g2(run, log) { try { return run() } catch (error) { log.warn('failed', error instanceof Error ? error.name : 'unknown'); return null } }",
    "function g3(run) { const [first] = [1]; let other; ({ other } = { other: 2 }); try { return run(first, other) } catch (error) { return first + other } }",
  ]) assert.deepEqual(scanSource('aumlok.mjs', aumlok.replace(anchor, fine + '\n' + anchor)), [], fine)
})
