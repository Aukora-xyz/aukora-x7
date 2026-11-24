# v0.5 (the same machine and Wasm bytes as lab v0.4): ledger wire format

The unprefixed tags and `ff 02` retain their field encodings. The `ff 03` dialect carries cell receipts and assessments that can cite their output. Integers in fixed-width numeric fields use little-endian byte order. Each accepted frame retains its original bytes. The ledger head is SHA-256 of the latest accepted frame, which names its parent. Stamps use a separate sidecar. [Inherited binary formats and worked examples](../v0.2/WIRE.md) · [Finite session ABI](EXPORTS.md)

## Installation

Tag `1b` (hex) carries the 32-byte parent, 8-byte next sequence, 32-byte staged file digest, a u32-length-prefixed model, a u32-length-prefixed proof, and the encoded owner intent. Model and proof must both be nonempty. Together they may occupy at most 1 MiB. The package parser consumes the entire frame.

### Round 12 owner intent for one package

The body of the signed install intent remains tag 01 followed by the 32 raw bytes of SHA-256 of the complete staged file. Its audience must equal `core/r12/` followed by 64 lowercase ASCII hex digits. Those digits encode SHA-256 of the following consecutive bytes.

```text
ASCII("AUKORA/R12/package") || u32le(model length) || model || u32le(proof length) || proof
```

There is no terminator after the domain and no hidden delimiter. The existing UTF-8 text field adds its usual u16le byte count to the audience. Both owner signatures cover that field. Reason 10 means the decoded package's audience differs from this computed value. The gate runs this check before type-checking the certificate. The frame carries one fixed-width length per blob. The ledger still requires the current parent and next sequence, spends the exact grant and retains the complete frame. Subject to SHA-256 collision resistance, the file and certificate bytes are fixed by that grant. Historical unbound install frames fail this comparison. [Encoding and gate](Ratchet11.lean) · [Full-step statement](Proofs/FullSuccession.lean)

### Judge and law identity

The full adapter compares the staged file with the entire stripped outgoing executable. The embedded descriptor records its prefix length, the byte offset of its 40-byte pin, and the SHA-256 of that prefix computed with the pin zeroed. The candidate must carry the same 40 bytes at that offset. The adapter then recomputes the normalized prefix hash from the staged bytes and permits only length-framed custom sections after it. The existing gate checks for exactly one `aukora.model.sha256` commitment. The host validates and instantiates the selected file and restores its ledger. The prefix comparison checks section lengths and name bounds. The engine validates the complete module, including UTF-8 section names. Fixing the entire executable covers code, exports and the actual data used to initialize the judge. Additional carried predicates travel as metadata. The executable continues to call its compiled transition. The gate proves no equivalence between a submitted model and that compiled behavior, and this policy fixes the available compiled handlers. Replacing checker code or declaration-environment bytes requires a new root. [Comparator](tools/JudgePin.h) · [Post-link pin](tools/seal-judge.py)

The genesis identity is SHA-256 of `R12B/1\n` in UTF-8, the 37 field names each terminated by LF, the 32-byte SHA-256 of the serialized judge environment, and the canonical expression bytes for `Aukora.RootFinal.Lawful`. Later identities use the same manifest and basis with the newly admitted law expression. The first carried declaration, `R9Candidate.claimedLaw`, contains the proposed predicate. The last identifies the machine. Its definitions are type-checked in a fresh extension of the running foundation.

The proof envelope binds the environment hash, parent identity, satisfaction witness and transition witness. The transition proves universal entailment and a commitment to the submitted machine’s installed parser slots. A separate manifest check requires retention of each prior name. After these checks the inner loader checks the package at its carried goal, verifies its staged model commitment, and spends the exact eligible installation grant. Subsequent calls derive the active law from accepted installation bytes. [Goal construction](RatchetChecker.lean) · [Combined contract](RootFinal.lean) · [Install path](Gate.lean)

`installReason()` consumes the pending frame. The outgoing adapter checks executable lineage first. For decoded packages the law checker checks the owner’s package commitment before proof work, then the certificate envelope, pinned identities, derived goals, entailment and satisfaction. Code zero leaves ordinary admission conditions, including the matching unspent grant, to `step()`. `witnessMask()` independently reports the two proof verdicts for diagnostics. [ABI and reason codes](EXPORTS.md)

### Version 3 cell receipts

An unsigned cell event starts with `ff 03 01`, the 32-byte prior head and the
next sequence (u64 little-endian). In order, its payload is the cell name, pin
SHA-256 (32 raw bytes), operation, optional input SHA-256, optional output
SHA-256 and status. Name, operation and status use a u16 little-endian byte
length and 1–64 ASCII letters, digits, dots, underscores or hyphens. Each
optional digest is the byte 00 or the byte 01 followed by 32 bytes. The parser
requires the entire payload to be consumed. The receipt is an unsigned host
statement. Admission records its bytes and preserves authority and threshold.

A version 3 assessment starts with `ff 03 02` and uses the version 2 assessment
layout. Claim kind 04 cites one cell receipt with a present output digest. The
receipt must precede the assessment in the record. Since a cell receipt supplies
no confidence value, that claim permits stated confidence zero. Absence claims
require the version 2 empty-read evidence. The earlier `ff 02` dialect retains
its original four claim kinds. The act uses the unchanged decimal tag 23 (hex 17) and commits to
the assessment bytes by SHA-256.

The journal text renders as `cell <name> <lowercase hex pin> <op> <input hex or none> <output hex or none> <status>`.


## Record seals and continuation

The segment ABI uses raw ASCII for the four domain strings below. Concatenation has no implicit lengths or terminator. Digests occupy 32 bytes. `keys` is the current 32-byte Ed25519 key followed by the current 1,952-byte ML-DSA-65 key.

| Operation | Bytes committed |
| --- | --- |
| First record | The journal starts at SHA-256 of `AUKORA/R12B/first` followed by the initial law digest and keys. The initial public ledger head is 32 zero bytes. |
| Accepted ledger frame or stamp | Replace the journal with SHA-256 of `AUKORA/R12B/entry`, previous journal, one kind byte (00 frame or 01 stamp), and the exact submitted wire. Refusals leave the journal intact. |
| Seal | Concatenate `AUKORA/R12B/seal`, current journal, current law digest, current ledger head, and keys. Both owner keys sign these exact bytes. Append the 64-byte Ed25519 signature and the 3,309-byte ML-DSA-65 signature and submit to `seal()`. The frozen seal head is SHA-256 of this entire signed trailer. |
| Continuation | Submit `AUKORA/R12B/genesis`, frozen seal head, current law digest and keys to `continueRecord()`. The ledger head and journal both become SHA-256 of this descriptor. Global ledger sequence and evidence indices continue. The new segment starts with empty ordinary and recovery counters. |

The host archives the accepted operation sequence, including stamps, signed trailers and continuation descriptors, to reproduce a chain from its original keys. Restoring a history with installs also requires each staged candidate. A fresh instance initialized with keys alone begins a fresh chain. A running instance retains prior history so evidence references, committed grants, revocations, outcomes and law succession continue to resolve. [Segment operations](SegmentFinal.lean) · [Replay vectors](vectors/segments.json.gz)
