/** More cases for Auma's crew relay (her own nine cases are in crew-relay.test.mjs):
 *  1. a read is ONE call that asks Linear for both ends of the comment list and answers from the newest page, whichever
 *     way Linear lists; it never walks further back, and says `gap: true` when the reader's cursor is older than that page;
 *  2. times are instants; a page list that cannot be trusted is refused;
 *  3. Linear's answer is bounded in size and time by the relay itself, a redirect is refused, a rate limit is said as one;
 *  4. one post at a time, with a slot that frees itself and a turn that is checked again right before the write;
 *  5. through the real Worker the route is owner-only and same-origin, and the key never appears in an answer. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createCrewRelay, RELAY_CHECKS } from '../crew-relay.mjs'
import { createWorker } from '../worker.mjs'

const ACCESS = { type: 'owner', email: 'owner@example.invalid' }
const KEY = 'relay-test-key-not-a-real-secret'
const ENV = { LINEAR_API_KEY: KEY }
const ISSUE = { id: 'issue-1', identifier: 'YOUR_TEAM-0', title: 'CREW RELAY' }
const ORDERS = ['newest-first', 'oldest-first']
const stamp = n => new Date(Date.UTC(2026, 10, 12, 0, 0, n)).toISOString()
const comment = n => ({ id: 'c' + String(n).padStart(4, '0'), body: 'line ' + n, createdAt: stamp(n), user: { name: 'Crew' } })
const range = (from, to) => Array.from({ length: Math.max(0, to - from + 1) }, (_, i) => comment(from + i))
const ids = list => list.map(item => item.id)
/** Linear's answer to the read: the first page under `comments`, the last page under `tail`. */
const ends = (headNodes, pageInfo, tailNodes, issue = ISSUE) => Response.json({ data: { issues: { nodes: [{ ...issue,
  comments: { nodes: headNodes, ...(pageInfo === undefined ? {} : { pageInfo }) }, ...(tailNodes === undefined ? {} : { tail: { nodes: tailNodes } }) }] } } })
