# v0.3 lab ledger wire format

The unprefixed tags and `ff 02` retain their field encodings. The new `ff 03` dialect carries cell receipts and assessments that can cite their output. Integers in fixed-width numeric fields use little-endian byte order. Each accepted frame retains its original bytes. The ledger head is SHA-256 of the latest accepted frame, which names its parent. Stamps use a separate sidecar. [Inherited binary formats and worked examples](../v0.2/WIRE.md) · [Finite session ABI](EXPORTS.md)

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

The law identity at genesis is SHA-256 of the UTF-8 manifest `R12/1\n` followed by the 36 names, each followed by a newline, then the 32 environment hash bytes and the serialized expression naming `Aukora.Root12.Contract`. The model’s first declaration is `R9Candidate.claimedLaw`. Persistent predicate expressions must resolve their constant and projection names against the immutable foundation, which gives their recorded bytes the same meaning across packages. Candidate-local definitions can implement the machine. The final declaration denotes the model. The four proof-envelope lets carry the foundation hash, previous law identity, satisfaction witness and transition witness. The gate constructs the transition goal from the submitted model, the proposed law and the recorded law. Its first conjunct requires every model satisfying the proposed law to satisfy the recorded law. Its second requires every such model to preserve the submitted model’s entire grammar table. This carries new parser assignments forward, including their rejection of malformed bodies. The legacy install primitive separately checks its original proof goal. The kernel refuted that goal for the full model. [Goal construction](RatchetChecker.lean) · [Combined contract](Root12.lean)

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
