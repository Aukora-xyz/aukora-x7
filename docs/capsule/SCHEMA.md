# The capsule record: schema table (`aukora.capsule.v1`) and its window (`aukora.capsule-facts.v1`)

**Status: brought to the capsule contract, draft 7 (not published in this repository), by M1.** Section 4 makes this
table part of the contract once reviewed. The code holds the same table as `SCHEMA_TABLE` in
`deploy/cloudflare/src/capsule-envelope.mjs`; `capsule-envelope.test.mjs` fails if a row here differs from it or if a
record field has no row in the window map below. The act door's shapes (section 6.5a) are at the end, held in code as
`ACT_SHAPE_TABLE` in `deploy/cloudflare/src/capsule-act-shapes.mjs` and checked by `capsule-act-shapes.test.mjs`.

Every record is first a canonical text of `aukora.canon.v1` (section 3). The schema is closed: a missing or unknown
field, a wrong type, a value outside its list or bound, or a broken cross-field rule is `SCHEMA`. Another schema name,
`readerMin` above 1, another `canon` or a non-empty `extensions` is `CAPSULE_SCHEMA_UNSUPPORTED`, reported alone with
no field checks. `CAPSULE_INCOMPLETE` is a report, not a refusal (`ok` stays true, `complete` becomes false). Every v1
record carries the label `CAPSULE_PRODUCER_UNVERIFIED`. "id" means 1 to 128 printable ASCII characters; "code" means
`[A-Z][A-Z0-9_]{0,127}`. `complete` speaks only about the record as declared: nothing unknown, no failed source, every
required row present. The five always-excluded rows, present and excluded, do not make a record incomplete; no v1
record is her whole self, because it always leaves those five out and says so.

## Record fields

