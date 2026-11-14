/** The one classifier for her Cloudflare door (cloud-brokers.mjs `cloudflareBroker` calls it).
 *
 * She has the whole account. Reads are open on every path; every write is open, except
 * three families that ask for the owner's passkey on the exact request (P1 her live home, P2 who holds keys, P3 deleting
 * a whole zone or account), and a short list of paths whose answer IS a key or secret, which are refused because keys
 * stay at the edge. Pure: no network, no clock, no storage; facts it needs from Cloudflare (what an id names) are asked
 * for by the verdict `needs` and given back by the caller. Closed by construction: a request that does not parse is
 * refused, never passed. docs/auma/cloudflare-door.md is her page for it.
 *
 * Job 4 (): the door has LEVELS (CLOUDFLARE_DOOR_LEVEL_TABLE). At `open`, his choice now, only the
 * dangerous core asks (C1 what serves her live host and its code, C2 her live home's storage, C3 who holds keys, C4
 * whole-thing deletion); at `guarded` every family above asks. The credential refusals and the answer screen do not
 * depend on the level.
 *
 * Job 5: at `open` a list of dangerous families can never be complete, so the
 * core is held by STRUCTURE: R1 every write to the live zone; R2 the account- and user-wide switches (ACCOUNT_WIDE);
 * R3 what the live Worker is made of, from its own settings when the edge can read them (liveWorkerFacts); R5a a path
 * with a credential-vocabulary segment (CLOUDFLARE_CREDENTIAL_VOCABULARY); R5b a body with a credential-shaped field
 * (bodyCarriesCredential); C5 anything that commits the owner to a charge (CLOUDFLARE_CHARGES, family P4). The family
 * names in the table are kept as the words on the card. */

import { canonicalJson } from './owner-grant-policy.mjs'

export const CLOUDFLARE_API_ORIGIN = 'https://api.cloudflare.com/client/v4'

/** Bounds of the door. The request bound is the broker's (CLOUD_BROKER_LIMITS.requestBytes, 256 KiB); the deadline is
 * CLOUD_BROKER_LIMITS.timeoutMs per call. Only the answer is larger than the other doors, for long list answers. */
export const CLOUDFLARE_DOOR_LIMITS = Object.freeze({
  pathChars: 1024,
  queryKeys: 32,
  queryValueChars: 2048,
  /** The whole answer she gets back (the broker's final check). */
  answerBytes: 1024 * 1024,
  /** Cloudflare's raw body, read with room left for the answer's own fields. */
  upstreamBytes: 1024 * 1024 - 16 * 1024,
  /** Fact lookups before a write: the live home's own facts, then a zone, record, route or product it names, then a zone
   * a nested request names. */
  factRounds: 5,
  /** The one read of her bound Durable Object namespaces (Cloudflare's maximum page). Job 7: read for every write, never kept. */
  boundIdPage: 1000,
  /** Job 7: a string that is itself JSON is read layer after layer up to this many layers; past it, or past
   * the node budget, what is left unread holds the write (`inspection-limit`). */
  viewLayers: 4,
  viewNodes: 200_000,
  /** Job 7: a request nested in a body is classified as its own request, to this depth. */
  nestedDepth: 3,
  /** Job 7: a held request must fit the staged file her card reads (STAGED_OUTWARD_MAX_BYTES in
   * webworker-runtime ball-loader.ts and in the card's outward-class3.ts; cloudflare-door.test.mjs checks they agree). */
  stagedBytes: 256 * 1024,
  /** A multipart body the edge builds: at most this many parts, and at most the broker's request bound in bytes
   * (CLOUD_BROKER_LIMITS.requestBytes, 256 KiB; cloudflare-door.test.mjs checks they agree). */
  multipartParts: 16,
  multipartBytes: 256 * 1024,
})

/** What serves her live home and what it stores. `storage` lists every storage object deploy/cloudflare/wrangler.toml
 * binds; cloudflare-door.test.mjs fails when a binding is not here, so a new binding forces a decision. */
export const CLOUDFLARE_LIVE_HOME = Object.freeze({
  hosts: Object.freeze(['node.example.invalid']),
  worker: 'your-node',
  storage: Object.freeze([
    Object.freeze({ binding: 'HEAD', kind: 'durable_object_class', name: 'X61HeadDurableObject' }),
    Object.freeze({ binding: 'MIRROR', kind: 'durable_object_class', name: 'MirrorDO' }),
    // The managed voice's bridge (admission counters, live conversations): her live home's storage like the two above.
    Object.freeze({ binding: 'VOICE_BRIDGE', kind: 'durable_object_class', name: 'VoiceBridgeDO' }),
    Object.freeze({ binding: 'ARCHIVE_BUCKET', kind: 'r2_bucket', name: 'your-node-archive' }),
  ]),
})

/** How each storage kind wrangler.toml binds today is recognised when a write addresses it (MUST 1:
 * a name rule cannot see an id). A Durable Object namespace also has an id, so a write carrying an id is checked against
 * the ids Cloudflare lists for the live Worker (`lookup`); an R2 bucket's only identifier is its name (`name`). KV, D1
 * and queues are not bound, so their ids need no lookup. cloudflare-door.test.mjs fails when wrangler.toml binds a kind
 * that is not here. */
export const CLOUDFLARE_BOUND_KINDS = Object.freeze({ 'durable_objects.bindings': 'lookup', r2_buckets: 'name' })

/** The families that ask for the owner's passkey, and the reason words a verdict may carry. */
export const CLOUDFLARE_PROTECTED_FAMILIES = Object.freeze(['P1', 'P2', 'P3', 'P4', 'account-wide-unclassified'])
/** C5's reason words (family P4), one per charge family the review named. */
const CHARGE_REASONS = ['paid-subscription', 'paid-subscription-bulk', 'paid-subscription-action', 'registrar-purchase', 'registrar-renewal',
  'registrar-transfer', 'billing-payment', 'paid-routing-enable', 'paid-storage-enable', 'paid-certificate-order', 'credit-purchase', 'billing']
export const CLOUDFLARE_PROTECTED_REASONS = Object.freeze(['live-worker', 'live-worker-settings', 'live-host', 'live-route', 'live-dns', 'live-zone',
  'bound-storage', 'user', 'keys', 'members', 'account', 'access', 'zone-deletion', 'account-deletion', 'unclassified',
  // Review: an id the edge could not check, another account, another API root, a host name it cannot read.
  'bound-id-unresolved', 'other-account', 'root-unclassified', 'host-unreadable',
  // Job 4: the registration of the live host's own domain (renewal, lock), apart from the zone-wide switches.
  'live-domain',
  // Job 5: an account- or user-wide switch; a Worker, service or dispatch namespace the live Worker uses, or that the
  // edge could not check; a zone the edge could not resolve; and the charges (C5).
  'account-switch', 'live-dependency', 'live-dependency-unresolved', 'zone-unresolved', ...CHARGE_REASONS,
  // Job 7: an application's secret or certificate (P2, apart from `keys`, which is now only what opens
  // the account itself or who can sign in); the live home's own facts could not be read (P1); a part of the request wrapped
  // more deeply than the door reads (P1).
  'app-secret', 'live-facts-unresolved', 'inspection-limit'])

/** The door's levels. `open` is the owner's choice;
 * `guarded` is what jobs 2 and 3 built. An absent or unknown level is `guarded`, the safe side. */
export const CLOUDFLARE_DOOR_LEVELS = Object.freeze(['open', 'guarded'])
/** The dangerous core: what asks for the fingerprint at every level. */
export const CLOUDFLARE_CORE = Object.freeze({
  C1: 'the live home\'s address and code',
  C2: 'her live home\'s storage',
  C3: 'who holds keys or can sign in',
  C4: 'whole-thing deletion',
  C5: 'anything that commits the owner to a charge',
})
const BOTH = Object.freeze(['open', 'guarded']), GUARDED = Object.freeze(['guarded'])
/** The one table: for each protected family (the reason word a verdict carries), its verdict family, the core group it
 * belongs to (null: not core), and the levels at which it asks for the owner's fingerprint. A reason not on it asks at
 * every level. The owner moves the line by moving a row; cloudflare-door.test.mjs checks the core rows ask at both. */