const created = (id = 'new') => Response.json({ data: { commentCreate: { success: true, comment: { id, createdAt: stamp(9999) } } } })
/** A comment as Linear would answer it: only the fields that ONE selection (`nodes { … }`) of the query names. */
const projected = (selection, node) => {
  const fields = selection.replace(/user \{ name \}/, '').split(/\s+/).filter(Boolean)
  const out = Object.fromEntries(fields.filter(field => field in node).map(field => [field, node[field]]))
  if (/user \{ name \}/.test(selection)) out.user = node.user
  return out
}
/** The comment selection of the first page and of the last page (the alias `tail`), each as the query wrote it. */
const selections = query => ({
  head: /\n\s+comments\(first: \$comments\) \{\s*nodes \{ ((?:[^{}]|\{[^{}]*\})*) \}/.exec(query)?.[1] ?? '',
  tail: /\n\s+tail: comments\(last: \$comments\) \{\s*nodes \{ ((?:[^{}]|\{[^{}]*\})*) \}/.exec(query)?.[1] ?? '',
})

/** A stand-in for Linear. `all` is given oldest first; `listed` is the order Linear's own list has. */
function linearStub(all, { listed = 'newest-first', failAt = null } = {}) {
  const list = listed === 'newest-first' ? [...all].reverse() : [...all]
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    calls.push({ url, authorization: init.headers.authorization, variables: body.variables, query: body.query, redirect: init.redirect, signal: init.signal })
    if (failAt !== null && calls.length === failAt) throw new Error('network down: ' + init.headers.authorization)
    if (/commentCreate/.test(body.query)) {
      // Only what the mutation selects comes back.
      const answer = { ...(/\bsuccess\b/.test(body.query) ? { success: true } : {}), ...(/comment \{ id createdAt \}/.test(body.query) ? { comment: { id: 'new', createdAt: stamp(9999) } } : {}) }
      return Response.json({ data: { commentCreate: answer } })
    }
    // The lookup before a write gets only the issue fields it selects.
    if (!/comments\(/.test(body.query)) return Response.json({ data: { issues: { nodes: [Object.fromEntries(Object.entries(ISSUE).filter(([field]) => new RegExp('\\n\\s+' + field + '\\n').test(body.query)))] } } })
    const size = body.variables.comments
    const selected = selections(body.query)
    // Only what the query asks for is answered: the first page under `comments`, the last page under the alias `tail`.
    const wantsHead = /\n\s+comments\(first: \$comments\) \{/.test(body.query)
    const wantsTail = /\n\s+tail: comments\(last: \$comments\) \{/.test(body.query)
    const wantsInfo = /pageInfo \{ hasNextPage \}/.test(body.query)
    if (!wantsHead) return Response.json({ errors: [{ message: 'the stand-in was not asked for the first page' }] })
    // The issue itself comes back with only the fields the query names before its comments.
    const issueFields = Object.fromEntries(Object.entries(ISSUE).filter(([field]) => new RegExp('nodes \\{\\s+(?:\\w+\\s+)*' + field + '\\s').test(body.query.slice(0, body.query.indexOf('comments(')))))
    return ends(list.slice(0, size).map(node => projected(selected.head, node)), wantsInfo ? { hasNextPage: list.length > size } : undefined,
      wantsTail ? list.slice(Math.max(0, list.length - size)).map(node => projected(selected.tail, node)) : undefined, issueFields)
  }
  return { calls, fetchImpl }
}
const get = after => {
  const url = new URL('https://relay.example.invalid/_host/crew-relay')
  if (after !== undefined) url.searchParams.set('after', after)
  return new Request(url)
}
const post = (body, headers = {}) => new Request('https://relay.example.invalid/_host/crew-relay', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body })
const answerOf = async response => ({ status: response.status, body: await response.json() })
const read = async (relay, after) => (await relay(get(after), ENV, ACCESS)).json()

// ---- the read ---------------------------------------------------------------------------------------------------------
for (const listed of ORDERS) {
  test(`a read is one call and answers the newest page, oldest first, for any length (Linear lists ${listed})`, async () => {
    for (const total of [0, 1, 49, 50, 51, 99, 100, 101, 5000]) {
      const all = range(1, total)
      const { fetchImpl, calls } = linearStub(all, { listed })
      const relay = createCrewRelay({ fetchImpl })
      const body = await read(relay)
      assert.deepEqual(ids(body.comments), ids(all.slice(-50)), `${total} comments`)
      // Each comment comes back whole: its id, its words, its time and who wrote it, and nothing else.
      assert.deepEqual(body.comments, all.slice(-50).map(item => ({ id: item.id, body: item.body, createdAt: item.createdAt, author: 'Crew' })), `${total} comments`)
      assert.deepEqual(body.issue, { identifier: 'YOUR_TEAM-0', title: 'CREW RELAY' })
      assert.equal(body.gap, false, 'without a cursor there is nothing to miss')
      assert.equal(calls.length, 1, `${total} comments cost one call`)
      assert.deepEqual(calls[0].variables, { teamKey: 'YOUR_TEAM', number: 0, comments: 50 })
      await read(relay); await read(relay, stamp(1))
      assert.equal(calls.length, 3, 'every read is one call; nothing is remembered between reads')
    }
  })

  test(`a cursor returns what is newer on the newest page, and says when it is older than that page (Linear lists ${listed})`, async () => {
    const all = range(1, 120)
    const relay = createCrewRelay({ fetchImpl: linearStub(all, { listed }).fetchImpl })
    const cases = [
      // cursor, the comments expected, gap
      [stamp(110), all.slice(110), false], // inside the newest page
      [stamp(71), all.slice(71), false], // exactly the newest page's oldest instant: everything after it is here
      [stamp(70), all.slice(70), true], // just before the page: nothing is missing here, but one call cannot know that
      [stamp(69), all.slice(70), true], // one comment (c0070) is newer than the cursor and NOT on the page
      [stamp(0), all.slice(70), true], // older than everything
      [stamp(120), [], false], // the newest instant
      [stamp(500), [], false], // the future
    ]
    for (const [cursor, want, gap] of cases) {
      const body = await read(relay, cursor)
      assert.deepEqual(ids(body.comments), ids(want), cursor)
      assert.equal(body.gap, gap, cursor)
    }
    // An issue that fits on one page has no gap, however old the cursor.
    const small = await read(createCrewRelay({ fetchImpl: linearStub(range(1, 50), { listed }).fetchImpl }), stamp(0))
    assert.equal(small.comments.length, 50)
    assert.equal(small.gap, false)
  })

  test(`comments at one instant: no cursor that is not older than them reports a gap or an error (Linear lists ${listed})`, async () => {
    const tied = (from, to, at) => range(from, to).map(item => ({ ...item, createdAt: stamp(at) }))
    // 5,000 comments, every one at instant 7.
    const all = tied(1, 5000, 7)
    const relay = createCrewRelay({ fetchImpl: linearStub(all, { listed }).fetchImpl })
    assert.equal((await read(relay)).comments.length, 50)
    assert.deepEqual(await read(relay, stamp(7)), { ok: true, schema: 'aukora.crew-relay.v1', issue: { identifier: 'YOUR_TEAM-0', title: 'CREW RELAY' }, comments: [], gap: false })
    assert.deepEqual((await read(relay, stamp(900))).comments, [])
    const older = await read(relay, stamp(1))
    assert.equal(older.comments.length, 50)
    assert.equal(older.gap, true)
    // The oldest 50 share instant 3 and 51 newer ones follow: a cursor AT 3 must find the newer ones, from either end.
    const mixed = [...tied(1, 50, 3), ...range(51, 101)]
    const second = createCrewRelay({ fetchImpl: linearStub(mixed, { listed }).fetchImpl })
    const body = await read(second, stamp(3))
    assert.deepEqual(ids(body.comments), ids(mixed.slice(-50)))
    assert.equal(body.gap, true, 'c0051 is newer than the cursor and not on the newest page')
  })
}

test('times are compared as instants; comments at one instant are ordered by id', async () => {
  const at = (iso, id) => ({ id, body: id, createdAt: iso, user: { name: 'Crew' } })
  const all = [at('2026-11-12T09:59:59.000Z', 'before'), at('2026-11-12T10:00:00Z', 'zero'), at('2026-11-12T10:00:00.500Z', 'half'), at('2026-11-12T10:00:01Z', 'next')]
  for (const listed of ORDERS) {
    const relay = createCrewRelay({ fetchImpl: linearStub(all, { listed }).fetchImpl })
    // As text "…00.500Z" sorts before "…00Z"; as instants it comes after.
    assert.deepEqual(ids((await read(relay)).comments), ['before', 'zero', 'half', 'next'])
    assert.deepEqual(ids((await read(relay, '2026-11-12T10:00:00Z')).comments), ['half', 'next'])
    // The same instant written two ways is one instant: nothing at 10:00:01 is "after" 10:00:01.000.
    assert.deepEqual((await read(relay, '2026-11-12T10:00:01.000Z')).comments, [])
  }
  const shuffled = ['m', 'b', 'z', 'a', 'k'].map(id => at('2026-11-12T10:00:00Z', id))
  assert.deepEqual(ids((await read(createCrewRelay({ fetchImpl: async () => ends(shuffled, { hasNextPage: false }) }))).comments), ['a', 'b', 'k', 'm', 'z'])
  const { fetchImpl, calls } = linearStub(all)
  const relay = createCrewRelay({ fetchImpl })
  // A cursor is a time this relay handed out (milliseconds at most); anything else is refused before Linear is asked.
  for (const bad of ['2026-11-12', '2026-11-12T10:00:00+08:00', '2026-13-40T99:00:00Z', 'now', '2026-11-12T10:00:00.0001Z', '']) {
    assert.deepEqual(await answerOf(await relay(get(bad), ENV, ACCESS)), { status: 400, body: { ok: false, code: 'RELAY_AFTER_INVALID' } }, bad)
  }
  assert.equal(calls.length, 0)
})

test('a comment listed twice on a page is one comment', async () => {
  const page = [comment(3), comment(2), comment(2), comment(1)]
  assert.deepEqual(ids((await read(createCrewRelay({ fetchImpl: async () => ends(page, { hasNextPage: false }) }))).comments), ['c0001', 'c0002', 'c0003'])
})

test('a page list that cannot be trusted is refused, never guessed at', async () => {
  const newest = range(51, 100).reverse() // a full first page of a list that runs newest first
  const oldest = range(1, 50).reverse() // its last page
  const cases = [
    ['a full page with no page information', () => ends(newest), 'page-info'],
    ['hasNextPage is not a boolean', () => ends(newest, { hasNextPage: 'yes' }, oldest), 'page-info'],
    ['more is promised and the other end is missing', () => ends(newest, { hasNextPage: true }), 'tail-page-shape'],
    ['more is promised and the other end is empty', () => ends(newest, { hasNextPage: true }, []), 'empty-end'],
    ['the other end is not a list', () => Response.json({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: newest, pageInfo: { hasNextPage: true } }, tail: {} }] } } }), 'tail-page-shape'],
    ['a comment with no time', () => ends([{ id: 'x', body: 'x', user: null }], { hasNextPage: false }), 'head-comment-time'],
    ['a comment with no id', () => ends([{ body: 'x', createdAt: stamp(1) }], { hasNextPage: false }), 'head-comment-shape'],
    ['a time finer than a millisecond', () => ends([{ ...comment(1), createdAt: '2026-11-12T10:00:00.0002Z' }], { hasNextPage: false }), 'head-comment-time'],
    ['comments is not a list', () => Response.json({ data: { issues: { nodes: [{ ...ISSUE, comments: {} }] } } }), 'head-page-shape'],
    ['a page in no time order', () => ends([comment(3), comment(1), comment(2)], { hasNextPage: false }), 'head-order'],
    ['the other end in no time order', () => ends(newest, { hasNextPage: true }, [comment(3), comment(1), comment(2)]), 'tail-order'],
    ['the first page runs newest first but the last page holds something newer', () => ends(newest, { hasNextPage: true }, range(150, 199).reverse()), 'outside-page'],
    ['the last page is taken as newest but the first page starts later', () => ends(range(60, 109), { hasNextPage: true }, range(51, 100)), 'outside-page'],
    // 100 different comments: the first page has instants 1 to 50, the last page has instants 26 to 75. Each page is in
    // order and the last page is later at both ends, yet h0050 (instant 50) is newer than half of the page taken.
    ['two ends that overlap in TIME but share no comment', () => ends(range(1, 50).map(item => ({ ...item, id: 'h' + item.id })), { hasNextPage: true }, range(26, 75).map(item => ({ ...item, id: 't' + item.id }))), 'outside-page'],
    ['the same, listed newest first', () => ends(range(26, 75).map(item => ({ ...item, id: 't' + item.id })).reverse(), { hasNextPage: true }, range(1, 50).map(item => ({ ...item, id: 'h' + item.id })).reverse()), 'outside-page'],
    // One comment on both ends with two different times: h1..h49 then shared@1000 | shared@50 then t51..t99.
    ['one comment on both ends with two times', () => ends([...range(1, 49), { ...comment(1000), id: 'shared' }], { hasNextPage: true }, [{ ...comment(50), id: 'shared' }, ...range(51, 99)]), 'two-times'],
    ['the same, listed newest first', () => ends([...range(51, 99).reverse(), { ...comment(50), id: 'shared' }], { hasNextPage: true }, [{ ...comment(1000), id: 'shared' }, ...range(1, 49).reverse()]), 'two-times'],
    ['one comment twice on one page with two times', () => ends([comment(3), { ...comment(2), id: 'twice' }, { ...comment(1), id: 'twice' }], { hasNextPage: false }), 'two-times'],
    // The first page says it is the whole list, and the other end that came with it says otherwise.
    ['a whole list whose other end holds another comment', () => ends([comment(1)], { hasNextPage: false }, [comment(1000)]), 'whole-list-mismatch'],
    ['the same, with no page information', () => ends([comment(1)], undefined, [comment(1000)]), 'whole-list-mismatch'],
    ['a whole list whose other end shows its comment at another time', () => ends([comment(1)], { hasNextPage: false }, [{ ...comment(1000), id: comment(1).id }]), 'whole-list-mismatch'],
    ['the same, with no page information', () => ends([comment(1)], undefined, [{ ...comment(1000), id: comment(1).id }]), 'whole-list-mismatch'],
    ['a whole list whose other end lacks one of its comments', () => ends([comment(2), comment(1)], { hasNextPage: false }, [comment(2)]), 'whole-list-mismatch'],
    ['a whole list whose other end is in no time order', () => ends([comment(3), comment(2), comment(1)], { hasNextPage: false }, [comment(2), comment(3), comment(1)]), 'tail-order'],
    ['a first page longer than what was asked for', () => ends(range(1, 51).reverse(), { hasNextPage: false }, range(1, 51).reverse()), 'head-page-shape'],
    ['a last page longer than what was asked for', () => ends(range(1001, 1050).reverse(), { hasNextPage: true }, range(1, 51).reverse()), 'tail-page-shape'],
    ['a whole list whose other end is not a list', () => Response.json({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [comment(1)], pageInfo: { hasNextPage: false } }, tail: {} }] } } }), 'tail-page-shape'],
  ]
  assert.equal(cases.length, 27)
  for (const [name, answer, check] of cases) {
    // Each refusal names the rule that fired, as one word from the closed list.
    assert.ok(RELAY_CHECKS.includes(check), name)
    for (const request of [get(), get(stamp(999)), get(stamp(0))]) {
      let calls = 0
      const response = await createCrewRelay({ fetchImpl: async () => { calls += 1; return answer() } })(request, ENV, ACCESS)
      assert.deepEqual(await answerOf(response), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check } }, name)
      assert.equal(calls, 1, name)
    }
  }
})

// ---- Linear's two ends run in opposite directions (as measured on a live edge) -----------------------------------------
/** Linear's answer as measured: `first` is the newest page, newest first; `last` the oldest page, oldest first. The
 *  mirror lists the oldest page first, oldest first, and the newest page last, newest first. `all` is oldest first. */
const measured = (all, { mirror = false } = {}) => {
  const newestPage = all.slice(-50).reverse()
  const oldestPage = all.slice(0, 50)
  return mirror ? ends(oldestPage, { hasNextPage: all.length > 50 }, [...newestPage]) : ends(newestPage, { hasNextPage: all.length > 50 }, oldestPage)
}

