# Her voice memory

Every finished spoken exchange becomes one record that names the hash of the record before it. A record holds no
words, only commitments to them; the words live beside it, in a file that could be deleted without touching the chain.

## What is kept, and where

| Holder | What | Where |
|---|---|---|
| Her home (her browser) | the whole chain, one canonical record per line; it only ever grows | `/dsh/home/auma/voice/chain.v1.jsonl` |
| Her home | the words, one words record per line | `/dsh/home/auma/voice/words.v1.jsonl` |
| Her edge | the head and the last 40 exchanges with their words | the VoiceBridge object |

The page carries the records from the edge to her home: after the tab door says `ready` it sends `memory_have` with
her home's head; each `memory` frame from the bridge (at most 8 items, 48,000 bytes) is one append, answered
`memory_ack` or `memory_nack` (`GAP`, `FORK` or `WRITE_FAILED`) with her home's head
(`apps/web/scripts/stock-apps/managed-voice/controller.mjs`). Nothing waits on it: a turn never blocks on her home,
and a failed write is tried again only when the bridge sends its next frame. Only a head her home actually READ goes up
(`ok: true`): an unreadable home (`HOME_UNREADABLE`, which carries seq 0) is never told to the edge as an empty one;
then no `memory_have` and no nack is sent, and the edge changes nothing. A `memory_have` that could not be sent at
`ready` is tried again with the next awareness push and after each of her turns, once sent never again that call.

Her worker's route `/__x6__/voice-memory` (POST, this page's own worker channel, 64 KiB body) is the one writer of the
two files (`packages/experimental/webworker-runtime/src/storage/voice-memory.ts`, wired in `ball-loader.ts`):
- `{ "action": "head" }` answers `{ ok, seq, digest }` (seq 0 and 64 zeros when her home has no chain).
- `{ "action": "append", "items": [...] }` checks EVERY item before writing anything: seq one above her home's last
  (the same bytes sent again are skipped; another record at a seq she has is `FORK`; a seq further on is `GAP`), `prev`
  equal to the last record's digest (else `FORK`), shapes and caps (`ITEM_INVALID`), both commitments open with the
  words (`COMMITMENT`), at most 8 items (`TOO_MANY_ITEMS`). Then the words lines and the chain lines are written
  together; a failed write puts both files back (`WRITE_FAILED`). A refusal answers with her home's head, unchanged.
  The folder is made on first use; a symbolic link on the way is refused.

