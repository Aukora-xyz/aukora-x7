# Sealed shards: lock a file, split it into pieces, bring it back from some of them

For Auma and the owner. sealed shards and sealed shards v2 (v2, below), 2026-11-18. Tags: RAN (run in this repository's tests), SOURCE (read in the code),
NOT VERIFIED.

**Status.** `deploy/cloudflare/src/sealed-shards.mjs` takes bytes and returns bytes.
The v1 and v2 fixtures check for references to the experimental codec in top-level edge source files.
See `deploy/cloudflare/src/__tests__/sealed-shards.test.mjs` and
`deploy/cloudflare/src/__tests__/sealed-shards-v2.test.mjs`. Deployment and custody remain unverified.

## What it is for

The file is encrypted and encoded into n pieces. With a trusted manifest, k distinct valid pieces reconstruct the complete ciphertext. Fewer pieces can contain parts of that ciphertext. Opening the file also needs the v1 unwrapping secret or the v2 recipient private key. Recovery tolerates up to n − k missing or invalid pieces when k valid ones remain.
- For a file of P bytes, the n pieces together occupy n × ceil((P + 16) / k) bytes, excluding the manifest. For large files the storage ratio approaches n/k.

The [cipher and coding identifiers](../../deploy/cloudflare/src/sealed-shards.mjs#L40) and the [project’s manifest fields](../../deploy/cloudflare/src/sealed-shards.mjs#L381) are defined in the codec.

## The two calls (SOURCE)

- `sealToShards(plain, { secret, k, n })` answers `{ ok: true, manifest, manifestJson, manifestSha256, shards }`.
  `shards[i]` is piece i.
- `openFromShards({ manifest, shards, secret })` takes the manifest (the object or its exact text) and a list of
  `{ index, bytes }` in any order, as many as were found. It answers `{ ok: true, plain, manifestSha256, used, rejected }`.
- `checkShard(manifest, index, bytes)` says whether a piece is the one the manifest names. It needs no secret: a store,
  or a scheduled re-check, can run it.

For v1, supply 32 bytes from a cryptographically secure random source.
The encoder checks that the recovery secret is a 32-byte `Uint8Array`. The caller supplies its randomness.
[Encoder input check](../../deploy/cloudflare/src/sealed-shards.mjs#L397).

## The format, exactly (`aukora.sealed-shards.v1`)

Written so that a second implementation can be made from this page alone. All hex is lower case. `||` joins bytes.

**The lock.**

1. Four random draws, in this order: wrap salt (32 bytes), wrap nonce (12), data key (32), body nonce (12).
2. `wrap key = HKDF-SHA-256(key material = secret, salt = wrap salt, info = UTF-8 "aukora.sealed-shards.v1 key-wrap")`,
   32 bytes.
3. `wrapped = AES-256-GCM(key = wrap key, nonce = wrap nonce, associated data = A("wrap"), message = data key)`:
   32 bytes followed by the 16-byte tag.
4. `ciphertext = AES-256-GCM(key = data key, nonce = body nonce, associated data = A("body"), message = the file)`:
   the file's length plus the 16-byte tag.
5. `A(part)` is the UTF-8 text of the JSON array `["aukora.sealed-shards.v1",part,k,n,plainBytes]` with no spaces, for
   example `["aukora.sealed-shards.v1","body",3,5,25]`. So both locks are bound to the numbers that shape the pieces.

**The cut.**

1. `shardBytes = max(1, ceil((plainBytes + 16) / k))`. The ciphertext is padded with zero bytes to `k * shardBytes`.
2. Data piece i (0 ≤ i < k) is bytes `[i * shardBytes, (i + 1) * shardBytes)` of that.
3. Parity piece i (k ≤ i < n): its byte t is the sum over j = 0..k-1 of `inverse(i XOR j) * dataPiece_j[t]`.
4. The arithmetic is in GF(2^8) with the polynomial x^8 + x^4 + x^3 + x^2 + 1 (0x11d): addition is XOR, and
   `inverse(a) = a^254`. This is a systematic Cauchy Reed-Solomon code: the identity on top of a Cauchy matrix with
   x = i and y = j. Every k of its n rows are independent, which is why any k pieces are enough. n is at most 255.
5. To rebuild: take any k good pieces, invert the k-by-k matrix made of their rows (row i is the unit row for a data
   piece, the Cauchy row for a parity piece), multiply, join the k data pieces and keep the first `plainBytes + 16` bytes.

**The manifest.** One JSON object with exactly these keys in exactly this order, serialised with no spaces:

```json
{"schema":"aukora.sealed-shards.v1","cipher":"AES-256-GCM","kdf":"HKDF-SHA-256","code":"cauchy-rs-gf256-11d",
 "k":3,"n":5,"plainBytes":25,"shardBytes":14,
 "wrap":{"salt":"<64 hex>","iv":"<24 hex>","key":"<96 hex>"},
 "body":{"iv":"<24 hex>","sha256":"<SHA-256 of the ciphertext with its tag>"},
 "shards":["<SHA-256 of piece 0>","...","<SHA-256 of piece n-1>"]}
```

(The line breaks above are for reading only.) Numbers are written as plain decimal whole numbers: no sign, no
fraction, no exponent. `manifestSha256` is the SHA-256 of that text. The manifest can rest
beside every piece. The v1 caller keeps the recovery secret.
The manifest carries the wrapped data key.

## Opening, and every refusal (SOURCE)

A piece is used only if its index is in range, no GOOD piece is already held at that index, it has `shardBytes` bytes
and its SHA-256 is the one the manifest names at that index. Pieces are judged in the order offered. Every other piece
is set aside and listed in `rejected`, in the order offered, as `{ index, why }` with the reason `index`, `duplicate`,
`length` or `hash` (`index` is `null` when what was offered has no whole-number index). **A bad piece does not hold
its place:** a place that hands back changed bytes cannot block a valid piece offered later at the same index.
After acceptance, a later offer at that index is a `duplicate` regardless of its bytes. The k good pieces with the lowest indexes are used.

The v1 [encoder](../../deploy/cloudflare/src/sealed-shards.mjs#L403) uses a key derived from the caller’s recovery secret to wrap a separately generated data key.
The [v1 reader](../../deploy/cloudflare/src/sealed-shards.mjs#L507) checks the recovery secret, piece array and manifest, then [counts valid pieces, reconstructs the ciphertext and checks its digest](../../deploy/cloudflare/src/sealed-shards.mjs#L468). It unwraps the data key and decrypts the file.

| Code | When |
|---|---|
| `SHARDS_INPUT` | In v1, the recovery secret must be a 32-byte `Uint8Array`, and the reader requires a piece array. The encoder requires a `Uint8Array` file of at most 320 MiB, integers with 1 ≤ k ≤ n ≤ 255, and a random function that returns a `Uint8Array` of each requested length. |
| `SHARDS_MANIFEST` | Not this format: a wrong or missing or extra key, a number that does not fit, hex of the wrong length or case, or text that is not the canonical text. |
| `SHARDS_TOO_FEW` | Fewer than k good pieces. It says `need`, `good` and `rejected`. |
| `SHARDS_SECRET` | The secret does not open this manifest's data key: a wrong secret, or the wrap or the bound numbers were changed. |
| `SHARDS_CIPHERTEXT` | The pieces are the named ones but the locked file does not check out: the manifest was changed. |

A refusal never carries bytes of the file.

## v2: locked to a public key (`aukora.sealed-shards.v2`)

Sealed shards v2 wraps the data key to the recipient’s X25519 public key. The sender can encrypt a copy
without the recipient’s private key. The sender still handles the plaintext, file key and temporary encryption material.
Recovering the wrapped file key requires the matching private key. See `sealToShardsFor` and `openFromShardsWith`
in `deploy/cloudflare/src/sealed-shards.mjs`.

**The calls (SOURCE).**

- `sealToShardsFor(plain, { publicKey, k, n })` answers what `sealToShards` answers. `publicKey` is the raw 32-byte
  X25519 public key (RFC 7748).
- `openFromShardsWith({ manifest, shards, privateKey })` answers what `openFromShards` answers. `privateKey` is the
  raw 32-byte X25519 private key.
- `checkShard` reads both formats. After the key and piece-array checks,
  each reader returns `SHARDS_MANIFEST` for a manifest in the other format.

**The construction.** HPKE, RFC 9180, base mode (mode 0x00, no PSK, no sender key), single-shot `Seal` of the 32-byte
data key, with the suite:

| Part | Choice | id |
|---|---|---|
| KEM | DHKEM(X25519, HKDF-SHA256) | 0x0020 |
| KDF | HKDF-SHA256 | 0x0001 |
| AEAD | AES-256-GCM | 0x0002 |

`info` is the UTF-8 text `aukora.sealed-shards.v2 key-wrap`. The AEAD's associated data is `A2("wrap")`, where
`A2(part)` is the UTF-8 text of `["aukora.sealed-shards.v2",part,k,n,plainBytes]` with no spaces.

**The lock, step by step.** The [file-key wrap](../../deploy/cloudflare/src/sealed-shards.mjs#L440) uses RFC 9180 base mode. Steps 8 and 9 cover the [body encryption and shard encoding](../../deploy/cloudflare/src/sealed-shards.mjs#L368). The `suite_id` is `"KEM" || 0x0020` inside the KEM and
`"HPKE" || 0x0020 || 0x0001 || 0x0002` in the key schedule; an empty HKDF salt means 32 zero bytes (RFC 5869).

1. Three random draws, in this order: ephemeral key seed `ikmE` (32 bytes), data key (32), body nonce (12).
2. `DeriveKeyPair(ikmE)` (RFC 9180 section 7.1.3): `skE = LabeledExpand(LabeledExtract("", "dkp_prk", ikmE), "sk",
   "", 32)`, `pkE = X25519(skE, 9)`. `enc = pkE`.
3. `dh = X25519(skE, pkR)`. If `dh` is 32 zero bytes the public key is refused (section 7.1.4): `SHARDS_INPUT`,
   `why: "publicKey"`. This catches the all-zero key and every other low-order key. Before any draw, a `pkR` that is
   not the canonical encoding (top bit set, or u ≥ 2^255 - 19) is refused the same way: X25519 reads it as the same
   point, but `to` and `enc || pkR` would carry bytes the owner never recomputes, so the set could never be opened.
4. `shared_secret = LabeledExpand(LabeledExtract("", "eae_prk", dh), "shared_secret", enc || pkR, 32)`.
5. Key schedule (section 5.1), base mode: `context = 0x00 || LabeledExtract("", "psk_id_hash", "") ||
   LabeledExtract("", "info_hash", info)`; `secret = LabeledExtract(shared_secret, "secret", "")`;
   `key = LabeledExpand(secret, "key", context, 32)`; `base_nonce = LabeledExpand(secret, "base_nonce", context, 12)`.
6. The nonce for sequence 0 is `base_nonce XOR I2OSP(0, 12)`, that is `base_nonce`.
7. `sealed key = AES-256-GCM(key, base_nonce, A2("wrap"), data key)`: 32 bytes and the 16-byte tag.
8. The body: as v1 step 4, with associated data `A2("body")`.
9. The cut: exactly as v1.

`LabeledExtract(salt, label, ikm) = HKDF-Extract(salt, "HPKE-v1" || suite_id || label || ikm)` and
`LabeledExpand(prk, label, info, L) = HKDF-Expand(prk, I2OSP(L, 2) || "HPKE-v1" || suite_id || label || info, L)`.

**The manifest.** The v1 keys in the v1 order, with `kdf` and `wrap` changed:

```json
{"schema":"aukora.sealed-shards.v2","cipher":"AES-256-GCM","kdf":"HPKE-X25519-HKDF-SHA256","code":"cauchy-rs-gf256-11d",
 "k":3,"n":5,"plainBytes":25,"shardBytes":14,
 "wrap":{"to":"<SHA-256 of the raw 32-byte public key, 64 hex>","enc":"<64 hex>","key":"<96 hex>"},
 "body":{"iv":"<24 hex>","sha256":"<SHA-256 of the ciphertext with its tag>"},
 "shards":["<SHA-256 of piece 0>","...","<SHA-256 of piece n-1>"]}
```

`to` is a fingerprint: it tells a holder which key opens the set. It is not secret, and it is not inside the AEAD's
associated data; a changed `to` changes `manifestSha256`, and the open below checks it.

**Opening.** The checks run in the v1 order, with the private key's length first and the wrap in the place of the
secret: the private key's length (`SHARDS_INPUT`, `why: "privateKey"`), the list of pieces, the manifest, the count of
good pieces, the rebuild, the ciphertext's SHA-256, then the wrap: `SHARDS_SECRET` when SHA-256 of
`X25519(privateKey, 9)` is not `to`, when `X25519(privateKey, enc)` is all zero, or when the HPKE open fails (a wrong
key, or a changed `enc`, `key`, k, n or plainBytes); last the file's lock (`SHARDS_CIPHERTEXT`). The refusal list is
the v1 list; nothing was added to it.

**Vectors.** `sealed-shards.vectors.json` holds, under `v2`: the RFC 9180 Appendix A.1 values (the RFC's own test
suite uses AES-128-GCM, so the AEAD is a parameter inside the module, and the same code runs both), and three v2
vectors (3 of 5, 1 of 3 with an empty file, 20 of 80), each with its test key pair, its three draws, `enc`, the
sealed key, the manifest text, its SHA-256 and every piece. Every key in that file is a published test key.

**Evidence (v2).**

- RAN `deploy/cloudflare/src/__tests__/sealed-shards-v2.test.mjs` (12 tests): every RFC 9180 A.1 value (both key
  pairs from their seeds, enc, shared_secret, key, base_nonce, the first nonce and ciphertext, and the open); files back
  byte for byte from every choice of k pieces for six shapes and eight sizes; a wrong private key, a near one and a
  stranger's key renamed into `to` refused; a changed enc (including the six low-order points), sealed key, `to`, k,
  n and plainBytes refused with their codes, and each bound number checked at the HPKE open; v1 and v2 never opening
  each other under any renaming; the six low-order public keys refused; non-canonical public keys (top bit set, u ≥ p)
  refused before any draw; the draws' order and sizes; the three v2
  vectors reproduced byte for byte; "wired to nothing" for the v2 names.
- RAN a cross-check against Python `cryptography` 49.0.0 (kept outside this repository).
  Its HPKE (`hpke.Suite`, a separate Rust/OpenSSL implementation) takes **no associated data**, so it checked the
  JavaScript directly with empty associated data, both ways (KEM, KDF, key schedule, info, AEAD). A short Python
  RFC 9180 written from the RFC on that library's X25519, HMAC and AES-GCM was held to the RFC's A.1 vector and to the
  library, and carried the check to the real associated data: JavaScript-locked files opened in Python, Python-sealed
  wraps opened in JavaScript, the pinned vectors opened and re-made from their draws: 129 checks, 0 failed.

## What it does not do, and what it cannot tell you

- **Which shard set is current.** Compare `manifestSha256` with a trusted digest for the backup you intend to restore.
  Identifying the newest set requires an up-to-date reference to its shard manifest.
  The [witness field](../../deploy/cloudflare/src/witness-do.mjs#L128) names the nightly-copy manifest.
  The [shard reader](../../deploy/cloudflare/src/sealed-shards.mjs#L514) computes a separate digest for its manifest.
- **It does not hide the file's length**, or that the pieces belong together.
- **It does not choose or reach stores**, sign anything, keep the secret or recover it. With the manifest, k valid pieces can reconstruct the ciphertext.
  The supplied reader needs the v1 recovery secret or v2 recipient private key to open it.
- The [codec](../../deploy/cloudflare/src/sealed-shards.mjs#L371) holds the whole file in memory and [limits plaintext to 320 MiB](../../deploy/cloudflare/src/sealed-shards.mjs#L36).
  Browser operation at that size is unverified. Splitting a large home into smaller inputs is unbuilt.

## Evidence

- RAN `deploy/cloudflare/src/__tests__/sealed-shards.test.mjs` (14 tests): the field against a slow multiply for all
  65,536 products; data back from every choice of k pieces for seven small shapes, and from sampled choices for 20 of
  80, 10 of 255 and 128 of 255; a file back byte for byte from every choice of k pieces for five shapes and ten sizes;
  k - 1 pieces refused; a changed piece set aside and replaced; a wrong secret refused; 27 kinds of changed manifest
  each refused with its code; four pinned vectors (`sealed-shards.vectors.json`: 3 of 5, 1 of 3 with an empty file,
  4 of 10, 20 of 80) reproduced exactly from their recorded random draws.
- RAN `recovery-restore.test.mjs` "sealed shards": a recovery file made exactly as the Continuity screen makes it, locked and
  cut 3 of 5, with one piece lost and one changed, comes back byte for byte and restores into an EMPTY edge with the
  same head, receipts and mirror digest. With one more piece lost it is refused. A stranger's secret is refused.
- RAN a second implementation (Python, written by another model from this page and the vectors only, never shown the
  module; kept outside this repository): all four vectors reproduced exactly (manifest text,
  digest, every piece) and opened from the first k, the last k and 25 random choices of k pieces; 231 checks, 0 failed.
  It named four things this page had left unsaid (a bad piece and its place, the order of the checks, how numbers are
  written, the shape of `rejected`); each is now stated above.

## Not built, not verified

- Deployment of the codec and custody of pieces remain unverified.
- No signature on the manifest and no field for it in the witness record.
- NOT VERIFIED: no review by a cryptographer (of v1 or of v2); no run in a Workers isolate or a browser (Node 24
  WebCrypto only; v2 needs WebCrypto X25519 with PKCS #8 import, which is not checked there); no measurement on a file
  of her real size. The v2 associated data was checked against a Python RFC 9180 written by the same author as the
  JavaScript, held to the RFC vector and to an independent library that has no associated-data parameter.
- v2 has no key rotation, no second recipient and no sender authentication (base mode: anyone with the public key can
  make a set that opens). How the owner's own X25519 key
  pair is made and kept is not decided here.
- It is JavaScript at the edge, not a pinned Wasm cell. The cut (not the lock) is integer table work that would fit a
  cell like `pentora-codec`.
- Open for the owner, none decided here: which places hold pieces (they must be run by different operators, with at
  least one he controls); how the 32-byte secret is made, shown and kept, through his own onboarding; how many pieces.