test('the measured answer and its mirror are read: the newest page, each comment once, oldest first, gap as before', async () => {
  const tied = (list, at) => list.map(item => ({ ...item, createdAt: stamp(at) }))
  const cases = [
    // name, the whole list oldest first, the cursor checks: [cursor, gap]
    ['93 comments: the two ends share 7', range(1, 93), [[stamp(10), true], [stamp(43), true], [stamp(44), false], [stamp(93), false]]],
    ['5,000 comments: the two ends share none', range(1, 5000), [[stamp(1), true], [stamp(4951), false]]],
    ['60 comments, the newest 15 at one instant: both ends reach it', [...range(1, 45), ...tied(range(46, 60), 900)], [[stamp(10), true], [stamp(11), false]]],
  ]
  for (const mirror of [false, true]) {
    for (const [name, all, cursors] of cases) {
      const label = `${name}${mirror ? ' (mirror)' : ''}`
      let calls = 0
      const relay = createCrewRelay({ fetchImpl: async () => { calls += 1; return measured(all, { mirror }) } })
      const body = await read(relay)
      assert.equal(body.ok, true, label)
      const want = all.slice(-50)
      assert.deepEqual(body.comments, want.map(item => ({ id: item.id, body: item.body, createdAt: item.createdAt, author: 'Crew' })), label)
      assert.equal(body.gap, false, label)
      for (const [cursor, gap] of cursors) {
        const after = await read(relay, cursor)
        assert.deepEqual(ids(after.comments), ids(want.filter(item => Date.parse(item.createdAt) > Date.parse(cursor))), label + ' ' + cursor)
        assert.equal(after.gap, gap, label + ' ' + cursor)
      }
      assert.equal(calls, 1 + cursors.length, label + ': one call per read')
    }
    // Every comment at one instant: either end is a newest page; the read answers one page of 50 and no gap at that instant.
    const flat = tied(range(1, 5000), 7)
    const relay = createCrewRelay({ fetchImpl: async () => measured(flat, { mirror }) })
    const body = await read(relay)
    assert.equal(body.comments.length, 50, 'flat' + (mirror ? ' (mirror)' : ''))
    assert.deepEqual(ids(body.comments), [...ids(body.comments)].sort(), 'ordered by id')
    assert.deepEqual(await read(relay, stamp(7)), { ok: true, schema: 'aukora.crew-relay.v1', issue: { identifier: 'YOUR_TEAM-0', title: 'CREW RELAY' }, comments: [], gap: false })
    assert.equal((await read(relay, stamp(1))).gap, true)
  }
})

test('the measured answer, with fixed instants at the edges of each end, is read from the first page', async () => {
  // 93 comments; the instants at the edges of each end are fixed, in the form `?shape=1` reports them:
  // the oldest, the first page's oldest (index 43), the last page's newest (index 49) and the newest. Between them,
  // evenly spaced. First page: indices 92..43 newest first; last page: 0..49 oldest first; 7 shared.
  const anchors = [[0, '2026-01-01T00:00:00.000Z'], [43, '2026-01-01T09:00:00.000Z'], [49, '2026-01-01T13:00:00.000Z'], [92, '2026-01-01T17:00:00.000Z']]
  const msAt = i => {
    const k = anchors.findIndex(([index], n) => i <= index || n === anchors.length - 1)
    if (k === 0) return Date.parse(anchors[0][1])
    const [i0, t0] = anchors[k - 1]
    const [i1, t1] = anchors[k]
    return Date.parse(t0) + Math.round((Date.parse(t1) - Date.parse(t0)) * (i - i0) / (i1 - i0))
  }
  const all = Array.from({ length: 93 }, (_, i) => ({ id: 'm' + String(i).padStart(2, '0'), body: 'line ' + i, createdAt: new Date(msAt(i)).toISOString(), user: { name: 'Crew' } }))
  const fetchImpl = async () => measured(all)
  const endEdges = (count, trend, first, last, newest, oldest) => ({ count, trend, first, last, newest, oldest })
  assert.deepEqual(await shapeOf(fetchImpl, all), {
    head: endEdges(50, -1, '2026-01-01T17:00:00.000Z', '2026-01-01T09:00:00.000Z', '2026-01-01T17:00:00.000Z', '2026-01-01T09:00:00.000Z'),
    tail: endEdges(50, 1, '2026-01-01T00:00:00.000Z', '2026-01-01T13:00:00.000Z', '2026-01-01T13:00:00.000Z', '2026-01-01T00:00:00.000Z'),
    hasNextPage: true, shared: 7, sameTimes: true, instants: { accepted: 100, refused: 0 },
  })
  const response = await createCrewRelay({ fetchImpl })(get(), ENV, ACCESS)
  const body = await response.json()
  assert.equal(response.status, 200)
  assert.deepEqual(ids(body.comments), ids(all.slice(43)), 'the first page, each comment once, oldest first')
  assert.equal(body.gap, false)
})

test('with the ends in opposite directions, a list that cannot be trusted is still refused', async () => {
  const late = { ...comment(75), id: 'late' }
  const cases = [
    // A comment on the other end, not on the page, newer than the page's oldest: as measured, and mirrored.
    ['the oldest end holds a comment newer than the newest page\'s oldest', () => ends(range(51, 100).reverse(), { hasNextPage: true }, [...range(1, 49), late]), 'outside-page'],
    ['the same, mirrored', () => ends([...range(1, 49), late], { hasNextPage: true }, range(51, 100).reverse()), 'outside-page'],
    // Both ends reach the newest instant, each holds a comment at it the other lacks, and neither is all at that instant.
    ['two ends tied at the newest instant, neither holding the other\'s', () => ends([{ ...comment(900), id: 'a' }, ...range(51, 99).reverse()], { hasNextPage: true }, [...range(1, 49), { ...comment(900), id: 'c' }]), 'outside-page'],
    ['an end that both rises and falls', () => ends([comment(3), comment(1), comment(2)], { hasNextPage: true }, range(1, 50)), 'head-order'],
    ['the other end both rises and falls', () => ends(range(51, 100).reverse(), { hasNextPage: true }, [comment(3), comment(1), comment(2)]), 'tail-order'],
    ['one comment on both ends with two times', () => ends([{ ...comment(1000), id: 'shared' }, ...range(51, 99).reverse()], { hasNextPage: true }, [...range(1, 49), { ...comment(50), id: 'shared' }]), 'two-times'],
    ['more is promised and the first end is empty', () => ends([], { hasNextPage: true }, range(1, 50)), 'empty-end'],
    ['more is promised and the last end is empty', () => ends(range(51, 100).reverse(), { hasNextPage: true }, []), 'empty-end'],
    ['a full first page with no page information', () => ends(range(51, 100).reverse(), undefined, range(1, 50)), 'page-info'],
    ['a whole list whose other end contradicts it', () => ends(range(1, 3).reverse(), { hasNextPage: false }, range(1, 4)), 'whole-list-mismatch'],
  ]
  for (const [name, answer, check] of cases) {
    assert.ok(RELAY_CHECKS.includes(check), name)
    for (const request of [get(), get(stamp(0))]) {
      let calls = 0
      const response = await createCrewRelay({ fetchImpl: async () => { calls += 1; return answer() } })(request, ENV, ACCESS)
      assert.deepEqual(await answerOf(response), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check } }, name)
      assert.equal(calls, 1, name)
    }
  }
  assert.ok(!RELAY_CHECKS.includes('opposite-directions'), 'a word no rule can produce is not on the list')
})

test('the same-direction rule binds only two ends that each run one way and end at different instants: its edges are pinned', async () => {
  // The rule (newestPage): two ends that both rise, or both fall, and whose newest instants differ, must have their
  // later end where that direction puts the newest. A flat end (one comment, or all at one instant) runs no way, and a
  // tie at the newest instant is decided by who holds the comments at it; then the times alone choose, and outside-page
  // still guards every comment off the page. Each row below differs from the read at an earlier commit (where a flat end took the
  // other end's direction and a tie went to the end that direction puts first); none was seen from Linear.
  const at = (id, n) => ({ ...comment(n), id })
  const accepted = [
    // name, first end, last end, the page oldest first, the cursor checks: [cursor, gap]
    ['a full first page newest first, and a last page of ONE newer comment', range(51, 100).reverse(), [comment(500)], [comment(500)], [[stamp(100), true], [stamp(500), false]]],
    ['a full first page all at one instant, and a newer last page newest first', range(1, 50).map(item => ({ ...item, createdAt: stamp(100) })), range(150, 199).reverse(), range(150, 199), [[stamp(100), true], [stamp(149), true], [stamp(150), false]]],
    ['two ends newest first, tied at the newest instant, the last end holding one more comment at it', [at('a', 900), ...range(1, 49).reverse()], [at('a', 900), at('t', 900), ...range(51, 98).reverse()], [...range(51, 98), at('a', 900), at('t', 900)], [[stamp(50), true], [stamp(51), false], [stamp(900), false]]],
  ]
  for (const [name, head, tail, page, cursors] of accepted) {
    const relay = createCrewRelay({ fetchImpl: async () => ends(head, { hasNextPage: true }, tail) })
    const body = await read(relay)
    assert.equal(body.ok, true, name)
    assert.deepEqual(ids(body.comments), ids(page), name)
    assert.equal(body.gap, false, name)
    for (const [cursor, gap] of cursors) {
      const after = await read(relay, cursor)
      assert.deepEqual(ids(after.comments), ids(page.filter(item => Date.parse(item.createdAt) > Date.parse(cursor))), name + ' ' + cursor)
      assert.equal(after.gap, gap, name + ' ' + cursor)
    }
  }
  // Two ends oldest first that share only their newest comment, while each holds older ones the other lacks: it cannot
  // come from one list. At an earlier commit the last page was taken as newest and this was read; now the tie goes to the end
  // that holds the other's comments at the newest instant (both do: the first), and the last end's 3 and 4 are newer
  // than its oldest.
  const refused = [
    ['two ends oldest first, tied at the newest instant by one shared comment', [at('a', 1), at('b', 2), at('z', 9)], [at('c', 3), at('d', 4), at('z', 9)], 'outside-page'],
  ]
  for (const [name, head, tail, check] of refused) {
    for (const request of [get(), get(stamp(0))]) {
      const response = await createCrewRelay({ fetchImpl: async () => ends(head, { hasNextPage: true }, tail) })(request, ENV, ACCESS)
      assert.deepEqual(await answerOf(response), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check } }, name)
    }
  }
})

