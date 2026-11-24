> **Historical page** (written for v0.5). Start from [README.md](README.md) and [docs/WHERE-THINGS-ARE.md](docs/WHERE-THINGS-ARE.md).

# Aukora Core v0.5 (a lab release)

A small core for an AI agent's record and its owner's approvals. The rules are one pure function written in
Lean 4. Laws about that function are proved in Lean. The same text is compiled to WebAssembly, and the core
checks proofs inside WebAssembly before it accepts a change to its own law set.

This is research code. It is a witness of what happened and what the owner approved. **It is not a lock:** nothing
outside it is forced to obey it yet. Read the limits before anything else.

## What is in this folder
- `core/`: the Lean sources, the two compiled files and their SHA-256 pins, the wire format, the test vectors,
  [what is proved](core/PROVED.md) and [what is not proved](core/NOT-PROVED.md).
- `standalone/`: a plain Node adapter, a command-line tool and an MCP server that run the small core file, with no
  dependencies. `node standalone/test.mjs` runs 34 end-to-end checks.

## What is checked
- One proposition with 37 named laws, proved for one machine and accepted by the Lean 4.19.0 kernel
  ([core/PROVED.md](core/PROVED.md)).
- `core/aukora-core.wasm` (7,331,989 bytes, SHA-256 `138170cca2e079d3b8cc72fa89fc42f396c7b3cad00371c3928a7809ba52817d`)
  and `core/aukora-core-lite.wasm` (666,064 bytes, SHA-256 `8e7cca361db0ef321450e5f5fc70c807957c9e1095314fd533bdd4806abaa311`)
  were reproduced byte-identically in repeated from-scratch builds on one machine, including a full passing run
  by an independent reviewer.
- The owner signs with two keys at once, Ed25519 and ML-DSA-65.

## The limits (each one is spelled out in [core/NOT-PROVED.md](core/NOT-PROVED.md))
- **The proofs are about the Lean model, not the compiled bytes.** Matching vectors and identical rebuilds are
  evidence, not a proof that the Wasm behaves as the model. (item 1)
- **An approval is not tied to one record, and this law set makes that permanent.** A plain approval, and the old
  key-change form, work on any record with the same owner keys; one of the 37 laws forces every lawful successor
  to keep admitting them. The cure is a restated law set. An owner who never signs those two forms is not
  exposed; the core does not enforce that. (item 7)
- **Upgrades through the gate can change law data only,** not the machine. (item 3)
- **A record has an end of life.** A record's whole chain is limited by memory (about 100 MiB of lines in the
  small file, as measured). At the limit the core stops with a crash rather than a refusal, and nothing more can
  be added, not even a seal. (item 20)
- **No outside witness is built in.** The newest lines of a record can be dropped and it still replays. The
  adapter can produce checkpoints for an outside keeper (see `standalone/README.md`); nobody keeps them for you.
  (items 8 and 9)
- **Raw key files, not a passkey. Cryptography is tested, not proved.** (items 5 and 6)
- **Rebuilt on one Mac only.** The build needs pinned macOS tools and input files that are not in this folder, so
  you cannot rebuild it from this folder alone yet. The compiled files and their pins are included. (item 18)
- **Old fixtures.** The compatibility list in `core/Compatibility/ListGate.lean` recognises two earlier lab cores
  by fingerprint. Neither is in this folder. One of them was a fixture whose owner is a published test key
  (RFC 8032, test 2). Never run such a core as a real one.
- **Nothing here runs in a live system.** No claim of novelty is made. (item 21)

## Try it
```sh
node standalone/test.mjs
```
Needs Node 24 or newer. It loads `standalone/aukora-core-lite.wasm`, refuses any file whose SHA-256 is not pinned,
and prints the core's fingerprint.
