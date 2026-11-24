# v0.1 ledger wire format

The first byte discriminates the format. The v0.1 tag set is **00, 13 through 1b** (hex). Reserve **ff** for a future versioned envelope. A future format can start with `ff <version>`, which this release always refuses, including `ff 01`. This preserves the bytes and SHA-256 heads of existing records. Select the v0.1 grammar by its tag. The inner tag of an ordinary frame comes **after** its 40-byte header. The tag set does not identify which contract a particular build has pinned.

## Field encodings

All integers below are unsigned and little-endian. `u8`, `u16`, `u32` and `u64` occupy exactly 1, 2, 4 and 8 bytes. `D` is 32 raw digest bytes. `H` is `D parent | u64 sequence`. A new session starts with a zero head and sequence 0. The first submission uses sequence 1. Each accepted frame names the current head and next sequence. The new head is SHA-256 of the entire submitted frame from byte zero through its final byte. A refusal preserves the head and sequence. Lengths count bytes. Fields are consecutive, with no alignment, terminator, implied padding or trailing bytes.

| Symbol | Encoding in wire order |
| --- | --- |
| blob | u16 length, followed by that many bytes |
| text | blob containing UTF-8 scalar values. Empty text is allowed. Invalid scalars, overlong encodings and truncated sequences are refused. |
| bool | 00 for false, 01 for true |
| result | 00 confirmed, 01 failed, 02 unknown |
| intent | body, text audience, u16 generation, u16 nonce |
| body | 00 followed by a blob for delivery, or 01 followed by a D for installation |
| EdKey, EdSig | 32-byte Ed25519 public key, 64-byte signature |
| MLKey, MLSig | 1,952-byte ML-DSA-65 public key, 3,309-byte signature |
| A | One inner action byte and its payload, as listed below |
| F | H followed by A |

The command chooses which of those fields to read. No outer frame length appears in the bytes. One call to `step()` delimits one frame. The staging and stamp calls have their own inputs. [Byte ABI](EXPORTS.md)

## Outer tags and offsets

Offsets count bytes from zero. Ranges include the start and exclude the end. When a row specifies the inner action tag, the inner tag byte is included in the submitted frame.

| Tag (hex) | Ordered fields after tag | Accepted inner actions or meaning |
| --- | --- | --- |
| 00 | H at 1..41, A at 41 | Unsigned ordinary actions 00, 01, 02, 05, 06, 0d, 10 |
| 13 | MLSig at 1..3310, H at 3310..3350, A at 3350 | Hybrid grant 03 or owner controls 09, 0a, 0c, 0e, 0f. A ends with EdSig. |
| 14 | new MLKey at 1..1953, MLSig at 1953..5262, H at 5262..5302, A at 5302 | Rebind 08, signed by both current keys |
| 15 | H at 1..41, D intent hash at 41..73, u8 score at 73, D bundle at 74..106 | Record an assessment |
| 16 | H at 1..41, u8 new threshold at 41, EdSig at 42..106, MLSig at 106..3415 | Set danger threshold |
| 17 | D bundle at 1..33, H at 33..73, A at 73 | Direct act 04 or mandate act 0b. Bundle must equal the effective assessment's bundle. |
| 18 | H at 1..41, u64 inclusive expiry at 41..49, intent at 49, EdSig, MLSig | Issue or renew a grant. Issue sequence must be strictly below expiry. |
| 19 | H at 1..41, D intent hash at 41..73, EdSig at 73..137, MLSig at 137..3446 | Revoke the uniquely matching eligible grant |
| 1a | H at 1..41, A at 41 | Labelled correction, inner action 05, referencing the previously reported intent |
| 1b | H at 1..41, D target at 41..73, u32 m at 73..77, m model bytes, u32 p, p proof bytes, install intent | Checked upgrade. Both lengths are positive, m+p ≤ 1,048,576. The intent must name the staged file's SHA-256. |

