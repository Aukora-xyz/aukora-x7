/**
 * THE ENGINE FLOOR: what a browser must have for her to start, found by trying it, never by
 * reading the user agent.
 *
 * Two kinds of gap, kept apart on purpose:
 * - BOOT GAPS stop her from starting at all: no gzip DecompressionStream (her seed image is gzip), no Worker, or a
 *   Worker that refuses `type: 'module'` (her host is one ES module worker). Without these the page used to hang on
 *   "Loading plugins" or go blank; now the boot page says which one is missing (`BROWSER_BELOW_FLOOR`, worded by
 *   `@deepseek-ai/dsh-client-web`'s boot page).
 * - CEREMONY GAPS let her start and talk, but not do everything: WebCrypto Ed25519 (node keys, invites, grants),
 *   WebAuthn (the owner's passkey) and WebCrypto digests (her Wasm cells are admitted by SHA-256 through
 *   `crypto.subtle`, only when one is used; boot hashes in JS, `module-loader.ts` sha256HexSync). A page that is not
 *   a secure context (a plain-HTTP LAN preview, which the runtime supports on purpose) has no `crypto.subtle` and no
 *   WebAuthn even in a current Chrome, so refusing the whole app for these would be false. They are recorded as browser
 *   facts and said on the boot page while she starts (`boot-page.ts` browserFactNotes), and the screens that need them
 *   refuse in words at the point of use (`identity/webauthn.ts` passkeyBlocker, the AUMLOK Ed25519 refusal).
 * @module @deepseek-ai/dsh-experimental-webworker-runtime/src/client/engine-floor
 */

/** The code the boot gate is refused with; the boot page turns it into a plain sentence. */
export const BROWSER_BELOW_FLOOR = 'BROWSER_BELOW_FLOOR'

/** A boot capability, named in the words the boot page shows. */
export type BootCapability = 'module workers' | 'gzip streams (DecompressionStream)'

/** A ceremony capability, named in the words a browser-facts reader shows. */
export type CeremonyCapability = 'WebCrypto Ed25519' | 'WebAuthn passkeys' | 'WebCrypto digests'

/** The globals the probe reads; production passes `globalThis`, specs pass fakes. */
export interface EngineScope {
  readonly Worker?: unknown
  readonly DecompressionStream?: unknown
  readonly crypto?: {
    readonly subtle?: {
      readonly digest?: unknown
      readonly generateKey?: (algorithm: { readonly name: string }, extractable: boolean, usages: string[]) => Promise<unknown>
    }
  } | undefined
  readonly PublicKeyCredential?: unknown
  readonly navigator?: { readonly credentials?: { readonly get?: unknown; readonly create?: unknown } } | undefined
}

/**
 * The boot gaps that can be found before a worker exists. The module-worker gap is found by constructing her real
 * worker: see {@link moduleWorkerGap}.
 * @param scope - The globals to probe.
 * @returns The missing boot capabilities, empty when the browser is above the floor.
 */
export function bootGaps(scope: EngineScope = globalThis as EngineScope): BootCapability[] {
  const gaps: BootCapability[] = []
  if (typeof scope.Worker !== 'function') gaps.push('module workers')
  if (!gzipStreams(scope.DecompressionStream)) gaps.push('gzip streams (DecompressionStream)')
  return gaps
}

function gzipStreams(Ctor: unknown): boolean {
  if (typeof Ctor !== 'function') return false
  try {
    Reflect.construct(Ctor, ['gzip'])
    return true
  } catch {
    return false
  }
}

/**
 * Whether this engine's Worker constructor reads the `type` option at all. Every engine with module workers reads it
 * while converting the options, before the constructor runs any step of its own (so before a Trusted Types or URL
 * refusal). The probe is given an address that cannot parse, so no worker is ever started; one that somehow is, is
 * stopped at once.
 * @param Ctor - The Worker constructor; defaults to the global one.
 * @returns True when `type` is read, false when it is ignored, undefined where there is no Worker to ask.
 */
export function workerReadsTypeOption(Ctor: unknown = (globalThis as EngineScope).Worker): boolean | undefined {
  if (typeof Ctor !== 'function') return undefined
  const seen = { type: false }
  try {
    const started: unknown = Reflect.construct(Ctor, ['http://[', {
      get type() {
        seen.type = true
        return 'module'
      },
    }])
    ;(started as { terminate?: () => void } | null)?.terminate?.()
  } catch { /* the address cannot parse: expected */ }
  return seen.type
}

/**
 * Whether constructing her module worker failed for want of module-worker support. Only what can be shown is
 * classified: the refusal names module scripts or workers, or this engine's Worker ignores the `type` option (so it
 * has no module workers). Anything else, a Trusted Types refusal for instance, which is also a TypeError, is not a
 * floor gap and is passed back unchanged.
 * @param error - What the Worker constructor threw.
 * @param readsTypeOption - Whether the engine reads the `type` option ({@link workerReadsTypeOption}).
 * @returns True when the error means "this engine has no module workers".
 */
export function moduleWorkerGap(error: unknown, readsTypeOption: boolean | undefined = workerReadsTypeOption()): boolean {
  if (!(error instanceof TypeError || (error instanceof Error && error.name === 'NotSupportedError'))) return false
  return /\bmodules?\b/i.test(error.message) || readsTypeOption === false
}

/**
 * The refusal the boot gate is rejected with: the code, then the capabilities, comma-separated.
 * @param gaps - The missing boot capabilities (at least one).
 * @returns The error to reject the boot gate with.
 */
export function belowFloorError(gaps: readonly BootCapability[]): Error {
  return new Error(`${BROWSER_BELOW_FLOOR}: ${gaps.join(', ')}`)
}

/** The page's boot barrier (client/index.ts `holdWorkerHostBoot` installs it; the stock entry awaits it). */
interface BootGateScope {
  __DSH_BOOT_READY__?: PromiseWithResolvers<void>
}

/**
 * Refuse the boot before any worker starts: the stock entry waiting on the barrier renders the reason on its boot page
 * instead of waiting forever. A page with no barrier installed has nobody waiting, so nothing happens.
 * @param reason - Why she cannot start in this page ({@link belowFloorError}).
 * @param scope - The page global; specs pass their own.
 */
export function refuseBoot(reason: Error, scope: BootGateScope = globalThis as BootGateScope): void {
  const gate = scope.__DSH_BOOT_READY__
  if (gate === undefined) return
  void gate.promise.catch(() => {})
  gate.reject(reason)
}

/**
 * The ceremony gaps, probed by trying them: an Ed25519 key is generated (not kept, not exported), and the WebAuthn and
 * digest entry points are looked for. Never throws; a probe that cannot run counts as a gap.
 * @param scope - The globals to probe.
 * @returns The missing ceremony capabilities.
 */
export async function ceremonyGaps(scope: EngineScope = globalThis as EngineScope): Promise<CeremonyCapability[]> {
  const gaps: CeremonyCapability[] = []
  const subtle = scope.crypto?.subtle
  let ed25519 = false
  if (typeof subtle?.generateKey === 'function') {
    try {
      await subtle.generateKey({ name: 'Ed25519' }, false, ['sign', 'verify'])
      ed25519 = true
    } catch {
      ed25519 = false
    }
  }
  if (!ed25519) gaps.push('WebCrypto Ed25519')
  const credentials = scope.navigator?.credentials
  if (typeof scope.PublicKeyCredential !== 'function' || typeof credentials?.get !== 'function'
    || typeof credentials.create !== 'function') gaps.push('WebAuthn passkeys')
  if (typeof subtle?.digest !== 'function') gaps.push('WebCrypto digests')
  return gaps
}
