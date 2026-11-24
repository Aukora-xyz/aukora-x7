# Aukora Core v0.8 (research code from a lab)

A small core for an AI agent's record and its owner's approvals. The rules are one pure function written in
Lean 4. Laws about that function are proved in Lean. The same text is compiled to WebAssembly, and the core
checks proofs inside WebAssembly before it accepts a change to its own law set.

What it does: it replays what was recorded and shows which approvals the core admitted. What a host asserts to it,
what a host leaves out, and whether any real effect happened are not established by it. **It is not a lock:**
nothing outside it is forced to obey it. The proof checking happens in the full file only, and it gates changes of
law data, not replacement of the executable. Two defects are open and are stated here, not hidden:

- **Two old command forms name no record.** They are the plain one-time approval and the old key change. For the
  approval this was exercised on these exact bytes: one approval signature was admitted and acted on in two
  different records of one owner. The old key change signs no record either; that run was not made for it. Use
  the timed approval and the newer key change, which sign the record's head.
- **A record has an end, and the end is a crash.** In one measurement on an EARLIER small core, with lines of 3,000
  bytes, a trap came instead of a refusal after about 35,000 lines. It was not re-measured on these bytes, and
  that figure is one run, not a capacity.

Everything else we know to be unproved or untested is in [v0.8/NOT-PROVED.md](v0.8/NOT-PROVED.md). Read it first.

More limits, in one line each: the proofs are about the Lean text, not the compiled bytes; it was built on one
Apple-silicon Mac and Linux is untried; keys are raw files, not a passkey; nothing in any live system is governed
by it. A later release may re-pin Lean4Lean to a newer commit; that is a new build with new digests.

## Try it in two minutes (Node 24 or newer, nothing to install)
```sh
node standalone/test.mjs                              # 34 end-to-end checks
node examples/read-record.mjs examples/sample-record.txt
```
The first runs on `standalone/aukora-core-lite.wasm`, a copy of the shipped small core (SHA-256 `2f10eb8f…0b59e9`),
and refuses to load any core file whose SHA-256 is not in its pin list. The second replays a sample record of five
frames in the same core and prints its head and the identity of the law set the core was built with. One mutation
we ran: change one hex character in line 4 of the sample file and run it again; the core refuses frame 2. Not
every change is caught where it is made: see `v0.8/NOT-PROVED.md`, item 8.

## What is checked
- One proposition with 44 named laws, proved for one machine and accepted by the Lean 4.19.0 kernel
  ([v0.8/PROVED.md](v0.8/PROVED.md)). Every statement is about the Lean model.
- `v0.8/aukora-core.wasm` (7,554,007 bytes, SHA-256
  `d0d3bfe5f9111419ff4fc98dfc3dc894252d106efe630e0dfce5a2ba4bddf84b`), which carries the proof checker, and
  `v0.8/aukora-core-lite.wasm` (679,046 bytes, SHA-256
  `2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9`), which does not. Two independent
  from-scratch builds on the SAME Apple-silicon Mac produced these exact bytes. Whether the procedure below works
  from an empty folder is a separate question: see "Rebuild from source".
- Neither file declares any WebAssembly import. That is the whole claim: it says nothing about what a host does
  with the answers, and nothing about traps.
- The owner signs with two keys at once, Ed25519 and ML-DSA-65.

## Verify the shipped files without rebuilding (seconds)
```sh
echo "d0d3bfe5f9111419ff4fc98dfc3dc894252d106efe630e0dfce5a2ba4bddf84b  v0.8/aukora-core.wasm" | shasum -a 256 -c -
echo "2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9  v0.8/aukora-core-lite.wasm" | shasum -a 256 -c -
```
Each command prints `OK` and exits 0 only if the file matches. (`v0.8/PINS.sha256` lists these two and the build's
other outputs, which exist only after a rebuild.)

## Rebuild from source (about 15 minutes, Apple-silicon macOS only)
The build pins two toolchains by the SHA-256 of every file in them. They are not in this tree (about 650 MB).
```sh
sh release-tools/fetch-toolchain.sh toolchain          # downloads Lean 4.19.0 and WASI SDK 25 for macOS ARM64
python3 release-tools/build-tree.py v0.8 ../core-build --toolchain toolchain
sh ../core-build/v0.8/build.sh                         # ends with: PASS v0.8
```
`build-tree.py` refuses a toolchain that does not match the pins, copies the sources and the build inputs into a
fresh folder, and the build checks its own outputs against `v0.8/PINS.sha256`. The folders `spike/`, `logs/`,
`core/`, `v0.1/` and `toolchain/downloads/` hold the build's inputs at the paths the build expects; their names
are lab history, not structure. Needs Python 3, Node 24 and the Xcode command-line tools. Peak memory about
1.4 GB. **Linux is untried.** STATUS OF THIS PROCEDURE: an isolated build staged by `build-tree.py`
from these sources and inputs has passed on the authors' Mac, with toolchain folders already on that machine
(checked against the pins). The download step (`fetch-toolchain.sh`) and a run from an empty folder have NOT yet
been exercised.

## What is in this tree
- `v0.8/`: the Lean sources, the two compiled files and their pins, the wire format (`WIRE.md`), test vectors,
  tests, what is proved and what is not.
- `standalone/`: a plain Node adapter, a command-line tool and an MCP server over the small core. No dependencies.
- `examples/`: a sample record made with throw-away keys (it holds public keys and signatures only) and a
  ten-line reader.
- `release-tools/`: the isolated-build tool and the toolchain pins.
- `RELEASE.json`: the declared facts of this release in one place (law count, law identity, file digests, the
  sample record's expected head).
- Build inputs, as described above. The three archives under `logs/r6/downloads/` and `toolchain/downloads/` are
  unmodified upstream sources under Apache-2.0; see `NOTICE`.

## Keys
No live or private owner signing material is included. Tests make throw-away keys as they run and keep none. The
sample record and the two `keys.bin` fixtures hold PUBLIC keys only. The compatibility list in `v0.8/Compatibility/ListGate.lean` recognises two earlier lab cores by fingerprint; one of
them was a fixture whose owner is a published test key (RFC 8032, test 2). Never run such a core as a real one.

## Licence
AGPL-3.0-or-later ([LICENSE](LICENSE)) applies to the files in this tree written by the Aukora authors. The three
third-party source archives keep their own terms; they, their versions and their licences are listed in
[NOTICE](NOTICE), and the Apache License 2.0 text is in `LICENSES/`.