test('nothing about the list is remembered: Linear may turn its list round between two reads', async () => {
  const tied = range(1, 50).map(item => ({ ...item, createdAt: stamp(3) }))
  const all = [...tied, ...range(51, 101)]
  let listed = 'newest-first'
  const relay = createCrewRelay({ fetchImpl: (url, init) => linearStub(all, { listed }).fetchImpl(url, init) })
  assert.deepEqual(ids((await read(relay, stamp(3))).comments), ids(all.slice(-50)))
  listed = 'oldest-first'
  assert.deepEqual(ids((await read(relay, stamp(3))).comments), ids(all.slice(-50)))
  listed = 'newest-first'
  assert.deepEqual(ids((await read(relay, stamp(3))).comments), ids(all.slice(-50)))
})

// ---- Linear's answers -------------------------------------------------------------------------------------------------
test('every call to Linear refuses a redirect; what Linear refuses or limits is said with its own code', async () => {
  const refused = (code, status) => ({ status, body: { ok: false, code } })
  const check = async (name, fetchImpl, want) => {
    const seen = []
    const response = await createCrewRelay({ fetchImpl: (url, init) => { seen.push(init); return fetchImpl(url, init) }, upstreamTimeoutMs: 150 })(get(), ENV, ACCESS)
    const text = await response.text()
    assert.deepEqual({ status: response.status, body: JSON.parse(text) }, want, name)
    assert.ok(!text.includes(KEY), name + ': the answer must not carry the key')
    assert.equal(seen.length, 1, name)
    assert.equal(seen[0].redirect, 'manual', name)
    assert.ok(seen[0].signal instanceof AbortSignal, name + ': the call carries the deadline as its signal')
  }
  /** A body that reports whether it was let go. */
  const watched = (text, state) => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(text)); controller.close() }, cancel() { state.cancelled = true } })
  await check('the issue is not there', async () => Response.json({ data: { issues: { nodes: [] } } }), refused('RELAY_ISSUE_NOT_FOUND', 404))
  await check('a key Linear does not accept', async () => Response.json({ errors: [{ message: 'Authentication required: ' + KEY }] }, { status: 401 }), refused('RELAY_UPSTREAM_REFUSED', 502))
  await check('a GraphQL error on a 200', async () => Response.json({ errors: [{ message: KEY }] }), refused('RELAY_UPSTREAM_ERROR', 502))
  const limited = {}
  await check('HTTP 429 with a text body', async () => new Response(watched('slow down ' + KEY, limited), { status: 429 }), refused('RELAY_UPSTREAM_RATE_LIMITED', 429))
  assert.equal(limited.cancelled, true, 'the refused answer is let go unread')
  await check('HTTP 400 with RATELIMITED', async () => Response.json({ errors: [{ message: 'x', extensions: { code: 'RATELIMITED' } }] }, { status: 400 }), refused('RELAY_UPSTREAM_RATE_LIMITED', 429))
  const redirected = {}
  await check('a redirect', async () => new Response(watched('moved', redirected), { status: 307, headers: { location: 'https://other.example.invalid/graphql' } }), refused('RELAY_UPSTREAM_REFUSED', 502))
  assert.equal(redirected.cancelled, true, 'the redirect is let go unread')
  await check('not JSON', async () => new Response('<html>' + KEY + '</html>', { status: 200 }), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'payload-json' } })
  await check('no data', async () => Response.json({ hello: KEY }), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'payload-data' } })
})

test('Linear\'s answer is bounded in bytes and in time by the relay itself', async () => {
  const one = async (fetchImpl, upstreamTimeoutMs = 150) => {
    const began = Date.now()
    const answer = await answerOf(await createCrewRelay({ fetchImpl, upstreamTimeoutMs })(get(), ENV, ACCESS))
    return { ...answer, ms: Date.now() - began }
  }
  const unavailable = { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_UNAVAILABLE' } }
  // Too large: one-mebibyte pieces; the read stops at the third and the rest is never asked for.
  let pulls = 0
  let cancelled = false
  const big = await one(async () => new Response(new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new Uint8Array(1024 * 1024)) }, cancel() { cancelled = true } }, { highWaterMark: 0 })), 5000)
  assert.deepEqual({ status: big.status, body: big.body }, { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_TOO_LARGE' } })
  assert.equal(pulls, 3, 'the third mebibyte is the one that passes the bound; a fourth is never asked for')
  assert.equal(cancelled, true)
  // The bound is exact: an answer of 2 MiB is read, one byte more is not.
  const padded = bytes => { const base = JSON.stringify({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [{ ...comment(1), body: '' }] } }] } } }); return base.replace('"body":""', '"body":"' + 'x'.repeat(bytes - base.length) + '"') }
  assert.equal(new TextEncoder().encode(padded(2 * 1024 * 1024)).byteLength, 2 * 1024 * 1024)
  assert.equal((await one(async () => new Response(padded(2 * 1024 * 1024)), 5000)).status, 200)
  assert.deepEqual((await one(async () => new Response(padded(2 * 1024 * 1024 + 1)), 5000)).body, { ok: false, code: 'RELAY_UPSTREAM_TOO_LARGE' })
  // An answer cut into an absurd number of pieces is refused by their count, well inside the deadline.
  const whole_ = new TextEncoder().encode(JSON.stringify({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [] } }] } } }))
  let handed = 0
  const shredded = await one(async () => new Response(new ReadableStream({ pull(controller) { handed += 1; if (handed <= 70000) controller.enqueue(new Uint8Array(0)); else { controller.enqueue(whole_); controller.close() } } }, { highWaterMark: 0 })), 60000)
  assert.deepEqual({ status: shredded.status, body: shredded.body }, unavailable)
  assert.ok(handed <= 65537, handed + ' pieces were taken')
  // A cancel that REJECTS leaves no unhandled rejection behind.
  const unhandled = []
  const note = reason => unhandled.push(reason)
  process.on('unhandledRejection', note)
  try {
    const rejecting = await one(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { return Promise.reject(new Error('cancel refused')) } })))
    assert.deepEqual({ status: rejecting.status, body: rejecting.body }, unavailable)
    await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(unhandled, [])
  } finally {
    process.off('unhandledRejection', note)
  }
  // A body that never finishes.
  let let_go = false
  const hung = await one(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{"data":')) }, cancel() { let_go = true } })))
  assert.deepEqual({ status: hung.status, body: hung.body }, unavailable)
  assert.equal(let_go, true)
  // A body that never finishes and whose cancel never settles either: the answer still comes at the deadline.
  const stuck = await one(async () => new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) }, cancel() { return new Promise(() => {}) } })))
  assert.deepEqual({ status: stuck.status, body: stuck.body }, unavailable)
  assert.ok(stuck.ms < 1500, 'answered ' + stuck.ms + ' ms after the call began')
  // A transport that honours the signal: the abort is what ends it.
  let aborted = false
  const honoured = await one((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })))
  assert.deepEqual({ status: honoured.status, body: honoured.body }, unavailable)
  assert.equal(aborted, true)
  // A transport that IGNORES the signal and never answers: the relay's own race ends it.
  const ignored = await one(() => new Promise(() => {}))
  assert.deepEqual({ status: ignored.status, body: ignored.body }, unavailable)
  assert.ok(ignored.ms < 1500)
  // A transport that ignores the signal and answers LATE with a perfectly good answer: still refused, and let go.
  let late_let_go = false
  const lateBody = () => new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(JSON.stringify({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [] } }] } } }))); controller.close() }, cancel() { late_let_go = true } })
  const late = await one(() => new Promise(resolve => setTimeout(() => resolve(new Response(lateBody())), 400)))
  assert.deepEqual({ status: late.status, body: late.body }, unavailable)
  await new Promise(resolve => setTimeout(resolve, 500))
  assert.equal(late_let_go, true, 'the late answer was let go unread')
  // A body that hands over empty pieces for ever without yielding to the timer. Each piece takes a millisecond, so
  // the count of pieces would take a minute to stop it: it is the clock that must.
  const spin = ms => { const until = Date.now() + ms; while (Date.now() < until) { /* busy */ } }
  const empty = await one(async () => new Response(new ReadableStream({ pull(controller) { spin(1); controller.enqueue(new Uint8Array(0)) } }, { highWaterMark: 0 })), 40)
  assert.deepEqual({ status: empty.status, body: empty.body }, unavailable)
  assert.ok(empty.ms < 2000, 'answered ' + empty.ms + ' ms after the call began')
  // A good answer whose LAST step arrives after the deadline, with the timer starved so that it could not fire.
  const whole = JSON.stringify({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [] } }] } } })
  let step = 0
  const overdue = await one(async () => new Response(new ReadableStream({ pull(controller) { step += 1; if (step === 1) controller.enqueue(new TextEncoder().encode(whole)); else { spin(80); controller.close() } } }, { highWaterMark: 0 })), 20)
  assert.deepEqual({ status: overdue.status, body: overdue.body }, unavailable, 'an end of body that comes after the deadline is not a success')
  // The same for the request itself: a transport that answers after the deadline without ever yielding.
  const slow = await one(async () => { spin(80); return Response.json({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: [] } }] } } }) }, 20)
  assert.deepEqual({ status: slow.status, body: slow.body }, unavailable)
  // An answer that is late is LATE, whatever it says: a rate-limit answer after the deadline is not passed on as one.
  const lateLimit = await one(async () => { spin(80); return new Response('slow down', { status: 429 }) }, 20)
  assert.deepEqual({ status: lateLimit.status, body: lateLimit.body }, unavailable)
})