export const CLOUDFLARE_DOOR_LEVEL_TABLE = Object.freeze([
  { reason: 'live-worker', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-worker-settings', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-host', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-route', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-dns', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-domain', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'host-unreadable', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'bound-storage', family: 'P1', core: 'C2', asks: BOTH },
  { reason: 'bound-id-unresolved', family: 'P1', core: 'C2', asks: BOTH },
  { reason: 'keys', family: 'P2', core: 'C3', asks: BOTH },
  { reason: 'members', family: 'P2', core: 'C3', asks: BOTH },
  { reason: 'access', family: 'P2', core: 'C3', asks: BOTH },
  // The account record carries `settings.enforce_twofactor`, which decides who may sign in to it (lead's reading: C3).
  { reason: 'account', family: 'P2', core: 'C3', asks: BOTH },
  { reason: 'zone-deletion', family: 'P3', core: 'C4', asks: BOTH },
  { reason: 'account-deletion', family: 'P3', core: 'C4', asks: BOTH },
  // Job 5, R1: every write to the live zone, whatever its family; a zone the edge could not resolve.
  { reason: 'live-zone', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'zone-unresolved', family: 'P1', core: 'C1', asks: BOTH },
  // Job 5, R2: the switches that act on every zone of the account or the user without naming one.
  { reason: 'account-switch', family: 'P1', core: 'C1', asks: BOTH },
  // Job 5, R3: a tail consumer, service or dispatch namespace the live Worker uses (or one the edge could not check).
  { reason: 'live-dependency', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'live-dependency-unresolved', family: 'P1', core: 'C1', asks: BOTH },
  // Job 5, C5: anything that commits the owner to a charge.
  ...CHARGE_REASONS.map(reason => ({ reason, family: 'P4', core: 'C5', asks: BOTH })),
  // Job 7: an application's secret or certificate (C3); the live home's facts unread, a request read only in part (C1).
  { reason: 'app-secret', family: 'P2', core: 'C3', asks: BOTH },
  { reason: 'live-facts-unresolved', family: 'P1', core: 'C1', asks: BOTH },
  { reason: 'inspection-limit', family: 'P1', core: 'C1', asks: BOTH },
  // Not core: open at `open`.
  { reason: 'user', family: 'P2', core: null, asks: GUARDED },
  { reason: 'unclassified', family: 'account-wide-unclassified', core: null, asks: GUARDED },
  { reason: 'other-account', family: 'account-wide-unclassified', core: null, asks: GUARDED },
  { reason: 'root-unclassified', family: 'account-wide-unclassified', core: null, asks: GUARDED },
].map(Object.freeze))

/** The level in force: `open` only when env.CLOUDFLARE_DOOR_LEVEL is exactly "open"; anything else is `guarded`. */
export function cloudflareDoorLevel(env) {
  return env?.CLOUDFLARE_DOOR_LEVEL === 'open' ? 'open' : 'guarded'
}
/** Whether a protected family (reason word) asks for the fingerprint at a level. A reason not on the table asks. */
export function cloudflareAsksAt(level, reason) {
  const row = CLOUDFLARE_DOOR_LEVEL_TABLE.find(item => item.reason === reason)
  return row === undefined || row.asks.includes(level === 'open' ? 'open' : 'guarded')
}
/** What `status` says about the level, for her and for reviewers: the level and the families that ask at it and at guarded. */
export function cloudflareDoorStatus(env) {
  const level = cloudflareDoorLevel(env)
  const asking = at => CLOUDFLARE_DOOR_LEVEL_TABLE.filter(row => row.asks.includes(at)).map(row => row.reason)
  return { level, asksAtThisLevel: asking(level), asksAtGuarded: asking('guarded') }
}
/** The Cloudflare family an `account-wide-unclassified` verdict names (`apiFamily`): one or two lower-cased path segments. */
export const CLOUDFLARE_API_FAMILY = /^[a-z0-9._~@:-]{1,64}(?:\/[a-z0-9._~@:-]{1,64})?$/

/** What to do next, one sentence per refusal (the broker passes only these). */
export const CLOUDFLARE_NEXT = Object.freeze({
  request: 'api takes { action: "api", method: GET|POST|PUT|PATCH|DELETE, path, query?, body?, bodyKind?, contentType? }: query is a flat object of at most 32 strings, numbers or booleans, and a GET has no body',
  path: 'path starts with / and has plain segments (letters, digits and . _ ~ @ : -) or {account}; no empty segment, no . or .., no %, ?, #, backslash or space; parameters go in query',
  multipart: 'bodyKind is "json" (default), "text" or "multipart"; a module Worker with bindings goes as bodyKind "multipart" with parts [{ name: "metadata", contentType: "application/json", json: { main_module, bindings, compatibility_date } }, { name: "worker.js", filename: "worker.js", contentType: "application/javascript+module", text }]',
  parts: 'multipart takes parts: 1 to 16 of { name, filename?, contentType, text | json }, names unique and plain (letters, digits, . _ ~ @ + - and /), contentType one of application/javascript+module, application/javascript, text/javascript, application/json, text/plain, application/toml, text/x-python, application/source-map (json parts are application/json); no body or contentType beside parts, and no GET',
  binary: 'binary parts (a Wasm module, an image, any bytes) are not in this door yet: only text and json parts go today',
  size: 'the multipart body the edge builds is over 256 KiB: split the upload or make the parts smaller',
  assets: 'a static-asset upload session answers an upload credential, and credentials stay at the edge: static assets are a later job of this door; until then put the files in the Worker itself (a text or json part) or ask the owner',
  credential: 'this answer is a key or secret, and keys stay at the edge: the owner makes or reads it in the Cloudflare dashboard (he can set it as a Worker secret, which the edge uses without showing it)',
  account: 'the edge has no Cloudflare account id configured, so {account} cannot be filled: put the account id in the path (GET /accounts lists them)',
  unresolved: 'the edge looks an id up on Cloudflare before a write to see what it touches, and could not: check the id with a GET first',
  withheld: 'Cloudflare answered with something shaped like a key or secret, so none of the answer is shown: read the status, and use a narrower GET for the rest',
  stored: 'the stored value is shaped like a key or secret, so it is not shown: keys stay at the edge; read the key list or its metadata instead, and ask the owner to keep a secret as a Worker secret',
  wrangler: 'wrangler has no edge behind it: use action "api" (any Cloudflare API v4 path, e.g. GET /accounts/{account}/workers/scripts)',
  // Job 7.
  tooLarge: 'this request needs the owner\'s fingerprint, and it is too large for his card to show whole: nothing was sent and nothing was staged; split it into smaller requests',
  reasonChanged: 'the reason this request needs the owner\'s fingerprint is not the one his card showed (or it no longer needs it): nothing was sent and his approval was not used; the request has to be asked for again so his card shows the reason as it is now',
})

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']
const INPUT_KEYS = ['action', 'method', 'path', 'query', 'body', 'bodyKind', 'contentType', 'parts']
const TEXT_TYPES = ['application/javascript', 'text/plain', 'application/toml']
const PART_KEYS = ['name', 'filename', 'contentType', 'text', 'json']
const PART_TYPES = ['application/javascript+module', 'application/javascript', 'text/javascript', 'application/json', 'text/plain', 'application/toml', 'text/x-python', 'application/source-map']
const BINARY_TYPE = /^(?:application\/(?:wasm|octet-stream|zip|gzip|x-tar|pdf)|image\/|video\/|audio\/|font\/)/i
const PART_NAME = /^[A-Za-z0-9._~@+-]+(?:\/[A-Za-z0-9._~@+-]+)*$/
const SEGMENT = /^[A-Za-z0-9._~@:-]+$/
const QUERY_KEY = /^[A-Za-z0-9_.[\]-]{1,128}$/
const ACCOUNT_ID = /^[a-f0-9]{32}$/
// Shape of an email address: no space, no control character, one @, a dotted domain.
const EMAIL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const refused = (code, status, next) => Object.freeze({ verdict: 'refused', code, status, next })
const coded = (code, status) => Object.assign(new Error(code), { code, status })

/** Paths whose answer IS credential material, refused for the methods named (every method when none is named).
 * From Cloudflare's API v4 reference; each with its reason. */
export const CLOUDFLARE_CREDENTIAL_PATHS = Object.freeze([
  { pattern: ['accounts', '*', 'cfd_tunnel', '*', 'token'], reason: 'a Cloudflare Tunnel run credential (it runs the tunnel as the account)' },
  { pattern: ['accounts', '*', 'warp_connector', '*', 'token'], reason: 'a WARP Connector run credential' },
  { pattern: ['accounts', '*', 'r2', 'temp-access-credentials'], reason: 'mints R2 S3 access keys' },
  { pattern: ['accounts', '*', 'stream', 'keys'], methods: ['POST'], reason: 'creates a Stream signing key and answers its private key' },
  { pattern: ['accounts', '*', 'images', 'v1', 'keys', '**'], reason: 'Images signing keys, answered in full' },
  { pattern: ['accounts', '*', 'challenges', 'widgets'], methods: ['POST'], reason: 'creates a Turnstile widget and answers its secret' },
  { pattern: ['accounts', '*', 'challenges', 'widgets', '*'], methods: ['GET'], reason: 'a Turnstile widget with its secret' },
  { pattern: ['accounts', '*', 'challenges', 'widgets', '*', 'rotate_secret'], reason: 'rotates a Turnstile secret and answers it' },
  { pattern: ['user', 'tokens'], methods: ['POST'], reason: 'creates an API token and answers its value' },
  { pattern: ['user', 'tokens', '*', 'value'], reason: 'rolls an API token and answers its value' },
  { pattern: ['accounts', '*', 'tokens'], methods: ['POST'], reason: 'creates an account API token and answers its value' },
  { pattern: ['accounts', '*', 'tokens', '*', 'value'], reason: 'rolls an account API token and answers its value' },
  { pattern: ['accounts', '*', 'access', 'service_tokens'], methods: ['POST'], reason: 'creates an Access service token and answers its client secret' },
  { pattern: ['accounts', '*', 'access', 'service_tokens', '*', 'rotate'], reason: 'rotates an Access service token and answers its client secret' },
  { pattern: ['accounts', '*', 'calls', 'turn_keys'], methods: ['POST'], reason: 'creates a Calls TURN key and answers the key itself (the answer field is not screened by name)' },
  { pattern: ['accounts', '*', 'calls', 'turn_keys', '*', 'token'], reason: 'regenerates a Calls TURN key and answers it' },
  { pattern: ['accounts', '*', 'pages', 'projects', '*', 'upload-token'], methods: ['GET'], reason: 'a Pages Direct Upload JWT (it uploads to that project as the account)' },
  // Review: an answer that mints an upload credential. Static-asset uploads are a later job that keeps
  // that credential at the edge (developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/assets/subresources/upload/).
  { pattern: ['accounts', '*', 'workers', 'scripts', '*', 'assets-upload-session'], reason: 'answers a Worker assets upload JWT (`jwt`)', next: 'assets' },
  { pattern: ['accounts', '*', 'workers', 'dispatch', 'namespaces', '*', 'scripts', '*', 'assets-upload-session'], reason: 'answers a Workers for Platforms assets upload JWT (`jwt`)', next: 'assets' },
  { pattern: ['accounts', '*', 'workers', 'assets', 'upload'], reason: 'answers an assets completion JWT, redeemed when a Worker version is made', next: 'assets' },
  // Job 5: an administrative override code (it switches a device's Zero Trust client off),
  // in both path spellings; a direct upload, whose answer `uploadURL` uploads without the account key.
  { pattern: ['accounts', '*', 'devices', 'registrations', '*', 'override_codes'], reason: 'device override codes (they disable the Zero Trust client)' },
  { pattern: ['accounts', '*', 'devices', '*', 'override_codes'], reason: 'device override codes, the legacy path' },
  { pattern: ['accounts', '*', 'images', 'v2', 'direct_upload'], reason: 'answers an Images upload URL that works without the account key' },
  { pattern: ['accounts', '*', 'images', 'v1', 'direct_upload'], reason: 'answers an Images upload URL that works without the account key' },
  { pattern: ['accounts', '*', 'stream', 'direct_upload'], reason: 'answers a Stream upload URL that works without the account key' },
  // Job 7: a payment setup intent, whose answer is its client secret
  // (developers.cloudflare.com/api/resources/accounts/subresources/client_secret/methods/create/).
  { pattern: ['accounts', '*', 'client-secret'], reason: 'creates a payment setup intent and answers its client secret' },
].map(entry => Object.freeze({ ...entry, pattern: Object.freeze(entry.pattern) })))

/** P2: writes that change who holds keys to the account. */
const WHO_HOLDS_KEYS = [
  [['user'], 'user'],
  [['user', 'tokens', '**'], 'keys'],
  [['accounts', '*', 'tokens', '**'], 'keys'],
  [['accounts', '*', 'members', '**'], 'members'],
  [['accounts', '*', 'iam', '**'], 'members'],
  [['memberships', '**'], 'members'],
  // Review (MUST): moving the account into an Organization gives its members implicit Super Administrator
  // access, and moving it out removes access that comes through the Organization (both spellings, and the Organization's
  // own accounts list); dashboard SSO routes the sign-in of every user of an email domain through an identity provider.
  [['accounts', '*', 'move'], 'members'],
  [['accounts', 'move'], 'members'],
  [['organizations', '*', 'accounts', '**'], 'members'],
  [['accounts', '*', 'sso_connectors', '**'], 'access'],
  [['accounts'], 'account'],
  [['accounts', '*'], 'account'],
  [['accounts', '*', 'access', '**'], 'access'],
  [['zones', '*', 'access', '**'], 'access'],
  // Review: an Organization member has implicit Super Administrator access to every account in it
  // (developers.cloudflare.com/fundamentals/organizations/for-enterprise/#implicit-access); its membership and access
  // writes are P2 by name. Every other /organizations write is `root-unclassified` (below).
  [['organizations', '*', 'members', '**'], 'members'],
  [['organizations', '*', 'invites', '**'], 'members'],
  [['organizations', '*', 'roles', '**'], 'members'],
  [['organizations', '*', 'iam', '**'], 'members'],
  [['organizations', '*', 'access', '**'], 'access'],
  // Job 4: the user's own Organization memberships (leaving one) are members too, not the user's record (C3 at every level).
  [['user', 'organizations', '**'], 'members'],
]
/** The API roots a write is classified under (turned around like the account level): any
 * other root is `root-unclassified`. POST /graphql is a read (above). */
const WRITE_ROOTS = ['zones', 'accounts', 'user', 'memberships']

/** R2 (C1 at every level): account- and user-wide switches, which act on every zone of the account or the user
 * without naming one. Account rulesets (collection, by id, by phase, rules, versions, entry points) and account lists
 * and their items run on every zone; account and user IP Access rules and account custom pages apply to every zone;
 * account DNS settings (DNS-only enforcement, views), account custom nameservers and secondary-DNS peers, TSIG keys and
 * ACLs decide how every zone resolves; account Logpush jobs and Workers observability destinations carry live request
 * data out. A Workers Builds trigger reaches a Worker by its tag (readable through an open GET) and deploys whatever its
 * deploy command builds, so it stays `live-worker`. */
const ACCOUNT_WIDE = [
  [['accounts', '*', 'rulesets', '**'], 'account-switch'],
  [['accounts', '*', 'rules', '**'], 'account-switch'],
  [['accounts', '*', 'firewall', '**'], 'account-switch'],
  [['user', 'firewall', '**'], 'account-switch'],
  [['accounts', '*', 'custom_pages', '**'], 'account-switch'],
  [['accounts', '*', 'dns_settings', '**'], 'account-switch'],
  [['accounts', '*', 'custom_ns', '**'], 'account-switch'],
  [['accounts', '*', 'secondary_dns', '**'], 'account-switch'],
  [['accounts', '*', 'logpush', '**'], 'account-switch'],
  [['accounts', '*', 'workers', 'observability', 'destinations', '**'], 'account-switch'],
  [['accounts', '*', 'builds', '**'], 'live-worker'],
]

/** Whether `run` (lower-cased segments, `*` any one) appears as consecutive segments anywhere in the path. */
function contains(segments, run) {
  for (let start = 0; start + run.length <= segments.length; start++) {
    if (run.every((part, index) => part === '*' || part === segments[start + index])) return true
  }
  return false
}

/** R5a (C3 at every level): the credential vocabulary. A write whose path carries one of these runs of segments
 * (anywhere, any case) changes a key, a secret, a certificate or who may sign in, whatever product it is under. ONE
 * table, each row with its reason word (the card's family) and why; cloudflare-door.test.mjs tests every row in three
 * spellings. From an outside review MUST 18 to 24 and the brief. Job 7:
 * `keys` is only what opens the account itself or who can sign in (API keys, a tunnel's run or management credential);
 * a secret, certificate or credential an application uses is `app-secret`. Job 7: a path segment is also split on
 * `-`, `_` and `.` and each word is read against the one-segment rows (singular too: `client-secret` reads `secrets`). */
export const CLOUDFLARE_CREDENTIAL_VOCABULARY = Object.freeze([
  { run: ['secrets'], reason: 'app-secret', why: 'Worker, service, environment and dispatch secrets (and their bulk forms)' },
  { run: ['secrets_store'], reason: 'app-secret', why: 'the account Secrets Store: its stores and secrets' },
  { run: ['keys'], reason: 'app-secret', why: 'signing and API keys of any product (Stream keys, Images keys, Access keys)' },
  { run: ['turn_keys'], reason: 'app-secret', why: 'Calls TURN keys' },
  { run: ['credentials'], reason: 'app-secret', why: 'credentials of any product (JWT validation keys, R2 and tunnel credentials)' },
  { run: ['tokens'], reason: 'keys', why: 'API tokens of the user or the account' },
  { run: ['token'], reason: 'keys', why: 'a tunnel, connector or TURN key run credential' },
  { run: ['token_validation'], reason: 'app-secret', why: 'trusted JWT keys and the rules that enforce them (API Shield)' },
  { run: ['certificates'], reason: 'app-secret', why: 'Origin CA certificates (the /certificates root) and certificates elsewhere' },
  { run: ['client_certificates'], reason: 'app-secret', why: 'mTLS client certificates issued, revoked or reactivated' },
  { run: ['mtls_certificates'], reason: 'app-secret', why: 'account mTLS certificates (they carry a private key)' },
  { run: ['origin_tls_client_auth'], reason: 'app-secret', why: 'authenticated origin pulls: the trust between the edge and an origin' },
  { run: ['hyperdrive'], reason: 'app-secret', why: 'Hyperdrive configs carry a database password' },
  { run: ['challenges', 'widgets'], reason: 'app-secret', why: 'Turnstile widgets: their secret and the domains it works on' },
  { run: ['calls', 'apps'], reason: 'app-secret', why: 'Calls apps: making one makes its secret' },
  { run: ['stream', 'live_inputs'], methods: ['POST'], reason: 'app-secret', why: 'a new Stream live input answers its stream key' },
  { run: ['cfd_tunnel', '*', 'management'], reason: 'keys', why: 'a tunnel management credential' },
  { run: ['scim'], reason: 'members', why: 'dashboard SCIM provisioning and deprovisioning of users and groups' },
  { run: ['invites'], reason: 'members', why: 'invitations of the user, the account or an Organization' },
  { run: ['members'], reason: 'members', why: 'members of anything' },
  { run: ['roles'], reason: 'members', why: 'roles of anything' },
  { run: ['sso_connectors'], reason: 'access', why: 'dashboard SSO: how everyone with an email domain signs in' },
  { run: ['devices'], reason: 'access', why: 'Zero Trust devices: registrations, revocation, posture and settings' },
  { run: ['gateway', 'configuration'], reason: 'access', why: 'Zero Trust Gateway security settings' },
  { run: ['gateway', 'logging'], reason: 'access', why: 'Zero Trust Gateway logging (what is recorded, and redaction)' },
].map(entry => Object.freeze({ ...entry, run: Object.freeze(entry.run) })))

/** Job 7: the singular words a segment's word is read as the plural row for (`client-secret`, `api-key`); other
 * singulars (`certificate_packs`, an edge certificate Cloudflare manages) are not. */
const CREDENTIAL_SINGULARS = Object.freeze(['secret', 'key', 'credential'])

/** C5: anything that commits the owner to a charge. His standing rule: nobody but him buys anything. A write
 * whose path carries one of these runs (anywhere, any case; the first match names the reason). Metered use (a model
 * run, a stored object) is NOT held: a limit of this door, said in docs/auma/cloudflare-door.md. */
export const CLOUDFLARE_CHARGES = Object.freeze([
  { run: ['bulk', 'subscriptions'], reason: 'paid-subscription-bulk', why: 'several paid subscriptions at once' },
  { run: ['subscriptions', '*', 'action'], reason: 'paid-subscription-action', why: 'a subscription action (append a plan)' },
  { run: ['subscriptions', 'cancel-downgrade'], reason: 'paid-subscription-action', why: 'cancelling a downgrade keeps a paid plan' },
  { run: ['subscriptions'], reason: 'paid-subscription', why: 'a paid plan of the account, a zone or the user' },
  { run: ['subscription'], reason: 'paid-subscription', why: 'a zone\'s paid plan' },
  { run: ['registrar', 'registrations'], end: true, methods: ['POST'], reason: 'registrar-purchase', why: 'registering a domain charges for it' },
  { run: ['transfer-in'], under: 'registrar', reason: 'registrar-transfer', why: 'a domain transfer in (priced by its extension)' },
  { run: ['transfer-out'], under: 'registrar', reason: 'registrar-transfer', why: 'a domain transfer out' },
  { run: ['transfers'], under: 'registrar', reason: 'registrar-transfer', why: 'domain transfers' },
  { run: ['registrar'], reason: 'registrar-renewal', why: 'a registered domain\'s renewal and settings (auto-renew authorises a later charge)' },
  { run: ['pay-invoice'], reason: 'billing-payment', why: 'paying an invoice' },
  { run: ['pay-bad-debt'], reason: 'billing-payment', why: 'paying an outstanding debt' },
  { run: ['topup'], reason: 'credit-purchase', why: 'buying credit (one top-up or an automatic one)' },
  { run: ['billing'], reason: 'billing', why: 'anything under a billing family' },
  { run: ['argo', 'smart_routing'], reason: 'paid-routing-enable', why: 'Argo Smart Routing is billed by use once on' },
  { run: ['cache', 'cache_reserve'], reason: 'paid-storage-enable', why: 'Cache Reserve is billed storage once on' },
  { run: ['ssl', 'certificate_packs', 'order'], reason: 'paid-certificate-order', why: 'an advanced certificate order (Advanced Certificate Manager)' },
].map(entry => Object.freeze({ ...entry, run: Object.freeze(entry.run) })))

/** The first row of a table whose run is in the path (and whose method, `end` and `under` conditions hold), or undefined. */
function rowFor(table, segments, method) {
  return table.find(row => (!row.methods || row.methods.includes(method)) && (!row.under || segments.includes(row.under))
    && (row.end ? matches(segments.slice(-row.run.length), row.run) : contains(segments, row.run)))
}

const REFERENCE = 'https://developers.cloudflare.com/api/resources/'
/** The account level, turned around: a write under
 * `/accounts/{account}/<family>/…` is OPEN only when its family (and, where named, its sub-family) is on this closed
 * list of self-contained resource families; every other account-level write asks for the owner's fingerprint as
 * `account-wide-unclassified`. Each entry says why it cannot change what serves the live host, who holds keys, or
 * account-wide traffic, and which reference page was read (developers.cloudflare.com, 2026-11-13). The P1 name rules
 * (the live Worker, the live host, its bound storage), the id lookups and the credential paths run BEFORE this list. */
export const CLOUDFLARE_ACCOUNT_OPEN = Object.freeze([
  { family: 'workers', sub: 'scripts', reason: 'one Worker script by name; your-node, the live host and her bound storage are P1 by name in the path, query and body', reference: REFERENCE + 'workers/subresources/scripts/methods/update/' },
  { family: 'workers', sub: 'workers', reason: 'one Worker by id; the edge looks the id up and the live Worker stays P1', reference: REFERENCE + 'workers/subresources/beta/subresources/workers/methods/create/' },
  { family: 'workers', sub: 'domains', reason: 'a Worker custom domain; a hostname that is or can match the live host, one serving the live Worker, or one on the live zone (by host, zone id or zone name) stays P1 (by body and by id)', reference: REFERENCE + 'workers/subresources/domains/methods/update/' },
  { family: 'workers', sub: 'observability', reason: 'telemetry queries over Workers logs: reads sent as POST (its destinations, which send live request data out, are an account switch and ask)', reference: REFERENCE + 'workers/subresources/observability/subresources/telemetry/methods/query/' },
  { family: 'storage', sub: 'kv', reason: 'KV namespaces and their keys; the live Worker binds no KV', reference: REFERENCE + 'kv/subresources/namespaces/methods/create/' },
  { family: 'r2', sub: 'buckets', reason: 'R2 buckets by name; the bound bucket your-node-archive is P1 by name, a custom domain on the live zone is P1 (by host or zone id), and R2 access keys are a credential path', reference: REFERENCE + 'r2/subresources/buckets/methods/create/' },
  { family: 'd1', sub: 'database', reason: 'D1 databases; the live Worker binds none', reference: REFERENCE + 'd1/subresources/database/methods/create/' },
  { family: 'queues', reason: 'queues and their messages; a consumer naming your-node is P1 by name', reference: REFERENCE + 'queues/methods/create/' },
  { family: 'pages', sub: 'projects', reason: 'Pages projects and deployments; a custom domain that is or can match a live host is P1 by name, and the upload pass is a credential path', reference: REFERENCE + 'pages/subresources/projects/methods/create/' },
  { family: 'vectorize', reason: 'Vectorize indexes and vectors', reference: REFERENCE + 'vectorize/subresources/indexes/methods/create/' },
  { family: 'ai', reason: 'Workers AI model runs and fine-tunes; nothing that routes traffic', reference: REFERENCE + 'ai/methods/run/' },
  // Job 5: Hyperdrive and Calls apps and TURN keys left this list (every write of theirs is in the credential vocabulary,
  // C3), and so did the registrar (C5, a charge).
  { family: 'stream', reason: 'Stream videos, webhooks and watermarks; signing keys and a new live input (its stream key) are C3, a direct upload is refused, a stream key in an answer is withheld', reference: REFERENCE + 'stream/methods/create/' },
  { family: 'images', reason: 'Cloudflare Images and variants; signing keys and direct uploads are credential paths', reference: REFERENCE + 'images/subresources/v1/methods/create/' },
  { family: 'analytics_engine', sub: 'sql', reason: 'Workers Analytics Engine SQL: a read sent as POST', reference: 'https://developers.cloudflare.com/analytics/analytics-engine/sql-api/' },
].map(Object.freeze))

/** Whether lower-cased path segments match a pattern (`*` one segment, a trailing `**` zero or more). */
function matches(segments, pattern) {
  for (let index = 0; index < pattern.length; index++) {
    if (pattern[index] === '**') return true
    if (index >= segments.length || (pattern[index] !== '*' && pattern[index] !== segments[index])) return false
  }
  return segments.length === pattern.length
}

/** Parse her path: the segments as written, or null when any part of it is refused. */
function parsePath(path) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.length > CLOUDFLARE_DOOR_LIMITS.pathChars) return null
  const segments = path.slice(1).split('/')
  return segments.every(part => part === '{account}' || (SEGMENT.test(part) && !/^\.+$/.test(part))) ? segments : null
}

