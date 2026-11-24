# The model itself as an executor

The laws are proved about Lean definitions. `Driver.lean` runs THOSE definitions (the public step, feed, reset and
stamp, the segment functions, the bound genesis) under Lean's interpreter, so on this side there is no compiled C,
no C compiler, no WebAssembly and no runtime port at all. Around them it restates in Lean the bookkeeping that the
small core's C shim keeps (segment limits, recovery reserve, sealed state, record identifier, journal). It reads the
same input stream as the native twin and prints the same line per input.

    node drt/drt.mjs --steps 3000 --seed 21 --emit run v0.10/aukora-core-lite.wasm v0.10/aukora-core.wasm
    LEAN_PATH=<built v0.10 library> lean --run drt/model/Driver.lean <law identity file> < run.in > run.model
    cmp run.expected run.model && echo "the Lean model = the WebAssembly core on every line"

This compares what was proved with what runs. It is a test, not a proof: the interpreter and the compiler share Lean's front end and intermediate code, and the shim's
restatement here is ours, so a fault present in both would not show. The C shim's limits are compared, not proved.

The law identity file is the 32-byte identity the small core reports (`lawByte`); a v0.10 build writes it to
`.work/package/root.id`. CONTROL: give the driver any other 32 bytes and every line must differ.

## A stream anyone can check without Lean
`drt/fixtures/model-checked-1.in.gz` holds 1,025 generated inputs (throw-away keys; public keys and signatures only)
and `model-checked-1.expected.gz` the outputs the interpreted Lean model gave for them, which the WebAssembly small
core matched line for line when they were made. `node drt/drt.mjs --check drt/fixtures/model-checked-1 <core.wasm>`
replays the stream in any core file and compares every line, so your copy of the core can be checked against the
model's own outputs with Node alone. `run-all.sh` does this for both v0.10 files, and checks that v0.9 does NOT
reproduce it (its law identity differs, so its bound records do).
