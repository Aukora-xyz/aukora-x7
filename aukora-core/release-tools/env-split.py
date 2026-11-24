#!/usr/bin/env python3
"""Count declaration kinds in the exported, pinned checker environment."""
import argparse
from pathlib import Path
import re
import sys


class Invalid(Exception):
    def __init__(self, code, reason):
        super().__init__(reason)
        self.code = code


def sorted_bytes(values):
    return sorted(values, key=lambda value: value.encode("utf-8"))


def split_environment(lines, expect=None):
    kinds, names, axioms = {}, set(), []
    for at, line in enumerate(lines, 1):
        fields = line.rstrip("\r\n").split("\t")
        if len(fields) != 3 or not fields[0] or not fields[1]:
            raise Invalid(2, f"line {at}: expected three fields (kind, name, length)")
        kind, name, length = fields
        if not re.fullmatch(r"[0-9]+", length):
            raise Invalid(3, f"line {at}: length is not a non-negative integer")
        try:
            size = int(length)
        except ValueError:
            raise Invalid(3, f"line {at}: invalid integer length") from None
        if name in names:
            raise Invalid(4, f"line {at}: duplicate declaration name")
        names.add(name)
        count, total = kinds.get(kind, (0, 0))
        kinds[kind] = count + 1, total + size
        if kind == "axiom":
            axioms.append(name)
    if expect is not None and len(names) != expect:
        raise Invalid(5, f"expected {expect} declarations, found {len(names)}")
    ordered = [(kind, *kinds[kind]) for kind in sorted_bytes(kinds)]
    nbytes = sum(size for _, _, size in ordered)
    report = f"ENVIRONMENT SPLIT: total {len(names)} declarations, {nbytes} bytes"
    report += "".join(f"; {kind} {count} ({size} bytes)" for kind, count, size in ordered)
    axiom_report = "AXIOMS IN THE PINNED ENVIRONMENT: " + (", ".join(sorted_bytes(axioms)) or "none")
    tsv = "kind\tcount\tbytes\n" + "".join(f"{kind}\t{count}\t{size}\n" for kind, count, size in ordered)
    return report, axiom_report, tsv


def selftest():
    lines = ["opaque\tB\t2\n", "axiom\tZ\t0\n", "axiom\tA\t3\n"]
    good = (
        "ENVIRONMENT SPLIT: total 3 declarations, 5 bytes; axiom 2 (3 bytes); opaque 1 (2 bytes)",
        "AXIOMS IN THE PINNED ENVIRONMENT: A, Z",
        "kind\tcount\tbytes\naxiom\t2\t3\nopaque\t1\t2\n",
    )
    if split_environment(lines, 3) != good or split_environment(reversed(lines), 3) != good:
        raise ValueError("selftest valid deterministic report")
    for code, sample, expect in (
        (2, ["axiom\tA\n"], None),
        (3, ["axiom\tA\t-1\n"], None),
        (4, ["axiom\tA\t0\n", "definition\tA\t1\n"], None),
        (5, lines, 4),
    ):
        try:
            split_environment(sample, expect)
        except Invalid as error:
            if error.code != code:
                raise ValueError(f"selftest wanted exit {code}, found {error.code}")
        else:
            raise ValueError(f"selftest accepted malformed input for exit {code}")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--expect", type=int)
    parser.add_argument("--selftest", action="store_true")
    args = parser.parse_args()
    try:
        if args.selftest:
            selftest()
            print("SELFTEST PASS")
            return 0
        release = Path(__file__).resolve().parents[1]
        with (release / ".work/package/laws.env.tsv").open(encoding="utf-8") as source:
            report, axioms, tsv = split_environment(source, args.expect)
        (release / "ENVIRONMENT-SPLIT.tsv").write_bytes(tsv.encode("utf-8"))
        print(report)
        print(axioms)
        return 0
    except Invalid as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return error.code
    except (OSError, ValueError) as error:
        print("ERROR: " + " ".join(str(error).splitlines()), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
