"""Inventory inputs to the round-nine proof, wire parser, Wasm build and tests."""
from pathlib import Path

def show(group, paths):
    print("\n" + group)
    for p in map(Path, paths):
        print(f"{len(p.read_bytes().splitlines()):5}  {p}")

base = "Core Core2 Sha256 Events4 Wire4 Bound4 Sha512 Ed25519 Wire5 Bound5 Stateful5 Upgrade6 Hybrid7 Shake7 Mldsa8 Risk8 Core8"
runtime = "Checker9 ModelSection9 Upgrade9 Policy9 Core9"
laws = "Advice7 Kira5 Laws7 Wire4Proofs Laws9 Tag9 Goal9 Candidate9 Policy9Laws Policy9Replay Core9PolicyLaws OnlyGate9 GrantOrigin9"
def lean_files(words):
    return [f"core/{name}.lean" for name in words.split()]

print("Lines of local hand-written source. Executable reachability is determined by the Wasm link.")
show("State machine, wire contract, concrete cryptography and dynamic checker", lean_files(base + " " + runtime) +
     ["spike/r6/KernelCell.lean"])
show("Proof contract and kernel-checked support", lean_files(laws))
show("Historical imported source (its digest list is excluded from the linked gate)", lean_files("Upgrade7"))
show("Wasm ABI, compiled environment and extraction", """spike/r9/core-interface.c spike/r9/pinned-context.c
spike/r9/embed.py spike/r9/core-roots.txt spike/r9/core-exports.txt spike/r9/build-wasm.py
spike/r6/route1-sources.py spike/r6/import-audit.py spike/r6/bootstrap-route1.py spike/r6/runtime.sh
spike/r6/kernel-platform.cpp spike/r6/kernel-roots.txt spike/r6/reachable.py spike/r4/shim.c
spike/runtime-r3/shim.c spike/runtime-r2/include/lean/config.h spike/r3/private-exports.py""".split())
show("Model export and lab candidate construction", """spike/r9/ExportCandidate.lean spike/r6/ExportTerm.lean
spike/r7/ExportLaws.lean spike/r9/candidate.py""".split())
show("Reproduction and independent host observations", """spike/r9/run.sh spike/r9/serial.py spike/r9/module.sh
spike/r3/watch.py spike/r9/prepare.sh spike/r9/certificates.sh spike/r9/CheckCandidate.lean
spike/r9/test-host.mjs spike/r9/gate.mjs spike/r9/policy.mjs spike/r9/regression.py spike/r8/risk.mjs
spike/r8/stamp.mjs spike/r9/differential.sh spike/r9/Differential.lean spike/r9/vector-signatures.mjs
spike/r9/replay-vectors.mjs spike/r9/inventory.py""".split())

print("""
Pinned binary inputs and upstream dependencies
  logs/r7/laws.env is the checker's private basis. logs/r7/laws.env.tsv names each declaration.
  The gate trusts that pinned environment, including 459 earlier theorem statements and 19 opaque
  declarations represented by their types. Classical.choice is an axiom. Candidate inputs cannot extend it
  with axioms. The native proof checker and the in-Wasm Lean4Lean checker have distinct evidence.
  core/Core6.wasm is the checked-hash base of the example candidate, with its original R6 policy.
  logs/r8/trusted-lines.txt gives the individual Lean4Lean, Batteries, Lean 4.19.0 runtime source
  units, transitive headers, and import closure reused with their line counts. logs/r7/trusted-lines.txt
  gives earlier certification provenance. Archive hashes are verified in spike/r9/prepare.sh.
  The bundled host Lean 4.19.0 and WASI SDK 25, C/C++ runtime/adapters, compiler, linker, Node/V8,
  operating system, and implementations of hashes and signature verification remain trusted.
  OpenSSL signing and public fixtures exercise the ABI. They provide test inputs and do not enter the gate.
  spike/r9/inputs.sha256 pins source and public test inputs. spike/r9/pins.sha256 pins generated outputs.
""".strip())
