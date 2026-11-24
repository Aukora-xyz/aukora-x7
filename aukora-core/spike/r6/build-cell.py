"""Link the proof-checking cell using the native objects, bootstrap and data from route 1."""
import os
from pathlib import Path
import subprocess
import sys

root = Path.cwd()
role = sys.argv[1]
if role not in {"kernel", "core"}:
    sys.exit("choose kernel or core")
lab = root / "logs/r6"
build = lab / f"{role}-build"
build.mkdir(exist_ok=True)
lib = lab / "bootstrap/lib"
src = Path("spike/r6")
sdk = Path("toolchain/wasi-sdk-25.0-arm64-macos/bin")
env = dict(os.environ, TMPDIR=str(lab / 'tmp'))

def run(*cmd):
    subprocess.run([sys.executable, "spike/r3/watch.py", *map(str, cmd)], env=env, check=True)

roots = (src / 'kernel-roots.txt').read_text().split()
roots += ['r6_kernel_init', 'r6_kernel_check']
modules = [*sorted((lib/'Batteries').rglob('*.c')), *sorted((lib/'Lean4Lean').rglob('*.c')), lab/'KernelCell.c']
interfaces = [src/'pinned-context.c']
if role == 'kernel':
    interfaces.append(src/'kernel-interface.c')
    exports = ['ready', 'input', 'check']
    published = 'Kernel6.wasm'
else:
    modules += [*sorted((lib/'core').glob('*.c')), lab/'Upgrade6.c']
    roots += ['r5_genesis', 'r5_head_byte', 'r5_core_byte', 'r5_feed', 'r5_reset', 'r5_verify_packed', 'r6_step']
    interfaces.append(src/'core-interface.c')
    exports = ['input','init','step','reset','feed','head','core','verify']
    published = 'Core6.wasm'
run(sys.executable, src/'reachable.py', build/'reachable.c', lab/'upstream/stage0/stdlib',
    '--roots', *roots, '--modules', *modules)
run(sys.executable, src/'embed.py', build/'pinned.h')
flags = ['-Os', '-DNDEBUG', '-ffunction-sections', '-fdata-sections', '-Ispike/runtime-r2/include',
         '-Itoolchain/lean-4.19.0-darwin_aarch64/include', '-I'+str(build)]
objs = []
for path in [build/'reachable.c', *interfaces, src/'kernel-platform.cpp']:
    obj = build / (path.stem + '.o')
    driver = 'clang++' if path.suffix == '.cpp' else 'clang'
    run(sdk/driver, *flags, '-Werror=int-conversion', '-c', path, '-o', obj)
    objs.append(obj)
rt = lab/'runtime'
wrap = ['lean_internal_panic','abort_message','lean_task_get','_ZNSt3__222__libcpp_verbose_abortEPKcz',
        'lean_expr_dbg_to_string','lean_io_eprintln','lean_panic_fn','_ZN4lean21stack_space_exceptionC1EPKc']
run(sdk/'clang++', '-nostartfiles','-Wl,--no-entry,--threads=1,--gc-sections,--strip-all,--error-limit=0',
    '-Wl,-z,stack-size=8388608,--stack-first', *['-Wl,--wrap='+n for n in wrap],
    *['-Wl,--export='+n for n in exports], *objs, rt/'kernel-extra.a', rt/'shim.o', rt/'route2.a',
    '-o', build/'linked.wasm')
run(sys.executable, 'spike/r3/private-exports.py', build/'linked.wasm', Path('core')/published)
