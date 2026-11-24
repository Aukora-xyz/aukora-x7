"""Link one offline WASI artifact from the serially compiled Lean modules."""
from pathlib import Path
import os
import subprocess
import sys

work = Path("logs/r9/build")
stage = work / "logs/r6"
lib = stage / "bootstrap/lib"
runtime = stage / "runtime"
build = work / 'core-wasm'
build.mkdir(exist_ok=True)
sdk = Path("toolchain/wasi-sdk-25.0-arm64-macos/bin")
r6 = Path("spike/r6")
r9 = Path("spike/r9")
env = dict(os.environ, TMPDIR=str((work / "tmp").resolve()), PYTHONDONTWRITEBYTECODE="1")

def run(*args):
    subprocess.run([sys.executable, "spike/r3/watch.py", *map(str, args)], env=env, check=True)

wrap = ["lean_internal_panic", "abort_message", "lean_task_get", "_ZNSt3__222__libcpp_verbose_abortEPKcz"]
archives = [runtime / "shim.o", runtime / "route2.a"]
modules = [*sorted((lib / "Batteries").rglob("*.c")), *sorted((lib / "Lean4Lean").rglob("*.c")),
           lib / "KernelCell.c"]
# Only runtime sources. No candidate source, export, model, proof or Wasm enters this link.
runtime_names = """Core Core2 Events4 Sha256 Bound4 Sha512 Ed25519 Wire4 Wire5 Bound5 Stateful5
Upgrade6 Hybrid7 Shake7 Mldsa8 Risk8 Core8 Policy9 ModelSection9 Checker9 Upgrade9 Core9"""
modules += [lib / "core" / (name + ".c") for name in sorted(runtime_names.split())]
roots = (r6 / "kernel-roots.txt").read_text().split() + ["r9_kernel_init"]
roots += (r9 / "core-roots.txt").read_text().split()
exports = (r9 / "core-exports.txt").read_text().split()
interfaces = [r9 / "pinned-context.c", r9 / "core-interface.c", r6 / "kernel-platform.cpp"]
run(sys.executable, r9 / "embed.py", build / "pinned.h")
wrap.extend(["lean_expr_dbg_to_string", "lean_io_eprintln", "lean_panic_fn",
             "_ZN4lean21stack_space_exceptionC1EPKc"])
archives.insert(0, runtime / "kernel-extra.a")
artifact = "Core9.wasm"

run(sys.executable, r6 / "reachable.py", build / "reachable.c", stage / "upstream/stage0/stdlib",
    "--roots", *roots, "--modules", *modules)
reachable = (build / "reachable.c").read_text()
# The older namespaces still occur in the private law environment as model ingredients.
# Their lists and step functions must not be callable from the new executable gate.
for forbidden in ["l_Aukora_Upgrade7_lookup(", "l_Aukora_Upgrade7_primaryDigest", "l_R9Candidate_"]:
    if forbidden in reachable:
        raise ValueError("unexpected reachable candidate/list symbol: " + forbidden)
print("No R7 digest lookup, R7 primary digest or R9 candidate code in reachable core C.", flush=True)
flags = ["-Os", "-DNDEBUG", "-ffunction-sections", "-fdata-sections", "-Ispike/runtime-r2/include",
         "-Itoolchain/lean-4.19.0-darwin_aarch64/include", "-I" + str(build)]
objects = []
for source in [build / "reachable.c", *interfaces]:
    driver = "clang++" if source.suffix == ".cpp" else "clang"
    obj = build / (source.stem + ".o")
    run(sdk / driver, *flags, "-Werror=int-conversion", "-c", source, "-o", obj)
    objects.append(obj)
run(sdk / "clang++", "-nostartfiles", "-Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0",
    "-Wl,-z,stack-size=8388608,--stack-first", *["-Wl,--wrap=" + s for s in wrap],
    *["-Wl,--export=" + s for s in exports], *objects, *archives, "-o", build / "linked.wasm")
run(sys.executable, "spike/r3/private-exports.py", build / "linked.wasm", Path("core") / artifact)
