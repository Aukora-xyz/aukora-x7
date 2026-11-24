/** The one rule for calls shared between requests in an isolate: nobody waits on another request's call without a
 * deadline of their own (shared-call.mjs). Manual timers; an "abandoned" call is a promise that never settles. */
import assert from 'node:assert/strict'
import test from 'node:test'
import * as sharedCall from '../shared-call.mjs'

const { createSharedCalls, SHARED_CALL_WAIT_MS } = sharedCall
// The code callers match on, spelled out here: it is part of what the Worker answers.
const SHARED_CALL_BUSY = 'SHARED_CALL_BUSY'

const tick = () => new Promise(resolve => setImmediate(resolve))
function manualTimers() {
  const pending = new Map()
  let next = 1
  return { setTimer: (run, ms) => { const id = next++; pending.set(id, { run, ms }); return id }, clearTimer: id => { pending.delete(id) },
    fire() { const due = [...pending.values()]; pending.clear(); for (const timer of due) timer.run() }, count: () => pending.size,
    fireOldest() { const id = Math.min(...pending.keys()), timer = pending.get(id); pending.delete(id); timer.run() },
    fireNewest() { const id = Math.max(...pending.keys()), timer = pending.get(id); pending.delete(id); timer.run() },
    waits: () => [...pending.values()].map(timer => timer.ms) }
}
const never = () => new Promise(() => {})
const PENDING = Symbol('pending')
const state = promise => Promise.race([promise.then(value => ({ value }), error => ({ error })), tick().then(() => PENDING)])

test('concurrent callers share one run; the slot is free again once it settles, for an answer or an error', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ ...timers })
  let runs = 0, release
  const run = () => { runs++; return new Promise(resolve => { release = resolve }) }
  const callers = [shared.call('k', run), shared.call('k', run), shared.call('k', run)]
  await tick()
  assert.equal(runs, 1)
  assert.equal(shared.size(), 1)
  assert.deepEqual(timers.waits(), [SHARED_CALL_WAIT_MS, SHARED_CALL_WAIT_MS])
  release('answer')
  assert.deepEqual(await Promise.all(callers), ['answer', 'answer', 'answer'])
  assert.equal(shared.size(), 0)
  assert.equal(timers.count(), 0, 'a settled wait leaves no timer behind')
  const failing = [shared.call('k', async () => { throw new Error('refused') }), shared.call('k', async () => 'unused')]
  for (const outcome of await Promise.allSettled(failing)) assert.equal(outcome.reason?.message, 'refused')
  assert.equal(shared.size(), 0)
  assert.equal(await shared.call('k', async () => 'again'), 'again')
})

test('keys are independent', async () => {
  const shared = createSharedCalls({ ...manualTimers() })
  const hung = shared.call('a', never)
  assert.equal(await shared.call('b', async () => 'b'), 'b')
  assert.equal(await state(hung), PENDING)
})

test('an abandoned call never holds later callers: after their own wait one takes it over and the rest share that', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 250, ...timers })
  const abandoned = shared.call('k', never)
  let runs = 0
  const run = async () => { runs++; return 'live' }
  const waiters = [shared.call('k', run), shared.call('k', run), shared.call('k', run)]
  await tick()
  assert.equal(runs, 0, 'within their wait they only share')
  assert.deepEqual(timers.waits(), [250, 250, 250])
  for (const waiter of waiters) assert.equal(await state(waiter), PENDING)
  timers.fire()
  assert.deepEqual(await Promise.all(waiters), ['live', 'live', 'live'])
  assert.equal(runs, 1, 'one takes over; the others share its live call')
  assert.equal(shared.size(), 0)
  assert.equal(await state(abandoned), PENDING)
  assert.equal(await shared.call('k', run), 'live')
  assert.equal(runs, 2)
})

test('an abandoned call that finishes late neither evicts nor replaces the call that took over', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 10, ...timers })
  let finishOld, finishNew
  const old = shared.call('k', () => new Promise(resolve => { finishOld = resolve }))
  const taker = shared.call('k', () => new Promise(resolve => { finishNew = resolve }))
  await tick()
  timers.fire()
  await tick()
  finishOld('old')
  assert.equal(await old, 'old')
  assert.equal(shared.size(), 1, 'the newer call still holds the slot')
  const sharer = shared.call('k', async () => 'unused')
  finishNew('new')
  assert.deepEqual(await Promise.all([taker, sharer]), ['new', 'new'])
  assert.equal(shared.size(), 0)
})

