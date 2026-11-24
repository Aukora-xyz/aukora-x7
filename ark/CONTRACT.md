# ARK proof contract v0.1.3 (DRAFT)

v0.1.1 (2026-11-21) added text clarifications C1-C20 in section 12. v0.1.2 (2026-11-21) adds C21-C22 (the contract
editor's decisions) and two vectors. v0.1.3 (2026-11-21) rewrites C7 (the contract editor's decision) and adds one vector. No wire
format or receiver behaviour changed. Wire strings still say `0.1`.

Status: DRAFT. Not frozen, not published. It becomes a candidate only after a second, independent client and
verifier consume it (the readers in this folder are separately written, not independent: ABOUT.md). Written by reader 1's author on 2026-11-21 from a private design review (its sections 4 and 5).

This file is complete on its own. An author who never sees reader 1's code must be able to write a client and an
offline verifier from it, plus the vectors in `vectors/`. Where this file and the vectors disagree, that is a bug:
write it in `ark/CONTRACT-ISSUES.md`.

Words: MUST, MUST NOT, MAY as usual. "hex" always means lowercase hex. "ms" means integer milliseconds since the
Unix epoch.

---------------------------------------------------------------------------------------------------------------------

## 1. Primitives

- Signatures: Ed25519 (RFC 8032, pure, no prehash, no context). Public key = the raw 32 bytes. Signature = 64 bytes.
- Hash: SHA-256.
- `hex(b)`: lowercase hexadecimal of bytes `b`.
- `b64u(b)`: base64url (RFC 4648 section 5, alphabet `A-Z a-z 0-9 - _`) WITHOUT `=` padding.
  Decoding is strict: a string is valid only if it uses that alphabet, has no padding, has a length that is not
  `1 mod 4`, and re-encoding the decoded bytes gives back exactly the same string (this rejects non-zero trailing
  bits). Any other string fails with `BAD_ENCODING`.
- Key encoding everywhere (payloads, pins files, CLI output): `hex(raw 32-byte public key)`, 64 hex chars.
- Key id: `keyid(K) = hex(SHA-256(raw 32-byte public key K))`, 64 hex chars.
- Item hash: `hash(item) = hex(SHA-256(exact payload bytes))`, i.e. the bytes obtained by b64u-decoding the
  envelope's `payload` string. Never hash a re-serialisation.

## 2. Envelope (every signed item)

```
{"payloadType":"application/vnd.aukora.ark.v0.1+json","payload":"<b64u(payload bytes)>","signatures":[{"keyid":"<keyid of signer>","sig":"<b64u(64-byte signature)>"}]}
```

- Exactly three fields: `payloadType` (string), `payload` (string), `signatures` (array). Any other field, or a
  missing one: `BAD_ENVELOPE`.
- `signatures` has exactly ONE element, an object with exactly `keyid` (64 hex) and `sig` (string). Otherwise
  `BAD_ENVELOPE`.
- `payloadType` MUST equal `application/vnd.aukora.ark.v0.1+json` exactly, else `BAD_PAYLOAD_TYPE`.
- `sig` MUST b64u-decode to exactly 64 bytes, `payload` MUST b64u-decode, else `BAD_ENCODING`.

Signed bytes (DSSE v1 PAE):

```
PAE = "DSSEv1" SP LEN(payloadType) SP payloadType SP LEN(payload_bytes) SP payload_bytes
```

`SP` is one 0x20 byte. `LEN(x)` is the ASCII decimal byte length of `x`, no leading zeros. `payload_bytes` are
the RAW payload bytes (the decoded bytes, NOT the base64 string). For this contract `LEN(payloadType)` is `36`.
`sig = Ed25519-Sign(private key, PAE)`.

Check: the DSSE spec's own vector `PAE("http://example.com/HelloWorld", "hello world")` =
`DSSEv1 29 http://example.com/HelloWorld 11 hello world`.

