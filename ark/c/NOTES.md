# Independent verifier notes

## Reproduce the check

From this folder on the Mac, run the following commands. The verifier uses Apple CryptoKit for Ed25519 and SHA-256. The vector runner uses the Python 3 standard library.

```sh
mkdir -p .build/tmp .build/module-cache
TMPDIR="$PWD/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
  swiftc -Osize -whole-module-optimization -module-cache-path "$PWD/.build/module-cache" \
  StrictJSON.swift Schema.swift Verifier.swift Operations.swift main.swift -o ./verifier
./verifier ../vectors/done.bundle.json ../vectors/pins.json
./run-vectors.sh
```

## Revision v0.1.3

C7 rejects every boolean in a decoded payload as `BAD_JSON` at E4. Only a direct `null` in `outcome.approval` or `outcome.effect` is allowed. I had chosen the other reading in v0.1.2, so a boolean directly in either field reached E5 and produced `BAD_SCHEMA`.

## Revision v0.1.2

**Changed.** Both headers now use C22’s exact escapes. LF, CR and tab print as `\n`, `\r` and `\t`. The other C0 controls and DEL print as lowercase `\u00xx`. Every other scalar prints as supplied. The runner now checks the manifest’s exact `stdout` wherever present, alongside the structured verdicts and exit code.

**Contract reading.** C21 confirms the existing shape checks. A boolean item or envelope member yields indexed `BAD_ENVELOPE`, a boolean bundle field yields `BAD_BUNDLE`, and a boolean pins field yields exit 2. For decoded payloads, I applied C7’s positional exception to all three literals it names. A boolean directly in `outcome.approval` or `outcome.effect` reaches `BAD_SCHEMA`. A boolean anywhere else yields `BAD_JSON`.

**Ran.** Rebuilt with `swiftc` and ran `./run-vectors.sh`. **25/25 matched**, including both new cases and their exact stdout. Separate CLI checks exercised both boolean values, all 33 escaped code points in both headers, and each header’s UTF-8 byte limit. Every supplied expectation was reproduced.

## Original 23-case run

**Read.** The implementation source of truth was `CONTRACT.md` (a byte-identical copy, then in `input/`, now `../CONTRACT.md`). The runner uses section 11 and the supplied manifest as its oracle. The checker itself reads only the two files passed on the command line. No reference implementation or receiver was consulted.

**Ran.** Apple Swift 6.2.1 compiled the executable for arm64 macOS. All **23 of 23 supplied bundle/pins cases matched**, with **0 differences**. The comparison includes the exact UTF-8 output, final newline, sorted operations, index, reason and process exit. All supplied JSON sample files are accounted for in the manifest. With a scratch copy of one expected exit deliberately changed, the runner reported one DIFFER and exited 1. A separate SHA-256 of `done.demo.txt` matched the signed DONE outcome’s `effect.after_sha256` (`a79f786d4a6a8a77099c594d997eeaa1a112fd90899b1bfcae91b0ce0d7163a0`).

**Ran beyond the supplied vectors.** The executable matched 59 synthetic JSON, encoding and size-boundary cases, 34 trust, pins and invocation cases, and 35 operation cases using locally generated signatures. These 128 checks exercised first-failure order, both sides of the eight-level and 65,536-byte limits, D1–D14, repeated records, and reordered, whitespace-rich UTF-8 payloads. The signed operation cases included identical proposal bytes signed by different clients in both envelope orders. These expected results reflect the readings below. Only the 23 supplied expectations come from the independent manifest.

## Questions and readings from the original run

1. **§8, invocation and errors.** The text names the two inputs in order. It could describe positional arguments or named flags. This build accepts `./verifier BUNDLE PINS`. For usage, unreadable input or invalid pins, §8 specifies exit 2 and §6 says bad pins produce no verdict. Diagnostics go to stderr and stdout stays empty. Bad pins take precedence when both files are bad.

2. **§§6 and 8, header text.** The grammar could require a literal copy of the decoded text or require each header to fit on one physical line. Both fields admit CR and LF by their stated byte limits. The checker displays CR as `\r` and LF as `\n` in those two values. Other characters are printed as supplied. The draft should specify escaping, or constrain the input fields. The “one plain sentence” description is not a checkable sentence grammar and the emitter’s own example has two sentences. The checker enforces the stated byte lengths.

3. **§§6 and 8, malformed bundle output.** Section 6 could imply that only `BUNDLE INVALID BAD_BUNDLE` is printed. Section 8 explicitly omits only coverage. The checker still prints the pins attribution and integrity line, then the bundle verdict. An unreadable file takes the I/O exit.

