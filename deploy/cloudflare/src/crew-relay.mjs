/**
 * Owner-only crew relay. Exactly two operations on the relay issue, never arbitrary GraphQL:
 *
 *   GET  /_host/crew-relay?after=<ISO>   the issue and its comments newer than `after`
 *   GET  /_host/crew-relay?shape=1       the same one query, answered as its shape only (counts, directions, instants)
 *   POST /_host/crew-relay { "body": "…" }   append one comment
 *
 * A refusal of Linear's answer (RELAY_UPSTREAM_MALFORMED) also carries `check`, a fixed word naming the rule
 * (RELAY_CHECKS).
 *
 * The Linear key is read from env.LINEAR_API_KEY inside this module and is never returned, logged or
 * echoed. The issue is fixed (TEAM_KEY and ISSUE_NUMBER below, placeholders here); the caller cannot name another issue or query.
 *
 * A read is ONE call to Linear and answers from the NEWEST page of comments only (COMMENT_PAGE of them). It never
 * walks further back: with a cursor it returns the comments on that page newer than the cursor and says `gap: true`
 * when the cursor is older than that whole page, so comments in between may exist and are not included.
 * (A read that walked pages was held in review three times; the walk is gone on purpose. A reader that polls often never
 * sees a gap.)
 */

const LINEAR_ENDPOINT = 'https://api.linear.app/graphql'
const TEAM_KEY = 'YOUR_TEAM' // placeholder: set your own team key
const ISSUE_NUMBER = 0 // placeholder: set your own relay issue's number
const MAX_COMMENT = 4000
// Bytes, not characters: 4000 characters of three bytes each, plus the JSON around them, fit.
const MAX_REQUEST = 16 * 1024
const UPSTREAM_TIMEOUT_MS = 8000
const MIN_POST_INTERVAL_MS = 5000
const COMMENT_PAGE = 50
// Linear's answer to one call, in bytes. Fifty comments are far below this; a larger answer is not read to its end.
const MAX_UPSTREAM_BYTES = 2 * 1024 * 1024
// Times are instants in milliseconds, in the one shape Linear writes and this relay hands back as a cursor.
const ISO_INSTANT = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$/

/** An ISO time as milliseconds, or null: times are compared as instants, never as text ("…00Z" and "…00.500Z"). */
function instant(value) {
  if (typeof value !== 'string' || !ISO_INSTANT.test(value)) return null
  const at = Date.parse(value)
  return Number.isFinite(at) ? at : null
}

// Linear's pages say a comment list is ordered by createdAt, not in which direction. So one call asks for BOTH ends
// of the list, the first page and the last page, and the relay takes the end that holds the newest comment.
const ISSUE_QUERY = `query CrewRelayIssue($teamKey: String!, $number: Float!, $comments: Int!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      id
      identifier
      title
      comments(first: $comments) {
        nodes { id body createdAt user { name } }
        pageInfo { hasNextPage }
      }
      tail: comments(last: $comments) {
        nodes { id body createdAt user { name } }
      }
    }
  }
}`

const ISSUE_ID_QUERY = `query CrewRelayIssueId($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      id
      identifier
      title
    }
  }
}`

const COMMENT_MUTATION = `mutation CrewRelayComment($issueId: String!, $body: String!) {
  commentCreate(input: { issueId: $issueId, body: $body }) {
    success
    comment { id createdAt }
  }
}`

const json = (value, status = 200) => new Response(JSON.stringify(value), {
  status,
  headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  },
})

/**
 * The closed list of words that say WHICH rule refused Linear's answer (RELAY_UPSTREAM_MALFORMED). A word travels in
 * the answer beside the code as `check`; it is always one of these fixed words, never anything Linear sent.
 *   payload-json         the answer is not JSON
 *   payload-data         the answer is JSON with no `data`
 *   head-/tail-page-shape     that end's comment list is not a list, or is longer than what was asked for
 *   head-/tail-comment-shape  a comment on that end is not an object with a string id
 *   head-/tail-comment-time   a comment on that end has a time the ISO instant pattern refuses
 *   page-info            a full first page without page information, or hasNextPage that is not a boolean
 *   head-order / tail-order   that end is in no time order (it both rises and falls)
 *   two-times            one comment id carries two different times
 *   whole-list-mismatch  the first page says it is the whole list and the other end contradicts it
 *   empty-end            more is promised and one end is empty
 *   outside-page         the times do not let one end be the newest page: a comment off that page is newer than its
 *                        oldest comment; or, at a tie at the newest instant, neither end can be it; or two ends that
 *                        each run the same way end at different instants and the later one is not where that
 *                        direction puts the newest (`?shape=1` tells these apart)
 * Measured on a live edge (`?shape=1`, three reads): Linear's `first: 50` is the newest 50, newest
 * first, and its `last: 50` the oldest 50, oldest first, so directions never choose the newest page; only two ends
 * that run the same way are held to agree with the times (see newestPage).
 */