test('after a call nothing is left behind: the answer\'s stream is unlocked and the deadline has no listener of ours', async () => {
  const real = AbortSignal.timeout
  const counts = { added: 0, removed: 0 }
  AbortSignal.timeout = ms => {
    const signal = real.call(AbortSignal, ms)
    const add = signal.addEventListener.bind(signal)
    const remove = signal.removeEventListener.bind(signal)
    signal.addEventListener = (type, ...rest) => { if (type === 'abort') counts.added += 1; return add(type, ...rest) }
    signal.removeEventListener = (type, ...rest) => { if (type === 'abort') counts.removed += 1; return remove(type, ...rest) }
    return signal
  }
  try {
    const kept = []
    const good = () => { const response = ends([comment(1)], { hasNextPage: false }); kept.push(response); return response }
    assert.equal((await createCrewRelay({ fetchImpl: async () => good() })(get(), ENV, ACCESS)).status, 200)
    const hung = new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('{')) } }))
    kept.push(hung)
    assert.equal((await createCrewRelay({ fetchImpl: async () => hung, upstreamTimeoutMs: 40 })(get(), ENV, ACCESS)).status, 502)
    await new Promise(resolve => setTimeout(resolve, 20))
    for (const response of kept) assert.equal(response.body.locked, false, 'the stream is not left locked')
    assert.equal(counts.added, 2)
    assert.equal(counts.removed, 2, 'each call takes its listener off the deadline when it ends')
  } finally {
    AbortSignal.timeout = real
  }
})

test('every answer of the relay is JSON that is not to be stored or sniffed', async () => {
  const relay = createCrewRelay({ fetchImpl: linearStub([comment(1)]).fetchImpl })
  for (const response of [await relay(get(), ENV, ACCESS), await relay(get('nonsense'), ENV, ACCESS), await relay(get(), ENV, null), await relay(post('{"body":"x"}'), ENV, ACCESS)]) {
    assert.equal(response.headers.get('content-type'), 'application/json; charset=utf-8')
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff')
  }
})

test('only an error this relay made leaves as its own code: anything else is RELAY_FAILED 500', async () => {
  const { fetchImpl, calls } = linearStub([comment(1)])
  const strange = { method: 'POST', url: 'https://relay.example.invalid/_host/crew-relay', headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => { throw Object.assign(new Error('x'), { code: 'RELAY_ARBITRARY_PAYLOAD', status: 200 }) } }
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl })(strange, ENV, ACCESS)), { status: 500, body: { ok: false, code: 'RELAY_FAILED' } })
  assert.equal(calls.length, 0)
})

test('only the owner types reach Linear: owner and access are admitted, a guest or an unknown type is not', async () => {
  for (const type of ['owner', 'access']) {
    const { fetchImpl, calls } = linearStub([comment(1)])
    assert.equal((await createCrewRelay({ fetchImpl })(get(), ENV, { type, email: 'owner@example.invalid' })).status, 200, type)
    assert.equal(calls.length, 1)
  }
  for (const access of [{ type: 'guest', email: 'friend@example.invalid' }, { type: 'invite' }, { email: 'owner@example.invalid' }, {}, undefined]) {
    const { fetchImpl, calls } = linearStub([comment(1)])
    const response = await createCrewRelay({ fetchImpl })(get(), ENV, access)
    assert.equal(response.status, 401, JSON.stringify(access))
    assert.equal(calls.length, 0)
  }
})

