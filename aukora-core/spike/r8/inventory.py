"""Print local hand-written inputs and the source closure available to the R8 build."""
import contextlib
import io
from pathlib import Path
import runpy
import re

def show(path):
    print(f"{len(path.read_bytes().splitlines()):6}  {path}")

print("LOCAL LEAN SOURCES COMPILED OR USED TO ESTABLISH THE PINNED CANDIDATE GOALS")
old = "Core Core2 Sha256 Sha512 Ed25519 Events4 Wire4 Bound4 Wire5 Bound5 Stateful5 Upgrade6 Kira5 Advice7 Laws7 Other7 Upgrade7 Hybrid7 Shake7"
new = sorted(Path("core").glob("*8.lean"))
for path in [*(Path("core", name + ".lean") for name in old.split()), *new]:
    show(path)
print("\nLOCAL CHECKER, ADAPTER, CERTIFICATE PROVENANCE AND BUILD INPUTS")
for name in """spike/r3/watch.py spike/r3/private-exports.py spike/r4/shim.c
spike/runtime-r3/shim.c spike/runtime-r2/include/lean/config.h
spike/r6/KernelCell.lean spike/r6/kernel-platform.cpp spike/r6/kernel-roots.txt
spike/r6/route1-sources.py spike/r6/bootstrap-route1.py spike/r6/import-audit.py
spike/r6/reachable.py spike/r6/runtime.sh spike/r6/ExportTerm.lean
spike/r7/ExportLaws.lean spike/r7/fixed-owner.py spike/r7/embed.py spike/r7/pinned-context.c""".split():
    show(Path(name))
print("\nROUND 8 BUILD, ABI AND MEASUREMENT FILES (test verdicts are external observations)")
for path in sorted(Path("spike/r8").iterdir()):
    if path.is_file():
        show(path)
print("\nHAND-WRITTEN UPSTREAM RUNTIME TRANSLATION UNITS")
stage = Path("logs/r8/build/logs/r6")
runtime_units = []
for name in """runtime/object runtime/utf8 runtime/alloc runtime/apply runtime/mpz runtime/mpn runtime/exception
runtime/interrupt runtime/hash runtime/platform kernel/abstract kernel/expr kernel/expr_eq_fn kernel/for_each_fn
kernel/instantiate kernel/level kernel/replace_fn util/kvmap util/name""".split():
    path = Path(name + ".cpp")
    runtime_units.append(path)
    print(f"{len((stage/'upstream/src'/path).read_bytes().splitlines()):6}  lean4/src/{path}")

print("\nUPSTREAM QUOTED HEADERS REACHABLE FROM THOSE UNITS (includes conditional branches)")
src = stage / "upstream/src"
seen, pending = set(runtime_units), list(runtime_units)
while pending:
    path = pending.pop()
    content = (src / path).read_text()
    for inc in re.findall(r'^\s*#\s*include\s*"([^"]+)"', content, re.MULTILINE):
        for header in (path.parent / inc, Path(inc)):
            if (src / header).is_file():
                if header not in seen:
                    seen.add(header)
                    pending.append(header)
                break
for header in sorted(seen - set(runtime_units)):
    print(f"{len((src/header).read_bytes().splitlines()):6}  lean4/src/{header}")
print("\nLEAN COMPILER/RUNTIME HEADERS AVAILABLE IN THE BUNDLED NATIVE AND WASI BUILDS")
for path in sorted(Path("toolchain/lean-4.19.0-darwin_aarch64/include/lean").glob("*.h")):
    show(path)
print("\nUPSTREAM LEAN IMPORT CLOSURE (includes source behind prebuilt oleans and elaboration-only imports)")
with contextlib.redirect_stdout(io.StringIO()):
    audit = runpy.run_path("spike/r6/import-audit.py")
for name in sorted(audit["visited"]):
    print(f"{len(audit['sources'][name].splitlines()):6}  {name.replace('.', '/')}.lean")
print("\nPrebuilt host Lean 4.19.0, WASI SDK 25, native compiler/linker, macOS, V8, Node and OpenSSL remain external trust dependencies. Generated C, compiled Wasm and proof expressions have no hand-written line count.")
