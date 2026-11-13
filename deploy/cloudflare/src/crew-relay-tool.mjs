/**
 * The organ-side half of the crew relay: a plain tool descriptor any Cordis organ can mount.
 *
 *   read  { after? }   one call; the newest 50 comments on the relay issue, plus `gap: true` when the
 *                      cursor is older than that page
 *   say   { body }     one comment on the relay issue, at most 4000 characters
 *
 * The route it calls is owner-gated; the browser sends the owner's own cookie, so this module holds no
 * key and carries no credential. It is a transport, not an authority.
 */
const MAX_ANSWER_BYTES = 256 * 1024

async function parseAnswer(response) {
  const text = await response.text()
  if (new TextEncoder().encode(text).byteLength > MAX_ANSWER_BYTES) {
    return { ok: false, code: 'RELAY_ANSWER_TOO_LARGE', status: response.status }
  }
  try {
    return JSON.parse(text)
  } catch {
    return { ok: false, code: 'RELAY_ANSWER_NOT_JSON', status: response.status }
  }
}

async function request(fetchImpl, url, init) {
  try {
    return await parseAnswer(await fetchImpl(url, init))
  } catch {
    return { ok: false, code: 'RELAY_UNREACHABLE' }
  }
}

export function createCrewRelayTool({ origin, fetchImpl = fetch } = {}) {
  if (typeof origin !== 'string' || origin === '' || origin.endsWith('/')) {
    throw new Error('RELAY_ORIGIN_REQUIRED')
  }
  const endpoint = `${origin}/_host/crew-relay`

  return {
    name: 'crew_relay',
    description:
      'Owner-gated door to the Linear crew relay. `read` is ONE call: it returns the newest 50 '
      + 'comments on the relay issue and `gap: true` when your `after` cursor is older than that page. '
      + '`say` posts one comment (max 4000 chars). After `say`, wait at least 5 s before `read` again. '
      + 'On 429 `RELAY_UPSTREAM_RATE_LIMITED`, wait and retry once, then stop. On 502 '
      + '`RELAY_UPSTREAM_ERROR`, do not rapid-retry; report it. An answer that is not JSON returns '
      + '`RELAY_ANSWER_NOT_JSON` with its status; do not retry it.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        op: { type: 'string', enum: ['read', 'say'] },
        after: { type: 'string' },
        body: { type: 'string', maxLength: 4000 },
      },
      required: ['op'],
    },
    async execute(args = {}) {
      if (args.op === 'read') {
        const url = new URL(endpoint)
        if (typeof args.after === 'string' && args.after !== '') url.searchParams.set('after', args.after)
        return await request(fetchImpl, url.toString(), { method: 'GET', credentials: 'same-origin' })
      }
      if (args.op === 'say') {
        return await request(fetchImpl, endpoint, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ body: args.body }),
        })
      }
      throw new Error('RELAY_OPERATION_UNKNOWN')
    },
  }
}
