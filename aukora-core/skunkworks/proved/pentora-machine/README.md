# The Pentora machine: five cubes, shared corners, one body. 24 November 2026

Five organs each report the outer cells of one cube in a dodecahedron. Among the sampled outer cells, only corners
are shared. All five cubes also share the origin. When both owners of every corner agree, the five reports describe
exactly one body. Its 110 trits fit in a 22-byte address. Each organ supplies its own check results. The machine's
verdict carries no authority.

Run these commands from the repository root.

    node skunkworks/proved/pentora-machine/check.mjs
    node skunkworks/proved/pentora-machine/check.mjs control    # a planted wrong expectation must fail
        LEAN=/path/to/lean-4.19.0/bin/lean sh skunkworks/proved/pentora-machine/check.sh
        LEAN=/path/to/lean-4.19.0/bin/lean sh skunkworks/proved/pentora-machine/check-rule.sh    # optional, heavier: see "A rule on six whole numbers"
    LEAN=/path/to/lean-4.19.0/bin/lean sh skunkworks/proved/pentora-machine/check-arkpairs.sh    # optional, light: see "The ten ARK pieces on the ten pairs"


With the toolchain fetched as the root README describes, `LEAN=toolchain/lean-4.19.0-darwin_aarch64/bin/lean` works for the Lean scripts (one outside run, for `check.sh` and `check-rule.sh`).

## The sampled geometry

The six geometry theorems in `Pentora.lean` check the listed points and tables in exact arithmetic. Coordinates
have the form a + b·φ for integers a and b, with φ² = φ + 1.

- `twenty_vertices` checks that the 20 listed points are distinct and all have squared radius 3.
- `five_cubes` checks five lists of eight vertices. From each vertex the other seven have the cube's distance
  signature, with three at squared distance 4, three at 8 and one at 12.
- `each_corner_in_two` and `each_pair_shares_two` check both incidence counts. Each corner has two owners,
  and each pair of distinct cubes shares two corners.
- `cube_has_27` checks 12 edge midpoints, six face centres and the common origin for each cube.
  Together with the eight corners, these give 27 sampled cells per cube.
- `figure_110` checks 110 distinct outer cells. The three shells contain 30 face centres, 60 edge midpoints
  and 20 corners. These counts describe the samples. The intersection of the solid cubes is outside their scope.

## Reports, faults and the address

An organ reports 18 numbered private trits followed by eight corners. The model gives the corners geometric
indices. It leaves the assignment of individual private slots to edge midpoints or face centres unspecified.

- `gluing` proves that the reports agree at every shared corner exactly when some body has those five views.
  `view_glue` shows that the constructed body's views reproduce the reports, and `glue_unique` supplies uniqueness.
  Each pair of organs can compare two corners (`two_witnesses`).
- A **seam** is a corner whose owners disagree. With four organs truthful about one common body and one false corner,
  both owners are suspects (by the definition of `suspects`, and observed in the run). The faulty organ owns every
  disagreement (`seam_names_liar`); its co-owner contradicts a false corner (`corner_lie_caught`).
  If all disagreements involve the same neighbour, both remain suspects. A private-only change to agreeing
  reports leaves zero seams and zero suspects (`private_cells_unwitnessed`). Two owners can also report the
  same false value at a shared corner without producing a seam there.
- If the four other organs report truthfully about one common body and the only disagreements are at two corners
  whose only common owner is organ x, the machine's `suspects()` names x alone. `liar_among_suspects` proves that
  the faulty organ is among the suspects when there is a seam. `convicted` says every suspect equals the proposed
  owner; that holds trivially for an empty suspect list, and its common-owner premise holds vacuously for disjoint
  owner pairs. Neither theorem alone states the claim above, and the extra condition matters: seams at corners 0, 1
  and 8 give no suspect in the Wasm file, because no organ owns all three.