Only the listed outer/inner pairings can be admitted. Direct and mandate acts require outer tag 17 even when a credential exists. An initial outcome uses 00. Later outcomes for the same intent require 1a. Tags 07, 11 and 12 in the **inner** action position were historical upgrade encodings and are refused. Other unassigned tags are refused. Assessment uses SHA-256 of the encoded intent. With no assessment, score is 255 and the default bundle is SHA-256 of the text-encoded literal below followed by the raw intent hash.

```text
AUKORA/R8/missing:request-intent-only;evidence=missing;reasoning=missing;witness=missing;versions=missing
```

## Event grammar and hex examples

The accompanying table gives the literal hexadecimal bytes for every event, including the signed controls, installation certificate and a genesis stamp. The signed examples use their recorded session histories. [Complete event hex](vectors/events.hex.tsv)

Every example in the right column expands to a complete exact frame. A space separates adjacent fields. These repeated-byte abbreviations keep large signatures readable. Z means 32 zero bytes, E means 64 zero bytes, K means 1,952 zero bytes, and S means 3,309 zero bytes. H0 is `Z 0100000000000000`. I is the delivery intent `00 0000 0000 0000 0100`. J is the install intent `01 Z 0100 63 0000 0100`. The examples illustrate the grammar. Signatures shown as zeros and references to history may fail admission. For complete **accepted** byte sequences with real signatures and valid histories, use the signed and gate manifests. [Hex extraction](#extract-an-accepted-example)

| Event | Inner action or outer payload, in order | Complete hex example |
| --- | --- | --- |
| Say | 00, text | `00 H0 00 0100 61` |
| Remember | 01, u16 claim ID, u16 source sequence, text | `00 H0 01 0700 0100 0100 61` |
| Correct a claim | 02, u16 old ID, u16 replacement ID, text reason | `00 H0 02 0700 0800 0100 61` |
| Grant | 03, intent, EdSig | `13 S H0 03 I E` |
| Act directly | 04, intent | `17 Z H0 04 I` |
| Report an outcome | 05, intent, result | `00 H0 05 I 00` |
| Advise | 06, text cell, u16 value | `00 H0 06 0100 61 0700` |
| Rebind owner | 08, new EdKey, EdSig | `14 K S H0 08 Z E` |
| Retract recent lines | 09, u16 count, EdSig | `13 S H0 09 0100 E` |
| Create a mandate | 0a, text audience, blob payload, u16 generation, u16 count, u16 inclusive expiry, EdSig | `13 S H0 0a 0100 61 0100 62 0000 0100 0900 E` |
| Act under a mandate | 0b, u16 mandate ID, 04, intent | `17 Z H0 0b 0000 04 I` |
| Grant a budget | 0c, u16 generation, u16 cap, EdSig | `13 S H0 0c 0000 0300 E` |
| Spend budget | 0d, u16 budget ID, u16 amount | `00 H0 0d 0000 0100` |
| Issue a read pass | 0e, text reader, text scope, u16 generation, u16 inclusive expiry, EdSig | `13 S H0 0e 0100 61 0100 62 0000 0900 E` |
| Revoke a read pass | 0f, u16 pass ID, EdSig | `13 S H0 0f 0000 E` |
| Read | 10, u16 pass ID, text reader, text scope, bool reader verified | `00 H0 10 0000 0100 61 0100 62 01` |
| Record danger assessment | Outer 15 fields | `15 H0 Z 7f Z` |
| Set threshold | Outer 16 fields | `16 H0 7f E S` |
| Issue an expiring grant | Outer 18 fields | `18 H0 0900000000000000 I E S` |
| Revoke one grant | Outer 19 fields | `19 H0 Z E S` |
| Correct an outcome | Outer 1a with inner 05 | `1a H0 05 I 01` |
| Submit install package | Outer 1b fields. Single zero bytes here stand in for the model and proof. | `1b H0 Z 01000000 00 01000000 00 J` |
| Submit a sidecar stamp through stamp() | D current head, blob beacon, D receipt, without an event tag | `Z 0100 61 Z` |

Mandate, budget and pass IDs are zero-based positions in the accepted history. The read flag is the host's assertion that the named reader authenticated. Stamp contents are opaque to the ledger. Retracting, correcting, and revoking retain the earlier record bytes.

### Signed messages

Both verifiers receive exactly the same bytes for an owner operation. Ed25519 uses the raw message. The core verifies ML-DSA-65 signatures in the pure-signature format with empty context. Let `keys(old)` denote `blob(old EdKey) | blob(old MLKey)` with length prefixes. Let `domain(role)` mean `text("AUKORA/R7/hybrid/" ++ role) | keys(old)`. Below, `raw` encodes UTF-8 with no length field. All other string literals marked `text` have their u16 length. `gen` is the current owner generation encoded as u64, and the request's H is the exact submitted parent and sequence.

| Operation | Bytes signed, from left to right |
| --- | --- |
| Grant in 13 | domain("grant"), intent |
| Control in 13 | domain("control"), raw("AUKORA/R5/control"), gen, H, inner action tag and control fields through the last payload byte before EdSig |
| Rebind in 14 | domain("rebind"), gen, keys(new) |
| Set threshold in 16 | text("AUKORA/R8/threshold"), keys(old), gen, H, u8 threshold |
| Issue in 18 | text("AUKORA/R9/grant"), keys(old), gen, H, u64 expiry, intent |
| Cancel in 19 | text("AUKORA/R9/revoke"), keys(old), gen, H, D intent hash |

### Certificate and staged file

The model is the literal ASCII `R9M1`, a variable-length count from 1 to 64 and that many triples of name, type expression and value expression. The last definition selects the candidate model. Each fresh name is a proper descendant of `R9Candidate`. The proof is one closed serialized Lean expression. The cursor must consume the entire model and the entire proof. The staged Wasm carries exactly one `aukora.model.sha256` custom section with the 32-byte SHA-256 of the model.

Within expressions, natural numbers use canonical unsigned base-128, low group first, with the continuation bit on each non-final byte. Text uses that encoding for its byte length followed by UTF-8. Lists begin with a variable-length element count. Name tags are 00 anonymous, 01 parent-name and text, 02 parent-name and natural. Universe tags are 00 zero, 01 successor of one level, 02 maximum of two levels, 03 imax of two levels, 04 parameter name. Binders are 00 default, 01 implicit, 02 strict implicit, 03 instance implicit. These fields use the certificate encoding, independently of the ledger's u16-prefixed fields.

| Expression tag | Fields following tag |
| --- | --- |
| 00 | Bound variable index (natural), strictly below the binder depth |
| 01 | Universe level |
| 02 | Constant name, list of universe levels |
| 03 | Function expression, argument expression |
| 04 / 05 | Lambda / forall. Binder byte, name, domain expression, body expression under binder |
| 06 | Let. Boolean non-dependent flag, name, type expression, value expression, body under binder |
| 07 / 08 | Natural literal / UTF-8 string literal |
| 09 | Projection. Structure name, natural field index, structure expression |

The recursive readers cap the nesting fuel at 256 and the remaining byte count. The checker type-checks each definition before adding it to the invocation's private environment. It constructs its own target by applying the pinned contract to the last declaration. [Certificate parser](KernelCell.lean) · [Model carrier](Checker.lean) · [Wasm section framing](ModelSection.lean)

### Extract an accepted example

From the lab directory, the following commands print complete lowercase hex with real headers and signatures. Use any accepted label in the signed or gate manifest.

```sh
python3 v0.1/tools/frame-hex.py signed signed-rebind
python3 v0.1/tools/frame-hex.py gate gate-install
```

[Signed session manifest](vectors/signed.tsv) · [Install session manifest](vectors/gate.tsv) · [Conformance replay instructions](vectors/README.md)