test('two waits on calls that do not settle: the caller starts nothing, is refused SHARED_CALL_BUSY (503) and leaves the slot as it is', async () => {
  // `maxWaits: 2` (the default is SHARED_CALL_MAX_WAITS): this case is the two-wait limit itself.
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 10, maxWaits: 2, ...timers })
  void shared.call('k', never)
  const first = shared.call('k', never) // waits with the caller, then takes the slot over with another dead call
  let runs = 0
  const caller = shared.call('k', async () => { runs++; return 'never run' })
  await tick()
  timers.fireOldest() // `first` gives up on the abandoned call and takes over: the slot holds a second dead call
  await tick()
  timers.fireOldest() // the caller's first wait ends: the slot is no longer the call it waited on, so it waits once more
  await tick()
  assert.equal(runs, 0)
  const second = shared.call('k', never)
  await tick()
  timers.fireNewest() // `second` takes over in turn: a third dead call
  await tick()
  timers.fireOldest() // the caller's second wait ends
  await assert.rejects(caller, error => error instanceof Error && error.code === SHARED_CALL_BUSY && error.status === 503)
  assert.equal(sharedCall.SHARED_CALL_BUSY, SHARED_CALL_BUSY)
  assert.equal(runs, 0, 'a caller out of waits never runs alone')
  assert.equal(shared.size(), 1, 'the refused caller neither takes nor clears the slot')
  assert.equal(timers.count(), 0)
  assert.equal(await state(first), PENDING)
  assert.equal(await state(second), PENDING)
})

for (const refuse of [false, true]) {
  test(`staggered waiters: the taker's call completes and clears before a later waiter's timer; that waiter gets its ${refuse ? 'refusal' : 'answer'} and starts nothing`, async () => {
    const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, ...timers })
    let runs = 0
    const abandoned = shared.call('k', () => { runs++; return never() }) // A
    await tick()
    const live = async () => { runs++; if (refuse) throw new Error('refused by the live call'); return 'live' }
    const b = shared.call('k', live)
    await tick()
    const c = shared.call('k', live) // arrives later: its own timer ends later
    await tick()
    assert.equal(timers.count(), 2)
    timers.fireOldest() // B's wait ends: B takes the slot over; its call completes and leaves the slot
    const outcomeOf = promise => promise.then(value => ({ value }), error => ({ error: error.message }))
    const expected = refuse ? { error: 'refused by the live call' } : { value: 'live' }
    assert.deepEqual(await outcomeOf(b), expected)
    assert.equal(runs, 2)
    assert.equal(await state(c), PENDING, 'C still waits on the abandoned call, on its own timer')
    timers.fireOldest() // C's wait ends: a call for its key settled since it arrived
    assert.deepEqual(await outcomeOf(c), expected)
    assert.equal(runs, 2, 'calls started: the abandoned one and the one that took over, never a third')
    assert.equal(shared.size(), 0, 'the kept outcome goes with the last caller that waited for it')
    assert.equal(timers.count(), 0)
    assert.equal(await state(abandoned), PENDING)
  })
}

test('many waiters while calls never settle: one new call per wait window, callers out of waits are refused, none waits a third time', async () => {
  // `maxWaits: 2`: the window-by-window counts below are those of a two-wait limit (the default is tested further down).
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, maxWaits: 2, ...timers })
  let runs = 0
  const run = () => { runs++; return never() }
  const callers = []
  // Each caller's end is noted as it happens: 'pending' until then.
  const arrive = async count => {
    for (let index = 0; index < count; index++) {
      const caller = { end: 'pending' }
      shared.call('k', run).then(() => { caller.end = 'answered' }, error => { caller.end = error.code === SHARED_CALL_BUSY && error.status === 503 ? 'busy 503' : 'failed' })
      callers.push(caller)
      await tick()
    }
  }
  const ends = value => callers.filter(caller => caller.end === value).length
  await arrive(8) // caller 0 starts the first call; seven wait on it
  assert.equal(runs, 1)
  const window = async () => { const before = runs; timers.fire(); await tick(); return runs - before }
  // Window 1: one of the seven replaces the abandoned call; the other six wait once more, on that one.
  assert.equal(await window(), 1)
  assert.deepEqual([ends('pending'), ends('busy 503'), timers.count()], [8, 0, 6])
  await arrive(6)
  // Window 2: the six are out of waits and are refused; one of the newer six replaces the second call.
  assert.equal(await window(), 1)
  assert.deepEqual([ends('pending'), ends('busy 503'), timers.count()], [8, 6, 5])
  await arrive(6)
  // Window 3: five more are refused; one of the newest six replaces the third call.
  assert.equal(await window(), 1)
  assert.deepEqual([ends('pending'), ends('busy 503'), timers.count()], [9, 11, 5])
  // Window 4: nobody new arrived, so nothing new starts, and the last five are refused.
  assert.equal(await window(), 0)
  assert.equal(callers.length, 20)
  assert.equal(runs, 4, 'twenty callers, four calls: the first, then one per window while somebody new waited')
  // The four that started a call await their own request's work (no helper deadline); everybody else was refused.
  assert.deepEqual([ends('pending'), ends('busy 503'), ends('answered'), ends('failed')], [4, 16, 0, 0])
  assert.equal(timers.count(), 0, 'nobody is left waiting on a call they did not start')
  assert.equal(shared.size(), 1)
})

