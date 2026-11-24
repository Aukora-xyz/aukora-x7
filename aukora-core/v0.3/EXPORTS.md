# Wasm byte ABI

The full `aukora-core.wasm` and replay-only `aukora-core-lite.wasm` each expose 20 functions and require zero imports. Each argument and result is a Wasm `i32`, interpreted as unsigned. A fresh instance holds its own owner keys, ledger, sidecars, staging and input buffer. The lite profile runs the same evidence and recovery operations and refuses every install. [Full step](Round11.lean) · [Lite step](Lite12.lean)

| Export | Arguments | Result and effect |
| --- | --- | --- |
| input | byte | Append one byte in 0..255, return 1. An out-of-range byte or buffer overflow marks the submission invalid and returns 0. Subsequent input for that submission returns 0. |
| init | none | Consume exactly 1,984 bytes in the order EdKey[32], MLKey[1952]. Return 1 on successful genesis and 0 for invalid input, checker initialization failure or repeat initialization. The initial head and installed digest are 32 zeros. EdKey must decode to a non-identity point in the prime-order subgroup. |
| step | none | Consume one complete ledger frame. Return 1 on admission and 0 on refusal, including use before genesis. An admission appends its exact bytes to the record within the shared session quota. A refusal leaves the machine state intact. |
| reset | none | Clear pending input, including an invalid submission. If initialized, discard staged candidate bytes and return 1. Otherwise return 0. The ledger, owner keys, stamps, thresholds, halt flag and pinned law identity survive. |
| feed | none | Consume pending bytes as a candidate chunk. Return 1 after appending it to the current staging area. Invalid input or missing genesis returns 0. A rejected chunk preserves the previous staging area. A later chunk that fits can still append. An accepted install empties the staging area. |
| head | index | Byte at index 0..31 of the current ledger head. Return 256 before genesis or outside that range. |
| core | index | Byte at index 0..31 of the installed digest in the ledger. Return 256 before genesis or outside that range. A successful install records the selected digest. The host resolves and instantiates the selected bytes. |
| recordByte | entry, offset | Byte in the accepted ledger record. Both indices are zero-based. Return 256 before genesis or for a missing entry or offset. |
| threshold | none | Current danger threshold, 0..255. Initial value 0. Return 256 before genesis. |
| stamp | none | Consume current head[32], u16 little-endian beacon length, beacon bytes, receipt digest[32]. Return 1 when the full input parses, the head matches and the session quota has space, otherwise 0. Appends the submitted bytes to a sidecar. |
| stampCount | none | Number of accepted sidecar stamps. Return 0 before genesis. |
| stampByte | entry, offset | Byte of a sidecar stamp, indexed from zero. Return 256 before genesis or outside the saved bytes. |
| verify | none | Consume EdKey[32], EdSig[64], remaining message bytes. Return 1 when the Ed25519 verifier accepts, otherwise 0. This read-only cryptographic primitive can run before genesis. |
| hashHead | none | Consume a 00, 13 or 14 envelope and return the first byte of its whole-envelope SHA-256, or 256 if its envelope prefix fails to parse or input failed. This read-only operation can run before genesis. It parses the outer prefix and does not validate the inner action. |
| outcome | none | Consume the 32-byte SHA-256 of an encoded intent. Return 0 confirmed, 1 failed, 2 unknown. Add 4 for a labelled correction, giving 4, 5, 6. Return 256 for a missing result, missing genesis or invalid submission. |
| halted | none | Return 1 when the most recently committed halt/clear leaves the machine halted, 0 when running and 256 before genesis. |
| guessCeiling | none | Current owner-controlled ceiling for guessed claims, 0..255. Initial value 0. Return 256 before genesis. |
| lawByte | index | Byte at index 0..31 of the stored law identity, including its checker foundation. The instance fills the 32-byte value at genesis and refreshes it after each accepted install. Return 256 before genesis or outside the available bytes. Lite always returns 256. |
| installReason | none | Consume a proposed wire. For tag 27, full first compares the staged executable and then checks the owner package commitment and ratchet certificate. Lite returns 12 for tag 27. Other tags return 0. Both return 256 before genesis or for invalid pending input. A zero result still requires all `step` checks, including the grant and quotas. |
| witnessMask | none | Consume an install package and check its two witnesses independently. Bit 0 means candidate satisfaction passed. Bit 1 means both universal law entailment and the submitted grammar commitment passed. Return the mask 0–3 or 256 when input, staging, judge or goals are unavailable or invalid. Lite always returns 256. The diagnostic grants no installation authority. |