// ---- the post ---------------------------------------------------------------------------------------------------------
test('a post looks the issue up without its comments, then writes once', async () => {
  const { fetchImpl, calls } = linearStub(range(1, 120))
  const response = await createCrewRelay({ fetchImpl })(post(JSON.stringify({ body: '  hello crew  ' })), ENV, ACCESS)
  assert.deepEqual(await answerOf(response), { status: 201, body: { ok: true, schema: 'aukora.crew-relay.v1', comment: { id: 'new', createdAt: stamp(9999) } } })
  assert.equal(calls.length, 2)
  assert.ok(!/comments\(/.test(calls[0].query))
  assert.deepEqual(calls[0].variables, { teamKey: 'YOUR_TEAM', number: 0 })
  assert.deepEqual(calls[1].variables, { issueId: 'issue-1', body: 'hello crew' })
})

test('two posts that arrive together send one comment: the slot is taken before the first wait on Linear', async () => {
  let clock = 1_000_000
  let release
  const gate = new Promise(resolve => { release = resolve })
  const started = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    started.push(/commentCreate/.test(body.query) ? 'write:' + body.variables.body : 'lookup')
    if (started.length === 1) await gate // the first post's LOOKUP is held back
    if (/commentCreate/.test(body.query)) { clock += 9000; return created('n' + started.length) } // the write takes nine seconds
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = text => relay(post(JSON.stringify({ body: text })), ENV, ACCESS)
  const first = say('one')
  assert.deepEqual(await answerOf(await say('two')), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
  assert.deepEqual(started, ['lookup'], 'the second post was refused before it asked Linear anything')
  release()
  assert.equal((await first).status, 201)
  assert.deepEqual(started, ['lookup', 'write:one'])
  // The first finished at +9 s. One second later is still inside the interval, although it STARTED ten seconds ago.
  clock += 1000
  assert.equal((await say('three')).status, 429)
  clock += 4000
  assert.equal((await say('four')).status, 201)
  assert.deepEqual(started, ['lookup', 'write:one', 'lookup', 'write:four'])
})

test('a post the runtime drops in mid-flight frees the slot by its own deadline, not for the life of the isolate', async () => {
  let clock = 2_000_000
  let dropped = true
  const { fetchImpl: live } = linearStub([])
  const relay = createCrewRelay({ fetchImpl: (url, init) => (dropped ? new Promise(() => {}) : live(url, init)), now: () => clock })
  const say = () => relay(post('{"body":"x"}'), ENV, ACCESS)
  say() // never settles: the page that sent it was closed
  await new Promise(resolve => setImmediate(resolve))
  dropped = false
  clock += 19_000
  assert.equal((await say()).status, 429, 'inside the hold (two calls of eight seconds and a margin)')
  clock += 1_001
  assert.equal((await say()).status, 201, 'past the hold the next post goes out')
})

test('a failure BEFORE the write frees the slot and starts no interval; a write whose answer is lost starts it', async () => {
  let clock = 5_000_000
  let failLookup = true
  let failWrite = false
  const written = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/commentCreate/.test(body.query)) {
      written.push(body.variables.body) // Linear has the comment from here on, whatever happens to the answer
      if (failWrite) throw new Error('the answer was lost')
      return created('ok')
    }
    if (failLookup) throw new Error('down')
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = text => relay(post(JSON.stringify({ body: text })), ENV, ACCESS)
  // The lookup fails: nothing was sent, so the next post may go at once.
  assert.deepEqual(await answerOf(await say('one')), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_UNAVAILABLE' } })
  failLookup = false
  failWrite = true
  // The write is sent and its answer is lost: the comment may be there, so the interval runs.
  assert.deepEqual(await answerOf(await say('two')), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_UNAVAILABLE' } })
  failWrite = false
  assert.deepEqual(await answerOf(await say('two again')), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
  assert.deepEqual(written, ['two'], 'the retry inside the interval was not sent')
  clock += 5000
  assert.equal((await say('three')).status, 201)
  assert.deepEqual(written, ['two', 'three'])
})

test('a write Linear did not confirm is a refusal, and the interval still runs', async () => {
  for (const [name, answer] of [
    ['success false with a comment', { success: false, comment: { id: 'x', createdAt: stamp(1) } }],
    ['success true with no comment', { success: true }],
    ['success true with a comment that has no id', { success: true, comment: { createdAt: stamp(1) } }],
    ['nothing', {}],
  ]) {
    let clock = 9_000_000
    let writes = 0
    const fetchImpl = async (url, init) => {
      if (/commentCreate/.test(JSON.parse(init.body).query)) { writes += 1; return Response.json({ data: { commentCreate: answer } }) }
      return Response.json({ data: { issues: { nodes: [ISSUE] } } })
    }
    const relay = createCrewRelay({ fetchImpl, now: () => clock })
    assert.deepEqual(await answerOf(await relay(post('{"body":"x"}'), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_COMMENT_REFUSED' } }, name)
    assert.equal((await relay(post('{"body":"x"}'), ENV, ACCESS)).status, 429, name + ': the interval runs after an unconfirmed write')
    assert.equal(writes, 1, name)
  }
})

test('a clock that jumps forward and back cannot let two posts through: the slot knows its holder', async () => {
  let clock = 8_000_000
  const lookups = []
  const written = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/commentCreate/.test(body.query)) { written.push(body.variables.body); return created() }
    await new Promise(resolve => lookups.push(resolve))
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = text => relay(post(JSON.stringify({ body: text })), ENV, ACCESS)
  const a = say('A')
  await new Promise(resolve => setImmediate(resolve))
  clock = 8_020_001 // the clock leaps: A's hold looks spent, B takes the slot
  const b = say('B')
  await new Promise(resolve => setImmediate(resolve))
  clock = 8_000_001 // and leaps back: by the clock alone A's hold looks live again
  lookups[0]()
  assert.equal((await a).status, 429, 'A no longer holds the slot, whatever the clock says')
  lookups[1]()
  assert.equal((await b).status, 201)
  assert.deepEqual(written, ['B'])
})

test('a post that outlived its own hold sends nothing, even when no other post has taken the slot', async () => {
  let clock = 7_000_000
  let release
  const written = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/commentCreate/.test(body.query)) { written.push(body.variables.body); return created() }
    await new Promise(resolve => { release = resolve })
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const late = relay(post('{"body":"late"}'), ENV, ACCESS)
  await new Promise(resolve => setImmediate(resolve))
  clock += 20_001 // two calls of eight seconds and a margin of four have gone by while the lookup waited
  release()
  assert.deepEqual(await answerOf(await late), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
  assert.deepEqual(written, [])
})

test('the post body is bounded in bytes, by its declared length before it is read and by what was read', async () => {
  const { fetchImpl, calls } = linearStub([comment(1)])
  const relay = createCrewRelay({ fetchImpl })
  const say = (body, headers) => relay(post(body, headers), ENV, ACCESS)
  for (const [name, response] of [
    ['declared too long', await say('{"body":"x"}', { 'content-length': '999999' })],
    ['declared length is not a number', await say('{"body":"x"}', { 'content-length': '12abc' })],
    ['read too long', await say(JSON.stringify({ body: 'x'.repeat(17000) }))],
    ['short in characters, long in bytes', await say(JSON.stringify({ body: '€'.repeat(5500) }))],
  ]) assert.deepEqual(await answerOf(response), { status: 413, body: { ok: false, code: 'RELAY_BODY_TOO_LARGE' } }, name)
  // A body declared too long is refused without one byte of it being read.
  let pulls = 0
  const unread = new Request('https://relay.example.invalid/_host/crew-relay', { method: 'POST', duplex: 'half', headers: { 'content-type': 'application/json', 'content-length': '999999' },
    body: new ReadableStream({ pull(controller) { pulls += 1; controller.enqueue(new TextEncoder().encode('{"body":"x"}')); controller.close() } }, { highWaterMark: 0 }) })
  assert.equal((await relay(unread, ENV, ACCESS)).status, 413)
  assert.equal(pulls, 0)
  // 4000 three-byte characters are within both the comment cap (characters) and the request cap (bytes).
  assert.equal((await say(JSON.stringify({ body: '€'.repeat(4000) }))).status, 201)
  assert.deepEqual(await answerOf(await say('{"body":"x"}', { 'content-type': 'text/plain' })), { status: 415, body: { ok: false, code: 'RELAY_CONTENT_TYPE_REQUIRED' } })
  assert.equal(calls.length, 2)
})

test('a post that outlived its hold has lost its turn: it sends nothing, and it does not free the next holder\'s slot', async () => {
  let clock = 1_000_000
  const gates = []
  const written = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/commentCreate/.test(body.query)) { written.push(body.variables.body); return created('n' + written.length) }
    await new Promise(resolve => gates.push(resolve)) // every lookup waits to be released
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = text => relay(post(JSON.stringify({ body: text })), ENV, ACCESS)
  const a = say('A') // takes the slot at 1,000,000; its hold ends at 1,020,000
  await new Promise(resolve => setImmediate(resolve))
  clock = 1_020_001
  const b = say('B') // the hold has run out: B takes the slot
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(gates.length, 2)
  gates[0]() // A's lookup comes back late
  assert.deepEqual(await answerOf(await a), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
  assert.deepEqual(written, [], 'A lost its turn and wrote nothing')
  // A's exit must not have freed B's slot: a third post is still refused while B is in flight.
  assert.equal((await say('C')).status, 429)
  assert.equal(gates.length, 2, 'C asked Linear nothing')
  gates[1]()
  assert.equal((await b).status, 201)
  assert.deepEqual(written, ['B'])
})

test('a post whose turn was passed while its lookup waited does not write inside the other post\'s interval', async () => {
  let clock = 3_000_000
  let releaseWrite
  const lookups = []
  const written = []
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body)
    if (/commentCreate/.test(body.query)) {
      written.push(body.variables.body)
      if (body.variables.body === 'A') await new Promise(resolve => { releaseWrite = resolve }) // A's WRITE is slow
      return created('n' + written.length)
    }
    if (lookups.length >= 1) await new Promise(resolve => lookups.push(resolve)) // B's lookup waits
    else lookups.push(null)
    return Response.json({ data: { issues: { nodes: [ISSUE] } } })
  }
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = text => relay(post(JSON.stringify({ body: text })), ENV, ACCESS)
  const a = say('A')
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(written, ['A'], 'A is writing')
  clock += 20_001 // A's hold runs out while Linear is still writing its comment
  const b = say('B')
  await new Promise(resolve => setImmediate(resolve))
  releaseWrite() // A finishes now: the interval starts here
  assert.equal((await a).status, 201)
  lookups[1]() // B's lookup comes back in the same instant
  assert.deepEqual(await answerOf(await b), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
  assert.deepEqual(written, ['A'])
})

// ---- through the real Worker --------------------------------------------------------------------------------------
const ORIGIN = 'https://relay.example.invalid'
const SEED = 'a'.repeat(64)

function workerFixture(env = {}) {
  const reached = []
  const answer = path => {
    reached.push(path) // every call, the bootstrap reads included
    if (path === '/_head/bootstrap-status') return { ok: true, phase: 'complete', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 }
    if (path === '/_mirror/bootstrap-status') return { ok: true, phase: 'ready', seedId: SEED, ballId: 'b'.repeat(64), epoch: 172 }
    return { ok: true, stub: path }
  }
  const namespace = { idFromName: name => name, get: () => ({ fetch: async request => Response.json(answer(new URL(request.url).pathname)) }) }
  const full = { PUBLIC_HOST: new URL(ORIGIN).host, OWNER_EMAIL: 'owner@example.invalid', OWNER_PUBLIC_KEY_HEX: 'e'.repeat(64), HEAD: namespace, MIRROR: namespace, ...env }
  let access = { type: 'owner', email: 'owner@example.invalid', expires: Math.floor(Date.now() / 1000) + 3600 }
  const worker = createWorker({ verifyAccess: async () => access })
  const call = (path, { method = 'GET', headers = {}, body, duplex } = {}) => worker.fetch(new Request(ORIGIN + path, {
    method,
    headers: Object.fromEntries(Object.entries({ origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...(method === 'POST' ? { 'content-type': 'application/json' } : {}), ...headers })
      .filter(([, value]) => value !== undefined)),
    ...(body === undefined ? {} : { body }), ...(duplex === undefined ? {} : { duplex }) }), full)
  return { call, reached, setAccess: value => { access = value } }
}

/** Replaces the global fetch for one test: the Worker's one relay instance looks the global up on every call. */
async function withGlobalFetch(impl, run) {
  const real = globalThis.fetch
  globalThis.fetch = impl
  try { return await run() } finally { globalThis.fetch = real }
}

test('through the Worker: the owner reads and posts from her own page; no answer carries the key', async () => {
  const stub = linearStub([comment(1), comment(2)])
  await withGlobalFetch(stub.fetchImpl, async () => {
    const f = workerFixture({ LINEAR_API_KEY: KEY })
    const read = await f.call('/_host/crew-relay')
    const readText = await read.text()
    assert.equal(read.status, 200, readText)
    assert.deepEqual(ids(JSON.parse(readText).comments), ['c0001', 'c0002'])
    // A plain same-origin read carries no Origin header: admitted like the other owner reads.
    assert.equal((await f.call('/_host/crew-relay', { headers: { origin: undefined } })).status, 200)
    const posted = await f.call('/_host/crew-relay', { method: 'POST', body: JSON.stringify({ body: 'READY: Auma.' }) })
    const postText = await posted.text()
    assert.equal(posted.status, 201, postText)
    for (const text of [readText, postText]) assert.ok(!text.includes(KEY))
    assert.ok(stub.calls.every(call => call.url === 'https://api.linear.app/graphql' && call.authorization === KEY && call.redirect === 'manual'))
    assert.deepEqual([...new Set(f.reached)].sort(), ['/_head/bootstrap-status', '/_mirror/bootstrap-status'], 'beyond the Worker\'s own bootstrap reads the relay asks HEAD and MIRROR for nothing')
    // The Worker keeps ONE relay for the isolate: a second post straight away is refused and sends nothing to Linear.
    const before = stub.calls.length
    assert.deepEqual(await answerOf(await f.call('/_host/crew-relay', { method: 'POST', body: JSON.stringify({ body: 'again' }) })), { status: 429, body: { ok: false, code: 'RELAY_RATE_LIMITED' } })
    assert.equal(stub.calls.length, before)
  })
})

test('through the Worker: an upstream failure answers a code, never the key or the upstream text', async () => {
  await withGlobalFetch(linearStub([comment(1)], { failAt: 1 }).fetchImpl, async () => {
    const f = workerFixture({ LINEAR_API_KEY: KEY })
    const response = await f.call('/_host/crew-relay')
    const text = await response.text()
    assert.equal(response.status, 502)
    assert.deepEqual(JSON.parse(text), { ok: false, code: 'RELAY_UPSTREAM_UNAVAILABLE' })
    assert.ok(!text.includes(KEY))
  })
})

test('through the Worker: no key configured answers RELAY_NOT_CONFIGURED and calls nothing', async () => {
  let called = 0
  await withGlobalFetch(async () => { called += 1; throw new Error('must not be called') }, async () => {
    const f = workerFixture()
    assert.deepEqual(await answerOf(await f.call('/_host/crew-relay')), { status: 503, body: { ok: false, code: 'RELAY_NOT_CONFIGURED' } })
    assert.equal(called, 0)
  })
})

test('through the Worker: other sites, other methods and signed-out callers never reach Linear', async () => {
  let called = 0
  await withGlobalFetch(async () => { called += 1; throw new Error('must not be called') }, async () => {
    const f = workerFixture({ LINEAR_API_KEY: KEY })
    const cases = [
      ['GET', { 'sec-fetch-site': 'cross-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      ['GET', { 'sec-fetch-site': 'same-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      ['GET', { 'sec-fetch-site': undefined }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      ['GET', { origin: 'https://evil.example' }, 403, 'ORIGIN_REFUSED'],
      ['POST', { origin: 'https://evil.example' }, 403, 'ORIGIN_REFUSED'],
      ['POST', { 'sec-fetch-site': 'cross-site' }, 403, 'CROSS_SITE_REFUSED'],
      ['POST', { 'sec-fetch-site': 'same-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      ['POST', { origin: undefined }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      ['PUT', {}, 405, 'METHOD_UNAVAILABLE'],
      ['DELETE', {}, 405, 'METHOD_UNAVAILABLE'],
      ['POST', { 'content-length': String(64 * 1024) }, 413, 'REQUEST_BODY_TOO_LARGE'],
    ]
    for (const [method, headers, status, code] of cases) {
      const response = await f.call('/_host/crew-relay', { method, headers, ...(method === 'GET' ? {} : { body: JSON.stringify({ body: 'x' }) }) })
      assert.deepEqual(await answerOf(response), { status, body: { ok: false, code } }, `${method} ${JSON.stringify(headers)}`)
    }
    f.setAccess(null)
    for (const method of ['GET', 'POST']) {
      const response = await f.call('/_host/crew-relay', { method, headers: { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'owner@example.invalid', expires: 4102444800 }), 'x-x6-internal-authorized': '1' },
        ...(method === 'GET' ? {} : { body: JSON.stringify({ body: 'x' }) }) })
      assert.equal(response.status, 401, method)
    }
    assert.equal(called, 0)
  })
})

test('through the Worker: another method is refused before any body is read, HEAD is asked or a key is looked at', async () => {
  let called = 0
  await withGlobalFetch(async () => { called += 1; throw new Error('must not be called') }, async () => {
    for (const env of [{}, { LINEAR_API_KEY: KEY }]) {
      const f = workerFixture(env)
      let pulls = 0
      const unfinished = new ReadableStream({ pull() { pulls += 1 } }, { highWaterMark: 0 }) // a body that never ends
      const response = await f.call('/_host/crew-relay', { method: 'PUT', body: unfinished, duplex: 'half' })
      assert.deepEqual(await answerOf(response), { status: 405, body: { ok: false, code: 'METHOD_UNAVAILABLE' } })
      assert.equal(pulls, 0, 'nothing of the body was read')
      assert.deepEqual(f.reached, [], 'neither HEAD nor MIRROR was asked')
      // A request line that carries a fragment is not this route.
      assert.deepEqual(await answerOf(await f.call('/_host/crew-relay#x')), { status: 404, body: { ok: false, code: 'NOT_FOUND' } })
      assert.deepEqual(f.reached, [])
    }
    assert.equal(called, 0)
  })
})

// ---- which rule refused, and the shape of what Linear sent ----------------------------------------------------------
test('a refusal of Linear\'s answer names its rule with one fixed word, and every word on the closed list is reachable', async () => {
  const newest = range(51, 100).reverse()
  // The words the other tests do not already produce: a comment on the OTHER end with no id, or with a refused time.
  const extra = [
    ['a comment on the other end with no id', () => ends(newest, { hasNextPage: true }, [{ body: 'x', createdAt: stamp(1) }]), 'tail-comment-shape'],
    ['a comment on the other end with a refused time', () => ends(newest, { hasNextPage: true }, [{ ...comment(1), createdAt: '2026-11-12T10:00:00+08:00' }]), 'tail-comment-time'],
    ['the same, on a whole list', () => ends([comment(1)], { hasNextPage: false }, [{ ...comment(1), createdAt: null }]), 'tail-comment-time'],
    ['a comment that is not an object', () => ends([null], { hasNextPage: false }), 'head-comment-shape'],
    ['not JSON', () => new Response('<html>' + KEY + '</html>'), 'payload-json'],
    ['no data', () => Response.json({ hello: KEY }), 'payload-data'],
  ]
  for (const [name, answer, check] of extra) {
    const response = await createCrewRelay({ fetchImpl: async () => answer() })(get(), ENV, ACCESS)
    const text = await response.text()
    assert.deepEqual({ status: response.status, body: JSON.parse(text) }, { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check } }, name)
    assert.ok(!text.includes(KEY), name)
  }
  // The list is closed and every word on it is produced by one of the inputs in this file.
  const produced = new Set([...extra.map(([, , check]) => check), 'page-info', 'empty-end', 'head-comment-time', 'head-page-shape', 'head-order', 'tail-order',
    'outside-page', 'two-times', 'whole-list-mismatch', 'tail-page-shape'])
  assert.deepEqual([...produced].sort(), [...RELAY_CHECKS].sort())
  assert.ok(Object.isFrozen(RELAY_CHECKS))
  for (const word of RELAY_CHECKS) assert.match(word, /^[a-z]+(?:-[a-z]+)*$/)
  // A refusal that is not about Linear's answer carries no word.
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: async () => Response.json({ data: { issues: { nodes: [] } } }) })(get(), ENV, ACCESS)), { status: 404, body: { ok: false, code: 'RELAY_ISSUE_NOT_FOUND' } })
  // The post's own calls name the same words when Linear's answer is not JSON.
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: async () => new Response('nope') })(post('{"body":"x"}'), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'payload-json' } })
})