test('every started call gets the next sequence number, whoever starts it and however it ends', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, ...timers })
  const seqs = []
  const note = (result, fail = false) => async ({ seq }) => { seqs.push(seq); if (fail) throw new Error(result); return result }
  assert.equal(await shared.call('a', note('one')), 'one')
  await assert.rejects(shared.call('a', note('two', true)), /two/)
  assert.equal(await shared.call('b', note('three')), 'three')
  void shared.call('a', args => { seqs.push(args.seq); return never() })
  await tick()
  const taker = shared.call('a', note('five')), sharer = shared.call('a', note('unused'))
  await tick()
  assert.deepEqual(seqs, [1, 2, 3, 4], 'waiting starts nothing')
  timers.fire()
  assert.deepEqual(await Promise.all([taker, sharer]), ['five', 'five'])
  assert.deepEqual(seqs, [1, 2, 3, 4, 5])
})

test('a replaced call that settles late answers the callers still waiting for its key, who start nothing', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, ...timers })
  let runs = 0, finishSlow
  const slow = shared.call('k', () => { runs++; return new Promise(resolve => { finishSlow = resolve }) })
  await tick()
  const taker = shared.call('k', () => { runs++; return never() })
  await tick()
  const waiter = shared.call('k', async () => { runs++; return 'unused' })
  await tick()
  timers.fireOldest() // the taker replaces the slow call with one that never settles
  await tick()
  timers.fireOldest() // the waiter's first wait ends: somebody took over, so it waits on that call once more
  await tick()
  assert.equal(runs, 2)
  assert.equal(await state(waiter), PENDING)
  finishSlow('slow answer') // the replaced call settles after all: it never touches the slot of the call that replaced it
  assert.equal(await slow, 'slow answer')
  assert.equal(shared.size(), 1)
  timers.fireOldest() // the waiter's second wait ends: a call for its key settled since it arrived
  assert.equal(await waiter, 'slow answer')
  assert.equal(runs, 2)
  assert.equal(await state(taker), PENDING)
  // A caller arriving now was not waiting when that call settled: its answer is not theirs.
  const late = shared.call('k', async () => { runs++; return 'unused' })
  await tick()
  assert.equal(await state(late), PENDING)
  assert.equal(runs, 2)
})

test('a replaced call that settles after a newer call answers nobody who arrived since, and never replaces the newer outcome', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, ...timers })
  let runs = 0, finishOld, finishNew
  const old = shared.call('k', () => { runs++; return new Promise(resolve => { finishOld = resolve }) }) // seq 1, slow
  await tick()
  const taker = shared.call('k', () => { runs++; return new Promise(resolve => { finishNew = resolve }) })
  await tick()
  timers.fire() // the taker replaces the slow call: seq 2
  await tick()
  finishNew('new') // the newer call completes; nobody waits, the slot is empty again
  assert.equal(await taker, 'new')
  assert.equal(shared.size(), 0)
  void shared.call('k', () => { runs++; return never() }) // seq 3, slow
  await tick()
  const late = shared.call('k', async () => { runs++; return 'own' }) // arrives AFTER 'new' settled; watches seq 3
  await tick()
  finishOld('old') // the call replaced long ago settles at last
  assert.equal(await old, 'old', 'its own caller still gets it')
  timers.fire() // the late caller's wait ends: nothing newer than 'new' has settled since it arrived
  assert.equal(await late, 'own', 'an answer older than one that had settled before the caller arrived was handed to it')
  assert.equal(runs, 4)
  // Within one wait: the newer call settles first, the older one after it. A caller that waited through both gets the newer.
  const both = createSharedCalls({ waitMs: 20, ...timers })
  let finishFirst, finishSecond
  const first = both.call('k', () => new Promise(resolve => { finishFirst = resolve }))
  await tick()
  const second = both.call('k', () => new Promise(resolve => { finishSecond = resolve }))
  await tick()
  const through = both.call('k', async () => 'unused') // watches the first call; its own timer ends later
  await tick()
  timers.fireOldest() // `second` replaces the first call
  await tick()
  finishSecond('newer')
  assert.equal(await second, 'newer')
  finishFirst('older')
  assert.equal(await first, 'older')
  assert.equal(await through, 'newer', 'the older call\'s late outcome replaced the newer one')
  assert.equal(both.size(), 0)
  assert.equal(timers.count(), 0)
})

