"""Select whole compiler-emitted definitions reachable from the R5 Lean exports.

Init's bootstrap C is already in the upstream source bundle. Keep original
function bodies verbatim. Execute only their referenced closed-value assignments,
in upstream module import order and upstream initializer order inside each module.
This step specializes startup to pure functions; it is part of the trusted build.
"""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("output", type=Path)
parser.add_argument("stdlib", type=Path)
parser.add_argument("modules", type=Path, nargs="+")
args = parser.parse_args()
roots = ["r5_genesis", "r5_step", "r5_head_byte", "r5_core_byte", "r5_feed", "r5_reset", "r5_verify_packed"]
# object.cpp calls these Lean-generated Init exports through C ABI primitives.
runtime_roots = ["lean_list_to_array", "lean_array_to_list_impl"]
functions, globals_, prototypes, imports, init_lines = {}, {}, {}, {}, {}
ident = r"[A-Za-z_]\w*"
# All top-level generated definitions have exactly one opening brace on the
# signature line, with no leading indentation. Read until braces balance.
header = re.compile(rf"^(?:LEAN_EXPORT |static )?(?:[\w]+\s*\*?\s+)+({ident})\([^;{{]*\) \{{$")
prototype = re.compile(rf"^[\w *]+?\b({ident})\([^;{{]*\);$")
variable = re.compile(rf"^(?:LEAN_EXPORT |static )?(?:lean_object\*|u?int\d+_t|size_t|double|float) (l_\w+);$")
symbols = re.compile(r"\b(?:l_\w+|lean_\w+|r[345]_\w+|_init_l_\w+)\b")
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
            elif name.startswith(("l_", "r3_", "r4_", "r5_", "_init_l_")) or name in roots + runtime_roots:
                functions[name] = "\n".join(body)
            continue
        m = variable.match(line)
        if m:
            globals_[m[1]] = (line, module)
            continue
        m = prototype.match(line)
        if m:
            prototypes[m[1]] = line

for path in [args.stdlib / "Init.c", *sorted((args.stdlib / "Init").rglob("*.c"))]:
    ingest(path.read_text())
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
        if name.startswith(("l_", "_init_", "r3_", "r4_", "r5_")):
            raise ValueError(f"unresolved Lean declaration {name}")
        outside.add(name)
for root in roots + runtime_roots:
    assert root in functions, f"missing Lean export {root}"
    visit(root)

# Use the exact generated signature for local functions. Non-generated primitive
# prototypes (e.g. externs) supplement lean.h where the generator did the same.
out = ["/* Reachable compiler output. Rebuild using spike/r5/reachable.py. */",
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

out.append("void r5_constants(void) {")
for path in args.modules:
    startup(path.read_text().splitlines()[1].split(": ", 1)[1])
out.append("}")
assert assigned == needed & globals_.keys(), (needed & globals_.keys()) - assigned
# Keep the C interface type-checked against the actual Lean compiler's export ABI.
args.output.with_name("exports.h").write_text("\n".join(prototypes[name] for name in roots) + "\n")
args.output.write_text("\n".join(out) + "\n")
print(f"{len(needed & functions.keys())} generated functions, {len(assigned)} closed constants")
