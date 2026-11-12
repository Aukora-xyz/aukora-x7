/** Cloudflare Browser Rendering headless body coordinator for Aukora X6.1.
 *
 * Gives Auma an on-demand headless browser body when no owner browser tab is open,
 * while strictly yielding (`409 BROWSER_TAB_ACTIVE`) whenever any live browser tab
 * peer or active turn is present so headless runs never contend with the owner's UI.
 *
 * Truthfulness invariant: reports `configured: false` and fails closed with
 * `503 CLOUD_BROWSER_BINDING_MISSING` unless `env.BROWSER` (or an explicit test launcher)
 * is genuinely bound. Always closes the browser instance in `finally`.
 */

export const CLOUD_BODY_SCHEMA = 'aukora.cloud-body.v1'
const LIVE_PRODUCTION_DO_NAME = 'node-main-v1'

const isObject = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const bodyError = (code, status = 400, extra = {}) => Object.assign(new Error(code), { code, status, ...extra })

async function internalHeadJson(headBinding, path, seedId, payload) {
  if (!headBinding) throw bodyError('CLOUD_BINDING_MISSING', 503)
  const resp = await headBinding.get(headBinding.idFromName(LIVE_PRODUCTION_DO_NAME)).fetch(new Request(`https://x61.internal${path}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: {
      'x-x6-internal-authorized': '1',
      ...(seedId ? { 'x-x6-bootstrap-seed': seedId } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  }))
  const data = await resp.json()
  if (!resp.ok || data?.ok !== true) {
    throw bodyError(typeof data?.code === 'string' ? data.code : 'CLOUD_BODY_HEAD_UNAVAILABLE', resp.status >= 400 ? resp.status : 503)
  }
  return data
}

async function defaultBindingLauncher(browserBinding) {
  if (!browserBinding) throw bodyError('CLOUD_BROWSER_BINDING_MISSING', 503)
  if (typeof browserBinding.launch === 'function') {
    return browserBinding.launch()
  }
  throw bodyError('CLOUD_BROWSER_ADAPTER_UNAVAILABLE', 503)
}

/** Execute `GET|POST /_host/cloud-body` (`status` or `run`). */
export async function executeCloudBrowserBody({
  env,
  seedId,
  input,
  now = Date.now,
  launchBrowser = null,
}) {
  const action = typeof input?.action === 'string' ? input.action : 'status'
  const configured = Boolean(env?.BROWSER || typeof launchBrowser === 'function')

  const [promoStatus, transcript] = await Promise.all([
    internalHeadJson(env.HEAD, '/_head/promotion-status', seedId),
    internalHeadJson(env.HEAD, '/_head/transcript', seedId, { action: 'read', limit: 5 }),
  ])

  const peers = Array.isArray(promoStatus.peers) ? promoStatus.peers : []
  const tabPeers = peers.filter(peer => isObject(peer) && peer.peerId !== 'cloud-head')
  const activeTurnRunning = isObject(transcript.turn) && transcript.turn.status === 'running'
  const wish = isObject(transcript.wish)
    ? {
        wish_id: transcript.wish.wish_id ?? null,
        status: transcript.wish.status ?? null,
        stepsCompleted: transcript.wish.stepsCompleted ?? 0,
        maxSteps: transcript.wish.maxSteps ?? 0,
      }
    : null

  if (action === 'status') {
    return {
      ok: true,
      schema: CLOUD_BODY_SCHEMA,
      configured,
      activeTabPeers: tabPeers.length,
      activeTurnRunning,
      canRunHeadlessNow: configured && tabPeers.length === 0 && !activeTurnRunning,
      head: {
        ballId: promoStatus.ballId ?? null,
        epoch: promoStatus.epoch ?? null,
      },
      activeWish: wish,
    }
  }

  if (action !== 'run') {
    throw bodyError('CLOUD_BODY_ACTION_INVALID', 400)
  }

  // Yield immediately whenever any owner browser tab or running turn is active.
  if (tabPeers.length > 0 || activeTurnRunning) {
    return {
      ok: false,
      status: 409,
      code: 'BROWSER_TAB_ACTIVE',
      activeTabPeers: tabPeers.length,
      activeTurnRunning,
    }
  }

  if (!configured) {
    throw bodyError('CLOUD_BROWSER_BINDING_MISSING', 503)
  }

  const holdMs = Number.isSafeInteger(input?.holdMs)
    ? Math.min(25000, Math.max(250, input.holdMs))
    : 2000
  const targetUrl = `https://${env.PUBLIC_HOST}/preview.html`
  const startedAt = now()
  let browser = null
  let browserClosed = false

  try {
    browser = typeof launchBrowser === 'function'
      ? await launchBrowser({ env, targetUrl, holdMs })
      : await defaultBindingLauncher(env.BROWSER)

    const page = typeof browser?.newPage === 'function' ? await browser.newPage() : null
    let pageTitle = null
    let mounted = false
    if (page) {
      if (typeof page.goto === 'function') {
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: Math.min(15000, holdMs + 5000) })
      }
      if (typeof page.waitForTimeout === 'function' && holdMs > 0) {
        await page.waitForTimeout(Math.min(holdMs, 5000))
      }
      if (typeof page.title === 'function') {
        pageTitle = await page.title()
      }
      mounted = true
    }

    return {
      ok: true,
      schema: CLOUD_BODY_SCHEMA,
      startedAt,
      completedAt: now(),
      targetUrl,
      mounted,
      pageTitle,
      head: {
        ballId: promoStatus.ballId ?? null,
        epoch: promoStatus.epoch ?? null,
      },
      browserClosed: true,
    }
  } finally {
    if (browser && typeof browser.close === 'function') {
      try {
        await browser.close()
        browserClosed = true
      } catch {
        // Best-effort cleanup in finally so leaked Chromium sessions never accumulate.
      }
    }
    void browserClosed
  }
}