const shapeGet = (query = 'shape=1') => new Request('https://relay.example.invalid/_host/crew-relay?' + query)
/** The shape answer, and its text with nothing from the fixture in it: no body, no author, no id, no issue, no key. */
async function shapeOf(fetchImpl, fixture) {
  const response = await createCrewRelay({ fetchImpl })(shapeGet(), ENV, ACCESS)
  const text = await response.text()
  assert.equal(response.status, 200, text)
  for (const item of fixture) {
    if (typeof item?.id === 'string') assert.ok(!text.includes(item.id), 'the id ' + item.id + ' leaked')
    if (typeof item?.body === 'string') assert.ok(!text.includes(item.body), 'a body leaked')
    if (typeof item?.user?.name === 'string') assert.ok(!text.includes(item.user.name), 'an author leaked')
  }
  for (const word of [KEY, ISSUE.id, ISSUE.identifier, ISSUE.title, 'body', 'author', 'user', 'id"']) assert.ok(!text.includes(word), word + ' leaked')
  const answer = JSON.parse(text)
  assert.deepEqual(Object.keys(answer), ['ok', 'shape'])
  assert.deepEqual(Object.keys(answer.shape), ['head', 'tail', 'hasNextPage', 'shared', 'sameTimes', 'instants'])
  return answer.shape
}
const edges = (count, trend, first, last, newest, oldest) => ({ count, trend, first, last, newest, oldest })
/** Comments with words, authors and ids that would be seen if they leaked. */
const marked = list => list.map(item => ({ ...item, id: 'ID-' + item.id, body: 'SECRET WORDS ' + item.id, user: { name: 'Author ' + item.id } }))

test('?shape=1, same direction on both ends: counts, directions and edge instants only', async () => {
  const all = marked(range(1, 120))
  const want = {
    'newest-first': { head: edges(50, -1, stamp(120), stamp(71), stamp(120), stamp(71)), tail: edges(50, -1, stamp(50), stamp(1), stamp(50), stamp(1)) },
    'oldest-first': { head: edges(50, 1, stamp(1), stamp(50), stamp(50), stamp(1)), tail: edges(50, 1, stamp(71), stamp(120), stamp(120), stamp(71)) },
  }
  for (const listed of ORDERS) {
    const { fetchImpl, calls } = linearStub(all, { listed })
    const shape = await shapeOf(fetchImpl, all)
    assert.deepEqual(shape, { ...want[listed], hasNextPage: true, shared: 0, sameTimes: true, instants: { accepted: 100, refused: 0 } }, listed)
    assert.equal(calls.length, 1, 'one call')
    assert.ok(/tail: comments\(last: \$comments\)/.test(calls[0].query) && /comments\(first: \$comments\)/.test(calls[0].query), 'both ends are asked for')
    assert.deepEqual(calls[0].variables, { teamKey: 'YOUR_TEAM', number: 0, comments: 50 }, 'the same one query as the read')
    assert.ok(!/commentCreate/.test(calls[0].query))
  }
  // A short list is one page on both ends, every comment shared at one time.
  const few = marked(range(1, 3))
  assert.deepEqual(await shapeOf(linearStub(few).fetchImpl, few), { head: edges(3, -1, stamp(3), stamp(1), stamp(3), stamp(1)), tail: edges(3, -1, stamp(3), stamp(1), stamp(3), stamp(1)),
    hasNextPage: false, shared: 3, sameTimes: true, instants: { accepted: 6, refused: 0 } })
})