export const RELAY_CHECKS = Object.freeze([
  'payload-json', 'payload-data',
  'head-page-shape', 'tail-page-shape', 'head-comment-shape', 'tail-comment-shape', 'head-comment-time', 'tail-comment-time',
  'page-info', 'head-order', 'tail-order', 'two-times', 'whole-list-mismatch', 'empty-end', 'outside-page',
])
const CHECK_WORDS = new Set(RELAY_CHECKS)

// Only an error this module made leaves as its own code and status; anything else is RELAY_FAILED.
const RELAY_ERRORS = new WeakSet()
function coded(code, status, check) {
  // A word outside the closed list is a fault of this module, not an answer: it leaves as RELAY_FAILED.
  if (check !== undefined && !CHECK_WORDS.has(check)) throw new Error('RELAY_CHECK_UNKNOWN')
  const error = new Error(code)
  error.code = code
  error.status = status
  if (check !== undefined) error.check = check
  RELAY_ERRORS.add(error)
  return error
}
/** Linear's answer refused by the named rule. */
const malformed = check => coded('RELAY_UPSTREAM_MALFORMED', 502, check)

/** Lets a stream go without waiting for it: a cancel that never settles must not hold the request. */
function letGo(cancel) {
  try {
    const done = cancel()
    if (done && typeof done.catch === 'function') done.catch(() => {})
  } catch { /* already gone */ }
}

/**
 * One call to Linear under ONE deadline that covers the request, the answer's body and nothing after it. The deadline
 * is raced by this function itself, so it holds even when the transport ignores the abort signal.
 */
async function callLinear(send, timeoutMs, key, query, variables) {
  const deadline = AbortSignal.timeout(timeoutMs)
  let expire
  const late = new Promise((_, reject) => {
    expire = () => reject(coded('RELAY_UPSTREAM_UNAVAILABLE', 502))
    if (deadline.aborted) expire()
    else deadline.addEventListener('abort', expire, { once: true })
  })
  late.catch(() => {}) // reported through the races below; a call that finished first leaves no unhandled rejection
  const startedAt = Date.now()
  // Asked after EVERY wait, by the clock as well as the signal: an answer or a last piece that arrives after the
  // deadline is refused even when the timer has not had its turn to fire.
  const expired = () => deadline.aborted || Date.now() - startedAt > timeoutMs
  let response = null
  let reader = null
  let sent = null
  try {
    try {
      sent = send(LINEAR_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: key,
        },
        body: JSON.stringify({ query, variables }),
        // The key goes to api.linear.app and nowhere else: a redirect is an answer to refuse, never one to follow.
        redirect: 'manual',
        signal: deadline,
      })
      response = await Promise.race([sent, late])
    } catch {
      // An answer that arrives after the deadline was lost is let go unread.
      if (sent && typeof sent.then === 'function') sent.then(lost => { if (lost?.body) letGo(() => lost.body.cancel()) }, () => {})
      throw coded('RELAY_UPSTREAM_UNAVAILABLE', 502)
    }
    if (expired()) throw coded('RELAY_UPSTREAM_UNAVAILABLE', 502)
    if (response.type === 'opaqueredirect' || (response.status >= 300 && response.status < 400)) throw coded('RELAY_UPSTREAM_REFUSED', 502)
    // Linear asking the key to slow down is its own answer, so the reader waits instead of calling the door broken.
    if (response.status === 429) throw coded('RELAY_UPSTREAM_RATE_LIMITED', 429)

    reader = response.body?.getReader?.() ?? null
    const chunks = []
    let total = 0
    let reads = 0
    while (reader) {
      // A body that hands over empty pieces without ever yielding to the timer must still stop, and so must one cut
      // into an absurd number of pieces.
      reads += 1
      if (expired() || reads > 65536) throw coded('RELAY_UPSTREAM_UNAVAILABLE', 502)
      let step
      try {
        step = await Promise.race([reader.read(), late])
      } catch (error) {
        throw RELAY_ERRORS.has(error) ? error : coded('RELAY_UPSTREAM_UNAVAILABLE', 502)
      }
      if (expired()) throw coded('RELAY_UPSTREAM_UNAVAILABLE', 502)
      if (step.done) break
      total += step.value.byteLength
      if (total > MAX_UPSTREAM_BYTES) throw coded('RELAY_UPSTREAM_TOO_LARGE', 502)
      chunks.push(step.value)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }

    let payload
    try {
      payload = JSON.parse(new TextDecoder().decode(bytes))
    } catch {
      throw malformed('payload-json')
    }
    if (payload && typeof payload === 'object' && Array.isArray(payload.errors)
      && payload.errors.some(item => item?.extensions?.code === 'RATELIMITED')) throw coded('RELAY_UPSTREAM_RATE_LIMITED', 429)
    if (!response.ok || !payload || typeof payload !== 'object') throw coded('RELAY_UPSTREAM_REFUSED', 502)
    if (Array.isArray(payload.errors) && payload.errors.length) throw coded('RELAY_UPSTREAM_ERROR', 502)
    if (!payload.data || typeof payload.data !== 'object') throw malformed('payload-data')
    return payload.data
  } finally {
    deadline.removeEventListener('abort', expire)
    // Whatever was not read to its end is let go, without waiting: a refused answer, an oversized one, a late one.
    if (reader) {
      letGo(() => reader.cancel())
      try { reader.releaseLock() } catch { /* a read still pending holds it; the cancel above ends that read */ }
    } else if (response?.body) letGo(() => response.body.cancel())
  }
}

