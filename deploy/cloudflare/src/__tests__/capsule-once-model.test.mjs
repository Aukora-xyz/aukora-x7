/**
 * THE CAPSULE "ONCE" MODEL, EXPLORED, for the capsule contract DRAFT 7 (milestone M2; docs/capsule/MODEL.md says how to
 * read it). Breadth first, exhaustive to stated bounds, over capsule-once-model.mjs, which imports no product code. The
 * gate explores the `gate` depths of SCENARIOS; CAPSULE_MODEL_DEEP=1 explores the `deep` depths (manual).
 *
 * Asserted here:
 *   1. the sound model (draft 7, read literally: draft 6 with this lane's F8 and F9 written in) breaks no safety
 *      invariant in any scenario, and progress holds in the honest ones;
 *   2. FINDINGS against draft 6, each modelled both ways (`amend: []` is draft 6's text), now in draft 7's text;
 *   3. every faulty protocol of section 8 and this lane's own is caught, by the named invariant, at the recorded
 *      shortest length (explored only to that depth), or is retired with the reason; every invariant is shown to fire;
 *   4. the recorded limits of 7.6 exist;
 *   5. the review questions (a) to (l), each with a trace or "no reachable state at these bounds";
 *   6. the ten sequences of the review that held draft 3 still end as the text says;
 *   7. a second configuration (3 retained used keys; burned capacity 2) does not change the results;
 *   8. the model is reproducible, dependency-free, and every explored trace exports as data; it calls the platform
 *      serialiser and parser once each, through its helpers, and this file never (the capsule rule scan).
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { after, before } from 'node:test'
import {
  AMENDMENTS, CONTRACT_FAULTS, DEFAULT_AMEND, HONEST_ONLY, INVARIANTS, OWN_FAULTS, PROBES, READINGS, RETIRED_FAULTS,
  SCENARIOS, SOUND_SCENARIOS, commandId, envDigest, explore, exploredTraces, formatTrace, makeConfig, replay, rowRead,
  scenario, select, startJson, statusOf, successors, keyText, fromKey, deepCopy,
} from './capsule-once-model.mjs'

const DEEP = process.env.CAPSULE_MODEL_DEEP === '1'
const BOUND = DEEP ? 'deep' : 'gate'
const FILE_STARTED = process.hrtime.bigint()
const sound = {}
let boundsLine = ''
const elapsed = from => Number((process.hrtime.bigint() - from) / 1000000n)

before(() => {
  const started = process.hrtime.bigint()
  PROBES.verifiedOtherGeneration = 0
  for (const name of SOUND_SCENARIOS) sound[name] = explore(scenario(name, { deep: DEEP }))
  const total = Object.values(sound).reduce((n, r) => n + r.states, 0)
  const each = SOUND_SCENARIOS.map(n => `${n} ${sound[n].depthReached}/${sound[n].states}`).join(', ')
  boundsLine = `CAPSULE MODEL (draft 7) bound=${BOUND}: bodies A (holder, k1) and B (k2), +1 profile copy in copy/fork; A has 2 tabs in tabs; 1 command per body; used keys kept: 2 (1 in fork, inherit); scenario depth/states: ${each}; states ${total}; amendments ${DEFAULT_AMEND.join(', ') || 'none'}; sound runs ${elapsed(started)} ms`
  console.log(boundsLine)
})
after(() => console.log(`${boundsLine}; WHOLE FILE ${elapsed(FILE_STARTED)} ms`))

const show = r => (r.violation === null ? '' : `\n${r.violation.invariant}: ${r.violation.message}\n${formatTrace(r.violation.trace)}`)
const reach = (cfg, goal) => {
  const r = explore(cfg, { goal })
  return r.violation === null ? null : r.violation.trace
}

// ---------------------------------------------------------------------------------------------------------------------
// 1. The sound model.
for (const name of SOUND_SCENARIOS) {
  test(`sound model, scenario ${name}: every safety invariant holds in every explored state${SCENARIOS[name].progress ? ', and progress holds' : ''}`, () => {
    const r = sound[name]
    assert.equal(r.violation, null, `shortest violating trace:${show(r)}`)
    assert.equal(r.depthReached, DEEP ? SCENARIOS[name].deep : SCENARIOS[name].gate, 'the stated bound was explored to its end')
    assert.ok(r.states > 100, `a real state space was explored (${r.states})`)
    if (SCENARIOS[name].progress) assert.ok(r.progressChecked > 0, 'states were checked for progress')
  })
}

test('the invariants: the safety list of section 8 bench 2 and the brief, each its own function, four honest-only', () => {
  assert.deepEqual(Object.keys(INVARIANTS), [
    'oneEffectPerActionId', 'positionFilledOnce', 'terminalRowNeverChanges', 'onePositionPerIntent', 'oneEffectPerWish',
    'oneSuccessorPerKey', 'keyUsedOnce', 'effectOrRotationOnlyVerified', 'rotationOncePerVerified', 'refusalHasNoEffect',
    'storedAnswerMatches', 'acknowledgedCommitStays', 'proofVerbBound', 'forkStopsEffects',
    'inheritedLockedNeverCommits', 'gatePassedAtCommit', 'leaseLiveAtBothChecks', 'actCommitDenyAsTable',
    'openIntentRetiredWithOutcome', 'oneIntentPerWish', 'clientPromotesOnlyOwnVerified', 'honestNeverForked',
    'honestKeepsNextKey', 'honestHolderNeverHolds', 'honestNeverSupersededLive',
  ])
  assert.deepEqual([...HONEST_ONLY], ['honestNeverForked', 'honestKeepsNextKey', 'honestHolderNeverHolds', 'honestNeverSupersededLive'])
})

// ---------------------------------------------------------------------------------------------------------------------
// 2. Findings against draft 6.
test('FINDING F8 (7.4 steps 3 and 5; S25): as written, a body whose open intent meets another body\'s pending row never clears it', () => {
  const r = explore(scenario('moves', { amend: [] }))
  assert.ok(r.violation !== null, 'the text as written produces the finding')
  assert.equal(r.violation.invariant, 'progress')
  const t = r.violation.trace
  console.log(`FINDING F8, shortest trace (${t.length} steps; from its last state no fair path lets the holder act again):\n${formatTrace(t)}`)
  assert.equal(t.length, 10)
  assert.ok(t.some(e => e.kind === 'move' && e.to === 'B') && t.some(e => e.kind === 'move' && e.to === 'A'), 'a move away and back')
  assert.ok(t.some(e => e.kind === 'process' && e.who === 'B' && e.answer === 'pending'), 'B left a pending row')
  assert.ok(t.some(e => e.kind === 'cycle' && e.actor === 'A'), 'A holds an open intent of its own from before the moves')
  // With the amendment ResolveOtherPendingFirst the same scenario is clean (the sound test above).
  assert.ok(AMENDMENTS.includes('ResolveOtherPendingFirst') && DEFAULT_AMEND.includes('ResolveOtherPendingFirst'))
})
test('FINDING F9 (7.4 step 5, first and last bullets): "Nothing else retires it" read strictly strands an intent refused at creation', () => {
  const r = explore(scenario('full', { readings: ['RetireOnlyOnTerminal'], depth: 5 }))
  assert.ok(r.violation !== null, 'the strict reading produces it')
  assert.equal(r.violation.invariant, 'progress')
  console.log(`FINDING F9, strict reading (${r.violation.trace.length} steps):\n${formatTrace(r.violation.trace)}`)
  assert.ok(r.violation.trace.some(e => e.kind === 'process' && /CAPSULE_GATE_DENIED|CAPSULE_LEDGER_FULL/.test(e.answer)))
  assert.deepEqual([...READINGS], ['RetireOnlyOnTerminal'])
})

// ---------------------------------------------------------------------------------------------------------------------
// 3. The faulty protocols: [scenario, invariant, shortest trace length]. Each is explored only to its recorded length,
// which breadth first reaches with its shortest counterexample.
const FAULTS = {
  EpochScopedKey: ['moves', 'positionFilledOnce', 7],
  NoFenceAtCommit: ['honest', 'leaseLiveAtBothChecks', 5],
  DedupeByIdOnly: ['forget', 'onePositionPerIntent', 7],
  ForgetRows: ['honest', 'terminalRowNeverChanges', 3],
  NewIntentOnRetry: ['forget', 'oneIntentPerWish', 6],
  PendingAnsweredAsDone: ['honest', 'acknowledgedCommitStays', 3],
  SecondEnvelopeAccepted: ['fork', 'oneSuccessorPerKey', 6],
  ProofOmitsVerb: ['wire', 'proofVerbBound', 4],
  CapBlocksResolution: ['full', 'progress', 4],
  RotateOnUnverified: ['wire', 'keyUsedOnce', 3],
  SendBeforeStore: ['honest', 'honestKeepsNextKey', 3],
  NoLockOnFork: ['fork', 'forkStopsEffects', 6],
  SessionInEnvelope: ['honest', 'honestNeverSupersededLive', 7],
  GateOnlyAtIntent: ['gate', 'gatePassedAtCommit', 3],
  SameKeyRestartAfterLock: ['fork', 'forkStopsEffects', 7],
  FenceBeforeReplay: ['honest', 'rotationOncePerVerified', 4],
  AbandonGated: ['gate', 'progress', 4],
  SuccessorCheckBeforeRetry: ['moves', 'honestHolderNeverHolds', 6],
  ChainPerGeneration: ['moves', 'oneSuccessorPerKey', 6],
  SecondEnvelopeIsFork: ['tabs', 'honestNeverForked', 8],
  StaleGenerationRotates: ['moves', 'effectOrRotationOnlyVerified', 4],
  ThumbOnlyPromotion: ['tabs', 'clientPromotesOnlyOwnVerified', 7],
  SingleLeaseCheck: ['honest', 'leaseLiveAtBothChecks', 3],
  ActSkipsInheritedLock: ['inherit', 'inheritedLockedNeverCommits', 9],
  FirstKeyForgotten: ['fork', 'forkStopsEffects', 8],
  SilentOriginal: ['moves', 'progress', 9],
  NextKeyMayRepeat: ['wire', 'keyUsedOnce', 3],
  StoredAnswerForAnyEnvelope: ['wire', 'storedAnswerMatches', 5],
  LeaseCheckAfterWrite: ['honest', 'refusalHasNoEffect', 3],
  BurnedAtWriteOnly: ['inherit', 'inheritedLockedNeverCommits', 9],
  HoldOnEarlierStay: ['moves', 'honestHolderNeverHolds', 10],
  IntentForgottenOnReset: ['forget', 'openIntentRetiredWithOutcome', 9],
  LeaseOnlyWithJournal: ['honest', 'progress', 4],
  GenerationsComparedInStep5: null,
  SecondCheckOnlyOnSuccess: ['gate', 'leaseLiveAtBothChecks', 3],
  ActDenyDropsRow: ['gate', 'actCommitDenyAsTable', 3],
  ActDenyAnswersPending: ['gate', 'actCommitDenyAsTable', 3],
  ActCreationDenyKeepsRow: ['gate', 'refusalHasNoEffect', 3],
}
/** Faults no scenario can catch, with the reason (a finding about the bench, not a hole in the protocol). */
const NOT_CAUGHT = {
  GenerationsComparedInStep5: 'equivalent under draft 6: a verified answer is the answer as first given, and the door verifies only an envelope whose holder generation is the holder\'s, so the answer always names the entry\'s own generation; no same-key move can make them differ',
}

