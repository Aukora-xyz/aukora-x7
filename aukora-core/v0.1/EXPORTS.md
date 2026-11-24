# Wasm byte ABI

`aukora-core.wasm` exposes 15 functions. Each parameter and result is one WebAssembly `i32`, interpreted as an unsigned integer. Internal pointers and linear memory are private. The host creates a fresh instance with an empty import object. Each instance holds its own current machine, staging area and input buffer. The same ABI applies to the fixed-genesis test candidate. Its Lean genesis validates the supplied key input using the ordinary admission rule, then initializes with its compiled-in Ed25519 and ML-DSA-65 public keys. The fixed pair is distributed in `fixtures/fixed-owner/keys.bin`.

| Export | Arguments | Result and effect |
| --- | --- | --- |
| input | byte | Append one byte in 0..255, return 1. An out-of-range byte or buffer overflow marks the submission invalid and returns 0. Subsequent input for that submission returns 0. |
| init | none | Consume exactly 1,984 bytes in the order EdKey[32], MLKey[1952]. Return 1 on successful genesis and 0 for invalid input, checker initialization failure or repeat initialization. The initial head and installed digest are 32 zeros. EdKey must decode to a non-identity point in the prime-order subgroup. |
| step | none | Consume one complete ledger frame. Return 1 on admission and 0 on refusal, including use before genesis. An admission appends its exact bytes to the record. A refusal leaves the machine state intact. |
| reset | none | Clear pending input and the invalid-staging flag. If initialized, discard staged candidate bytes and return 1. Otherwise return 0. Ledger, keys, stamps and threshold survive. |
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

The replay-only `aukora-core-lite.wasm` exports the same 15 functions. Its `step()` returns 0 for **every outer tag 1b** (decimal 27), including a package with a valid certificate and a matching staged and authorized file. The installed digest therefore stays at genesis. A host can replay ordinary ledger sessions with this variant. For a history with an accepted install, use the full core to reproduce that transition and the subsequent head chain.

The input buffer holds 1,179,774 bytes per submission. The first call beyond capacity returns 0. Call the intended consuming operation to finish that failed submission before supplying the next one, or use `reset` to discard both pending input and candidate staging. A failed `feed` on an initialized machine also prevents later input until `reset`. Direct accessors such as `head` leave pending input alone. Candidate files can exceed the input buffer by using repeated `input` and `feed` operations. Certificate limits apply separately.

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

[Frame grammar and examples](WIRE.md) · [ABI implementation](Interface.c) · [Release machine](Machine.lean)
