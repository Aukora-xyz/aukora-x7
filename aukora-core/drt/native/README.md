# The native twin

The small core is normally built as 32-bit WebAssembly, linked against a WASI port of the Lean runtime made for this
project. The native twin takes the SAME C that the Lean compiler emitted for it (`reachable.c`, from the build's work
folder) and the SAME shim (`Interface.c`), and compiles them for the host CPU (64-bit arm64) against Lean's own
official runtime. Then both are given the same inputs and every output line is compared.

Different word size, different C target, different runtime, different allocator: a fault in the WebAssembly
toolchain, in the runtime port, or anything that depends on the width of a machine word would show up as a
differing line. What is still shared, and so not tested here: the Lean compiler's front end and the C it emits.

    sh drt/native/build-native.sh <a v0.10 build folder whose .work was kept> <toolchain folder> native-lite
    node drt/drt.mjs --steps 3000 --seed 21 --emit run v0.10/aukora-core-lite.wasm v0.10/aukora-core.wasm
    ./native-lite < run.in > run.got && cmp run.expected run.got && echo "native = WebAssembly on every line"

A normal build removes its work folder; to keep it, run the build from a staged copy whose `tools/build.py` skips the
final clean. The native binary is not in this tree (it is specific to one machine); the result of comparing it is.
Built and run on one Apple-silicon Mac, Lean 4.19.0's `libleanshared`. Linux untried.
