"""Wording pass for the public copy of v0.8. Comments, file names and the two prose pages only; no statement, no code path.
The proof that nothing that matters changed is the isolated build of the patched tree reproducing v0.8/PINS.sha256."""
import hashlib, os, re, shutil, sys
from pathlib import Path
out = Path(sys.argv[1]); lab = Path(__file__).resolve().parents[1]; v = out / "v0.8"

def edit(rel, pairs):
    p = v / rel; s = p.read_text()
    for old, new in pairs:
        if old not in s: raise SystemExit(f"wording patch: text not found in {rel}: {old[:60]!r}")
        s = s.replace(old, new)
    p.write_text(s)

# 1. the independent tests: neutral names, relative imports
src, dst = v / "tests/second-seat", v / "tests/independent"; dst.mkdir()
names = {"mythos-binding.mjs": "readdress.mjs", "mythos-bound-edges.mjs": "bound-edges.mjs", "mythos-twin-cores.mjs": "twin-cores.mjs"}
for old, new in names.items():
    s = (src / old).read_text()
    s, n = re.subn(r"const T = '[^']*/tests/';", "const T = new URL('../', import.meta.url).pathname;", s)
    if n != 1: raise SystemExit(f"wording patch: library path not found in {old}")
    s = s.replace("mythos-binding.mjs", "readdress.mjs").replace("mythos-twin-cores.mjs", "twin-cores.mjs").replace("mythos-bound-edges.mjs", "bound-edges.mjs")
    s = re.sub(r"^// Mythos, second seat, round 12c D\. ", "// An independent check. ", s, flags=re.M)
    s = re.sub(r"^// Mythos: ", "// An independent check: ", s, flags=re.M)
    s = s.replace("(frame builders from the release's own test library; the logic is mine)", "(frame builders from this release's own test library)")
    s = s.replace("(frame builders from the v0.6 test library; the logic is mine)", "(frame builders from this release's own test library)")
    (dst / new).write_text(s)
shutil.rmtree(src)
(dst / "README.md").write_text("Three checks written independently of the builder's tests. Run each with a core file:\n\n"
    "    node v0.8/tests/independent/readdress.mjs v0.8/aukora-core-lite.wasm\n    node v0.8/tests/independent/bound-edges.mjs v0.8/aukora-core-lite.wasm\n"
    "    node v0.8/tests/independent/twin-cores.mjs <core A> <core B>     (the same bytes into two cores, compared after every input)\n")

# 2. comments
edit("Proofs/Events.lean", [("-- Round 1 repair (Mythos): the first proof's", "-- Repair: the first proof's"), ("-- Round 1 repair (Mythos): `simp` did not", "-- Repair: `simp` did not")])
edit("Proofs/PolicyCarried.lean", [("(finding O1 of the second seat on skeleton 1)", "(a review finding on the first skeleton step)")])
s = (v / "tests/record-rebinding-vectors.mjs").read_text().split("\n"); s[0] = "// Stored frames of the re-addressing test (tests/record-rebinding.mjs)," if "second seat" in s[0] else s[0]; (v / "tests/record-rebinding-vectors.mjs").write_text("\n".join(s))
t = (v / "tests/record-rebinding.mjs").read_text().split("\n")
t[0] = "// The question the first binding test does not ask: is the SIGNATURE tied to the record?"
t = [re.sub(r"node mythos-binding\.mjs", "node record-rebinding.mjs", l).replace("the logic is mine", "independent logic") for l in t]
(v / "tests/record-rebinding.mjs").write_text("\n".join(t))

# 3. the two prose pages
shutil.copy(lab / "release-extras/NOT-PROVED-v0.8.md", v / "NOT-PROVED.md")
p = (v / "PROVED.md").read_text().split("\n")
head = ["# What is proved in v0.8", "",
 "ONE proposition, `Aukora.RootFinal.Lawful`, with 44 named fields, proved for ONE machine: `theorem full_lawful : Lawful fullModel`.",
 "Accepted by the Lean 4.19.0 kernel in two independent from-scratch builds (no error, no `sorryAx`). The full Wasm pins this set.",
 "Every statement is about the Lean MODEL. Read `NOT-PROVED.md` first.", "",
 "The 44 are: 37 from the earlier law set (ten of them restated in v0.8, see the last section), then `b1` to `b4` (record",
 "binding), `pinned`, and the two register laws `r_mono` and `id_fixed`."]