/** The comments of one page as Linear listed them, each with its instant; refused unless every one has an id and a time. */
function listed(connection, end) {
  const nodes = connection?.nodes
  // A page holds at most what was asked for: a longer one is not an answer to this query.
  if (!Array.isArray(nodes) || nodes.length > COMMENT_PAGE) throw malformed(`${end}-page-shape`)
  return nodes.map(comment => {
    // One refusal as before (no comment, no string id, or a time the pattern refuses); the word says which part.
    if (!comment || typeof comment.id !== 'string') throw malformed(`${end}-comment-shape`)
    const at = instant(comment.createdAt)
    if (at === null) throw malformed(`${end}-comment-time`)
    return { ...comment, at }
  })
}

/** 1 when the instants never fall, -1 when they never rise, 0 when they are all one instant, null when neither holds. */
function trend(items) {
  let rises = false
  let falls = false
  for (let i = 1; i < items.length; i += 1) {
    if (items[i].at > items[i - 1].at) rises = true
    if (items[i].at < items[i - 1].at) falls = true
  }
  if (rises && falls) return null
  return rises ? 1 : falls ? -1 : 0
}

/**
 * The newest page of the issue's comments, and whether the list goes on beyond it. Each end must be in time order by
 * itself, either way; an end in neither order, or an end that contradicts the other, is refused.
 */
