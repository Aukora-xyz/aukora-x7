# Fresh Link v0: fresh keys and a throwaway identity for every connection

**Experimental, unreviewed, used by nothing.** No cryptographer has reviewed this composition. No second, independent
implementation has been run against its vectors (the only second implementation is the one inside this repository's own
test). No route, Durable Object or app imports `deploy/cloudflare/src/fresh-link.mjs`, and a test
(`deploy/cloudflare/src/__tests__/fresh-link.test.mjs`, "wired to nothing") keeps it that way until someone changes it
on purpose.

It is not a new cipher. It is a choice from a short menu of proven methods, always doubled so that both a classical and a
post-quantum method must be broken, with fresh keys and a throwaway identity for each connection, and a chained transcript
both sides can compare. The shape is SIGMA, as TLS 1.3 and IKEv2 use it: an ephemeral key exchange, each side signs the
transcript, each side sends a MAC under a key from the exchange.

## The parts (suite `0x0001`, the only entry on the menu)

| Part | What | Where it is specified | Library |
|---|---|---|---|
| Key exchange | X-Wing: X25519 + ML-KEM-768 (pk 1216, ct 1120, ss 32 bytes) | draft-connolly-cfrg-xwing-kem-11; FIPS 203; RFC 7748 | `@noble/post-quantum/hybrid.js` `ml_kem768_x25519` |
| Long-term signatures | Ed25519 AND ML-DSA-65 (context `freshlink/v0`), both required | RFC 8032 (strict, not ZIP-215); FIPS 204 | `@noble/curves/ed25519.js`, `@noble/post-quantum/ml-dsa.js` |
| Throwaway identity | a fresh Ed25519 key pair per connection | RFC 8032 | `@noble/curves/ed25519.js` |
| Hash, KDF, MAC, AEAD | SHA-256, HKDF-SHA-256, HMAC-SHA-256, AES-256-GCM | FIPS 180-4, RFC 5869, RFC 2104, SP 800-38D | WebCrypto (`crypto.subtle`) |

Identity keys `idK = Ed25519 public key (32) || ML-DSA-65 public key (1952)`; identity id `= SHA-256("freshlink/v0 id" || idK)`.
Long-term secret keys never enter the library: the caller passes a `signer` that signs.

## The three messages

1. **m1** (initiator, 1285 bytes) `= "FL" || 0x00 || suite || nI || epk || tIpk`: a fresh X-Wing public key, a fresh
   throwaway public key, a random nonce.
2. **m2** (responder, 6653 bytes) `= ct || nR || tRpk || seal(hsR, aad TH1, idK_R || sig_R || tsig_R || mac_R)`. The
   responder refuses an m1 whose length, magic, version or suite is not exact or not in its own allowed set (no
   negotiation, no fallback). `TH1` hashes m1 and the clear part of m2; the four handshake keys come from
   HKDF(salt TH1, ikm X-Wing shared secret). `TH2` adds the responder's identity keys; both long-term signatures, the
   throwaway signature and the MAC are over `TH2`.
3. **m3** (initiator, 5469 bytes) `= seal(hsI, aad TH2f, idK_I || sig_I || tsig_I || mac_I)`, where `TH2f` hashes
   everything the responder sent and `TH3` adds the initiator's identity keys.

`TH4` (everything the initiator sent, on top) is the session id; the two application keys are HKDF over the same secret
with `TH4` in the label. A frame is `counter (8) || AES-256-GCM(...)`; the receiver accepts only exactly the next counter,
any failure kills the session, and a direction closes before 2^32 frames. The exact byte layout is in the module's code and
in `deploy/cloudflare/src/fresh-link.vectors.json`.

## What each side proves

- **The responder** proves it holds both long-term keys of `idK_R` (two signatures over `TH2`), that it holds the throwaway
  key `tRpk` it sent in the clear (a signature over `TH2`), and that it holds the X-Wing shared secret (the MAC under
  `fkR`, and m2 opening under `hsR`).
- **The initiator** proves the same over `TH3`, which contains everything the responder sent: both long-term signatures,
  the throwaway signature under `tIpk` from m1, and the MAC under `fkI`.
- **The peer rule is never implicit.** The initiator names the peer it expects (a 32-byte id) or passes an `acceptPeer`
  function; the responder must pass `acceptPeer`. There is no default that accepts anyone.

Every handshake failure a peer can cause is one error, `FRESHLINK_HANDSHAKE_FAILED`, with no detail about which check
failed; every spoiled frame is `FRESHLINK_FRAME_FAILED`. Local misuse has its own codes. No error carries key material.

## What it gives

- A session key that needs **both** X25519 and ML-KEM-768 broken (the X-Wing combiner).
- Identity forgery that needs **both** Ed25519 and ML-DSA-65 broken.
- Fresh keys per connection: a later theft of a long-term key does not open past sessions.
- A throwaway outer identity: two connections cannot be linked by an onlooker through the keys sent in the clear.
- A transcript both sides can compare: per direction `C_n = SHA-256("freshlink/v0 chain" || C_(n-1) || counter || SHA-256(frame))`
  from `C_0 = TH4`; `transcript()` hashes both chains and both counts. Both sides get the same 32 bytes when they have
  handled the same frames. `fingerprint()` shows its first 6 bytes as `xxxx-xxxx-xxxx` for two people (or two of her) to
  compare, and the 32 bytes are what one of her records can commit to ("this was said").

## What it does NOT give

- The responder's identity is hidden from onlookers, but not from anyone who connects to it.
- No resumption, no early data, no group messaging, no deniability (the long-term signatures are evidence).
- The transcript is not a signature. Both sides hold both application keys, so either side alone can make frames for
  both directions and a matching transcript. Equal transcripts show that the two sides handled the same frames; they
  prove nothing to a third party about who said what. Only the long-term signatures in the handshake are evidence.
- X-Wing is an Informational Independent Submission draft (draft-connolly-cfrg-xwing-kem-11), not a standard.
- `@noble/post-quantum` 0.7.1 (X-Wing, ML-DSA) has no independent audit. `@noble/curves` lists independent audits of
  earlier versions; the version used here is 2.4.0, and whether any audit covers it is not verified by this library.
- A JavaScript runtime cannot promise memory is wiped: `close()` overwrites the byte arrays it holds, best effort, and
  WebCrypto keys can only be dropped.

## Before real use

1. Review of the composition by a cryptographer.
2. A second, independent implementation, run against `fresh-link.vectors.json`.
3. The owner's go.
