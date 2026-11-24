# Wasm byte ABI

`aukora-core.wasm` exposes 19 functions. Each parameter and result is one WebAssembly `i32`, interpreted as an unsigned integer. Create a fresh instance with an empty import object. Its current machine, candidate staging area and input buffer are private to that instance. Both the full research core and the ratchet successor validate and bind the supplied genesis owner keys.

| Export | Arguments | Result and effect |
| --- | --- | --- |
| input | byte | Append one byte in 0..255, return 1. An out-of-range byte or buffer overflow marks the submission invalid and returns 0. Subsequent input for that submission returns 0. |
| init | none | Consume exactly 1,984 bytes in the order EdKey[32], MLKey[1952]. Return 1 on successful genesis and 0 for invalid input, checker initialization failure or repeat initialization. The initial head and installed digest are 32 zeros. EdKey must decode to a non-identity point in the prime-order subgroup. |
| step | none | Consume one complete ledger frame. Return 1 on admission and 0 on refusal, including use before genesis. An admission appends its exact bytes to the record. A refusal leaves the machine state intact. |
| reset | none | Clear pending input and the invalid-staging flag. If initialized, discard staged candidate bytes and return 1. Otherwise return 0. The ledger, owner keys, stamps, thresholds, halt flag and pinned law identity survive. |
| feed | none | Consume pending bytes as a candidate chunk. Return 1 after appending it to the current staging area. Invalid input or missing genesis returns 0. An invalid chunk after genesis latches a staging error until reset. An accepted install empties the staging area. |
| head | index | Byte at index 0..31 of the current ledger head. Return 256 before genesis or outside that range. |
| core | index | Byte at index 0..31 of the installed digest in the ledger. Return 256 before genesis or outside that range. A successful install records the selected digest. The host resolves and instantiates the selected bytes. |
| recordByte | entry, offset | Byte in the accepted ledger record. Both indices are zero-based. Return 256 before genesis or for a missing entry or offset. |
| threshold | none | Current danger threshold, 0..255. Initial value 0. Return 256 before genesis. |
| stamp | none | Consume current head[32], u16 little-endian beacon length, beacon bytes, receipt digest[32]. Return 1 when the full input parses and the head matches, otherwise 0. Appends the submitted bytes to a sidecar. |
| stampCount | none | Number of accepted sidecar stamps. Return 0 before genesis. |
| stampByte | entry, offset | Byte of a sidecar stamp, indexed from zero. Return 256 before genesis or outside the saved bytes. |
| verify | none | Consume EdKey[32], EdSig[64], remaining message bytes. Return 1 when the Ed25519 verifier accepts, otherwise 0. This read-only cryptographic primitive can run before genesis. |
| hashHead | none | Consume a 00, 13 or 14 envelope and return the first byte of its whole-envelope SHA-256, or 256 if its envelope prefix fails to parse or input failed. This read-only operation can run before genesis. It parses the outer prefix and does not validate the inner action. |
| outcome | none | Consume the 32-byte SHA-256 of an encoded intent. Return 0 confirmed, 1 failed, 2 unknown. Add 4 for a labelled correction, giving 4, 5, 6. Return 256 for a missing result, missing genesis or invalid submission. |
| halted | none | Return 1 when the most recently committed halt/clear leaves the machine halted, 0 when running and 256 before genesis. |
| guessCeiling | none | Current owner-controlled ceiling for guessed claims, 0..255. Initial value 0. Return 256 before genesis. |
| lawByte | index | Byte at index 0..31 of the stored law identity, including its checker foundation. The instance fills the 32-byte value at genesis and refreshes it after each accepted install. Return 256 before genesis or outside the available bytes. |
| installReason | none | Consume a proposed upgrade wire and return its first ratchet failure code, independently of staging, the install grant and the halt filter. Return 256 on unavailable input or before genesis. A zero result says the ratchet permits proceeding to the remaining checks. Ordinary frames also return zero. |

The full core applies the safe-state and evidence rules around the succession gate. The demonstrable successor `fixtures/ratchet-core.wasm` uses the same byte interface with the R10-compatible ratchet step. Its contract inherits the 23 R10 fields and adds succession. Its lawful branch cannot admit any new release-2 control frame. The full research core's valid halt provides a kernel-checked witness to that incompatibility. [Public machine](Round11.lean) · [Safe-state proofs](Proofs/Round11Safe.lean)

| Install reason | Failed check |
| --- | --- |
| 1 | The checker foundation is unavailable or differs from the recorded foundation. |
| 2 | The package lacks the required certificate witnesses. |
| 3 | The certificate names a different checker foundation. |
| 4 | The certificate names a different parent law identity. |
| 5 | The candidate law declaration or manifest does not parse. |
| 6 | The checker cannot construct both goals in the extended environment. |
| 7 | The candidate model's proof of its own declared law fails. |
| 8 | The candidate's proof of entailment to the current law fails. |
| 9 | The outer tag denotes an installation and the package does not decode. |

The input buffer holds 1,179,774 bytes per submission. The first call beyond capacity returns 0. Call the intended consuming operation to finish that failed submission before supplying the next one, or use `reset` to discard both pending input and candidate staging. After a failed `feed` on an initialized machine, later feeds and install attempts return 0 until reset. The adapter continues to accept ordinary input, owner clears and rebinds, even with the staging error set. Direct accessors such as `head` leave pending input alone. Candidate files can exceed the input buffer by using repeated `input` and `feed` operations. Certificate limits apply separately.

```js
const { instance } = await WebAssembly.instantiate(wasmBytes, {});
const api = instance.exports;
function consume(name, bytes) {
  for (const value of bytes) api.input(value);
  return api[name]();
}
if (consume('init', packedOwnerKeys) !== 1) throw Error('genesis failed');
const verdict = consume('step', completeFrame);
const head = Uint8Array.from({ length: 32 }, (_, i) => api.head(i));
```

[Frame grammar and examples](WIRE.md) · [ABI implementation](Interface.c) · [Full release step](Round11.lean)