function newestPage(node) {
  const head = listed(node.comments, 'head')
  const info = node.comments.pageInfo
  // A short page with no page information is the whole list (an issue with a few comments); a full page must say
  // whether more follow, or a silent half-read would look complete.
  let beyond
  if (info === undefined || info === null) {
    if (head.length >= COMMENT_PAGE) throw malformed('page-info')
    beyond = false
  } else {
    if (typeof info !== 'object' || typeof info.hasNextPage !== 'boolean') throw malformed('page-info')
    beyond = info.hasNextPage
  }
  const headTrend = trend(head)
  if (headTrend === null) throw malformed('head-order')
  if (!beyond) {
    // The first page says it is the whole list. A comment has one time; and when the other end came with the answer
    // it must show the same comments at the same times, or the two halves of one answer contradict each other.
    const seenAt = new Map()
    for (const item of head) {
      if (seenAt.has(item.id) && seenAt.get(item.id) !== item.at) throw malformed('two-times')
      seenAt.set(item.id, item.at)
    }
    if (node.tail !== undefined && node.tail !== null) {
      const tail = listed(node.tail, 'tail')
      if (trend(tail) === null) throw malformed('tail-order')
      const tailIds = new Set(tail.map(item => item.id))
      if (tail.some(item => seenAt.get(item.id) !== item.at) || head.some(item => !tailIds.has(item.id))) throw malformed('whole-list-mismatch')
    }
    return { page: head, beyond: false }
  }

  // The list is longer than one page: its other end decides which end is the newest.
  const tail = listed(node.tail, 'tail')
  const tailTrend = trend(tail)
  // One refusal as before, now said in two words: the other end in no order, or an end with nothing on it.
  if (tailTrend === null) throw malformed('tail-order')
  if (head.length === 0 || tail.length === 0) throw malformed('empty-end')
  // A comment has ONE time: the same id with two instants, on either end or across them, is not a list to trust.
  const timeOf = new Map()
  for (const item of [...head, ...tail]) {
    if (timeOf.has(item.id) && timeOf.get(item.id) !== item.at) throw malformed('two-times')
    timeOf.set(item.id, item.at)
  }
  const newest = items => items.reduce((most, item) => Math.max(most, item.at), -Infinity)
  const oldest = items => items.reduce((least, item) => Math.min(least, item.at), Infinity)
  // The newest page is the end whose newest instant is later; each end's own direction does not decide it (Linear
  // lists its two ends in opposite directions: see RELAY_CHECKS).
  const headNewest = newest(head)
  const tailNewest = newest(tail)
  let page
  if (headNewest !== tailNewest) page = headNewest > tailNewest ? head : tail
  else {
    // Both ends reach the same newest instant: the page is the end that holds every comment at that instant that the
    // other end holds (the first page when both do). An end whose comments are ALL at that instant can have nothing
    // newer outside it, so it may still be the page (the first page first); otherwise no end is the newest page.
    const atNewest = items => new Set(items.filter(item => item.at === headNewest).map(item => item.id))
    const headAt = atNewest(head)
    const tailAt = atNewest(tail)
    const holdsAll = (mine, theirs) => [...theirs].every(id => mine.has(id))
    const flat = items => items.every(item => item.at === headNewest)
    page = holdsAll(headAt, tailAt) ? head : holdsAll(tailAt, headAt) ? tail : flat(head) ? head : flat(tail) ? tail : null
    if (page === null) throw malformed('outside-page')
  }
  // Two ends that run the SAME direction are read as one list, as before: a list newest first holds its newest on the
  // first page, one oldest first on the last. A later end that this direction does not put first contradicts it. It
  // binds only when both ends run a way (a flat end, such as one comment, runs none) and their newest instants differ;
  // the test "its edges are pinned" holds the shapes it leaves to the times alone.
  if (headTrend !== 0 && headTrend === tailTrend && headNewest !== tailNewest && page !== (headTrend < 0 ? head : tail)) throw malformed('outside-page')
  const other = page === head ? tail : head
  // Every comment that is on the other end and NOT on this page must be at or before this page's oldest comment
  // (the two ends share comments when the list is shorter than two pages). Otherwise the list is not in time order
  // and a comment newer than a reader's cursor could sit outside the page unseen.
  const onPage = new Set(page.map(item => item.id))
  const floor = oldest(page)
  if (other.some(item => !onPage.has(item.id) && item.at > floor)) throw malformed('outside-page')
  return { page, beyond: true }
}

/**
 * The SHAPE of one end of Linear's answer, for the owner's diagnosis: how many comments, in which time direction, and
 * the instants at its edges. No rule is applied: a comment whose time the pattern refuses is counted and left out of
 * the trend. Only counts, directions and normalised instants leave; never a body, an author or an id. An end that is
 * not a list reads as null.
 */
function endShape(connection, tally) {
  const nodes = connection?.nodes
  if (!Array.isArray(nodes)) return null
  const timed = []
  for (const comment of nodes) {
    const at = instant(comment?.createdAt)
    if (at === null) tally.refused += 1
    else { tally.accepted += 1; timed.push({ at }) }
  }
  const iso = at => (at === null ? null : new Date(at).toISOString())
  const ats = timed.map(item => item.at)
  return {
    count: nodes.length,
    trend: trend(timed),
    first: iso(ats.length ? ats[0] : null),
    last: iso(ats.length ? ats[ats.length - 1] : null),
    newest: iso(ats.length ? ats.reduce((a, b) => Math.max(a, b)) : null),
    oldest: iso(ats.length ? ats.reduce((a, b) => Math.min(a, b)) : null),
  }
}