/**
 * A text as every reader of it may see it, for the name match: as written, and with its string escapes decoded (JSON and
 * JavaScript \uXXXX, \u{X}, \xXX; TOML and Python \UXXXXXXXX). Its JSON reading is in the views (requestViews). Only ever
 * adds strings: never loosens a match.
 */
function readable(text) {
  const decoded = text.replace(/\\(?:u\{([0-9a-fA-F]{1,6})\}|u([0-9a-fA-F]{4})|U([0-9a-fA-F]{8})|x([0-9a-fA-F]{2}))/g, (whole, ...hex) => {
    const point = parseInt(hex.slice(0, 4).find(value => value !== undefined), 16)
    return point <= 0x10ffff ? String.fromCodePoint(point) : whole
  })
  return decoded === text ? [text] : [text, decoded]
}

const escape = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i
const TOKEN_SPLIT = /[\s,;"'`()<>[\]{}|=]+/

/**
 * A host name or host pattern as every live-host comparison reads it (R7a): Unicode NFKC, lower case,
 * a scheme and a route's path dropped, IDNA to ASCII by the platform's URL parser (which also maps the ideographic full
 * stop and drops a soft hyphen), trailing dots removed. A `*` stays a wildcard.
 *
 * An `xn--` label is not left to the platform alone (2026-11-14): the parsers disagree about ill-formed Punycode (Node
 * 24.11 refuses `xn--zz`, Node 24.22 on the hosted runners returns it unchanged), and the edge runs on a third one. So
 * each such label is decoded here (RFC 3492) and must come back byte for byte when the platform encodes the decoded
 * name: a label that is not the one ASCII form of a real name cannot be read, on every runtime.
 * @param {unknown} value A host name, a route pattern or a URL.
 * @returns {string | null} The ASCII host (or pattern), or null when it cannot be read as a host name.
 */
export function normalHost(value) {
  if (typeof value !== 'string' || value.length > 1024) return null
  const text = value.normalize('NFKC').toLowerCase().replace(SCHEME, '').split(/[/?#\\]/)[0]
  if (!text) return null
  let host
  try { host = new URL('http://' + text + '/').hostname } catch { return null }
  host = host.replace(/\.+$/, '')
  if (!host) return null
  for (const label of host.split('.')) {
    if (!label.startsWith('xn--')) continue
    const points = punycodePoints(label.slice(4))
    if (points === null || points.length === 0) return null
    let back
    try { back = new URL('http://' + String.fromCodePoint(...points) + '.invalid/').hostname } catch { return null }
    if (back !== label + '.invalid') return null
  }
  return host
}

/**
 * The code points one Punycode label stands for (RFC 3492 section 6.2, the part after `xn--`, already lower case).
 * @param {string} input The label without its `xn--` prefix.
 * @returns {number[] | null} The decoded code points, or null when the input is not well-formed Punycode.
 */
function punycodePoints(input) {
  const cut = input.lastIndexOf('-')
  const points = []
  for (let at = 0; at < cut; at++) {
    const basic = input.charCodeAt(at)
    if (basic >= 0x80) return null
    points.push(basic)
  }
  let n = 128, bias = 72, i = 0, at = cut > 0 ? cut + 1 : 0
  while (at < input.length) {
    const before = i
    for (let w = 1, k = 36; ; k += 36) {
      if (at >= input.length) return null
      const unit = input.charCodeAt(at++)
      const digit = unit >= 0x61 && unit <= 0x7a ? unit - 0x61 : unit >= 0x30 && unit <= 0x39 ? unit - 0x30 + 26 : -1
      if (digit < 0) return null
      i += digit * w
      if (i > 0x7fffffff) return null
      const t = k <= bias ? 1 : k >= bias + 26 ? 26 : k - bias
      if (digit < t) break
      w *= 36 - t
      if (w > 0x7fffffff) return null
    }
    const count = points.length + 1
    let delta = Math.floor((i - before) / (before === 0 ? 700 : 2))
    delta += Math.floor(delta / count)
    let k = 0
    for (; delta > 455; k += 36) delta = Math.floor(delta / 35)
    bias = k + Math.floor(36 * delta / (delta + 38))
    n += Math.floor(i / count)
    if (n > 0x10ffff) return null
    i %= count
    points.splice(i++, 0, n)
  }
  return points
}

/** Whether a host or host pattern (`*` matches anything) is, covers, or cannot be read against a live host. */
function coverage(pattern, hosts) {
  if (typeof pattern !== 'string') return 'other'
  const host = normalHost(pattern)
  if (host === null) return 'unreadable'
  const glob = new RegExp('^' + host.split('*').map(escape).join('.*') + '$')
  return hosts.some(live => glob.test(live)) ? 'live' : 'other'
}
const covers = (pattern, hosts) => coverage(pattern, hosts) === 'live'

/** The P1 reasons the strings give: the live host by name or by a wildcard
 * that covers it; the Worker; its storage. Each string is read as written and in NFKC form; a token that only the URL
 * parser reads as a host (not plain ASCII, or percent-escaped) is read through `normalHost`. Only ever adds matches. */
function nameReasons(strings, live, hosts) {
  const hostNames = hosts.map(host => new RegExp(`(?<![a-z0-9.-])${escape(host)}(?![a-z0-9-]|\\.[a-z0-9])`, 'i'))
  const name = value => new RegExp(`(?<![a-z0-9_-])${escape(value)}(?![a-z0-9_-])`, 'i')
  const worker = name(live.worker), storage = live.storage.map(item => name(item.name))
  const found = new Set()
  for (const raw of strings) {
    const folded = raw.normalize('NFKC')
    for (const text of folded === raw ? [raw] : [raw, folded]) {
      if (hostNames.some(pattern => pattern.test(text))) found.add('live-host')
      // A wildcard host pattern anywhere (a route, a DNS name, a rule) that covers the live host; a bare `*` is judged only
      // where it is a name on the live zone, below.
      if (text.includes('*')) {
        for (const token of text.split(TOKEN_SPLIT)) {
          if (!token.includes('*')) continue
          const host = normalHost(token)
          if (host !== null && host.includes('.') && covers(host, hosts)) found.add('live-host')
        }
      }
      if (storage.some(pattern => pattern.test(text))) found.add('bound-storage')
      if (worker.test(text)) found.add('live-worker')
    }
    if (/[^\x21-\x7e\s]|%/.test(folded)) {
      for (const token of folded.split(TOKEN_SPLIT)) {
        if (!/[^\x21-\x7e]|%/.test(token)) continue
        const host = normalHost(token)
        if (host !== null && host.includes('.') && covers(host, hosts)) found.add('live-host')
      }
    }
  }
  return found
}

/** A DNS record name as Cloudflare reads it on a zone: `@` is the apex, a name not ending in the zone is relative; null
 * when it cannot be read as a host name. */
function dnsName(name, zone) {
  if (name.normalize('NFKC').trim() === '@') return zone
  const value = normalHost(name)
  if (value === null) return null
  return value === zone || value.endsWith('.' + zone) ? value : value + '.' + zone
}
const dnsNames = body => (Array.isArray(body) ? body : [body]).filter(record).map(item => item.name).filter(name => typeof name === 'string')

/** A text as JSON, or undefined when it does not parse (a leading byte-order mark is ignored, as JSON readers do). */
function jsonOf(text) {
  if (typeof text !== 'string') return undefined
  try { return JSON.parse(text.replace(/^\uFEFF/, '')) } catch { return undefined }
}

/** Whether a zone name (as a lookup or a body gives it) is the zone of a live host: the R1 test. */
function liveZoneName(name, hosts) {
  const zone = normalHost(String(name)) ?? String(name).toLowerCase().replace(/\.+$/, '')
  return hosts.some(host => host === zone || host.endsWith('.' + zone))
}

/** Every run of 32 or more hex digits the strings carry (NFKC, dashes ignored, lower case): what could be a Cloudflare id. */
function idRuns(strings) {
  const out = new Set()
  for (const text of strings) for (const run of text.normalize('NFKC').replace(/-/g, '').toLowerCase().match(/[0-9a-f]{32,}/g) ?? []) out.add(run)
  return [...out]
}

/**
 * The ids of her live home's bound storage, from Cloudflare's answer to GET /accounts/{account}/workers/durable_objects/namespaces
 * (developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/methods/list/). Pure. Null when the answer
 * cannot be trusted whole: not a success, more than one page, an id that is not 32 hex, or a Durable Object class the live
 * Worker binds (CLOUDFLARE_LIVE_HOME.storage) missing from it.
 * @param {unknown} answer The parsed answer.
 * @returns {string[] | null} The lower-cased namespace ids whose script is the live Worker, or null.
 */
export function boundStorageIds(answer) {
  if (!record(answer) || answer.success !== true || !Array.isArray(answer.result)) return null
  const info = answer.result_info
  if (record(info) && ((Number.isFinite(info.total_pages) && info.total_pages > 1) || (Number.isFinite(info.total_count) && info.total_count > answer.result.length))) return null
  const mine = answer.result.filter(item => record(item) && typeof item.script === 'string' && item.script.toLowerCase() === CLOUDFLARE_LIVE_HOME.worker)
  if (!mine.every(item => typeof item.id === 'string' && /^[0-9a-f]{32}$/i.test(item.id))) return null
  const classes = new Set(mine.map(item => String(item.class ?? '').toLowerCase()))
  const bound = CLOUDFLARE_LIVE_HOME.storage.filter(item => item.kind === 'durable_object_class')
  if (!bound.every(item => classes.has(item.name.toLowerCase()))) return null
  return mine.map(item => item.id.toLowerCase())
}

/**
 * Job 7: every binding type the Worker binding schema carries
 * (developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/settings/methods/get/), with the
 * members that identify what it reaches. `required` lists the identifying members (an inner list: any one of them); a
 * binding of a type here without them makes the inventory unresolved. `workers`, `dispatch`, `workflows`, `queues` and
 * `storage` say where each identifier goes. A dotted member is read inside the binding (`outbound.worker.service`).
 */
export const CLOUDFLARE_BINDING_TYPES = Object.freeze({
  service: { required: ['service'], workers: ['service'] },
  dispatch_namespace: { required: ['namespace'], dispatch: ['namespace'], workers: ['outbound.worker.service'] },
  durable_object_namespace: { required: ['class_name'], workers: ['script_name'], storage: ['namespace_id'], dispatch: ['dispatch_namespace'] },
  workflow: { required: ['workflow_name'], workflows: ['workflow_name'], workers: ['script_name'] },
  queue: { required: ['queue_name'], queues: ['queue_name'], storage: ['queue_name'] },
  kv_namespace: { required: ['namespace_id'], storage: ['namespace_id'] },
  d1: { required: [['id', 'database_id']], storage: ['id', 'database_id'] },
  r2_bucket: { required: ['bucket_name'], storage: ['bucket_name'] },
  hyperdrive: { required: ['id'], storage: ['id'] },
  vectorize: { required: ['index_name'], storage: ['index_name'] },
  analytics_engine: { required: ['dataset'], storage: ['dataset'] },
  mtls_certificate: { required: ['certificate_id'], storage: ['certificate_id'] },
  secrets_store_secret: { required: ['store_id', 'secret_name'], storage: ['store_id', 'secret_name'] },
  pipelines: { required: ['pipeline'], storage: ['pipeline'] },
})
/** Job 7: binding types that carry no identifier of another resource (a model, a browser, the static assets, a value). */
export const CLOUDFLARE_BINDING_PLAIN = Object.freeze(['ai', 'browser', 'images', 'version_metadata', 'assets', 'plain_text', 'secret_text', 'json',
  'inherit', 'send_email', 'secret_key', 'wasm_module', 'text_blob', 'data_blob'])

/**
 * R3 and C2: what the live Worker is made of, from Cloudflare's answer to GET
 * /accounts/{account}/workers/scripts/your-node/settings. Pure. Null when the answer cannot be understood whole: not a
 * success, `bindings` not a list, a binding or tail consumer that is not an object, a binding type this door does not
 * know, or a known type without its identifying member (an inventory is never "empty" because it was not understood).
 * @param {unknown} answer The parsed answer.
 * @returns {{ workers: string[], dispatch: string[], workflows: string[], queues: string[], storage: string[],
 *   durableObjects: { className: string, script: string }[] } | null} Lower-cased: the other Workers it calls or sends its
 *   tail to, the dispatch namespaces, workflows and queues it binds, the identifier of every store it binds (3 characters
 *   or more), and each Durable Object class it binds on its own or another script (for the namespace list).
 */
export function liveWorkerFacts(answer) {
  if (!record(answer) || answer.success !== true || !record(answer.result) || !Array.isArray(answer.result.bindings)) return null
  const bindings = answer.result.bindings, tails = answer.result.tail_consumers ?? []
  if (!Array.isArray(tails) || !bindings.every(record) || !tails.every(record)) return null
  const word = value => (typeof value === 'string' && value.length >= 1 && value.length <= 256 ? value.normalize('NFKC').toLowerCase() : null)
  const member = (binding, path) => path.split('.').reduce((item, key) => (record(item) ? item[key] : undefined), binding)
  const out = { workers: new Set(), dispatch: new Set(), workflows: new Set(), queues: new Set(), storage: new Set() }
  const durableObjects = []
  for (const tail of tails) {
    if (!word(tail.service)) return null
    out.workers.add(word(tail.service))
  }
  for (const binding of bindings) {
    const type = typeof binding.type === 'string' ? binding.type.toLowerCase() : null
    if (type === null) return null
    if (CLOUDFLARE_BINDING_PLAIN.includes(type)) continue
    const shape = Object.hasOwn(CLOUDFLARE_BINDING_TYPES, type) ? CLOUDFLARE_BINDING_TYPES[type] : null
    if (shape === null) return null
    if (!shape.required.every(need => (Array.isArray(need) ? need : [need]).some(key => word(member(binding, key)) !== null))) return null
    for (const kind of ['workers', 'dispatch', 'workflows', 'queues', 'storage']) {
      for (const key of shape[kind] ?? []) {
        const value = word(member(binding, key))
        if (value !== null && (kind !== 'storage' || value.length >= 3)) out[kind].add(value)
      }
    }
    if (type === 'durable_object_namespace' && word(binding.dispatch_namespace) === null) {
      durableObjects.push({ className: word(binding.class_name), script: word(binding.script_name) ?? CLOUDFLARE_LIVE_HOME.worker })
    }
  }
  out.workers.delete(CLOUDFLARE_LIVE_HOME.worker)
  return { workers: [...out.workers], dispatch: [...out.dispatch], workflows: [...out.workflows], queues: [...out.queues], storage: [...out.storage], durableObjects }
}

/**
 * Job 7: the Durable Object namespace ids the live Worker binds, from this request's
 * own read of the namespace list (never a kept one) and its own read of the settings: every namespace whose script is
 * the live Worker (boundStorageIds), and the namespace of each class the settings bind on another script. Null when the
 * list cannot be trusted whole, or a class the settings bind on the live Worker itself is missing from it.
 * @param {unknown} answer The parsed namespace list.
 * @param {ReturnType<typeof liveWorkerFacts>} known The live Worker's facts (null: only the list is used).
 * @returns {string[] | null} Lower-cased ids, or null.
 */
export function liveDurableObjectIds(answer, known) {
  const ids = boundStorageIds(answer)
  if (ids === null || !record(known)) return ids
  const out = new Set(ids)
  for (const item of known.durableObjects) {
    const found = answer.result.filter(entry => record(entry) && String(entry.script ?? '').toLowerCase() === item.script && String(entry.class ?? '').toLowerCase() === item.className)
    if (found.length === 0 && item.script === CLOUDFLARE_LIVE_HOME.worker) return null
    for (const entry of found) {
      if (typeof entry.id !== 'string' || !/^[0-9a-f]{32}$/i.test(entry.id)) return null
      out.add(entry.id.toLowerCase())
    }
  }
  return [...out]
}

const partRefused = next => ({ refused: refused('CLOUDFLARE_REQUEST_INVALID', 400, next) })
const plainName = name => typeof name === 'string' && name.length <= 256 && PART_NAME.test(name) && name.split('/').every(part => !/^\.+$/.test(part))
/**
 * Build a multipart/form-data body from her text and json parts, with the edge's own boundary: the first
 * `aukora-cfdoor-<n>` that occurs in no part. Pure and deterministic, so the bytes she staged are the bytes that go.
 * @param {unknown} parts Her parts: 1 to 16 of { name, filename?, contentType, text | json }.
 * @returns {{ body: string, contentType: string } | { refused: object }} The body, or the refusal.
 */
function multipartBody(parts) {
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > CLOUDFLARE_DOOR_LIMITS.multipartParts) return partRefused(CLOUDFLARE_NEXT.parts)
  const ready = [], names = new Set()
  for (const part of parts) {
    if (!record(part) || Object.keys(part).some(key => !PART_KEYS.includes(key))) return partRefused(CLOUDFLARE_NEXT.parts)
    if (typeof part.contentType === 'string' && BINARY_TYPE.test(part.contentType)) return { refused: refused('CLOUDFLARE_BODY_KIND_UNSUPPORTED', 400, CLOUDFLARE_NEXT.binary) }
    if (!plainName(part.name) || names.has(part.name) || (part.filename !== undefined && !plainName(part.filename))) return partRefused(CLOUDFLARE_NEXT.parts)
    if (!PART_TYPES.includes(part.contentType) || (part.text === undefined) === (part.json === undefined)) return partRefused(CLOUDFLARE_NEXT.parts)
    let data
    if (part.json !== undefined) {
      if (part.contentType !== 'application/json' || !(record(part.json) || Array.isArray(part.json))) return partRefused(CLOUDFLARE_NEXT.parts)
      // Review: the canonical serialization the approval covers, so key order changes no byte that goes.
      data = canonicalJson(part.json)
    } else if (typeof part.text === 'string') data = part.text
    else return partRefused(CLOUDFLARE_NEXT.parts)
    names.add(part.name)
    ready.push({ name: part.name, filename: part.filename, contentType: part.contentType, data })
  }
  let boundary
  for (let index = 0; boundary === undefined; index++) {
    const candidate = 'aukora-cfdoor-' + index.toString(36).padStart(8, '0')
    if (!ready.some(part => part.data.includes(candidate))) boundary = candidate
  }
  const body = ready.map(part => `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${part.filename === undefined ? '' : `; filename="${part.filename}"`}`
    + `\r\nContent-Type: ${part.contentType}\r\n\r\n${part.data}\r\n`).join('') + `--${boundary}--\r\n`
  if (new TextEncoder().encode(body).byteLength > CLOUDFLARE_DOOR_LIMITS.multipartBytes) return { refused: refused('CLOUDFLARE_BODY_TOO_LARGE', 413, CLOUDFLARE_NEXT.size) }
  return { body, contentType: 'multipart/form-data; boundary=' + boundary }
}

/** Job 7: the primary reason is chosen by family (P3 deletion, P4 a charge, P2 keys and secrets, P1
 * the live home, then account-wide-unclassified); inside one family a reason that names the target beats one that says
 * the edge could not check; then ascending by code. Every other reason that matched goes into `also` (at most 8, sorted
 * by family then reason in plain code-unit order). */
const FAMILY_RANK = Object.freeze({ P3: 0, P4: 1, P2: 2, P1: 3, 'account-wide-unclassified': 4 })
const unchecked = reason => reason.endsWith('-unresolved') || reason === 'inspection-limit' || reason === 'host-unreadable'
const textOrder = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const precedence = (a, b) => FAMILY_RANK[a.family] - FAMILY_RANK[b.family] || Number(unchecked(a.reason)) - Number(unchecked(b.reason)) || textOrder(a.reason, b.reason)
const plainOrder = (a, b) => textOrder(a.family, b.family) || textOrder(a.reason, b.reason)
export const CLOUDFLARE_ALSO_MAX = 8

/**
 * The protection object for every (family, reason) that matched.
 * @param {{ family: string, reason: string, apiFamily?: string }[]} pairs At least one; one per reason.
 * @returns {{ family: string, reason: string, apiFamily?: string, also?: { family: string, reason: string }[] }}
 */
export function cloudflareProtectionOf(pairs) {
  const sorted = [...pairs].sort(precedence), primary = sorted[0]
  const also = sorted.slice(1, 1 + CLOUDFLARE_ALSO_MAX).sort(plainOrder).map(({ family, reason }) => Object.freeze({ family, reason }))
  return Object.freeze({ family: primary.family, reason: primary.reason,
    ...(primary.family === 'account-wide-unclassified' && typeof primary.apiFamily === 'string' && CLOUDFLARE_API_FAMILY.test(primary.apiFamily) ? { apiFamily: primary.apiFamily } : {}),
    ...(also.length > 0 ? { also: Object.freeze(also) } : {}) })
}

const REASON = /^[a-z-]{1,40}$/
/**
 * A protection object exactly as the door's contract allows it, or null: the family and reason, `apiFamily` only with
 * `account-wide-unclassified` (dropped when it is not a family name), and `also` of 1 to 8 pairs with exactly a family and
 * a reason each, sorted, without duplicates and without the primary pair. Any other `also` makes the whole object null.
 * @param {unknown} value A protection object from anywhere.
 * @returns {object | null} A fresh object with only those members, or null.
 */
export function cloudflareProtectionShape(value) {
  if (!record(value) || !CLOUDFLARE_PROTECTED_FAMILIES.includes(value.family) || typeof value.reason !== 'string' || !REASON.test(value.reason)) return null
  const apiFamily = value.family === 'account-wide-unclassified' && typeof value.apiFamily === 'string' && CLOUDFLARE_API_FAMILY.test(value.apiFamily) ? value.apiFamily : null
  let also = null
  if (value.also !== undefined) {
    const list = value.also
    if (!Array.isArray(list) || list.length < 1 || list.length > CLOUDFLARE_ALSO_MAX) return null
    for (const [index, item] of list.entries()) {
      if (!record(item) || Object.keys(item).length !== 2 || !CLOUDFLARE_PROTECTED_FAMILIES.includes(item.family) || typeof item.reason !== 'string' || !REASON.test(item.reason)) return null
      if (item.family === value.family && item.reason === value.reason) return null
      if (index > 0 && plainOrder(list[index - 1], item) >= 0) return null
    }
    also = list.map(item => ({ family: item.family, reason: item.reason }))
  }
  return { family: value.family, reason: value.reason, ...(apiFamily !== null ? { apiFamily } : {}), ...(also !== null ? { also } : {}) }
}

/** A string that is itself a JSON object or array, parsed; undefined otherwise. */
const innerJson = text => {
  if (!/^\s*[[{]/.test(text)) return undefined
  const value = jsonOf(text)
  return value !== null && typeof value === 'object' ? value : undefined
}

/**
 * Job 7, decision A: the one set of views of a request, built once and read by every rule. `strings`: every string the
 * query and body carry (object keys, multipart part names and file names, a text's decoded escapes, too); `fields`: every
 * (field name, value) pair at any depth (query parameters and multipart parts are fields too); `objects`: every JSON
 * object; `documents`: the top-level JSON documents (the JSON body, a text body or text part that parses, a json part).
 * Every representation is read: JSON; a string that itself parses as a JSON object or array, layer after layer up to
 * CLOUDFLARE_DOOR_LIMITS.viewLayers; multipart parts; text; NDJSON lines. `limited`: something was left unread (a layer
 * deeper than the limit, or more than CLOUDFLARE_DOOR_LIMITS.viewNodes values), so the request is held, never passed.
 */
function requestViews(input, bodyKind) {
  const strings = [], fields = [], objects = [], documents = []
  let nodes = 0, limited = false
  const walk = (value, layer) => {
    const stack = [[value, layer]]
    while (stack.length > 0) {
      const [item, depth] = stack.pop()
      if (++nodes > CLOUDFLARE_DOOR_LIMITS.viewNodes) { limited = true; return }
      if (typeof item === 'string') {
        strings.push(item)
        const inner = innerJson(item)
        if (inner !== undefined) {
          if (depth >= CLOUDFLARE_DOOR_LIMITS.viewLayers) limited = true
          else stack.push([inner, depth + 1])
        }
      } else if (Array.isArray(item)) {
        for (const child of item) stack.push([child, depth])
      } else if (record(item)) {
        objects.push(item)
        for (const [key, child] of Object.entries(item)) { strings.push(key); fields.push([key, child]); stack.push([child, depth]) }
      }
    }
  }
  const text = value => {
    strings.push(...readable(value))
    const whole = jsonOf(value)
    if (whole !== undefined) {
      if (whole !== null && typeof whole === 'object') documents.push(whole)
      walk(whole, 0)
      return
    }
    for (const line of value.split(/\r?\n/)) {
      if (!/^\s*[[{"]/.test(line)) continue
      const item = jsonOf(line)
      if (item !== undefined) walk(item, 0)
    }
  }
  if (record(input.query)) {
    for (const [key, value] of Object.entries(input.query)) { strings.push(key); fields.push([key, value]); walk(value, 0) }
  }
  if (bodyKind === 'multipart') {
    for (const part of input.parts) {
      strings.push(part.name, ...(typeof part.filename === 'string' ? [part.filename] : []))
      fields.push([part.name, part.json ?? part.text])
      if (part.json !== undefined) { documents.push(part.json); walk(part.json, 0) } else text(part.text)
    }
  } else if (typeof input.body === 'string') text(input.body)
  else if (input.body !== undefined) { documents.push(input.body); walk(input.body, 0) }
  return { strings, fields, objects, documents, limited }
}

/** Job 8: the longest host name (RFC 1035): no live host is longer, so a name that runs further left is not one. */
const HOST_NAME_MAX = 253
const hostChar = code => (code >= 97 && code <= 122) || (code >= 65 && code <= 90) || (code >= 48 && code <= 57) || code === 45
/** Job 8: where the host name that ends with the zone name at `zoneStart` begins: the labels (`[a-z0-9-]+.`) right before
 * it, as many as there are; -1 when they run more than HOST_NAME_MAX characters to the left (not a host name a live host
 * can be). Never reads further left than that, so every zone name costs at most HOST_NAME_MAX steps. */
function hostStart(value, zoneStart) {
  let start = zoneStart
  while (start > 0 && value.charCodeAt(start - 1) === 46) {
    let label = start - 1
    while (label > 0 && hostChar(value.charCodeAt(label - 1))) {
      label--
      if (zoneStart - label > HOST_NAME_MAX) return -1
    }
    if (label === start - 1) break
    start = label
  }
  return start
}

/** Job 7: whether any string names a host on a live zone other than the live host itself (which `live-host`
 * names): the zone name bounded on the left by the start, a dot or a character that cannot be part of a host name, and on
 * the right by the end (a final dot allowed) or such a character. Job 8: the zone name is found first, then the labels
 * before it are read leftwards for at most HOST_NAME_MAX characters (the single regular expression it replaces read every
 * run of labels from every starting point: quadratic time on a long run of `a.`); the answer is the same for every text. */
function onLiveZoneIn(strings, zoneNames, liveHosts) {
  if (zoneNames.length === 0) return false
  const pattern = new RegExp(`(?<![a-z0-9-])(?:${zoneNames.map(escape).join('|')})(?=\\.?(?:$|[^a-z0-9.-]))`, 'gi')
  for (const raw of strings) {
    const folded = raw.normalize('NFKC')
    for (const value of folded === raw ? [raw] : [raw, folded]) {
      for (const match of value.matchAll(pattern)) {
        const start = hostStart(value, match.index)
        if (start < 0 || !liveHosts.includes(value.slice(start, match.index + match[0].length).toLowerCase())) return true
      }
    }
  }
  return false
}

const WRITE_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE']
/** SHOULD 2: a JSON object in a body that is itself a Cloudflare request (a write method and a path or an API URL),
 * as her request shape; null for anything else. */
function nestedRequest(item) {
  if (typeof item.method !== 'string' || !WRITE_METHODS.includes(item.method.toUpperCase())) return null
  let path = null, query
  if (typeof item.path === 'string' && item.path.startsWith('/')) path = item.path
  else if (typeof item.url === 'string' && item.url.startsWith(CLOUDFLARE_API_ORIGIN + '/')) {
    let url
    try { url = new URL(item.url) } catch { return { action: 'api', method: item.method, path: item.url } }
    path = url.pathname.slice('/client/v4'.length)
    if (url.search) query = Object.fromEntries(url.searchParams)
  }
  if (path === null) return null
  return { action: 'api', method: item.method, path, ...(query ? { query } : {}), ...(record(item.body) || Array.isArray(item.body) ? { body: item.body } : {}) }
}

/**
 * Classify one `api` request. Pure.
 * @param {unknown} input Her request: { action: 'api', method, path, query?, body?, bodyKind?, contentType?, parts? }.
 * @param {{ accountId?: string|null, facts?: object, hosts?: string[], level?: string, lookups?: string[] }} options The
 *   configured account id (fills `{account}`), facts already looked up, the live hosts (default CLOUDFLARE_LIVE_HOME.hosts;
 *   the broker adds PUBLIC_HOST, never fewer), and the door's level (`open` or `guarded`; anything else, or none, is
 *   `guarded`). Facts: `zones`, `dnsRecords`, `routes`, `domains`, `workers`, `queues`, `pages`, `references`, `tunnels`
 *   (each keyed as its `needs` item says; null: the lookup failed), and the live home's own facts: `liveWorker`
 *   (liveWorkerFacts), `boundIds` (liveDurableObjectIds) and `liveZones` ([{ id, name }] of the zones that serve the live
 *   hosts), each null when it could not be read or understood. Job 7, decision B: a caller that names 'live' in
 *   `lookups` (the broker) is asked for all three before anything else is decided (`needs` [{ kind: 'live' }]); a caller
 *   that does not leaves them out, and the checkout's own list (CLOUDFLARE_LIVE_HOME) decides.
 * @returns {object} `refused` { code, status, next }; `needs` { needs: [{ kind, ... }] }; or `open` / `protected`
 *   { method, path (as written in her request), url (filled), body (string or undefined), contentType, allowed, read, and when
 *   protected the protection object's members (family, reason, apiFamily?, also?), `protection` itself and `matched`
 *   (every pair that matched) }.
 */
export function classifyCloudflareRequest(input, options = {}) {
  return classifyAt(input, options, 0)
}

function classifyAt(input, options, depth) {
  const { accountId = null, facts = {}, hosts = CLOUDFLARE_LIVE_HOME.hosts, level = 'guarded', lookups = [] } = options
  const live = CLOUDFLARE_LIVE_HOME
  const at = level === 'open' ? 'open' : 'guarded'
  const liveHosts = [...new Set(hosts.map(host => normalHost(String(host)) ?? String(host).toLowerCase()))]
  if (!record(input) || input.action !== 'api' || Object.keys(input).some(key => !INPUT_KEYS.includes(key))) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
  const method = typeof input.method === 'string' ? input.method.toUpperCase() : ''
  if (!METHODS.includes(method)) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
  const parsed = parsePath(input.path)
  if (parsed === null) return refused('CLOUDFLARE_PATH_REFUSED', 400, CLOUDFLARE_NEXT.path)

  let query = ''
  if (input.query !== undefined) {
    if (!record(input.query) || Object.keys(input.query).length > CLOUDFLARE_DOOR_LIMITS.queryKeys) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
    const params = new URLSearchParams()
    // Review: the query goes in canonical key order (the order canonicalJson, which the approval covers, uses).
    for (const key of Object.keys(input.query).sort()) {
      const value = input.query[key]
      if (!QUERY_KEY.test(key)) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
      if (typeof value === 'string' && value.length <= CLOUDFLARE_DOOR_LIMITS.queryValueChars) params.append(key, value)
      else if ((typeof value === 'number' && Number.isFinite(value)) || typeof value === 'boolean') params.append(key, String(value))
      else return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
    }
    query = params.toString()
  }

  const bodyKind = input.bodyKind ?? 'json'
  if (bodyKind !== 'json' && bodyKind !== 'text' && bodyKind !== 'multipart') return refused('CLOUDFLARE_BODY_KIND_UNSUPPORTED', 400, CLOUDFLARE_NEXT.multipart)
  let body, contentType
  if (bodyKind === 'multipart') {
    if (method === 'GET' || input.body !== undefined || input.contentType !== undefined) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.parts)
    const built = multipartBody(input.parts)
    if (built.refused) return built.refused
    body = built.body; contentType = built.contentType
  } else if (input.parts !== undefined) {
    return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.parts)
  } else if (input.body === undefined) {
    if (input.bodyKind !== undefined || input.contentType !== undefined) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
  } else {
    if (method === 'GET') return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
    if (bodyKind === 'json') {
      if (!(record(input.body) || Array.isArray(input.body)) || (input.contentType !== undefined && input.contentType !== 'application/json')) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
      body = canonicalJson(input.body); contentType = 'application/json'
    } else {
      if (typeof input.body !== 'string' || !TEXT_TYPES.includes(input.contentType)) return refused('CLOUDFLARE_REQUEST_INVALID', 400, CLOUDFLARE_NEXT.request)
      body = input.body; contentType = input.contentType
    }
  }

  if (parsed.includes('{account}') && !(typeof accountId === 'string' && ACCOUNT_ID.test(accountId))) return refused('CLOUDFLARE_BROKER_CONFIG_INVALID', 503, CLOUDFLARE_NEXT.account)
  const segments = parsed.map(part => (part === '{account}' ? accountId : part))
  const resolved = '/' + segments.join('/')
  const s = segments.map(part => part.toLowerCase())
  // `allowed`: the answer fields the credential screen lets through on this path (CLOUDFLARE_ANSWER_ALLOWED).
  const base = { method, path: input.path, url: CLOUDFLARE_API_ORIGIN + resolved + (query ? '?' + query : ''), body, contentType, allowed: Object.freeze(answerAllowed(method, s)) }

  const credential = CLOUDFLARE_CREDENTIAL_PATHS.find(entry => (!entry.methods || entry.methods.includes(method)) && matches(s, entry.pattern))
  if (credential) return refused('CLOUDFLARE_CREDENTIAL_PATH_REFUSED', 403, CLOUDFLARE_NEXT[credential.next ?? 'credential'])
  const read = method === 'GET' || (method === 'POST' && s.length === 1 && s[0] === 'graphql')
  if (read) return Object.freeze({ verdict: 'open', read: true, ...base })
  const open = Object.freeze({ verdict: 'open', read: false, ...base })
  const needs = items => Object.freeze({ verdict: 'needs', needs: Object.freeze(items.map(Object.freeze)) })
  const configured = typeof accountId === 'string' && ACCOUNT_ID.test(accountId)

  // Decision B: the live home's own facts come before any rule decides anything, for every write.
  if (lookups.includes('live') && (facts.liveWorker === undefined || facts.boundIds === undefined || facts.liveZones === undefined)) {
    return needs([{ kind: 'live', account: configured ? accountId : null }])
  }

  // Decision C: every rule that matches adds its (family, reason); none returns on a match. A reason the level does
  // not ask for is not added. `wanted`: lookups a rule needs before the answer can be built.
  const pairs = new Map(), wanted = []
  const add = (family, reason, apiFamily) => {
    if (!pairs.has(reason) && cloudflareAsksAt(at, reason)) pairs.set(reason, Object.freeze({ family, reason, ...(typeof apiFamily === 'string' && CLOUDFLARE_API_FAMILY.test(apiFamily) ? { apiFamily } : {}) }))
  }
  const want = item => { if (!wanted.some(other => canonicalJson(other) === canonicalJson(item))) wanted.push(item) }

  // Decision A: the views, built once.
  const views = requestViews(input, bodyKind)
  const structured = bodyKind === 'json' ? input.body : bodyKind === 'text' ? jsonOf(input.body) : undefined
  const parents = liveHosts.flatMap(host => host.split('.').slice(1, -1).map((_, index, labels) => labels.slice(index).join('.') + '.' + host.split('.').at(-1)))
  const liveZones = Array.isArray(facts.liveZones) ? facts.liveZones.filter(zone => record(zone) && typeof zone.id === 'string' && typeof zone.name === 'string') : []
  const zoneNames = [...new Set([...parents, ...liveZones.map(zone => normalHost(zone.name)).filter(name => name !== null)])]
  const liveZoneIds = new Set(liveZones.map(zone => zone.id.toLowerCase()))
  for (const [id, name] of Object.entries(facts.zones ?? {})) if (typeof name === 'string' && liveZoneName(name, liveHosts)) liveZoneIds.add(id.toLowerCase())
  // A host that is (or a wildcard that covers) the live host is `live-host`; any other host on a live zone is `live-zone`.
  const onLiveZone = value => {
    const host = normalHost(String(value ?? ''))
    return host !== null && !liveHosts.includes(host) && zoneNames.some(zone => host === zone || host.endsWith('.' + zone))
  }
  const servingReason = value => (covers(value, liveHosts) ? 'live-host' : onLiveZone(value) ? 'live-zone' : null)
  // The path beyond the account or zone it is under (the zone a path names is read by R1 below).
  const pathStrings = segments.filter((_, index) => !(index === 1 && (s[0] === 'accounts' || s[0] === 'zones')))
  const addressed = [...pathStrings, ...views.strings]
  const runs = idRuns(addressed).filter(run => run !== String(accountId ?? '').toLowerCase())

  // What could not be read: a request wrapped past the view limits; the live home's own facts.
  if (views.limited) add('P1', 'inspection-limit')
  if (facts.liveWorker === null || facts.boundIds === null || facts.liveZones === null) add('P1', 'live-facts-unresolved')

  // P3 whole-thing deletion (C4).
  if (method === 'DELETE' && s.length === 2 && (s[0] === 'zones' || s[0] === 'accounts')) add('P3', s[0] === 'zones' ? 'zone-deletion' : 'account-deletion')
  // P2 who holds keys (C3; the user's own record is not core). The rows of one table say what ONE path is (the first row
  // that matches: /accounts/move is a move, not an account record), so a table gives one pair; every table is read.
  const holder = WHO_HOLDS_KEYS.find(([pattern]) => matches(s, pattern))
  if (holder) add('P2', holder[1])
  // P1 by name, anywhere in the path, the query or the body (case-insensitive, NFKC, host names read as the URL parser reads them).
  for (const reason of nameReasons([resolved, ...views.strings], live, liveHosts)) add('P1', reason)
  // P1 the live host's own domain named in the path (the registrar record of example.invalid: its renewal and lock), C1.
  if (s.some(part => zoneNames.includes(part.replace(/\.$/, '')))) add('P1', 'live-domain')

  // P1 her live home's storage BY ID: anything shaped like a Cloudflare id (32 hex, dashes
  // ignored) is checked against the Durable Object namespace ids the live Worker binds (read for this request).
  if (runs.length > 0) {
    if (Array.isArray(facts.boundIds)) { if (runs.some(run => facts.boundIds.some(id => run.includes(id)))) add('P1', 'bound-storage') }
    else if (facts.boundIds === undefined) add('P1', 'bound-id-unresolved')
  }

  // C5: anything that commits the owner to a charge, by path, by a paid plan named anywhere in the views (`rate_plan`), or by
  // the `plan` member of Edit Zone (PATCH /zones/<id>), which creates or cancels a zone's subscription.
  const charge = rowFor(CLOUDFLARE_CHARGES, s, method)
  if (charge) add('P4', charge.reason)
  if (views.fields.some(([key]) => /^rateplans?$/.test(key.toLowerCase().replace(/[_-]/g, '')))) add('P4', 'paid-subscription')
  if (s[0] === 'zones' && s.length === 2 && views.documents.some(view => record(view) && Object.keys(view).some(key => key.toLowerCase() === 'plan'))) add('P4', 'paid-subscription')

  // R5a: a path with a run from the credential vocabulary (C3), under any root; job 7: or a word of a segment.
  const vocabulary = rowFor(CLOUDFLARE_CREDENTIAL_VOCABULARY, s, method)
  if (vocabulary) add('P2', vocabulary.reason)
  const single = CLOUDFLARE_CREDENTIAL_VOCABULARY.filter(entry => entry.run.length === 1 && !entry.methods)
  for (const part of s) {
    const words = part.split(/[-_.]+/)
    // A segment that is itself a row (`token_validation`, `turn_keys`) is read by that row, not word by word.
    if (words.length < 2 || single.some(entry => entry.run[0] === part)) continue
    for (const word of words) {
      const row = single.find(entry => entry.run[0] === word || (CREDENTIAL_SINGULARS.includes(word) && entry.run[0] === word + 's'))
      if (row) add('P2', row.reason)
    }
  }
  // R5b: a credential carried anywhere in the views: a credential-named field (whatever its value), a secret binding, a
  // credential value (a Cloudflare credential format, which opens the account: `keys`; a PEM private key, a Bearer value, a
  // URL with user-info or a credential-named query parameter: `app-secret`).
  for (const reason of viewCredentials(views)) add('P2', reason)

  // A host name Cloudflare reads from the body of a custom-domain write must be readable (R7a).
  if (s[0] === 'accounts' && ((s[2] === 'workers' && s[3] === 'domains') || (s[2] === 'pages' && s[3] === 'projects' && s[5] === 'domains'))) {
    const fields = (Array.isArray(structured) ? structured : [structured]).filter(record).flatMap(item => [item.hostname, item.name]).filter(value => typeof value === 'string')
    if (fields.some(value => coverage(value, liveHosts) === 'unreadable')) add('P1', 'host-unreadable')
    if (fields.some(value => covers(value, liveHosts))) add('P1', 'live-host')
  }

  // R1 by reference (job 7 MUST 5 and 7, through the views): a zone id or zone name in any field, a /zones/<id> URL
  // in any string, the live zone's id in any string, a host on the live zone in any string.
  const zoneIds = [], zoneNamed = []
  for (const [key, value] of views.fields) {
    const name = key.toLowerCase().replace(/[_-]/g, '')
    if (/^zone(?:id|tag)s?$/.test(name)) zoneIds.push(...[value].flat().filter(item => typeof item === 'string'))
    if (/^zonenames?$/.test(name)) zoneNamed.push(...[value].flat().filter(item => typeof item === 'string'))
  }
  for (const text of views.strings) for (const match of text.matchAll(/\/zones\/([0-9a-f]{32})(?![0-9a-z_-])/gi)) zoneIds.push(match[1])
  if (zoneIds.some(id => !/^[0-9a-f]{32}$/i.test(id))) add('P1', 'zone-unresolved')
  for (const id of new Set(zoneIds.filter(value => /^[0-9a-f]{32}$/i.test(value)).map(value => value.toLowerCase()))) {
    const name = facts.zones?.[id]
    if (liveZoneIds.has(id)) add('P1', 'live-zone')
    else if (name === undefined) want({ kind: 'zone', zoneId: id })
    else if (name === null) add('P1', 'zone-unresolved')
    else if (liveZoneName(name, liveHosts)) add('P1', 'live-zone')
  }
  if (zoneNamed.some(name => normalHost(name) === null)) add('P1', 'host-unreadable')
  if (zoneNamed.some(name => normalHost(name) !== null && liveZoneName(name, liveHosts))) add('P1', 'live-zone')
  if (runs.some(run => [...liveZoneIds].some(id => run.includes(id)))) add('P1', 'live-zone')
  if (onLiveZoneIn([...pathStrings.filter(part => !zoneNames.includes(part.toLowerCase().replace(/\.$/, ''))), ...views.strings], zoneNames, liveHosts)) add('P1', 'live-zone')
  if (s[0] === 'accounts') {
    const items = (Array.isArray(structured) ? structured : [structured]).filter(record)
    const domainHosts = s[2] === 'workers' && s[3] === 'domains' ? items.map(item => item.hostname)
      : s[2] === 'pages' && s[3] === 'projects' && s[5] === 'domains' ? [...items.map(item => item.name), s[6]]
        : s[2] === 'r2' && s[3] === 'buckets' && s[5] === 'domains' && s[6] === 'custom' ? [...items.map(item => item.domain), s[7]] : []
    for (const value of domainHosts.filter(item => typeof item === 'string')) {
      if (normalHost(value) === null) add('P1', 'host-unreadable')
      else if (servingReason(value) !== null) add('P1', servingReason(value))
    }
  }

  const own = s[0] === 'accounts' && configured && s[1] === accountId
  // R3 and C2 (job 7 MUST 1 and 3): what the live Worker is made of, from its own settings: a Worker it calls or
  // sends its tail to, a dispatch namespace or workflow it binds (C1, `live-dependency`), and every store it binds (C2).
  const known = record(facts.liveWorker) ? facts.liveWorker : null
  if (own && known !== null) {
    const target = dependencyTarget(s)
    const bound = target === null || target.name === null ? false
      : (target.kind === 'dispatch' ? known.dispatch : target.kind === 'workflow' ? known.workflows : known.workers).includes(target.name)
    if (bound) add('P1', 'live-dependency')
    if (carriesToken(addressed, known.storage)) add('P1', 'bound-storage')
  }
  // Job 7: a queue is addressed by its id, the settings bind it by name: a write under a queue id when the live
  // Worker binds any queue, and always a purge or a delete, looks the queue up (its name and consumers).
  if (own && s[2] === 'queues' && s.length >= 4 && (known === null || known.queues.length > 0 || (method === 'DELETE' && s.length === 4) || s[4] === 'purge')) {
    const fact = facts.queues?.[`${segments[1]}/${s[3]}`]
    if (fact === undefined) want({ kind: 'queue', account: segments[1], id: s[3] })
    else if (fact === null) add('P1', 'bound-id-unresolved')
    else {
      if (known !== null && known.queues.includes(String(fact.name).toLowerCase())) add('P1', 'bound-storage')
      if (fact.consumers.some(name => String(name).toLowerCase() === live.worker)) add('P1', 'live-dependency')
    }
  }

  // P1 account-level Workers: settings of every Worker, deployments and Durable Objects by id, a Worker or a custom domain by id.
  if (s[0] === 'accounts' && s[2] === 'workers') {
    if (s[3] === 'account-settings' || (s[3] === 'subdomain' && s.length === 4)) add('P1', 'live-worker-settings')
    else if (s[3] === 'deployments') add('P1', 'live-worker')
    else if (s[3] === 'durable_objects') add('P1', 'bound-storage')
    else if (s[3] === 'workers' && s.length >= 5) {
      // A Worker named by its name (the live one is held by name above) needs no lookup.
      const name = s[4] === live.worker ? live.worker : facts.workers?.[segments[1] + '/' + segments[4]]
      if (name === undefined) want({ kind: 'worker', account: segments[1], id: segments[4] })
      else {
        const lower = String(name).toLowerCase()
        if (lower === live.worker) add('P1', 'live-worker')
        else if (known !== null && known.workers.includes(lower)) add('P1', 'live-dependency')
      }
    } else if (s[3] === 'domains' && s.length >= 5) {
      const domain = facts.domains?.[segments[1] + '/' + segments[4]]
      if (domain === undefined) want({ kind: 'domain', account: segments[1], id: segments[4] })
      else {
        if (coverage(domain.hostname, liveHosts) === 'unreadable') add('P1', 'host-unreadable')
        else if (covers(domain.hostname, liveHosts) || String(domain.service ?? '').toLowerCase() === live.worker) add('P1', 'live-host')
        // Job 7: the custom domain's own zone, as its lookup gives it, by the same live-zone test as a new one.
        if (onLiveZone(domain.hostname) || (typeof domain.zoneName === 'string' && liveZoneName(domain.zoneName, liveHosts))
          || (typeof domain.zoneId === 'string' && liveZoneIds.has(domain.zoneId.toLowerCase()))) add('P1', 'live-zone')
      }
    }
  }

  // R2: the account- and user-wide switches (C1 at every level); Workers Builds is `live-worker`.
  const wide = ACCOUNT_WIDE.find(([pattern]) => matches(s, pattern))
  if (wide) add('P1', wide[1])

  // SHOULD 3: existing products that serve the live zone through a relation, each read by one lookup; one that
  // cannot be read holds (`live-dependency-unresolved`). Private-network routes (teamnet, zero-trust hostname routes) do
  // not serve the live zone and are not read.
  if (own) {
    const account = segments[1]
    if (s[2] === 'pages' && s[3] === 'projects' && s.length >= 5) {
      const relation = (method === 'DELETE' && (s.length === 5 || (s[5] === 'deployments' && s.length === 7)))
        || (method === 'PATCH' && s.length === 5) || (method === 'POST' && s[5] === 'deployments' && s.length === 8 && ['rollback', 'retry'].includes(s[7]))
      if (relation) {
        const fact = facts.pages?.[`${account}/${s[4]}`]
        if (fact === undefined) want({ kind: 'pagesProject', account, id: s[4] })
        else if (fact === null) add('P1', 'live-dependency-unresolved')
        else {
          for (const domain of fact.domains) if (servingReason(domain) !== null) add('P1', servingReason(domain))
          if (method === 'PATCH' && pagesSecretRemoved(structured, fact.envVars)) add('P2', 'app-secret')
        }
      }
    }
    if (s[2] === 'load_balancers' && (s[3] === 'pools' || s[3] === 'monitors') && s.length >= 5 && s[5] !== 'references') {
      const fact = facts.references?.[`${account}/${s[3]}/${s[4]}`]
      if (fact === undefined) want({ kind: 'lbReferences', account, collection: s[3], id: s[4] })
      else if (fact === null) add('P1', 'live-dependency-unresolved')
      else for (const item of fact) if (item.type === 'load_balancer' && servingReason(item.name) !== null) add('P1', servingReason(item.name))
    }
    if (s[2] === 'cfd_tunnel' && s.length >= 4 && ((method === 'DELETE' && s.length === 4) || (s[4] === 'configurations' && s.length === 5) || (method === 'DELETE' && s[4] === 'connections'))) {
      const fact = facts.tunnels?.[`${account}/${s[3]}`]
      if (fact === undefined) want({ kind: 'tunnelConfig', account, id: s[3] })
      else if (fact === null || fact.local) add('P1', 'live-dependency-unresolved')
      else for (const host of fact.hostnames) if (servingReason(host) !== null) add('P1', servingReason(host))
    }
  }

  // SHOULD 2: a request nested in the body is classified as its own request, and its reasons join this one's.
  const nested = views.objects.map(nestedRequest).filter(item => item !== null)
  if (nested.length > 0 && (depth + 1 > CLOUDFLARE_DOOR_LIMITS.nestedDepth || nested.length > 64)) add('P1', 'inspection-limit')
  else {
    for (const item of nested) {
      const inner = classifyAt(item, options, depth + 1)
      if (inner.verdict === 'needs') for (const need of inner.needs) want(need)
      else if (inner.verdict === 'refused') add('P1', 'inspection-limit')
      else if (inner.verdict === 'protected') for (const pair of inner.matched) add(pair.family, pair.reason, pair.apiFamily)
    }
  }

  // Another account: the open list and the account rules are about the configured account.
  if (s[0] === 'accounts' && s.length >= 2 && !own && s[1] !== 'move') add('account-wide-unclassified', 'other-account', s.slice(2, 4).join('/') || 'accounts')

  // R1: a zone write resolves the zone; on the zone that serves the live host EVERY write asks (C1), whatever its
  // family; a zone the edge could not resolve asks too; every other zone is open. The reason names what the edge can tell:
  // a DNS record (`live-dns`), a Workers route (`live-route`), a name there that cannot be read (`host-unreadable`).
  if (s[0] === 'zones' && s.length >= 2) {
    const zoneId = s[1], known = liveZones.find(zone => zone.id.toLowerCase() === zoneId)
    const zoneName = known !== undefined ? known.name : facts.zones?.[zoneId]
    if (zoneName === undefined) want({ kind: 'zone', zoneId })
    else if (zoneName === null) add('P1', 'zone-unresolved')
    else if (liveZoneName(zoneName, liveHosts)) {
      const zone = normalHost(String(zoneName)) ?? String(zoneName).toLowerCase().replace(/\.+$/, '')
      const rest = s.slice(2)
      const readableBody = bodyKind !== 'multipart' && (input.body === undefined || structured !== undefined)
      if (rest[0] === 'dns_records') add('P1', (readableBody ? dnsNames(structured).map(name => dnsName(name, zone)) : []).includes(null) ? 'host-unreadable' : 'live-dns')
      else if (rest[0] === 'workers' && rest[1] === 'routes') add('P1', coverage(readableBody && record(structured) ? structured.pattern : undefined, liveHosts) === 'unreadable' ? 'host-unreadable' : 'live-route')
      else add('P1', 'live-zone')
    }
  }

  if (wanted.length > 0) return needs(wanted)
  // The fall-through, after every rule has read the views: a write nothing above classified asks at `guarded` only (not core):
  // under /user as P2, at the account level off the open list, under another API root.
  if (pairs.size === 0) {
    if (s[0] === 'user') add('P2', 'user')
    else if (s[0] === 'accounts' && s.length >= 3 && own) {
      const listed = CLOUDFLARE_ACCOUNT_OPEN.filter(entry => entry.family === s[2])
      if (!listed.some(entry => entry.sub === undefined || entry.sub === s[3])) add('account-wide-unclassified', 'unclassified', listed.length > 0 && s[3] !== undefined ? s[2] + '/' + s[3] : s[2])
    } else if (!WRITE_ROOTS.includes(s[0])) add('account-wide-unclassified', 'root-unclassified', s[0])
  }
  if (pairs.size === 0) return open
  const matched = Object.freeze([...pairs.values()])
  const protection = cloudflareProtectionOf(matched)
  return Object.freeze({ verdict: 'protected', read: false, ...protection, protection, matched, ...base })
}

/** Job 7: whether a Pages PATCH body sets to null, or gives another type to, an environment variable that is a
 * secret today (`envVars`: { production: { NAME: type }, preview: { ... } } from the project's lookup). */
function pagesSecretRemoved(body, envVars) {
  const configs = record(body) && record(body.deployment_configs) ? body.deployment_configs : {}
  return Object.entries(configs).some(([environment, config]) => record(config) && record(config.env_vars) && Object.entries(config.env_vars).some(([name, value]) => {
    if (String(envVars?.[environment]?.[name] ?? '').toLowerCase() !== 'secret_text') return false
    return value === null || (record(value) && String(value.type ?? 'plain_text').toLowerCase() !== 'secret_text')
  }))
}

/** R5b through the views: the P2 reasons a request's views carry. */
function viewCredentials(views) {
  const found = new Set()
  for (const [key, value] of views.fields) {
    if (credentialField(key, value, [], true)) found.add('app-secret')
    // A credential-named field counts whatever its value (a number, an object), never a boolean or an empty value.
    else if (typeof value === 'number' && fieldNames(key).some(name => CREDENTIAL_KEYS.has(name) || CREDENTIAL_SUFFIX.test(name))) found.add('app-secret')
  }
  for (const item of views.objects) if (typeof item.type === 'string' && SECRET_TYPES.includes(item.type.toLowerCase())) found.add('app-secret')
  for (const text of views.strings) {
    if (CREDENTIAL_FORMAT.test(text)) found.add('keys')
    else if (credentialText(text)) found.add('app-secret')
  }
  return found
}

/** R3: what a write under the configured account is, for the live Worker's own settings: a Worker by name
 * (scripts, services) or by id (name null: looked up below), a dispatch namespace, a workflow; null for anything else. */
function dependencyTarget(s) {
  if (s[0] !== 'accounts' || s.length < 4) return null
  if (s[2] === 'workers' && (s[3] === 'scripts' || s[3] === 'services') && s.length >= 5) return { kind: 'worker', name: s[4] }
  if (s[2] === 'workers' && s[3] === 'workers' && s.length >= 5) return { kind: 'worker', name: null }
  if (s[2] === 'workers' && s[3] === 'dispatch' && s[4] === 'namespaces' && s.length >= 6) return { kind: 'dispatch', name: s[5] }
  if (s[2] === 'workflows' && s.length >= 4) return { kind: 'workflow', name: s[3] }
  return null
}

/** Whether any of the strings names one of the store identifiers (a 32-hex id with or without dashes, or a name as a
 * whole word, any case, NFKC). */
function carriesToken(strings, tokens) {
  const runs = idRuns(strings)
  return tokens.some(token => {
    const plain = token.replace(/-/g, '')
    if (/^[0-9a-f]{32,}$/.test(plain)) return runs.some(run => run.includes(plain))
    const pattern = new RegExp(`(?<![a-z0-9_-])${escape(token)}(?![a-z0-9_-])`, 'i')
    return strings.some(text => pattern.test(text.normalize('NFKC')))
  })
}

/** Job 7: the largest protection object the contract allows, for the staged-file bound. */
const LARGEST_PROTECTION = Object.freeze({ family: 'account-wide-unclassified', reason: 'x'.repeat(40), apiFamily: 'x'.repeat(64) + '/' + 'x'.repeat(64),
  also: Array.from({ length: CLOUDFLARE_ALSO_MAX }, (_, index) => ({ family: 'account-wide-unclassified', reason: 'x'.repeat(39) + 'abcdefgh'[index] })) })
/** The staged slot's schema her runtime writes (webworker-runtime ball-loader.ts STAGED_OUTWARD_SCHEMA). */
export const CLOUDFLARE_STAGED_SCHEMA = 'aukora.staged-outward-class3.v1'

/**
 * Job 7: the bytes of the staged file her runtime writes for a held request, with the largest
 * protection object allowed and the largest `stagedAt`. Her runtime writes it indented (JSON.stringify with two spaces,
 * then a newline), which is never smaller than the compact form the contract names, so this bound holds for both.
 * @param {unknown} input Her request as she sent it.
 * @returns {number} The byte length.
 */
export function cloudflareStagedBytes(input) {
  return new TextEncoder().encode(JSON.stringify({ schema: CLOUDFLARE_STAGED_SCHEMA, stagedAt: Number.MAX_SAFE_INTEGER, tool: 'x6_cloudflare', method: 'POST',
    pathname: '/_host/cloudflare', body: input, protection: LARGEST_PROTECTION }, null, 2) + '\n').byteLength
}

/** Which kind of Cloudflare credential the edge holds, as a word (never a value). */
export function cloudflareAuthKind(env) {
  const key = env?.CLOUDFLARE_API_TOKEN
  if (typeof key !== 'string' || !key || key.length > 4096 || /\s/.test(key)) return 'none'
  return typeof env.CLOUDFLARE_EMAIL === 'string' && env.CLOUDFLARE_EMAIL.length <= 254 && EMAIL.test(env.CLOUDFLARE_EMAIL) ? 'global-key' : 'api-token'
}

/**
 * The auth headers of every Cloudflare call. A Global API Key authenticates only as X-Auth-Email and X-Auth-Key, so when
 * CLOUDFLARE_EMAIL has the shape of an email those two go and no Authorization; otherwise Authorization: Bearer. Never both.
 * @param {object} env Worker bindings.
 * @returns {{ authKind: 'global-key'|'api-token', headers: Record<string, string> }} Never logged, never in an answer.
 */
export function cloudflareAuth(env) {
  const key = env?.CLOUDFLARE_API_TOKEN
  if (typeof key !== 'string' || !key) throw coded('CLOUDFLARE_BROKER_TOKEN_UNCONFIGURED', 503)
  if (key.length > 4096 || /\s/.test(key)) throw coded('CLOUDFLARE_BROKER_CONFIG_INVALID', 503)
  return cloudflareAuthKind(env) === 'global-key'
    ? { authKind: 'global-key', headers: { 'x-auth-email': env.CLOUDFLARE_EMAIL, 'x-auth-key': key } }
    : { authKind: 'api-token', headers: { authorization: 'Bearer ' + key } }
}

const CREDENTIAL_KEYS = new Set(['secret', 'clientsecret', 'tunnelsecret', 'privatekey', 'password', 'passphrase', 'credentialsfile', 'streamkey',
  'secretaccesskey', 'sessiontoken', 'apikey', 'apitoken', 'token', 'pem', 'jwk',
  // Review: an upload credential, a credentials object, an IPsec pre-shared key.
  'jwt', 'credentials', 'psk',
  // Job 5: a bearer upload URL, a domain transfer code.
  'uploadurl', 'authcode',
  // Job 7: the aliases (`private_key`, `api_key`, `client_secret` and `credentials` were here).
  'passwd', 'pwd', 'authorization', 'accesskey', 'signingkey', 'credential'])
/** Job 5: a name that ENDS in one of these (after the plural rule) is a credential field too. */
const CREDENTIAL_SUFFIX = /(?:secret|jwt|privatekey|password|apikey|authcode)$/
/** Job 5: request headers that carry a credential, wherever a `headers` object appears. */
const CREDENTIAL_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|cf-access-client-secret|x-auth-.+)$/i
/** Job 5: Cloudflare's newer credential formats (developers.cloudflare.com/fundamentals/api/get-started/token-formats/). */
const CREDENTIAL_FORMAT = /(?<![A-Za-z0-9])(?:cfk|cfut|cfat)_[A-Za-z0-9_-]{16,}/
/** Job 5: words of a URL query parameter name that carry a credential (a signed URL, a SAS, an access key). */
const QUERY_CREDENTIAL_WORDS = new Set(['token', 'secret', 'password', 'passwd', 'pwd', 'key', 'sig', 'signature', 'auth', 'authorization',
  'credential', 'credentials', 'sas', 'apikey', 'accesskey', 'secretkey'])
/** Job 5 (R5b): a binding type whose value is a secret (a Worker secret binding, a Pages secret variable). */
const SECRET_TYPES = ['secret_text', 'secret_key']

/** A field name lower-cased with its separators dropped, and its singular when it ends in `s` (the plural rule, job 5:
 * `client_secrets` is read as `client_secret`). */
function fieldNames(key) {
  const squashed = key.toLowerCase().replace(/[^a-z]/g, '')
  return squashed.length > 1 && squashed.endsWith('s') ? [squashed, squashed.slice(0, -1)] : [squashed]
}

/** Job 7: a PEM private-key block; a Bearer value (case as HTTP writes it, six characters or more).
 * Job 8 review: the value carries a digit or runs 20 characters or more, so `Bearer tokens` or `Bearer authentication` in
 * a comment is prose, not a value (a real one is random: a digit in it is all but certain, and a long one counts anyway). */
const PEM_PRIVATE = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/
const BEARER = /(?<![A-Za-z0-9])Bearer\s+(?:(?=[A-Za-z._~+/-]*[0-9])[A-Za-z0-9._~+/-]{6,}|[A-Za-z0-9._~+/-]{20,})/
/** URL scheme characters, and the characters that end a URL inside a text. */
const SCHEME_CHAR = /[a-z0-9+.-]/i
const URL_TAIL = /[^\s"'`<>\\]+/y
/** Job 8 (and its review): the URLs inside a text, exactly the matches of the unbounded expression job 7 used
 * (`/[a-z][a-z0-9+.-]*:\/\/[^\s"'`<>\\]+/gi`), found in linear time. That expression tried every starting point of a run
 * of scheme characters (quadratic); this finds each `://`, reads its scheme run leftwards (a run never holds `:` or `/`,
 * so the runs are disjoint and each character is read once), starts at the run's first letter, and reads the tail. */
export function cloudflareUrlsInText(text) {
  const found = []
  let from = 0
  for (let colon = text.indexOf('://'); colon >= 0; colon = text.indexOf('://', Math.max(colon + 1, from))) {
    let start = colon
    while (start > from && SCHEME_CHAR.test(text[start - 1])) start--
    while (start < colon && !/[a-z]/i.test(text[start])) start++
    if (start === colon) continue
    URL_TAIL.lastIndex = colon + 3
    const tail = URL_TAIL.exec(text)
    if (tail === null) continue
    found.push(text.slice(start, URL_TAIL.lastIndex))
    from = URL_TAIL.lastIndex
  }
  return found
}
/** Job 8: a query value that is not a value yet but program text: an expression or a placeholder (`${`, `{{`, `{`, `<`).
 * A value the string ends before (a quote, a backtick, a `+` that joins an expression) is empty: the URL ends there.
 * Job 8 review: a value that starts with `+` inside the string is a literal (raw base64) and counts. */
const QUERY_VALUE_EXPRESSION = /^(?:\$\{|\{|<)/

/** Whether one URL carries a credential: user-info, or a credential-named query parameter that has a literal value (job 8:
 * an empty value, an expression or a placeholder is not one). */
function credentialUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(url)) return true
  const at = url.indexOf('?')
  if (at < 0) return false
  return url.slice(at + 1).split('#')[0].split('&').some(pair => {
    const [rawName, ...rest] = pair.split('=')
    let name
    try { name = decodeURIComponent(rawName) } catch { name = rawName }
    name = name.toLowerCase()
    const value = rest.join('=')
    return value.length > 0 && !QUERY_VALUE_EXPRESSION.test(value) && (name.startsWith('header_') || name.split(/[^a-z0-9]+/).some(word => QUERY_CREDENTIAL_WORDS.has(word))
      || /(?:token|secret|password|signature|apikey|accesskey)$/.test(name.replace(/[^a-z]/g, '')))
  })
}

/** Whether a string carries a credential by its form, anywhere in it (MUST 28 and 29; job 7, SHOULD 1 and MUST
 * 11): a Cloudflare credential format, a PEM private-key block, a Bearer value, or a URL (the whole string or one inside
 * it) with user-info or with a credential-named query parameter that has a value. */
function credentialText(text) {
  if (CREDENTIAL_FORMAT.test(text) || PEM_PRIVATE.test(text) || BEARER.test(text)) return true
  if (!text.includes('://')) return false
  return cloudflareUrlsInText(text).some(credentialUrl)
}

/** Job 7: whether the raw text of an answer, whatever its type, carries a credential by its form. */
export function cloudflareAnswerCarriesCredential(text) {
  return typeof text === 'string' && credentialText(text)
}

/** Answer fields named like a credential that are harmless on one path, each with its reason. The `token` rule below
 * would withhold them; nothing else is relaxed. */
export const CLOUDFLARE_ANSWER_ALLOWED = Object.freeze([
  Object.freeze({ pattern: Object.freeze(['accounts', '*', 'images', 'v2']), methods: Object.freeze(['GET']), field: 'continuation_token',
    reason: 'the Images v2 list answers `result.continuation_token`, a page cursor passed back as a query parameter (developers.cloudflare.com/api/resources/images/subresources/v2/methods/list/)' }),
  // Review: both were readable before the `token` rule. The Web Analytics beacon value is public by design: it is
  // written into every page the site serves (the beacon script's data-cf-beacon), so it opens nothing.
  Object.freeze({ pattern: Object.freeze(['accounts', '*', 'pages', 'projects', '**']), methods: Object.freeze(['GET']), field: 'web_analytics_token',
    reason: 'Pages project and deployment answers carry `build_config.web_analytics_token`, the public Web Analytics beacon value (developers.cloudflare.com/api/resources/pages/subresources/projects/methods/list/)' }),
  Object.freeze({ pattern: Object.freeze(['accounts', '*', 'rum', 'site_info', '**']), methods: Object.freeze(['GET']), field: 'site_token',
    reason: 'the Web Analytics site list answers `result[].site_token`, the same public beacon value (developers.cloudflare.com/api/resources/rum/subresources/site_info/methods/list/)' }),
])

/** The answer fields allowed on this request (lower-cased path segments), from CLOUDFLARE_ANSWER_ALLOWED. */
export function answerAllowed(method, segments) {
  return CLOUDFLARE_ANSWER_ALLOWED.filter(entry => entry.methods.includes(method) && matches(segments, entry.pattern)).map(entry => entry.field)
}

/** Whether one field, by its name and value, is credential material. `strict` (a request body): a name ending in
 * `token` counts with any non-empty string. */
function credentialField(key, child, allowed, strict = false) {
  const filled = (typeof child === 'string' && child.length > 0) || (child !== null && typeof child === 'object' && Object.keys(child).length > 0)
  const names = fieldNames(key)
  if (filled && names.some(name => CREDENTIAL_KEYS.has(name) || CREDENTIAL_SUFFIX.test(name))) return true
  // A Logpush destination carries its credentials in its query or user-info (header_Authorization, access keys).
  if (names[0] === 'destinationconf' && typeof child === 'string' && /[?@]/.test(child)) return true
  // A `headers` object with an Authorization, Cookie or X-Auth-* header (or any header named like a key) that has a value.
  if (names.includes('header') && record(child) && Object.entries(child).some(([name, value]) => (typeof value === 'string' ? value.length > 0 : value !== null && value !== undefined)
    && (CREDENTIAL_HEADER.test(name) || /(?:apikey|token|secret|password)$/.test(name.toLowerCase().replace(/[^a-z]/g, ''))))) return true
  // `token` or a name ending in `token` (plural too) with a string of 20 or more characters, or a list of them (a page
  // cursor is allowed by path, above); in a body, any non-empty one.
  const strings = typeof child === 'string' ? [child] : Array.isArray(child) ? child.filter(item => typeof item === 'string') : []
  return names.some(name => /token$/.test(name)) && !allowed.includes(key) && strings.some(item => item.length >= (strict ? 1 : 20))
}

/**
 * Whether an answer carries a field named like credential material with something in it: `jwt`, `secret`,
 * `client_secret`, `private_key`, `api_key`, `password`, `credentials`, `uploadURL`, `auth_code` and every name ending in
 * `secret`, `jwt`, `private_key`, `password`, `api_key` or `auth_code` (any case or separator, plural too:
 * `client_secrets`), and `token` or a name ending in `token` whose value is a string of 20 or more characters (or a list
 * of them); a `headers` object with Authorization, Cookie or X-Auth-*; a Logpush `destination_conf` with a query or
 * user-info; and any string that is a URL with user-info or a credential-named query parameter, or that carries a
 * Cloudflare credential format (`cfk_`, `cfut_`, `cfat_`). A string inside the answer that is itself JSON is read as
 * JSON too (to a depth of 4), so a credential cannot hide in a nested document. The broker's secret screen (safeText)
 * runs too; this catches keys it cannot know. It cannot recognise an arbitrary credential stored as ordinary data.
 * @param {unknown} value The parsed answer (or, with `body`, a request body).
 * @param {{ allowed?: string[], body?: boolean }} [options] Field names allowed on this path (answerAllowed); `body`: read
 *   a request body (any non-empty token-named string counts, and a `secret_text` or `secret_key` binding counts).
 * @returns {boolean} True when any of it must be withheld (an answer) or asks as `keys` (a body).
 */
export function credentialShaped(value, { allowed = [], body = false } = {}) {
  const stack = [[value, 0]]
  while (stack.length) {
    const [item, depth] = stack.pop()
    if (typeof item === 'string') {
      if (credentialText(item)) return true
      if (depth < 4 && /^\s*[[{]/.test(item)) {
        const parsed = jsonOf(item)
        if (parsed !== undefined) stack.push([parsed, depth + 1])
      }
    } else if (Array.isArray(item)) for (const child of item) stack.push([child, depth])
    else if (record(item)) {
      if (body && typeof item.type === 'string' && SECRET_TYPES.includes(item.type.toLowerCase())) return true
      for (const [key, child] of Object.entries(item)) {
        if (credentialField(key, child, allowed, body)) return true
        stack.push([child, depth])
      }
    }
  }
  return false
}

/** R5b: whether a request body (a parsed JSON view of it) carries a credential-shaped field at any depth. */
export function bodyCarriesCredential(view) {
  return credentialShaped(view, { body: true })
}
