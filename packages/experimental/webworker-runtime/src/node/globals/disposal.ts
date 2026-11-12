/**
 * Install cross-engine runtime globals before modules define resource-owning classes.
 *
 * - `Symbol.dispose` / `Symbol.asyncDispose`: TypeScript lowers `using` into calls that require these symbols even
 *   when the browser has no native explicit-resource-management support (Safari, older Firefox). The registered
 *   `Symbol.for('Symbol.<name>')` keys match the well-known fallback TypeScript's helpers and `fs.ts` already accept.
 * - `Promise.withResolvers`: ES2024; absent before Safari 17.4 and Firefox 121. Host modules (`worker-host.ts`) call it
 *   during boot, so a missing intrinsic must be filled before they load, never after a TypeError.
 * - `AbortSignal.any`: absent before Safari 17.4 and Firefox 124. The turn path composes signals with it
 *   (`x6/ball-loader.ts`), so an engine without it would fail every turn with a TypeError.
 *
 * ONE SHIM FOR BOTH HALVES: the worker loads it first (`worker-host.ts`), and so does the page
 * (`client/index.ts`, the first module the worker bootstrap page imports), so neither half calls an intrinsic before it
 * exists.
 *
 * Each install is idempotent, never replaces a native value, and defines non-enumerable, non-writable,
 * non-configurable properties so a later script cannot swap the protocol key.
 * Ported from X63 (disposal) plus the Wave 4B Promise.withResolvers guard.
 */
for (const name of ['dispose', 'asyncDispose'] as const) {
  if (typeof (Symbol as unknown as Record<string, unknown>)[name] === 'symbol') continue
  Object.defineProperty(Symbol, name, { value: Symbol.for(`Symbol.${name}`) })
}

if (typeof (Promise as { withResolvers?: unknown }).withResolvers !== 'function') {
  Object.defineProperty(Promise, 'withResolvers', {
    value: function withResolvers<T>(this: PromiseConstructor) {
      let resolve!: (value: T | PromiseLike<T>) => void
      let reject!: (reason?: unknown) => void
      // Like the native intrinsic, honour a subclass receiver; fall back to Promise for a detached call.
      const Ctor = typeof this === 'function' ? this : Promise
      const promise = new Ctor<T>((res, rej) => { resolve = res; reject = rej })
      return { promise, resolve, reject }
    },
    writable: true,
    configurable: true,
  })
}

if (typeof AbortSignal === 'function' && typeof (AbortSignal as { any?: unknown }).any !== 'function') {
  Object.defineProperty(AbortSignal, 'any', {
    value: function any(signals: Iterable<AbortSignal>): AbortSignal {
      const controller = new AbortController()
      const sources = [...signals]
      // Like the native one: an already-aborted source aborts the result at once, with that source's reason.
      const first = sources.find(signal => signal.aborted)
      if (first !== undefined) {
        controller.abort(first.reason)
        return controller.signal
      }
      // The first source to abort wins; every listener is then removed, so a long-lived source keeps no reference.
      const onAbort = function (this: AbortSignal): void {
        for (const signal of sources) signal.removeEventListener('abort', onAbort)
        controller.abort(this.reason)
      }
      for (const signal of sources) signal.addEventListener('abort', onAbort)
      return controller.signal
    },
    writable: true,
    configurable: true,
  })
}

export {}