DSSE conformance (checked 2026-11-21 against secure-systems-lab/dsse protocol.md and envelope.md, v1.0.2,
read by reader 1 (Node); SOURCE): the PAE above MATCHES DSSE v1 exactly, on the reading that "payload" in the signed
bytes is the raw serialized body. The envelope field names match DSSE. This profile is NARROWER than DSSE in four
ways, on purpose: (1) only URL-safe base64 without padding (DSSE allows standard or URL-safe and tells verifiers
to accept both); (2) exactly one signature; (3) `keyid` is required (optional in DSSE); (4) unknown envelope fields
are rejected (DSSE says consumers ignore them). So every envelope valid here is a valid DSSE envelope, but not
the other way round.

## 3. Payload JSON rules

Every payload, and every unsigned JSON file in this contract (bundle, pins, request, answer), MUST satisfy:

1. UTF-8 bytes, no byte-order mark. Invalid UTF-8: `BAD_JSON`.
2. One JSON value (RFC 8259) whose top level is an object. Whitespace between tokens (space, tab, LF, CR) is
   allowed. Trailing bytes after the value: `BAD_JSON`.
3. No duplicate keys in any object, at any depth: `BAD_JSON`.
4. Numbers: integers only, written as `0` or `[1-9][0-9]*`. No sign, no fraction, no exponent, value at most
   9007199254740991. Anything else (`-1`, `1.0`, `1e3`, `01`) is `BAD_JSON`. (All integers in v0.1 are >= 0.)
5. Strings: standard JSON escapes. A `\u` escape that yields a lone surrogate (unpaired U+D800..U+DFFF) is
   `BAD_JSON`.
6. `true`/`false` do not occur in any v0.1 object; `null` only where a field says "or null".
7. Every object has exactly its listed fields: an unknown field or a missing field is `BAD_SCHEMA`. A field of the
   wrong type, or a value outside its pattern, is `BAD_SCHEMA`.
8. Payloads: at most 65536 bytes (`BAD_SCHEMA` if larger). Nesting at most 8 levels deep (`BAD_JSON` if deeper).

A reader parses the payload bytes only to read fields. It MUST NOT re-serialise to hash or to verify.
Writers in reader 1 (Node) emit compact JSON with keys in the order listed below; readers MUST NOT depend on order or
formatting.

Field patterns used below:

| name     | rule |
|----------|------|
| `hex64`  | exactly 64 chars `[0-9a-f]` |
| `hex32`  | exactly 32 chars `[0-9a-f]` (128 bits) |
| `rid`    | receiver id, `[a-z0-9-]{1,64}` |
| `aname`  | action name, `[a-z_]{1,32}` |
| `res`    | resource, `[a-z0-9._/-]{1,128}` |
| `line`   | string of 1 to 200 UTF-8 BYTES containing no code point below U+0020 and no U+007F |
| `ntext`  | string of 1 to 1000 UTF-8 bytes, same character rule as `line` |
| `code`   | reason code, `[A-Z_]{1,40}` |
| `int`    | integer per rule 4 |

## 4. Signed objects (six types)

Every payload starts with `"v":"0.1"` and `"type":"<type>"` (both required, exact strings). Field list is
complete; types as in section 3.

1. `grant` (signed by the OWNER)
   `v`, `type`="grant", `grant_id` hex32, `owner_key` hex64, `client_key` hex64, `receiver_id` rid,
   `scope` object {`action` aname, `resource` res}, `not_after` int (ms).
2. `authority` (signed by the OWNER). A full list of grants in force, not a change.
   `v`, `type`="authority", `owner_key` hex64, `receiver_id` rid, `epoch` int >= 1,
   `grants` array of 0..64 distinct hex64 (each a grant item hash).
