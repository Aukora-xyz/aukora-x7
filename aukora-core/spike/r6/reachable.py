"""Extract pure Lean-generated C using the round-5 closed-value startup convention.

Explicit module files take precedence over stage0 files of the same module.
The external-refs report includes lean.h inline functions and genuine unresolved
primitives. Only the Wasm linker establishes which runtime definitions are missing.
"""
import argparse
import re
from pathlib import Path

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("output", type=Path)
parser.add_argument("stdlib", type=Path)
parser.add_argument("--roots", required=True, nargs="+")
parser.add_argument("--modules", required=True, type=Path, nargs="+")
args = parser.parse_args()
# object.cpp calls these Init ABI functions from the C++ side of the boundary.
runtime_roots = ["lean_list_to_array", "lean_array_to_list_impl"]

ident = r"[A-Za-z_]\w*"
header = re.compile(rf"^(?:[\w]+\s*\*?\s+)+({ident})\([^;{{]*\) \{{$")
prototype = re.compile(rf"^[\w *]+?\b({ident})\([^;{{]*\);$")
variable = re.compile(rf"^(?:LEAN_EXPORT |static )?(?:lean_object\*|u?int\d+_t|size_t|double|float) ({ident});$")
extern_var = re.compile(rf"^extern [\w *]+?\b({ident});$")
tokens = re.compile(rf"\b({ident})\b(\s*\()?")
literals = re.compile(r'"(?:[^"\\]|\\.)*"')
generated_prefix = re.compile(r"^(?:l_|_init_|r[3-6]_)")
assignment = re.compile(rf"({ident}) = (_init_\w+)\(\);")
mark = re.compile(rf"lean_mark_persistent\(({ident})\);")

# A rebuilt stdlib module supersedes all definitions, including private values,
# from any earlier bootstrap version. Never mix definitions from the two files.
paths, supplied = {}, []
for path in [*sorted(args.stdlib.rglob("*.c")), *args.modules]:
    with path.open() as reader:
        if reader.readline().rstrip() != "// Lean compiler output":
            raise ValueError(f"{path}: expected Lean-generated C")
        label = reader.readline().rstrip()
        if not label.startswith("// Module: "):
            raise ValueError(f"{path}: missing module name")
        module = label[len("// Module: "):]
    paths[module] = path
    if path in args.modules:
        supplied.append(module)

functions, globals_, prototypes, externs, imports, init_lines = {}, {}, {}, {}, {}, {}
collisions = set()
for module, path in paths.items():
    with path.open() as source:
        next(source)
        next(source)
        imports[module] = next(source).removeprefix("// Imports:").split()
        init_lines[module] = []
        for raw in source:
            line = raw.rstrip("\r\n")
            if line.endswith(" {") and (m := header.match(line)):
                name = m[1]
                body = [line]
                depth = 1
                while depth:
                    row = next(source).rstrip("\r\n")
                    body.append(row)
                    bare = literals.sub("", row) if '"' in row else row
                    depth += bare.count("{") - bare.count("}")
                if name.startswith("initialize_"):
                    init_lines[module] = body
                else:
                    if name in functions:
                        collisions.add(name)
                    functions[name] = "\n".join(body)
            elif line.endswith(";"):
                if m := variable.match(line):
                    if m[1] in globals_:
                        collisions.add(m[1])
                    globals_[m[1]] = (line, module)
                elif m := extern_var.match(line):
                    externs[m[1]] = line
                elif m := prototype.match(line):
                    prototypes[m[1]] = line

defined = functions.keys() | globals_.keys()
unknown_roots = set(args.roots) - defined
if unknown_roots:
    raise ValueError(f"missing generated roots: {sorted(unknown_roots)}")

needed, outside = set(), set()
pending = [*args.roots, *runtime_roots]
while pending:
    name = pending.pop()
    if name in needed:
        continue
    needed.add(name)
    if name in functions:
        for ref, call in tokens.findall(literals.sub("", functions[name])):
            if (ref in defined or ref in prototypes or ref in externs or generated_prefix.match(ref)
                    or (call and ref.startswith("lean_"))):
                pending.append(ref)
    elif name in globals_:
        pending.append("_init_" + name)
    else:
        outside.add(name)

external_report = args.output.with_name("external-refs.txt")
external_report.write_text("".join(ref + "\n" for ref in sorted(outside)))
print(f"{len(outside)} external references (including header inlines): {external_report}", flush=True)
if duplicates := sorted(needed & collisions):
    raise ValueError(f"ambiguous definitions across generated C files: {duplicates}")
missing = sorted(ref for ref in outside if generated_prefix.match(ref))
if missing:
    raise ValueError("unresolved generated declarations: " + ", ".join(missing))

out = ["/* Reachable compiler output. See spike/r6/reachable.py. */", "#include <lean/lean.h>"]
for name in sorted(outside & (prototypes.keys() | externs.keys())):
    out.append(prototypes.get(name) or externs[name])
for name in sorted(needed & globals_.keys()):
    out.append(globals_[name][0])
signatures = {name: functions[name].partition("\n")[0][:-2] + ";"
              for name in needed & functions.keys()}
for name in sorted(signatures):
    out.append(signatures[name])
for name in sorted(signatures):
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
        m = assignment.fullmatch(row)
        if m and m[1] in needed:
            if m[2] != "_init_" + m[1] or m[1] in assigned:
                raise ValueError(f"{module}: unsupported initializer {row}")
            out.append("    " + row)
            assigned.add(m[1])
        m = mark.fullmatch(row)
        if m and m[1] in needed:
            if m[1] not in assigned:
                raise ValueError(f"{module}: premature persistence mark {row}")
            out.append("    " + row)

out.append("void r6_constants(void) {")
for module in [*supplied, *sorted({globals_[name][1] for name in needed & globals_.keys()})]:
    startup(module)
out.append("}")
uninitialized = (needed & globals_.keys()) - assigned
if uninitialized:
    raise ValueError(f"missing pure initializers: {sorted(uninitialized)}")

exports = []
for name in args.roots:
    if name in signatures:
        exports.append(signatures[name])
    else:
        decl = globals_[name][0]
        exports.append(decl if decl.startswith("static ") else "extern " + decl.removeprefix("LEAN_EXPORT "))
args.output.with_name("exports.h").write_text("#include <lean/lean.h>\nvoid r6_constants(void);\n" + "\n".join(exports) + "\n")
args.output.write_text("\n".join(out) + "\n")
print(f"{len(signatures)} generated functions, {len(assigned)} closed constants")