i = next(k for k, l in enumerate(p) if l.startswith('"Never" is what the law forbids'))
body = "\n".join(head + [""] + p[i:])
for old, new in [("## Added in v0.6 (round 12c D), kernel-checked in the Claude coder's runs", "## Added after the 37: record binding and the pin law"),
                 ("(the fortieth, `Record.toRecord`, was not found by name by the second seat)", "(the fortieth, `Record.toRecord`, was not found by name in an independent check)"),
                 ("## Also proved in v0.4 (names as in the build transcript)", "## Also proved (names as in the build transcript)"),
                 ("See `NOT-PROVED.md` before relying on any line above.", "")]:
    if old not in body: raise SystemExit("wording patch: PROVED.md text not found: " + old[:50])
    body = body.replace(old, new)
body = re.sub(r" \(new(, D2|, A)?\) \|", " |", body)
recovery = "open (not halted, not sealed, within its limits); the owner's recovery (a valid clear, a valid key change) is the one\npromise that holds from every state, including a full record (within the 16-entry recovery reserve)."
if recovery not in body: raise SystemExit("wording patch: recovery sentence not found in PROVED.md")
body = body.replace(recovery, "open (not halted, not sealed, within its limits). The owner's recovery (a valid clear, a valid key change) is the one\npromise that also holds when the ordinary limits are reached, and only while the segment is not sealed and the\n16-entry recovery reserve is not spent.")
body = body.rstrip("\n") + """

## New in v0.8: the owner's restriction list (laws restated; the machine is unchanged)
The state gains registers for an owner policy (`id`, `refused`, `enabled`, `limits`, `judge`). No step reads or writes
them yet. What changed is the law set, so that a later machine MAY refuse a form the owner has listed:
- `Forms.lean`: a closed table of the 31 forms the machine implements, each with a fixed number; `formOf` reads the wire
  bytes only. `table`, `all_complete`, `code_injective`, `enabled_default` are kernel-checked.
- Restated with one added condition ("unless the form is in the refused list") and nothing else: the availability
  promises that go through `Open` (feed, reset, the two public ports, stamping, the five supported control kinds), and
  `PriorVerdicts`, `VersionVerdicts`, `Speech`, `E6`. The no-lockout law `h5` is NOT restated.
- `r_mono`: no input removes anything from the refused list. `id_fixed`: no input changes the record identifier register.
- `PolicyCarried.policy_carried`: every input (frame, feed, reset, stamp), every seal and every continuation leaves the
  registers exactly as they were; from the ordinary start and from a bound start they are the defaults on every
  reachable state.
- `OldText.old_of_lawful`: ANY model satisfying the 44 gives back the earlier text of every restated promise wherever the
  refused list is empty; `old_lawful_reachable`: for this machine that is every reachable state.
- `OldText.forced_blocked`: the restated `PriorVerdicts` no longer forces a refused form to be admitted (shown for that
  one clause; see NOT-PROVED item 20).
Axioms of these, as the kernel reports them: propext, Classical.choice, Quot.sound (`table`: none).

See `NOT-PROVED.md` before relying on any line above.
"""
(v / "PROVED.md").write_text(body)

# 4. the source list: the same membership as the lab's, renamed paths, fresh digests
rows = []
for line in (v / "SOURCE.sha256").read_text().splitlines():
    path = line.split("  ", 1)[1]
    if "/tests/second-seat/" in path:
        base = path.rsplit("/", 1)[1]; path = "v0.8/tests/independent/" + names.get(base, base)
    rows.append(path)
rows = sorted(set(rows), key=lambda x: x.encode())
(v / "SOURCE.sha256").write_text("".join(hashlib.sha256((out / r).read_bytes()).hexdigest() + "  " + r + "\n" for r in rows))
print(f"wording patch applied; source list {len(rows)} entries")