From her fast voice, `read`, `grep` and `glob` never open either file (a memory store: "that is my voice memory; I read
it only through x6_voice_memory"); a search of a folder above withholds their entries. Her voice scratch tool is
confined to its own folder and cannot reach them.

## The formats (DESIGN.md, implemented exactly)

Canonical JSON: UTF-8, object keys sorted by code unit, no whitespace, integers only, no floats, no undefined.
`sha256hex(bytes)` is the lower-case hex of SHA-256.

- Chain record: `{ v: 1, seq, prev, at, conv, turn, kind: "exchange", heardC, saidC, ended, path, calls }`;
  `ended` is `answered`, `cut`, `handed`, `failed` or `refused`; `path` is `fast` or `governed`; `calls` (at most 8)
  are `{ id, req, res, model, effort, rid }` receipts of the model calls that produced it.
- `digest(record)` = `sha256hex(canonical(record))`; the next record's `prev` is that digest (64 zeros for seq 1).
- `heardC` = `sha256hex(salt || 0x00 || utf8(heard))`, `saidC` = `sha256hex(salt || 0x01 || utf8(said))`.
- Words record: `{ seq, salt, heard, said }`: a fresh 16-byte salt per record (32 hex), heard at most 4,000
  characters, said at most 6,000. The salt lives only here, never in the chain record.
- Gap record: `{ v: 1, kind: "gap", seq, prev, at, missingFrom, missingTo }` with `seq` = `missingTo`. When her home
  is further behind than the edge's tail reaches, a gap starts a new segment: its `prev` is the edge's digest of the
  record at `missingTo`, and the next record names that same digest. It has no words. No digest covers a gap
  record's own fields (`at`, `missingFrom`, `prev` itself): the next record names only the edge's digest. So her
  home alone cannot tell a true gap from an exchange that was replaced by one; the verifier names every gap span.

The page's implementation is checked against the edge lane's vectors (`voicememory1/VECTORS.json`): every record's
canonical text, its UTF-8 bytes, its digest, its commitments and the gap record match
(`packages/experimental/webworker-runtime/tests/x6/voice-memory.spec.ts`).

## What the verifier shows: `x6_voice_memory`

A built-in read (class 0 for every action; her fast voice calls it through `look`; its answers pass the same secret
filter as every voice answer):
- `verify`: walks the chain file (every line canonical, every seq in order, every digest and link) and opens every
  words record against its commitments, then asks the edge for its head through the owner status read
  `x6_voice_status` uses (`managed_status`, its `memory.seq` and `memory.digest12`). The status carries only the first
  12 hex of the edge's head digest, so those 12 are compared, and the answer says so. Closed verdicts:
  `INTACT_MATCHES_EDGE`, `INTACT_HOME_BEHIND` (with how many), `INTACT_EDGE_BEHIND` (with how many), `FORK_AT` (seq),
  `BROKEN_AT` (seq, and which check failed), `WORDS_MISSING` (the seqs whose words are gone with no deletion record),
  `EDGE_UNREACHABLE` (the edge did not answer with its head: this is unknown, never a pass). A status with the switch
  off carries the edge's default block (seq 0), not a head it read: that is `EDGE_UNREACHABLE` too. When the edge
  marks a fork (`memory.fork`), the verdict is `FORK_AT` its seq, whatever the digests say: it has stopped appending
  to her home until a person decides. Every `verify` answer carries `gaps` (the spans her home records as gap records)
  and `gapCount`, with a sentence saying what a gap does not show; `tail` and `search` carry them when there are any.
- `tail { n }`: the last n exchanges (n at most 20, default 5) with their words and age.
- `search { q }`: plain text (any case) over the words, at most 10 hits, newest first, each with seq, age and 200
  characters around the hit.
- `head`: her home's last seq and digest.
- Any other action: `VOICE_MEMORY_ACTION_INVALID`, refused by the tool itself.

Every answer ends with: "This compares her home with her own edge: it catches bugs and a changed file, not a rewrite
by whoever controls both."

The verifier compares the browser and edge copies. It can detect lost writes, bugs and changes to one copy. Whoever controls both can rewrite them together. An outside witness would require owner approval.

## How conversations share memory

Typed and spoken conversations receive timeline entries from other conversations. Each spoken exchange appended at home gets a timeline pointer. The feed follows that pointer to read the words file.

- When: the FIRST step of a turn only, when her timeline holds records this conversation has not been given that did
  not happen in itself. A later step, and a turn with nothing new, get nothing.
- What: ONE user message, source kind still `auma:voice-heard` (nothing else reads that kind, so it was not renamed), a
  notice: "Heard elsewhere: n spoken, m from your other conversations". It is not part of the runtime-context snapshot.
- The notice has three fixed lines. A bracketed heading introduces the entries. A second line tells the reader to treat them as data from other conversations. The closing line tells the reader to continue the current task. The notice also gives counts, a cursor line when applicable, and entries in chronological order with an absolute time for each.
- Limits: at most 8 entries; his spoken words quoted whole up to 400 characters, her fast voice's up to 600, his written
  words up to 160, else a placeholder with the count (never a cut); her last message's last 240 characters cut back to
  a word boundary; the whole at most 4,096 bytes, whole entries dropped oldest first and counted. Each text passes her
  secret-shape filter whole before any count or cut and is quoted as one JSON string (line and paragraph separators
  escaped), so nothing quoted can start a line or open a block.
- Once per conversation: the highest timeline seq already given, stored in
  `/dsh/home/auma/timeline/heard.v1.json` (512 conversations, the lowest seqs dropped first), read once per page life
  and written through the timeline store's queue when her session logs the message. A reload no longer tells the same
  records again; a missing or unparsable file is said in the block ("no cursor; these may have been delivered before.").
- Her voice conversation (a spoken turn, or the home proven and marked) is given no voice exchange, since it already
  receives the page's spoken-since block; it does hear her other conversations. At the open level a TYPED turn in her
  voice conversation is not recognised as hers by any cheap check and may be given exchanges the page also gives it.
  A child agent is origin `subagent` or a delegation depth above 0 (a bare `parentSession` does not make one). A child agent and a step that claimed
  no message of its own get nothing. An unreadable home gives no message and no error.
- Cost per turn: at most the last 256 KiB of each of the four files (timeline and voice, chain and words); the cursor
  file is read once per page life (at most 64 KiB) and written whole (about 100 bytes per conversation) when a block is logged.
- Where: `timelineSince`, `heardText` and `createHeardFeed` in
  `packages/experimental/webworker-runtime/src/storage/memory-timeline.ts`, registered as an `agent/pre-step` listener
  beside `auma:live-state-map` in `ball-loader.ts`; tests in `tests/x6/voice-heard.spec.ts` and `tests/x6/heard-block.spec.ts`. The voice memory's own
  reader `voiceMemorySince` stays in `voice-memory.ts` with its tests; the feed no longer uses it.
- Records are given in time order (a voice pointer may be posted after a later turn). A pointer a failed write or a
  reload left out is written later, so its exchange still reaches the feed.
- Spoken exchanges from before her timeline existed are not pointed at, so they are not given by this feed; they stay
  in her voice memory (`x6_voice_memory`).
- A spoken hand-off is told once: the pointer of a governed exchange (`ended: "handed"`, which holds only what was
  spoken aloud, or `"answered"` after a fast turn fell back) is left out when the read holds the SPOKEN turn (captured
  in this page life) that tells it with her working self's answer (his words as heard, within 15 minutes) and this
  conversation has that turn; otherwise it is told as before. Both records stay in the timeline; `x6_memory` shows both
  and marks a handed pointer `handed: true`.
- Her voice memory's chain and words files travel to the cloud mirror in the session-journal lane at any size (alone,
  at most once a minute, after her other saves), as her timeline's do.

The other direction is built too: her fast voice has the last lines of her three most recent conversations in its
awareness and is told to look at `x6_memory` `timeline` first for "what happened today".
A test fails if the edge's description of `x6_memory` and the worker's tool ever disagree. Her `recall` organ does not search
the voice words yet and cannot see conversation files over 2 MiB; that is her organ, changed only by her proposal.

## Not built

- Deleting words. The format supports erasing a words record and its salt and appending a deletion record.
  Deletion requires separate owner approval. Until then any missing words show as `WORDS_MISSING`.
- Keeping the request bytes for the call receipts: only digests are recorded, so a past request cannot be re-checked.
- An outside witness for the head.
- A receipt of the head in her own ledger at call end (hers to build inside).
- The Pentora frame.
- Her working self's own `write` tool is not barred from the two files; only her voice (fast and look-only) is.