/** What both ends of one answer look like together; see endShape for what may leave. */
function answerShape(node) {
  const instants = { accepted: 0, refused: 0 }
  const head = endShape(node.comments, instants)
  const tail = endShape(node.tail, instants)
  const info = node.comments?.pageInfo
  const hasNextPage = info && typeof info === 'object' && typeof info.hasNextPage === 'boolean' ? info.hasNextPage : 'absent'
  // Each id's times across both ends, a refused time written as its own mark; an id is shared when both ends list it.
  const timesOf = new Map()
  const idsOn = connection => {
    const seen = new Set()
    for (const comment of Array.isArray(connection?.nodes) ? connection.nodes : []) {
      if (!comment || typeof comment.id !== 'string') continue
      seen.add(comment.id)
      const at = instant(comment.createdAt)
      if (!timesOf.has(comment.id)) timesOf.set(comment.id, new Set())
      timesOf.get(comment.id).add(at === null ? 'refused' : at)
    }
    return seen
  }
  const headIds = idsOn(node.comments)
  const tailIds = idsOn(node.tail)
  const sharedIds = [...headIds].filter(id => tailIds.has(id))
  return {
    head,
    tail,
    hasNextPage,
    shared: sharedIds.length,
    sameTimes: sharedIds.every(id => timesOf.get(id).size === 1),
    instants,
  }
}