| Field | Type | Bound | Why this bound |
|---|---|---|---|
| `(body)` | object | exactly these members | section 4 (closed) |
| `schema` | string | "aukora.capsule.v1" | another schema name is CAPSULE_SCHEMA_UNSUPPORTED, reported alone |
| `state` | object | exactly these members | section 4 (closed) |
| `state.lineageId` | string or null | 64 lowercase hex digits | section 6.2: the act lineage is a digest |
| `state.parentCapsuleId` | string or null | 64 lowercase hex digits | a record id: a digest under aukora.capsule.v1 |
| `state.heads` | object | exactly these members | section 4 (closed) |
| `state.heads.local` | object | exactly these members | section 4 (closed) |
| `state.heads.local.ballId` | string | 64 lowercase hex digits | section 4: hex64 (both ball id forms are 64 lowercase hex; carried verbatim, 3.5) |
| `state.heads.local.ballIdForm` | string | one of canonical, legacy | section 4 closed list |
| `state.heads.local.epoch` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.heads.local.parentBallId` | string or null | 64 lowercase hex digits | a ball id, as ballId |
| `state.heads.published` | object or null | exactly these members | section 4 (closed) |
| `state.heads.published.ballId` | string | 64 lowercase hex digits | section 4: hex64 (both ball id forms are 64 lowercase hex; carried verbatim, 3.5) |
| `state.heads.published.ballIdForm` | string | one of canonical, legacy | section 4 closed list |
| `state.heads.published.epoch` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.heads.staged` | object or null | exactly these members | section 4 (closed) |
| `state.heads.staged.ballId` | string | 64 lowercase hex digits | section 4: hex64 (both ball id forms are 64 lowercase hex; carried verbatim, 3.5) |
| `state.heads.staged.ballIdForm` | string | one of canonical, legacy | section 4 closed list |
| `state.heads.staged.epoch` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.heads.staged.state` | string | one of awaiting_owner, published, superseded | closed list from the source: head-do.mjs:1049, :1123, :1139 |
| `state.heads.agreement` | string | one of agree, local-ahead, published-ahead, diverged, unknown | section 4 closed list; recomputed from the heads (rule agreement) |
| `state.producer` | object | exactly these members | section 4 (closed) |
| `state.producer.builder` | string | "host/capsule-record" | section 4 literal |
| `state.producer.builderVersion` | integer | 1 | section 4 literal |
| `state.producer.sourceRevision` | string or null | 40 lowercase hex digits | section 4: sourceRevision is 40 lowercase hex |
| `state.producer.runtimeArtifactSha256` | string or null | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.producer.claim` | string | "self-asserted" | section 4 literal |
| `state.inventory` | array | at most 2048 items; strictly ascending by id | section 4: inventory 2,048 |
| `state.inventory[]` | object | exactly these members | section 4 (closed) |
| `state.inventory[].id` | string | organ:<1..128 printable>, module:<hex64>, file:<1..128 printable>, or one of ownerBinding, messages, turnJournal, providerBudget, headHistory | section 4: inventory ids have a fixed form; the 1-to-128 rule applies after the prefix (draft 7 ruling 4) |
| `state.inventory[].kind` | string | one of organ-entry, module, file, log, root, other | section 4 closed list |
| `state.inventory[].byteLength` | integer or null | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.inventory[].digest` | string or null | 64 lowercase hex for sha256-raw; an id for native-id | rule digest-pair |
| `state.inventory[].digestKind` | string or null | one of sha256-raw, native-id | section 4 closed list |
| `state.inventory[].disposition` | string | one of included, excluded, unknown | section 4 closed list |
| `state.inventory[].reason` | string or null | one of EXCLUDED_AUTHORITY, EXCLUDED_SECRET, EXCLUDED_PRIVATE, EXCLUDED_HOST_SPECIFIC, EXCLUDED_NOT_PORTABLE, UNKNOWN_NO_SOURCE, UNKNOWN_SOURCE_FAILED, UNKNOWN_SIGNER_UNPINNED, UNKNOWN_NOT_CAPTURED | section 4 closed list; rule reason-pair |
| `state.roots` | object | exactly these members | section 4 (closed) |
| `state.roots.receipts` | object or null | exactly these members | section 4 (closed) |
| `state.roots.receipts.count` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.roots.receipts.lastLeafHash` | string | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.roots.receipts.checkpointSeq` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.roots.memory` | object or null | exactly these members | section 4 (closed) |
| `state.roots.memory.root` | string | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.roots.memory.nodes` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.roots.suite` | object or null | exactly these members | section 4 (closed) |
| `state.roots.suite.digest` | string | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.roots.suite.cases` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.roots.baseline` | object or null | exactly these members | section 4 (closed) |
| `state.roots.baseline.digest` | string | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.roots.policy` | object or null | exactly these members | section 4 (closed) |
| `state.roots.policy.version` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `state.roots.policy.digest` | string | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.pending` | array | at most 1024 items; strictly ascending by seq | section 4: pending 1,024 |
| `state.pending[]` | object | exactly these members | section 4 (closed) |
| `state.pending[].actionId` | string | 64 lowercase hex digits | section 4: actionId is hex64 |
| `state.pending[].intentId` | string | 32 lowercase hex digits | section 4: intentId is 32 lowercase hex |
| `state.pending[].seq` | integer | 1..9007199254740991 | section 4: seq is at least 1 |
| `state.pending[].state` | string | one of intent, sent, unknown | section 4 closed list |
| `state.evidence` | object | exactly these members | section 4 (closed) |
| `state.evidence.retention` | array | at most 1024 items; strictly ascending by ref | section 4: each evidence list 1,024 |
| `state.evidence.retention[]` | object | exactly these members | section 4 (closed) |
| `state.evidence.retention[].ref` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.retention[].issuer` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.retention[].scope` | string | one of behavioral-retention-only | section 4: evidence.scope is closed; retention rows carry "behavioral-retention-only" |
| `state.evidence.retention[].status` | string | one of verified, unverified, failed | section 4 closed list |
| `state.evidence.retention[].digest` | string or null | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.evidence.receipts` | array | at most 1024 items; strictly ascending by ref | section 4: each evidence list 1,024 |
| `state.evidence.receipts[]` | object | exactly these members | section 4 (closed) |
| `state.evidence.receipts[].ref` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.receipts[].issuer` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.receipts[].scope` | string | one of nostr-receipts-head | section 4: evidence.scope is closed; receipts rows carry "nostr-receipts-head" |
| `state.evidence.receipts[].status` | string | one of verified, unverified, failed | section 4 closed list |
| `state.evidence.receipts[].digest` | string or null | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.evidence.checkpoints` | array | at most 1024 items; strictly ascending by ref | section 4: each evidence list 1,024 |
| `state.evidence.checkpoints[]` | object | exactly these members | section 4 (closed) |
| `state.evidence.checkpoints[].ref` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.checkpoints[].issuer` | string | 1..128 printable ASCII characters | section 4: ids are 1 to 128 printable characters |
| `state.evidence.checkpoints[].scope` | string | one of checkpoint | section 4: evidence.scope is closed; checkpoints rows carry "checkpoint" |
| `state.evidence.checkpoints[].status` | string | one of verified, unverified, failed | section 4 closed list |
| `state.evidence.checkpoints[].digest` | string or null | 64 lowercase hex digits | section 4: hex64 is the type of every hash, root and digest |
| `state.compatibility` | object | exactly these members | section 4 (closed) |
| `state.compatibility.readerMin` | integer | 1..1 | section 4: readerMin is 1 (above 1: CAPSULE_SCHEMA_UNSUPPORTED, reported alone) |
| `state.compatibility.canon` | string | "aukora.canon.v1" | another canon is CAPSULE_SCHEMA_UNSUPPORTED, reported alone |
| `state.compatibility.unsupported` | array | at most 64 items; strictly ascending by value | section 4: code lists 64; sorted and unique |
| `state.compatibility.unsupported[]` | string | [A-Z][A-Z0-9_]{0,127} | section 4: codes match [A-Z][A-Z0-9_]{0,127} |
| `state.authorityRequired` | array | at most 64 items; strictly ascending by value | section 4: code lists 64; sorted and unique; exactly the three in a v1 record (rule authority-required); descriptive, never a grant (D5) |
| `state.authorityRequired[]` | string | one of OWNER_APPROVED_MOVE, OWNER_SESSION, WRITER_LEASE | section 4: a closed list of three codes |
| `state.extensions` | object | {} (non-empty: CAPSULE_SCHEMA_UNSUPPORTED, reported alone) | section 4: must be empty in v1 |
| `observation` | object | exactly these members | section 4 (closed) |
| `observation.capturedAtMs` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |
| `observation.attempt` | integer | 1..3 | section 4: attempt is 1 to 3 |
| `observation.sources` | array | at most 64 items; strictly ascending by name | section 4: sources 64 |
| `observation.sources[]` | object | exactly these members | section 4 (closed) |
| `observation.sources[].name` | string | one of baseline, evidence, files, head.local, head.published, head.staged, holder, journal, lease, lineage, memory, modules, organs, owner, policy, producer, receipts, suite | section 5: source names, a closed list |
| `observation.sources[].ok` | boolean | true or false | section 4 |
| `observation.sources[].code` | string or null | [A-Z][A-Z0-9_]{0,127} | section 4: codes match [A-Z][A-Z0-9_]{0,127} |
| `observation.sources[].observedAtMs` | integer | 0..9007199254740991 | section 4: epochs, counts, times and policy.version are integers from 0 |

## Rules across fields

- **agreement**: the stored agreement equals the one recomputed from local and published: unknown if published is null or the two id forms differ; agree if ids and epochs are equal; diverged if exactly one of id and epoch is equal; otherwise local-ahead or published-ahead by the larger epoch. A stored value that differs is SCHEMA; the staged head does not enter the rule. Why: section 4 "three heads, never one"; S4.
- **digest-pair**: digest is null exactly when digestKind is null; sha256-raw needs 64 lowercase hex, native-id an id. Why: section 4 types; 3.5.
- **reason-pair**: included has reason null; excluded has an EXCLUDED_ reason; unknown has an UNKNOWN_ reason. Why: section 4 types.
- **source-code**: a sources row with ok true has code null; with ok false it has a code. Why: section 4 types.
- **failed-source**: every sources row with ok false is CAPSULE_INCOMPLETE: a record with a failed source is not complete, whether or not a null names it. Why: section 4: complete means nothing unknown, no failed source, every required row present; draft 7 ruling 3.
- **null-source**: a null field of the source table: its source row with ok true is complete, with ok false is CAPSULE_INCOMPLETE; no row for its source is SCHEMA. Why: section 4 "unknown is null plus a sources row".
- **inventory-id**: an inventory id is organ:<id>, module:<hex64>, file:<id> or one of the five fixed names; the 1-to-128 rule applies to the part after the prefix; anything else is SCHEMA (a field rule, checked with the field). Why: section 4; draft 7 ruling 4.
- **inventory-kind**: the form fixes the kind: organ: with organ-entry, module: with module, file: with file, log, root or other; anything else is SCHEMA. Why: section 4; draft 7 ruling 4.
- **excluded-constant**: a row named ownerBinding, messages, turnJournal, providerBudget or headHistory is the constant: kind other; byteLength, digest and digestKind null; disposition excluded; reason EXCLUDED_AUTHORITY for ownerBinding, EXCLUDED_PRIVATE for messages and turnJournal, EXCLUDED_HOST_SPECIFIC for providerBudget, EXCLUDED_NOT_PORTABLE for headHistory; any other value is SCHEMA. Why: section 4 "those five rows are constants"; draft 7 ruling 5.
- **required-excluded**: a record without one of the five rows ownerBinding, messages, turnJournal, providerBudget, headHistory is CAPSULE_INCOMPLETE. Why: section 4 "required rows"; draft 7 ruling 5 ("as before").
- **authority-required**: authorityRequired is exactly OWNER_APPROVED_MOVE, OWNER_SESSION, WRITER_LEASE; any other list is SCHEMA. Why: section 4 "a v1 record carries all three, always"; draft 7 ruling 6.
- **item-bytes**: with item bytes supplied, each sha256-raw item is checked against its bytes (a changed byte or a truncation is CAPSULE_BYTES_MISMATCH naming the item); an item with no bytes supplied is CAPSULE_INCOMPLETE and never counted as verified. Why: section 4 "the verifier".

## The closed lists of section 4

- `state.heads.staged.state`: `awaiting_owner`, `published`, `superseded`. These are the only values HEAD gives the
  `state` of its staged promotion record: `deploy/cloudflare/src/head-do.mjs:1049` and `:1139` (`awaiting_owner`, the held
  candidate) and `:1123` (`published` or `superseded`, a staged record the head has moved past). Read at an earlier main.
- `evidence.scope`: closed, one value per list (ruling 2): retention rows `behavioral-retention-only`, receipts rows `nostr-receipts-head`, checkpoints rows `checkpoint`.
  Sources: `behavioral-retention-only` is the retention admission scope (`packages/experimental/webworker-runtime/src/x6/ball-loader.ts:4135`,
  checked at `server/verified-facts.mjs:261`); `nostr-receipts-head` is the receipts head read's scope
  (`deploy/cloudflare/src/mirror-do.mjs:1181-1182`); `checkpoint` is the contract's own name (checkpoints carry no scope in
  the source). Each list takes its own value and no other: another list's scope is `SCHEMA`.
- `authorityRequired[]`: exactly `OWNER_APPROVED_MOVE`, `OWNER_SESSION`, `WRITER_LEASE` in a v1 record (ruling 6); any other list is `SCHEMA`; descriptive only (D5).
- `inventory[].id`: `organ:<organ id>`, `module:<sha256>` (64 lowercase hex), `file:<path id>`, or one of the five fixed names
  `ownerBinding`, `messages`, `turnJournal`, `providerBudget`, `headHistory`. The 1-to-128 rule applies to the part after the prefix (ruling 4). The form fixes
  the kind: `organ:` with `organ-entry`; `module:` with `module`; `file:` with `file`, `log`, `root`, `other`; anything else is `SCHEMA`.
- The five always-excluded rows are constants (ruling 5): kind `other`; `byteLength`, `digest`, `digestKind` null; disposition `excluded`;
  reason `EXCLUDED_AUTHORITY` for `ownerBinding`, `EXCLUDED_PRIVATE` for `messages`, `EXCLUDED_PRIVATE` for `turnJournal`, `EXCLUDED_HOST_SPECIFIC` for `providerBudget`, `EXCLUDED_NOT_PORTABLE` for `headHistory`. Any other value is `SCHEMA`; a missing one is `CAPSULE_INCOMPLETE`.

## Where each null comes from (the fixed table of section 4)

| Field | Source row name |
|---|---|
| `state.lineageId` | `lineage` |
| `state.parentCapsuleId` | `lineage` |
| `state.heads.local.parentBallId` | `head.local` |
| `state.heads.published` | `head.published` |
| `state.heads.staged` | `head.staged` |
| `state.producer.sourceRevision` | `producer` |
| `state.producer.runtimeArtifactSha256` | `producer` |
| `state.roots.receipts` | `receipts` |
| `state.roots.memory` | `memory` |
| `state.roots.suite` | `suite` |
| `state.roots.baseline` | `baseline` |
| `state.roots.policy` | `policy` |

A null whose source row says `ok: true` was read and nothing is there (complete). A row that says `ok: false` makes the
record `CAPSULE_INCOMPLETE`. A null with no row for its source is `SCHEMA`. Source names are the closed list of section 5:
`baseline`, `evidence`, `files`, `head.local`, `head.published`, `head.staged`, `holder`, `journal`, `lease`, `lineage`, `memory`, `modules`, `organs`, `owner`, `policy`, `producer`, `receipts`, `suite`. The inventory must also hold the five always-excluded rows
`ownerBinding`, `messages`, `turnJournal`, `providerBudget`, `headHistory`, else `CAPSULE_INCOMPLETE`.

## The window: `aukora.capsule-facts.v1` (section 5)

Built by the host and deep-frozen; the only input of the record builder and of her view. Types are those draft 7 gives;
"not typed by draft 7" marks a field whose type the contract leaves open (nothing here decides it).

| Window field | Type | Note |
|---|---|---|
| `schema` | "aukora.capsule-facts.v1" | literal |
| `body.hostClass` | string | not typed by draft 7 |
| `body.bootId` | string | not typed by draft 7; never in a record |
| `body.keyThumb` | hex64 or null | a key thumb (3.5, `aukora.key.v1`) |
| `captured.atMs` | integer from 0 | section 4 times |
| `captured.attempt` | integer 1..3 | section 4 attempt; section 5 capture retries at most twice |
| `sources[]` | array, at most 64, strictly ascending by name | section 5 |
| `sources[].name` | one of baseline, evidence, files, head.local, head.published, head.staged, holder, journal, lease, lineage, memory, modules, organs, owner, policy, producer, receipts, suite | section 5 closed list |
| `sources[].ok` | boolean | section 5 |
| `sources[].code` | code or null | null exactly when ok is true (section 4) |
| `sources[].observedAtMs` | integer from 0 | section 5 |
| `lineageId` | hex64 or null | section 6.2 |
| `producer.sourceRevision` | 40 lowercase hex or null | section 4 |
| `producer.runtimeArtifactSha256` | hex64 or null | section 4 |
| `head.local` | { ballId, ballIdForm, epoch, parentBallId or null } | as in the record |
| `head.published` | { ballId, ballIdForm, epoch } or null | as in the record; read by one request inside the capture |
| `head.staged` | { ballId, ballIdForm, epoch, state } or null | as in the record; state one of awaiting_owner, published, superseded |
| `head.agreement` | one of agree, local-ahead, published-ahead, diverged, unknown | as in the record (the five-value rule) |
| `authority.owner.bound` | true, false or null | a boolean about the binding, never its bytes |
| `authority.owner.credentialCount` | integer from 0 or null | a count, never a credential |
| `authority.holder.claimed` | not typed by draft 7 | may be null |
| `authority.holder.generation` | integer from 0 or null | may be null |
| `authority.holder.youAreHolder` | boolean or null | may be null |
| `authority.lease` | { held, generation, expiresAtMs } or null | the edge's view only; never a lease reference |
| `authority.policy` | { version, digest } or null | version an integer from 0, digest hex64 |
| `store.durable` | boolean | not typed by draft 7 |
| `store.readOnly` | boolean | not typed by draft 7 |
| `store.pendingPaths` | integer from 0 | not typed by draft 7 (read as a count: host paths are excluded) |
| `store.mirror.pendingBatches` | integer from 0 | not typed by draft 7 |
| `store.mirror.conflict` | boolean | not typed by draft 7 |
| `snapshots.count` | integer from 0 | section 4 counts |
| `snapshots.latestId` | id or null | not typed by draft 7 |
| `snapshots.latestAtMs` | integer from 0 or null | section 4 times |
| `roots.receipts` | { count, lastLeafHash, checkpointSeq } or null | as in the record |
| `roots.memory` | { root, nodes } or null | as in the record |
| `roots.suite` | { digest, cases } or null | as in the record |
| `roots.baseline` | { digest } or null | as in the record |
| `organs[]` | array, strictly ascending by id | section 5 |
| `organs[].id` | id | section 4 ids |
| `organs[].specifier` | string | not typed by draft 7 |
| `organs[].sha256` | hex64 | the module bytes, sha256-raw |
| `organs[].bytes` | integer from 0 | a byte length |
| `organs[].disabled` | boolean | not typed by draft 7 |
| `organs[].configDigest` | hex64 or null | not typed by draft 7 |
| `modules[]` | array, strictly ascending by sha256 | section 5 |
| `modules[].sha256` | hex64 | sha256-raw |
| `modules[].bytes` | integer from 0 | a byte length |
| `files[]` | array, strictly ascending by id | section 5 |
| `files[].id` | id | section 4 ids |
| `files[].kind` | one of file, log, root, other | section 5 |
| `files[].byteLength` | integer from 0 or null | as the inventory |
| `files[].digest` | as the inventory | rule digest-pair |
| `files[].digestKind` | sha256-raw, native-id or null | as the inventory |
| `files[].disposition` | included, excluded or unknown | as the inventory |
| `files[].reason` | a reason code or null | rule reason-pair |
| `pending[]` | as the record | the body's own journal |
| `evidence` | { retention[], receipts[], checkpoints[] } | as the record |
| `effects[]` | array | adapters; empty until the act client exists |
| `models[]` | { name, kind: remote or local, manifestDigest or null } | not typed by draft 7 |
| `capabilities.indexDigest` | hex64 | not typed by draft 7 |
| `capabilities.toolCount` | integer from 0 | a count |
| `attestation` | "none" | literal |
| `errors[]` | { field, code } | not typed by draft 7 |

## Every record field and the window field it is computed from

The record builder reads the window and nothing else. "A constant of the builder" is a fixed value of the builder,
not a read. `state.parentCapsuleId` has no window field (null in this push, by section 4), and `state.authorityRequired`
is the constant list of all three (ruling 6).

| Record field | Window field | How |
|---|---|---|
| `schema` | (none) | a constant of the builder: "aukora.capsule.v1" |
| `state` | (the fields below) | object |
| `state.lineageId` | lineageId | copied |
| `state.parentCapsuleId` | (none: the window has no parent-capsule field) | a constant of the builder in this push: null (section 4: no record descends from another yet); the `lineage` source row explains it |
| `state.heads` | head | object |
| `state.heads.local` | head.local | copied |
| `state.heads.local.ballId` | head.local.ballId | copied |
| `state.heads.local.ballIdForm` | head.local.ballIdForm | copied |
| `state.heads.local.epoch` | head.local.epoch | copied |
| `state.heads.local.parentBallId` | head.local.parentBallId | copied |
| `state.heads.published` | head.published | copied; null with the `head.published` row |
| `state.heads.published.ballId` | head.published.ballId | copied |
| `state.heads.published.ballIdForm` | head.published.ballIdForm | copied |
| `state.heads.published.epoch` | head.published.epoch | copied |
| `state.heads.staged` | head.staged | copied; null with the `head.staged` row |
| `state.heads.staged.ballId` | head.staged.ballId | copied |
| `state.heads.staged.ballIdForm` | head.staged.ballIdForm | copied |
| `state.heads.staged.epoch` | head.staged.epoch | copied |
| `state.heads.staged.state` | head.staged.state | copied (closed list) |
| `state.heads.agreement` | head.local, head.published | computed by the five-value rule (the window's head.agreement must equal it) |
| `state.producer` | producer | object |
| `state.producer.builder` | (none) | a constant of the builder: "host/capsule-record" |
| `state.producer.builderVersion` | (none) | a constant of the builder: 1 |
| `state.producer.sourceRevision` | producer.sourceRevision | copied |
| `state.producer.runtimeArtifactSha256` | producer.runtimeArtifactSha256 | copied |
| `state.producer.claim` | (none) | a constant of the builder: "self-asserted" |
| `state.inventory` | organs[], modules[], files[] | one row per organ entry, one per module, one per file row; sorted by id |
| `state.inventory[]` | organs[] / modules[] / files[] | one item per window row |
| `state.inventory[].id` | organs[].id / modules[].sha256 / files[].id | the fixed forms of section 4: `organ:<organs[].id>`, `module:<modules[].sha256>`, `file:<files[].id>`; the five always-excluded rows by their fixed names, as constants of the builder (ruling 5) |
| `state.inventory[].kind` | (organ-entry, module) / files[].kind | organ-entry for organs[], module for modules[], the window row's kind for files[], other for the five (the form fixes the kind, ruling 4) |
| `state.inventory[].byteLength` | organs[].bytes / modules[].bytes / files[].byteLength | copied |
| `state.inventory[].digest` | organs[].sha256 / modules[].sha256 / files[].digest | copied |
| `state.inventory[].digestKind` | (sha256-raw) / files[].digestKind | sha256-raw for organs[] and modules[] |
| `state.inventory[].disposition` | (included) / files[].disposition | included for organs[] and modules[] |
| `state.inventory[].reason` | (null) / files[].reason | null for organs[] and modules[] |
| `state.roots` | roots, authority.policy | object |
| `state.roots.receipts` | roots.receipts | copied |
| `state.roots.receipts.count` | roots.receipts.count | copied |
| `state.roots.receipts.lastLeafHash` | roots.receipts.lastLeafHash | copied |
| `state.roots.receipts.checkpointSeq` | roots.receipts.checkpointSeq | copied |
| `state.roots.memory` | roots.memory | copied |
| `state.roots.memory.root` | roots.memory.root | copied |
| `state.roots.memory.nodes` | roots.memory.nodes | copied |
| `state.roots.suite` | roots.suite | copied |
| `state.roots.suite.digest` | roots.suite.digest | copied |
| `state.roots.suite.cases` | roots.suite.cases | copied |
| `state.roots.baseline` | roots.baseline | copied |
| `state.roots.baseline.digest` | roots.baseline.digest | copied |
| `state.roots.policy` | authority.policy | copied |
| `state.roots.policy.version` | authority.policy.version | copied |
| `state.roots.policy.digest` | authority.policy.digest | copied |
| `state.pending` | pending[] | copied |
| `state.pending[]` | pending[] | copied |
| `state.pending[].actionId` | pending[].actionId | copied |
| `state.pending[].intentId` | pending[].intentId | copied |
| `state.pending[].seq` | pending[].seq | copied |
| `state.pending[].state` | pending[].state | copied |
| `state.evidence` | evidence | copied |
| `state.evidence.retention` | evidence.retention[] | copied |
| `state.evidence.retention[]` | evidence.retention[] | copied |
| `state.evidence.retention[].ref` | evidence.retention[].ref | copied |
| `state.evidence.retention[].issuer` | evidence.retention[].issuer | copied |
| `state.evidence.retention[].scope` | evidence.retention[].scope | copied |
| `state.evidence.retention[].status` | evidence.retention[].status | copied |
| `state.evidence.retention[].digest` | evidence.retention[].digest | copied |
| `state.evidence.receipts` | evidence.receipts[] | copied |
| `state.evidence.receipts[]` | evidence.receipts[] | copied |
| `state.evidence.receipts[].ref` | evidence.receipts[].ref | copied |
| `state.evidence.receipts[].issuer` | evidence.receipts[].issuer | copied |
| `state.evidence.receipts[].scope` | evidence.receipts[].scope | copied |
| `state.evidence.receipts[].status` | evidence.receipts[].status | copied |
| `state.evidence.receipts[].digest` | evidence.receipts[].digest | copied |
| `state.evidence.checkpoints` | evidence.checkpoints[] | copied |
| `state.evidence.checkpoints[]` | evidence.checkpoints[] | copied |
| `state.evidence.checkpoints[].ref` | evidence.checkpoints[].ref | copied |
| `state.evidence.checkpoints[].issuer` | evidence.checkpoints[].issuer | copied |
| `state.evidence.checkpoints[].scope` | evidence.checkpoints[].scope | copied |
| `state.evidence.checkpoints[].status` | evidence.checkpoints[].status | copied |
| `state.evidence.checkpoints[].digest` | evidence.checkpoints[].digest | copied |
| `state.compatibility` | (none) | a constant of the builder |
| `state.compatibility.readerMin` | (none) | a constant of the builder: 1 |
| `state.compatibility.canon` | (none) | a constant of the builder: "aukora.canon.v1" |
| `state.compatibility.unsupported` | (none) | a constant of the builder: [] |
| `state.compatibility.unsupported[]` | (none) | none in v1 |
| `state.authorityRequired` | (none) | a constant of the builder: all three of OWNER_APPROVED_MOVE, OWNER_SESSION, WRITER_LEASE, always (section 4, ruling 6: every restored body needs each of them before it can act; descriptive only, D5) |
| `state.authorityRequired[]` | (none) | as above |
| `state.extensions` | (none) | a constant of the builder: {} |
| `observation` | captured, sources[] | object; outside the state root |
| `observation.capturedAtMs` | captured.atMs | copied |
| `observation.attempt` | captured.attempt | copied |
| `observation.sources` | sources[] | copied |
| `observation.sources[]` | sources[] | copied |
| `observation.sources[].name` | sources[].name | copied |
| `observation.sources[].ok` | sources[].ok | copied |
| `observation.sources[].code` | sources[].code | copied |
| `observation.sources[].observedAtMs` | sources[].observedAtMs | copied |

Window fields the record does not use (her view may): `body.*`, `authority.owner`, `authority.holder`, `authority.lease`,
`store`, `snapshots`, `effects[]`, `models[]`, `capabilities`, `attestation`, `errors[]`.

## The act door's shapes (section 6.5a) and the gate's two calls (section 8)

Closed canonical objects of `aukora.canon.v1`: a missing or unknown member, a wrong type or a value outside its list is
`SCHEMA` with the rule name in the last column (a `*` names the member's own rules). A whole message (answer, read, status,
row read, request) is judged on its bytes, or for a host value on `parse(encode(value))`; a text that is not canonical is
refused by its class of section 3.3 under the rule `<shape>.canon`. Rules across fields: an answer's `code` is null unless
`result` is `refused`, and is then one of the act-door codes; a `row` read names exactly one of `actionId` and `intentId`,
a `status` or `pending` read neither; a `commit` or `abandon` request carries `command: null` (rule `request.commandNull`);
the gate's inputs are checked for one call: at `creation` the verb is `intent` or `act`, `rowGeneration` is null and
`logicalTime.rows` is from 0; at `commit` the verb is `commit`, `rowGeneration` is an integer and `logicalTime.rows` is from 1
(ruling 13). Signatures are never checked here.

Draft 7 rulings 9 to 12, checked in this order after the members' own types. The four state members of an answer (`head`,
`holderGeneration`, `holderKeyThumb`, `chain`) are all null exactly when `code` is `CAPSULE_ACTION_ID_MISMATCH` or `CAPSULE_LINEAGE_MISMATCH`; `holderKeyThumb`
and `chain` are null with the other two present only in a refused `CAPSULE_INSTANCE_REVOKED` (a world with no holder); in every other
answer all four are present (rule `answer.state`). In a status `holderKeyThumb` is null exactly when `chain` is null (`status.state`).
The row in an answer: with `pending`, `committed` or `abandoned` it is present and its state is the result; refused with one of
the two codes it is null; refused otherwise it may be a row or null (`answer.row`). Every row: `resolvedBy` null exactly when
pending; `gate.commit` present exactly when committed, and then ALLOW (a commit verdict that is not ALLOW is never stored);
`seq` and `intentId` the command's; `actionId` the digest of the command. `checkRow`, `checkAnswer` and `checkRowRead` hash, so
they are async.

The act-door codes (section 16, the rows whose speaker is the act door, in its order): `CAPSULE_ACTION_ID_MISMATCH`, `CAPSULE_LINEAGE_MISMATCH`, `PROOF_INVALID`, `PROOF_REPLAYED`, `PROOF_SUPERSEDED`, `CAPSULE_GENERATION_STALE`, `CAPSULE_INSTANCE_REVOKED`, `BODY_KEY_FORKED`, `WRITER_LEASE_REQUIRED`, `CAPSULE_INTENT_ALREADY_PLACED`, `CAPSULE_ACTION_CONFLICT`, `CAPSULE_POSITION_STALE`, `CAPSULE_ACTION_UNKNOWN`, `CAPSULE_ACTION_ABANDONED`, `CAPSULE_ACTION_COMMITTED`, `CAPSULE_INHERITED_LOCKED`, `CAPSULE_GATE_DENIED`, `CAPSULE_LEDGER_FULL`.

| Shape | Field | Type | Refusal rule |
|---|---|---|---|
| verdict | `decision` | one of ALLOW, ESCALATE, DENY | `verdict.decision` |
| verdict | `reason` | a code, `[A-Z][A-Z0-9_]{0,127}` (her closed list, once written) | `verdict.reason` |
| verdict | `policyDigest` | hex64 | `verdict.policyDigest` |
| row | `seq` | integer from 1 | `row.seq` |
| row | `actionId` | hex64 | `row.actionId` |
| row | `intentId` | 32 lowercase hex | `row.intentId` |
| row | `state` | one of pending, committed, abandoned | `row.state` |
| row | `command` | the command object of 6.3 | `command.*` |
| row | `intentBy` | { keyThumb: hex64, holderGeneration: integer from 0, chainFirstThumb: hex64 } | `row.intentBy.*` |
| row | `resolvedBy` | { keyThumb: hex64, holderGeneration: integer from 0 } or null | `row.resolvedBy.*` |
| row | `gate` | { creation: verdict, commit: verdict or null } | `row.gate.*` |
| row | `(resolvedBy, state)` | resolvedBy is null exactly when state is pending | `row.resolvedBy.state` |
| row | `(gate.commit, state)` | gate.commit is present exactly when state is committed | `row.gate.commit.state` |
| row | `gate.commit.decision` | ALLOW: a commit verdict that is not ALLOW is never stored | `row.gate.commit.allow` |
| row | `(seq, intentId)` | the command's seq and intentId | `row.command` |
| row | `(actionId, command)` | actionId is the digest of the command (aukora.act.v1) | `row.actionId.digest` |
| chain | `firstThumb` | hex64 | `chain.firstThumb` |
| chain | `currentThumb` | hex64 | `chain.currentThumb` |
| chain | `lastDigest` | hex64 or null | `chain.lastDigest` |
| chain | `locked` | boolean | `chain.locked` |
| answer | `schema` | "aukora.act-answer.v1" | `answer.schema` |
| answer | `envelopeDigest` | hex64 | `answer.envelopeDigest` |
| answer | `verified` | boolean | `answer.verified` |
| answer | `result` | one of pending, committed, abandoned, refused | `answer.result` |
| answer | `code` | null unless result is refused; then one of the 18 act-door codes of section 16 | `answer.code` |
| answer | `row` | row or null | `row.*` |
| answer | `head` | { seq: integer from 0, id: hex64 } or null | `answer.head.*` |
| answer | `holderGeneration` | integer from 0 or null | `answer.holderGeneration` |
| answer | `holderKeyThumb` | hex64 or null | `answer.holderKeyThumb` |
| answer | `chain` | chain or null | `chain.*` |
| answer | `(head, holderGeneration, holderKeyThumb, chain)` | all four null exactly when code is CAPSULE_ACTION_ID_MISMATCH or CAPSULE_LINEAGE_MISMATCH; holderKeyThumb and chain null (head and holderGeneration present) only in a refused CAPSULE_INSTANCE_REVOKED; otherwise all four present | `answer.state` |
| answer | `(row, result)` | pending, committed, abandoned: a row whose state is the result; refused with one of the two codes above: null; refused otherwise: a row or null | `answer.row` |
| read | `schema` | "aukora.act-read.v1" | `read.schema` |
| read | `verb` | one of status, pending, row | `read.verb` |
| read | `actionId` | hex64 or null | `read.actionId` |
| read | `intentId` | 32 lowercase hex or null | `read.intentId` |
| read | `(actionId, intentId)` | row: exactly one of the two is set; status and pending: both null | `read.ids` |
| status | `schema` | "aukora.act-status.v1" | `status.schema` |
| status | `lineageId` | hex64 | `status.lineageId` |
| status | `holderGeneration` | integer from 0 | `status.holderGeneration` |
| status | `holderKeyThumb` | hex64 or null | `status.holderKeyThumb` |
| status | `lease` | { held: boolean, generation: integer from 0 } | `status.lease.*` |
| status | `chain` | chain or null | `chain.*` |
| status | `head` | { seq: integer from 0, id: hex64 } | `status.head.*` |
| status | `pending` | boolean | `status.pending` |
| status | `(holderKeyThumb, chain)` | both null (a world with no holder) or both present | `status.state` |
| rowread | `schema` | "aukora.act-row.v1" | `rowread.schema` |
| rowread | `row` | row or null (none) | `row.*` |
| gate inputs | `(call)` | creation or commit | `gate.call` |
| gate inputs | `proposal.verb` | creation: intent or act; commit: commit | `proposal.verb.call` |
| gate inputs | `capability.rowGeneration` | creation: null; commit: integer from 0 | `capability.rowGeneration.call` |
| gate inputs | `capability.ownerBound` | boolean (the door passes true; her bench may pass false) | `capability.ownerBound` |
| gate inputs | `courtResult` | null | `courtResult.null` |
| gate inputs | `lease` | { held: boolean, generation: integer from 0 } | `lease.*` |
| gate inputs | `logicalTime.rows` | creation: from 0; commit: from 1 (the row being committed is counted); at most 1,024 | `logicalTime.rows.call` |
