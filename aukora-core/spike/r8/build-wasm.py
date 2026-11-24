"""Link one offline WASI artifact from the serially compiled Lean modules."""
from pathlib import Path
import os
import subprocess
import sys

role, = sys.argv[1:]
if role not in {"verify", "core"}:
    raise SystemExit("choose verify or core")
work = Path("logs/r8/build")
stage = work / "logs/r6"
lib = stage / "bootstrap/lib"
runtime = stage / "runtime"
build = work / role
build.mkdir(exist_ok=True)
sdk = Path("toolchain/wasi-sdk-25.0-arm64-macos/bin")
r6 = Path("spike/r6")
r7 = Path("spike/r7")
r8 = Path("spike/r8")
env = dict(os.environ, TMPDIR=str((work / "tmp").resolve()), PYTHONDONTWRITEBYTECODE="1")

def run(*args):
    subprocess.run([sys.executable, "spike/r3/watch.py", *map(str, args)], env=env, check=True)

wrap = ["lean_internal_panic", "abort_message", "lean_task_get", "_ZNSt3__222__libcpp_verbose_abortEPKcz"]
archives = [runtime / "shim.o", runtime / "route2.a"]
if role == "verify":
    modules = [lib / "core/Shake7.c", lib / "core/Mldsa8.c"]
    roots = ["r8_mldsa_verify"]
    exports = ["clear", "input", "verify"]
    interfaces = [r8 / "verify-interface.c"]
    artifact = "Mldsa8.wasm"
else:
    modules = [*sorted((lib / "Batteries").rglob("*.c")), *sorted((lib / "Lean4Lean").rglob("*.c")),
               lib / "KernelCell.c", *sorted((lib / "core").glob("*.c"))]
    roots = (r6 / "kernel-roots.txt").read_text().split() + ["r6_kernel_init", "r6_kernel_check"]
    roots += (r8 / "core-roots.txt").read_text().split()
    exports = (r8 / "core-exports.txt").read_text().split()
    interfaces = [r7 / "pinned-context.c", r8 / "core-interface.c", r6 / "kernel-platform.cpp"]
    run(sys.executable, r7 / "embed.py", build / "pinned.h")
    wrap.extend(["lean_expr_dbg_to_string", "lean_io_eprintln", "lean_panic_fn",
                 "_ZN4lean21stack_space_exceptionC1EPKc"])
    archives.insert(0, runtime / "kernel-extra.a")
    artifact = "Core8.wasm"

run(sys.executable, r6 / "reachable.py", build / "reachable.c", stage / "upstream/stage0/stdlib",
    "--roots", *roots, "--modules", *modules)
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
