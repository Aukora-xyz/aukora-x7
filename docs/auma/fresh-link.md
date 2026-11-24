# Fresh Link v0 — hybrid key exchange and per-connection Ed25519 keys

Fresh Link is an experimental peer handshake with initiator and responder entry points. [fresh-link.mjs:204](../../deploy/cloudflare/src/fresh-link.mjs#L204) · [fresh-link.mjs:225](../../deploy/cloudflare/src/fresh-link.mjs#L225)

## Suite and interface

| Source field | Literal value | Source |
|---|---|---|
| `id` | `0x0001` | [fresh-link.mjs:31](../../deploy/cloudflare/src/fresh-link.mjs#L31) |
| `name` | `'freshlink/v0 suite 0x0001'` | [fresh-link.mjs:32](../../deploy/cloudflare/src/fresh-link.mjs#L32) |
| `hash` and `kdf` | `'SHA-256'` and `'HKDF-SHA-256'` | [fresh-link.mjs:36](../../deploy/cloudflare/src/fresh-link.mjs#L36) |
| `mac` and `aead` | `'HMAC-SHA-256'` and `'AES-256-GCM'` | [fresh-link.mjs:36](../../deploy/cloudflare/src/fresh-link.mjs#L36) |
| Session methods | `send, receive, transcript, fingerprint, close` | [fresh-link.mjs:409](../../deploy/cloudflare/src/fresh-link.mjs#L409) |

## Offline vector check

From the repository root, with the dependencies installed:

```sh
node --test deploy/cloudflare/src/__tests__/fresh-link-vectors.test.mjs
```

The vector fixture checks the library’s handshake against reference outputs and an in-tree second implementation in both roles. [fresh-link-vectors.test.mjs:200](../../deploy/cloudflare/src/__tests__/fresh-link-vectors.test.mjs#L200) · [fresh-link-vectors.test.mjs:266](../../deploy/cloudflare/src/__tests__/fresh-link-vectors.test.mjs#L266) · [fresh-link-vectors.test.mjs:292](../../deploy/cloudflare/src/__tests__/fresh-link-vectors.test.mjs#L292)

**Not verified.** The authors describe the composition as experimental and unreviewed. External peer interoperability and an independent audit covering these dependency versions remain unverified here. [fresh-link.mjs:2](../../deploy/cloudflare/src/fresh-link.mjs#L2)

**Not done.** The project supplies fixture and vector callers. A shipped node route using this handshake is unbuilt. [fresh-link.test.mjs:37](../../deploy/cloudflare/src/__tests__/fresh-link.test.mjs#L37) · [fresh-link.test.mjs:319](../../deploy/cloudflare/src/__tests__/fresh-link.test.mjs#L319)
