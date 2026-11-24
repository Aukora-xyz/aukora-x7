# Adapter for the next line (bound records). Lab only.

This folder is NOT part of any release tree. The released adapter is `../standalone/` and is unchanged.
`aukora.mjs` here is that adapter plus four things, for cores that have the bound start (42 laws and later):

1. `initBound(owner)` starts a record bound to its own identifier (a digest over a fixed label, the core's law
   identity, the owner's public keys and 32 random bytes drawn here). The first head is the identifier.
2. The newer owner commands, each of which signs the head: `halt`, `clear`, `changeKeys`.
3. In a bound record the adapter REFUSES TO SIGN the two old forms that name no record: the one-time approval
   (`grant`, 0x13) and the old key change (`rebind`, 0x14). Use `grantUntil` and `changeKeys`.
4. `exportRecord` / `replay` carry the host value; `replay(text, { expectId })` requires a named record.

Run: `node standalone-next/bound-test.mjs <core.wasm> <its sha256>` (47 checks) and
`node standalone-next/old-mode-test.mjs` (the released adapter's 34 checks, unchanged, through this file).

## What this does and does not give
- CHECKED (RAN, v0.6 and v0.7, small and full core): a timed approval made for one bound record is refused by a
  twin record of the same owner, unchanged and re-addressed; stop, clear and key change work through the newer
  forms; a bound record replays to the same head and identifier; one changed character in the host value, a
  dropped line, or the same lines presented as an old-start record do not replay.
- NOT closed by this: the CORE still admits an old-form approval in a bound record. The test builds one by hand
  and prints `WATCH blocker 12: … YES (still open in this core)`. The adapter only guarantees that the owner's
  own tool never makes such a frame. Anything else holding the owner's keys still could. Root v2 must make the
  core refuse it; that line of the test is then run with `closed` as its fourth argument.
- STATED LIMIT: the same keys and the same host value give the same identifier, so they are one record twice.
  The adapter draws 32 random bytes; a host that reuses a value gets no separation.
- The host value must be kept with the record. Without it the record cannot be replayed.