- The passed, unknown and failed tallies sum to 26 per report. Their triple is the triangle point
  (`triangle`, `organ_triangle`). Centre health is computed over the 110 cells of an agreeing body. It is 0
  when all passed, 1 when at least one is unknown and none failed, and 2 when any failed.
  `view_cell_in_body` proves that a trit value occurring in a local view occurs in the body. This carries a
  local failure to the centre. The centre has no separate address digit.
- The address encodes all 110 trits injectively. The largest address needs **175 bits** (`address_bits` states it; `fits_22_bytes` is the 22-byte bound), which fits in 22 bytes.
  Each organ can check its own 26 trits against a supplied body. Changing another organ's private trit changes
  the address while preserving the first organ's view. Equal addresses give equal bodies (`address_injective`),
  hence equal centre health (`centre_of_address`).

## What four or three reports determine

Two distinct owners per corner give four-organ coverage. Exactly two corners per pair explain why any three miss
two. For two distinct omitted organs, `blind_corner` selects a corner owned by that pair.

Given the excluded organ's index, `heal` reads all 20 global corners from the four truthful reports, including that
organ's eight corners (`four_see_all`, `heal_true`). The Wasm call reads one corner at a time and requires a fifth
valid report as filler. The excluded organ's 18 private cells remain unknown. The call writes nothing.

The **seal** is the sum of the 20 corner trits modulo three. Any four organs can read this trit from their
truthful local views. Every possible three-organ view is compatible with all three values. For each target,
`seal_hidden_from_three` sets one unseen corner to a value that gives that sum and preserves the three views.
This is possibilistic hiding.
The theorem gives no probabilities. For example, if all corners copy the same random trit `t`, even one organ can
compute the sum as `20t mod 3`. Any caller with an agreeing buffer can read `seal()` directly.
**Do not use this trit as a key or put secrets in it.**

## Sharper statements (`Sharper.lean`)

Written after outside reviews found that some prose said more than the theorems in `Pentora.lean`. Nothing in
`Pentora.lean` or `Entry.lean` changed. Each theorem here says exactly one thing.

- `convicted_alone`: if the four organs other than x report the body truly, and the reports disagree at two corners
  whose only common owner is organ x, then x is a suspect and every suspect equals x.
- `shift_unseen`, `shift_seal`, `shift_cycle`: leave out two different organs x and y, and move the lower corner
  that only they own one step. The other three organs' views are unchanged, the sum modulo three goes up by one, and
  three such moves give back the same body. (`shift_seal` and `shift_cycle` hold for any corner; only `shift_unseen`
  needs the corner that only those two organs own.) It follows, by an argument in prose that is not a Lean theorem,
  that the bodies with one given three-organ view come in cycles of three, one for each sum. This is a counting fact.
  No probability statement is made in Lean.
- `address_bits`: 3^110 < 2^175 and 2^174 < 3^110, so the address needs 175 bits.
- `judge_agrees`: for the Lean function `judge`, a result below 256 implies that the input is well formed (130 bytes of 0, 1 or 2) and the decoded reports have no disagreement. The shipped C/Wasm path is compared with plain code on selected inputs by `check.mjs`; it is not proved equivalent to the Lean function.
- `view_upd`, `bump3`, `seam_code_is_large`: helpers.

## Two figures and the twelve five-point faces (`Twin.lean`)

The golden flip sends φ to 1 - φ. These statements are about lists of listed points; none is about solid cubes.
The two figures share a three-dimensional cube of 27 sampled cells. It is not a flat interface.

- `twin_is_a_pentora`: the 20 flipped points are all different, and the same five index lists pass the same
  distance test there.
- `flip_fixes_cube0`: the listed vertices unchanged by the flip are exactly the eight of cube 0.
- `two_figures_share_one_cube`: each figure's list of cell points (the corners and the middles of all corner pairs
  of each listed cube, at four times size) has 111 points. Exactly 27 points are in both lists, and all 27 are cell
  points of cube 0.
- `rational_cells_are_cube0`: exactly 27 of the figure's 111 cell points have no φ part, and all of them are cell
  points of cube 0. Which cube is "the rational one" depends on the coordinates chosen.
