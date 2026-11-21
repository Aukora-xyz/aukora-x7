# Her outside witness: Bitcoin timestamps and a chain of Nostr events

## The switch

The witness runs. `deploy/cloudflare/wrangler.toml` `[vars]` holds `WITNESS_SWITCH = "on"` in the shipped
configuration. Every outbound request carries the node's domain name (below). Only
exactly `"on"` runs it; `"off"`, or anything else, stops it. (The switch is not called `WITNESS` because that name is
already the witness object's binding.) While it is off the hourly cron makes no call, the witness object's tick answers
`WITNESS_OFF` before it reads storage or calls anything, and HEAD's sign route answers `WITNESS_OFF` and signs nothing,
so her node key cannot sign a witness event whoever asks. `GET /api/witness` always answers what is stored.

While it is on it sends, every 4 hours and after a promotion (at most 24 promotion records a day, below): the 32-byte
values `sha256(digest || nonce)` to four OpenTimestamps calendars, and one signed kind 4871 event (her node key's public
half, the record's digest, its seq and the previous event's id) to five Nostr relays; and, to read the events back, a
request for one event id at a time to the same relays; block heights and block hashes to up to seven public block
explorers (the header check and the header check, the header check below); and, while `WITNESS_TSA` is `"on"`, each record's 32-byte digest and a random nonce to
one RFC 3161 timestamp authority (freetsa.org). Every one of those requests also carries a `CF-Worker` header holding her domain name: Cloudflare
adds it to every request a Worker or Durable Object sends, and code cannot remove it (from Cloudflare's documentation;
not checked here). So each calendar and relay operator learns which site sent the fingerprint. Her node key's public
half is already tied to the same domain in public by the existing `/.well-known/nostr.json?name=auma` (once a head
announcement has been published), so the relays learn no new link between that key and the domain; the calendars do
learn that the domain stamps something every 4 hours, and, since records are also made at promotions, roughly when her
head moves.

To turn it off: change that one line to `WITNESS_SWITCH = "off"` in a commit of its own.

## Why

A hash chain shows that a file changed only to someone who kept an earlier head where the writer cannot reach it. Until
now nobody outside her own edge held one. The witness gives her record two outside holders: Bitcoin, through the public
OpenTimestamps calendars ("this fingerprint existed by this block"), and five public Nostr relays holding a chained
series of signed fingerprint events.

## What is stamped, and when

Every hour (the Worker's cron, minute 17) the witness object (`WitnessDO`, `deploy/cloudflare/src/witness-do.mjs`) runs
one bounded tick. A new record is made only when none exists or the newest is at least 3 h 59 min old, so one record
about every 4 hours on the schedule.

A record at each promotion. When HEAD commits a new selected head (any committed publish: a promotion by passkey, a direct
publish, a night-grant promotion; in the code every change of the live selected head goes through that one commit,
apart from the very first bootstrap), it sends the witness object one internal
`POST /_witness/kick` after the commit, without waiting for it: a fault in that call (no binding, an error, no answer)
is swallowed and counted in HEAD's memory (`witnessKicks`), and never changes the promotion's answer. The kick only sets
the witness object's alarm about 15 s ahead (an earlier alarm is kept), because the tick calls back into HEAD for the
facts and the signature and must not run inside HEAD's own request. The alarm runs one tick marked as
promotion-triggered: it skips the proof upgrades (the hourly tick does those), runs the usual retries and read-backs,
and makes a record without the 4-hour spacing only when the head HEAD reads now differs from the newest record's
`facts.head`. Floors and caps, in `WITNESS_LIMITS`: at least 60 s since the newest record (a promotion tick inside that
floor sets the alarm for the floor's end, so the last head of a burst, a quick rollback included, is still recorded);
at most 24 promotion-triggered records in any rolling 24 hours (past that, the hourly schedule carries on as before). A promotion tick that finds a tick
already running sets the alarm again 15 s on. The hourly 4-hour rule is unchanged (a promotion record counts as the
newest record), and `WITNESS_SWITCH` off stops this too: a kick then does nothing and HEAD makes no call. The cost of
this: the public series now shows when her head moved (to within a minute or so), not only a fixed schedule.

Each record's row says what made it, `trigger: "schedule" | "promotion"`, stored beside the record, never inside it:
the trigger never changed the hashed record's shape, and the records made before the promotion records read as `schedule`.

A record (`deploy/cloudflare/src/witness.mjs`), as made since the nightly commitment (2026-11-18):

```json
{ "v": 2, "seq": 7, "prev": "<digest of record 6; 64 zeros for record 1>", "at": 1794830400000,
  "facts": { "head": { "ballId": "<her selected ball>", "epoch": 80 },
             "receipts": { "leafHash": "<last verified receipt leaf>", "rows": 412 },
             "journals": [ { "path": "/dsh/home/auma/voice/chain.v1.jsonl", "bytes": 1834, "last": "<sha256 of its last line>" },
                           { "path": "/dsh/home/auma/timeline/chain.v1.jsonl", "bytes": 0, "last": "" } ],
             "nightly": { "set": "2026-11-18T19-17-00Z", "sha256": "<sha256 of that set's manifest.json bytes>" } },
  "missing": [] }
```

`digest = sha256(canonical record)`: keys sorted at every depth, no whitespace, integers only (the same canonical form
as her voice memory). A fact that could not be read within its bound is `null` and named in `missing` with a closed
reason (`head-none`, `head-unavailable`, `receipts-unavailable`, `journals-over-bound`, `journals-unavailable`,
`nightly-none`, `nightly-off`, `nightly-unavailable`); it is never guessed, and a missing fact never stops a tick. Each
journal is read from the newest 64 KiB of the file only.

### What a record commits to since the nightly commitment: the whole nightly copy

Since the nightly commitment every new record also commits to the newest COMPLETE nightly copy of what her cloud holds
(`docs/auma/nightly-copy.md`: every stored key of HEAD except the three rows the copy leaves out — `aumlok:signin:v1`
and `aumlok:devices:pending:v1`, the two in-flight credential rows, and `aumlok:v1`, the owner binding — which are
never copied, so no record commits to them; the mirror except the rows the secret-path rule withholds by reading each row's own value — an entry's `value.path`, a reset row's value, and a chunk decided by reading its entry, so a chunk whose entry is gone or malformed is withheld too, while a read that throws fails the page rather than counting as hidden — with hidden-path rows and conflict rows counted apart; the voice bridge and the witness object; and the vault's inventory, key and size only
for each piece, not its contents, in R2 under `nightly/<set>/`). The fact `nightly` is exactly two fingerprints: the set's name (its
UTC start time to the second, `:` written `-`) and the SHA-256 of that set's `manifest.json` bytes, the value
`nightly/LATEST.json` holds. The manifest holds the SHA-256 of every page it copied, so the record's digest, and with it
the Nostr event and the Bitcoin stamp, fixes the whole copy: change one stored row in the set and its page hash, the
manifest hash, the record digest and every later record's `prev` no longer match.

SOURCE (`witness-do.mjs` `readNightlyFact`): the witness object reads `nightly/LATEST.json`, then the manifest it names,
recomputes the manifest's SHA-256 from its exact bytes and keeps the fact only when it equals the pointer's, the
manifest says `complete: true` and names the same set. One deadline of 5 s for both reads, the pointer at most 1 KiB, the
manifest at most 1 MiB; the read runs beside HEAD's facts read, never throws, and reads no row page. A fact it cannot
have is `null` with one closed code: `nightly-off` (`NIGHTLY_COPY` is not exactly `"on"`; nothing is read),
`nightly-none` (no complete set yet), `nightly-unavailable` (no `ARCHIVE_BUCKET` binding, a read that failed or did not
finish in 5 s, a pointer or manifest over its bound or not of its shape, a hash that does not match, a manifest not
complete or of another set). The hourly cron runs the witness before the nightly copy, so the record made in the hour
the copy runs names the set before it; the next record names the new one.

The version rule. Records come in two versions, and both stay valid for ever:

- `v` 1: every record made before the nightly commitment, the live chain's records. Facts exactly `head`, `receipts`, `journals`. Its
  shape, its canonical bytes and its digest are unchanged.
- `v` 2: every record made since. The same three facts and `nightly`, no other.

A `v` 1 record with a `nightly` fact (even `null`), or a `v` 2 record without one, is not a record, and neither is any
other `v`. A chain may hold both, in any order: the live chain is `v` 1 records followed by `v` 2 ones, and a rollback
of the Worker to a build from before the nightly commitment would make `v` 1 records after `v` 2 ones; such a record is valid and commits
to no copy. HEAD's signing does not change: it signs a digest and remembers `{ seq, id, digest, prevEventId, event }`,
never a record's shape, so its memory of the last `v` 1 record signs the first `v` 2 record (RAN: the test
`witness-nightly.test.mjs` signs three `v` 1 records through HEAD's own sign path, then ticks: record 4 is `v` 2, signed,
naming event 3, and the whole chain verifies). The public rows below do not change.

## What leaves her edge

Only 32-byte fingerprints. No content, no titles, no words, no counts of her exchanges or turns.

- To the four calendars the reference client uses (`a.pool.opentimestamps.org`, `b.pool.opentimestamps.org`,
  `a.pool.eternitywall.com`, `ots.btc.catallaxy.com`): `sha256(digest || nonce)`, the 32 bytes the reference client
  submits, where the nonce is 16 random bytes kept with the record (it blinds the digest). Headers:
  `Accept: application/vnd.opentimestamps.v1`, `Content-Type: application/x-www-form-urlencoded`,
  `User-Agent: ots-client`. The code sets no other header, but Cloudflare adds one it cannot remove: `CF-Worker:
  <her zone name>` on every request a Worker or Durable Object makes (calendar POSTs and GETs, and very likely the relay
  WebSocket handshakes), so each calendar and relay operator can see which site sent a fingerprint (from Cloudflare's
  documentation; not checked here). Two good replies make the proof; fewer is `failed` and is tried again later with the same
  nonce, at most 3 attempts in all.
- Upgrades: a pending proof at least an hour old is asked about at `<calendar>/timestamp/<commitment>`, only on https
  hosts under `*.calendar.opentimestamps.org`, `*.calendar.eternitywall.com` and `*.calendar.catallaxy.com`, at most 6
  requests a tick. A reply holding a Bitcoin attestation is spliced in: the proof is `confirmed` with its block height.
  After 14 days a proof still pending is `stale` and no longer asked about.
- To `wss://relay.damus.io`, `wss://nos.lol`, `wss://relay.primal.net`, `wss://relay.nostr.band` and `wss://nostr.mom`
  (five since the promotion records, so that one silent relay does not decide the count): one Nostr event per record, signed by her
  existing node key (her Messages identity; no new key):
  `{ kind: 4871, content: "", tags: [["e", <event of record n-1>], ["seq", "n"], ["digest", <record digest>], ["chain", "witness.v1"]] }`
  (no `e` tag on the first). HEAD builds and signs it (`/_head/witness/sign`); it signs one event per seq, ever, each
  naming the one before, so her key never signs a fork. Each relay's answer is kept as `ok`, `duplicate`,
  `refused:<reason>` or `timeout`; at most 3 attempts per event on each relay, ever. A record published before the
  two new relays were added is sent to them by the same retry pass (each new relay has had no attempt yet).
- Read-back: an accepted publish is not proof that a relay still holds the event. A tick asks each relay for
  the event of each of the newest published records by its id (`["REQ", <first 16 hex of the id>, { "ids": [<id>] }]`),
  and counts the relay as holding it only when an event it returns is the stored event exactly, field by field (the
  stored event's id and signature were verified when HEAD signed it). The socket is closed on that event, on `EOSE`,
  `CLOSED`, after 4 s, or after 8 frames, whichever comes first. Only the 4 newest published records, and of those only
  the ones a relay is due on: each relay asked at most once per record per 6 hours, 16 s for the whole read-back at
  most. The read-back runs after the tick's new record, so it can never keep a record from being made.
- The header check ("no verification against Bitcoin block headers"): on the HOURLY tick only,
  for at most 2 records a tick whose proof is `confirmed` and not yet checked (never-tried ones first, newest first),
  the edge takes the 32-byte value the proof's Bitcoin attestation commits to and its height, and fetches that block's
  header from a POOL of explorers run by unrelated operators, asked in this order: `mempool.space`, `btcscan.org`, `mempool.emzy.de`, `api.blockchain.info`, `api.blockcypher.com`, `api.bitaps.com`, `blockstream.info`.
  Each has a kind, and one adapter per kind turns its reply into a block hash and 80 header bytes:
  - Esplora (`mempool.space`, `btcscan.org`, `mempool.emzy.de`, `blockstream.info`): `GET /api/block-height/<height>`,
    `GET /api/block/<hash>/header`, `GET /api/blocks/tip/height` (only this kind gives a tip);
  - fields: `api.blockchain.info` (`GET /haskoin-store/btc/block/height/<height>?notx=true`, a list of one block that
    must say `mainchain: true`) and `api.blockcypher.com` (`GET /v1/btc/main/blocks/<height>`), their JSON fields
    rebuilt into the 80 header bytes;
  - raw: `api.bitaps.com` (`GET /btc/v1/blockchain/block/<height>`, a base64 header whose first 80 bytes are the header).

  `blockstream.info` answered nobody on 2026-11-17, so it is asked last. Only block heights and block hashes leave in
  these requests; https only, these seven hosts exactly, no redirect followed, `User-Agent: header-check/1`, 8 s a reply
  and 4 KiB (2 KiB for `api.blockchain.info` and `api.bitaps.com`). The pool is asked two at a time, in order, until two
  sources give headers that each pass their own checks: the header's double SHA-256 is the block hash that source
  names, it names the height asked, the hash meets the header's own target (its `bits`) and has
  at least 72 leading zero bits. A source that fails its own checks is `self-mismatch` and the next is asked (and is never asked for a tip). With fewer
  than two good sources the check is `HEADER_SOURCE_UNAVAILABLE` when any source did not answer, and the self-mismatch's
  own code (`HEADER_HASH_MISMATCH` or `HEADER_WORK_TOO_LOW`) only when every other source failed its own checks. The first two good sources
  must name the SAME block hash, the header's merkle root (in header byte order) must equal the proof's value byte for
  byte, and the lower of the tips of up to two Esplora sources (the agreeing ones first) must show at least 6
  confirmations; when no Esplora source gives a tip the check is `HEADER_TOO_FEW_CONFIRMATIONS` (the count is the one at
  the time of the check, never refreshed). The whole pass has one deadline, 30 s, handed to every request: whatever is
  undecided then is `HEADER_SOURCE_UNAVAILABLE`, and no record is started past it. The 72-bit floor is roughly 1/128 to 1/256 of one
  real block's work (recent real blocks have about 80): it stops an explorer that does not mine from
  making a header up for a value of its choosing; it does not stop a large mining pool, which could make one in about a
  minute, and the header's link to the block before it is not followed. It does
  NOT show the block is in the chain with the most work, nor that its bits were the ones the chain required (that needs
  the chain of headers): two unrelated explorers agreeing, and 6 confirmations by the lower of their tips, stand for
  that. The pass runs after the hour's new record is made, so a slow explorer never delays one; a proof confirmed in a
  tick is checked from the next hour on. The result is kept beside the record. A stored proof the edge cannot read a
  Bitcoin attestation from is `HEADER_PROOF_UNREADABLE` (counted as a try). Retries: `HEADER_SOURCE_UNAVAILABLE`
  is tried again at the next hourly tick (at least 30 min after the last try) for its first 3 tries, then every 6 h;
  every other failed check is tried again at most once every 6 h; at most 8 times in all. `HEADER_MERKLE_MISMATCH` is
  never retried silently: it stays shown. `HEADER_SOURCES_DISAGREE` is tried once more after 6 h, then it stays shown.
- What happened when the header check first ran live: every header check failed from the edge on its first two
  hourly ticks, all `HEADER_SOURCE_UNAVAILABLE`, and the page could not say which source failed or how. From another
  machine the same hour `mempool.space` and `api.blockcypher.com` answered and `blockstream.info` did not; from the edge at least one of
  the two first explorers refused or throttled Cloudflare's shared addresses. So the check now asks a pool, says why
  in `tried`, and retries an unavailable check hourly; those four records are due at the first tick after the deploy
  (two a tick).
- The second timestamp: while `[vars] WITNESS_TSA` is
  exactly `"on"` (it ships `"on"`), each NEW record, and at most one older record per hourly tick (oldest first, as
  backfill), gets one request to `https://freetsa.org/tsr`: the 69-byte SHA-256 time-stamp query for the record's
  digest with a fresh random 8-byte nonce and `certReq` TRUE (`Content-Type: application/timestamp-query`,
  `User-Agent: tsa-client/1`), 8 s, a reply of at most 16 KiB, at most 3 tries per record, one a tick. The reply is
  sanity-read only (an outer SEQUENCE, status 0 or 1, then a token: a SEQUENCE starting with the signedData OID
  1.2.840.113549.1.7.2, with the digest and nonce bytes found inside that token) and stored beside the record. Finding
  those bytes inside the token is not parsing it.
  The edge does not check the token's signature or its certificate chain. The authority is volunteer-run and best effort
  (no service promise). A token for an old record dates it from the day the token was made, not from the record's own
  time. Off (any value but exactly `"on"`): no request, and rows read `tsa: null`.

## What anyone can read

`GET https://node.example.invalid/api/witness` (signed out, cached 60 s):

```json
{ "schema": "witness.v1", "pubkey": "<her node key, hex>", "head": { "seq": 7, "digest": "…", "at": 1794830400000 },
  "records": [ { "seq": 7, "at": 1794830400000, "digest": "…", "prev": "…", "eventId": "…",
                 "trigger": "promotion",
                 "relays": { "ok": 4, "of": 5, "held": 3, "heldCheckedAt": 1794834000000,
                             "rows": [ { "relay": "relay.damus.io", "sent": "ok", "held": true }, … ] },
                 "ots": { "state": "confirmed", "height": 900000, "header": { "checked": true, "hash": "…", "time": 1794847294,
                          "confirmations": 9, "sources": [ "btcscan.org", "mempool.emzy.de" ],
                          "tried": [ { "host": "mempool.space", "why": "http-429" }, { "host": "btcscan.org", "why": "ok" },
                                     { "host": "mempool.emzy.de", "why": "ok" } ], "at": 1794834000000 } },
                 "tsa": { "state": "stored", "authority": "freetsa.org", "at": 1794830400000 } } ] }
```

The newest 24 records, newest first. `ots.state` is `none`, `pending`, `confirmed`, `failed` or `stale`. It never shows
a record's facts or its missing list. `GET /api/witness/ots?seq=n` downloads that record's `.ots` proof (at most 16 KiB).

`ots.header` is `null` (not tried yet; every record made before the header check reads so until its check runs),
`{ "checked": true, "hash", "time", "confirmations", "sources": [host, host], "tried", "at" }` (`time` is the block header's
time in seconds, `at` when the check ran), or `{ "checked": false, "code", "tried", "at" }` with `code` one of
`HEADER_SOURCE_UNAVAILABLE`, `HEADER_SOURCES_DISAGREE`, `HEADER_HASH_MISMATCH`, `HEADER_WORK_TOO_LOW`,
`HEADER_MERKLE_MISMATCH`, `HEADER_TOO_FEW_CONFIRMATIONS`, `HEADER_PROOF_UNREADABLE`. `tried` lists each source
asked, in the order asked, and how its asking ended: at most 8 rows of `{ "host", "why" }`, the host one of the seven,
`why` one closed word: `ok`, `http-<3 digits>` (the status, digits only), `timeout` (8 s, or the pass's 30 s),
`redirect` (never followed), `too-large`, `shape` (answered, not the expected form), `self-mismatch` (its header does
not hash to the hash it names, misses its own target or the work floor, or names another height), `error` (anything
else). A row keeps its first ending that is not `ok`: a source whose header was `ok` and whose tip then failed shows the
tip's ending; a failed header (`self-mismatch` above all) is never overwritten. Nothing else is in a row. A check stored
before the header check has no `tried` and reads as before. `tsa` is `null` (off, or never asked) or
`{ "state": "stored" | "failed", "authority": "freetsa.org", "at" }`: "stored" means a reply was kept, never "verified".
The door refuses any other shape of either.

`GET /api/witness/tsa?seq=n` downloads that record's stored RFC 3161 reply as the authority sent it
(`application/timestamp-reply`, at most 16 KiB; 404 `WITNESS_TSA_NONE` when there is none or `WITNESS_TSA` is off). Same
door, cache and shield as `/api/witness/ots`, and the same exact `?seq=n`.

`relays.ok` against `relays.held`: `ok` counts the relays that ACCEPTED the publish (an attempt count: "2 of 3" could
mean the same two every time); `held` counts the relays whose newest read-back RETURNED the event (null until one was
asked), and `heldCheckedAt` is when the newest read-back ran. Each row names one relay by its host name only, its publish
state (`sent`: `none`, `ok`, `duplicate`, `refused:<reason>` or `timeout`) and `held` (`true`, `false`, or `null` for
never asked).

`GET /api/witness/record?seq=n`: one whole hashed record for anyone, `{ "ok": true, "seq", "digest", "record" }`, where
`record` is exactly the hashed record so anyone can recompute `digest` (the script below); never the nonce or anything
stored beside the record. It is BUILT AND OFF: served only while `[vars] WITNESS_RECORD_PUBLIC` is exactly `"on"`, and it
ships `"off"` (404 `WITNESS_RECORD_NOT_PUBLIC`, no call to the witness object), because the owner has not yet said yes
to showing a record's counts and fingerprints to everyone. What it would show: her selected head's id and epoch, the
receipt count and newest receipt digest, the two memory chain files' sizes and newest-line digests, on a `v` 2 record
the nightly set's name and its manifest's SHA-256, and the missing list. No words. Same door, cache and shield as `/api/witness/ots`, and the same exact `?seq=n`.

The owner sees a whole record, facts included, at `GET /_head/witness/record?seq=n` from his signed-in page.

`GET /api/witness` and `GET /api/witness/ots` gained nothing in the nightly commitment: the same fields, the same proof bytes (pinned by
`witness-nightly.test.mjs`). The nightly fact is shown only where the whole record already is: the owner's read above
and, while `WITNESS_RECORD_PUBLIC` is `"on"`, `/api/witness/record`.

## How anyone checks a stamp

With the standard OpenTimestamps client (`pip install opentimestamps-client`):

```sh
curl -o witness-7.ots 'https://node.example.invalid/api/witness/ots?seq=7'
ots info witness-7.ots                       # the tree: her digest, the nonce, the calendars
ots upgrade witness-7.ots                    # fetches the Bitcoin part if the calendars have it
ots verify -d <digest of record 7> witness-7.ots
```

The digest is the record's `digest` in `/api/witness`. `ots verify` checks the proof against Bitcoin itself (it asks a
Bitcoin node it can reach). The owner can also recompute the digest from the whole record; save the `record` field of
his record read as `record.json` and run:

```js
// node digest.mjs record.json   (record.json: the "record" field of the owner's GET /_head/witness/record?seq=n)
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
// Canonical JSON: keys sorted at every depth, no whitespace, integers only (as witness.mjs writes it).
const canon = value => value === null || typeof value !== 'object' ? JSON.stringify(value)
  : Array.isArray(value) ? `[${value.map(canon).join(',')}]`
  : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canon(value[key])}`).join(',')}}`
const record = JSON.parse(readFileSync(process.argv[2], 'utf8'))
console.log(createHash('sha256').update(canon(record)).digest('hex'))
```

