# ARK: a receipt contract you can check yourself (DRAFT)

ARK is a small contract for one question: **did the owner approve exactly this action, and did the service that acted
sign what it did?** A client proposes an action, the owner signs an approval of those exact bytes, a receiver (the
service that performs the act) refuses or acts and signs the outcome, and anyone holding the owner's and the
receiver's public keys can check the whole bundle offline.

Status: **DRAFT v0.1.3, not frozen** (`CONTRACT.md`, first lines). Not used by the rest of this repository yet: nothing
outside `ark/` imports it. The keys in `vectors/` and in the tests are synthetic TEST keys made by the tools.

## What is here

| Path | What |
|---|---|
| `CONTRACT.md` | The contract: wire format, signatures (DSSE-style pre-authentication encoding, Ed25519), receiver rules, offline verifier rules, commands. |
| `vectors/` | The vector inputs (26 vector bundles, pins, and the demo effect file) and their expected verdicts, `vectors/expected-verdicts.json`. |
| `a/` | Reader 1 (Node): the receiver, a stand-in owner tool, client A, a self-check, and self-tests. Its author also wrote the contract and the vectors. |
| `b/` | Reader 2 (Go 1.26.5 or newer, standard library only): an offline verifier, client B and the vector checker, written from the contract and the vectors without reading reader 1's source; what else its author read is in `INDEPENDENCE.md`. |
| `c/` | Reader 3 (Swift, CryptoKit; its runner needs Python 3): an offline verifier. `c/NOTES.md` records reader 3's interpretations of the contract and its runs; nobody audited what its author read. |
| `accept/run.sh` | The acceptance run, written by reader 2's author: 20 checks that drive reader 1's tools and reader 2's tools as black boxes in fresh test worlds under `run/`. Its last line begins `accept: 20 PASS, 0 FAIL` (a note of the run's paths follows). |
| `CONTRACT-ISSUES.md`, `CONTRACT-DECISIONS.md` | Reader 2's gaps (`CONTRACT-ISSUES.md`) and reader 3's (`c/NOTES.md`), and how each was decided. |
| `MUTATION-TEST.md` | Which deliberate faults in the receiver the acceptance run catches. Two survived at first, M1 and M9 (checks 16 and 20 were then added and catch them); M5 was never run, and no client, verifier or Go-tool mutation was tried. |
| `INDEPENDENCE.md`, `INDEPENDENCE-AUDIT.md` | What reader 2's author read and ran, and an audit of that session's own record. |
| `MANIFEST.sha256` | The sha256 of every other file in this folder as published. |

## Who wrote the readers (plainly)

These are three separately written readers, not three independent ones. All three are machine-written, by AI coding
models. Readers 1 and 2 come from models of the same family; reader 3 from a model of another family. Reader 1's author
also wrote the contract and the vectors, and both were revised after the other readers' questions (contract v0.1.1 to
v0.1.3; the vectors grew from 23 to 26), so the vectors are not independent of reader 1. Reader 2 was written without
reading reader 1's source, but its author also read reader 1's hand-off note and part of a private design review, and
ran reader 1's tools as black boxes (`INDEPENDENCE.md`; `INDEPENDENCE-AUDIT.md` audits that session's own record;
the audit's evidence, the session's transcript, is private and not published here).
Reader 3's notes say no reference implementation was consulted (`c/NOTES.md`); reader 3 was not audited. No
cryptographer has reviewed the contract.

Runs, all by the authors on one machine: the acceptance, 20 PASS, 0 FAIL; reader 1, 15 of 15 self-tests; reader 2,
`vectors matched: 26 of 26`. Reader 3: 26 of 26 vectors matched at v0.1.3 (run by the authors on their machine, at
v0.1.3 and again on this tree); `c/NOTES.md` holds the earlier 25 of 25 at v0.1.2.

## Run it (from this folder; no network)

```sh
(cd a && node --test --test-concurrency=1 test/*.test.mjs)   # reader 1 self-tests (Node 22 or newer)
./b/run-vectors.sh                     # reader 2 against every vector (Go 1.26.5 or newer; GO=<path> to choose one)
(cd c && mkdir -p .build/tmp .build/module-cache && TMPDIR="$PWD/.build/tmp" CLANG_MODULE_CACHE_PATH="$PWD/.build/module-cache" \
  swiftc -Osize -whole-module-optimization -module-cache-path "$PWD/.build/module-cache" \
  StrictJSON.swift Schema.swift Verifier.swift Operations.swift main.swift -o ./verifier && ./run-vectors.sh)   # reader 3 (macOS Swift, Python 3)
./accept/run.sh                        # the 20 acceptance checks (Node, Go, shasum)
```

Their test worlds and build outputs go inside this folder (`run/`, `b/bin`, `b/.gocache`, `c/verifier`, `c/.build`);
the Go compiler may also use the system's temporary directory. Delete those after.