test('a waiter whose request is cancelled is counted in its row only: nothing about it outlives the bounded table', async () => {
  // A cancelled request: its timer never fires and its continuation never runs, so it never leaves its wait.
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, capacity: 2, ...timers })
  for (let index = 0; index < 5; index++) {
    void shared.call('subject-' + index, never) // a check in flight for this subject
    await tick()
    void shared.call('subject-' + index, async () => 'unused') // a second request waits on it, then is cancelled
    await tick()
    assert.ok(shared.size() <= 2)
  }
  // Two other keys arrive: the table is full, so the rows of the last cancelled waiters go, with their counts.
  for (const key of ['a', 'b']) void shared.call(key, never)
  await tick()
  for (let index = 0; index < 5; index++) {
    // Nobody in the table waits for this subject any more: its next call is kept for nobody and leaves no row behind.
    assert.equal(await shared.call('subject-' + index, async () => 'served'), 'served')
  }
  assert.equal(shared.size(), 1, 'only the abandoned call of the newest other key is left; no subject kept a row')
  const fresh = createSharedCalls({ waitMs: 20, capacity: 1, ...timers })
  void fresh.call('x', never)
  await tick()
  void fresh.call('x', async () => 'unused') // cancelled while waiting
  await tick()
  assert.equal(await fresh.call('y', async () => 'y'), 'y') // the table is full: the row of 'x' goes, with its waiter's count
  assert.equal(fresh.size(), 0)
  assert.equal(await fresh.call('x', async () => 'x'), 'x')
  assert.equal(fresh.size(), 0, 'the cancelled waiter is still counted for its key, outside the table')
})

test('entries and kept outcomes share one bounded table; losing a row costs one extra call, never a hang', async () => {
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, capacity: 1, ...timers })
  let runs = 0
  void shared.call('a', () => { runs++; return never() })
  await tick()
  const waiter = shared.call('a', async () => { runs++; return 'served' })
  await tick()
  void shared.call('b', never) // the table is full: the row of 'a' goes, with the call its waiter watches
  await tick()
  assert.equal(shared.size(), 1)
  timers.fire() // the waiter finds neither its call nor an outcome: it starts one call and is answered
  assert.equal(await waiter, 'served')
  assert.equal(runs, 2)
  assert.ok(shared.size() <= 1)
  // A kept outcome never outlives the callers waiting for it, so settled keys leave nothing behind.
  const kept = createSharedCalls({ waitMs: 20, capacity: 2, ...timers })
  for (let index = 0; index < 20; index++) {
    void kept.call('key-' + index, never)
    await tick()
    const taker = kept.call('key-' + index, async () => 'live'), sharer = kept.call('key-' + index, async () => 'unused')
    await tick()
    timers.fire()
    assert.deepEqual(await Promise.all([taker, sharer]), ['live', 'live'])
    assert.ok(kept.size() <= 2)
  }
  assert.equal(kept.size(), 0)
})

test('the table is bounded: abandoned calls nobody asks about again cannot grow it past its capacity', async () => {
  const shared = createSharedCalls({ capacity: 3, ...manualTimers() })
  for (let index = 0; index < 50; index++) void shared.call('subject-' + index, never)
  await tick()
  assert.equal(shared.size(), 3)
  assert.equal(await shared.call('fresh', async () => 'served'), 'served')
  assert.throws(() => createSharedCalls({ capacity: 0 }), TypeError)
  assert.throws(() => createSharedCalls({ waitMs: -1 }), TypeError)
})

