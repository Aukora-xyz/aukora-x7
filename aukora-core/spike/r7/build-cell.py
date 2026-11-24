"""Relink the unchanged round-six checker with R7's compiled-in manifest goals."""
import os
from pathlib import Path
import subprocess
import sys

root = Path.cwd()
role = sys.argv[1]
if role not in {"kernel", "core"}:
    raise SystemExit("choose kernel or core")
work = root / "logs/r7/build"
stage = work / "logs/r6"
build = work / f"{role}-build"
build.mkdir(exist_ok=True)
lib = stage / "bootstrap/lib"
src = Path("spike/r7")
r6 = Path("spike/r6")
sdk = Path("toolchain/wasi-sdk-25.0-arm64-macos/bin")
env = dict(os.environ, TMPDIR=str(work / "tmp"))

def run(*cmd):
    subprocess.run([sys.executable, "spike/r3/watch.py", *map(str, cmd)], env=env, check=True)

roots = (r6 / "kernel-roots.txt").read_text().split() + ["r6_kernel_init", "r6_kernel_check"]
modules = [*sorted((lib / "Batteries").rglob("*.c")), *sorted((lib / "Lean4Lean").rglob("*.c")),
           work / "KernelCell.c"]
interfaces = [src / "pinned-context.c"]
if role == "kernel":
    interfaces.append(src / "kernel-interface.c")
    exports = ["ready", "input", "check"]
    published = "Kernel7.wasm"
else:
    modules += [*sorted((lib / "core").glob("*.c")), work / "Upgrade6.c", work / "Upgrade7.c"]
    roots += ["r5_genesis", "r5_head_byte", "r5_core_byte", "r5_feed", "r5_reset", "r5_verify_packed", "r7_step"]
    interfaces.append(src / "core-interface.c")
    exports = ["input", "init", "step", "reset", "feed", "head", "core", "verify"]
    published = "Core7.wasm"
run(sys.executable, r6 / "reachable.py", build / "reachable.c", stage / "upstream/stage0/stdlib",
    "--roots", *roots, "--modules", *modules)
run(sys.executable, src / "embed.py", build / "pinned.h")
flags = ["-Os", "-DNDEBUG", "-ffunction-sections", "-fdata-sections", "-Ispike/runtime-r2/include",
         "-Itoolchain/lean-4.19.0-darwin_aarch64/include", "-I" + str(build)]
objs = []
for path in [build / "reachable.c", *interfaces, r6 / "kernel-platform.cpp"]:
    obj = build / (path.stem + ".o")
    driver = "clang++" if path.suffix == ".cpp" else "clang"
    run(sdk / driver, *flags, "-Werror=int-conversion", "-c", path, "-o", obj)
    objs.append(obj)
runtime = stage / "runtime"
wrap = ["lean_internal_panic", "abort_message", "lean_task_get", "_ZNSt3__222__libcpp_verbose_abortEPKcz",
        "lean_expr_dbg_to_string", "lean_io_eprintln", "lean_panic_fn", "_ZN4lean21stack_space_exceptionC1EPKc"]
run(sdk / "clang++", "-nostartfiles", "-Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0",
    "-Wl,-z,stack-size=8388608,--stack-first", *["-Wl,--wrap=" + n for n in wrap],
    *["-Wl,--export=" + n for n in exports], *objs, runtime / "kernel-extra.a", runtime / "shim.o",
    runtime / "route2.a", "-o", build / "linked.wasm")
run(sys.executable, "spike/r3/private-exports.py", build / "linked.wasm", Path("core") / published)