- `shared_corner_three_owners`: each corner of cube 0 lies in exactly one of the other four listed cubes. ("Three
  owners" in a pair of figures is arithmetic, one shared cube plus one cube of each figure; it is not a theorem
  about two figures. It would also need the shared cube to be one reporting identity across both figures, and no
  such protocol exists.)
- `majority_true`: for values a, b, c and t, if at least two of a, b, c equal t then `maj a b c = t`. No machine for
  two figures exists in Lean or in the Wasm file.
- `twelve_faces`, `face_meets_every_cube_once`, `face_has_five_pairs`, `corner_in_three_faces`: the 12 listed
  five-point sets pass a distance test (two neighbours at the edge length and two at squared distance 4); each
  shares exactly two points with each listed cube; their five points have five different owner pairs; each listed
  vertex is in three of them. Flatness (coplanarity) is not checked in Lean, and `twin.py` does not check it either. A reviewer reports
  checking outside Lean that the distance pattern gives a regular planar pentagon, and that each face plane
  holds ten sampled cells (five corners and the five midpoints of their diagonals); being a face also needs the
  other vertices on one side of that plane, which Lean does not check. "Five cells, one byte" therefore describes
  the five corners only.
- `face_fits_a_byte`: 3^5 < 256.

`twin.py` recomputes the same listed-point facts in exact arithmetic. Run `python3 gen.py` first, in the same folder: it writes `tables.json`, which `twin.py` reads (it fails without it).

## The Wasm interface

`interface.c` is the handwritten shim. The shipped `pentora.wasm` is 151,039 bytes, has zero imports and exports
the 12 functions below. Its SHA-256 is `f735a7f915b97c80a7fbca9b6450ff72733f549207702aba3a8b54f8ced3596f`.

Call `reset()`, then call `input(byte)` 130 times. Send five reports in organ order, each with 18 private trits
followed by eight corners in slot order. Input codes are 0 for failed, 1 for unknown and 2 for passed.
`no_seam_one_body` applies to the **decoded reports**. Its premise tests for seams and omits `wellFormed` and
`judge`. For example, 130 bytes of value 3 decode to passes under `reportOf`, but `judge()` rejects the packet.

| Call | Result |
| --- | --- |
| `judge()` | On agreement, 0 through 242 encode the five organ healths in base three, organ 0 lowest. On disagreement, 256 plus the lowest disputed corner index. Malformed input returns `0xFFFFFFFF`. |
| `seams()` | Bit `v` is set for each disputed corner. |
| `suspects()` | Zero when there are no seams. Otherwise bit `c` is set exactly when organ `c` owns every disputed corner. Disputes with no common owner also give zero. |
| `addressByte(i)` | Byte 0 through 21 of the agreeing body's address, lowest byte first. |
| `tally(c, t)` | Number of cells with trit `t` in organ `c`'s report. |
| `seal()`, `centre()` | The corner sum modulo three (not a seal on data) and centre health, respectively. Both return `0xFFFFFFFF` on disagreement. |
| `heal(x, v)` | Corner `v` as reported by one owner other than the supplied index `x`, from a well-formed packet. It does not check that this owner is truthful or find the faulty organ; the result is the true corner only if the four organs other than `x` report truly. |
| `owner(v, w)`, `vertex(c, j)` | For corner `v`, selector zero returns its first owner and any nonzero selector returns its second owner. Vertex lookup returns the global corner at local slot `j` of organ `c`. |

`judge()` reports agreement among the five reports; it is not a safety check and grants no authority.

## What was checked