3. `proposal` (signed by the CLIENT whose key is the grant's `client_key`)
   `v`, `type`="proposal", `op_id` hex32, `grant` hex64 (grant item hash),
   `action` object {`name` aname, `resource` res, `text` line}, `created_at` int.
4. `approval` (signed by the OWNER)
   `v`, `type`="approval", `proposal` hex64 (proposal item hash), `receiver_id` rid, `epoch` int >= 1,
   `decision` "approve" or "refuse", `not_after` int.
5. `outcome` (signed by the RECEIVER)
   `v`, `type`="outcome", `receiver_id` rid, `op_id` hex32, `proposal` hex64, `approval` hex64 or null,
   `epoch` int >= 0, `status` "DONE" or "REFUSED", `reason` code ("OK" when DONE),
   `effect` object {`resource` res, `before_sha256` hex64, `after_sha256` hex64} or null,
   `seq` int >= 1, `prev` hex64 (item hash of the previous outcome of this receiver, or 64 zeros for seq 1),
   `at` int (the time the receiver DECIDED, before any effect).
6. `note` (signed by ANY key; never authority)
   `v`, `type`="note", `about` hex64 (any item hash), `label` "assessment" or "summary", `grants` "none" (exact),
   `text` ntext. No receiver ever reads a note. A verifier never lets a note change a verdict.

Who may sign what (role rule): owner key: grant, authority, approval, note. Receiver key: outcome, note.
A grant's client key: proposal, note.

## 5. The one harmless action

- Action name `append_line`, resource `notes/demo.txt`. It is the only action a v0.1 receiver executes.
- The resource is the file `<effect_root>/notes/demo.txt` (effect_root is set at receiver init; in the proof it is
  `run/<world>/` of that world).
- Effect: append exactly the bytes `op_id + " " + action.text + "\n"` (UTF-8, one LF) to the file, creating it
  (and `notes/`) if absent.
- `effect.before_sha256` = SHA-256 of the whole file before the append (SHA-256 of zero bytes if absent:
  `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`). `effect.after_sha256` = SHA-256 of the
  whole file right after the append. An outside check can hash the file and compare (true only while nothing
  else has been appended since).

## 6. Bundle and pins files (unsigned)

Bundle (the archive / receipt file, produced by the emitter):
```
{"v":"0.1","coverage":"<one plain sentence>","items":[<envelope>, ...]}
```
`coverage` is a string of 1..500 UTF-8 bytes. `items` has 1..10000 envelopes. Items may be in any order and may
repeat. Same JSON rules (section 3). Malformed bundle file (not JSON, BAD_JSON-class error, wrong fields): the
verifier prints `BUNDLE INVALID BAD_BUNDLE` and exits 4.

Reader 1's emitter writes this coverage sentence: `This bundle covers only actions mediated by receiver <rid>:
appending one line to notes/demo.txt. Nothing else the client or its agent did is covered.`

Pins file (given to the verifier by a person, NEVER taken from a bundle):
```
{"v":"0.1","owner_key":"<hex64>","receiver_key":"<hex64>","receiver_id":"<rid>","supplied_by":"<string 1..200 bytes>"}
```
`owner_key` MUST differ from `receiver_key`. A malformed pins file: exit 2, no verdict.

## 7. Receiver rules (what a receiver enforces)

- R1. Trust only the pinned owner key. The client key comes from the grant, never from the request.
- R2. The grant must be listed in the receiver's current `authority` (highest epoch accepted), be unexpired
  (`now <= not_after`), name this receiver, and its scope must equal the proposal's action name and resource exactly.
- R3. The approval must be owner-signed, say "approve", name this proposal's hash and this receiver, carry the
  current epoch, and be unexpired (`now <= not_after`).
- R4. The first signed outcome for an op_id is final. Same op_id and same proposal hash: return the stored outcome
  bytes unchanged, no effect. Same op_id, other proposal hash: plain rejection `OP_ID_REUSED`, no effect, no new
  outcome (a second signed outcome for one op_id would contradict finality).
- R5. Write the intent down before the effect. The effect line carries the op_id, so after a crash the receiver
  scans the file for a line starting with `op_id + " "` to see whether it ran: if yes, it signs the DONE outcome from
  the saved intent; if no, it drops the intent and the op stays open (a retry decides afresh).
- R6. Accept an `authority` only if owner-signed (pinned key), `owner_key` equals the pin, `receiver_id` is this
  receiver, and its epoch is above both the current epoch and the restore floor. Otherwise reject; the epoch is
  unchanged.
- R7. A restore brings back outcomes (and the items they reference) as record, never authority. After a restore
  the receiver has NO current authority and every new write is refused with `LOCKED_AFTER_RESTORE` until it accepts
  an `authority` whose epoch is above the restore floor = the highest epoch found in the restored record (outcome
  epochs and authority epochs in the archive).
- R8. A refusal of a well-signed proposal is a signed outcome (status REFUSED, reason code). Anything else
  (unparseable request, grant not signed by the pinned owner, proposal not signed by the grant's client key,
  proposal not matching the grant hash, op_id reuse) gets a plain unsigned rejection and is not recorded.

Receiver decision order for a well-signed proposal with no stored outcome (first failing check wins; all give a
signed REFUSED outcome with that reason; `approval` in the outcome is the approval's hash if an approval envelope
was supplied and is validly owner-signed, else null; `epoch` is the receiver's current epoch, 0 if none):

1. `LOCKED_AFTER_RESTORE` 2. `NO_AUTHORITY` 3. `GRANT_NOT_IN_AUTHORITY` 4. `WRONG_RECEIVER` (grant)
5. `GRANT_EXPIRED` 6. `SCOPE_MISMATCH` 7. `UNSUPPORTED_ACTION` (not append_line on notes/demo.txt)
8. `NO_APPROVAL` 9. `BAD_APPROVAL` (bad envelope/schema/signature/not owner) 10. `OWNER_REFUSED` (decision refuse)
11. `APPROVAL_MISMATCH` 12. `WRONG_RECEIVER` (approval) 13. `STALE_EPOCH` 14. `APPROVAL_EXPIRED`.
All pass: write intent, append the line, sign DONE (reason `OK`).

Plain rejection reasons (answer status `REJECTED`, no outcome): `BAD_REQUEST`, `BAD_GRANT`, `BAD_PROPOSAL`,
`WRONG_CLIENT`, `GRANT_HASH_MISMATCH`, `OP_ID_REUSED`; for authority requests `BAD_AUTHORITY`, `STALE_AUTHORITY`.

## 8. Verifier (offline)

Inputs: one bundle file, one pins file. No network. No key is ever taken from the bundle.

Output, in this order, one item per line:
```
coverage: <bundle coverage>
pins supplied by: <pins supplied_by>
integrity only; freshness and completeness not shown
BUNDLE OK | BUNDLE INVALID <REASON> item=<index> | BUNDLE UNTRUSTED_KEY item=<index> | BUNDLE INVALID BAD_BUNDLE
OP <op_id> DONE | OP <op_id> REFUSED | OP <op_id> UNKNOWN | OP <op_id> INVALID <REASON>     (only after BUNDLE OK)
```
(The first line is omitted only for `BAD_BUNDLE`. `index` is 0-based. OP lines sorted by op_id ascending.)

Exit code: 0 = BUNDLE OK and every op DONE or REFUSED; 3 = BUNDLE OK, at least one UNKNOWN, none INVALID;
4 = any INVALID (bundle or op); 5 = BUNDLE UNTRUSTED_KEY; 2 = usage, unreadable file or bad pins.

### 8.1 Item checks (every item gets exactly one result: OK, INVALID <reason>, or UNTRUSTED_KEY)

Pass 1, for each item in order, first failure wins:
E1 `BAD_ENVELOPE` (an item that is not an object counts here), E2 `BAD_PAYLOAD_TYPE`, E3 `BAD_ENCODING`,
E4s `BAD_SCHEMA` if the decoded payload is over 65536 bytes (checked before parsing),
E4 `BAD_JSON` (payload bytes: section 3 rules 1-6 and the depth limit), E5 `BAD_SCHEMA` (section 3 rule 7, section 4).

Signer resolution (only for items that passed pass 1). `K_owner`, `K_recv` come from the pins file.
- S1. If `keyid` = keyid(K_owner) or keyid(K_recv): verify the Ed25519 signature over PAE with that key; failure is
  `BAD_SIGNATURE`. Then the role rule (section 4): a type that key may not sign is `WRONG_SIGNER`.
- S2. Client keys = the `client_key` of every grant item that is OK after S1 (owner-signed). For an unresolved item
  whose `keyid` = keyid(one of those client keys): verify with that key, failure `BAD_SIGNATURE`; type other than
  proposal or note is `WRONG_SIGNER`.
- S3. Any item still unresolved: if its type is `note` it is OK (unverified; notes never count); otherwise it is
  `UNTRUSTED_KEY`.

Bundle result: if any item is INVALID, `BUNDLE INVALID <reason of the lowest-index INVALID item> item=<index>`.
Else if any item is UNTRUSTED_KEY, `BUNDLE UNTRUSTED_KEY item=<lowest such index>`. Else `BUNDLE OK`.
No OP lines are printed unless `BUNDLE OK`.

### 8.2 Operation verdicts (after BUNDLE OK)

Identical items (same item hash and same type) count once. Operations = every op_id that appears in a proposal or
an outcome. For each op_id X, first failing check wins:

- O1. No outcome with op_id X: `UNKNOWN`. More than one distinct outcome with op_id X: `INVALID CONFLICTING_OUTCOMES`.
  Let O be the outcome.
- O2. `O.receiver_id` != pins receiver_id: `INVALID WRONG_RECEIVER`.
- O3. No proposal item P with hash(P) = `O.proposal` and `P.op_id` = X: `INVALID PROPOSAL_MISSING`.
- O4. DONE with `effect` null, or REFUSED with `effect` not null: `INVALID BAD_OUTCOME`.
- O5. `O.status` = REFUSED: `REFUSED`.
- D1. `O.approval` is null, or no approval item has that hash: `INVALID NO_APPROVAL`. Let A be that approval.
- D2. `A.decision` != "approve": `INVALID APPROVAL_NOT_APPROVE`.
- D3. `A.proposal` != `O.proposal`: `INVALID APPROVAL_MISMATCH`.
- D4. `A.receiver_id` != pins receiver_id: `INVALID WRONG_RECEIVER`.
- D5. `A.epoch` != `O.epoch`: `INVALID STALE_EPOCH`.
- D6. `A.not_after` < `O.at`: `INVALID APPROVAL_EXPIRED`.
- D7. No grant item G with hash(G) = `P.grant`: `INVALID GRANT_MISSING`.
- D8. `G.owner_key` != pins owner_key: `INVALID WRONG_OWNER`.
- D9. `G.receiver_id` != pins receiver_id: `INVALID WRONG_RECEIVER`.
- D10. P's envelope `keyid` != keyid(`G.client_key`): `INVALID WRONG_CLIENT`.
- D11. `G.scope.action` != `P.action.name` or `G.scope.resource` != `P.action.resource`: `INVALID SCOPE_MISMATCH`.
- D12. `G.not_after` < `O.at`: `INVALID GRANT_EXPIRED`.
- D13. No authority item with `epoch` = `O.epoch`, `receiver_id` = pins receiver_id, `owner_key` = pins owner_key,
  whose `grants` contains `P.grant`: `INVALID GRANT_NOT_IN_AUTHORITY`.
- D14. `O.effect.resource` != `P.action.resource`: `INVALID EFFECT_MISMATCH`.
- Otherwise `DONE`.

The verifier does not use `seq`, `prev` or `created_at` for any verdict in v0.1 (completeness is not shown).

### 8.3 UNKNOWN vs INVALID vs UNTRUSTED_KEY, in one paragraph
UNTRUSTED_KEY: a non-note item is signed by a key that neither the pins nor an owner-signed grant in the bundle
vouches for (wrong pins, or a foreign signer). INVALID: something is signed by a trusted key but the bytes do not
check (bad encoding, JSON, schema, signature, role) or the trusted items contradict each other or the rules (D1-D14).
UNKNOWN: every item checks, but there is no receiver outcome for that op_id; that says nothing about whether the
effect happened. UNKNOWN is the default; only a receiver-signed outcome moves an op to DONE or REFUSED.

## 9. Files on the wire: requests and answers

There are no sockets. A receiver has a home directory `<R>`:
```
<R>/config.json          {"v":"0.1","receiver_id":..,"receiver_key":..,"owner_key":..,"effect_root":..}
<R>/key.json             TEST private key (never read by clients)
<R>/inbox/<request_id>.req.json
<R>/outbox/<request_id>.ans.json
<R>/state/               receiver state; deleting this directory = wiping the receiver's state (key and config stay)
<R>/lock/                present while a receiver process works (stale locks of dead processes are broken)
<R>/STOP                 create it to stop `receiver serve`
```
`request_id` matches `[a-z0-9-]{1,80}` and must be unique per send. A sender MUST write the request to
`<R>/inbox/<request_id>.req.json.tmp` and then rename it to `<request_id>.req.json` (the receiver ignores `*.tmp`).
The receiver writes the answer the same way (tmp, then rename) and deletes the request after answering.
A request with no answer is UNKNOWN to the sender. A retry is a NEW request_id carrying the SAME proposal bytes
(same op_id). A lost answer never earns a new op_id.

Requests (section 3 rules; envelopes are embedded as JSON objects):
```
{"v":"0.1","kind":"submit","grant":<env>,"proposal":<env>,"approval":<env or null>,"notes":[<env>,...]}
{"v":"0.1","kind":"authority","authority":<env>}
{"v":"0.1","kind":"status","op_id":"<hex32>"}
```
Answer (every kind):
```
{"v":"0.1","kind":"submit|authority|status|error","request_id":"..","status":"..","reason":"<code>","outcome":<env or null>,"authority":<env or null>}
```
- submit: status `DONE` / `REFUSED` (with the signed outcome) or `REJECTED` (plain, outcome null). `authority` is
  the authority envelope at the outcome's epoch if the receiver has it, else null.
- status: `DONE` / `REFUSED` (stored outcome) or `UNKNOWN` (reason `NO_OUTCOME`, outcome null).
- authority: `ACCEPTED` or `REJECTED`; `authority` = the receiver's current authority envelope or null.
- error (request unreadable): `REJECTED`, reason `BAD_REQUEST`.
For a replayed proposal the answer's `outcome` is byte-identical (same `payload` and `sig` strings) every time.

## 10. Commands (reader 1's tools, run as black boxes; do not read their source)

Launchers: `a/bin/receiver`, `a/bin/owner`, `a/bin/client-a` (POSIX sh, need `node` 22+ on PATH).
Times `<T>` are ms integers, or `+N` / `-N` meaning now plus or minus N ms.
Exit codes for every command: 0 success / DONE / ACCEPTED, 1 REFUSED, 2 usage or I/O error, 3 UNKNOWN (no answer
yet), 4 REJECTED. All keys made by these tools are fresh TEST keys.

Receiver:
- `receiver init --home R --receiver-id RID --owner-key HEX --effect-root DIR` : new TEST key; prints `receiver_key <hex>`.
- `receiver pins --home R --supplied-by TEXT --out FILE` : writes a pins file from its config.
- `receiver run-once --home R [--fault drop-answer|drop-request|die-after-effect]` : recovers, handles every pending
  request in inbox (sorted by name), exits. Fault switches apply to every request in that run:
  `drop-answer` does the work but writes no answer; `drop-request` deletes the request unread (no work, no answer);
  `die-after-effect` kills its own process (SIGKILL) after the effect line is written and before the outcome is saved.
- `receiver serve --home R [--fault F] [--poll-ms N]` : loops like run-once every N ms (default 50) until `<R>/STOP`
  exists (it then deletes STOP and exits 0).
- `receiver status --home R <op_id>` : recovers, then prints the stored outcome envelope as one JSON line (exit 0 DONE,
  1 REFUSED) or `UNKNOWN` (exit 3).
- `receiver epoch --home R` : prints `epoch <n>` and, if locked after a restore, `locked floor <n>`.
- `receiver archive --home R --out-dir DIR` : writes `DIR/archive.bundle.json` (every authority, grant, proposal,
  approval and outcome it holds).
- `receiver restore --home R DIR` : `<R>/state` must be empty or absent; restores from `DIR/archive.bundle.json`;
  only outcomes signed by this receiver's own key are taken; prints `restored <n> outcomes, locked floor <f>`.

Owner (stand-in):
- `owner init --home O` : TEST key; prints `owner_key <hex>`.
- `owner grant --home O --client-key HEX --receiver-id RID --action NAME --resource RES --not-after T --out FILE` : prints `grant <hash>`.
- `owner authority --home O --receiver-id RID --epoch N [--grant FILE]... --out FILE` : prints `authority <hash>`.
- `owner approve --home O --proposal FILE --receiver-id RID --epoch N --not-after T [--decision approve|refuse] [--yes] --out FILE` :
  FIRST prints the resource and the exact text read from the proposal bytes, then signs only after `y` on stdin or `--yes`.
- `owner deliver --home O --receiver-home R --authority FILE [--wait-ms N]` : sends an authority request; prints the answer status.

Client A:
- `client-a init --home C` : TEST key; prints `client_key <hex>`.
- `client-a propose --home C --grant FILE --text TEXT [--op-id HEX32] [--action NAME] [--resource RES] --out FILE` :
  new random op_id unless given; action/resource default to the grant's scope; prints `op_id <hex> proposal <hash>`.
- `client-a send --home C --receiver-home R --grant FILE --proposal FILE [--approval FILE] [--note FILE]... [--request-id ID] [--wait-ms N]` :
  writes one submit request; waits up to N ms (default 10000; 0 = do not wait, print `SENT <request_id>`, exit 3);
  prints `<STATUS> <reason> <request_id>`.
- `client-a collect --home C --receiver-home R --request-id ID` : reads an answer if present, else `UNKNOWN` (exit 3).
- `client-a status --home C --receiver-home R --op-id HEX [--wait-ms N]` : sends a status request.
- `client-a note --home C --about HASH --label assessment|summary --text TEXT --out FILE`.
- `client-a keep --home C FILE...` : adds envelopes (or a bundle's items) to the client's record.
- `client-a export --home C --receiver-id RID --out FILE` : the emitter; writes a bundle of every item in the client's
  record (everything it sent and every outcome and authority it received).

Mapping of the acceptance list's words to this contract (deliberate):
- Acceptance item 6 "same op_id with different text: REFUSED" -> answer status `REJECTED`, reason `OP_ID_REUSED`, no
  effect, no new outcome (R4 finality).
- Acceptance item 10(c) "B submits under A's grant with B's key: REFUSED" -> `REJECTED WRONG_CLIENT` (R8: not a
  well-signed proposal for that grant), no effect.
- Acceptance item 10(d) "authority epoch 1 replayed: refused" -> authority answer `REJECTED STALE_AUTHORITY`.
- Acceptance item 13 "note says safe, approved, no approval: verifier INVALID" -> the receiver gives a signed REFUSED
  `NO_APPROVAL` (so the honest bundle verifies as REFUSED); the verifier says `INVALID NO_APPROVAL` when a bundle
  claims DONE without an approval (vector `invalid-note-no-approval`).

## 11. Test vectors (`vectors/`)
- `pins.json` (right pins) and `pins-wrong-owner.json` (a different owner key). All keys are fresh TEST keys.
- One bundle file per case; `done.demo.txt` is the demo file right after the DONE vector's effect (its SHA-256
  equals that outcome's `effect.after_sha256`).
- `expected-verdicts.json`: `{"v","about","vectors":[{"bundle","pins","note","bundle_verdict":{"verdict","reason"?,"item"?},"ops":{op_id:{"verdict","reason"?}},"exit","stdout"?}]}`.
  `bundle_verdict.verdict` is `OK`, `INVALID` or `UNTRUSTED_KEY`; `item` is the 0-based deciding item (absent for
  `OK` and `BAD_BUNDLE`); `ops` is empty unless `OK`; `stdout`, where present, is the verifier's exact stdout as an
  array of lines without line ends. This file is ordinary JSON (it is not a contract object).
- Every expected verdict follows from the bytes and section 8 alone.

## 12. Clarifications (v0.1.1, normative)

C1. The verifier is invoked as `verifier BUNDLE PINS`; on exit 2 (usage, unreadable file, bad pins) it writes the
    reason to stderr and nothing to stdout, and the pins file is read and checked before the bundle.
C2. For `BAD_BUNDLE` the verifier prints the `pins supplied by` line, the integrity line, then
    `BUNDLE INVALID BAD_BUNDLE`, and exits 4.
C3. JSON depth counts the top-level object as level 1 and each nested object or array as one more level; a 9th
    level is `BAD_JSON`, in payloads and in every unsigned file alike.
C4. Whitespace (space, tab, LF, CR) before or after the top-level value is allowed; only payloads have the
    65536-byte limit.
C5. Duplicate member names are compared after unescaping, code point by code point, with no Unicode normalisation.
C6. A JSON syntax error or duplicate name anywhere in a bundle file is `BAD_BUNDLE`; an item that parses but is not
    an object, or has wrong, missing, extra or wrongly typed envelope members (null included), is `BAD_ENVELOPE`
    at that index.
C7. Inside decoded payload bytes, any `true` or `false`, anywhere (including in an unknown field or as the value of
    `outcome.approval` or `outcome.effect`), is `BAD_JSON` (E4). Inside decoded payload bytes, `null` is `BAD_JSON`
    (E4) everywhere except as the direct value of `outcome.approval` or `outcome.effect`.
C8. `v` and `type` may appear at any position in a payload object.
C9. An outcome with status `DONE` must have reason `OK` (else `BAD_SCHEMA`); a `REFUSED` outcome may carry any `code`.
C10. Client keys come only from grants that are OK after S1 as owner-signed; a grant's scope, expiry, receiver_id or
    owner_key field does not gate S2; S1 roles are applied first and an item is never tried under a second role.
C11. Notes go through E1-E5, and through S1/S2 when their keyid is known, so a malformed or badly signed note makes the
    bundle INVALID; a note never enters O1-D14.
C12. D10 passes if ANY envelope in the bundle carrying that proposal's exact payload bytes is OK and has
    keyid(`G.client_key`).
C13. Section 8.2 is the complete list of operation checks: the verifier does not re-run receiver rules, does not
    read the effect file, accepts `not_after` equal to `at`, and does not check `seq` or `prev`.
C14. D13 passes if any one matching authority item lists the grant, however many authority items the bundle holds.
C15. A bundle with zero items is `BAD_BUNDLE`; a `BUNDLE OK` bundle with no proposal or outcome prints no OP lines
    and exits 0.
C16. `owner deliver --wait-ms` defaults to 10000; `0` means print `SENT <request_id>` and exit 3.
C17. A second `receiver run-once` or `serve` waits up to 60 s for `<R>/lock` (breaking it if its holder process is
    dead), then runs normally and exits 0; after 60 s it exits 2.
C18. `run-once --fault die-after-effect` ends by SIGKILL, so it has no normal exit code (a POSIX shell reports 137).
C19. A status answer's `authority` is the authority envelope at the stored outcome's epoch if the receiver holds it,
    else null (null for UNKNOWN).
C20. Acceptance item 10(b) yields `REFUSED GRANT_NOT_IN_AUTHORITY`, because section 7 check 3 comes before check 13
    (`STALE_EPOCH`); acceptance item 13 stays as mapped in section 10.

C21. A `true` or `false` value inside an unsigned file is not a parse error: in a bundle it is a shape error, so an
    item that is (or contains, as an envelope member) a boolean is `BAD_ENVELOPE` at its index, and a boolean as a
    top-level bundle member value is `BAD_BUNDLE`.
C22. `coverage` and `supplied_by` accept any UTF-8 of their stated lengths, and the verifier MUST print them escaped:
    each code point U+0000..U+001F and U+007F is printed as `\n` (LF), `\r` (CR), `\t` (TAB), or otherwise `\u00XX`
    (four hex digits, lowercase), and every other code point is printed as supplied, so a header is always one line.

## 13. Not in v0.1
No ledger requirement, MCP, Nostr, relays, shards, Bitcoin, post-quantum signatures, key rotation, more than one
owner or receiver, encryption of archives, freshness or completeness proofs.
