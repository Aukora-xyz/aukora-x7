"""Select whole compiler-emitted definitions reachable from the three Lean exports.

Init's bootstrap C is already in the official local source archive. Keep original
function bodies verbatim. Execute only their referenced closed-value assignments,
in upstream module import order and upstream initializer order inside each module.
This step specializes startup to pure functions; it is part of the trusted build.
"""
import argparse
import re
import tarfile
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("modules", type=Path, nargs="+")
args = parser.parse_args()
roots = ["r3_genesis", "r3_step", "r3_head_byte"]
functions, globals_, prototypes, imports, init_lines = {}, {}, {}, {}, {}
ident = r"[A-Za-z_]\w*"
# All top-level generated definitions have exactly one opening brace on the
# signature line, with no leading indentation. Read until braces balance.
header = re.compile(rf"^(?:LEAN_EXPORT |static )?(?:[\w]+\s*\*?\s+)+({ident})\([^;{{]*\) \{{$")
prototype = re.compile(rf"^[\w *]+?\b({ident})\([^;{{]*\);$")
variable = re.compile(rf"^(?:LEAN_EXPORT |static )?(?:lean_object\*|u?int\d+_t|size_t|double|float) (l_\w+);$")
symbols = re.compile(r"\b(?:l_\w+|lean_\w+|r3_\w+|_init_l_\w+)\b")
literals = re.compile(r'"(?:[^"\\]|\\.)*"')
def ingest(source):
    lines = source.splitlines()
    module = lines[1].split(": ", 1)[1]
    imports[module] = lines[2].removeprefix("// Imports:").split()
    init_lines[module] = []
    it = iter(lines)
    for line in it:
        m = header.match(line)
        if m:
            name = m[1]
            body = [line]
            depth = 1
            while depth:
                row = next(it)
                body.append(row)
                bare = literals.sub("", row)
                depth += bare.count("{") - bare.count("}")
            if name.startswith("initialize_"):
                init_lines[module] = body
            elif name.startswith(("l_", "r3_", "_init_l_")) or name in roots:
                functions[name] = "\n".join(body)
            continue
        m = variable.match(line)
        if m:
            globals_[m[1]] = (line, module)
            continue
        m = prototype.match(line)
        if m:
            prototypes[m[1]] = line

archive = Path("toolchain/downloads/lean4-v4.19.0-source.tar.gz")
with tarfile.open(archive, mode="r|gz") as tar:
    for item in tar:
        name = item.name.partition("/stage0/stdlib/")[2]
        if name == "Init.c" or (name.startswith("Init/") and name.endswith(".c")):
            ingest(tar.extractfile(item).read().decode())
for path in args.modules:
    ingest(path.read_text())

needed, outside = set(), set()
def visit(name):
    if name in needed:
        return
    needed.add(name)
    if name in functions:
        for ref in symbols.findall(literals.sub("", functions[name])):
            visit(ref)
    elif name in globals_:
        visit("_init_" + name)
    else:
        if name.startswith(("l_", "_init_", "r3_")):
            raise ValueError(f"unresolved Lean declaration {name}")
        outside.add(name)
for root in roots:
    visit(root)

# Use the exact generated signature for local functions. Non-generated primitive
# prototypes (e.g. externs) supplement lean.h where the generator did the same.
out = ["/* Reachable compiler output. Rebuild using spike/r3/reachable.py. */",
       "#include <lean/lean.h>"]
for name in sorted(outside & prototypes.keys()):
    out.append(prototypes[name])
for name in sorted(needed & globals_.keys()):
    out.append(globals_[name][0])
for name in sorted(needed & functions.keys()):
    out.append(functions[name].splitlines()[0][:-2] + ";")
for name in sorted(needed & functions.keys()):
    out.append(functions[name])

seen, assigned = set(), set()
def startup(module):
    if module in seen:
        return
    seen.add(module)
    for dep in imports[module]:
        if dep in imports:
            startup(dep)
    for row in init_lines[module]:
        m = re.fullmatch(r"(l_\w+) = (_init_\w+)\(\);", row)
        if m and m[1] in needed:
            assert m[2] == "_init_" + m[1] and m[1] not in assigned
            out.append("    " + row)
            assigned.add(m[1])
        m = re.fullmatch(r"lean_mark_persistent\((l_\w+)\);", row)
        if m and m[1] in needed:
            assert m[1] in assigned
            out.append("    " + row)

out.append("void r3_constants(void) {")
for path in args.modules:
    startup(path.read_text().splitlines()[1].split(": ", 1)[1])
out.append("}")
assert assigned == needed & globals_.keys(), (needed & globals_.keys()) - assigned
args.output.write_text("\n".join(out) + "\n")
print(f"{len(needed & functions.keys())} generated functions, {len(assigned)} closed constants")
