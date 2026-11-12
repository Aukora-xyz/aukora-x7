/**
 * The engine floor is found by trying each capability, and a browser below it refuses the boot gate
 * with a code the boot page words plainly, instead of hanging.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  belowFloorError, bootGaps, BROWSER_BELOW_FLOOR, ceremonyGaps, moduleWorkerGap, refuseBoot, workerReadsTypeOption, type EngineScope,
} from '../../src/client/engine-floor.ts'
import { holdWorkerHostBoot } from '../../src/client/index.ts'
import { BROWSER_BELOW_FLOOR as BOOT_PAGE_CODE, belowFloorSentence } from '../../../../client/web/src/boot-page.ts'

function Gzip(format: string): void { if (format !== 'gzip') throw new TypeError('format') }
function Present(): void { /* a constructor that exists */ }
const subtle = {
  digest: async () => new ArrayBuffer(32),
  generateKey: async (algorithm: { name: string }) => {
    if (algorithm.name !== 'Ed25519') throw new Error('NotSupportedError')
    return {}
  },
}
const modern: EngineScope = {
  Worker: Present,
  DecompressionStream: Gzip,
  crypto: { subtle },
  PublicKeyCredential: Present,
  navigator: { credentials: { get: () => null, create: () => null } },
}

describe('boot gaps', () => {
  it('a current engine has none', () => {
    expect(bootGaps(modern)).toEqual([])
  })

  it('names each missing boot capability, in the words the boot page shows', () => {
    expect(bootGaps({})).toEqual(['module workers', 'gzip streams (DecompressionStream)'])
    expect(bootGaps({ ...modern, DecompressionStream: () => ({}) }))
      .toEqual(['gzip streams (DecompressionStream)'])
  })

  it('a page without WebCrypto digests still boots (plain-HTTP LAN previews have no crypto.subtle; boot hashes in JS)', () => {
    expect(bootGaps({ ...modern, crypto: { subtle: {} } })).toEqual([])
    expect(bootGaps({ ...modern, crypto: {} })).toEqual([])
    expect(bootGaps({ ...modern, crypto: undefined })).toEqual([])
  })

  it('reads the real globals by default (this test engine is above the floor)', () => {
    // Node has DecompressionStream and WebCrypto, but no Worker.
    expect(bootGaps()).toEqual(['module workers'])
  })

  it('a Worker constructor that refuses module scripts is a module-worker gap; any other error is not', () => {
    expect(moduleWorkerGap(new TypeError('Module scripts are not supported on DedicatedWorker yet'))).toBe(true)
    expect(moduleWorkerGap(Object.assign(new Error('module workers'), { name: 'NotSupportedError' }))).toBe(true)
    expect(moduleWorkerGap(new SyntaxError('bad url'))).toBe(false)
    expect(moduleWorkerGap('not an error')).toBe(false)
  })

  it('an unrelated TypeError from an engine that HAS module workers stays itself (Trusted Types, Chrome)', () => {
    const trustedTypes = new TypeError("Failed to construct 'Worker': This document requires 'TrustedScriptURL' assignment.")
    expect(moduleWorkerGap(trustedTypes, true)).toBe(false)
    // Where no Worker can be asked, nothing about modules is shown either: still not a floor gap.
    expect(moduleWorkerGap(trustedTypes, undefined)).toBe(false)
    expect(moduleWorkerGap(new TypeError('Failed to fetch'), true)).toBe(false)
    // The module refusal itself is still a gap even where the option is read.
    expect(moduleWorkerGap(new TypeError('Module scripts are not supported on DedicatedWorker yet'), true)).toBe(true)
  })

  it('an engine whose Worker ignores the type option has no module workers: its refusal is the gap', () => {
    expect(moduleWorkerGap(new TypeError('Worker failed'), false)).toBe(true)
    expect(moduleWorkerGap(new SyntaxError('bad url'), false)).toBe(false)
  })

  it('the type-option probe reads the option without starting a worker', () => {
    const started: unknown[] = []
    function Modern(url: string, options: { type?: string }): void {
      void options.type
      if (url === 'http://[') throw new SyntaxError('invalid URL')
      started.push(url)
    }
    function Classic(url: string): void {
      if (url === 'http://[') throw new SyntaxError('invalid URL')
      started.push(url)
    }
    expect(workerReadsTypeOption(Modern)).toBe(true)
    expect(workerReadsTypeOption(Classic)).toBe(false)
    expect(workerReadsTypeOption(undefined)).toBeUndefined()
    expect(started).toEqual([])
    // A constructor that starts one anyway has it stopped at once.
    const stopped: string[] = []
    class Lenient { constructor(_url: string, options: { type?: string }) { void options.type } terminate() { stopped.push('terminated') } }
    expect(workerReadsTypeOption(Lenient)).toBe(true)
    expect(stopped).toEqual(['terminated'])
  })
})

describe('ceremony gaps: she starts, but cannot bind or approve', () => {
  it('a current engine has none', async () => {
    expect(await ceremonyGaps(modern)).toEqual([])
  })

  it('no Ed25519 and no WebAuthn are both named', async () => {
    const noEd25519 = { ...subtle, generateKey: async () => { throw new Error('NotSupportedError: Ed25519') } }
    expect(await ceremonyGaps({ ...modern, crypto: { subtle: noEd25519 }, PublicKeyCredential: undefined }))
      .toEqual(['WebCrypto Ed25519', 'WebAuthn passkeys'])
    expect(await ceremonyGaps({ ...modern, crypto: undefined, navigator: { credentials: { get: () => null } } }))
      .toEqual(['WebCrypto Ed25519', 'WebAuthn passkeys', 'WebCrypto digests'])
  })

  it('no WebCrypto digest is recorded as a gap she starts without (her Wasm cells need it), never a boot refusal', async () => {
    expect(await ceremonyGaps({ ...modern, crypto: { subtle: { generateKey: subtle.generateKey } } })).toEqual(['WebCrypto digests'])
  })
})

describe('below the floor, the boot gate is refused in words', () => {
  afterEach(() => { Reflect.deleteProperty(globalThis, '__DSH_BOOT_READY__') })

  it('the refusal carries the code and the capabilities, and the boot page turns it into a sentence', async () => {
    refuseBoot(belowFloorError(['module workers']), {})
    holdWorkerHostBoot()
    refuseBoot(belowFloorError(['module workers', 'gzip streams (DecompressionStream)']))
    const gate = (globalThis as { __DSH_BOOT_READY__?: PromiseWithResolvers<void> }).__DSH_BOOT_READY__
    const reason = await gate?.promise.then(() => null, (error: unknown) => error)
    expect(reason).toBeInstanceOf(Error)
    const message = (reason as Error).message
    expect(message).toBe(`${BROWSER_BELOW_FLOOR}: module workers, gzip streams (DecompressionStream)`)
    // The two packages hold the same code: the runtime raises it, the boot page words it.
    expect(BOOT_PAGE_CODE).toBe(BROWSER_BELOW_FLOOR)
    expect(belowFloorSentence(message)).toBe(
      'This browser cannot run her: it lacks module workers and gzip streams (DecompressionStream). Open her in a current Chrome, Firefox or Safari.')
  })
})
