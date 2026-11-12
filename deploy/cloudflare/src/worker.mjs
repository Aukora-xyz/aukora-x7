/** Private edge host. No operation connects to the owner's computer. */
import { OWNER_JWT_UNVERIFIED, createAccessVerifier, createOwnerLoginVerifier, ownerAccessConfigured } from './access.mjs'
import { handleCloudBroker, approveConsumedRepoPublication } from './cloud-brokers.mjs'
import { bootstrapPackage, readBoundedBootstrapJson } from './head-do.mjs'
import { OWNER_GRANT_MAX_BODY_BYTES, normalizeOwnerGrantBinding, ownerGrantFailure, ownerGrantRequestFailure, verifySignedOwnerGrant, requireOwnerNodeKeySeparation } from './owner-grant-policy.mjs'
import { aumlokClass3Binding, AUMLOK_SIGNIN_CHALLENGE_MAX, AUMLOK_SIGNIN_LIMITS, sessionTokenAuthentic, signinAssertionShape /* DEVICES hook */, sessionTokenParts, signinChallengeDigest, signinChallengeMac, signinPayloadCheck, signinPayloadText } from './aumlok.mjs'
import { verifyAuthenticationResponse } from '@simplewebauthn/server'
import { isoBase64URL } from '@simplewebauthn/server/helpers'
import { providerBudgetLimits, providerRequestReservation } from './provider-budget.mjs'
import { createPlatformPublicHttpsTransport, createTrustedDocsHttpsTransport, TRUSTED_DOCS_HTTPS_ORIGINS } from './public-https-transport.mjs'
import { createEdgeDiagnostics } from './edge-diagnostics.mjs'
import { executeEdgeArchiveOperation, COLD_ARCHIVE_SCHEMA, archiveErrorReply } from './cold-archive.mjs'
import { extractDoorTurnSummary } from './turn-journal.mjs'
import { executeCloudBrowserBody } from './cloud-body.mjs'
import { handleEdgeVoiceRequest, projectVoiceStatus } from './voice-director.mjs'
import { cloudWakeProvider } from './cloud-wake-tools.mjs'
import { WAKE_PROBE_STATUSES } from './messages-store.mjs'
import { recoveryRestorePageMode, recoveryRestorePageResponse } from './recovery-restore-page.mjs'
// NOSTR hook: her signed head announcement: two signed-out reads and the owner's publish route. Not a relay.
import { NOSTR_ANCHOR_ROUTE, NOSTR_ANCHOR_LATEST_PATH, NOSTR_PUBLIC_ROUTES, createNostrReadDoor } from './nostr-anchor.mjs'
import { proofIs, proofOutcome, relayWrong } from './proof-failure-rule.mjs' // DEVICES hook: a verifier's three outcomes; job 10: the login gate's closed field
import { SCREEN_POLICY, screenAssertion } from './webauthn-screen.mjs' // DEVICES hook: a passkey answer is screened before the library
import { OWNER_LOGIN_SLOTS, createLoginSlots } from './owner-login-slots.mjs' // DEVICES hook: owner-login checks in flight, bounded
import { GATE_LOCKOUT_DEFAULTS } from './gate-lockout.mjs' // DEVICES hook: the failures HEAD's login gate allows
import { createSharedCalls, SHARED_CALL_BUSY, SHARED_CALL_MAX_WAITS, SHARED_CALL_WAIT_MS } from './shared-call.mjs'
// DEVICES hook: more than one enrolled passkey (passkey-devices.mjs owns the logic; the marked lines below only call it).
import { PASSKEY_DEVICE_SIGNIN_LINK, PASSKEY_DEVICE_SIGNIN_LINK_STYLE, PASSKEY_DEVICE_ROUTES, passkeyDeviceDoor, signinAllowCredentials, signinCredentialFor, signinKeyDeviceCode, signinKeyDevices } from './passkey-devices.mjs'
export { X61HeadDurableObject } from './head-do.mjs'
export { MirrorDO } from './mirror-do.mjs'
import { bootstrapResetPaths, validateMirrorEntries, MIRROR_LIMITS, mirrorSnapshotPrefixBytes, mirrorSnapshotEntryBytes } from './mirror-do.mjs'
// ANYBROWSER hook: the vault (hash-named pieces and checked rescue indexes in the private bucket) and the /rescue page.
import { handleVaultRequest } from './vault.mjs' // ANYBROWSER hook
import { rescuePageResponse, rescueBusyResponse, wantsRescueDocument } from './rescue-page.mjs' // ANYBROWSER hook

const MAX_BODY = 16 * 1024 * 1024
const MESSAGE_METHODS = new Map([
  ['/aukora-messages/contacts.json', 'GET'],
  ['/aukora-messages/thread', 'POST'],
  ['/aukora-messages/send', 'POST'],
  ['/aukora-messages/add-contact', 'POST'],
])
const HEX_64 = /^[0-9a-f]{64}$/

async function edgeOwnerKey(env) {
  const publicKeyHex = env.OWNER_PUBLIC_KEY_HEX
  if (publicKeyHex === undefined || publicKeyHex === '') ownerGrantFailure('OWNER_KEY_NOT_CONFIGURED', 503)
  if (typeof publicKeyHex !== 'string' || !HEX_64.test(publicKeyHex)) ownerGrantFailure('OWNER_KEY_INVALID', 503)
  return { publicKeyHex, keyId: `owner-ed25519-${publicKeyHex.slice(0, 12)}` }
}

async function edgeClass3(request, env, input) {
  const token = request.headers.get('x-x6-class3-approval')
  if (!token) ownerGrantFailure('CLASS3_WEBAUTHN_REQUIRED', 403)
  const url = new URL(request.url)
  const binding = await aumlokClass3Binding({ audience: url.origin, method: request.method, pathname: url.pathname, body: input })
  return bootstrapCall(env, 'HEAD', '/_head/class3-authorize', { token, binding })
}