export function createCrewRelay({ fetchImpl, now = Date.now, upstreamTimeoutMs = UPSTREAM_TIMEOUT_MS } = {}) {
  let lastPostAt = 0
  // The post slot is `{ until }`: busy only while its deadline is ahead. A request the runtime drops in mid-flight
  // (a closed tab) can therefore never keep the slot for the life of the isolate.
  let postSlot = null
  // Two calls to Linear at most, each bounded by the deadline, plus a margin.
  const postHoldMs = 2 * upstreamTimeoutMs + 4000

  // Resolved per call when none was injected, so the Worker's one instance can be exercised by a test.
  const linear = (env, query, variables) => callLinear(fetchImpl ?? globalThis.fetch, upstreamTimeoutMs, env.LINEAR_API_KEY, query, variables)

  function issueNode(data) {
    const node = data?.issues?.nodes?.[0]
    if (!node || typeof node.id !== 'string' || typeof node.identifier !== 'string') {
      throw coded('RELAY_ISSUE_NOT_FOUND', 404)
    }
    return node
  }

  async function handle(request, env, access) {
    if (!access || (access.type !== 'owner' && access.type !== 'access')) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
    if (!env || typeof env.LINEAR_API_KEY !== 'string' || env.LINEAR_API_KEY.trim() === '') {
      return json({ ok: false, code: 'RELAY_NOT_CONFIGURED' }, 503)
    }

    const url = new URL(request.url)

    if (request.method === 'GET') {
      // `?shape=1`: the same one query, answered as its shape only (answerShape), for the owner to see what Linear
      // sends. It takes no other parameter, applies only the transport rules, never posts and never takes the slot.
      const shapeAsked = url.searchParams.getAll('shape')
      if (shapeAsked.length > 0) {
        if (shapeAsked.length !== 1 || shapeAsked[0] !== '1' || [...url.searchParams.keys()].some(name => name !== 'shape')) {
          throw coded('RELAY_SHAPE_INVALID', 400)
        }
        const node = issueNode(await linear(env, ISSUE_QUERY, {
          teamKey: TEAM_KEY,
          number: ISSUE_NUMBER,
          comments: COMMENT_PAGE,
        }))
        return json({ ok: true, shape: answerShape(node) })
      }
      const after = url.searchParams.get('after')
      const afterAt = after === null ? null : instant(after)
      if (after !== null && afterAt === null) throw coded('RELAY_AFTER_INVALID', 400)
      const node = issueNode(await linear(env, ISSUE_QUERY, {
        teamKey: TEAM_KEY,
        number: ISSUE_NUMBER,
        comments: COMMENT_PAGE,
      }))
      const { page, beyond } = newestPage(node)
      // Each comment once, oldest first, ties by id.
      const seen = new Map()
      for (const comment of page) if (!seen.has(comment.id)) seen.set(comment.id, comment)
      const ordered = [...seen.values()].sort((a, b) => (a.at - b.at) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      const chosen = afterAt === null ? ordered : ordered.filter(comment => comment.at > afterAt)
      const comments = chosen.map(comment => ({
        id: comment.id,
        body: comment.body,
        createdAt: comment.createdAt,
        author: comment.user?.name ?? null,
      }))
      return json({
        ok: true,
        schema: 'aukora.crew-relay.v1',
        issue: { identifier: node.identifier, title: node.title },
        comments,
        // True when the reader's cursor is older than everything on the newest page and the list goes on beyond it:
        // comments between the cursor and these MAY exist and are not here (one call cannot tell). False means
        // nothing newer than the cursor is missing. Without a cursor there is nothing to miss.
        gap: afterAt !== null && beyond && ordered.length > 0 && ordered[0].at > afterAt,
      })
    }

    if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)

    const contentType = request.headers.get('content-type') ?? ''
    if (!/^application\/json(?:\s*;|$)/i.test(contentType)) throw coded('RELAY_CONTENT_TYPE_REQUIRED', 415)
    // The size is judged in bytes, by the declared length before anything is read and by the bytes actually read.
    const declared = request.headers.get('content-length')
    if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > MAX_REQUEST)) throw coded('RELAY_BODY_TOO_LARGE', 413)
    const raw = await request.text()
    if (new TextEncoder().encode(raw).byteLength > MAX_REQUEST) throw coded('RELAY_BODY_TOO_LARGE', 413)
    let input
    try {
      input = JSON.parse(raw)
    } catch {
      throw coded('RELAY_BODY_MALFORMED', 400)
    }
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw coded('RELAY_BODY_MALFORMED', 400)
    const keys = Object.keys(input)
    if (keys.length !== 1 || keys[0] !== 'body') throw coded('RELAY_OPERATION_UNKNOWN', 400)
    if (typeof input.body !== 'string') throw coded('RELAY_COMMENT_MALFORMED', 400)
    const body = input.body.trim()
    if (!body || body.length > MAX_COMMENT) throw coded('RELAY_COMMENT_LENGTH', 400)

    // One post at a time, and the next no sooner than MIN_POST_INTERVAL_MS after the last one FINISHED. The slot is
    // taken before the first wait on Linear, so two posts that arrive together cannot both go out.
    const admitted = () => {
      const at = now()
      return at - lastPostAt >= MIN_POST_INTERVAL_MS ? at : null
    }
    const started = admitted()
    if (started === null || (postSlot !== null && postSlot.until > started)) throw coded('RELAY_RATE_LIMITED', 429)
    const slot = { until: started + postHoldMs }
    postSlot = slot
    try {
      const node = issueNode(await linear(env, ISSUE_ID_QUERY, { teamKey: TEAM_KEY, number: ISSUE_NUMBER }))
      // Asked again right before the write: a post whose slot another post now holds, or that outlived its own hold,
      // or that another post's interval now covers, has lost its turn and sends nothing.
      const writeAt = admitted()
      if (postSlot !== slot || writeAt === null || slot.until <= writeAt) throw coded('RELAY_RATE_LIMITED', 429)
      let data
      try {
        data = await linear(env, COMMENT_MUTATION, { issueId: node.id, body })
      } finally {
        // The write was sent. Whether its answer came back or was lost, Linear may hold the comment: the interval
        // starts here, so a caller who retries at once cannot send the same words twice in a row.
        lastPostAt = now()
      }
      const created = data?.commentCreate?.comment
      if (data?.commentCreate?.success !== true || !created || typeof created.id !== 'string') {
        throw coded('RELAY_COMMENT_REFUSED', 502)
      }
      return json({
        ok: true,
        schema: 'aukora.crew-relay.v1',
        comment: { id: created.id, createdAt: created.createdAt },
      }, 201)
    } finally {
      if (postSlot === slot) postSlot = null
    }
  }

  /** Every refusal of this route leaves as its own code and status; nothing else about the failure is said. */
  return async function handleCrewRelay(request, env, access) {
    try {
      return await handle(request, env, access)
    } catch (error) {
      // `check` is a word from RELAY_CHECKS (coded() admits no other), present only when a rule refused Linear's answer.
      if (RELAY_ERRORS.has(error)) return json({ ok: false, code: error.code, ...(error.check === undefined ? {} : { check: error.check }) }, error.status)
      return json({ ok: false, code: 'RELAY_FAILED' }, 500)
    }
  }
}
