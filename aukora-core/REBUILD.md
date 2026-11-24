> **Historical page** (the rebuild of an early core, Core5). Start from [README.md](README.md) and [docs/WHERE-THINGS-ARE.md](docs/WHERE-THINGS-ARE.md).

# Rebuild Core5

Run `./rebuild.sh` from this folder on Apple silicon macOS. The command prints `PASS SHA-256` and the measured digest after checking the Lean sources, matching the pinned Wasm digest, and passing the Node tests. A failure returns a nonzero status, prints `FAIL` with the digest if available, and preserves the build directory named in the output.

The pinned module is 355,910 bytes with SHA-256 `d74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a`.

Use the lab sources, the supplied `toolchain/lean-4.19.0-darwin_aarch64/` and `toolchain/wasi-sdk-25.0-arm64-macos/` folders, plus local Python 3, Node and standard macOS command-line utilities. Each run starts in a new directory under `logs/`, checks and compiles the imported Lean modules, checks the proof and test modules, extracts the compiler-generated definitions for the live exports, compiles eight C++ runtime units from source, links the Wasm, and makes its WebAssembly memory private. Each Lean process and the Node test run have a watchdog under five minutes. The script publishes `core/Core5.wasm` only after the pin and tests pass.

The Lean binary distribution omits the C++ runtime sources and the bootstrapped Init C used by this target. The source bundle in `spike/r5/vendor/` contains unchanged members from the lab's upstream Lean 4.19.0 archive, including its licenses, the eight C++ units and their local headers, and the upstream Init C files needed by the exported functions and their initializer order. The original archive's SHA-256 is `26afde96ddf0632c68732943f2b6a0d84c1cd0790292fd464c25054b3d877853`. The script verifies the bundled subset's own hash before extraction. The full upstream archive, earlier round binaries, and previous build directories can all be absent.