async function edgeOwnerGrant(request, env, { now }) {
  if (request.method === 'GET') {
    const { publicKeyHex, keyId } = await edgeOwnerKey(env)
    return json({ ok: true, publicKeyHex, keyId })
  }
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  let input
  try { input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await request.arrayBuffer())) }
  catch { ownerGrantFailure('OWNER_GRANT_MALFORMED') }
  const unsignedBinding = input?.schema === 'aukora.hybrid-envelope.v2' ? null : normalizeOwnerGrantBinding(input, { now: now() })
  const head = await bootstrapCall(env, 'HEAD', '/_head/lease')
  if (unsignedBinding && (unsignedBinding.ballId !== head.ballId || unsignedBinding.epoch !== head.epoch)) ownerGrantFailure('OWNER_GRANT_STALE_BINDING', 409)
  if (!request.headers.get('x-x6-class3-approval')) ownerGrantFailure('CLASS3_WEBAUTHN_REQUIRED', 403)
  const identityResponse = await forward(new Request(new URL('/_host/aumlok/status', request.url)), env.HEAD, 'HEAD', (await bootstrapCall(env, 'HEAD', '/_head/bootstrap-status')).seedId)
  if (!identityResponse.ok) ownerGrantFailure('OWNER_IDENTITY_UNAVAILABLE', 503)
  const identity = await identityResponse.json()
  if (identity?.ok !== true || !['BOUND', 'UNBOUND'].includes(identity.phase)) ownerGrantFailure('OWNER_IDENTITY_UNAVAILABLE', 503)
  requireOwnerNodeKeySeparation(env.OWNER_PUBLIC_KEY_HEX, identity.nodePubkeyHex)
  const signed = input?.schema === 'aukora.hybrid-envelope.v2'
    ? await verifySignedOwnerGrant(input, { trustedKeys: { ed25519PublicKeyHex: env.OWNER_PUBLIC_KEY_HEX, mlDsaPublicKeyHex: env.OWNER_MLDSA_PUBLIC_KEY_HEX }, nodePublicKeyHex: identity.nodePubkeyHex, now: now() }) : null
  const binding = signed ? signed.binding : unsignedBinding
  if (binding.ballId !== head.ballId || binding.epoch !== head.epoch) ownerGrantFailure('OWNER_GRANT_STALE_BINDING', 409)
  const approval = await edgeClass3(request, env, input)
  normalizeOwnerGrantBinding(binding, { now: now() })
  const current = await bootstrapCall(env, 'HEAD', '/_head/lease')
  if (binding.ballId !== current.ballId || binding.epoch !== current.epoch) ownerGrantFailure('OWNER_GRANT_STALE_BINDING', 409)
  normalizeOwnerGrantBinding(binding, { now: now() })
  if (!Number.isFinite(approval.expiresAt) || approval.expiresAt <= now()) ownerGrantFailure('CLASS3_APPROVAL_EXPIRED', 403)
  // A passkey authorization is not an Ed25519 grant and never masquerades as one.
  return json(signed ? { ok: true, ownerGrant: signed.envelope } : { ok: true, authorization: 'bound-passkey-exact-action', binding })
}
const PROVIDERS = {
  deepseek: { origin: 'https://api.deepseek.com', secret: 'DEEPSEEK_API_KEY' },
  moonshot: { origin: 'https://api.moonshot.ai', secret: 'MOONSHOT_API_KEY' },
  'moonshot-cn': { origin: 'https://api.moonshot.cn', secret: 'MOONSHOT_CN_API_KEY' },
  openrouter: { origin: 'https://openrouter.ai/api', secret: 'OPENROUTER_API_KEY' },
  openai: { origin: 'https://api.openai.com', secret: 'OPENAI_API_KEY' },
  anthropic: { origin: 'https://api.anthropic.com', secret: 'ANTHROPIC_API_KEY' },
  xai: { origin: 'https://api.x.ai', secret: 'XAI_API_KEY' },
}
const json = (value, status = 200) => Response.json(value, { status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
const unavailable = capability => json({ ok: false, code: 'CLOUD_CAPABILITY_UNAVAILABLE', capability, macFallback: false }, 501)
/** The stamped source revision, or null when the stamp is absent or not a commit id. */
const stampedRevision = env => typeof env.SOURCE_REVISION === 'string' && /^[0-9a-f]{40,64}$/.test(env.SOURCE_REVISION) ? env.SOURCE_REVISION : null

/**
 * `GET /api/build`: the one signed-out read. It says only which source revision this Worker was stamped with, so the
 * cloud deploy and the witnesses can tell what is live. Constant cost: no durable object, no storage, no secret, no
 * request value reflected.
 */
export const BUILD_ROUTE = '/api/build'
function buildRevision(request, url, env) {
  if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
  if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  return json({ ok: true, schema: 'aukora.edge-build.v1', sourceRevision: stampedRevision(env) })
}

/**
 * Browser caching for static files. Files whose names carry a content hash (the build's `assets/` and `preview/`
 * chunks, the image's `preview/lazy/<sha256>` archives) never change under one name: cached for a year. The seed image
 * (`preview/vfs-image.tar.gz`, written by server/build-preview.mjs beside the preview bootstrap that fetches it) and the
 * Wasm cells keep their names across builds: kept, but revalidated by ETag on every use (only when the asset store
 * gave one). Everything else (HTML, the manifest, any other file, every non-200 answer) stays no-store. All of it is
 * `private`: it is only ever served to an owner session, so no shared cache may keep it.
 */
const HASHED_ASSET = /^\/(?:assets|preview)\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+-(?=[A-Za-z0-9_-]{8}\.)(?=[A-Za-z0-9_-]{0,7}[A-Z0-9_-])[A-Za-z0-9_-]{8}\.(?:js|mjs|css|wasm|woff2?|ttf|otf|eot|png|jpe?g|gif|webp|avif|svg|ico)$/
const LAZY_ARCHIVE = /^\/preview\/lazy\/[0-9a-f]{64}\.tar\.gz$/
const REVALIDATED_ASSET = /^\/(?:preview\/vfs-image\.tar\.gz|cells\/[a-z0-9-]{1,64}\.wasm)$/
export function staticCachePolicy(pathname, status, headers) {
  if (status !== 200 && status !== 304) return 'no-store'
  if (HASHED_ASSET.test(pathname) || LAZY_ARCHIVE.test(pathname)) return 'private, max-age=31536000, immutable'
  if (REVALIDATED_ASSET.test(pathname) && headers.has('etag')) return 'private, no-cache'
  return 'no-store'
}

const OWNER_SIGNIN_STYLE = `
/*
 * THE SPATIAL LOOK, carried by value: this page loads no file and no font, and the CSP admits only this block by its
 * hash. Every value is copied from the Spatial palette (packages/client/ui-layout/src/client/spatial/spatial-tokens.css,
 * dark half), the design platform (packages/client/ui-theme/src/styles/design-platform.css) or its base sheet
 * (packages/client/ui-theme/src/styles/base.css); each line names the token it came from.
 */
* { box-sizing: border-box; }
:root {
  color-scheme: dark;
  /* --dsh-font-family-text-default (base.css) */
  font: 100%/1.5 -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', 'Hiragino Sans GB', 'Microsoft YaHei', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  /* --aukora-text */
  color: rgb(232, 234, 237);
  /* --aukora-background */
  background-color: rgb(11, 13, 24);
}
body {
  margin: 0; padding: 16px; min-height: 100vh; display: grid; place-items: center;
  /* --dsw-specific-spatial-canvas, dark: --dsw-static-spatial-night-900 / -850 / -950 under the mint, violet and blue glows */
  background:
    radial-gradient(1200px 800px at 18% -10%, rgba(129, 212, 180, 0.1), transparent 60%),
    radial-gradient(1100px 760px at 82% 110%, rgba(196, 170, 255, 0.12), transparent 60%),
    radial-gradient(900px 700px at 50% 50%, rgba(150, 180, 255, 0.07), transparent 65%),
    linear-gradient(160deg, rgb(9, 10, 18) 0%, rgb(11, 13, 24) 55%, rgb(8, 9, 16) 100%);
  background-color: rgb(11, 13, 24);
}
main {
  width: 100%; max-width: 26rem; padding: clamp(20px, 6vw, 36px);
  /* --dsw-specific-spatial-lane (dark) on --aukora-border, --dsw-radius-panel */
  background: rgba(255, 255, 255, 0.043); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 28px;
}
h1 {
  margin: 0; font-size: 1.75rem; font-weight: 600; letter-spacing: 0.12em; line-height: 1.2;
  /* --dsw-static-neutral-bluish-00 */
  color: rgb(255, 255, 255);
}
.lede {
  margin: 6px 0 32px; font-size: 1rem;
  /* --dsw-static-spatial-blue (--aukora-blue) */
  color: rgb(150, 180, 255);
}
h2 { margin: 0 0 8px; font-size: 1.0625rem; font-weight: 600; color: rgb(255, 255, 255); }
p { margin: 0; overflow-wrap: anywhere; }
label, input, button { display: block; width: 100%; }
label { margin-top: 16px; font-weight: 500; }
input, button {
  margin-top: 8px; padding: 12px 16px; font: inherit; line-height: 1.4;
  /* --dsw-radius-md */
  border-radius: 12px;
  /* --ds-transition-duration, --ds-ease-in-out */
  transition: background-color 0.2s cubic-bezier(0.4, 0, 0.2, 1);
}
input {
  /* --aukora-backdrop, --aukora-text-muted, --aukora-text */
  background: rgba(8, 9, 16, 0.56); border: 1px solid rgb(139, 144, 153); color: rgb(232, 234, 237);
}
button {
  cursor: pointer; font-weight: 500;
  /* --dsw-specific-spatial-lane (dark), --aukora-text-muted, --aukora-text */
  background: rgba(255, 255, 255, 0.043); border: 1px solid rgb(139, 144, 153); color: rgb(232, 234, 237);
}
button:hover:not(:disabled) { background: rgba(255, 255, 255, 0.1); }
#passkey-submit {
  margin-top: 0; padding: 14px 16px; font-weight: 600;
  /* --dsw-static-spatial-blue fill, --dsw-static-spatial-night-950 label */
  background: rgb(150, 180, 255); border-color: rgb(150, 180, 255); color: rgb(8, 9, 16);
}
/* --dsw-static-deepseek-300 */
#passkey-submit:hover:not(:disabled) { background: rgb(183, 200, 254); border-color: rgb(183, 200, 254); }
button:disabled { cursor: wait; opacity: 0.6; }
input:disabled { opacity: 0.6; }
/* --dsw-static-spatial-blue */
:focus-visible { outline: 3px solid rgb(150, 180, 255); outline-offset: 3px; }
[role="status"] {
  margin-top: 12px;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
#passkey-status { min-height: 3em; }
#owner-status { min-height: 3em; }
#invite-check { margin-bottom: 28px; padding-bottom: 24px; border-bottom: 1px solid rgba(255, 255, 255, 0.1); }
#invite-help, #owner-help {
  margin-top: 8px; font-size: 0.9375rem;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
details { margin-top: 20px; padding-top: 16px; border-top: 1px solid rgba(255, 255, 255, 0.1); }
summary {
  cursor: pointer; padding: 4px 0; border-radius: 4px;
  /* --aukora-text-secondary */
  color: rgb(184, 188, 196);
}
summary:hover { color: rgb(232, 234, 237); }
noscript { display: block; margin-top: 16px; color: rgb(184, 188, 196); }
${PASSKEY_DEVICE_SIGNIN_LINK_STYLE /* DEVICES hook: the add-device link's colour, Spatial tokens by value */}@media (prefers-reduced-motion: reduce) { input, button { transition: none; } }
@media (forced-colors: active) {
  main, input, button { border: 1px solid CanvasText; }
  :focus-visible { outline-color: Highlight; }
}
`
const OWNER_SIGNIN_SCRIPT = `
(() => {
  // AN INVITE LINK (<origin>/#invite=<receipt>) lands on this page when no session is open. The receipt is public; the
  // invite code never travels in a link, so the guest types it. The fragment leaves the address bar at once and no part
  // of it is ever written into the page. The node's own guest door answers (POST /_host/aumlok/redeem); this page only
  // says what it answered. An invite grants no access today; if that changes, the node's answer will say so here.
  const PREFIX = '#invite=';
  const fragment = String((window.location && window.location.hash) || '');
  if (!fragment.startsWith(PREFIX)) return;
  // If the fragment cannot be taken out of the address bar, nothing is read from it and nothing is sent.
  let cleared = false;
  try { window.history.replaceState(null, '', window.location.pathname); cleared = true; } catch (error) { cleared = false; }
  const section = document.getElementById('invite-check');
  const form = document.getElementById('invite-form');
  const input = document.getElementById('invite-code');
  const button = document.getElementById('invite-submit');
  const status = document.getElementById('invite-status');
  if (!section || !form || !input || !button || !status) return;
  if (!cleared) {
    section.hidden = false;
    input.disabled = true;
    button.disabled = true;
    status.textContent = 'This invite could not be opened safely here: its link could not be taken out of the address bar. Nothing was sent. Open the invite link again.';
    return;
  }
  let invite = null;
  const raw = fragment.slice(PREFIX.length);
  if (raw.length > 0 && raw.length <= 8192 && /^[A-Za-z0-9_-]+$/.test(raw)) {
    try {
      const bytes = Uint8Array.from(atob(raw.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(raw.length / 4) * 4, '=')), character => character.charCodeAt(0));
      const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
      if (value && typeof value === 'object' && !Array.isArray(value)) invite = value;
    } catch (error) { invite = null; }
  }
  section.hidden = false;
  if (!invite) {
    input.disabled = true;
    status.textContent = 'This link does not carry an invite this page can read. Nothing was sent.';
    return;
  }
  const NOTHING = ' Nothing was granted.';
  const WORDS = {
    AUMLOK_INVITE_REDEEM_INVALID: 'This node refused the request as malformed. Nothing was checked.',
    AUMLOK_INVITE_SPONSOR_UNTRUSTED: 'This node did not sign this invite (another node did, or this node is not set up yet).' + NOTHING,
    AUMLOK_INVITE_NOT_FOUND: 'This node holds no invite like this one.' + NOTHING,
    AUMLOK_INVITE_REVOKED: 'This invite was revoked by the node that signed it.' + NOTHING,
    AUMLOK_INVITE_EXPIRED: 'This node says the invite is not valid at this time (it has expired, or its time has not come).' + NOTHING,
    AUMLOK_INVITE_CODE_INVALID: 'This node says the code is not the one this invite was made for.' + NOTHING,
    AUMLOK_REQUEST_TIMEOUT: 'The check took too long and was dropped.' + NOTHING,
    GUEST_DOOR_LOCKED: 'Too many checks came from this network, so this node is not checking invites from it for now.',
    GUEST_DOOR_BUSY: 'This node is turning away invite checks for now.',
    SAME_ORIGIN_BROWSER_REQUIRED: 'This node did not look at the invite: the check did not come from its own page. Nothing was checked.',
    BOOTSTRAP_REQUIRED: 'This node is not ready, so it checked nothing.',
    CLOUD_REQUEST_FAILED: 'This node is not ready, so it checked nothing.',
    AUMLOK_CONFIGURATION_UNAVAILABLE: 'This node is not ready, so it checked nothing.'
  };
  // The guest door's two refusals carry the wait the node gave (Retry-After, whole seconds). It is said only when it is a
  // plain bounded number; otherwise the page promises nothing.
  const WAITED = { GUEST_DOOR_LOCKED: true, GUEST_DOOR_BUSY: true };
  const waitWords = header => {
    const text = typeof header === 'string' ? header.trim() : '';
    if (!/^[0-9]{1,6}$/.test(text)) return '';
    const seconds = Number(text);
    if (seconds < 1 || seconds > 86400) return '';
    const minutes = Math.ceil(seconds / 60);
    const span = seconds < 60 ? 'less than a minute' : minutes === 1 ? 'about a minute' : minutes < 90 ? 'about ' + minutes + ' minutes'
      : 'about ' + Math.ceil(seconds / 3600) + ' hours';
    return ' The node asks for a wait of ' + span + ' before trying again.';
  };
  const answer = (code, body, retryAfter) => {
    if (code === 200 && body && body.ok === true && body.recipientStatus === 'CODE_VERIFIED' && body.accessGranted === false
      && body.identityEnrolled === false && body.inviteConsumed === false
      && (body.guestAccess === undefined || (body.guestAccess && body.guestAccess.available === false))) {
      const left = Number.isSafeInteger(body.expiresAt) && Number.isSafeInteger(body.verifiedAt) ? Math.floor((body.expiresAt - body.verifiedAt) / 86400000) : null;
      const until = left === null ? '' : left >= 2 ? ' (' + left + ' days left)' : left === 1 ? ' (1 day left)' : ' (less than a day left)';
      return 'This node checked the invite and its code: they match, and the invite is valid' + until + '. An invite grants no access today: '
        + 'nothing was signed in, no guest view was opened, and the invite was not used up.';
    }
    if (code === 200) return 'This node answered, but not in a form this page reads as an invite check.' + NOTHING;
    const refusal = body && typeof body.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(body.code) ? body.code : null;
    if (refusal && Object.prototype.hasOwnProperty.call(WAITED, refusal)) return WORDS[refusal] + (code === 429 ? waitWords(retryAfter) : '') + ' Nothing was checked.';
    if (refusal && Object.prototype.hasOwnProperty.call(WORDS, refusal)) return WORDS[refusal];
    return refusal ? 'This node refused the check (' + refusal + ').' + NOTHING : 'This node refused the check.' + NOTHING;
  };
  let busy = false;
  button.disabled = false;
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (busy) return;
    const code = input.value.trim();
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) {
      status.textContent = 'An invite code is 43 characters: letters, digits, - and _. Nothing was sent.';
      input.focus();
      return;
    }
    input.value = '';
    busy = true;
    input.disabled = true;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Asking this node about the invite…';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch('/_host/aumlok/redeem', { method: 'POST', headers: { 'content-type': 'application/json' },
        credentials: 'same-origin', redirect: 'error', cache: 'no-store', body: JSON.stringify({ invite, code }), signal: controller.signal });
      let body = null;
      try { body = await response.json(); } catch (error) { body = null; }
      status.textContent = answer(response.status, body, response.headers && typeof response.headers.get === 'function' ? response.headers.get('retry-after') : null);
    } catch (error) {
      status.textContent = 'No answer came back, so what this node said is not known. It was not sent again.';
    } finally {
      clearTimeout(timer);
      busy = false;
      input.disabled = false;
      button.disabled = false;
      form.removeAttribute('aria-busy');
    }
  });
})();
(() => {
  const form = document.getElementById('owner-signin');
  const input = document.getElementById('owner-token');
  const button = document.getElementById('owner-submit');
  const status = document.getElementById('owner-status');
  let attempt = null;
  const enable = () => {
    input.disabled = false;
    button.disabled = false;
    form.removeAttribute('aria-busy');
  };
  const clearPage = () => {
    input.value = '';
    const previous = attempt;
    attempt = null;
    if (previous) {
      clearTimeout(previous.timer);
      previous.controller.abort();
    }
    enable();
    status.textContent = '';
  };
  window.addEventListener('pagehide', clearPage);
  window.addEventListener('pageshow', clearPage);
  form.addEventListener('submit', async event => {
    event.preventDefault();
    if (attempt) { input.value = ''; return; }
    let token = input.value.trim();
    input.value = '';
    if (!token || token.length > 16384) {
      token = '';
      status.textContent = 'Paste a signed owner pass of at most 16 KiB.';
      input.focus();
      return;
    }
    const current = { controller: new AbortController(), timer: null };
    attempt = current;
    input.disabled = true;
    button.disabled = true;
    form.setAttribute('aria-busy', 'true');
    status.textContent = 'Signing in…';
    let timedOut = false;
    let navigating = false;
    const deadline = new Promise((resolve, reject) => {
      current.timer = setTimeout(() => {
        timedOut = true;
        reject(new Error('Sign-in timed out'));
        current.controller.abort();
      }, 10000);
    });
    try {
      let pending;
      try {
        pending = fetch('/_auth/owner', {
          method: 'POST', headers: { 'content-type': 'application/jwt' },
          credentials: 'same-origin', redirect: 'error', cache: 'no-store',
          body: token, signal: current.controller.signal
        });
      } finally { token = ''; }
      const response = await Promise.race([pending, deadline]);
      if (attempt !== current) return;
      if (response.status === 200) {
        window.location.replace(window.location.pathname === '/rescue' ? '/rescue' : '/');
        navigating = true;
        return;
      }
      status.textContent = response.status === 401
        ? 'This pass was not accepted. Paste a valid signed owner pass that has not run out, and try again.'
        : 'Sign-in could not complete. Paste the pass to try again.';
    } catch (error) {
      // Response bodies and exception messages may contain secrets or untrusted text.
      if (attempt === current) status.textContent = timedOut
        ? 'Sign-in timed out. Paste the pass to try again.'
        : 'Sign-in could not complete. Paste the pass to try again.';
    } finally {
      token = '';
      clearTimeout(current.timer);
      if (attempt === current && !navigating) {
        attempt = null;
        enable();
        input.focus();
      }
    }
  });
  clearPage();
})();
(() => {
  const button = document.getElementById('passkey-submit');
  const status = document.getElementById('passkey-status');
  if (!button || !status) return;
  const CHALLENGE = '/_auth/passkey/challenge', REOPEN = 'x61-owner-signin-reopen';
  const post = (path, value, signal) => fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin',
    redirect: 'error', cache: 'no-store', body: JSON.stringify(value), ...(signal ? { signal } : {}) });
  // A link from another site arrives without the SameSite=Strict session cookie; the page's own same-site challenge
  // request carries it. When that first answer says a live session envelope came with it, reopen once from this page (a
  // same-site navigation sends the cookie). This needs no passkey support, only that one request, and it happens at
  // most once: the reopened page carries the marker and never reopens again.
  const reopened = window.name === REOPEN;
  if (reopened) window.name = '';
  let arrival = !reopened, navigating = false;
  const reopen = issued => {
    const first = arrival;
    arrival = false;
    if (!first || navigating || !issued || issued.status !== 200 || issued.headers.get('x-x61-session') !== 'present') return false;
    navigating = true;
    window.name = REOPEN;
    window.location.replace(window.location.pathname === '/rescue' ? '/rescue' : '/');
    return true;
  };
  if (!window.PublicKeyCredential || !navigator.credentials || typeof navigator.credentials.get !== 'function') {
    status.textContent = 'This browser cannot use a passkey here. Use “Another way to sign in” below.';
    // Here that way is the only one, so it is shown open.
    const other = document.getElementById('owner-other');
    if (other) other.open = true;
    // Without passkeys the page makes that one request only when it was opened from another site: a direct or same-site
    // arrival already carried the Strict cookie, so it has no session to reopen into. (A link that strips the referrer
    // gives no sign; the signed owner pass below still works.)
    let from = '';
    try { from = document.referrer ? new URL(document.referrer).origin : ''; } catch (error) { from = ''; }
    if (arrival && from && from !== window.location.origin) post(CHALLENGE, {}).then(reopen, () => { arrival = false; });
    return;
  }
  const b64 = text => text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const encode = bytes => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
  const decode = text => Uint8Array.from(atob(b64(text)), character => character.charCodeAt(0));
  const refused = response => response.status === 429 ? 'Too many sign-in attempts from this network. Wait a few minutes and try again.'
    : 'This node did not accept the passkey sign-in. Try again.';
  const READY = 'Ready. Press “Sign in with passkey” again to use your passkey.';
  const RAN_OUT = 'The sign-in challenge ran out before the passkey answered. Nothing was sent. Press “Sign in with passkey” to try again.';
  const SLOW = 'This node answered too slowly.';
  // ONE HELD CHALLENGE, ONE CLOCK RULE. The challenge is fetched AHEAD of the click, so a press that prompts calls
  // credentials.get before any network wait (WebKit gives async work only a short user-activation window); a press
  // that finds no usable challenge never prompts: it starts or joins the one request and asks for one more press.
  //   held     at most one challenge: { sentWall, sentMono, lifeMs }, its request's send time on both clocks and the
  //            node's own issued-to-expiry span. Nothing else about its age is stored anywhere.
  //   age()    the LARGER of wall and monotonic time since the send (the node issued it no earlier), or Infinity if the
  //            wall clock went back. performance.now() can stand still while a Mac sleeps; the wall clock cannot hide
  //            that sleep, so the larger of the two is always the careful one.
  //   left()   lifeMs - MARGIN - age(): the time a proof can still reach the node. usable() is left() >= HOLD_LEFT (a
  //            phone sign-in needs that long). Every decision uses only these: publishing Ready, prompting on a press,
  //            the prompt's timeout and abort deadline, and the check just before the proof is sent.
  //   request  exactly one in flight, shared by every caller, under a generation number and a 10 s deadline; an answer
  //            from any other generation is ignored, so an older request can never clear or replace a newer challenge.
  const HOLD_LEFT = 60000, MARGIN = 5000, LIFE_CAP = 120000, REQUEST_MS = 10000, SLOW_RETRIES = 2, MAX_REFRESHES = 8;
  let held = null, inflight = null, generation = 0, waiting = false, slowRetries = 0, busy = false, timer = null, refreshes = 0;
  const age = current => {
    const wall = Date.now() - current.sentWall;
    return wall < 0 ? Infinity : Math.max(wall, performance.now() - current.sentMono);
  };
  const left = current => current.lifeMs - MARGIN - age(current);
  const usable = current => current !== null && left(current) >= HOLD_LEFT;
  const spanOf = challenge => {
    try {
      const payload = JSON.parse(atob(b64(challenge.challengeId.split('.')[0])));
      return payload.expiresAt === challenge.expiresAt && Number.isSafeInteger(payload.issuedAt) ? payload.expiresAt - payload.issuedAt : NaN;
    } catch (error) { return NaN; }
  };
  const optionsFor = key => ({ publicKey: { challenge: decode(key.challenge), rpId: key.rpId, userVerification: 'required',
    allowCredentials: key.allowCredentials.map(item => ({ type: 'public-key', id: decode(item.id), ...(Array.isArray(item.transports) ? { transports: item.transports } : {}) })),
    ...(Array.isArray(key.hints) ? { hints: key.hints } : {}) } });
  const deadlineSignal = () => {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(REQUEST_MS);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), REQUEST_MS);
    return controller.signal;
  };
  const idle = text => {
    waiting = false;
    if (text !== null) status.textContent = text;
    if (!busy && !navigating) button.disabled = false;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = null;
    // The refresh is only a convenience; usable() is checked again at every use.
    if (held && refreshes < MAX_REFRESHES && document.visibilityState !== 'hidden') {
      refreshes++;
      timer = setTimeout(() => { timer = null; request(); }, Math.max(1000, left(held) - HOLD_LEFT));
    }
  };
  const landed = (mine, sentWall, sentMono, issued, challenge) => {
    if (inflight === null || inflight.generation !== mine) return;
    inflight = null;
    if (navigating || reopen(issued)) return;
    const life = challenge && challenge.ok === true && challenge.publicKey && typeof challenge.challengeId === 'string'
      ? Math.min(spanOf(challenge), Number(challenge.publicKey.timeout), LIFE_CAP) : NaN;
    if (!(life >= HOLD_LEFT + MARGIN)) {
      if (!usable(held)) held = null;
      idle(waiting ? (challenge ? 'This node sent a sign-in challenge this page cannot use. Try again.' : refused(issued)) : null);
      return;
    }
    const next = { challengeId: challenge.challengeId, options: optionsFor(challenge.publicKey), sentWall, sentMono, lifeMs: life };
    if (!usable(next)) {
      // Stored and announced only if usable now. A slow answer is retried a bounded number of times, then waits for a press.
      if (!usable(held)) held = null;
      if (slowRetries < SLOW_RETRIES) { slowRetries++; status.textContent = SLOW + ' Asking it again…'; request(); return; }
      slowRetries = 0;
      idle(SLOW + ' Press “Sign in with passkey” to try again.');
      return;
    }
    slowRetries = 0;
    held = next;
    idle(waiting ? READY : null);
    schedule();
  };
  const failed = (mine, timedOut) => {
    if (inflight === null || inflight.generation !== mine) return;
    inflight = null;
    arrival = false;
    idle(waiting ? (timedOut ? 'This node did not answer in time. Press “Sign in with passkey” to try again.'
      : 'This node could not be reached. Press “Sign in with passkey” to try again.') : null);
  };
  const request = () => {
    if (inflight !== null || navigating) return;
    const mine = ++generation, sentWall = Date.now(), sentMono = performance.now(), signal = deadlineSignal();
    const stopped = new Promise((resolve, reject) => {
      if (signal.aborted) reject(new Error('timeout'));
      signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true });
    });
    const answer = (async () => {
      const issued = await post(CHALLENGE, {}, signal);
      return { issued, challenge: issued.status === 200 ? await issued.json() : null };
    })();
    inflight = { generation: mine };
    Promise.race([answer, stopped]).then(({ issued, challenge }) => landed(mine, sentWall, sentMono, issued, challenge),
      () => failed(mine, signal.aborted));
  };
  // Back from the background, a restored page, or focus: a challenge that is not usable by the one clock rule is dropped.
  const recheck = () => {
    if (busy || navigating || usable(held)) return;
    held = null;
    refreshes = 0;
    request();
  };
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recheck(); });
  window.addEventListener('pageshow', recheck);
  window.addEventListener('focus', recheck);
  const prompt = async current => {
    const controller = new AbortController(), until = left(current);
    let ranOut = false;
    current.options.publicKey.timeout = until;
    const stop = setTimeout(() => { ranOut = true; controller.abort(); }, until);
    status.textContent = 'Use your passkey (Touch ID, Face ID or your device lock).';
    try {
      const assertion = await navigator.credentials.get({ ...current.options, signal: controller.signal });
      clearTimeout(stop);
      if (ranOut || left(current) <= 0) { status.textContent = RAN_OUT; return; }
      if (!assertion) { status.textContent = 'No passkey was used. Nothing was sent.'; return; }
      const answer = assertion.response;
      const credential = { id: assertion.id, rawId: encode(assertion.rawId), type: assertion.type,
        clientExtensionResults: assertion.getClientExtensionResults(), response: { clientDataJSON: encode(answer.clientDataJSON),
          authenticatorData: encode(answer.authenticatorData), signature: encode(answer.signature),
          ...(answer.userHandle ? { userHandle: encode(answer.userHandle) } : {}) } };
      // Checked again at the last moment by the same clock rule: a proof past its deadline is never sent.
      if (left(current) <= 0) { status.textContent = RAN_OUT; return; }
      status.textContent = 'Checking the passkey with this node…';
      const done = await post('/_auth/passkey', { challengeId: current.challengeId, credential });
      if (done.status === 200) { navigating = true; window.location.replace(window.location.pathname === '/rescue' ? '/rescue' : '/'); return; }
      status.textContent = refused(done);
    } catch (error) {
      status.textContent = ranOut ? RAN_OUT : 'The passkey sign-in did not complete. Nothing was signed in.';
    } finally {
      clearTimeout(stop);
      busy = false;
      if (!navigating) {
        // A challenge is single use: fetch the next one so the next press can prompt at once.
        button.disabled = false;
        refreshes = 0;
        request();
      }
    }
  };
  button.disabled = false;
  button.addEventListener('click', () => {
    if (busy || navigating || waiting) return;
    clearTimeout(timer);
    timer = null;
    if (!usable(held)) {
      held = null;
      waiting = true;
      slowRetries = 0;
      button.disabled = true;
      status.textContent = 'Asking this node for a sign-in challenge…';
      request();
      return;
    }
    const current = held;
    held = null;
    busy = true;
    button.disabled = true;
    void prompt(current);
  });
  request();
})();
`
const OWNER_SIGNIN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Owner sign-in</title><style>${OWNER_SIGNIN_STYLE}</style></head>
<body><main><h1>AUKORA</h1><p class="lede">Owner sign-in</p>
<section id="invite-check" aria-labelledby="invite-heading" hidden><h2 id="invite-heading">You opened an invite</h2>
<p id="invite-help">An invite grants no access to this node today. This page can only ask the node whether the invite and its code are real.</p>
<form id="invite-form" method="post" autocomplete="off">
<label for="invite-code">Invite code (given to you privately)</label>
<input id="invite-code" type="text" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="64" aria-describedby="invite-help">
<button id="invite-submit" type="submit" disabled>Check invite</button>
<p id="invite-status" role="status" aria-live="polite" aria-atomic="true"></p>
</form></section>
<section id="passkey-signin" aria-label="Sign in with passkey">
<button id="passkey-submit" type="button" disabled>Sign in with passkey</button>
<p id="passkey-status" role="status" aria-live="polite" aria-atomic="true"></p></section>
${PASSKEY_DEVICE_SIGNIN_LINK /* DEVICES hook: a static link to the add page; this page's script is unchanged */}
<details id="owner-other"><summary>Another way to sign in</summary>
<form id="owner-signin" method="post" autocomplete="off">
<label for="owner-token">Signed owner pass</label>
<input id="owner-token" type="password" autocomplete="off" autocapitalize="none" spellcheck="false" maxlength="16384" aria-describedby="owner-help">
<p id="owner-help">A signed owner pass is made by the owner’s key on another machine. Pasted here, it is swapped for a secure browser session. This page cannot make or renew one.</p>
<button id="owner-submit" type="submit" disabled>Sign in</button>
<p id="owner-status" role="status" aria-live="polite" aria-atomic="true"></p>
</form></details><noscript>Enable JavaScript to sign in.</noscript></main><script>${OWNER_SIGNIN_SCRIPT}</script></body></html>`

/** Only explicit HTML document requests may receive sign-in; query values are never reflected or authenticated. Fragments are not sent over HTTP. */
function wantsOwnerSignin(request, url) {
  if (request.method !== 'GET' || !['/', '/index.html', '/preview.html'].includes(url.pathname)) return false
  const mode = request.headers.get('sec-fetch-mode'), destination = request.headers.get('sec-fetch-dest')
  if ((mode !== null && mode !== 'navigate') || (destination !== null && destination !== 'document')) return false
  const html = (request.headers.get('accept') || '').split(',').map(value => value.trim()).filter(value => value.split(';')[0].trim().toLowerCase() === 'text/html')
  if (html.length !== 1) return false
  const match = /^text\/html(?:\s*;\s*q=(0(?:\.[0-9]{0,3})?|1(?:\.0{0,3})?))?$/i.exec(html[0])
  return match !== null && (match[1] === undefined || Number(match[1]) > 0)
}

const signinCspHash = async text => "'sha256-" + btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))) + "'"
// Only the RESOLVED policy text is held between requests, never a pending promise: a promise left here by a request the
// runtime then cancels would never settle. A request that finds no text computes it itself (two SHA-256 digests).
let ownerSigninPolicy = null
/** The CSP admits exactly the page's one script and one style, by hashes computed from those bytes. */
async function ownerSignin() {
  let policy = ownerSigninPolicy
  if (policy === null) {
    const [script, style] = await Promise.all([signinCspHash(OWNER_SIGNIN_SCRIPT), signinCspHash(OWNER_SIGNIN_STYLE)])
    policy = ownerSigninPolicy = `default-src 'none'; base-uri 'none'; object-src 'none'; script-src ${script}; style-src ${style}; connect-src 'self'; form-action 'none'; frame-ancestors 'none'`
  }
  return new Response(OWNER_SIGNIN_HTML, { status: 401, headers: {
    'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
    'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer',
    'content-security-policy': policy,
  } })
}

/** Read mutating request bytes with an enforced streaming limit. */
export async function boundedRequest(request, limit = MAX_BODY, strict = false, timeoutMs = 0) {
  if (['GET', 'HEAD'].includes(request.method)) return request
  const declaredLength = request.headers.get('content-length')
  if (strict && declaredLength !== null && (!/^(0|[1-9][0-9]*)$/.test(declaredLength) || !Number.isSafeInteger(Number(declaredLength)))) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  if (strict && request.headers.has('content-encoding') && request.headers.get('content-encoding') !== 'identity') ownerGrantFailure('OWNER_GRANT_MALFORMED')
  if (Number(request.headers.get('content-length')) > limit) throw Object.assign(new Error('REQUEST_BODY_TOO_LARGE'), { status: 413 })
  const reader = request.body?.getReader()
  const chunks = []
  let size = 0
  if (reader) {
    let timer
    const deadline = timeoutMs > 0 ? new Promise((resolve, reject) => {
      timer = setTimeout(() => {
        reject(Object.assign(new Error('OWNER_LOGIN_TIMEOUT'), { code: 'OWNER_LOGIN_TIMEOUT', status: 408 }))
        // Cancellation must not delay the response if the underlying source stalls.
        void reader.cancel().catch(() => {})
      }, timeoutMs)
    }) : null
    try {
      for (;;) {
        const { done, value } = await (deadline ? Promise.race([reader.read(), deadline]) : reader.read())
        if (done) break
        size += value.byteLength
        if (size > limit) { await (deadline ? Promise.race([reader.cancel(), deadline]) : reader.cancel()); throw Object.assign(new Error('REQUEST_BODY_TOO_LARGE'), { status: 413 }) }
        chunks.push(value)
      }
    } finally { clearTimeout(timer); reader.releaseLock() }
  }
  if (strict && declaredLength !== null && Number(declaredLength) !== size) ownerGrantFailure('OWNER_GRANT_MALFORMED')
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  return new Request(request, { body: bytes, duplex: 'half' })
}

function forward(request, binding, name, seedId, access) {
  if (!binding) return json({ ok: false, code: 'CLOUD_BINDING_MISSING', binding: name }, 503)
  const headers = new Headers(request.headers)
  // Public request values never authorize an internal operation.
  headers.delete('x-x6-internal-authorized')
  headers.delete('x-x6-bootstrap-seed')
  headers.delete('x-x6-verified-access')
  if (access && ['owner', 'access'].includes(access.type) && typeof access.email === 'string' && Number.isFinite(access.expires)) headers.set('x-x6-verified-access', JSON.stringify({ type: access.type, email: access.email, expires: access.expires }))
  for (const name of [...headers.keys()]) if (name.startsWith('x-x6-aura-')) headers.delete(name)
  headers.set('x-x6-internal-authorized', '1')
  if (seedId) headers.set('x-x6-bootstrap-seed', seedId)
  return binding.get(binding.idFromName('node-main-v1')).fetch(new Request(request, { headers }))
}

// ANYBROWSER hook: the vault's `{ charge, count, release }` world budget, asked of MIRROR's internal-only route with this world's seed.
// ANYBROWSER hook: a refusal comes back as the budget's own answer; anything else throws, and the vault answers 503 BUDGET_UNAVAILABLE.
const vaultBudget = (env, seedId, signal) => { // ANYBROWSER hook
  const ask = op => async ({ kind, bytes, ref }) => { // ANYBROWSER hook
    if (!env.MIRROR) throw new Error('CLOUD_BINDING_MISSING') // ANYBROWSER hook
    const response = await env.MIRROR.get(env.MIRROR.idFromName('node-main-v1')).fetch(new Request('https://x61.internal/_mirror/world/budget', { method: 'POST', signal, // ANYBROWSER hook
      headers: { 'content-type': 'application/json', 'x-x6-internal-authorized': '1', 'x-x6-bootstrap-seed': seedId }, body: JSON.stringify({ op, kind, bytes, ...(ref === undefined ? {} : { ref }) }) })) // ANYBROWSER hook
    const answer = await response.json().catch(() => null) // ANYBROWSER hook
    if (!response.ok || answer?.ok !== true || !answer.budget || typeof answer.budget !== 'object') throw new Error('BUDGET_UNAVAILABLE') // ANYBROWSER hook
    return answer.budget // ANYBROWSER hook
  } // ANYBROWSER hook
  return { charge: ask('charge'), count: ask('count'), release: ask('release') } // ANYBROWSER hook
} // ANYBROWSER hook

const bootstrapFailure = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }) }

const estateCount = value => Number.isSafeInteger(value) && value >= 0
const estateTime = value => value === null || estateCount(value)
const estateBoolean = value => typeof value === 'boolean'
const estateEnum = values => value => values.includes(value)
// Explicit scalar fields only: neither upstream additions nor stored payloads become public.
function estateFields(value, fields) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) bootstrapFailure('ESTATE_PROJECTION_INVALID', 503)
  const output = {}
  for (const [key, check] of Object.entries(fields)) {
    if (!check(value[key])) bootstrapFailure('ESTATE_PROJECTION_INVALID', 503)
    output[key] = value[key]
  }
  return output
}

function estateHead(value) {
  if (value?.ok !== true || value.schema !== 'aukora.head-estate.v1') bootstrapFailure('ESTATE_PROJECTION_INVALID', 503)
  return { schema: value.schema, coverage: 'partial',
    head: estateFields(value.head, { ballId: value => typeof value === 'string' && HEX_64.test(value), epoch: estateCount }),
    lease: estateFields(value.lease, { active: estateBoolean, expiresAt: estateTime }),
    wake: estateFields(value.wake, { enabled: estateBoolean, intervalMs: estateCount, wakeCount: estateCount, nextWakeAt: estateTime, lastWakeAt: estateTime,
      lastWakeOutcome: estateEnum([null, ...WAKE_PROBE_STATUSES]),
      consecutiveUnacknowledgedWakes: value => estateCount(value) && value <= 3, autoPaused: estateBoolean,
      scheduleStatus: estateEnum(['disabled', 'alarm_missing', 'scheduled']), scheduledAlarmAt: estateTime }),
    repo: estateFields(value.repo, { staged: estateBoolean, pending: estateBoolean, lastOutcome: estateEnum([null, 'succeeded', 'failed', 'unknown']) }),
    transcript: estateFields(value.transcript, { lastSequence: estateCount }),
    inventory: { scope: 'allowlisted-metadata', rawKeysExposed: false, contentsExposed: false } }
}

async function estateRead(request, env, name, path, seedId, access) {
  const controller = new AbortController()
  let timer
  const aborted = () => controller.abort()
  request.signal.addEventListener('abort', aborted, { once: true })
  if (request.signal.aborted) controller.abort()
  try {
    return await Promise.race([
      (async () => {
        const response = await forward(new Request(new URL(path, request.url), { signal: controller.signal }), env[name], name, seedId, access)
        if (!response.ok) { void response.body?.cancel().catch(() => {}); bootstrapFailure('ESTATE_SOURCE_UNAVAILABLE', 503) }
        return await readBoundedBootstrapJson({ headers: response.headers, body: response.body, signal: controller.signal }, 16384)
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('ESTATE_SOURCE_TIMEOUT'), { code: 'ESTATE_SOURCE_TIMEOUT', status: 503 })) }, 10000) }),
    ])
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', aborted) }
}

/** Fixed-prefix R2 metadata only. Archive payloads and credential metadata are never read. */
async function estateArchiveMetadata(request, env) {
  const bucket = env.ARCHIVE_BUCKET
  const base = { ok: true, schema: 'aukora.archive-metadata.v1', configured: Boolean(bucket), coverage: 'metadata-only', integrityVerified: false }
  if (!bucket) return { ...base, status: 'unconfigured', backupStatus: 'unconfigured', objects: [], latest: null, truncated: false, omittedObjectCount: 0, prefixes: [], prefixSummaryComplete: false }
  if (!['list', 'get', 'head'].every(method => typeof bucket[method] === 'function')) bootstrapFailure('ARCHIVE_METADATA_UNAVAILABLE', 503)
  const controller = new AbortController(), abort = () => controller.abort()
  request.signal.addEventListener('abort', abort, { once: true })
  if (request.signal.aborted) controller.abort()
  let timer
  const validateObject = item => {
    const match = typeof item?.key === 'string' && /^snapshots\/epoch-([0-9]{1,16})-([0-9a-f]{64})\.json$/.exec(item.key)
    if (!match || !estateCount(Number(match[1])) || String(Number(match[1])) !== match[1]) return null
    if (!estateCount(item.size) || !(item.uploaded instanceof Date) || !estateCount(item.uploaded.getTime())) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
    return { epoch: Number(match[1]), ballId: match[2], bytes: item.size, uploadedAt: item.uploaded.getTime() }
  }
  const validateListing = listed => {
    if (!listed || !Array.isArray(listed.objects) || listed.objects.length > 64 || typeof listed.truncated !== 'boolean') bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
  }
  const summarize = (prefix, listed, objects, omittedObjectCount) => {
    const bytes = objects.reduce((total, item) => total + item.bytes, 0)
    if (!estateCount(bytes)) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
    return { prefix, examinedObjectCount: listed.objects.length, recognizedObjectCount: objects.length, bytes,
      truncated: listed.truncated, omittedObjectCount, complete: !listed.truncated && omittedObjectCount === 0 }
  }
  try {
    return await Promise.race([
      (async () => {
        controller.signal.throwIfAborted()
        const listed = await bucket.list({ prefix: 'snapshots/', limit: 64 })
        controller.signal.throwIfAborted()
        validateListing(listed)
        const objects = [], seen = new Set()
        let omittedObjectCount = 0
        for (const item of listed.objects) {
          const value = validateObject(item)
          if (!value) { if (item?.key !== 'snapshots/LATEST.json') omittedObjectCount++; continue }
          if (seen.has(item.key)) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
          seen.add(item.key); objects.push(value)
        }
        const prefixes = [summarize('snapshots/', listed, objects, omittedObjectCount)]
        for (const [prefix, pattern] of [['modules/', /^modules\/[0-9a-f]{64}\.js$/], ['files/', /^files\/[0-9a-f]{64}\.b64$/]]) {
          controller.signal.throwIfAborted()
          const page = await bucket.list({ prefix, limit: 64 })
          controller.signal.throwIfAborted()
          validateListing(page)
          const recognized = [], keys = new Set()
          let omitted = 0
          for (const item of page.objects) {
            if (typeof item?.key !== 'string' || !pattern.test(item.key)) { omitted++; continue }
            if (keys.has(item.key) || !estateCount(item.size) || !(item.uploaded instanceof Date) || !estateCount(item.uploaded.getTime())) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
            keys.add(item.key); recognized.push({ bytes: item.size })
          }
          prefixes.push(summarize(prefix, page, recognized, omitted))
        }
        controller.signal.throwIfAborted()
        const pointer = await bucket.get('snapshots/LATEST.json')
        if (controller.signal.aborted) {
          if (typeof pointer?.body?.cancel === 'function') void pointer.body.cancel().catch(() => {})
          controller.signal.throwIfAborted()
        }
        let latest = null
        if (pointer !== null) {
          if (!pointer || !estateCount(pointer.size) || pointer.size > 8192 || !pointer.body?.getReader) {
            if (typeof pointer?.body?.cancel === 'function') void pointer.body.cancel().catch(() => {})
            bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
          }
          const value = await readBoundedBootstrapJson({ headers: new Headers({ 'content-length': String(pointer.size) }), body: pointer.body, signal: controller.signal }, 8192)
          if (value?.schema !== COLD_ARCHIVE_SCHEMA || !estateCount(value.epoch) || value.r2Key !== `snapshots/epoch-${value.epoch}-${value.ballId}.json`) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
          latest = estateFields(value, { archiveId: value => typeof value === 'string' && HEX_64.test(value), ballId: value => typeof value === 'string' && HEX_64.test(value),
            exportedAt: estateCount, epoch: estateCount, moduleCount: estateCount, receiptCount: estateCount, checkpointCount: estateCount,
            merkleRoot: value => typeof value === 'string' && HEX_64.test(value), compositeHeadHash: value => typeof value === 'string' && HEX_64.test(value) })
          controller.signal.throwIfAborted()
          const stored = await bucket.head(value.r2Key)
          controller.signal.throwIfAborted()
          if (stored === null) bootstrapFailure('ARCHIVE_METADATA_TARGET_MISSING', 503)
          const target = validateObject(stored)
          if (stored?.key !== value.r2Key || !target) bootstrapFailure('ARCHIVE_METADATA_INVALID', 503)
          latest = { ...latest, object: target }
        }
        const backupStatus = latest ? 'snapshot-present' : prefixes.every(value => value.examinedObjectCount === 0 && !value.truncated) ? 'empty' : 'no-latest-pointer'
        return { ...base, status: 'observed', backupStatus, objects, latest, truncated: listed.truncated, omittedObjectCount, prefixes, prefixSummaryComplete: prefixes.every(value => value.complete) }
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('ARCHIVE_METADATA_TIMEOUT'), { code: 'ARCHIVE_METADATA_TIMEOUT', status: 503 })) }, 10000) }),
    ])
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort) }
}

async function estateProjection(request, env, bootstrap, access) {
  const seedId = bootstrap.head.seedId
  const [head, rawMirror, archive] = await Promise.all([
    estateRead(request, env, 'HEAD', '/_head/estate', seedId, access),
    estateRead(request, env, 'MIRROR', '/_mirror/estate', seedId, access),
    estateArchiveMetadata(request, env),
  ])
  if (rawMirror?.ok !== true || rawMirror.schema !== 'aukora.mirror-estate.v1') bootstrapFailure('ESTATE_PROJECTION_INVALID', 503)
  const mirror = estateFields(rawMirror, { entryCount: estateCount, fileCount: estateCount, directoryCount: estateCount, highWater: estateCount,
    // the tag may end in the representation (secret-path rule) version, `:r<n>`.
    snapshotETag: value => typeof value === 'string' && /^"x61-mirror-snapshot-v2:[0-9a-f-]{36}:[0-9]{1,16}(?::r[0-9]{1,6})?"$/.test(value),
    // how many stored entries the secret-path rule withholds (a count, never a path), and its one plain line.
    ...(rawMirror.withheldEntries === undefined && rawMirror.pathRuleNote === undefined ? {} : {
      withheldEntries: estateCount, pathRuleNote: value => typeof value === 'string' && value.length <= 80 }) })
  const selected = estateHead(head)
  return json({ ok: true, schema: 'aukora.edge-estate.v1', coverage: 'partial', head: selected, mirror,
    archive: { ...archive, latestMatchesSelectedHead: archive.latest === null ? null : archive.latest.epoch === selected.head.epoch && archive.latest.ballId === selected.head.ballId },
    worker: { sourceRevision: stampedRevision(env),
      capabilities: { head: Boolean(env.HEAD), mirror: Boolean(env.MIRROR), archive: Boolean(env.ARCHIVE_BUCKET), browser: Boolean(env.BROWSER) },
      secretPresence: Object.fromEntries(['GITHUB_TOKEN', 'CLOUDFLARE_API_TOKEN', ...Object.values(PROVIDERS).map(provider => provider.secret)].map(key => [key, typeof env[key] === 'string' && env[key].length > 0])) } })
}

async function estateAcknowledge(request, env, seedId, access, wakeId) {
  const controller = new AbortController()
  const aborted = () => controller.abort()
  request.signal.addEventListener('abort', aborted, { once: true })
  if (request.signal.aborted) controller.abort()
  let timer
  try {
    return await Promise.race([
      (async () => {
        const response = await forward(new Request(request, { signal: controller.signal }), env.HEAD, 'HEAD', seedId, access)
        const value = await readBoundedBootstrapJson({ headers: response.headers, body: response.body, signal: controller.signal }, 65536)
        if (!response.ok || value?.ok !== true) {
          const statuses = { WAKE_ACKNOWLEDGEMENT_STALE: 409, WAKE_STORE_DISPOSED: 409, WAKE_REQUEST_INVALID: 400,
            WAKE_STATE_INVALID: 503, BOOTSTRAP_REQUIRED: 503, UNAUTHORIZED: 401, ESTATE_OWNER_REQUIRED: 403 }
          if (value?.ok === false && Object.hasOwn(statuses, value.code) && statuses[value.code] === response.status) return json({ ok: false, code: value.code }, response.status)
          bootstrapFailure('ESTATE_SOURCE_UNAVAILABLE', 503)
        }
        if (response.status !== 200 || value.acknowledgedWakeId !== wakeId) bootstrapFailure('ESTATE_PROJECTION_INVALID', 503)
        return json({ ok: true, acknowledgedWakeId: wakeId, ...estateFields(value, { idempotent: estateBoolean,
          enabled: estateBoolean, intervalMs: estateCount, wakeCount: estateCount, nextWakeAt: estateTime, lastWakeAt: estateTime,
          consecutiveUnacknowledgedWakes: value => value === 0, autoPaused: value => value === false }) })
      })(),
      new Promise((resolve, reject) => { timer = setTimeout(() => { controller.abort(); reject(Object.assign(new Error('ESTATE_SOURCE_TIMEOUT'), { code: 'ESTATE_SOURCE_TIMEOUT', status: 503 })) }, 10000) }),
    ])
  } finally { clearTimeout(timer); request.signal.removeEventListener('abort', aborted) }
}

async function bootstrapCall(env, name, path, body, signal) {
  if (!env[name]) bootstrapFailure('CLOUD_BINDING_MISSING', 503)
  const controller = new AbortController(), deadlineAt = performance.now() + 60000
  let reader, timer, stopped, completed = false, rejectStopped
  const interrupted = new Promise((resolve, reject) => { rejectStopped = reject })
  const stop = (code, status) => {
    if (stopped) return
    stopped = Object.assign(new Error(code), { code, status })
    controller.abort()
    if (reader) void reader.cancel().catch(_error => {})
    rejectStopped(stopped)
  }
  const onAbort = () => stop('BOOTSTRAP_CANCELLED', 408)
  const check = () => {
    if (signal?.aborted) onAbort()
    if (performance.now() >= deadlineAt) stop('BOOTSTRAP_TIMEOUT', 503)
    if (stopped) throw stopped
  }
  timer = setTimeout(() => stop('BOOTSTRAP_TIMEOUT', 503), 60000)
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    const pending = Promise.resolve().then(() => {
      check()
      return env[name].get(env[name].idFromName('node-main-v1')).fetch(new Request('https://x61.internal' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'x-x6-internal-authorized': '1', 'content-type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: controller.signal,
      }))
    }).then(response => {
      if (stopped || performance.now() >= deadlineAt) {
        void response.body?.cancel().catch(_error => {})
        check()
      }
      return response
    })
    const response = await Promise.race([pending, interrupted])
    reader = response.body?.getReader()
    check()
    let text = '', bytes = 0
    const decoder = new TextDecoder('utf-8', { fatal: true })
    if (reader) for (;;) {
      const chunk = await Promise.race([reader.read(), interrupted])
      check()
      if (chunk.done) break
      bytes += chunk.value.byteLength
      if (bytes > 64 * 1024) bootstrapFailure('BOOTSTRAP_ACK_TOO_LARGE', 503)
      text += decoder.decode(chunk.value, { stream: true })
    }
    text += decoder.decode()
    const result = JSON.parse(text)
    check()
    if (!response.ok || result?.ok !== true) bootstrapFailure(typeof result?.code === 'string' ? result.code : 'BOOTSTRAP_ACK_MISSING', response.status >= 400 ? response.status : 503)
    completed = true
    return result
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (!completed && reader) void reader.cancel().catch(_error => {})
    reader?.releaseLock()
  }
}

async function bootstrapStatus(env, signal) {
  const [head, mirror] = await Promise.all([
    bootstrapCall(env, 'HEAD', '/_head/bootstrap-status', undefined, signal),
    bootstrapCall(env, 'MIRROR', '/_mirror/bootstrap-status', undefined, signal),
  ])
  const valid = value => typeof value.seedId === 'string' && HEX_64.test(value.seedId) && typeof value.ballId === 'string' && HEX_64.test(value.ballId) && Number.isSafeInteger(value.epoch) && value.epoch >= 0
  const ready = head.phase === 'complete' && mirror.phase === 'ready' && valid(head) && valid(mirror) && head.seedId === mirror.seedId && head.ballId === mirror.ballId && head.epoch === mirror.epoch
  return { ok: true, ready, head, mirror }
}

async function bootstrapOperation(request, env) {
  if (request.method === 'GET') return json(await bootstrapStatus(env, request.signal))
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  const input = await readBoundedBootstrapJson(request)
  if (input?.action === 'preflight' || input?.action === 'preflight-entries') {
    // NO WRITES: everything a seed import checks that can be checked before the first durable write. 'preflight' takes
    // the package (module hashes, limits), every deletion marker and the edge's emptiness; 'preflight-entries' takes every
    // entry's path, kind, mode and time in byte-bounded chunks (the import's own rules, strictly after `after`), so no
    // check request is ever larger than a write request.
    if (input.action === 'preflight-entries') {
      // Each entry's path, kind, mode and time judged by the import's own validateMirrorEntries (file contents are judged
      // by the page: canonical base64 and size), in strict order after `after`.
      if (!Array.isArray(input.entries) || !input.entries.length || input.entries.length > 10000 || typeof input.after !== 'string'
        || !Number.isSafeInteger(input.bytes) || input.bytes < 0 || !Number.isSafeInteger(input.count) || input.count < 0) bootstrapFailure('BOOTSTRAP_PREFLIGHT_ENTRIES_INVALID', 400)
      // The running export size, carried chunk to chunk from 'preflight' (which counted the opening, markers included),
      // grown here with the mirror's own entry accounting and held to the limit the import enforces.
      let previous = input.after, bytes = input.bytes, count = input.count
      for (const item of input.entries) {
        const path = Array.isArray(item) && typeof item[0] === 'string' ? item[0].slice(0, 4096) : null
        const meta = Array.isArray(item) && item.length === 2 && item[1] !== null && typeof item[1] === 'object' && !Array.isArray(item[1]) ? item[1] : null
        const file = meta?.kind === 'file'
        if (!meta || !['dir', 'file'].includes(meta.kind) || Object.keys(meta).some(name => !(file ? ['kind', 'mode', 'mtimeMs', 'b64Length'] : ['kind', 'mode']).includes(name))
          || (file && (!Number.isSafeInteger(meta.b64Length) || meta.b64Length < 0 || meta.b64Length % 4 !== 0 || meta.b64Length > Math.ceil(MIRROR_LIMITS.fileBytes / 3) * 4))) return json({ ok: false, code: 'INVALID_MIRROR_ENTRY', path }, 400)
        const wire = file ? { kind: 'file', mode: meta.mode, mtimeMs: meta.mtimeMs } : { kind: 'dir', mode: meta.mode }
        try { validateMirrorEntries([[item[0], file ? { ...wire, b64: '' } : wire]]) }
        catch (error) { return json({ ok: false, code: typeof error?.code === 'string' ? error.code : 'INVALID_MIRROR_ENTRY', path }, 400) }
        if (item[0] <= previous) return json({ ok: false, code: 'BOOTSTRAP_PATH_ORDER', path }, 400)
        previous = item[0]
        bytes += mirrorSnapshotEntryBytes(item[0], file ? { ...wire, b64: '' } : wire, file ? meta.b64Length : 0) + (count++ ? 1 : 0)
        if (bytes > MIRROR_LIMITS.snapshotBytes) return json({ ok: false, code: 'MIRROR_SNAPSHOT_TOO_LARGE', path, bytes }, 413)
      }
      return json({ ok: true, checked: input.entries.length, last: previous, bytes, count, written: false })
    }
    const seed = await bootstrapPackage(input.package)
    const resetPaths = bootstrapResetPaths(input.resetPaths)
    const current = await bootstrapStatus(env)
    if (current.head.phase !== 'empty' && current.head.seedId !== seed.seedId) bootstrapFailure('HEAD_ALREADY_INITIALIZED')
    if (current.mirror.phase !== 'empty' && current.mirror.seedId !== seed.seedId) bootstrapFailure('MIRROR_ALREADY_INITIALIZED')
    const bytes = mirrorSnapshotPrefixBytes(resetPaths)
    if (bytes > MIRROR_LIMITS.snapshotBytes) bootstrapFailure('MIRROR_SNAPSHOT_TOO_LARGE', 413)
    return json({ ok: true, seedId: seed.seedId, entryCount: seed.mirror.entryCount, resetCount: resetPaths.length, bytes, written: false })
  }
  if (input?.action === 'prepare') {
    const seed = await bootstrapPackage(input.package)
    const resetPaths = bootstrapResetPaths(input.resetPaths)
    const current = await bootstrapStatus(env)
    // No normal cloud routes are admitted before paired readiness, so these
    // checks are backed by the DO-local empty checks, not a permissive preflight.
    if (current.head.phase !== 'empty' && current.head.seedId !== seed.seedId) bootstrapFailure('HEAD_ALREADY_INITIALIZED')
    if (current.mirror.phase !== 'empty' && current.mirror.seedId !== seed.seedId) bootstrapFailure('MIRROR_ALREADY_INITIALIZED')
    const head = await bootstrapCall(env, 'HEAD', '/_head/bootstrap', { action: 'prepare', package: seed })
    const mirror = await bootstrapCall(env, 'MIRROR', '/_mirror/bootstrap', { action: 'begin', seedId: seed.seedId, ballId: seed.ball.ballId, epoch: seed.ball.epoch, mirror: seed.mirror, ...(resetPaths.length ? { resetPaths } : {}) })
    return json({ ok: true, seedId: seed.seedId, phase: head.phase === 'complete' ? 'complete' : 'prepared', head, mirror })
  }
  if (!input || typeof input.seedId !== 'string' || !/^[0-9a-f]{64}$/.test(input.seedId)) bootstrapFailure('INVALID_BOOTSTRAP_REQUEST', 400)
  const current = await bootstrapStatus(env)
  if (current.head.seedId !== input.seedId || current.mirror.seedId !== input.seedId) bootstrapFailure('BOOTSTRAP_SEED_CONFLICT')
  if (input.action === 'batch') return json(await bootstrapCall(env, 'MIRROR', '/_mirror/bootstrap', { action: 'batch', seedId: input.seedId, index: input.index, entries: input.entries }))
  if (input.action === 'commit') {
    const mirror = await bootstrapCall(env, 'MIRROR', '/_mirror/bootstrap', { action: 'commit', seedId: input.seedId })
    const head = await bootstrapCall(env, 'HEAD', '/_head/bootstrap', { action: 'commit', seedId: input.seedId })
    if (head.phase !== 'complete' || mirror.phase !== 'ready' || head.seedId !== mirror.seedId || head.ballId !== mirror.ballId || head.epoch !== mirror.epoch) bootstrapFailure('BOOTSTRAP_ACK_MISMATCH', 503)
    return json({ ok: true, seedId: input.seedId, phase: 'complete', head, mirror })
  }
  bootstrapFailure('BOOTSTRAP_ACTION_INVALID', 400)
}

async function providerDoor(request, env, url, seedId) {
  const match = url.pathname.match(/^\/door\/([a-z0-9-]+)(\/.*)$/)
  const provider = match && PROVIDERS[match[1]]
  if (!provider) return json({ ok: false, code: 'PROVIDER_UNAVAILABLE' }, 404)
  if (!['GET', 'POST'].includes(request.method) || !/^\/(?:(?:anthropic\/)?v1\/)?(?:models|chat\/completions|messages|responses)$/.test(match[2]) || url.search || url.hash
    || (match[2].endsWith('/models') ? request.method !== 'GET' : request.method !== 'POST')) return json({ ok: false, code: 'PROVIDER_ENDPOINT_UNAVAILABLE' }, 404)
  const limits = providerBudgetLimits(env)
  const rawKey = env[provider.secret]
  const key = typeof rawKey === 'string' ? rawKey.trim().replace(/^Bearer\s+/i, '').trim() : ''
  if (!key) return json({ ok: false, code: 'PROVIDER_SECRET_NOT_CONFIGURED', provider: match[1] }, 503)
  // The request has already passed boundedRequest. Read only that bounded copy, never the SSE response.
  const modelId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/@+ -]{0,199}$/.test(value) ? value : null
  const bodyBytes = request.method === 'POST' ? new Uint8Array(await request.arrayBuffer()) : undefined
  const reservation = providerRequestReservation(bodyBytes, limits, match[2])
  const { requestedModel } = reservation
  // New callers name the lifecycle parent and a separate per-request ID. Legacy
  // x-x6-turn-id alone remains a request ID, with no inferred parent association.
  const requestId = request.headers.get('x-x6-request-id')
  const turnId = request.headers.get('x-x6-turn-id')
  if (request.method === 'POST' && requestId !== null && turnId === null) bootstrapFailure('TURN_JOURNAL_PARENT_ID_REQUIRED', 400)
  const turnSummary = request.method === 'POST'
    ? await extractDoorTurnSummary(match[1], match[2], reservation.bodyBytes, {
        turnIdHeader: requestId ?? turnId,
        parentTurnIdHeader: requestId === null ? null : turnId,
        requestedModel,
      })
    : null
  await bootstrapCall(env, 'HEAD', '/_head/provider-budget', { provider: match[1], tokens: reservation.tokens }, request.signal)
  const turnJournal = turnSummary
    ? await bootstrapCall(env, 'HEAD', '/_head/turn-journal', turnSummary, request.signal)
    : null
  const turnJournalHeader = turnJournal?.entry
    ? JSON.stringify({
        savedBeforeInference: true,
        idempotent: Boolean(turnJournal.idempotent),
        seq: turnJournal.entry.seq,
        turnId: turnJournal.entry.turnId,
        parentTurnId: turnJournal.entry.parentTurnId,
        requestSha256: turnJournal.entry.requestSha256,
        signerRole: turnJournal.entry.signerRole,
      })
    : null
  let upstream
  try {
    const headers = new Headers({ 'content-type': 'application/json', 'x-x6-provider': match[1], 'x-x6-provider-endpoint': match[2] })
    if (turnJournal?.entry) {
      headers.set('x-x6-turn-id', turnJournal.entry.turnId)
      if (turnJournal.entry.parentTurnId) headers.set('x-x6-parent-turn-id', turnJournal.entry.parentTurnId)
    }
    if (request.headers.has('anthropic-beta')) headers.set('anthropic-beta', request.headers.get('anthropic-beta'))
    upstream = await forward(new Request('https://x61.internal/_head/provider-dispatch', {
      method: request.method, headers, body: reservation.bodyBytes, signal: request.signal,
    }), env.HEAD, 'HEAD', seedId)
  }
  catch (_error) {
    // Dispatch failures may follow provider spending. The durable reservation stays spent.
    // 5xx would trigger default client retries; explicit always-retry policies remain caller-owned.
    const response = json({ ok: false, code: 'PROVIDER_OUTCOME_UNKNOWN', outcome: 'unknown', retry: 'do-not-repeat-automatically',
      error: { type: 'provider_outcome_unknown', code: 'PROVIDER_OUTCOME_UNKNOWN', message: 'The provider may have processed this request. Its result is unknown. Do not automatically resubmit it.' } }, 422)
    response.headers.set('x-should-retry', 'false')
    if (turnJournalHeader) response.headers.set('x-x6-turn-journal', turnJournalHeader)
    return response
  }
  if (upstream.redirected || (upstream.status >= 300 && upstream.status < 400)) {
    void upstream.body?.cancel().catch(_error => {})
    return json({ ok: false, code: 'PROVIDER_REDIRECT_REFUSED' }, 502)
  }
  const output = new Headers({ 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  for (const header of ['content-type', 'retry-after', 'x-request-id', 'x-should-retry']) if (upstream.headers.has(header)) output.set(header, upstream.headers.get(header))
  const providerReportedModel = ['x-model', 'x-model-id', 'openai-model', 'anthropic-model', 'x-openrouter-model']
    .map(header => modelId(upstream.headers.get(header))).find(Boolean) ?? null
  output.set('x-x6-model-attribution', JSON.stringify({ requestedModel, providerReportedModel, immutableRevision: null, evidenceQuality: 'gateway-observed' }))
  if (turnJournalHeader) output.set('x-x6-turn-journal', turnJournalHeader)
  return new Response(upstream.body, { status: upstream.status, headers: output })
}

// Cloudflare supplies this header at the edge. Never use caller-selected identity,
// forwarded-for, ambient cookies, or a JWT claim to choose a login failure bucket.
async function ownerLoginSubject(request) {
  const address = request.headers.get('cf-connecting-ip') || 'unknown'
  const bytes = new TextEncoder().encode('/_auth/owner\0' + address)
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))
  return 'owner-login:' + [...hash].map(byte => byte.toString(16).padStart(2, '0')).join('')
}

/**
 * THE GUEST DOOR: the one route a caller with no session may reach. `GET` says what it is (so an invitee's page can tell
 * the edge from the Mac host before it sends a code); `POST { invite, code }` asks the AUMLOK store's read-only `redeem`,
 * which grants nothing and counts nothing. The door is guest-scoped: the request reaching HEAD carries no verified
 * access, only the redeem path, and a fresh body of exactly `{ invite, code }`. Its failures count only in its own
 * per-address table in the mirror object (`guestGateDecision`), never in the owner's sign-in lockout, the HEAD passkey
 * gate or the AUMLOK WebAuthn counters, so a stranger can never lock the owner out.
 */
export const GUEST_DOOR = Object.freeze({ route: '/_host/aumlok/redeem', maxBytes: 4096 })
/**
 * The network one guest-door row stands for: an IPv4 address as is; an IPv6 address by its /64 prefix (one subscriber
 * line usually holds a whole /64, so counting single IPv6 addresses would give one caller endless rows); an IPv4-mapped
 * IPv6 address as its IPv4 address. Anything that does not parse is used as it came (as before).
 */
export function guestNetwork(address) {
  const raw = typeof address === 'string' && address !== '' ? address : 'unknown'
  const value = raw.trim().toLowerCase()
  const four = text => {
    const octets = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text)
    return octets && octets.slice(1).every(octet => Number(octet) <= 255) ? octets.slice(1).map(Number) : null
  }
  if (four(value)) return four(value).join('.')
  let text = value.replace(/%[^%]*$/, '')
  const tail = /^(.*:)([^:]*\.[^:]*)$/.exec(text)
  if (tail) {
    const octets = four(tail[2])
    if (!octets) return raw
    text = tail[1] + ((octets[0] << 8) | octets[1]).toString(16) + ':' + ((octets[2] << 8) | octets[3]).toString(16)
  }
  const halves = text.split('::')
  if (halves.length > 2) return raw
  const parts = half => half === '' ? [] : half.split(':')
  const head = parts(halves[0]), rest = halves.length === 2 ? parts(halves[1]) : []
  const missing = 8 - head.length - rest.length
  if (halves.length === 2 ? missing < 1 : missing !== 0) return raw
  const groups = [...head, ...Array(halves.length === 2 ? missing : 0).fill('0'), ...rest]
  if (!groups.every(group => /^[0-9a-f]{1,4}$/.test(group))) return raw
  const numbers = groups.map(group => parseInt(group, 16))
  if (numbers.slice(0, 5).every(group => group === 0) && numbers[5] === 0xffff) {
    return [numbers[6] >> 8, numbers[6] & 255, numbers[7] >> 8, numbers[7] & 255].join('.')
  }
  return numbers.slice(0, 4).map(group => group.toString(16)).join(':') + '::/64'
}
async function guestSubjectOf(text) {
  const bytes = new TextEncoder().encode(GUEST_DOOR.route + '\0' + text)
  return 'guest-redeem:' + [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('')
}
/**
 * The caller's row (its network), and `legacy`: the subject the door used before rows stood for networks (the raw
 * address), sent only when it differs, so a penalty set under it before this deploy still holds (see LEGACY PENALTIES
 * at guestGateDecision in mirror-do.mjs, which says when this goes). An IPv4 caller's two subjects are the same.
 */
async function guestRedeemSubjects(request) {
  const address = request.headers.get('cf-connecting-ip')
  const subject = await guestSubjectOf(guestNetwork(address)), legacy = await guestSubjectOf(address || 'unknown')
  return legacy === subject ? { subject, legacy: null } : { subject, legacy }
}

/**
 * IN-ISOLATE SHIELD for the routes a caller with no session reaches. It runs before any durable call and only ever
 * answers sooner what the durable gates would answer anyway; it never admits anything they refuse. Per address: at most
 * `limit` requests in each `windowMs`, and a durable lock this isolate has already been told about is remembered until
 * it ends (at most `holdMs`), counted from when the durable request was SENT, so a slow reply never stretches it. The wait
 * it reports is the durable one (from that same send time), not its own shorter hold, so a caller is never told less.
 * The table is bounded; when full the oldest row goes, which can only weaken this shield,
 * never refuse a new address, so a stranger with many addresses cannot use it to turn anyone away.
 */
export const ISOLATE_SHIELD = Object.freeze({ guest: Object.freeze({ limit: 10, windowMs: 10000, holdMs: 60000, capacity: 1024 }),
  ownerLogin: Object.freeze({ holdMs: 30000, capacity: 1024 }), bootstrapMs: 5000 })
export function createIsolateShield({ limit = Infinity, windowMs = 10000, holdMs = 60000, capacity = 1024, shareWaitMs = SHARED_CALL_WAIT_MS, shareMaxWaits = SHARED_CALL_MAX_WAITS } = {}) {
  const rows = new Map(), checks = createSharedCalls({ waitMs: shareWaitMs, maxWaits: shareMaxWaits, capacity })
  const row = (subject, at) => {
    let value = rows.get(subject)
    if (value && at - value.start >= windowMs && value.lockedUntil <= at) { rows.delete(subject); value = undefined }
    if (!value) {
      if (rows.size >= capacity) rows.delete(rows.keys().next().value)
      value = { start: at, count: 0, lockedUntil: 0, unlockAt: 0 }
      rows.set(subject, value)
    }
    return value
  }
  return Object.freeze({
    /** One request from `subject`: `{ ok: true }`, or why not and for how long, without any durable call. */
    take(subject, at) {
      const value = row(subject, at)
      if (value.lockedUntil > at) return { ok: false, code: 'GATE_LOCKOUT_ACTIVE', retryAfterMs: Math.max(value.lockedUntil, value.unlockAt) - at }
      if (value.count >= limit) return { ok: false, code: 'ISOLATE_RATE_LIMITED', retryAfterMs: value.start + windowMs - at }
      value.count++
      return { ok: true }
    },
    /**
     * A durable gate answered a request sent at `sentAt` (received at `receivedAt`) that this subject is locked for
     * `retryAfterMs`. The gate counted that from its own reading of the time, no earlier than `sentAt`, so
     * `sentAt + retryAfterMs` is never later than the durable unlock. It is held here until
     * min(sentAt + retryAfterMs, receivedAt + holdMs): never past the durable lock, and never installed already expired.
     */
    locked(subject, sentAt, retryAfterMs, receivedAt = sentAt) {
      if (![sentAt, retryAfterMs, receivedAt].every(Number.isFinite) || retryAfterMs <= 0) return
      const until = Math.min(sentAt + retryAfterMs, receivedAt + holdMs)
      if (until > receivedAt) {
        const value = row(subject, receivedAt)
        value.lockedUntil = until
        // The wait reported to a caller is the durable one (from the same send time), never this shorter hold.
        value.unlockAt = sentAt + retryAfterMs
      }
    },
    /**
     * Concurrent callers for one subject share ONE in-flight read-only check (shared-call.mjs: a check whose request was
     * cancelled never settles, and nobody may wait on it for ever). A caller waits at most `shareMaxWaits` x its own
     * `shareWaitMs` on checks it did not start; while checks do not settle at most one new check starts per
     * `shareWaitMs` per subject, and a caller out of waits throws SHARED_CALL_BUSY (status 503), which the Worker's
     * fetch answers as a 503.
     * That per-subject bound holds while the subject's row is in the sharing table (`capacity` subjects with a check in
     * flight or awaited): past that the oldest subject loses its sharing and each of its waiting callers may start one
     * check. Never more checks than requests, never a hang.
     */
    share(subject, run) { return checks.call(subject, run) },
    size: () => rows.size,
  })
}

/** Readiness changes rarely and only towards ready in normal life; only a READY answer is held, and only briefly. */
async function cachedReadyBootstrap(env, signal, cache, now) {
  const at = now()
  if (cache.value && cache.until > at) return cache.value
  const value = await bootstrapStatus(env, signal)
  if (value.ready) { cache.value = value; cache.until = at + ISOLATE_SHIELD.bootstrapMs } else cache.value = null
  return value
}

async function guestRedeemDoor(request, env, url, origin, shield, now) {
  if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
  if (request.method === 'GET') {
    if (request.body !== null || (request.headers.has('content-length') && request.headers.get('content-length') !== '0')) return json({ ok: false, code: 'AUMLOK_REQUEST_INVALID' }, 400)
    return json({ ok: true, schema: 'aukora.guest-door.v1', runtime: 'cloudflare', route: GUEST_DOOR.route, method: 'POST', grants: 'nothing', counts: 'this-door-only' })
  }
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  if (origin !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) return json({ ok: false, code: 'AUMLOK_CONTENT_TYPE_REQUIRED' }, 400)
  const { subject, legacy } = await guestRedeemSubjects(request)
  // In-isolate first: a burst from one address is answered here, before any durable object is asked anything.
  const local = shield.guest.take(subject, now())
  if (!local.ok) return guestGateRefusal(local)
  // The bytes are read and shaped here before any durable call: a malformed body costs no durable work.
  let input = null
  try {
    const bounded = await boundedRequest(request, GUEST_DOOR.maxBytes, true, 10000)
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer()))
  } catch (error) { if (error?.status === 408) return json({ ok: false, code: 'AUMLOK_REQUEST_TIMEOUT' }, 408) }
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).sort().join() !== 'code,invite'
    || input.invite === null || typeof input.invite !== 'object' || Array.isArray(input.invite) || typeof input.code !== 'string' || input.code.length > 64) {
    return json({ ok: false, code: 'AUMLOK_INVITE_REDEEM_INVALID' }, 400)
  }
  const bootstrap = await cachedReadyBootstrap(env, request.signal, shield.bootstrap, now)
  if (!bootstrap.ready) return json({ ok: false, code: 'BOOTSTRAP_REQUIRED' }, 503)
  // Admission is reserved atomically before HEAD is asked; every well-formed attempt counts, so no burst outruns the limit.
  const sentAt = now()
  const gate = (await bootstrapCall(env, 'MIRROR', '/_mirror/guest-gate', { action: 'reserve', subject, ...(legacy ? { legacy } : {}) }, request.signal)).gate
  if (!gate?.ok) {
    // A legacy penalty holds one old address, not its whole network, so the isolate does not hold it for the network.
    if (gate?.code === 'GATE_LOCKOUT_ACTIVE' && gate.legacy !== true) shield.guest.locked(subject, sentAt, gate.retryAfterMs, now())
    return guestGateRefusal(gate)
  }
  // Only the redeem path, only these bytes, no verified access: forward() strips every internal header a caller sent.
  const response = await forward(new Request(new URL(GUEST_DOOR.route, url), { method: 'POST', signal: request.signal,
    headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin' },
    body: JSON.stringify({ invite: input.invite, code: input.code }) }), env.HEAD, 'HEAD', bootstrap.head.seedId, null)
  return new Response(response.body, { status: response.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } })
}

function guestGateRefusal(gate) {
  const response = json({ ok: false, code: gate?.code === 'GATE_LOCKOUT_ACTIVE' ? 'GUEST_DOOR_LOCKED' : 'GUEST_DOOR_BUSY' }, 429)
  if (Number.isFinite(gate?.retryAfterMs)) response.headers.set('retry-after', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
  return response
}

/**
 * OWNER SIGN-IN WITH THE BOUND PASSKEY, NO MAC STEP. The edge issues a stateless MAC'd challenge (single use, two
 * minutes, bound to this origin, its RP id, the bound credential and the identity generation); the AUMLOK store verifies
 * the UV assertion against the enrolled credential with the same verifier and counter rule as every approval; a short
 * server-side session (eight hours, revocable, ended by any re-bind) goes into an HttpOnly, Secure, SameSite=Strict,
 * host-only `__Host-` cookie. A session is not an approval: every Class 3 action still needs its own passkey assertion
 * over its exact bytes. Challenges are minted HERE under a per-generation key HEAD derives from the pepper, and every
 * proof is pre-checked HERE against the bound public key, so a stranger's attempts cost no durable call and there is no
 * per-address bucket for a stranger on the owner's network to fill. Nothing here touches any owner lockout counter.
 */
export const OWNER_PASSKEY = Object.freeze({ challenge: '/_auth/passkey/challenge', signin: '/_auth/passkey', signout: '/_auth/passkey/signout',
  cookie: '__Host-x61-owner', maxBytes: 16384, keyRefreshMs: 10000, hints: Object.freeze(['client-device', 'hybrid']) })
const passkeyRoutes = new Set([OWNER_PASSKEY.challenge, OWNER_PASSKEY.signin, OWNER_PASSKEY.signout])
const PASSKEY_TRANSPORTS = new Set(['usb', 'nfc', 'ble', 'internal', 'hybrid', 'smart-card'])

async function sessionEnvelopeLive(request, key, now) {
  const token = passkeyCookie(request)
  const parts = token === null ? null : sessionTokenParts(token)
  return parts !== null && parts.expiresAt > now() && parts.generation === key.generation && await sessionTokenAuthentic(key.sessionKeyHex, parts)
}

function passkeyCookie(request) {
  const cookies = request.headers.get('cookie')
  if (cookies === null || cookies.length > 32768) return null
  const found = cookies.split(';').map(value => value.trim()).filter(value => value.startsWith(OWNER_PASSKEY.cookie + '='))
  const token = found.length === 1 ? found[0].slice(OWNER_PASSKEY.cookie.length + 1) : ''
  // Only the envelope shape HEAD signs; anything else is no token at all (and costs nothing).
  return sessionTokenParts(token) === null ? null : token
}
const aumlokInternal = (url, action, body, request) => new Request(new URL('/_host/aumlok/' + action, url), { method: 'POST', signal: request.signal,
  headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin',
    ...(request.headers.has('cf-connecting-ip') ? { 'cf-connecting-ip': request.headers.get('cf-connecting-ip') } : {}) },
  body: JSON.stringify(body) })
const passkeySessionCookie = (token, maxAge) => `${OWNER_PASSKEY.cookie}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`

async function ownerPasskeyDoor(request, env, url, origin, keys, now) {
  if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
  if (request.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
  if (origin !== url.origin || request.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
  if (!/^application\/json(?:;\s*charset=utf-8)?$/i.test(request.headers.get('content-type') || '')) return json({ ok: false, code: 'AUMLOK_CONTENT_TYPE_REQUIRED' }, 400)
  if (url.pathname === OWNER_PASSKEY.signout) {
    const token = passkeyCookie(request)
    // No token, or one HEAD never signed: there is nothing to end, and nothing durable is asked.
    const parts = token === null ? null : sessionTokenParts(token)
    const unconfirmed = () => json({ ok: false, code: 'SIGNOUT_UNCONFIRMED', retry: true }, 503)
    let key = parts === null ? null : await signinKeyFor(env, url, keys, now)
    // A well-formed token, but HEAD's key could not be read: whether it is real is unknown, so nothing is claimed.
    if (key !== null && !key.ok) return unconfirmed()
    // A generation this isolate has not seen (a re-bind or rotation made through another isolate): refresh before
    // judging. If the refresh is not allowed yet or still does not reach it, the token's fate is unknown: say so and keep
    // the cookie. Only a token from an OLDER generation than HEAD's is known dead without asking.
    if (key !== null && parts.generation > key.generation) {
      key = await signinKeyFor(env, url, keys, now, 'upward')
      if (!key.ok || parts.generation > key.generation) return unconfirmed()
    }
    const authentic = key?.ok === true && parts.generation === key.generation && await sessionTokenAuthentic(key.sessionKeyHex, parts)
    if (authentic) {
      const seedId = key.seedId
      // Only HEAD's acknowledgement ends the session. Without it the cookie stays, so the owner can press again.
      const answer = await forward(aumlokInternal(url, 'signout', { token }, request), env.HEAD, 'HEAD', seedId, null)
      let body = null
      try { body = await answer.json() } catch (_error) { body = null }
      if (!answer.ok || body?.ok !== true) return json({ ok: false, code: 'SIGNOUT_UNCONFIRMED', retry: true }, 503)
    }
    const response = json({ ok: true })
    response.headers.set('set-cookie', passkeySessionCookie('', 0))
    return response
  }
  let input = null
  try {
    const bounded = await boundedRequest(request, OWNER_PASSKEY.maxBytes, true, 10000)
    input = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer()))
  } catch (_error) { input = null }
  const challenge = url.pathname === OWNER_PASSKEY.challenge
  const shaped = challenge ? input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).length === 0
    : input !== null && typeof input === 'object' && !Array.isArray(input) && Object.keys(input).sort().join() === 'challengeId,credential'
  if (!shaped) return json({ ok: false, code: 'AUMLOK_SIGNIN_INVALID' }, 400)
  // A challenge always reads HEAD's current credential and generation (one small read, shared by concurrent callers).
  let key = await signinKeyFor(env, url, keys, now, challenge ? 'fresh' : 'cached')
  if (!key.ok) return json({ ok: false, code: key.code }, key.status)
  if (challenge) {
    // Minted here: the same payload and MAC HEAD would make, under the per-generation issuance key.
    const issuedAt = now(), expiresAt = issuedAt + AUMLOK_SIGNIN_LIMITS.challengeMs
    const payload = signinPayloadText({ nonce: isoBase64URL.fromBuffer(crypto.getRandomValues(new Uint8Array(32))), origin: url.origin,
      generation: key.generation, credentialId: key.credentialId, issuedAt })
    const challengeId = isoBase64URL.fromBuffer(new TextEncoder().encode(payload)) + '.' + await signinChallengeMac(key.issuanceKeyHex, payload)
    // Transports go through only when the store recorded them; the hints let a browser without this passkey offer a phone.
    const response = json({ ok: true, schema: 'aukora.aumlok.signin-challenge.v1', challengeId, expiresAt, publicKey: { challenge: await signinChallengeDigest(payload), rpId: key.rpId,
      allowCredentials: signinAllowCredentials(key) /* DEVICES hook: every enrolled credential, each with its recorded transports */, userVerification: 'required',
      timeout: AUMLOK_SIGNIN_LIMITS.challengeMs, hints: OWNER_PASSKEY.hints } })
    // Whether this same-site request carries a session envelope this generation signed and that has not run out (checked
    // here with the key just read, no further durable call). The sign-in page uses it to reopen once after arriving by a
    // link from another site, which the SameSite=Strict cookie does not follow. It is a hint, never access: every request
    // that the reopen makes is judged by HEAD as before.
    response.headers.set('x-x61-session', await sessionEnvelopeLive(request, key, now) ? 'present' : 'absent')
    return response
  }
  // PRE-CHECK HERE, before HEAD: the challenge's MAC, its fields and expiry, and the assertion's signature, origin, RP id
  // and user verification against the bound public key. Only the owner's own passkey can pass, so no stranger's attempt
  // ever reaches durable state and no per-address bucket exists for anyone to fill. HEAD then decides for real.
  let precheck = await signinPrecheck(input, url, key, now)
  if (!precheck.ok && (precheck.code === 'AUMLOK_SIGNIN_CHALLENGE_INVALID' || signinCredentialFor(key, input.credential?.id) === null /* DEVICES hook */)) {
    // A re-bind changes the key and the credential: look once more (within the shared 10 s bound) before refusing.
    key = await signinKeyFor(env, url, keys, now, 'stale')
    if (!key.ok) return json({ ok: false, code: key.code }, key.status)
    precheck = await signinPrecheck(input, url, key, now)
  }
  if (!precheck.ok) return json({ ok: false, code: precheck.code }, precheck.status)
  const answer = await forward(aumlokInternal(url, 'signin', { challengeId: input.challengeId, credential: input.credential }, request), env.HEAD, 'HEAD', key.seedId, null)
  let body = null
  try { body = await answer.json() } catch (_error) { body = null }
  if (!answer.ok || body?.ok !== true || typeof body.sessionToken !== 'string' || !Number.isSafeInteger(body.expiresAt)) {
    // HEAD refused what this Worker's held key accepted: that key may be stale (a re-bind). Two separate steps:
    // (1) Expire the held value so the next request refreshes it, but only if it is still the one this request verified
    //     with (same generation and credential): a refusal that arrives late never expires a value of ANOTHER generation
    //     or credential read meanwhile. (A value re-read meanwhile with the same generation and credential is expired
    //     again: one extra read.)
    // (2) Whatever is held at this moment (that value, a newer one, a refusal, nothing): a read already in flight may
    //     carry the replaced credential, so none that started before this may publish (signinKeysInvalidated).
    if (['AUMLOK_SIGNIN_CHALLENGE_INVALID', 'AUMLOK_SIGNIN_PROOF_INVALID', 'AUMLOK_NOT_BOUND'].includes(body?.code)) {
      if (keys.value?.ok === true && keys.value.generation === key.generation && keys.value.credentialId === key.credentialId) keys.value = { ...keys.value, until: 0 }
      signinKeysInvalidated(keys)
    }
    return json({ ok: false, code: typeof body?.code === 'string' ? body.code : 'AUMLOK_UNAVAILABLE' }, answer.ok ? 503 : answer.status)
  }
  const maxAge = Math.floor((body.expiresAt - now()) / 1000)
  if (!Number.isSafeInteger(maxAge) || maxAge < 1) return json({ ok: false, code: 'AUMLOK_CLOCK_INVALID' }, 503)
  const response = json({ ok: true, expires: Math.floor(body.expiresAt / 1000) })
  response.headers.set('set-cookie', passkeySessionCookie(body.sessionToken, maxAge))
  return response
}

/**
 * The bound credential's PUBLIC key, the challenge key and the session key, from HEAD's internal `signin-key` (one small
 * call; the seed id is cached and re-read only when HEAD says it changed). Concurrent callers share one read in flight
 * (shared-call.mjs).
 *   'fresh'   every sign-in CHALLENGE asks for a read, so the next challenge after a re-bind names the new credential.
 *   'upward'  a session token claiming a newer generation may ask for one, at most once a second per isolate.
 *   'stale'   a proof that does not fit the cache (a re-bind elsewhere) may ask for one, at most once per 10 s.
 *   'cached'  anything else uses what is held (60 s; a refusal 10 s) and asks only when nothing live is held.
 * What an anonymous caller can cost: while reads settle, the bounds above, plus one small read per burst of concurrent
 * challenge requests. While reads do NOT settle (slow or abandoned), at most one new read per `shareWaitMs` per isolate,
 * however many callers wait; a caller waits at most `shareMaxWaits` x `shareWaitMs` PER SHARED READ on reads it did not
 * start and is then answered AUMLOK_UNAVAILABLE (503), which is not held. One call of this function makes at most two
 * shared reads (the second only when the first answer came from a read that began before an invalidation this call came
 * after), and one request can call it twice (a held answer, then 'upward' or 'stale'), so its worst case is four times
 * `shareMaxWaits` x `shareWaitMs` (the re-ask needs an invalidation inside the request); and an answer another read
 * produced meanwhile reaches a waiter only when its own timer fires. A read a caller starts itself has no deadline here
 * (readSigninKey's call to HEAD carries none): while HEAD does not answer, the one request per `shareWaitMs` that
 * starts a read waits until its own client gives up. No per-address state exists anywhere.
 * Publication: a read's answer is held only if no read started after it has been held (by call sequence, never by the
 * clock) and no invalidation happened since it started (a re-bind: it may carry the credential that was replaced).
 * Use: a caller never decides with the answer of a read that began before an invalidation it arrived after (it shared
 * that read): it asks once more, and if that answer is older still, it is answered AUMLOK_UNAVAILABLE (503, not held).
 */
async function signinKeyFor(env, url, keys, now, mode = 'cached') {
  const at = now(), current = keys.value, since = keys.fetchedAt === undefined ? Infinity : at - keys.fetchedAt
  const settled = current && current.until > at
  const wanted = mode === 'fresh' || !settled || (mode === 'stale' && since >= OWNER_PASSKEY.keyRefreshMs) || (mode === 'upward' && since >= 1000)
  if (!wanted && current) return current
  // Shared, but never awaited without the caller's own deadline (shared-call.mjs): the read belongs to the request that
  // started it, and a cancelled request (a reload is enough) would otherwise hang every later session in this isolate.
  keys.shared ??= createSharedCalls({ waitMs: keys.shareWaitMs ?? SHARED_CALL_WAIT_MS, maxWaits: keys.shareMaxWaits ?? SHARED_CALL_MAX_WAITS })
  // The invalidations this caller arrived after: an answer from a read that began before any of them is not its answer.
  const entered = keys.invalidations ?? 0
  try {
    for (let asks = 0; asks < 2; asks++) {
      const answer = await keys.shared.call('signin-key', async ({ seq }) => {
        // The clock is kept for the 'stale' and 'upward' throttles only; what may be published is decided by `seq`.
        keys.fetchedAt = now()
        const invalidations = keys.invalidations ?? 0
        const read = await readSigninKey(env, url, keys.seedId, now)
        if (seq > (keys.valueSeq ?? 0) && invalidations === (keys.invalidations ?? 0)) {
          keys.value = read.value
          keys.valueSeq = seq
          keys.seedId = read.seedId
        }
        return { value: read.value, invalidations }
      })
      if (answer.invalidations >= entered) return answer.value
      // Shared from a read that began before an invalidation this caller came after: ask once more (bounded).
    }
    return { ok: false, code: 'AUMLOK_UNAVAILABLE', status: 503, until: now() + 10000 }
  } catch (error) {
    if (error?.code !== SHARED_CALL_BUSY) throw error
    // Out of waits on other requests' reads and no answer: the same short refusal as an unreadable answer, never held.
    return { ok: false, code: 'AUMLOK_UNAVAILABLE', status: 503, until: now() + 10000 }
  }
}

/** The held sign-in key is no longer to be trusted (a re-bind or rotation): no read already in flight may publish. */
function signinKeysInvalidated(keys) { keys.invalidations = (keys.invalidations ?? 0) + 1 }

/**
 * One read of HEAD's internal `signin-key`; never throws (an unreadable answer is a short-lived refusal). It touches no
 * shared state: `{ value, seedId }` is the answer and the seed id THIS read used (null when HEAD says it changed), for
 * the caller to publish together or not at all.
 */
async function readSigninKey(env, url, knownSeedId, now) {
  let seedId = knownSeedId || null
  try {
    if (!seedId) {
      const bootstrap = await bootstrapStatus(env)
      if (!bootstrap.ready) return { seedId, value: { ok: false, code: 'BOOTSTRAP_REQUIRED', status: 503, until: now() + 10000 } }
      seedId = bootstrap.head.seedId
    }
    const internal = new Request(new URL('/_host/aumlok/signin-key', url), { method: 'POST', headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin' }, body: '{}' })
    const answer = await forward(internal, env.HEAD, 'HEAD', seedId, null)
    let body = null
    try { body = await answer.json() } catch (_error) { body = null }
    if (body?.code === 'BOOTSTRAP_REQUIRED') seedId = null
    const devices = signinKeyDevices(body) // DEVICES hook: enrolled devices' public keys, [] when none
    const valid = answer.ok && body?.ok === true && Number.isSafeInteger(body.generation) && typeof body.rpId === 'string' && typeof body.credentialId === 'string'
      && typeof body.publicKeyB64 === 'string' && /^[0-9a-f]{64}$/.test(body.issuanceKeyHex ?? '') && /^[0-9a-f]{64}$/.test(body.sessionKeyHex ?? '') && devices !== null
    // Transports are optional and only ever names from the WebAuthn list; anything else is dropped, never trusted.
    const transports = Array.isArray(body?.transports) && body.transports.length > 0 && body.transports.length <= 8
      && body.transports.every(value => PASSKEY_TRANSPORTS.has(value)) ? Object.freeze([...new Set(body.transports)]) : null
    return { seedId, value: valid ? { ok: true, generation: body.generation, rpId: body.rpId, credentialId: body.credentialId, publicKeyB64: body.publicKeyB64, devices, deviceCode: signinKeyDeviceCode(body) /* DEVICES hook */,
      issuanceKeyHex: body.issuanceKeyHex, sessionKeyHex: body.sessionKeyHex, transports, seedId, until: now() + 60000 }
      : { ok: false, code: typeof body?.code === 'string' ? body.code : 'AUMLOK_UNAVAILABLE', status: answer.ok ? 503 : answer.status, until: now() + 10000 } }
  } catch (_error) { return { seedId, value: { ok: false, code: 'AUMLOK_UNAVAILABLE', status: 503, until: now() + 10000 } } }
}

async function signinPrecheck(input, url, key, now) {
  const refused = (code, status) => ({ ok: false, code, status })
  const enrolled = signinCredentialFor(key, input.credential?.id) // DEVICES hook: the primary or an enrolled device
  if (typeof input.challengeId !== 'string' || input.challengeId.length > AUMLOK_SIGNIN_CHALLENGE_MAX || input.credential === null || typeof input.credential !== 'object'
    || enrolled === null) return refused(typeof input.challengeId === 'string' ? 'AUMLOK_SIGNIN_PROOF_INVALID' : 'AUMLOK_SIGNIN_INVALID', typeof input.challengeId === 'string' ? 403 : 400)
  const [encoded, tag, extra] = input.challengeId.split('.')
  if (extra !== undefined || !/^[A-Za-z0-9_-]+$/.test(encoded ?? '') || !/^[0-9a-f]{64}$/.test(tag ?? '')) return refused('AUMLOK_SIGNIN_CHALLENGE_INVALID', 403)
  let text
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(isoBase64URL.toBuffer(encoded)) } catch (_error) { return refused('AUMLOK_SIGNIN_CHALLENGE_INVALID', 403) }
  const hmac = await crypto.subtle.importKey('raw', Uint8Array.from(key.issuanceKeyHex.match(/../g), byte => parseInt(byte, 16)), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  // DEVICES hook: each check's answer is classified by proof-failure-rule.mjs. A strict false is 403; a
  // verifier that threw (the WebAuthn library's own throws too) or answered anything but a boolean reached no
  // verdict: 503 AUMLOK_UNAVAILABLE, never "wrong". Sign-in moves no budget either way.
  const mac = await proofOutcome(() => crypto.subtle.verify('HMAC', hmac, Uint8Array.from(tag.match(/../g), byte => parseInt(byte, 16)), new TextEncoder().encode(text)),
    { code: 'AUMLOK_SIGNIN_CHALLENGE_INVALID' })
  if (!proofIs(mac, 'ok')) return refused(mac.code, mac.status)
  const checked = signinPayloadCheck(text, { origin: url.origin, generation: key.generation, credentialId: key.credentialId, now: now() })
  if (!checked.payload) return refused(checked.code, checked.status)
  const ceremony = await signinChallengeDigest(text)
  // DEVICES hook: bytes that are not an assertion of the enrolled key's algorithm are malformed (400), never judged.
  if (!signinAssertionShape(input.credential, enrolled.publicKeyB64)) return refused('AUMLOK_SIGNIN_INVALID', 400)
  // DEVICES hook: THE SCREEN, before the library: type, challenge, origin, RP id and both flags are compared here
  // (403, nothing checked, nothing counted); the library's own throws after it are no verdict (503).
  const screened = await screenAssertion(input.credential, { challenge: ceremony, origin: url.origin, rpId: checked.payload.rpId,
    stored: { id: enrolled.id, publicKeyB64: enrolled.publicKeyB64, counter: 0 }, counterRule: false })
  if (!screened.pass) return screened.refusal === 'unavailable' ? refused('AUMLOK_UNAVAILABLE', 503)
    : SCREEN_POLICY.includes(screened.refusal) || screened.refusal === 'credential' ? refused('AUMLOK_SIGNIN_PROOF_INVALID', 403) : refused('AUMLOK_SIGNIN_INVALID', 400)
  // Counter 0 here: the signature, origin, RP id and UV are judged; the counter rule is HEAD's, with the stored counter.
  const proof = await proofOutcome(() => verifyAuthenticationResponse({ response: input.credential, expectedChallenge: ceremony, expectedOrigin: url.origin,
    expectedRPID: checked.payload.rpId, expectedType: 'webauthn.get', requireUserVerification: true,
    credential: { id: enrolled.id, publicKey: isoBase64URL.toBuffer(enrolled.publicKeyB64), counter: 0 } }), { code: 'AUMLOK_SIGNIN_PROOF_INVALID', judge: 'webauthn-authentication' })
  if (!proofIs(proof, 'ok')) return refused(proof.code, proof.status)
  return { ok: true }
}

/** passkeySessionAccess's answer for a session it could not check (a 503 key refusal); compared by identity. */
const OWNER_SESSION_PENDING = Object.freeze({ unavailable: true })
/**
 * The same, when the key could not be read because the edge is not seeded (BOOTSTRAP_REQUIRED: empty, or a restore left
 * half done). That does not clear by waiting, so a navigation still gets the sign-in page: its owner pass is the only way
 * to the restore page. API routes still get the 503.
 */
const OWNER_SESSION_UNSEEDED = Object.freeze({ unavailable: true, bootstrap: true })
/**
 * DEVICES hook (job 11 review): an ambient owner JWT whose check reached no verdict, with no passkey session to decide. Its
 * cookie is HttpOnly and lives up to a day, so if the check keeps failing a navigation must still reach the sign-in page
 * (his passkey is the way in), as on an unseeded edge; API routes still get the 503.
 */
const OWNER_JWT_PENDING = Object.freeze({ unavailable: true, ownerJwt: true })
/**
 * The owner access a passkey session cookie carries. The envelope is authenticated HERE first (a token HEAD never signed
 * costs no durable call); then HEAD decides EVERY TIME (one small read, no session cache): sign-out, expiry and a re-bind
 * (new generation) take effect on the very next request, in every isolate.
 * Returns that access, null (no session: the request is answered as signed out), or OWNER_SESSION_PENDING when the
 * cookie is a well-formed envelope that has not run out but the key it must be checked with could not be read (a 503
 * refusal: busy, unreadable; OWNER_SESSION_UNSEEDED when it is BOOTSTRAP_REQUIRED). Whether that session is live is
 * then unknown, so an API call is never answered as signed out (see ownerSessionUnavailable; only a navigation on an
 * unseeded edge gets the sign-in page). A key that WAS read decides as before: a fabricated or stale envelope, or HEAD
 * saying the session is not valid, gets null.
 */
async function passkeySessionAccess(request, env, keys, now) {
  const token = passkeyCookie(request)
  if (token === null || typeof env.OWNER_EMAIL !== 'string') return null
  const parts = sessionTokenParts(token)
  if (parts.expiresAt <= now()) return null
  const url = new URL(request.url)
  let key = await signinKeyFor(env, url, keys, now)
  if (key.ok && parts.generation > key.generation) key = await signinKeyFor(env, url, keys, now, 'upward')
  if (!key.ok && key.status === 503) return key.code === 'BOOTSTRAP_REQUIRED' ? OWNER_SESSION_UNSEEDED : OWNER_SESSION_PENDING
  if (!key.ok || parts.generation !== key.generation || !await sessionTokenAuthentic(key.sessionKeyHex, parts)) return null
  const answer = await forward(aumlokInternal(url, 'session', { token }, request), env.HEAD, 'HEAD', key.seedId, null)
  let body = null
  try { body = await answer.json() } catch (_error) { body = null }
  // Only the seed this request used is forgotten: a late answer never drops one a newer read has published.
  if (body?.code === 'BOOTSTRAP_REQUIRED' && keys.seedId === key.seedId) keys.seedId = null
  if (!answer.ok || body?.ok !== true || !Number.isSafeInteger(body.expiresAt) || body.expiresAt <= now()) return null
  return { type: 'owner', email: env.OWNER_EMAIL, expires: Math.floor(body.expiresAt / 1000) }
}

/** A signed-in request whose key could not be read: retry in a second. Never the sign-in page, never 401, cookie kept. */
function ownerSessionUnavailable() {
  const response = json({ ok: false, code: 'OWNER_SESSION_UNAVAILABLE' }, 503)
  response.headers.set('retry-after', '1')
  return response
}

async function ownerLoginGate(env, subject, action, proof) {
  // Bootstrap transport requires ok:true. The internal endpoint wraps the gate
  // decision so a 429 remains a gate result rather than a transport failure.
  // DEVICES hook: a failure carries `proof`, relayWrong's claim for a checked-wrong owner-JWT signature (HEAD
  // refuses a failure without it); check and success carry nothing else.
  const result = await bootstrapCall(env, 'HEAD', '/_head/gate-lockout', action === 'failure' ? { action, subject, proof } : { action, subject })
  const gate = result.gate
  if (!gate || typeof gate.ok !== 'boolean') bootstrapFailure('GATE_RESPONSE_INVALID', 503)
  return gate
}

function ownerLoginGateResponse(gate) {
  const response = json(gate, gate.status === 429 ? 429 : 503)
  if (Number.isFinite(gate.retryAfterMs)) response.headers.set('retry-after', String(Math.max(1, Math.ceil(gate.retryAfterMs / 1000))))
  return response
}

const edgeNetworkFetch = (url, init) => fetch(url, init?.redirect === 'error' ? { ...init, redirect: 'manual' } : init)

/** Create a host; approval injection is trusted process configuration, never a request or environment flag. */
export function createWorker({ verifyAccess, networkFetch = edgeNetworkFetch, approveRepoPublication = approveConsumedRepoPublication, launchBrowser = null, now = Date.now, shareWaitMs = SHARED_CALL_WAIT_MS, shareMaxWaits = SHARED_CALL_MAX_WAITS } = {}) {
  const diagnostics = createEdgeDiagnostics('worker-isolate', now)
  const verifyOwnerLogin = createOwnerLoginVerifier({ now }) // DEVICES hook: screened first, then checked; never a bare null
  const ownerLoginSlots = createLoginSlots() // DEVICES hook: per address, signature checks in flight <= failures left
  const signinKeys = { value: null, shareWaitMs, shareMaxWaits }
  const shield = { guest: createIsolateShield({ ...ISOLATE_SHIELD.guest, shareWaitMs, shareMaxWaits }), ownerLogin: createIsolateShield({ ...ISOLATE_SHIELD.ownerLogin, shareWaitMs, shareMaxWaits }), bootstrap: { value: null, until: 0 } }
  // NOSTR hook: one 60 s cache and its own shield rows (per network, apart from the guest door's) for the signed-out Nostr reads.
  const nostrReadDoor = createNostrReadDoor({ now, shareWaitMs, shareMaxWaits, shield: createIsolateShield(ISOLATE_SHIELD.guest), subjectOf: request => 'nostr-read:' + guestNetwork(request.headers.get('cf-connecting-ip')) })
  // DEVICES hook: an owner JWT whose check reached no verdict answers OWNER_JWT_UNVERIFIED (not null).
  verifyAccess ??= createAccessVerifier({ now, unverified: OWNER_JWT_UNVERIFIED })
  return {
    async fetch(incoming, env) {
      return diagnostics.observe(incoming, async () => {
      try {
        const url = new URL(incoming.url)
        if (url.protocol !== 'https:' || !env.PUBLIC_HOST || url.host !== env.PUBLIC_HOST) return json({ ok: false, code: 'HOST_REFUSED' }, 403)
        if (url.pathname === BUILD_ROUTE) return buildRevision(incoming, url, env)
        // NOSTR hook: signed out, read-only, cached; HEAD is asked at most once per isolate per minute while its reads settle
        // (while they do not: at most one new read per `shareWaitMs`, see createNostrReadDoor).
        if (NOSTR_PUBLIC_ROUTES.has(url.pathname)) return await nostrReadDoor.serve(incoming, url, signal => bootstrapCall(env, 'HEAD', NOSTR_ANCHOR_LATEST_PATH, undefined, signal))
        if (!ownerAccessConfigured(env)) return json({ ok: false, code: 'OWNER_ACCESS_NOT_CONFIGURED' }, 503)
        const origin = incoming.headers.get('origin')
        if (origin && origin !== url.origin) return json({ ok: false, code: 'ORIGIN_REFUSED' }, 403)
        if (incoming.headers.get('sec-fetch-site') === 'cross-site' && !['GET', 'HEAD'].includes(incoming.method)) return json({ ok: false, code: 'CROSS_SITE_REFUSED' }, 403)
        // ANYBROWSER hook: the vault's fetch-site rules, before the session is read: a write must come from her own page (its
        // ANYBROWSER hook: Origin and `sec-fetch-site: same-origin`); a read from her own page or the owner's own navigation
        // ANYBROWSER hook: (`none` + `navigate`). Anything else (`same-site`, `cross-site`, no fetch mark) is refused with the
        // ANYBROWSER hook: answer a signed-out caller gets on any /_vault/ path (401 OWNER_ACCESS_REQUIRED): no session,
        // ANYBROWSER hook: bootstrap or key read, and nothing new to learn about the path.
        if (url.pathname.startsWith('/_vault/') && (['GET', 'HEAD'].includes(incoming.method) // ANYBROWSER hook
          ? incoming.headers.get('sec-fetch-site') !== 'same-origin' && !(incoming.headers.get('sec-fetch-site') === 'none' && incoming.headers.get('sec-fetch-mode') === 'navigate') // ANYBROWSER hook
          : origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401) // ANYBROWSER hook
        if (url.pathname === '/_auth/owner') {
          if (url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (incoming.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (incoming.headers.get('content-type') !== 'application/jwt') return json({ ok: false, code: 'OWNER_LOGIN_MALFORMED' }, 400)
          const bounded = await boundedRequest(incoming, 16384, true, 10000)
          let token
          try { token = new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer()) }
          catch { return json({ ok: false, code: 'OWNER_LOGIN_MALFORMED' }, 400) }
          // Only the posted JWT authenticates this exchange. Ambient credentials cannot
          // substitute for it or prevent replacing an independently signed owner token.
          const subject = await ownerLoginSubject(incoming)
          // A lock HEAD already reported for this address is answered here until it ends: no durable call, and nothing
          // HEAD would admit is refused (an active lock is never lifted early, not even by a valid token).
          const known = shield.ownerLogin.take(subject, now())
          if (!known.ok) return ownerLoginGateResponse({ ok: false, code: known.code, status: 429, retryAfterMs: known.retryAfterMs })
          // A lock is remembered from when its request was sent, capped from when its reply arrived. The read-only check is
          // shared by concurrent requests from one address; failure and success are still recorded per request.
          const ask = async (action, proof) => {
            const sentAt = now(), gate = await ownerLoginGate(env, subject, action, proof)
            if (!gate.ok && gate.code === 'GATE_LOCKOUT_ACTIVE') shield.ownerLogin.locked(subject, sentAt, gate.retryAfterMs, now())
            return gate
          }
          // DEVICES hook: THE ONE RULE AT THE OWNER LOGIN. Only a checked-WRONG signature on a well-formed, in-window
          // owner JWT records a failure (its branded outcome becomes the closed field HEAD requires). A JWT refused before its
          // signature is checked (malformed, out of its window, another audience, issuer or owner) is 401 and moves nothing;
          // a check that reached no verdict is 503 and moves nothing. (Review of job 10:) those two are answered HERE, before
          // any durable call, so junk at this signed-out door costs the owner's HEAD nothing.
          const screened = verifyOwnerLogin(token, env)
          if (screened.kind === 'refused') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
          if (screened.kind !== 'screened') {
            const response = json({ ok: false, code: 'OWNER_LOGIN_UNAVAILABLE' }, 503)
            response.headers.set('retry-after', '1')
            return response
          }
          const gate = await shield.ownerLogin.share(subject, () => ask('check'))
          if (!gate.ok) return ownerLoginGateResponse(gate)
          // DEVICES hook: the gate bounds failures STORED; this bounds signature checks IN FLIGHT for this
          // address to the failures left before the lock (never more than the budget). Any other request is answered at
          // once, the lock's 429 shape with a short wait. The slot is let go when this request settles, and at its own
          // deadline if it never does (owner-login-slots.mjs).
          const left = GATE_LOCKOUT_DEFAULTS.maxFailures - (Number.isSafeInteger(gate.failures) && gate.failures >= 0 ? gate.failures : GATE_LOCKOUT_DEFAULTS.maxFailures - 1)
          const slot = ownerLoginSlots.take(subject, left, now())
          if (slot === null) return ownerLoginGateResponse({ ok: false, code: 'OWNER_LOGIN_CHECKS_BUSY', status: 429, retryAfterMs: OWNER_LOGIN_SLOTS.waitMs })
          // DEVICES hook: THE CHECK AND ITS GATE CALL RUN UNDER THE LEASE'S OWN DEADLINE. When it passes first, the
          // request is FENCED: it answers 503 (retry in a second) and nothing that arrives later is acted on (no cookie, no
          // success recorded, no failure counted). The lease ends then; the signature check keeps its place in the table
          // until its own promise settles (owner-login-slots.mjs `check`), so leases that expire never admit more checks
          // than the budget. Everything here is this request's own: no promise is left for another request to wait on.
          let fenced = false, timer
          const deadline = new Promise(resolve => { timer = setTimeout(() => { fenced = true; resolve(null) }, OWNER_LOGIN_SLOTS.holdMs) })
          const operation = (async () => {
            const judged = await slot.check(() => screened.check())
            if (fenced) return null
            if (judged.kind === 'unavailable') return null
            if (judged.kind === 'wrong') {
              const failed = await ask('failure', relayWrong(judged.outcome))
              if (fenced) return null
              return failed.ok ? json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401) : ownerLoginGateResponse(failed)
            }
            const identity = judged.kind === 'ok' ? judged.identity : null
            const maxAge = identity?.type === 'owner' ? Math.floor(identity.expires - now() / 1000) : 0
            if (!Number.isSafeInteger(maxAge) || maxAge < 1 || maxAge > 86400) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
            const cleared = await ask('success')
            if (fenced) return null
            if (!cleared.ok) return ownerLoginGateResponse(cleared)
            const response = json({ ok: true, expires: identity.expires })
            response.headers.set('set-cookie', `CF_Authorization=${token}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`)
            return response
          })()
          // A fenced operation that later fails has nobody to answer: its rejection is observed here, never left unhandled.
          operation.catch(() => {})
          try {
            const answer = await Promise.race([operation, deadline])
            if (answer !== null) return answer
            // No verdict, no answer by the deadline, or an answer fenced: OWNER_LOGIN_UNAVAILABLE, retry in a second.
            const response = json({ ok: false, code: 'OWNER_LOGIN_UNAVAILABLE' }, 503)
            response.headers.set('retry-after', '1')
            return response
          } finally { clearTimeout(timer); slot.release() }
        }
        if (passkeyRoutes.has(url.pathname)) return await ownerPasskeyDoor(incoming, env, url, origin, signinKeys, now)
        // DEVICES hook: the code-bearing "add this device" door, reachable without a session (passkey-devices.mjs).
        if (url.pathname === PASSKEY_DEVICE_ROUTES.addChallenge || url.pathname === PASSKEY_DEVICE_ROUTES.add) return await passkeyDeviceDoor(incoming, env, url, origin, { forward, boundedRequest, keys: signinKeys, keyFor: mode => signinKeyFor(env, url, signinKeys, now, mode), invalidated: () => signinKeysInvalidated(signinKeys) })
        // DEVICES hook: an ambient owner JWT whose check reached no verdict is not "signed out" either: a
        // passkey session can still decide; without one the request is answered as a session that could not be checked
        // (503, retry in a second, cookie kept), exactly as a busy key read is.
        const ambient = await verifyAccess(incoming, env)
        let access = (ambient === OWNER_JWT_UNVERIFIED ? null : ambient) ?? await passkeySessionAccess(incoming, env, signinKeys, now)
        if (access === null && ambient === OWNER_JWT_UNVERIFIED) access = OWNER_JWT_PENDING
        // A live-looking session whose key could not be read is not "signed out": 503, retry in a second, cookie kept (API
        // routes and navigations alike). The guest door alone is still served as to anyone without a session; and on an
        // unseeded edge, or for an owner JWT whose check reached no verdict (job 11 review), a navigation still gets the
        // sign-in page (the owner pass there leads to the restore page; the passkey signs in past the stuck cookie).
        if (access === OWNER_SESSION_PENDING || access === OWNER_SESSION_UNSEEDED || access === OWNER_JWT_PENDING) {
          // ANYBROWSER hook: /rescue opened while the key read is busy: a small page with one link back to /rescue (never `/`).
          if (access === OWNER_SESSION_PENDING && wantsRescueDocument(incoming, url)) return await rescueBusyResponse() // ANYBROWSER hook
          // ANYBROWSER hook: an owner JWT whose check reached no verdict is answered on /rescue as main answers it on `/`: the sign-in page.
          if (access === OWNER_JWT_PENDING && wantsRescueDocument(incoming, url)) return await ownerSignin() // ANYBROWSER hook
          if (url.pathname !== GUEST_DOOR.route && !(access !== OWNER_SESSION_PENDING && wantsOwnerSignin(incoming, url))) return ownerSessionUnavailable()
          access = null
        }
        if (!access && url.pathname === GUEST_DOOR.route) return await guestRedeemDoor(incoming, env, url, origin, shield, now)
        if (!access && wantsRescueDocument(incoming, url)) return await ownerSignin() // ANYBROWSER hook: signed out on /rescue: the owner sign-in page itself
        if (!access) return wantsOwnerSignin(incoming, url) ? await ownerSignin() : json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 401)
        const estateRoute = url.pathname === '/_host/estate'
        // DEVICES hook: the devices list is an owner-only GET read, judged exactly as the invites list.
        const aumlokInvitesRoute = url.pathname === '/_host/aumlok/invites' || url.pathname === PASSKEY_DEVICE_ROUTES.list
        let estateInput
        if (estateRoute || aumlokInvitesRoute) {
          if (access.type !== 'owner' || typeof access.email !== 'string' || typeof env.OWNER_EMAIL !== 'string' || access.email.toLowerCase() !== env.OWNER_EMAIL.toLowerCase() || !Number.isFinite(access.expires) || access.expires <= now() / 1000) return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
        }
        if (estateRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400)
          if (!['GET', 'POST'].includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (incoming.method === 'GET') {
            if (incoming.body !== null || incoming.headers.has('transfer-encoding') || incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0') return json({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400)
          } else {
            if (!/^application\/json(?:\s*;|$)/i.test(incoming.headers.get('content-type') || '')) return json({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400)
            const bounded = await boundedRequest(incoming, 1024, true, 10000)
            try { estateInput = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await bounded.arrayBuffer())) }
            catch { return json({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400) }
            if (!estateInput || Array.isArray(estateInput) || typeof estateInput !== 'object'
              || !['archive_status', 'acknowledge_wake', 'reconcile_proposal'].includes(estateInput.action)
              || Object.keys(estateInput).some(key => !['action', ...(estateInput.action === 'acknowledge_wake' ? ['wakeId'] : [])].includes(key))
              || estateInput.action === 'acknowledge_wake' && (typeof estateInput.wakeId !== 'string' || !/^wake-[0-9a-f]{64}-[1-9][0-9]{0,15}$/.test(estateInput.wakeId))) return json({ ok: false, code: 'ESTATE_REQUEST_INVALID' }, 400)
          }
        }
        const messagesRoute = url.pathname === '/aukora-messages' || url.pathname.startsWith('/aukora-messages/')
        const statusRoute = ['/__x6/status', '/api/x61/status'].includes(url.pathname)
        const factsRoute = ['/__x6/facts', '/api/x61/facts'].includes(url.pathname)
        if (url.pathname === '/_mirror/status') {
          if (incoming.method !== 'GET') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (url.hash || (url.search && url.search !== '?compact=1')) return json({ ok: false, code: 'INVALID_MIRROR_STATUS_QUERY' }, 400)
          if (incoming.body !== null || (incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0')) return json({ ok: false, code: 'MIRROR_STATUS_REQUEST_INVALID' }, 400)
        }
        if (factsRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (incoming.method !== 'GET') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (incoming.body !== null || (incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0')) return json({ ok: false, code: 'FACTS_REQUEST_INVALID' }, 400)
        }
        const wakeRoute = url.pathname === '/_host/wake'
        const archiveRoute = url.pathname === '/_host/archive'
        const cloudBodyRoute = url.pathname === '/_host/cloud-body' || url.pathname === '/api/body/run'
        const turnJournalRoute = url.pathname === '/_host/turn-journal'
        const voiceControlRoute = url.pathname === '/_host/voice'
        const voiceDoorRoute = url.pathname === '/door/voice'
        const headStageOrPromoteRoute = url.pathname === '/_head/stage' || url.pathname === '/_head/promote'
        // AURA's night grant: owner-only and same-origin exactly like /_head/promote; its GET (status) needs the owner too.
        const nightGrantRoute = url.pathname === '/_head/night-grant' || url.pathname === '/_head/night-grant/promote'
        const transcriptRoute = url.pathname === '/_head/transcript'
        const selftestRoute = url.pathname === '/_host/selftest'
        const browserReadRoute = selftestRoute || url.pathname === '/_host/diagnostics'
        const brokerRoute = browserReadRoute || ['/_host/repo', '/_host/github', '/_host/cloudflare', '/_host/web-eyes'].includes(url.pathname)
        const aumlokRoute = /^\/_host\/aumlok\/(?:status|invites|redeem|challenge|bind|refresh|invite|approve|unseal|devices|device-code|device-remove|device-confirm|device-decline)$/.test(url.pathname) // DEVICES hook: the last five
        if (archiveRoute || cloudBodyRoute || turnJournalRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          const allowedMethods = turnJournalRoute ? ['GET'] : ['GET', 'POST']
          if (!allowedMethods.includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (incoming.method === 'POST' && access.type !== 'owner') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
          if (archiveRoute && access.type !== 'owner') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403) // status builds the live bundle and names his credential; owner only
        }
        if (voiceControlRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (!['GET', 'POST'].includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
        }
        if (voiceDoorRoute) {
          if (url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (incoming.method !== 'GET') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (origin !== url.origin) return json({ ok: false, code: 'ORIGIN_REFUSED' }, 403)
        }
        if (headStageOrPromoteRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (incoming.method !== 'POST') return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (access.type !== 'owner') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
        }
        if (nightGrantRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          const methods = url.pathname === '/_head/night-grant' ? ['GET', 'POST'] : ['POST']
          if (!methods.includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (access.type !== 'owner') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
          if (incoming.method === 'GET' && (incoming.body !== null || (incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0'))) return json({ ok: false, code: 'NIGHT_GRANT_REQUEST_INVALID' }, 400)
        }
        if (transcriptRoute) {
          if (url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (!['GET', 'POST'].includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (incoming.method === 'POST' && (origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
        }
        // NOSTR hook: publishing her signed head announcement is an owner POST from her own page; HEAD demands the passkey.
        // NOSTR hook: the owner's GET of the four facts that POST is checked against: same owner rule, no body, no query.
        if (url.pathname === NOSTR_ANCHOR_ROUTE) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (!['GET', 'POST'].includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405) // NOSTR hook
          if ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin') return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403) // NOSTR hook
          if (access.type !== 'owner') return json({ ok: false, code: 'OWNER_ACCESS_REQUIRED' }, 403)
          if (incoming.method === 'GET' && (incoming.body !== null || incoming.headers.has('transfer-encoding') || (incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0'))) return json({ ok: false, code: 'NOSTR_ANCHOR_REQUEST_INVALID' }, 400) // NOSTR hook
        }
        if (brokerRoute || aumlokRoute) {
          if (url.href.includes('?') || url.href.includes('#')) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          const methods = browserReadRoute ? ['GET'] : brokerRoute ? ['GET', 'POST'] : [url.pathname.endsWith('/status') || aumlokInvitesRoute ? 'GET' : 'POST']
          if (!methods.includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (aumlokInvitesRoute && (incoming.body !== null || incoming.headers.has('transfer-encoding') || incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0')) return json({ ok: false, code: 'AUMLOK_REQUEST_INVALID' }, 400)
          if ((brokerRoute || aumlokInvitesRoute || incoming.method === 'POST') && ((origin !== url.origin && !((browserReadRoute || aumlokInvitesRoute) && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          if (browserReadRoute && incoming.headers.has('referer')) {
            let referer
            try { referer = new URL(incoming.headers.get('referer')) } catch (_error) { return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403) }
            if (referer.origin !== url.origin || referer.username || referer.password) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          }
        }
        if (messagesRoute || statusRoute) {
          const method = statusRoute ? 'GET' : MESSAGE_METHODS.get(url.pathname)
          if (!method || url.search) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (incoming.method !== method) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (method === 'POST' && (origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
        }
        if (wakeRoute) {
          if (url.href.includes('?') || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          if (!['GET', 'POST'].includes(incoming.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
          if (incoming.method === 'GET' && (incoming.body !== null || (incoming.headers.has('content-length') && incoming.headers.get('content-length') !== '0'))) return json({ ok: false, code: 'WAKE_REQUEST_INVALID' }, 400)
          if (incoming.method === 'POST' && (origin !== url.origin || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
        }
        const ownerRoute = url.pathname === '/_host/owner-key' || url.pathname === '/_host/owner-grant'
        if (ownerRoute) {
          const failure = ownerGrantRequestFailure({ pathname: url.pathname, method: incoming.method, origin, fetchSite: incoming.headers.get('sec-fetch-site'), expectedOrigin: url.origin, search: url.search })
          if (failure) return json({ ok: false, code: failure.code }, failure.status)
        }
        if (url.pathname === '/_head/ws' && origin !== url.origin) return json({ ok: false, code: 'ORIGIN_REFUSED' }, 403)
        // ANYBROWSER hook: the vault reads its own bodies (hard limit while reading, 30 s idle, 120 s in all). Its fetch-site
        // ANYBROWSER hook: rules are judged BEFORE the session (above, where they cost no HEAD, bootstrap or key read).
        const vaultRoute = url.pathname.startsWith('/_vault/') // ANYBROWSER hook
        // Bootstrap, mirror, messages and wake own their bounded readers and
        // deadlines before storage; do not buffer those streams twice.
        if (url.pathname === '/_bootstrap') return await bootstrapOperation(incoming, env)
        const request = vaultRoute /* ANYBROWSER hook */ || estateRoute || messagesRoute || wakeRoute || archiveRoute || cloudBodyRoute || voiceControlRoute || voiceDoorRoute || headStageOrPromoteRoute || nightGrantRoute || brokerRoute || aumlokRoute || url.pathname === '/_mirror/delta' ? incoming : await boundedRequest(incoming, ownerRoute ? OWNER_GRANT_MAX_BODY_BYTES : MAX_BODY, ownerRoute)
        const bootstrap = await bootstrapStatus(env, request.signal)
        const publicHttpsFetch = createPlatformPublicHttpsTransport({ publicHost: env.PUBLIC_HOST })
        const coldR2Backup = Boolean(env.ARCHIVE_BUCKET)
        const headlessBrowserBody = Boolean(env.BROWSER || typeof launchBrowser === 'function')
        const voiceDuplex = projectVoiceStatus(env)
        if (url.pathname === '/api/health') {
          const telemetry = bootstrap.ready
            ? await bootstrapCall(env, 'HEAD', '/_head/telemetry', undefined, request.signal).catch(() => null)
            : null
          return json({
            ok: true,
            ready: bootstrap.ready,
            bootstrap,
            liveHead: telemetry?.liveHead ?? (bootstrap.ready ? { ballId: bootstrap.head.ballId, epoch: bootstrap.head.epoch } : null),
            runtime: 'cloudflare',
            macDependency: false,
            buildSha: env.SOURCE_REVISION || 'UNVERIFIED',
            sourceRevision: stampedRevision(env),
            voiceDuplex,
            providerUsage: telemetry?.providerUsage ?? null,
            lastArchive: telemetry?.lastArchive ?? null,
            lastGithubSync: telemetry?.lastGithubSync ?? null,
            capabilities: {
              head: Boolean(env.HEAD),
              mirror: Boolean(env.MIRROR),
              selftest: true,
              repoBroker: true,
              githubBroker: typeof env.GITHUB_TOKEN === 'string' && Boolean(env.GITHUB_TOKEN),
              cloudflareMetadata: true,
              publicWebFetch: Boolean(publicHttpsFetch),
              publicWebNetworkPolicy: publicHttpsFetch?.networkPolicy ?? null,
              trustedDocsHttpsFetch: true,
              trustedDocsOrigins: TRUSTED_DOCS_HTTPS_ORIGINS,
              sourcePublicationApproval: typeof approveRepoPublication === 'function',
              coldR2Backup,
              savedBeforeInference: true,
              headlessBrowserBody,
              voiceDirector: true,
              voiceDuplex: voiceDuplex.configured,
              providerDoors: Object.fromEntries(Object.entries(PROVIDERS).map(([name, value]) => [name, typeof env[value.secret] === 'string' && Boolean(env[value.secret])])),
              // Booleans only: whether each door is configured, never a value. Speech is the Deepgram pass the voice
              // director mints; the cloud wake is what lets her think with every tab closed (HEAD's own rule).
              speechProvider: typeof env.DEEPGRAM_API_KEY === 'string' && env.DEEPGRAM_API_KEY.trim().length > 0,
              cloudflareBroker: typeof env.CLOUDFLARE_API_TOKEN === 'string' && Boolean(env.CLOUDFLARE_API_TOKEN) && typeof env.CLOUDFLARE_ACCOUNT_ID === 'string' && Boolean(env.CLOUDFLARE_ACCOUNT_ID),
              // HEAD runs a wake step only when the switch is on (WAKE_EXECUTOR_ENABLED === '1') AND a provider is
              // configured by its own rule (cloudWakeProvider); either one alone is no wake, and this says so.
              cloudWake: env.WAKE_EXECUTOR_ENABLED === '1' && cloudWakeProvider(env).ok === true,
            },
            unsupported: [
              'native-shell',
              'local-repository',
              'eyes',
              ...(!publicHttpsFetch ? ['public-web-fetch'] : []),
              ...(!headlessBrowserBody ? ['no-tab-agent-loop'] : []),
              ...(!voiceDuplex.configured ? ['voice-duplex-renderer'] : []),
              'runtime-recovery',
              ...(!coldR2Backup ? ['cold-r2-backup'] : []),
              'provider-request-deduplication',
              'session-turn-lease',
            ],
          })
        }
        // Includes static boot assets and provider doors: no partly seeded browser.
        // Existing unseeded namespaces require an explicit migration, never auto-adoption.
        // An owner opening the app on a truly empty edge (or one holding an unfinished restore) gets the restore page; it
        // writes only through /_bootstrap, which refuses an initialized world. Established or mismatched namespaces and
        // every other request still get BOOTSTRAP_REQUIRED.
        const restoreMode = recoveryRestorePageMode(bootstrap)
        if (restoreMode !== null && wantsOwnerSignin(request, url)) return await recoveryRestorePageResponse(restoreMode)
        if (!bootstrap.ready) return json({ ok: false, code: 'BOOTSTRAP_REQUIRED', ...(estateRoute ? {} : { bootstrap }) }, 503)
        // ANYBROWSER hook: seeded worlds only (above). `world` is the name this Worker gives the objects, never the seedId.
        if (vaultRoute) return await handleVaultRequest({ request, url, env, world: 'node-main-v1', ready: bootstrap.ready, budget: vaultBudget(env, bootstrap.head.seedId, request.signal), now }) // ANYBROWSER hook
        if (wantsRescueDocument(request, url)) return await rescuePageResponse() // ANYBROWSER hook: the /rescue page, signed in
        if (estateRoute) {
          if (request.method === 'GET') return await estateProjection(request, env, bootstrap, access)
          if (estateInput.action === 'archive_status') return json(await estateArchiveMetadata(request, env))
          const wake = estateInput.action === 'acknowledge_wake'
          const target = new Request(new URL(wake ? '/_host/wake' : '/_host/repo', url), { method: 'POST', signal: request.signal,
            headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin' },
            body: JSON.stringify(wake ? { action: 'acknowledge', wakeId: estateInput.wakeId } : { action: 'reconcile_proposal' }) })
          if (wake) return await estateAcknowledge(target, env, bootstrap.head.seedId, access, estateInput.wakeId)
          return await handleCloudBroker(target, env, { access, bootstrap, networkFetch, approveRepoPublication, now })
        }
        if (voiceControlRoute || voiceDoorRoute) {
          return await handleEdgeVoiceRequest({ request, url, env, seedId: bootstrap.head.seedId, access, networkFetch, now })
        }
        if (archiveRoute) {
          const input = request.method === 'GET' ? { action: 'status' } : await readBoundedBootstrapJson(request)
          // the owner-secret row rides in a reply only under his passkey approval of this exact body (cold-archive.mjs).
          try {
            return json(await executeEdgeArchiveOperation({ env, seedId: bootstrap.head.seedId, input, now, request, authorizeClass3: body => edgeClass3(request, env, body) }))
          } catch (error) { // a coded archive error keeps its checked cleanup, step and limit (cold-archive.mjs)
            const reply = archiveErrorReply(error)
            if (reply === null) throw error
            return json(reply.body, reply.status)
          }
        }
        if (cloudBodyRoute) {
          const input = request.method === 'GET' ? { action: 'status' } : await readBoundedBootstrapJson(request, 16384)
          const out = await executeCloudBrowserBody({ env, seedId: bootstrap.head.seedId, input, now, launchBrowser })
          return json(out, out.status ?? 200)
        }
        if (turnJournalRoute) {
          return await forward(new Request(new URL('/_head/turn-journal', url), request), env.HEAD, 'HEAD', bootstrap.head.seedId, access)
        }
        if (brokerRoute) return await handleCloudBroker(request, env, { access, bootstrap, networkFetch, approveRepoPublication, now, diagnostics: diagnostics.snapshot, publicHttpsFetch,
          trustedDocsHttpsFetch: createTrustedDocsHttpsTransport({ networkFetch, publicHost: env.PUBLIC_HOST }), authorizeClass3: input => edgeClass3(request, env, input) })
        if (aumlokRoute || url.pathname === '/_host/governance/verify' || url.pathname === '/_host/checkpoint-policy') {
          const response = await forward(request, env.HEAD, 'HEAD', bootstrap.head.seedId, access)
          // A bind or rotation that this Worker carried changes the identity generation: drop the sign-in caches now, and
          // let no key read that started before it publish afterwards.
          if (response.ok && ['/_host/aumlok/bind', '/_host/aumlok/refresh', PASSKEY_DEVICE_ROUTES.remove, PASSKEY_DEVICE_ROUTES.code, PASSKEY_DEVICE_ROUTES.confirm /* DEVICES hook */].includes(url.pathname)) { signinKeys.value = null; signinKeysInvalidated(signinKeys) }
          return response
        }
        if (messagesRoute || statusRoute || factsRoute || wakeRoute) return await forward(request, env.HEAD, 'HEAD', bootstrap.head.seedId)
        if (url.pathname === NOSTR_ANCHOR_ROUTE) return await forward(request, env.HEAD, 'HEAD', bootstrap.head.seedId, access) // NOSTR hook
        if (['/_head/ball', '/_head/lease', '/_head/status', '/_head/ws', '/_head/promotion-status', '/_head/transcript', '/_head/stage', '/_head/promote', '/_head/night-grant', '/_head/night-grant/promote'].includes(url.pathname)) return await forward(request, env.HEAD, 'HEAD', bootstrap.head.seedId, access)
        if (['/_mirror/delta', '/_mirror/status', '/_mirror/memory-history', '/_mirror/conflicts', '/api/snapshot'].includes(url.pathname)) return await forward(request, env.MIRROR, 'MIRROR', bootstrap.head.seedId)
        if (url.pathname === '/_mirror/export') {
          if (request.method !== 'GET' || url.search || url.hash) return json({ ok: false, code: 'NOT_FOUND' }, 404)
          const target = new URL('/api/snapshot?snapshotFormat=x61-mirror-snapshot/v2', url)
          return await forward(new Request(target, request), env.MIRROR, 'MIRROR', bootstrap.head.seedId)
        }
        if (ownerRoute) return await edgeOwnerGrant(request, env, { now })
        if (url.pathname.startsWith('/door/')) {
          // Provider doors spend: even the GET (model list) reserves budget in HEAD and calls the paid provider. It gets
          // the same same-origin rule as the other owner GETs, judged before any durable write or provider call. (A POST
          // already needs a matching Origin and is refused cross-site above.)
          if (incoming.method === 'GET' && ((origin !== url.origin && !(incoming.method === 'GET' && origin === null)) || incoming.headers.get('sec-fetch-site') !== 'same-origin')) return json({ ok: false, code: 'SAME_ORIGIN_BROWSER_REQUIRED' }, 403)
          return await providerDoor(request, env, url, bootstrap.head.seedId)
        }
        if (url.pathname.startsWith('/_host/') || url.pathname.startsWith('/_head/') || url.pathname.startsWith('/_mirror/') || url.pathname.startsWith('/api/') || url.pathname.startsWith('/download/') || url.pathname === '/recovery' || url.pathname.startsWith('/recovery/')) return unavailable(url.pathname)
        if (!['GET', 'HEAD'].includes(request.method)) return json({ ok: false, code: 'METHOD_UNAVAILABLE' }, 405)
        if (url.pathname.endsWith('.map') || url.pathname.includes('..') || url.pathname.includes('\\')) return json({ ok: false, code: 'ASSET_UNAVAILABLE' }, 404)
        if (!env.ASSETS) return json({ ok: false, code: 'CLOUD_BINDING_MISSING', binding: 'ASSETS' }, 503)
        const target = new URL(url)
        if (['/', '/index.html', '/preview.html'].includes(target.pathname)) target.pathname = '/preview.html'
        const result = await env.ASSETS.fetch(new Request(target, request))
        const headers = new Headers(result.headers)
        headers.set('cache-control', staticCachePolicy(target.pathname, result.status, headers))
        headers.set('x-content-type-options', 'nosniff')
        headers.delete('set-cookie')
        return new Response(result.body, { status: result.status, headers })
      } catch (error) {
        const code = typeof error?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(error.code) ? error.code : error?.status === 413 ? 'REQUEST_BODY_TOO_LARGE' : 'CLOUD_REQUEST_FAILED'
        return json({ ok: false, code }, [400, 403, 408, 409, 413, 423, 429, 503].includes(error?.status) ? error.status : 503)
      }
      })
    },
  }
}

export default createWorker()
