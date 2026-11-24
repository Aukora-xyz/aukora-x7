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
assert profile in ("lite", "full")
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
machine_modules.extend(["RatchetChecker", "Ratchet11", "Evidence11", "Safe11", "Round11", "Judge12", "SegmentFinal", "SessionFinal"])
machine_modules.append("Bound12c")
if profile == "lite":
    machine_modules.extend(["Lite", "Lite12"])
modules = [*sorted((lib/"Batteries").rglob("*.c")), *sorted((lib/"Lean4Lean").rglob("*.c")),
           *[lib/(name.replace(".", "/") + ".c") for name in machine_modules]]
roots += ["r11_halted", "r11_ceiling", "r12_digest", "r12b_entry", "r12b_first",
          "r12b_recovery_kind", "r12b_seal", "r12b_continue", "r12c_bound_genesis"]
exports += ["seal", "continueRecord", "journalByte", "sealByte"]
exports += ["initBound", "recordIdByte"]
exports += ["witnessMask", "lawByte", "installReason", "halted", "guessCeiling"]
if profile == "lite":
    law = (work / "package/root.id").read_bytes()
    if len(law) != 32:
        raise ValueError("expected a 32-byte genesis law identity")
    (build / "root-law.h").write_text("static const uint8_t initial_law[32] = {" +
                                      ",".join(map(str, law)) + "};\n")
    roots[roots.index("r9_step")] = "r12_lite_step"
    flags.append("-DRELEASE_LITE")
    archives.insert(0, runtime / "platform.o")
else:
    roots[roots.index("r9_step")] = "r11_step"
    roots += Path("spike/r6/kernel-roots.txt").read_text().split()
    roots += ["r11_kernel_init", "r11_reason", "r11_law_digest", "r12_staged", "r12_witness_mask"]
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
if profile == "lite" and "Lean4Lean_TypeChecker" in reachable:
    raise ValueError("checker unexpectedly reachable from lite")
objects = []
for source in [build / "reachable.c", *interfaces]:
    driver = "clang++" if source.suffix == ".cpp" else "clang"
    obj = build / (source.stem + ".o")
    run(sdk / driver, *flags, "-Werror=int-conversion", "-c", source, "-o", obj)
    objects.append(obj)
run(sdk / "clang++", "-nostartfiles", "-Wl,--no-entry,--max-memory=268435456,--threads=1,--gc-sections,--strip-all,--error-limit=0",
    "-Wl,-z,stack-size=8388608,--stack-first", *["-Wl,--wrap=" + s for s in wrap],
    *["-Wl,--export=" + s for s in exports], *objects, *archives, "-o", build / "linked.wasm")
if profile == "lite":
    run(sys.executable, "spike/r3/private-exports.py", build / "linked.wasm", release / "aukora-core-lite.wasm")
else:
    run(sys.executable, "spike/r3/private-exports.py", build / "linked.wasm", build / "stripped.wasm")
    run(sys.executable, release / "tools/seal-judge.py", build / "stripped.wasm", release / "aukora-core.wasm")