Each record's `prev` is the digest of the record before, so one confirmed stamp also fixes every earlier record it
links back to.

What an outside verifier must do differently since the nightly commitment. The digest rule is the same for both versions, so the script
above needs no change. A checker of a record's shape must accept `v` 1 with exactly `head`, `receipts`, `journals`
and `v` 2 with exactly those and `nightly`, and refuse each shape under the other's number; it must not refuse a chain
for holding both. To check the copy itself, given read access to the bucket (the owner; the copy is not public): take
the record's `facts.nightly`, read `nightly/<set>/manifest.json`, check its SHA-256 equals `sha256`, then each page's
SHA-256 against the manifest's `pages` rows. A `null` nightly fact proves nothing about a copy: it names only why none
was committed.

The RFC 3161 token, offline, with OpenSSL (`cacert.pem` and `tsa.crt` from freetsa.org's own page, pinned by the
fingerprints it publishes):

```sh
curl -o witness-7.tsr 'https://node.example.invalid/api/witness/tsa?seq=7'
openssl ts -reply -in witness-7.tsr -text          # the status, the time, the digest it covers
openssl ts -verify -digest <digest of record 7> -in witness-7.tsr -CAfile cacert.pem -untrusted tsa.crt
```

With `-digest` OpenSSL does not compare the nonce (the edge only found the nonce's bytes inside the token when it
stored the reply; it did not read the token's nonce field). The `-digest` form of
`-verify` was not run here (the research ran the query side only).

## How anyone walks the event chain on a relay

Ask a relay for her witness events (`pubkey` from `/api/witness`), for example with `nak`:

```sh
nak req -k 4871 -a <pubkey> -l 500 wss://nos.lol
```

or send `["REQ", "w", { "kinds": [4871], "authors": ["<pubkey>"], "limit": 500 }]` over a WebSocket. Then for every
event: recompute its id (NIP-01: sha256 of `[0, pubkey, created_at, kind, tags, content]`) and check its signature; keep
only `["chain", "witness.v1"]`; check that `seq` runs 1, 2, 3 … with no gap, that each `e` tag is the id of the event
with the seq before, and that each `digest` tag equals that record's digest in `/api/witness`. Two different events
with the same seq are a fork and an alarm. An event one relay does not have is "not on this relay", not forged: ask the
others (the public row's `held` says which relays returned it on the newest read-back).

## What this does and does not prove

A confirmed stamp proves this fingerprint existed by that Bitcoin block. A `header.checked: true` says the edge saw the
proof's value in the merkle root of a header two unrelated explorers agreed on, with real work and 6 confirmations; it
is a check against headers, not a full node. A stored RFC 3161 token is one more party's signed statement of a time,
from another kind of authority; the edge has not checked that signature. It does not prove the record is true, complete, or that an earlier version was not also stamped. Until a stamp confirms (usually a few hours) a record made in that window can still be rewritten unseen. The relays are a second, weaker holder: each can drop or withhold events.

## Known state: signing stalled

Two objects remember the event chain: the witness object (its records and their events) and HEAD (`witness:signer:last`,
the last seq her node key signed and that event's id). HEAD signs only the next seq, naming that id, so her key
never forks the chain. If the two get out of step (one object's storage lost or rolled back, the other's not), every later sign
is refused (`WITNESS_SIGN_REFUSED` in the tick's codes) and stays refused: records are still made and stamped, but each
new one shows `"eventId": null` at `GET /api/witness` while `pubkey` is set. No route resets HEAD's memory, and the
`scheduled` handler does not log the tick's codes, so `"eventId": null` on new records is the only outside sign.

the nightly commitment's new record version does not cause this: HEAD's memory holds no record shape, and the sign route takes only a
seq, a digest and the previous event's id (RAN: `witness-nightly.test.mjs`, a memory written for `v` 1 records signs
the next `v` 2 record and the one after).

Leaving it takes a code change, made with the owner told. Never delete `witness:signer:last`: her key would then
sign a second event for a seq already on the relays, a fork they keep. The ways out: restore the lost object's storage
to a point where the two agree again (SQLite-backed Durable Objects have point-in-time recovery; Cloudflare's docs, not
tried here), or start a new chain, which changes the chain tag and is a format change the owner approves first.

## Not built, and not checked

the nightly commitment (the nightly fact), NOT VERIFIED:

- No `v` 2 record has been seen live. Every record of this shape so far was made in tests over fakes.
- Whether the nightly copy itself has run live and left a complete set: until it does, new records carry
  `nightly-none` (or `nightly-off` while `NIGHTLY_COPY` is not `"on"`).
- That the witness object can read `ARCHIVE_BUCKET` on the platform: the binding is the Worker's and Durable Objects of
  the same Worker get the same `env` (Cloudflare's documentation, not checked here); without it the fact is
  `nightly-unavailable`.
- That a live manifest stays under 1 MiB and both reads finish in 5 s.
- A check from outside the edge that a committed set's pages still hash to the manifest's rows: the record fixes the
  manifest's hash; nothing re-reads the pages afterwards.

Built in the header check: the proof checked against Bitcoin block headers (above; against two explorers' headers from a pool of seven since the header check, not a full
node's chain of headers), and a second timestamp authority (RFC 3161, stored). Still not checked:

- The RFC 3161 token's signature and its certificate chain: the edge stores the token and reads its shape only.
- That a record is the only one for its time: nothing outside shows that no second record or chain was made for the
  same hours; a confirmed stamp proves only that this fingerprint existed by that block.
- Anything about the relays beyond `held`: whether a relay keeps the event after its newest read-back, or serves it to
  everyone.
- The header's place in the chain with the most work (the chain of headers before it), and its bits against the
  difficulty the chain required.
- A post-quantum signature inside the event.
- Her own tool to read the witness.
- A full check of a proof against Bitcoin from the edge (a node's chain of headers); the edge checks one header from two
  explorers, and anyone checks the standard proof file with the standard tool.
- Her chains' own records as Nostr events (only the witness fingerprints are published).

## Limits, in the code

Proof at most 16 KiB; calendar reply at most 10,000 bytes; 5 s per outbound call; a relay waited on for at most 5 s;
6 upgrade requests a tick; 3 attempts per stamp, and per event on each relay; journals read from the newest 64 KiB.
Nightly pointer: one deadline of 5 s for the pointer and its manifest, the pointer at most 1 KiB, the manifest
at most 1 MiB. Promotion records: a kick's alarm 15 s ahead, at least 60 s after the newest record (deferred to then, not dropped), at
most 24 in a rolling 24 h. Read-back: the 4 newest published records, a relay asked at most once per record per 6 h,
4 s and 8 frames per request, 16 s in all. Header check (hourly only): at most 2 records a tick, 8 s and 4 KiB per
explorer reply (2 KiB for `api.blockchain.info` and `api.bitaps.com`), one deadline of 30 s for the whole pass, run after
the new record, 72 leading zero bits, 6 confirmations, at most 8 `tried` rows, a failed check again
once every 6 h at most 8 times (`HEADER_SOURCE_UNAVAILABLE`: at the next hourly tick for its first 3 tries; a
disagreement: tried once more). RFC 3161: one request per new record and at most one older record an hour, 8 s, 16 KiB,
at most 3 tries per record. The
public view is read at the door with a 48 KiB bound (five relay rows and up to 8 `tried` rows a record). RIPEMD-160 and
Keccak are not computed at the edge (WebCrypto has neither, and no hash library is bundled): a calendar reply whose path
needs one is not counted as a good reply.