test('?shape=1, opposite directions: the shape of what the read now accepts', async () => {
  const head = marked(range(51, 100).reverse())
  const tail = marked(range(1, 50))
  const fetchImpl = async () => ends(head, { hasNextPage: true }, tail)
  const read = await answerOf(await createCrewRelay({ fetchImpl })(get(), ENV, ACCESS))
  assert.equal(read.status, 200)
  assert.deepEqual(ids(read.body.comments), ids(marked(range(51, 100))), 'the first page, oldest first')
  assert.deepEqual(await shapeOf(fetchImpl, [...head, ...tail]), {
    head: edges(50, -1, stamp(100), stamp(51), stamp(100), stamp(51)),
    tail: edges(50, 1, stamp(1), stamp(50), stamp(50), stamp(1)),
    hasNextPage: true, shared: 0, sameTimes: true, instants: { accepted: 100, refused: 0 },
  })
})

test('?shape=1, a tie-heavy list: flat and stepped ends, shared comments, and one comment with two times', async () => {
  // 60 comments in three instants of twenty, listed oldest first: the two ends share forty comments.
  const stepped = marked(range(1, 60).map((item, i) => ({ ...item, createdAt: stamp(1 + Math.floor(i / 20)) })))
  assert.deepEqual(await shapeOf(linearStub(stepped, { listed: 'oldest-first' }).fetchImpl, stepped), {
    head: edges(50, 1, stamp(1), stamp(3), stamp(3), stamp(1)),
    tail: edges(50, 1, stamp(1), stamp(3), stamp(3), stamp(1)),
    hasNextPage: true, shared: 40, sameTimes: true, instants: { accepted: 100, refused: 0 },
  })
  // 5,000 comments at one instant: both ends are flat.
  const flat = marked(range(1, 5000).map(item => ({ ...item, createdAt: stamp(7) })))
  assert.deepEqual(await shapeOf(linearStub(flat).fetchImpl, flat), {
    head: edges(50, 0, stamp(7), stamp(7), stamp(7), stamp(7)), tail: edges(50, 0, stamp(7), stamp(7), stamp(7), stamp(7)),
    hasNextPage: true, shared: 0, sameTimes: true, instants: { accepted: 100, refused: 0 },
  })
  // One comment on both ends with two times: the read refuses (two-times); the shape says sameTimes false.
  const head = marked([...range(1, 49), { ...comment(1000), id: 'shared' }])
  const tail = marked([{ ...comment(50), id: 'shared' }, ...range(51, 99)])
  const fetchImpl = async () => ends(head, { hasNextPage: true }, tail)
  assert.equal((await (await createCrewRelay({ fetchImpl })(get(), ENV, ACCESS)).json()).check, 'two-times')
  assert.deepEqual(await shapeOf(fetchImpl, [...head, ...tail]), {
    head: edges(50, 1, stamp(1), stamp(1000), stamp(1000), stamp(1)), tail: edges(50, 1, stamp(50), stamp(99), stamp(99), stamp(50)),
    hasNextPage: true, shared: 1, sameTimes: false, instants: { accepted: 100, refused: 0 },
  })
})

test('?shape=1, refused instants are counted and left out of the trend instead of failing the reading', async () => {
  const head = marked([comment(5), { ...comment(4), createdAt: '2026-11-12T10:00:00.0002Z' }, comment(3), { ...comment(2), createdAt: '2026-11-12T10:00:00+08:00' }, { ...comment(1), createdAt: undefined }])
  const fetchImpl = async () => ends(head, { hasNextPage: 'yes' })
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl })(get(), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'head-comment-time' } })
  assert.deepEqual(await shapeOf(fetchImpl, head), {
    head: edges(5, -1, stamp(5), stamp(3), stamp(5), stamp(3)), tail: null,
    hasNextPage: 'absent', shared: 0, sameTimes: true, instants: { accepted: 2, refused: 3 },
  })
  // Nothing accepted on an end: its count stays, its instants and trend are empty; an end that is not a list is null.
  const none = marked([{ ...comment(1), createdAt: 'yesterday' }])
  assert.deepEqual(await shapeOf(async () => Response.json({ data: { issues: { nodes: [{ ...ISSUE, comments: { nodes: none }, tail: { nodes: 'x' } }] } } }), none), {
    head: edges(1, 0, null, null, null, null), tail: null, hasNextPage: 'absent', shared: 0, sameTimes: true, instants: { accepted: 0, refused: 1 },
  })
  // The transport rules still hold: an answer that is not JSON is refused with its word, a missing issue is a 404.
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: async () => new Response('<html>') })(shapeGet(), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_MALFORMED', check: 'payload-json' } })
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: async () => Response.json({ data: { issues: { nodes: [] } } }) })(shapeGet(), ENV, ACCESS)), { status: 404, body: { ok: false, code: 'RELAY_ISSUE_NOT_FOUND' } })
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: async () => new Response(new Uint8Array(2 * 1024 * 1024 + 1)), upstreamTimeoutMs: 5000 })(shapeGet(), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_TOO_LARGE' } })
  assert.deepEqual(await answerOf(await createCrewRelay({ fetchImpl: () => new Promise(() => {}), upstreamTimeoutMs: 40 })(shapeGet(), ENV, ACCESS)), { status: 502, body: { ok: false, code: 'RELAY_UPSTREAM_UNAVAILABLE' } })
})

test('?shape=1 takes no other parameter, needs the owner, and asks Linear nothing when refused', async () => {
  const { fetchImpl, calls } = linearStub([comment(1)])
  const relay = createCrewRelay({ fetchImpl })
  for (const query of ['shape=0', 'shape=', 'shape=true', 'shape=1&shape=1', 'shape=1&after=' + encodeURIComponent(stamp(1)), 'shape=1&x=1']) {
    assert.deepEqual(await answerOf(await relay(shapeGet(query), ENV, ACCESS)), { status: 400, body: { ok: false, code: 'RELAY_SHAPE_INVALID' } }, query)
  }
  for (const access of [null, { type: 'guest', email: 'friend@example.invalid' }]) {
    assert.deepEqual(await answerOf(await relay(shapeGet(), ENV, access)), { status: 401, body: { ok: false, code: 'OWNER_ACCESS_REQUIRED' } })
  }
  assert.deepEqual(await answerOf(await relay(shapeGet(), {}, ACCESS)), { status: 503, body: { ok: false, code: 'RELAY_NOT_CONFIGURED' } })
  assert.equal(calls.length, 0)
})

test('?shape=1 never posts and leaves the post slot and interval alone; a POST is unaffected by it', async () => {
  let clock = 4_000_000
  const { fetchImpl, calls } = linearStub(range(1, 120))
  const relay = createCrewRelay({ fetchImpl, now: () => clock })
  const say = (text, path = '') => relay(new Request('https://relay.example.invalid/_host/crew-relay' + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ body: text }) }), ENV, ACCESS)
  // Shape readings, many in a row, write nothing and do not hold back the first post.
  for (let i = 0; i < 3; i += 1) assert.equal((await relay(shapeGet(), ENV, ACCESS)).status, 200)
  assert.equal((await say('one')).status, 201)
  // Inside the post interval a shape reading still answers, and the interval is neither reset nor lifted by it.
  clock += 1000
  assert.equal((await relay(shapeGet(), ENV, ACCESS)).status, 200)
  assert.equal((await say('two')).status, 429)
  clock += 4000
  // A POST with `?shape=1` on its address is an ordinary post.
  assert.deepEqual(await answerOf(await say('three', '?shape=1')), { status: 201, body: { ok: true, schema: 'aukora.crew-relay.v1', comment: { id: 'new', createdAt: stamp(9999) } } })
  const writes = calls.filter(call => /commentCreate/.test(call.query)).map(call => call.variables.body)
  assert.deepEqual(writes, ['one', 'three'])
})

test('through the Worker: ?shape=1 is the owner\'s, same-origin, like the read; no answer carries the key', async () => {
  const stub = linearStub(marked(range(1, 60)))
  await withGlobalFetch(stub.fetchImpl, async () => {
    const f = workerFixture({ LINEAR_API_KEY: KEY })
    const ok = await f.call('/_host/crew-relay?shape=1')
    const text = await ok.text()
    assert.equal(ok.status, 200, text)
    assert.ok(!text.includes(KEY))
    assert.equal(JSON.parse(text).shape.instants.accepted, 100)
    assert.equal((await f.call('/_host/crew-relay?shape=1', { headers: { origin: undefined } })).status, 200)
    assert.equal(stub.calls.length, 2)
  })
  let called = 0
  await withGlobalFetch(async () => { called += 1; throw new Error('must not be called') }, async () => {
    const f = workerFixture({ LINEAR_API_KEY: KEY })
    for (const [headers, status, code] of [
      [{ 'sec-fetch-site': 'cross-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      [{ 'sec-fetch-site': 'same-site' }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      [{ 'sec-fetch-site': undefined }, 403, 'SAME_ORIGIN_BROWSER_REQUIRED'],
      [{ origin: 'https://evil.example' }, 403, 'ORIGIN_REFUSED'],
    ]) {
      assert.deepEqual(await answerOf(await f.call('/_host/crew-relay?shape=1', { headers })), { status, body: { ok: false, code } }, JSON.stringify(headers))
    }
    f.setAccess(null)
    const response = await f.call('/_host/crew-relay?shape=1', { headers: { 'x-x6-verified-access': JSON.stringify({ type: 'owner', email: 'owner@example.invalid', expires: 4102444800 }), 'x-x6-internal-authorized': '1' } })
    assert.equal(response.status, 401)
    assert.equal(called, 0)
  })
})