test('the fault table names the 32 faults of section 8 (draft 6, unchanged in draft 7) in order, then this lane\'s six', () => {
  assert.deepEqual(Object.keys(FAULTS), [...CONTRACT_FAULTS, ...OWN_FAULTS])
  assert.equal(CONTRACT_FAULTS.length, 32)
  assert.ok(!CONTRACT_FAULTS.includes('PromoteWithoutGenCheck') && 'PromoteWithoutGenCheck' in RETIRED_FAULTS, 'PromoteWithoutGenCheck is retired, with its reason')
  for (const f of ['DedupeByIdOnly', 'NewIntentOnRetry', 'IntentForgottenOnReset']) assert.equal(FAULTS[f][0], 'forget', `${f} runs where her memory of a command is lost`)
})
for (const [fault, row] of Object.entries(FAULTS)) {
  if (row === null) continue
  const [where, invariant, length] = row
  test(`faulty protocol ${fault} is caught in scenario ${where} by ${invariant} (trace length ${length})`, () => {
    const r = explore(scenario(where, { faults: [fault], depth: length }))
    assert.ok(r.violation !== null, `${fault} survived scenario ${where} at depth ${r.depthReached}`)
    console.log(`fault ${fault}: ${r.violation.invariant} at trace length ${r.violation.trace.length} in ${where}: ${r.violation.message}`)
    assert.equal(r.violation.invariant, invariant, show(r))
    assert.equal(r.violation.trace.length, length, show(r))
  })
}
for (const [fault, why] of Object.entries(NOT_CAUGHT)) {
  test(`faulty protocol ${fault} cannot differ from the sound model, and is retired (${why})`, () => {
    assert.equal(PROBES.verifiedOtherGeneration, 0, 'no verified answer for a journal entry named another holder generation in any sound state explored')
    for (const [where, depth] of [['honest', 6], ['moves', 7], ['copy', 6]]) {
      const a = explore(scenario(where, { faults: [fault], depth }))
      const b = explore(scenario(where, { depth }))
      assert.equal(a.violation, null, `${fault} is caught in ${where} after all:${show(a)}`)
      assert.equal(a.states, b.states, `an equivalent mutant explores exactly the sound state space (${where}, depth ${depth})`)
    }
  })
}
let epochTwice = null
test('EpochScopedKey, the classic story too: one action takes effect twice across same-key moves', () => {
  const r = explore(scenario('moves', { faults: ['EpochScopedKey'], depth: 9 }), { stopAtFirst: false })
  epochTwice = r.violations.find(v => v.invariant === 'oneEffectPerActionId')
  assert.ok(epochTwice !== undefined, 'reached')
  assert.equal(epochTwice.trace.length, 9, 'the story\'s recorded length')
  console.log(`EpochScopedKey, one action two effects (${epochTwice.trace.length} steps):\n${formatTrace(epochTwice.trace)}`)
})
let wishTwice = null
test('NewIntentOnRetry, the classic story too: one wish takes effect twice', () => {
  // the client invariants of (l) catch it first; looking past them, a second effect for one wish follows
  const r = explore({ ...scenario('forget', { faults: ['NewIntentOnRetry'], depth: 7 }), ignore: ['openIntentRetiredWithOutcome', 'oneIntentPerWish'] })
  wishTwice = r.violation
  assert.ok(wishTwice !== null && wishTwice.invariant === 'oneEffectPerWish', show(r))
  assert.equal(wishTwice.trace.length, 7, 'the story\'s recorded length')
  console.log(`NewIntentOnRetry, one wish two effects (${wishTwice.trace.length} steps):\n${formatTrace(wishTwice.trace)}`)
})
test('every invariant can fire: each catches at least one fault, or the EpochScopedKey and NewIntentOnRetry stories', () => {
  const firing = new Set(Object.values(FAULTS).filter(Boolean).map(r => r[1]))
  firing.add('oneEffectPerActionId').add('oneEffectPerWish')
  for (const name of Object.keys(INVARIANTS)) assert.ok(firing.has(name), `${name} is never shown to fire`)
})