The seven Lean files that `check.sh` checks declare 97 theorems, including helpers (56 in `Pentora.lean`, one in `Entry.lean`, 11 in `Twin.lean`, 9 in `Sharper.lean`, 12 in `Stamp.lean`, 2 in `StampBytes.lean`, 6 in `Degraded.lean`). Two more files, `Rule.lean` (9) and `ArkPairs.lean` (6), make 112 in all; each is checked by its own optional script (`check-rule.sh`, `check-arkpairs.sh`), and their audits are in `check-rule.txt` and `check-arkpairs.txt`, not in the figures below. The stored axiom audit (`check.txt`) lists 76 of the 97
and 18 list no axioms. It lists no axioms for the six geometry results, none for ten of the eleven `Twin.lean` results (`majority_true` lists
`propext`), and none for `address_bits`. Twelve audited results use `Classical.choice`: `seams_nil_iff`, `no_seam_one_body`, seven in `Stamp.lean` (`go_iff`, `one_part_cannot_force_go`, `honest_go`, `any_part_can_stop`, `two_owners_can_force`, `private_fault_can_be_hidden`, `judge_zero_means_go`) `judge_zero_iff` in `StampBytes.lean`, and `go_gives_go4` and `offline_neighbour_can_force` in `Degraded.lean`. The other axioms appearing in the audit are `propext` and `Quot.sound`. The Lean files checked by `check.sh` and `check-rule.sh` contain no `sorry` (the check output shows none).

The checker loads only the Wasm and computes expected machine outputs in separate JavaScript. Its cube search
closely follows the Python generator. Lean checks the supplied tables. `run-all.sh` invokes both the normal run and the control with a planted wrong verdict, and requires the control to fail on that verdict (`agreeing reports: verdict: got 0, wanted 1`), not merely to exit nonzero.

The authors' run of the checker recorded 11,633 passing comparisons on its normal run and zero failures; rerun `check.mjs` to check this for yourself. It counted five rejected
malformed cases separately. All 400 generated bodies (301 distinct) agreed and matched their expected addresses. The faulty organ
was a suspect in all 391 corner-fault cases and the sole suspect in 241. All 391 recovered the expected corners
with the faulty index supplied. Of 400 private assignments, 256 changed a trit (144 wrote the value already there) and all preserved the zero seam
mask. A review observation, not re-checked here: the
private-change check and the seal check test properties built into the examples, so on their own they cannot catch a
faulty Wasm file. Each of 400 selected triples saw identical reports for two different sums.

The lab reports compiling the executable definitions to Wasm. The Lean audit checks the source and the JavaScript
comparison exercises the shipped bytes. No live integration or outside rebuild is documented here.

## What each part determines of a field on the sphere (a RUN in exact arithmetic; not a Lean theorem)

A field here is a polynomial in x, y, z read on the unit sphere. Degree at most L means (L + 1)² independent
numbers. A set of sample directions DETERMINES degree L when two such fields that agree in every direction of the
set are the same field. `parts.py` computes this for parts of the figure, exactly, using pairs of fractions to stand for numbers of the form a + b·φ (φ the golden ratio)
(about 45 to 60 seconds); its output is `parts.txt`.

| Sample directions | Cells | Determines degree | Numbers |
| --- | --- | --- | --- |
| all five organs | 110 | 9 | 100 |
| any four organs (all 5 choices) | 92 | 7 | 64 |
| any three organs (all 10 choices) | 72 | 7 | 64 |
| any two organs (all 10 choices) | 50 | 5 | 36 |
| any one organ (all 5 choices) | 26 | 3 | 16 |
| corners and edge middles, no face centres | 80 | 7 | 64 |
| the axis cube (one organ) without its face centres | 20 | 3 | 16 |
| the 20 corners / the 30 face centres / the 60 edge middles | 20 / 30 / 60 | 3 / 4 / 5 | 16 / 25 / 36 |

In each row the next degree is NOT determined (the script finds the rank short). The script tests every choice of organs for the degree but prints the cell count for one choice of each size; the counts for the other choices follow from how the cubes and cells overlap and were counted separately. Read each row as a promise with a
condition: IF the field has at most that degree, those samples fix it everywhere on the sphere.

It is NOT a coarse reading of a finer field. If the field has more detail than a part can determine, two different
fields can agree on every sample of the part and still have different averages over the sphere.
Example (exact): the degree-8 field (xy(x² - y²))² is zero at every sample of the axis cube and has a positive
average over the sphere.

