"""Link either gate configuration or the record/replay profile from local Lean C."""
import fcntl
import os
from pathlib import Path
import subprocess
import sys

release = Path(__file__).resolve().parents[1]
lab = release.parent
os.chdir(lab)
work = release / ".work"
profile = sys.argv[1]
assert profile in ("full", "ratchet")
build = work / ("link-" + profile)
build.mkdir(exist_ok=True)
stage = work / "logs/r6"
runtime = stage / "runtime"
lib = stage / "bootstrap/lib"
sdk = lab / "toolchain/wasi-sdk-25.0-arm64-macos/bin"
env = dict(os.environ, TMPDIR=str(work / "tmp"), PYTHONDONTWRITEBYTECODE="1",
           CLANG_MODULE_CACHE_PATH=str(work / "tmp/ModuleCache"))
lock = (work / "compile.lock").open("a")
fcntl.flock(lock, fcntl.LOCK_EX)
env["R11_COMPILE_LOCK_FD"] = str(lock.fileno())

def run(*args):
    subprocess.run([sys.executable, str(release / "tools/watch.py"), *map(str,args)], check=True, env=env, pass_fds=(lock.fileno(),))

roots = Path("spike/r9/core-roots.txt").read_text().split()
exports = Path("spike/r9/core-exports.txt").read_text().split()
flags = ["-Os", "-DNDEBUG", "-ffunction-sections", "-fdata-sections", "-Ispike/runtime-r2/include",
         "-Itoolchain/lean-4.19.0-darwin_aarch64/include", "-I" + str(build)]
wrap = ["lean_internal_panic", "abort_message", "lean_task_get", "_ZNSt3__222__libcpp_verbose_abortEPKcz"]
archives = [runtime / "shim.o", runtime / "route2.a"]
interfaces = [release / "Interface.c"]
# Keep the symbol closure independent of which proofs and test modules have been compiled.
machine_modules = """Types Ledger.Events Ledger.Frames Crypto.Sha256 Ledger.GrantEvents Ledger.Bound Wire
Crypto.Sha512 Crypto.Ed25519 Wire.Signed Ledger.Signed Ledger.Trace Compatibility.Certificate
Compatibility.ListGate Hybrid Crypto.Shake Crypto.Mldsa Danger Ledger.Assessed Policy ModelSection
Checker Gate Machine KernelCell""".split()
machine_modules.extend(["RatchetChecker", "Ratchet11", "Evidence11", "Safe11", "Round11"])
modules = [*sorted((lib/"Batteries").rglob("*.c")), *sorted((lib/"Lean4Lean").rglob("*.c")),
           *[lib/(name.replace(".", "/") + ".c") for name in machine_modules]]
roots[roots.index("r9_step")] = "r11_ratchet_step" if profile == "ratchet" else "r11_step"
if profile == "ratchet":
    flags.append("-DRELEASE_RATCHET")
roots += Path("spike/r6/kernel-roots.txt").read_text().split()
roots += ["r11_kernel_init", "r11_reason", "r11_law_digest", "r11_halted", "r11_ceiling"]
exports += ["lawByte", "installReason", "halted", "guessCeiling"]
interfaces.extend([release / "tools/Context.c", lab / "spike/r6/kernel-platform.cpp"])
wrap.extend(["lean_expr_dbg_to_string", "lean_io_eprintln", "lean_panic_fn",
             "_ZN4lean21stack_space_exceptionC1EPKc"])
archives.insert(0, runtime / "kernel-extra.a")
data = (work / "package/laws.env").read_bytes()
with (build / "pinned.h").open("w") as out:
    out.write("static const uint8_t r9_environment[] = {\n")
    for i in range(0,len(data),64):
        out.write(",".join(map(str,data[i:i+64])) + ",\n")
    out.write("};\n")
run(sys.executable, "spike/r6/reachable.py", build / "reachable.c", stage / "upstream/stage0/stdlib",
    "--roots", *roots, "--modules", *modules)
reachable = (build / "reachable.c").read_text()
for forbidden in ["l_Aukora_Upgrade7_lookup(", "l_Aukora_Upgrade7_primaryDigest", "l_R9Candidate_successor"]:
    if forbidden in reachable:
        raise ValueError("unexpected linked code: " + forbidden)
objects = []
for source in [build / "reachable.c", *interfaces]:
    driver = "clang++" if source.suffix == ".cpp" else "clang"
    obj = build / (source.stem + ".o")
    run(sdk / driver, *flags, "-Werror=int-conversion", "-c", source, "-o", obj)
    objects.append(obj)
run(sdk / "clang++", "-nostartfiles", "-Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0",
    "-Wl,-z,stack-size=8388608,--stack-first", *["-Wl,--wrap=" + s for s in wrap],
    *["-Wl,--export=" + s for s in exports], *objects, *archives, "-o", build / "linked.wasm")
artifact = release / ("aukora-core.wasm" if profile == "full" else "fixtures/ratchet-core.wasm")
run(sys.executable, "spike/r3/private-exports.py", build / "linked.wasm", artifact)