test('the default is five waits: a caller is refused only after its fifth; at most one new call per window, and only after a first wait', async () => {
  assert.equal(sharedCall.SHARED_CALL_MAX_WAITS, 5)
  assert.throws(() => createSharedCalls({ maxWaits: 0 }), TypeError)
  assert.throws(() => createSharedCalls({ maxWaits: 1.5 }), TypeError)
  const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, ...timers })
  let runs = 0
  const run = () => { runs++; return never() }
  const callers = []
  const arrive = async count => {
    for (let index = 0; index < count; index++) {
      const caller = { end: 'pending' }
      shared.call('k', run).then(() => { caller.end = 'answered' }, error => { caller.end = error.code === SHARED_CALL_BUSY && error.status === 503 ? 'busy 503' : 'failed' })
      callers.push(caller)
      await tick()
    }
  }
  const ends = value => callers.filter(caller => caller.end === value).length
  const window = async () => { const before = runs; timers.fire(); await tick(); return runs - before }
  await arrive(4) // caller 0 starts call A; callers 1-3 wait on it
  assert.equal(runs, 1)
  // Window 1: caller 1 replaces A (call B); callers 2 and 3 watch B.
  assert.equal(await window(), 1)
  await arrive(1) // caller 4 arrives after that takeover and watches B
  // Window 2: caller 4's FIRST wait on B ends with B in the slot: it replaces B (call C). Callers 2 and 3 had their
  // second wait on B: no takeover after a later wait, so they start nothing and keep waiting.
  assert.equal(await window(), 1)
  assert.deepEqual([ends('pending'), timers.count()], [5, 2])
  // Windows 3 and 4: nobody new arrived, so nothing starts; callers 2 and 3 follow C, then give it another wait.
  for (let index = 3; index <= 4; index++) {
    assert.equal(await window(), 0, `window ${String(index)}`)
    assert.deepEqual([ends('pending'), ends('busy 503'), timers.count()], [5, 0, 2], `window ${String(index)}`)
  }
  // Window 5: their fifth wait ends with no answer: refused, never running alone.
  assert.equal(await window(), 0)
  assert.deepEqual([ends('pending'), ends('busy 503'), ends('answered'), ends('failed')], [3, 2, 0, 0])
  assert.equal(runs, 3, 'five callers, three calls: the first and one per window in which a caller ended its FIRST wait')
  assert.equal(timers.count(), 0)
})

for (const maxWaits of [5, 2]) {
  test(`a slow live call that took over settles during the fourth wait: with maxWaits ${String(maxWaits)} ${maxWaits === 5 ? 'it answers everyone who waited, and nobody started another call' : 'the callers had been refused after their second wait'}`, async () => {
    const timers = manualTimers(), shared = createSharedCalls({ waitMs: 20, maxWaits, ...timers })
    let runs = 0, finish = null
    const abandoned = shared.call('k', () => { runs++; return never() }) // call A, its request cancelled
    await tick()
    const slowLive = () => { runs++; return new Promise(resolve => { finish = resolve }) }
    const outcomes = [], callers = []
    for (let index = 0; index < 3; index++) {
      const done = shared.call('k', slowLive).then(value => ({ value }), error => ({ error: error.code }))
      callers.push(done.then(outcome => { outcomes[index] = outcome }))
      await tick()
    }
    // Wait 1 ends: the first caller replaces A with the slow live call B; the others watch B.
    timers.fire(); await tick()
    assert.equal(runs, 2)
    // Waits 2 and 3 end with B still running: no further call (a takeover only ever follows a FIRST wait).
    for (let wait = 2; wait <= 3; wait++) { timers.fire(); await tick() }
    assert.equal(runs, 2)
    finish('live') // during the fourth wait
    await Promise.all(callers)
    if (maxWaits === 5) assert.deepEqual(outcomes, [{ value: 'live' }, { value: 'live' }, { value: 'live' }])
    else assert.deepEqual(outcomes, [{ value: 'live' }, { error: SHARED_CALL_BUSY }, { error: SHARED_CALL_BUSY }])
    assert.equal(runs, 2, 'calls started: A and the one takeover, never a third')
    assert.equal(timers.count(), 0)
    assert.equal(shared.size(), 0, 'the slot is free once B settled')
    assert.equal(await state(abandoned), PENDING)
  })
}