4. **§3 rules 2, 3 and 8, JSON boundaries.** “Trailing bytes” could include trailing whitespace. The reference to RFC 8259 supports allowing space, tab, CR and LF before and after the object. Depth could start at zero or one, and the depth sentence follows the payload size limit. Here the root object is level one, every nested object or array adds one, and scalars add none. The depth limit applies to unsigned documents as well as each separately decoded payload. Only the payload has the 65,536-byte limit. For duplicate names, equality is by decoded scalar sequence, without Unicode normalization. Thus a JSON escape and its literal spelling compare equal, while two distinct scalar sequences that render alike remain distinct names.

5. **§§2, 3, 6 and 8.1, which layer owns the error.** A malformed embedded envelope could be treated as a malformed enclosing file. This checker assigns syntax errors and duplicate names anywhere in the outer byte stream to `BAD_BUNDLE`. Validly parsed envelopes with wrong fields, wrong types, or non-object item values get indexed `BAD_ENVELOPE` under E1. In particular it treats a boolean or null in an envelope slot as a shape failure. A competing reading sends these literals straight to `BAD_BUNDLE` under unsigned-file rule 6. In *decoded payloads*, §8.1 explicitly assigns rules 1–6 to E4. Any boolean or forbidden null gives `BAD_JSON` before field-set checks, including in unknown fields. Only an outcome’s immediate `approval` and `effect` fields allow null. Other unknown or mistyped payload fields reach E5 and give `BAD_SCHEMA`.

6. **§§3–4, field order and outcome schema.** “Starts with” could require `v` and `type` to be the first two members. The explicit order-independence rule allows both anywhere. “OK when DONE” could also reserve `OK` exclusively for DONE. This checker enforces that implication in the stated direction. A DONE with another reason fails E5. A REFUSED reason may be any matching `code`. The relationship between status and effect is checked at O4, where the draft gives the specific verdict `INVALID BAD_OUTCOME`.

7. **§§4 and 8.1, signer trust.** “No key is ever taken from the bundle” could exclude client keys too. S2 expressly resolves them from grants that passed S1. Pin the root keys externally and introduce a client key only from a schema-valid, owner-signed grant. Scope, expiry, receiver and the grant’s declared owner are operation checks. They do not gate S2. A client key can equal a pin under §6. A combined-role reading would allow that pin to sign proposals. This checker applies the pinned role first under S1 and treats a disallowed type as `WRONG_SIGNER`, with no second role attempt.

8. **§§4 and 8.1, notes.** “Never lets a note change a verdict” could mean skipping notes altogether. The checker applies E1–E5 to every note and S1/S2 to every known signer. A malformed note or a bad signature from a known key can therefore invalidate the bundle. S3 admits a well-formed note with an unresolved signer. Its claims, including references to missing items, do not enter operation checks.

9. **§§6 and 8.2, duplicates with different signatures.** Item identity uses payload hash and type, while D10 asks for the proposal envelope’s key ID. Two authenticated clients can sign exactly the same proposal bytes. Choosing the first signature makes the verdict depend on bundle order. Requiring every signature to match gives a different result again. This checker counts one proposal, retains every verified signer ID, and satisfies D10 if the grant’s client signed those bytes. A malformed or invalid duplicate still fails its own §8.1 item checks before de-duplication.

10. **§§4–5, 7 and 8.2, receiver checks in an offline verdict.** One reading replays all receiver rules or verifies the effect file. The other follows O1–O5 and D1–D14 as an exhaustive ordered list. This checker follows the list. REFUSED stops at O5. DONE checks the effect resource at D14 and the syntax of both digests. It does not require the effect file or independently enforce the receiver’s sole executable action. Expiration uses the signed decision time, including equality at the deadline. Section 4 describes a predecessor chain, including a zero predecessor at sequence one. Section 8.2 disclaims verdict use of that chain. The checker enforces the field types, ranges and hash spelling, without a sequence-one zero check or predecessor lookup.

11. **§§7 and 8.2 D13, authority snapshots.** A receiver uses its current authority. A bundle can contain a later epoch or two distinct authorities for one epoch. Choosing the latest snapshot or rejecting conflicting snapshots would add an offline rule. D13 asks whether *any* owner- and receiver-matching authority at the outcome’s epoch lists the grant. The checker uses that existential test.

12. **§8, an OK bundle with no operations.** The exit table has no explicit empty case. An archive containing only a grant, authority, approval or note has no proposal/outcome IDs to print. “Every op DONE or REFUSED” holds for an empty set, so the checker prints `BUNDLE OK`, no OP lines and exits 0.

The draft’s preamble requests an issues file outside the working folder. All findings for this independent build are recorded here as requested. No expected verdict required a sample-specific exception.