What this does not say. (1) It is a computation run on one machine, not a proof in Lean. (2) It is not a better count
than other sample sets: for the same number of directions, directions in general position can determine at least as
many numbers (26 directions in general position determine degree 4, 25 numbers, by an interpolation argument that is not a result of `parts.py`, while one organ's 26 determine degree 3, 16 numbers). A set that contains the opposite of every direction, like these, gives each opposite pair one even and one
odd reading, so 26 such directions give only 13 even readings, fewer than the 15 coefficients of a degree-4 even
part. What the figure adds is that every choice of the same number of organs gives the same highest degree, in exact
arithmetic. (3) Under exact, noiseless measurements and the stated degree bound, the computed ranks show unique determination of the field for these sample sets; nothing is claimed about noisy or adversarial measurements or about recovering an arbitrary stored file. (4) `parts.py` assumes correct readings and supplies no
decoder for wrong reports. (5) This computation examines only the sample directions. (6) It has not been checked
for novelty.

To re-run it: `python3 skunkworks/proved/pentora-machine/parts.py` (about 45 to 60 seconds, Python 3 standard library only) and compare with `parts.txt`. It is not part of `run-all.sh`.

## A rule on six whole numbers (`Rule.lean`)

Twice each outer cell's position has three coordinates of the form a + b·φ, giving six signed whole numbers. `rule` is a test on those six numbers that
reads no list of vertices or cubes: the squared length is 4 or 8 and the point is in a lattice (the second number is
φ times the first and the third φ times the second, each time with both coefficients of the difference even); or the squared length is 12, all six
numbers are even, and half the point less (1, 1, 1) is in that lattice.

- `rule_iff_cell` (uses `propext` and `Quot.sound`): for EVERY point with whole-number parts, of any size, the point
  passes the rule exactly when it is in `cells2`, the list of the 110 outer cells of `Pentora.lean` at twice their position.
- `cells_pass_the_rule` (no axioms): halving the stored cells loses nothing, the 110 are different points, and each
  passes the rule.
- `box_check` (no axioms): the finite check. Among all points whose six squares add to at most 12, each one that
  passes the rule is one of the 110 written out in `cellsLit`; `cells_lit` (no axioms) says that list is `cells2`.
- `small_of_sq`, `rule_norm`, `norm2_a`, `sq_nonneg'`, `all7p_spec`: the bound that makes the finite check complete
  (a point that passes has squares adding to at most 12, so each number is between -3 and 3), and helpers. The
  definitions are `inL` (the lattice test), `allEven`, `halfLessOne`, `halfPt` (halves a stored cell) and `all7p` (the
  search over seven values per number).

`rule.py` repeats the comparison by plain enumeration of all 117,649 points with numbers from -3 to 3: 110 pass, 30,
60 and 20 on the three shells, the same set as the figure built the long way (`rule.txt`).

What this does not say. It is a second, table-free definition of the same 110 points; a stored table answers
membership too. The proof is a bound plus a finite check; it gives no geometric derivation of the rule. "Six whole numbers" is how these coordinates
are written; no statement about a six-dimensional lattice or projection is made. The maintainers measured 48 seconds and 2.79 GB peak (macOS `/usr/bin/time -l`) for checking this file on one laptop, and an outside run on the same laptop took 31 seconds and 2.75 GB (the stored audit does not record those figures), heavier than the other checks, so it is checked separately by the optional `check-rule.sh` (its audit is `check-rule.txt`) and is not part of `run-all.sh`. The
rule itself was suggested by an outside review; the Lean statement, its proof and the enumeration were written here.
We make no claim of novelty. To re-run the enumeration: `python3 skunkworks/proved/pentora-machine/rule.py`.

## The decision stamp (`Stamp.lean`)

Each pair of distinct organs shares two corners. The stamp labels the lower-numbered corner *truth* and the higher-numbered corner *safety*. It reads the five organs’ reports and returns `true` for accept or `false` for reject.

- `corner_order` says that for any two distinct organs, their truth corner has a lower number than their safety corner.
- `corner_owners` says that for either label and any two distinct organs, those two organs are exactly the owners of the selected corner.
- `corner_symm` says that swapping the order of the organs selects the same corner for a given label.
- `corner_kind_iff` says that a corner’s two owners select that corner exactly when the requested label is the one `kindOf` assigns to it.
- `go_iff` says that the stamp accepts exactly when both owners agree at every corner and every cell in every report passed.
- `report_pass_iff` says that every cell in one report passed exactly when all 18 private slots and all eight corner slots in that report passed.
- `one_part_cannot_force_go` says that if a body has a failed or unknown corner and four organs report their true views of that body, the stamp rejects whatever the fifth organ reports.
- `honest_go` says that when all five organs report their true views of a body, the stamp accepts exactly when all its private cells and all its shared corners passed.
- `any_part_can_stop` says that if any organ reports even one failed or unknown cell, the stamp rejects the five reports.
- `two_owners_can_force` gives a body with a corner that did not pass and reports the stamp accepts, with all three organs outside that corner’s owner pair reporting their true views.
- `private_fault_can_be_hidden` gives a body with a private cell that did not pass and reports the stamp accepts, with all four organs other than the cell’s owner reporting their true views.
- `judge_zero_means_go` says that if the Lean function `judge` returns zero for a byte packet, the stamp accepts the reports decoded from that packet.

`stamp.mjs` runs the shipped Pentora Wasm: it builds reports, sends them to `judge()` and compares the result with values it computes separately in the script (PASS on 10 pairs, 2,000 single-organ trials, 500 veto trials and 2 limit cases; a planted wrong expectation makes it fail). It does not read the Lean file.

### What this does not say

*Truth* and *safety* are names for the two corners of a pair. Lean treats each check as a supplied value and assigns it no real-world meaning. In one model example both owners report `.pass` for a shared corner whose body value is `.fail`; in another one organ reports `.pass` for a private cell whose body value is `.unknown`; the stamp accepts both sets of reports. The function `go` reads reports. `Stamp.lean` states one direction (`judge_zero_means_go`: a zero from the Lean function `judge` means the stamp accepts); `StampBytes.lean` adds the other for a well-formed packet. Both are about the Lean function `judge`, not the shipped file; `stamp.mjs` checks the shipped file only on its examples. The Lean `judge` returns 4,294,967,295 for every malformed packet (a byte other than 0, 1 or 2, or the wrong length), and only zero denotes acceptance; on the five malformed examples in `check.mjs` the shipped file returned 4,294,967,295. These theorems impose no requirement that a real system call `go` or `judge` before acting. We make no claim of novelty.

### What `StampBytes.lean` adds

- `go_means_judge_zero` says that if a packet is well formed and the stamp accepts its decoded reports, the Lean function `judge` returns zero.
- `judge_zero_iff` says that the Lean function `judge` returns zero exactly when the packet is well formed and the stamp accepts its five decoded reports. A well-formed packet contains exactly 130 bytes, each with value 0, 1 or 2. The stamp accepts exactly when both owners agree at every shared corner and every reported cell passes.

These are statements about the Lean function `judge`. Verification of the compiled file is outside the scope of these proofs; On its examples, `stamp.mjs` checks the shipped `judge` result against values or ranges specified in JavaScript; some expected values use corner mappings read from the same Wasm file.

To re-run the stamp check: `node skunkworks/proved/pentora-machine/stamp.mjs` (about 0.1 second; `run-all.sh` runs it and its control).

## What the four-report rule checks with one organ offline (`Degraded.lean`)

Choose which of the five organs is offline. The four-report rule ignores that organ’s report. A cell can be marked **pass**, **fail**, or **unknown**.

- `go4_iff` says the rule accepts exactly when every cell in the four remaining reports is marked pass and both owners give the same answer at every corner they can still compare.
- `go_gives_go4` says that if the five-report rule accepts, the four-report rule accepts whichever organ goes offline.
- `honest_go4` says that if the four online organs report their true views, the rule accepts exactly when all their private cells and all 20 corners of the body passed. Every corner still has at least one online owner.
- `one_part_cannot_force_go4` says that if one organ is offline, a second organ may report anything, and the other three report their true views, a failed or unknown corner forces rejection whenever at least one of its owners is among those three.
- `offline_neighbour_can_force` gives an example in which a corner failed, one owner is offline, and the other owner reports a pass. The three organs outside the pair report their true views, and the rule accepts.
- `two_unwitnessed_corners` says that for any choice of offline organ and any other organ, exactly two corners belong to that pair. At those two corners the online organ is the only remaining reporter.

**What this does not say.** Acceptance tells you nothing about the offline organ’s 18 private cells. If an online organ conceals a fault at a corner it shares with the offline organ, the other three have no report of that corner to compare.

`degraded.mjs` computes the four-report rule in JavaScript, because the shipped Wasm has no call for it. It checks that JavaScript copy on generated reports (2,000 visible bad corners and 2,000 hidden shared corners) and, in 2,000 further trials, that the shipped five-report `judge` returns nonzero for a packet with one nonpassing entry and zero after it is repaired, and that the JavaScript rule then accepts the repaired all-pass packet for each of the five offline choices; a planted wrong expectation makes it fail. It does not run the Lean function. To re-run it: `node skunkworks/proved/pentora-machine/degraded.mjs` (a second; `run-all.sh` runs it and its control).

## The ten ARK pieces on the ten pairs (`ArkPairs.lean`)

ARK, defined in `core/Ark.lean`, uses four source parts over GF(256), with four identity rows and six Cauchy rows, labelled 0 to 9. Its theorem `every_four_rows` states that every selection of four distinct row labels has a two-sided inverse. Each of the five organs forms a pair with each of the other four. This file assigns one ARK row label to each pair. The label identifies the encoded piece its two organs would both hold.

- `pairRow_symm` says that swapping the two organs leaves their row label unchanged.
- `pairRow_bijection` says that pairs of distinct organs get labels from 0 through 9, every label is used, and two such pairs get the same label exactly when they consist of the same two organs in either order.
- `organRows_four` says that every organ has four different row labels.
- `organRows_common` says that any two distinct organs have exactly one label in common, the label for their own pair.
- `coverage_counts` says that any one organ covers four labels, any two distinct organs cover seven, any three distinct organs cover nine, and any four distinct organs cover all ten.
- `one_organ_rebuilds` says that each organ’s four rows have a two-sided inverse. For four pieces correctly encoded from the same source with those row labels, applying the inverse recovers all four source parts.

**What this does not say.** If both organs of each pair store its quarter-size piece, the 20 stored pieces occupy five times the source payload in total, one full payload per organ, so there is no storage saving. What the arrangement adds is that each label is assigned to exactly two organs; if both store that piece, they could compare their copies. Nothing here stores, moves, or checks real pieces.

How it is checked. `check-arkpairs.sh` takes the definitions of `core/Ark.lean` (its text up to, not including,
`def checkedMask`) straight from that file each time it runs, and checks `ArkPairs.lean` against them (12 to 13 seconds in the two reported runs). `one_organ_rebuilds` is proved by checking the five organs' own row sets with ARK's stored candidate
inverses; it does not use ARK's general theorem `every_four_rows`. Checking `core/Ark.lean` in full was tried on the laptop this was written on and stopped by a 4 GB memory limit (an author-reported observation). The script refuses to run if the text it takes from `core/Ark.lean` differs from the text `ArkPairs.lean` was checked against (a pinned SHA-256 of that text). This script does not check `every_four_rows`.

Checking `ArkPairs.lean` took 13 seconds and 0.79 GB on one laptop (a second run by the file's author: 12 seconds and 0.61 GB); `check-arkpairs.sh` is not part of `run-all.sh`.
