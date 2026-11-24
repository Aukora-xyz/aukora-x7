# Her outside witness: Bitcoin timestamps and a chain of Nostr events

## The switch

The witness constructs signed commitments to records and requests timestamps for their digests. [witness.mjs:256](../../deploy/cloudflare/src/witness.mjs#L256) · [witness-do.mjs:967](../../deploy/cloudflare/src/witness-do.mjs#L967)

| Configuration | Shipped value or data | Source |
|---|---|---|
| Witness switch | `WITNESS_SWITCH = "on"` | [wrangler.toml:95](../../deploy/cloudflare/wrangler.toml#L95) |
| Full-record download | `GET /api/witness/record?seq=n`. `WITNESS_RECORD_PUBLIC` ships `"off"`. The closed-route code is `WITNESS_RECORD_NOT_PUBLIC`. | [wrangler.toml:98](../../deploy/cloudflare/wrangler.toml#L98) · [wrangler.toml:102](../../deploy/cloudflare/wrangler.toml#L102) · [witness-do.mjs:1322](../../deploy/cloudflare/src/witness-do.mjs#L1322) |
| Timestamp authority | `WITNESS_TSA`, `https://freetsa.org/tsr`, 32-byte digest. Download: `GET /api/witness/tsa?seq=n`. In the download routes, replace n with the positive decimal record sequence. | [witness-do.mjs:1142](../../deploy/cloudflare/src/witness-do.mjs#L1142) · [witness-do.mjs:251](../../deploy/cloudflare/src/witness-do.mjs#L251) · [wrangler.toml:104](../../deploy/cloudflare/wrangler.toml#L104) · [wrangler.toml:106](../../deploy/cloudflare/wrangler.toml#L106) · [tsa.mjs:21](../../deploy/cloudflare/src/tsa.mjs#L21) |
| Relay list | Includes `wss://relay.nostr.band` and `wss://nostr.mom` | [witness-do.mjs:54](../../deploy/cloudflare/src/witness-do.mjs#L54) |

## Witness events, record facts and nightly-copy data

| Field | Value or shape | Source |
|---|---|---|
| Record versions | `WITNESS_VERSIONS = Object.freeze([1, 2])` | [witness.mjs:34](../../deploy/cloudflare/src/witness.mjs#L34) |
| Event | Kind `4871`, chain `witness.v1`, empty content. The exact tag list is built by `witnessEventTemplate`. | [witness.mjs:37](../../deploy/cloudflare/src/witness.mjs#L37) · [witness.mjs:38](../../deploy/cloudflare/src/witness.mjs#L38) · [witness.mjs:177](../../deploy/cloudflare/src/witness.mjs#L177) |
| Full record · journals | Byte counts and newest-line digests. No words from the journal entries. | [wrangler.toml:99](../../deploy/cloudflare/wrangler.toml#L99) · [witness.mjs:85](../../deploy/cloudflare/src/witness.mjs#L85) |
| Nightly copy · omissions | Three HEAD rows are never copied: `aumlok:signin:v1`, `aumlok:devices:pending:v1` and `aumlok:v1`. | [nightly-copy.mjs:13](../../deploy/cloudflare/src/nightly-copy.mjs#L13) · [witness-nightly.test.mjs:455](../../deploy/cloudflare/src/__tests__/witness-nightly.test.mjs#L455) |
| Nightly manifest · vault inventory | Input per blob: key and size only. Completed inventory: count, total bytes and one digest of the sorted inventory. | [nightly-copy.mjs:289](../../deploy/cloudflare/src/nightly-copy.mjs#L289) · [nightly-copy.mjs:291](../../deploy/cloudflare/src/nightly-copy.mjs#L291) · [nightly-copy.mjs:381](../../deploy/cloudflare/src/nightly-copy.mjs#L381) |

Record metadata includes `trigger: "schedule" | "promotion"`. [witness-do.mjs:1125](../../deploy/cloudflare/src/witness-do.mjs#L1125)

The signed-out summary lists identifiers and status fields, including OTS, header and authority fields. These are example field fragments from the documentation fixture. [witness-switch.test.mjs:183](../../deploy/cloudflare/src/__tests__/witness-switch.test.mjs#L183) · [witness-switch.test.mjs:197](../../deploy/cloudflare/src/__tests__/witness-switch.test.mjs#L197) · [witness-do.mjs:1122](../../deploy/cloudflare/src/witness-do.mjs#L1122)

```text
"ots": { "state": "confirmed", "height": 900000, "header":
"tsa": { "state": "stored", "authority": "freetsa.org"
"tried": [ { "host": "mempool.space", "why": "http-429" }
```

## Limits, in the code

| Scope | Constant or fixture bound | Source |
|---|---|---|
| `POST /_witness/kick` | HEAD’s internal kick targets an alarm about 15 s ahead unless an earlier alarm is set. Promotion floor at least 60 s since the newest record. Rolling limit at most 24 promotion-triggered records per 24 hours. | [witness-do.mjs:47](../../deploy/cloudflare/src/witness-do.mjs#L47) · [witness-do.mjs:67](../../deploy/cloudflare/src/witness-do.mjs#L67) · [witness-do.mjs:429](../../deploy/cloudflare/src/witness-do.mjs#L429) · [witness-do.mjs:872](../../deploy/cloudflare/src/witness-do.mjs#L872) |
| Header batch | `headerRecordsPerTick: 2` (at most 2 records). Explorer batch: two at a time. | [witness-do.mjs:87](../../deploy/cloudflare/src/witness-do.mjs#L87) · [witness-do.mjs:601](../../deploy/cloudflare/src/witness-do.mjs#L601) |
| Header work and depth floors | At least 6 confirmations, at least 72 leading zero bits. Depth uses the lower of the tips of up to two Esplora sources. | [witness-do.mjs:87](../../deploy/cloudflare/src/witness-do.mjs#L87) · [witness-do.mjs:624](../../deploy/cloudflare/src/witness-do.mjs#L624) · [witness-do.mjs:629](../../deploy/cloudflare/src/witness-do.mjs#L629) |
| Header time limits | Explorer requests have an 8 s timeout and share one deadline of 30 s. The pass checks the deadline before starting a record. Source-specific response limits of 4 KiB and 2 KiB. | [witness-do.mjs:88](../../deploy/cloudflare/src/witness-do.mjs#L88) · [witness-do.mjs:167](../../deploy/cloudflare/src/witness-do.mjs#L167) · [witness-do.mjs:560](../../deploy/cloudflare/src/witness-do.mjs#L560) · [witness-do.mjs:683](../../deploy/cloudflare/src/witness-do.mjs#L683) |
| Header attempts | A header result can be recorded at most 8 times per record. After a disagreement, a saved disagreement count of 2 blocks a retry. An older entry without that counter can still be tried once more after a second disagreement, subject to the attempt and selection limits. | [witness-do.mjs:87](../../deploy/cloudflare/src/witness-do.mjs#L87) · [witness-do.mjs:542](../../deploy/cloudflare/src/witness-do.mjs#L542) · [witness-do.mjs:549](../../deploy/cloudflare/src/witness-do.mjs#L549) · [witness-do.mjs:562](../../deploy/cloudflare/src/witness-do.mjs#L562) |
| Header retry eligibility | Ordinary floor: at most once every 6 h. Unavailable result: at least 30 minutes between the first 3 tries, then every 6 h at the earliest, with no guarantee of selection on the next hourly tick. | [witness-do.mjs:87](../../deploy/cloudflare/src/witness-do.mjs#L87) · [witness-do.mjs:92](../../deploy/cloudflare/src/witness-do.mjs#L92) · [witness-do.mjs:550](../../deploy/cloudflare/src/witness-do.mjs#L550) · [witness-do.mjs:554](../../deploy/cloudflare/src/witness-do.mjs#L554) · [witness-do.mjs:560](../../deploy/cloudflare/src/witness-do.mjs#L560) |
| Header diagnostics | `headerTriedRows: 8` (at most 8 rows), `User-Agent: header-check/1` | [witness-do.mjs:94](../../deploy/cloudflare/src/witness-do.mjs#L94) · [witness-do.mjs:180](../../deploy/cloudflare/src/witness-do.mjs#L180) |
| Authority | `tsaTries: 3` (at most 3 tries recorded in saved state). Reply limit 16 KiB. | [witness-do.mjs:98](../../deploy/cloudflare/src/witness-do.mjs#L98) · [witness-do.mjs:647](../../deploy/cloudflare/src/witness-do.mjs#L647) · [witness-do.mjs:672](../../deploy/cloudflare/src/witness-do.mjs#L672) · [tsa.mjs:25](../../deploy/cloudflare/src/tsa.mjs#L25) |
| Worker read of the witness object’s public-summary JSON | `publicBytes: 48 * 1024` (48 KiB) | [witness-do.mjs:1152](../../deploy/cloudflare/src/witness-do.mjs#L1152) · [witness-do.mjs:1291](../../deploy/cloudflare/src/witness-do.mjs#L1291) |

Configured explorer hosts, with `blockstream.info` last: `mempool.space`, `btcscan.org`, `mempool.emzy.de`, `api.blockchain.info`, `api.blockcypher.com`, `api.bitaps.com`, `blockstream.info`. [witness-do.mjs:168](../../deploy/cloudflare/src/witness-do.mjs#L168)

| Adapter | Request paths (angle brackets mark inputs) | Source |
|---|---|---|
| Esplora | `/api/block-height/<height>`, `/api/block/<hash>/header`, `/api/blocks/tip/height` | [witness-do.mjs:707](../../deploy/cloudflare/src/witness-do.mjs#L707) · [witness-do.mjs:710](../../deploy/cloudflare/src/witness-do.mjs#L710) · [witness-do.mjs:718](../../deploy/cloudflare/src/witness-do.mjs#L718) |
| Fields | `/haskoin-store/btc/block/height/<height>?notx=true`, `/v1/btc/main/blocks/<height>` | [witness-do.mjs:172](../../deploy/cloudflare/src/witness-do.mjs#L172) · [witness-do.mjs:730](../../deploy/cloudflare/src/witness-do.mjs#L730) |
| Raw | `/btc/v1/blockchain/block/<height>` | [witness-do.mjs:174](../../deploy/cloudflare/src/witness-do.mjs#L174) · [witness-do.mjs:752](../../deploy/cloudflare/src/witness-do.mjs#L752) |

Header codes include `HEADER_SOURCE_UNAVAILABLE`, `HEADER_SOURCES_DISAGREE`, `HEADER_HASH_MISMATCH`, `HEADER_WORK_TOO_LOW`, `HEADER_MERKLE_MISMATCH` and `HEADER_TOO_FEW_CONFIRMATIONS`. [witness-do.mjs:182](../../deploy/cloudflare/src/witness-do.mjs#L182) · [witness-do.mjs:183](../../deploy/cloudflare/src/witness-do.mjs#L183)

The public diagnostic validator accepts `ok`, `http-<3 digits>` (100–599), `timeout`, `redirect`, `too-large`, `shape`, `self-mismatch` and `error`. [witness-do.mjs:190](../../deploy/cloudflare/src/witness-do.mjs#L190) · [witness-do.mjs:195](../../deploy/cloudflare/src/witness-do.mjs#L195)

## How anyone checks a stamp

If the public route is closed, ask the owner for the full record. Save the [full-record response’s `record` member](../../deploy/cloudflare/src/witness-do.mjs#L1271) as `record.json`. With dependencies installed, compute its digest offline from the repository root. For a Nostr event, follow the [event ID, signature and trusted-signer checks](../../README.md#L26) before comparing its digest tag with the output. For a detached proof, compare its starting digest. [witness.mjs:146](../../deploy/cloudflare/src/witness.mjs#L146) · [witness.mjs:177](../../deploy/cloudflare/src/witness.mjs#L177)

```sh
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {witnessDigest} from "./deploy/cloudflare/src/witness.mjs"; console.log(await witnessDigest(JSON.parse(readFileSync("record.json","utf8"))))'
```

For the [detached proof](../../deploy/cloudflare/src/witness-do.mjs#L1278) from `GET /api/witness/ots?seq=n`, match its starting SHA-256 to the computed record digest. A [pending proof](../../deploy/cloudflare/src/witness-do.mjs#L979) can already be downloaded. Once the proof [includes a Bitcoin attestation](../../deploy/cloudflare/src/witness-do.mjs#L524), verify the [attestation path](../../deploy/cloudflare/src/ots.mjs#L360) against trusted Bitcoin chain data with an OpenTimestamps verifier.

Save the [RFC 3161 response](../../deploy/cloudflare/src/witness-do.mjs#L1275) from `GET /api/witness/tsa?seq=n` as `witness.tsr` for both commands. For verification, supply the expected digest in `RECORD_DIGEST`, a trusted CA file and the signer certificate. These OpenSSL commands inspect the response and check it against that digest offline. [tsa.mjs:14](../../deploy/cloudflare/src/tsa.mjs#L14) · [witness-switch.test.mjs:186](../../deploy/cloudflare/src/__tests__/witness-switch.test.mjs#L186)

```sh
openssl ts -reply -in witness.tsr -text
openssl ts -verify -digest "$RECORD_DIGEST" -in witness.tsr -CAfile cacert.pem -untrusted tsa.crt
```

## Not built, and not checked

**Not done.** The edge does not check the token's signature or its certificate chain. A separate check is needed to authenticate a claimed time from the day the token was made. [tsa.mjs:14](../../deploy/cloudflare/src/tsa.mjs#L14)

**Not verified.** Live relay retention beyond `held` and whether a record is the only one for its time remain unverified. Explorer diagnostics record how a request ended. An error code alone cannot establish its cause. [witness-do.mjs:156](../../deploy/cloudflare/src/witness-do.mjs#L156) · [witness-do.mjs:340](../../deploy/cloudflare/src/witness-do.mjs#L340) · [witness.mjs:157](../../deploy/cloudflare/src/witness.mjs#L157)

**Not verified.** Whether the authority is volunteer-run and what availability a best effort service provides in practice remain unverified here. [witness-switch.test.mjs:185](../../deploy/cloudflare/src/__tests__/witness-switch.test.mjs#L185)