// ---------------------------------------------------------------------------------------------------------------------
// Replays: event patterns taken through the same `successors` (the first matching event at each step).
const P = {
  make: (actor, extra = {}) => ({ kind: 'make-command', actor, ...extra }),
  cycle: (actor, extra = {}) => ({ kind: 'cycle', actor, ...extra }),
  proc: (who, answer, extra = {}) => ({ kind: 'process', who, answer, ...extra }),
  between: (who, answer) => ({ kind: 'process-lease-expires-between-checks', who, answer }),
  recv: (actor, extra = {}) => ({ kind: 'receive', actor, ...extra }),
  lose: () => ({ kind: 'lose-answer' }),
  move: (to, sameKey) => ({ kind: 'move', to, sameKey }),
  copy: phase => ({ kind: 'copy-profile', phase }),
}
const takesLease = n => /takes the lease/.test(n ?? '')
const cfgOf = (name, over = {}) => makeConfig({ ...SCENARIOS[name], name, depth: 99, ...over, budget: { ...SCENARIOS[name].budget, ...over.budget }, amend: [...DEFAULT_AMEND] })
const chainOf = s => s.d.chain
const answersOf = t => t.filter(e => e.kind.startsWith('process')).map(e => e.answer)

// ---------------------------------------------------------------------------------------------------------------------
// 4. The recorded limits of 7.6: each EXISTS in the model.
test('LIMIT 1: a copy that acts first is the body until an envelope of the original reaches the destination; then both are locked', () => {
  const cfg = cfgOf('copy', { cmds: 2 })
  const { trace, s } = replay(cfg, [
    P.make('A'), P.copy('before-preparing'), P.cycle('Ac', { step: 'prepare', verb: 'act' }), { kind: 'send', actor: 'Ac' },
    P.proc('Ac', 'committed'), P.make('A'), P.cycle('A', { verb: 'act', notes: n => /out of step/.test(n ?? '') }),
    { kind: 'send', actor: 'A' }, P.proc('A', 'BODY_KEY_FORKED'),
  ])
  console.log(`LIMIT 1 (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.equal(s.g.eff.length, 1, 'the copy\'s act took effect: it was the body')
  assert.ok(chainOf(s).locked, 'the original\'s envelope through its installation key locked the chain')
  assert.equal(statusOf(s.d, cfg).locked, true)
})
test('LIMIT 2: a copy made while a next key is stored and unused sends the same bytes: the stored answer, both promote; caught one act later', () => {
  const cfg = cfgOf('copy', { cmds: 2 })
  const { trace, s } = replay(cfg, [
    P.make('A'), P.cycle('A', { step: 'prepare', verb: 'act' }), P.copy('next-key-stored-entry-unsent'),
    { kind: 'send', actor: 'A' }, { kind: 'send', actor: 'Ac' }, P.proc('A', 'committed'),
    P.proc('Ac', 'committed', { stored: true }), P.recv('A', { result: r => /^promotes/.test(r) }), P.recv('Ac', { result: r => /^promotes/.test(r) }),
    P.make('A'), P.cycle('A', { verb: 'intent' }), { kind: 'send', actor: 'A' },
    P.make('Ac'), P.cycle('Ac', { verb: 'intent' }), { kind: 'send', actor: 'Ac' },
    P.proc('A', 'pending'), P.proc('Ac', 'BODY_KEY_FORKED'),
  ])
  console.log(`LIMIT 2 (${trace.length} steps):\n${formatTrace(trace)}`)
  const promoted = trace.findIndex(e => e.kind === 'receive' && e.actor === 'Ac')
  assert.equal(answersOf(trace.slice(0, promoted)).filter(a => a === 'committed').length, 2, 'both sends of the one entry are answered committed')
  assert.ok(trace[6].stored, 'the second is the stored answer (verified): both promote to the same key, nobody is locked')
  assert.equal(s.g.eff.length, 1)
  assert.ok(chainOf(s).locked, 'one act later the two are caught')
  const two = trace.filter(e => e.kind === 'cycle' && e.verb === 'intent')
  assert.equal(two[0].by, two[1].by, 'the shared key named two successors')
  assert.notEqual(two[0].nx, two[1].nx)
  assert.ok(!answersOf(trace).includes('PROOF_SUPERSEDED'), 'draft 6 wording: the stored answer, not superseded')
})
test('LIMIT 3: two tabs of one profile WITHOUT the lock can fork', () => {
  const t = reach(scenario('tabsUnlocked'), s => s.g.forked > 0)
  assert.ok(t !== null, 'reachable')
  console.log(`LIMIT 3 (${t.length} steps):\n${formatTrace(t)}`)
})
test('LIMIT 4: a body whose storage went back is locked, though no copy exists', () => {
  const cfg = cfgOf('bodyBack', { cmds: 2 })
  const { trace, s } = replay(cfg, [
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'committed'), { kind: 'storage-goes-back', actor: 'A' },
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'BODY_KEY_FORKED'),
  ])
  console.log(`LIMIT 4 (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.equal(Object.keys(s.b).filter(n => n.endsWith('c')).length, 0, 'no copy')
  assert.ok(chainOf(s).locked)
})
test('LIMIT 5: a stale copy that keeps using a chain key more than `kept` acts old is revoked and locks nobody', () => {
  const cfg = cfgOf('staleCopy')
  const { trace, s } = replay(cfg, [
    P.make('A'), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'), P.cycle('A', { verb: 'commit' }),
    P.copy('next-key-stored-entry-sent'), P.proc('A', 'committed'), P.make('A'), P.cycle('A', { verb: 'intent' }),
    P.proc('A', 'pending'), { kind: 'stale-copy-signs', actor: 'Ac' }, P.proc('Ac', 'CAPSULE_INSTANCE_REVOKED'),
  ])
  console.log(`LIMIT 5 (${trace.length} steps; kept = ${cfg.kept}):\n${formatTrace(trace)}`)
  assert.equal(chainOf(s).locked, false)
})
test('LIMIT 6: after a lock the honest original\'s installation key is burned too', () => {
  const cfg = cfgOf('fork', { budget: { moves: 2 } })
  const { trace, s } = replay(cfg, [
    P.copy('before-preparing'), P.make('A'), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'),
    P.cycle('Ac', { verb: 'abandon' }), P.proc('Ac', 'BODY_KEY_FORKED'), P.move('B', false),
    P.cycle('B', { verb: 'abandon', notes: takesLease }), P.proc('B', 'abandoned'), P.move('A', false),
  ])
  console.log(`LIMIT 6 (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.deepEqual(s.d.burned, [1])
  assert.equal(statusOf(s.d, cfg).locked, true, 'the original (k1) reads as locked')
  assert.equal(successors(keyText(s), cfg).filter(o => o.ev.kind === 'cycle' && o.ev.actor === 'A').length, 0, 'and cannot act')
})
test('LIMIT 7: the destination\'s storage going back one step unlocks a locked chain', () => {
  const cfg = cfgOf('destBack')
  const { trace, s } = replay(cfg, [
    P.copy('before-preparing'), P.make('A'), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'),
    P.cycle('Ac', { verb: 'abandon' }), P.proc('Ac', 'BODY_KEY_FORKED'), { kind: 'destination-goes-back' },
    P.cycle('A', { verb: 'commit' }), P.proc('A', 'committed'),
  ])
  console.log(`LIMIT 7 (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.equal(chainOf(s).locked, false)
  assert.equal(s.g.eff.length, 1, 'an effect after a fork had reached the destination')
})

// ---------------------------------------------------------------------------------------------------------------------
// 5. The review questions, each answered with a trace or "no reachable state at these bounds".
const HONEST = SOUND_SCENARIOS.filter(n => SCENARIOS[n].honest)
const answer = (q, text) => console.log(`ANSWER (${q}) at bound ${BOUND}: ${text}`)

test('(a) an honest holder unable to act without a lock: as written yes (F8); amended, no reachable state', () => {
  for (const n of HONEST) assert.equal(sound[n].violation, null, n)
  answer('a', `as written: yes, F8 (10 steps, moves scenario: no lock and no hold, but A never acts again; a reload does not help, since nothing in 7.4 clears another body's pending row; only a move to the body that placed it does); with ResolveOtherPendingFirst: no reachable state in ${HONEST.join(', ')} (progress, honestHolderNeverHolds). The draft 4 hold (F3) is now the text (7.4 step 6) and its fault HoldOnEarlierStay is caught`)
})
test('(b) after a verified envelope answered by a fence refusal the body always continues', () => {
  const { trace, s } = replay(cfgOf('honest'), [
    P.make('A'), P.cycle('A', { verb: 'act' }), { kind: 'lease-expires' }, P.proc('A', 'WRITER_LEASE_REQUIRED', { verified: true }),
    P.recv('A', { result: r => /^promotes/.test(r) }), P.cycle('A', { verb: 'act', notes: takesLease }), P.proc('A', 'committed'),
  ])
  assert.equal(s.g.eff.length, 1)
  assert.equal(trace[5].by, trace[1].nx, 'the next envelope is signed by the key the refused one named')
  answer('b', `yes: progress holds from every checked state of ${HONEST.join(', ')}; witness (${trace.length} steps):\n${formatTrace(trace)}`)
})
test('(c) late duplicates, replaced envelopes and envelopes from an earlier stay never lock or redirect an honest chain', () => {
  for (const n of HONEST) assert.equal(sound[n].violation, null, n)
  const cfg = scenario('moves')
  const seenCode = code => s => s.net.ans.some(a => a.code === code)
  const superseded = reach(cfg, seenCode('PROOF_SUPERSEDED'))
  const stale = reach(cfg, seenCode('CAPSULE_GENERATION_STALE'))
  const revoked = reach(cfg, s => s.net.ans.some(a => a.code === 'CAPSULE_INSTANCE_REVOKED' && a.to[0] === 'A') && s.d.hname === 'A')
  for (const t of [superseded, stale, revoked]) assert.ok(t !== null, 'non-vacuous: the case is reachable in the honest moves scenario')
  answer('c', `no reachable state (honestNeverForked, honestKeepsNextKey, oneSuccessorPerKey in ${HONEST.join(', ')}); a replaced envelope arriving late is PROOF_SUPERSEDED (${superseded.length} steps), a request caught by a move is CAPSULE_GENERATION_STALE (${stale.length}), an envelope from an earlier stay after the move back is CAPSULE_INSTANCE_REVOKED (${revoked.length}):\n${formatTrace(superseded)}`)
})
test('(d) the order of 6.7: no ledger effect followed by a refusal (except 6.8\'s act DENY), no rotation without its stored answer', () => {
  for (const n of SOUND_SCENARIOS) assert.equal(sound[n].violation, null, n)
  const { trace, s } = replay(cfgOf('honest'), [P.make('A'), P.cycle('A', { verb: 'act' }), P.between('A', 'WRITER_LEASE_REQUIRED')])
  assert.equal(s.d.rows.length, 0, 'no ledger effect')
  assert.equal(chainOf(s).cur, trace[1].nx, 'the key rotated')
  assert.equal(chainOf(s).last.code, 'WRITER_LEASE_REQUIRED', 'and its answer is stored')
  answer('d', `no reachable state (refusalHasNoEffect, leaseLiveAtBothChecks in all ${SOUND_SCENARIOS.length} scenarios); the lease expiring between the two checks gives WRITER_LEASE_REQUIRED, a rotation and the stored answer, no row`)
})
test('(e) a pending row the current holder can neither commit nor abandon: none in honest schedules; after a lock only by a move', () => {
  for (const n of HONEST) assert.equal(sound[n].violation, null, n)
  answer('e', `no reachable state in ${HONEST.join(', ')} (progress, which includes the one-row ledger, the escalating policy and the commit-denied act); a row left under a locked chain is abandoned by the next holder (MUST3 below); a lineage whose locks are used up keeps the lock (burned capacity 2, section 7 below)`)
})
test('(f) two different first envelopes of one chain are never both accepted', () => {
  for (const n of SOUND_SCENARIOS) assert.equal(sound[n].violation, null, n)
  answer('f', `no reachable state (oneSuccessorPerKey, keyUsedOnce in all ${SOUND_SCENARIOS.length} scenarios, copies, two tabs, stale keys and moves included)`)
})
test('(g) after a same-key move, two copies never both cause ledger effects after naming different successors', () => {
  for (const name of ['copy', 'fork']) {
    const cfg = { ...scenario(name, { deep: DEEP }), trackDiv: true }
    const t = reach(cfg, s => s.g.div && s.g.effAfterDiv.length >= 2)
    assert.equal(t, null, `reachable in ${name}:\n${t && formatTrace(t)}`)
  }
  const sameKey = reach({ ...scenario('copy'), trackDiv: true }, s => s.g.div && s.n.moves === 1 && s.d.hname === 'A' && s.d.gen === 2 && s.d.chain?.locked)
  assert.ok(sameKey !== null, 'non-vacuous: copies diverging around a same-key move are reached, and end locked')
  answer('g', `no reachable state in copy and fork (at the ${BOUND} depth, with divergence tracking); diverging copies around a same-key move end locked (${sameKey.length} steps)`)
})
test('(h) the out-of-step rule never locks an honest body when no copy exists and no storage was lost', () => {
  for (const n of HONEST) assert.equal(sound[n].violation, null, n)
  const cfg = cfgOf('moves', { cmds: 2 })
  const { trace, s } = replay(cfg, [
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'committed'), P.cycle('A', { notes: n => /promotes/.test(n ?? '') }),
    P.move('B', false), P.make('B'), P.cycle('B', { verb: 'act' }), P.proc('B', 'committed'), P.move('A', false),
    P.make('A'), P.cycle('A', { verb: 'act', notes: n => /out of step/.test(n ?? '') }), P.proc('A', 'committed'),
  ])
  assert.equal(chainOf(s).owner, 1, 'A\'s restarted chain accepted the envelope by its installation key')
  assert.equal(chainOf(s).locked, false)
  answer('h', `no reachable state (honestNeverForked in ${HONEST.join(', ')}); the rule fires honestly after a move away and back, and the restarted chain accepts (${trace.length} steps)`)
})
test('(i) PROOF_SUPERSEDED never answers an honest body\'s live journal entry', () => {
  for (const n of HONEST) assert.equal(sound[n].violation, null, n)
  answer('i', `no reachable state (honestNeverSupersededLive in ${HONEST.join(', ')}); it is reachable for a replaced entry, see (c)`)
})
test('(j) with the lease expired and no journal entry, the honest holder always acts again', () => {
  for (const n of ['honest', 'tabs', 'full', 'gate']) assert.equal(sound[n].violation, null, n)
  const { trace, s } = replay(cfgOf('honest', { cmds: 2 }), [
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'committed'), P.recv('A'), { kind: 'lease-expires' },
    P.make('A'), P.cycle('A', { verb: 'act', notes: takesLease }), P.proc('A', 'committed'),
  ])
  assert.equal(s.g.eff.length, 2)
  answer('j', `yes: progress holds in honest, tabs, full and gate, each with a lease expiry (step 1 takes the lease whatever the journal holds); witness (${trace.length} steps); the careless reading LeaseOnlyWithJournal fails progress (4 steps)`)
})
test('(k) an act never creates a row while no lease is live at the second check', () => {
  for (const n of SOUND_SCENARIOS) assert.equal(sound[n].violation, null, n)
  const { trace, s } = replay(cfgOf('gate'), [P.make('A', { pay: 'flaky' }), P.cycle('A', { verb: 'act' }), P.between('A', 'WRITER_LEASE_REQUIRED')])
  assert.equal(s.d.rows.length, 0, 'the row the act staged was discarded')
  assert.equal(chainOf(s).last.code, 'WRITER_LEASE_REQUIRED', 'the rotation and the stored refusal are kept')
  const denied = replay(cfgOf('gate'), [P.make('A', { pay: 'flaky' }), P.cycle('A', { verb: 'act' }), P.proc('A', 'CAPSULE_GATE_DENIED', { verified: true })])
  assert.equal(denied.s.d.rows[0].st, 'P', 'with the lease live: CAPSULE_GATE_DENIED and the new row pending (6.8)')
  const revCommits = reach(scenario('gate'), st => st.d.rows.some(r => r.cmd.pay === 'rev'))
  assert.equal(revCommits, null, 'the reverse (creation DENY, commit ALLOW) never makes a row, so it never commits')
  answer('k', `no reachable state (leaseLiveAtBothChecks in all ${SOUND_SCENARIOS.length} scenarios; the gate scenario has an act whose two gate calls differ, with an expiry between the checks); witness (${trace.length} steps): the staged row is discarded, the rotation and refusal kept; the careless reading SecondCheckOnlyOnSuccess creates the row (3 steps)`)
})
test('(l) an open intent is never lost or given a second intent id in an honest schedule', () => {
  for (const n of SOUND_SCENARIOS) assert.equal(sound[n].violation, null, n)
  answer('l', `no reachable state (oneIntentPerWish, openIntentRetiredWithOutcome in all ${SOUND_SCENARIOS.length} scenarios, the adverse ones included); IntentForgottenOnReset is caught in forget (9 steps), NewIntentOnRetry in forget (6)`)
})
test('draft 7, 6.5a "The row in an answer": a commit DENY carries this action\'s pending row and the intent stays; a creation DENY carries no row and retires it', () => {
  const cfg = cfgOf('gate')
  const answered = pay => replay(cfg, [P.make('A', { pay }), P.cycle('A', { verb: 'act' }), P.proc('A', 'CAPSULE_GATE_DENIED', { verified: true })]).s
  const received = pay => replay(cfg, [P.make('A', { pay }), P.cycle('A', { verb: 'act' }), P.proc('A', 'CAPSULE_GATE_DENIED', { verified: true }), P.recv('A')]).s
  // creation ALLOW, commit DENY: the answer's row is this action's row, pending; the client keeps the open intent
  const commitDeny = answered('flaky')
  assert.equal(commitDeny.net.ans.length, 1)
  assert.equal(commitDeny.net.ans[0].row, 'P', 'the answer carries this action\'s row, pending')
  assert.equal(commitDeny.d.rows[0].id, commitDeny.b.A.st.oi.id)
  const kept = received('flaky')
  assert.notEqual(kept.b.A.st.oi, null, 'the open intent stays: its next request is commit or abandon')
  assert.equal(kept.b.A.cmds[0].out, 'pending')
  // creation DENY: no row, and the answer carries none; the client retires the open intent with that outcome
  const creationDeny = answered('rev')
  assert.equal(creationDeny.net.ans[0].row, null, 'a creation DENY carries no row')
  assert.equal(creationDeny.d.rows.length, 0)
  const retired = received('rev')
  assert.equal(retired.b.A.st.oi, null, '7.4 step 5: a final refusal at creation that leaves no row retires the open intent')
  assert.equal(retired.b.A.cmds[0].out, 'denied')
})

// ---------------------------------------------------------------------------------------------------------------------
// 6. The ten sequences of the review that held draft 3: still ending as the text says.
test('CODEX MUST1: an exact retry of a verified envelope gets the stored answer (not PROOF_INVALID) and the body promotes', () => {
  const { trace, s } = replay(cfgOf('honest'), [
    P.make('A'), P.cycle('A', { verb: 'act' }), { kind: 'crash-restart', actor: 'A' }, P.cycle('A', { step: 're-send' }),
    { kind: 'process', from: null, answer: 'committed' }, P.proc('A', 'committed', { stored: true }), P.recv('A', { result: r => /^promotes/.test(r) }),
  ])
  assert.equal(s.g.eff.length, 1)
  assert.equal(s.b.A.st.cur, chainOf(s).cur)
  assert.equal(s.b.A.st.oi, null, 'the open intent is retired by the committed outcome')
  assert.ok(!answersOf(trace).includes('PROOF_INVALID'))
})
test('CODEX MUST2: after a completed act and a move that keeps the key, a restarted client continues the chain', () => {
  const { trace, s } = replay(cfgOf('honest', { cmds: 2 }), [
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'committed'), P.recv('A'), P.move('A', true),
    { kind: 'crash-restart', actor: 'A' }, P.make('A'), P.cycle('A', { verb: 'act', notes: takesLease }), P.proc('A', 'committed'),
  ])
  assert.equal(trace[7].by, trace[1].nx, 'signed by the rotated key: the chain continued across the move')
  assert.equal(s.g.eff.length, 2)
})
test('CODEX MUST3: a row left under a locked chain is refused to act(C) by the next holder (CAPSULE_INHERITED_LOCKED), then abandoned', () => {
  const { trace, s } = replay(cfgOf('fork'), [
    P.copy('before-preparing'), P.make('A'), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'),
    P.cycle('Ac', { verb: 'commit' }), P.proc('Ac', 'BODY_KEY_FORKED'), P.move('B', false),
    P.cycle('B', { verb: 'act' }), P.proc('B', 'CAPSULE_INHERITED_LOCKED', { verified: true }),
    P.cycle('B', { verb: 'abandon' }), P.proc('B', 'abandoned'),
  ])
  console.log(`CODEX MUST3 (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.equal(s.d.rows[0].st, 'A')
  assert.equal(s.g.eff.length, 0)
})
test('CODEX MUST4: a moved-out body learns what happened to its command with the row read, by action id and by intent id', () => {
  const { s } = replay(cfgOf('honest'), [
    P.make('A'), P.cycle('A', { verb: 'act' }), P.proc('A', 'committed'), P.lose(), P.move('B', false),
    P.make('B'), P.cycle('B', { verb: 'act' }), P.proc('B', 'committed'),
  ])
  const c = s.b.A.cmds[0]
  assert.equal(rowRead(s.d, { aid: c.id }).st, 'C')
  assert.equal(rowRead(s.d, { iid: c.iid }).id, c.id)
})
test('CODEX MUST5: the lease expiring after the first check: no ledger effect, the rotation and its refusal kept', () => {
  const { s } = replay(cfgOf('honest'), [P.make('A'), P.cycle('A', { verb: 'act' }), P.between('A', 'WRITER_LEASE_REQUIRED')])
  assert.equal(s.d.rows.length, 0)
  assert.equal(chainOf(s).last.ver, true)
})
test('CODEX MUST6: no current owner session: nothing reaches the act door and nothing changes', () => {
  const cfg = cfgOf('wire')
  const { trace, json } = replay(cfg, [{ kind: 'send-own-envelope', session: 'none' }])
  const next = successors(json, cfg).find(o => o.ev.kind === 'process')
  assert.equal(next.ev.answer, 'NO_SESSION')
  assert.deepEqual(next.s.d, fromKey(json).d)
  assert.equal(trace.length, 1)
})
test('CODEX MUST7: commit of an unknown id is CAPSULE_ACTION_UNKNOWN; the cap comes before creation; act on a pending row answers its verdict', () => {
  const cfg = cfgOf('full')
  const start = fromKey(startJson(cfg))
  const env = { v: 'commit', hg: 1, lg: 1, aid: commandId({ seq: 9, prev: 'g0', iid: 77, pay: 'safe' }), by: 1, nx: 50 }
  start.net.req.push({ env, cmd: null, sig: `1:${envDigest(env)}`, via: 'sA', from: ['A', 0], who: 'A', rv: 'commit', sv: 'commit', w: 0 })
  const unknown = successors(keyText(start), cfg).find(o => o.ev.kind === 'process')
  assert.equal(unknown.ev.answer, 'CAPSULE_ACTION_UNKNOWN')
  assert.equal(unknown.ev.verified, true)
  const full = replay(cfgOf('full', { cmds: 2 }), [P.make('A', { pay: 'safe' }), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'), P.cycle('A', { verb: 'abandon' }),
    P.proc('A', 'abandoned'), P.make('A', { pay: 'safe' }), P.cycle('A', { verb: 'intent' }), P.proc('A', 'CAPSULE_LEDGER_FULL', { verified: true })])
  assert.equal(full.s.d.rows.length, 1, 'the cap (one row here) refuses creation and only creation')
  const escalated = replay(cfg, [P.make('A', { pay: 'safe' }), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'), { kind: 'policy-change' },
    P.cycle('A', { verb: 'act' }), P.proc('A', 'pending', { verified: true })])
  assert.equal(escalated.s.d.rows[0].st, 'P', 'ESCALATE at commit: pending, the row unchanged')
})
test('CODEX MUST8: act calls the gate at creation and again at commit; after a policy change a commit is judged again', () => {
  const cfg = cfgOf('full')
  const { s } = replay(cfg, [P.make('A', { pay: 'safe' }), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'), { kind: 'policy-change' },
    P.cycle('A', { verb: 'commit' }), P.proc('A', 'pending'), P.cycle('A', { verb: 'abandon' }), P.proc('A', 'abandoned')])
  assert.equal(s.g.eff.length, 0, 'the row passed the gate at creation under v0 and was not committed under v1')
})
test('CODEX MUST9: an expired lease and a valid current-key envelope: the chain rotates, the refusal is stored, no ledger effect', () => {
  const { trace, s } = replay(cfgOf('honest'), [P.make('A'), P.cycle('A', { verb: 'act' }), { kind: 'lease-expires' }, P.proc('A', 'WRITER_LEASE_REQUIRED', { verified: true })])
  assert.equal(s.d.rows.length, 0)
  assert.equal(chainOf(s).cur, trace[1].nx)
})
test('CODEX MUST10: (c) copies that diverge before a same-key move end locked; (d) a stale key beyond the retained ones is revoked (LIMIT 5)', () => {
  const cfg = cfgOf('copy')
  const { trace, s } = replay(cfg, [
    P.make('A'), P.copy('before-preparing'), P.cycle('A', { step: 'prepare', verb: 'act' }), P.cycle('Ac', { step: 'prepare', verb: 'intent' }),
    { kind: 'send', actor: 'A' }, { kind: 'send', actor: 'Ac' }, P.proc('A', 'committed'), P.move('A', true), P.proc('Ac', 'BODY_KEY_FORKED'),
  ])
  console.log(`CODEX MUST10 (c) (${trace.length} steps):\n${formatTrace(trace)}`)
  assert.ok(chainOf(s).locked)
  assert.equal(s.g.eff.length, 1, 'only the first envelope took effect')
})

// ---------------------------------------------------------------------------------------------------------------------
// 7. A second configuration: the results do not hang on the scaling.
for (const name of ['honest', 'moves', 'copy']) {
  test(`second configuration: scenario ${name} with 3 retained used keys, one step below the gate, is clean`, () => {
    const depth = (DEEP ? SCENARIOS[name].deep : SCENARIOS[name].gate) - 1
    const r = explore(scenario(name, { depth, over: { kept: 3 } }))
    console.log(`second configuration ${name}: kept 3, depth ${r.depthReached}, states ${r.states}`)
    assert.equal(r.violation, null, show(r))
    assert.equal(r.depthReached, depth)
  })
}
test('second configuration: burned capacity 2 in the fork scenario is clean, and a third lock cannot be lifted', () => {
  const over = { burnCap: 2, preBurned: [901, 902] }
  const r = explore(scenario('fork', { over }))
  console.log(`second configuration fork: burned capacity 2 (two earlier locks), depth ${r.depthReached}, states ${r.states}`)
  assert.equal(r.violation, null, show(r))
  const steps = [
    P.copy('before-preparing'), P.make('A'), P.cycle('A', { verb: 'intent' }), P.proc('A', 'pending'),
    P.cycle('Ac', { verb: 'abandon' }), P.proc('Ac', 'BODY_KEY_FORKED'), P.move('B', false),
  ]
  const full = replay(cfgOf('fork', over), steps)
  assert.equal(statusOf(full.s.d, cfgOf('fork', over)).locked, true, 'the third lock stays: B, a new key, reads the chain locked (fails closed)')
  assert.equal(successors(full.json, cfgOf('fork', over)).filter(o => o.ev.kind === 'cycle' && o.ev.actor === 'B').length, 0, 'and cannot act')
  assert.deepEqual(full.s.d.burned, [901, 902])
  const room = replay(cfgOf('fork', { burnCap: 3, preBurned: [901, 902] }), [...steps, P.cycle('B', { verb: 'abandon' }), P.proc('B', 'abandoned')])
  assert.deepEqual(room.s.d.burned, [901, 902, 1], 'with room for it, the lock is burned and B clears the row')
})

// ---------------------------------------------------------------------------------------------------------------------
// 8. Reproducible, dependency-free, exportable.
test('the model imports nothing and uses no randomness or clock', () => {
  const src = readFileSync(new URL('./capsule-once-model.mjs', import.meta.url), 'utf8')
  assert.equal(/^\s*import\s/m.test(src), false, 'no imports')
  assert.equal(/\bimport\s*\(/.test(src), false, 'no dynamic import')
  for (const banned of ['Math.random', 'Date.now', 'new Date', 'performance.now', 'crypto', 'process.', 'setTimeout']) {
    assert.equal(src.includes(banned), false, `the model does not use ${banned}`)
  }
})
test('the platform serialiser and parser: once each in the model (its helpers), never in this file', () => {
  // the patterns are assembled from pieces, as in the capsule rule scan, so this file does not match itself
  const call = name => `${'JSON'}.${name}(`
  const countOf = (text, needle) => text.split(needle).length - 1
  const model = readFileSync(new URL('./capsule-once-model.mjs', import.meta.url), 'utf8')
  const self = readFileSync(new URL(import.meta.url), 'utf8')
  assert.deepEqual([countOf(model, call('stringify')), countOf(model, call('parse'))], [1, 1])
  assert.deepEqual([countOf(self, call('stringify')), countOf(self, call('parse'))], [0, 0])
  const value = { a: [1, { b: null }], c: 'x' }
  const copy = deepCopy(value)
  assert.deepEqual(copy, value)
  assert.notEqual(copy.a, value.a, 'a deep copy shares nothing')
  assert.deepEqual(fromKey(keyText(value)), value)
})
test('exploration is deterministic, and every explored trace is exported as data', () => {
  const cfg = scenario('honest', { depth: 5 })
  const a = explore(cfg, { stopAtFirst: false })
  const b = explore(cfg, { stopAtFirst: false })
  assert.equal(a.states, b.states)
  assert.equal(a.edges, b.edges)
  const traces = [...exploredTraces(cfg)]
  assert.equal(traces.length, a.states - 1)
  for (const tr of traces) {
    assert.ok(tr.steps.length >= 1 && tr.steps.length <= 5)
    for (const step of tr.steps) assert.equal(typeof step.kind, 'string')
  }
  assert.deepEqual(deepCopy(traces[traces.length - 1]), traces[traces.length - 1], 'plain JSON')
  const last = traces[traces.length - 1].steps
  assert.equal(replay(cfg, last.map(e => ({ ...e }))).trace.length, last.length, 'an exported trace replays through the model')
  assert.ok(select)
})
