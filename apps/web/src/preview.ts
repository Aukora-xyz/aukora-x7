/**
 * Worker-preview bootstrap: the one module preview.html adds ahead of the
 * stock entry tag. The runtime's optional source stage owns the pre-Cordis
 * chooser; the unchanged Host connector then owns the Worker handshake.
 * Everything after those calls is the served startup chain verbatim.
 */
import DshWorker from '@deepseek-ai/dsh-experimental-webworker-runtime/worker?worker'
import {
  chooseWorkerHostSource, connectWorkerHost, holdWorkerHostBoot, IMAGE_FILE_NAME,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/client'
// The engine floor is one self-contained module, imported by its source path (the package publishes ./src/*).
import {
  belowFloorError, bootGaps, ceremonyGaps, moduleWorkerGap, refuseBoot,
} from '@deepseek-ai/dsh-experimental-webworker-runtime/src/client/engine-floor.ts'
import {
  askToKeepLocalStore, recordBrowserFacts, STORAGE_KEEP_WAIT_MS, storageKeepLine, type StorageKeep,
} from './browser-facts.ts'
import { installAumaLiveFacts } from './spatial/auma-live-facts.ts'
import { installWorkBridge } from './spatial/work-bridge.ts'

// THE PAGE'S OWN BUILD. This bootstrap is bundled by apps/web, so Vite replaces its small page stamp
// `__X6_PAGE_STAMP__` (a JSON string literal of `sourceRevision` and `sourceDirty` only; the whole build identity with its
// retention suite stays out of the page); the UI library ships inside the app image and never is, so its "a new build
// is live" notice (ui-layout portal/build-notice.ts `pageBuildStamp`) reads the stamp published here: once, frozen,
// before the image loads. A dirty, unstamped or unreadable build publishes nulls, and then the notice names nothing.
// deploy/ci/built-notice-check.mjs reads it out of the built dist as text.
declare const __X6_PAGE_STAMP__: string | undefined
function pageStamp(): { sourceRevision: string | null; sourceDirty: boolean | null } {
  try {
    const stamp: unknown = typeof __X6_PAGE_STAMP__ === 'string' ? JSON.parse(__X6_PAGE_STAMP__) : null
    if (stamp !== null && typeof stamp === 'object') {
      const { sourceRevision, sourceDirty } = stamp as Record<string, unknown>
      return { sourceRevision: typeof sourceRevision === 'string' ? sourceRevision : null, sourceDirty: typeof sourceDirty === 'boolean' ? sourceDirty : null }
    }
  } catch { /* an unreadable stamp names nothing */ }
  return { sourceRevision: null, sourceDirty: null }
}
try {
  Object.defineProperty(globalThis, '__X6_PAGE_BUILD__', {
    value: Object.freeze(pageStamp()),
    writable: false, enumerable: false, configurable: false,
  })
} catch { /* already published on this page: the first stamp stands, and boot goes on */ }
// Establish the stock shell's existing barrier before reading storage metadata.
// No worker opens/upgrades IndexedDB until an existing v1 owner has been warned.
// (The runtime client module this imports loads the cross-engine shim first: Promise.withResolvers, AbortSignal.any.)
holdWorkerHostBoot()
// The Spatial Work surface reads Auma's SuperAgent state through the one page-side reader (spatial/work-bridge.ts).
installWorkBridge()
// Auma Live's status strip reads two routes no host defines; they are answered here from edge facts (F6).
installAumaLiveFacts()
// THE ENGINE FLOOR (B12): a browser that cannot run her is told which capability it lacks, instead of a hang.
const floorGaps = bootGaps()
const candidate = new URL(globalThis.location.href).searchParams.get('runtime_candidate')
if (candidate) {
  if (!/^[a-f0-9]{64}$/.test(candidate) || !new URL(import.meta.url).pathname.startsWith('/_runtime/' + candidate + '/')) throw new Error('Runtime candidate module does not match its requested release')
  const pinnedUrl = (input: string | URL | null | undefined): string | URL | null | undefined => {
    if (input == null) return input
    const url = new URL(input, globalThis.location.href)
    if (url.origin === globalThis.location.origin) url.searchParams.set('runtime_candidate', candidate)
    return url.href
  }
  const push = history.pushState.bind(history)
  const replace = history.replaceState.bind(history)
  history.pushState = (data: unknown, unused: string, url?: string | URL | null) => { push(data, unused, pinnedUrl(url)) }
  history.replaceState = (data: unknown, unused: string, url?: string | URL | null) => { replace(data, unused, pinnedUrl(url)) }
  const banner = document.createElement('aside')
  banner.id = 'x6-runtime-candidate-banner'
  banner.setAttribute('aria-label', 'Live runtime candidate')
  banner.textContent = 'Live runtime candidate ' + candidate.slice(0, 12) + '. Uses current memory and host access; not isolated. '
  const leave = document.createElement('button')
  leave.textContent = 'Return to main build'
  leave.addEventListener('click', () => { if (confirm('Save or export pending work before leaving this live candidate. Continue to the main build?')) globalThis.location.assign('/') })
  banner.append(leave)
  Object.assign(banner.style, { position: 'fixed', right: '12px', top: '12px', zIndex: '10000', maxWidth: '28rem', padding: '12px', background: '#172535', color: '#fff', border: '1px solid #a5dbff', borderRadius: '8px', font: '13px/1.4 system-ui' })
  document.body.append(banner)
}
let hasLegacyV1Storage = false
if (typeof indexedDB !== 'undefined' && typeof indexedDB.databases === 'function') {
  try {
    hasLegacyV1Storage = (await indexedDB.databases()).some(database => database.name === 'aukora-x6-vfs' && database.version === 1)
  } catch { hasLegacyV1Storage = false }
}
if (hasLegacyV1Storage) {
  console.info('x6-preview: upgrading legacy v1 aukora-x6-vfs IndexedDB store to v2 conflict-protected schema')
}
// Keep image and lazy archives beside this exact release’s bootstrap.
const image = new URL(IMAGE_FILE_NAME, import.meta.url).href
const useChooser = new URLSearchParams(globalThis.location?.search ?? '').has('chooser')
if (floorGaps.length > 0) {
  refuseBoot(belowFloorError(floorGaps))
} else {
  // What this browser cannot do for her (B12) is probed now, while the boot page is up, so it can say so as she starts
  // (boot-page.ts browserFactNotes reads these facts). Never awaited; never a refusal.
  void ceremonyGaps().then((gaps) => {
    if (gaps.length > 0) console.warn(`x6-browser: she runs here, but this browser lacks ${gaps.join(', ')}`)
    recordBrowserFacts({ ceremonyGaps: gaps })
  })
  const source = useChooser ? await chooseWorkerHostSource({ image }) : { overlays: [] }
  let worker: Worker | null = null
  try {
    worker = new DshWorker({ name: 'dsh-host' })
  } catch (error) {
    // An engine without module workers throws here; anything else is not a floor gap and stays what it was.
    if (!moduleWorkerGap(error)) throw error
    refuseBoot(belowFloorError(['module workers']))
  }
  if (worker !== null) {
    await connectWorkerHost(worker, { image, overlays: source.overlays })
    // Her worker has attached its local store: ask the browser to keep it (B4) and record what it answered (the boot
    // page says it if it is still up). Not awaited by anything; the gate is already open. A late answer replaces the
    // interim "no answer" fact when it comes.
    const recordStorageKeep = (storageKeep: StorageKeep): void => {
      console.info(storageKeepLine(storageKeep))
      recordBrowserFacts({ storageKeep })
    }
    void askToKeepLocalStore(typeof navigator === 'undefined' ? undefined : navigator.storage, STORAGE_KEEP_WAIT_MS, recordStorageKeep)
      .then(recordStorageKeep)
  }
}
