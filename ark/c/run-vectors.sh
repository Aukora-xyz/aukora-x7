#!/bin/sh
set -eu
cd "$(dirname "$0")"
exec python3 -I -B -S - <<'PY'
import json
import subprocess
from pathlib import Path


vectors = Path("../vectors")
header_escapes = {code: f"\\u{code:04x}" for code in (*range(32), 127)}
header_escapes.update({9: "\\t", 10: "\\n", 13: "\\r"})


def vector_file(name):
    path = vectors / name
    if not name or name in (".", "..") or Path(name).name != name or path.is_symlink():
        raise ValueError(f"expected a filename inside {vectors}, got {name!r}")
    return path


def verdict_line(prefix, result):
    words = [prefix, result["verdict"]]
    if "reason" in result:
        words.append(result["reason"])
    if "item" in result:
        words.append(f"item={result['item']}")
    return " ".join(words)


def expected_output(case, bundle, pins):
    result = case["bundle_verdict"]
    lines = []
    if result.get("reason") != "BAD_BUNDLE":
        coverage = json.loads(bundle.read_bytes())["coverage"]
        lines.append("coverage: " + coverage.translate(header_escapes))
    supplied_by = json.loads(pins.read_bytes())["supplied_by"]
    lines.extend(["pins supplied by: " + supplied_by.translate(header_escapes),
                  "integrity only; freshness and completeness not shown"])

    verdicts = [verdict_line("BUNDLE", result)]
    for op, verdict in sorted(case["ops"].items()):
        verdicts.append(verdict_line("OP " + op, verdict))
    stdout = ("\n".join(lines + verdicts) + "\n").encode("utf-8")
    return stdout, verdicts


cases = json.loads(vector_file("expected-verdicts.json").read_bytes())["vectors"]
matches = 0
for case in cases:
    bundle = vector_file(case["bundle"])
    pins = vector_file(case["pins"])
    label = f"{bundle.name} [{pins.name}]"
    derived, verdicts = expected_output(case, bundle, pins)
    expected = ("\n".join(case["stdout"]) + "\n").encode("utf-8") if "stdout" in case else derived
    actual = subprocess.run(["./verifier", bundle, pins], stdout=subprocess.PIPE)
    if actual.stdout == expected == derived and actual.returncode == case["exit"]:
        matches += 1
        observed = actual.stdout.decode("utf-8").removesuffix("\n").split("\n")[-len(verdicts):]
        print(f"MATCH {label} expected={', '.join(verdicts)} (exit {case['exit']}) "
              f"actual={', '.join(observed)} (exit {actual.returncode})")
    else:
        print(f"DIFFER {label} expected={expected!r} (exit {case['exit']}) "
              f"actual={actual.stdout!r} (exit {actual.returncode})")
        if expected != derived:
            print(f"  Output derived from headers and structured verdicts: {derived!r}")

print(f"{matches}/{len(cases)} matched, {len(cases) - matches} differed")
raise SystemExit(0 if matches == len(cases) else 1)
PY