The full gate selects the 36-clause ROOT v1 goal. It checks the combined law-entailment and grammar witness first (reason 8), then satisfaction (reason 7). The full model accepts a versioned halt excluded by the unchanged D5 and P1 safety clauses. It therefore cannot supply its own satisfaction certificate. The diagnostic alone cannot establish an install or its law lineage. [Exact goal](Root12.lean) · [Conflict proofs](Proofs/Root12Conflict.lean)

| Install reason | Failed check |
| --- | --- |
| 1 | The checker foundation is unavailable or differs from the recorded foundation. |
| 2 | The package lacks the required certificate witnesses. |
| 3 | The certificate names a different checker foundation. |
| 4 | The certificate names a different parent law identity. |
| 5 | The candidate law declaration or manifest does not parse. |
| 6 | The checker cannot construct both goals in the extended environment. |
| 7 | The candidate model's proof of its own declared law fails. |
| 8 | The candidate's transition witness fails to prove universal law entailment and grammar preservation. |
| 9 | The outer tag denotes an installation and the package does not decode. |
| 10 | Package decoded, but its owner intent carries a different model/proof commitment. |
| 11 | The staged file failed the full executable-prefix or trailing custom-section check. |
| 12 | Lite refuses every installation. |

## Finite session

| Resource | Inclusive limit | What consumes it |
| --- | ---: | --- |
| Pending input | 1,179,774 bytes | Bytes since the last consuming call |
| Candidate staging | 16 MiB | All accepted feed chunks since reset or install |
| Record entries | 512 | Accepted frames and stamps combined |
| Record bytes | 2 MiB | Complete encoded bytes of accepted frames and stamps combined |
| Linear memory | 4,096 Wasm pages (256 MiB) | Static data, stack, runtime, declaration environment, staging, record and temporary allocations |

An invalid byte or an input overflow invalidates the rest of that submission. The consuming call discards it and returns refusal. A feed that exceeds staging capacity preserves the accumulated candidate. Direct accessors leave pending input available. A zero-byte feed fits even when staging reaches the cap.

The 16 MiB staging budget accommodates the full executable and additional custom metadata. The full file declares 223 initial pages and lite declares 147. Both set the same 4,096-page maximum. The separate install submission still limits model plus proof to 1 MiB. The 256 MiB linear-memory maximum budgets space for the static environment, 8 MiB stack, bounded live data and temporary parser/checker allocations. Section limits and the stage and record guards keep comparisons inside bounded machine-word arithmetic. A stamp consumes one entry and all its encoded bytes, including the beacon and its length field. A record at capacity is terminal for further appends, including a correctly signed clear or rebind. Its contents remain readable. A new instance begins a new genesis with a separate history. The unbounded model’s H5 recovery proof applies before those physical limits. [Bounded model](Bounds12.lean) · [Boundary vectors](tests/bounds12.mjs)

The adapter refuses over-quota submissions before allocating their Lean byte arrays. Wasm instantiation, in-quota allocations, expression checking, cryptography and the runtime stack can still exhaust host or linear memory and trap. A terminal record and a declared memory maximum do not establish a universal no-trap theorem. [ABI implementation](Interface.c) · [Linker limit](tools/link.py)

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
