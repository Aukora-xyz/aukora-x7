# The next line and the lab: what else is in this tree, and how far each piece is checked

The release in this tree is v0.8. Everything on this page is NEWER and LESS CHECKED than v0.8. It is here because
we would rather show the work than a polished subset. Where a folder's own pages disagree with this page, this
page is the later one. `v0.9/PROVED.md`, `v0.9/NOT-PROVED.md` and the same two pages in `v0.10/` are carried lab
pages: their headings still name earlier versions, and they do not yet describe what v0.9 and v0.10 added.

## v0.10: the core that refuses the two old command forms
v0.8's first open defect is that two old command forms (first byte 13 hex, the plain approval; 14 hex, the old key
change) name no record, so one signature is good in more than one record. In `v0.10/` a record that starts BOUND
starts with those two forms on its refused list, and one place in the machine (`Public.lean`) reads that list.

- The law set is 46 laws: the 44, restated where needed, plus `refused_refuses` (a refused form is refused, state
  unchanged) and `essentials_open` (halt, clear, the newer key change, seal and continuation can never be put on
  the list, so the list itself cannot lock the owner out; holding valid keys and the core's finite capacity still
  matter). Index of the v0.10 proofs: [docs/V0.10-PROOF-INDEX.md](docs/V0.10-PROOF-INDEX.md).
- RAN on the compiled small core `v0.10/aukora-core-lite.wasm` (SHA-256
  `c924c72aec0214b59f1f9405ac2c7467b86e2d96985540570ad1896db3c25d93`) and on the full core: in a bound record both
  old forms are refused, signed for that very record or re-addressed from a twin (56 checks,
  `v0.10/tests/independent/readdress.mjs <core> closed`); the timed approval still works; a record started the old
  way behaves exactly as under v0.9 (3,913 steps compared, `twin-cores.mjs`).
- v0.10 was rebuilt from scratch a second time, by a second project builder, from an isolated staged folder on the same Apple-silicon
  Mac; both files came out byte-identical to the pinned digests (23 Nov 2026, the second builder's report). NOT DONE (none documented by this project): a rebuild on other hardware or by someone outside the project.
- PROVED ON EFFECTS (hardening round 1, `hardening/BoundEffects.lean`): in a record started bound, a new grant can
  come only from a timed approval, and the owner's keys can change only by a key change addressed to that record.
  For those two effects there is no other route, in the Lean model.
- NOT PROVED: no other effect is covered by that statement, and two records started with the same descriptor (a
  fork) are not ruled out. No frame can yet CHANGE the list; a record's list is fixed at its start.
- UNCHANGED: in the recorded 3,000-byte-line run, the v0.10 small core trapped after 34,988 lines (102.1 MiB), within one line of v0.8 (one run each, `docs/long-chain-v0.10-lite-3000.txt`); this is not a general length limit.
- An old-start record is exactly as exposed as in v0.8.
- Pages inside `v0.10/` that still describe older behaviour are corrected in [ERRATA](ERRATA.md).

## Hardening round 1 (23 to 24 November 2026)
What was added to make the claims above checkable by anyone, each with a control that is shown to fail when the
thing it guards is broken. `run-all.sh` runs the short versions.
- **What was proved, against what runs** (`drt/model/`). The Lean definitions the laws are about, run by Lean's
  interpreter (no compiled C on that side), with the C shim's bookkeeping restated in Lean, compared line by line
  with the WebAssembly small core on generated input streams: the same output on all 49,131 inputs (night of 23 to
  24 November 2026, one Apple-silicon Mac), 0 differences. Not a proof: interpreter and compiler share Lean's front
  end and intermediate code, and the shim's restatement is ours. A 1,025-input stream with the model's outputs ships
  in `drt/fixtures/`; `run-all.sh` replays it in both v0.10 files, so anyone can check their copy of the core
  against the model's own outputs with Node alone.
- **Compiled files against each other, at scale** (`drt/`). The small and the full v0.10 files, the native twin (the
  same emitted C compiled for 64-bit arm64 against Lean's official runtime), and v0.9 on old-start records, given
  the same generated inputs and compared after every input on the verdict and every exported value. Same night, same
  Mac: the small and the full file agreed on all 1,375,821 inputs, the native twin agreed with WebAssembly on all
  1,375,821, and v0.9 agreed with v0.10 on all 454,061 inputs of old-start records; 0 disagreements. Every refused
  input was also checked to leave every exported value unchanged, and on every input: a frame naming an earlier
  head or position is refused, nothing is admitted while halted, and a v0.10 bound record admits neither old form.
  The same check, run on v0.9, fails, as it should.
- **Named properties, kernel-checked** (`hardening/Obligations.lean`): refusal is a no-op; deny overrides; the order
  of the list does not matter; the list never loses a member; and any history equals a history with the refused
  inputs removed.
- **Effect laws, kernel-checked** (`hardening/BoundEffects.lean`), as above.
- **The form table outside Lean** (`tools/forms.mjs`), checked against the Lean source by a comparison test on the cases it covers, and a
  boundary check (`tools/within.mjs`) that answers within, exceeds or unsupported for two restriction lists.
- **Revertible effects** (`bailiff-rehearsal/revertible.mjs`): each write carries its undo, undo runs newest first,
  and with the core every write and every undo needs its own exact approval. Tested against the three statements
  kernel-checked in `skunkworks/proved/cordis-lean/`.
- **[THREATS.md](THREATS.md)** (who the adversary is, what is trusted, what is out of scope) and
  **[COMPARISON.md](COMPARISON.md)** (this core beside published systems, facts as stated in their sources).
- NOT DONE in round 1 (none documented by this project): a rebuild on other hardware or by someone outside the project; a Linux build; a way for the
  owner to add to a record's refused list; a record that starts from a seal instead of ending in a trap.

## v0.9: the table of forms agrees with the decoder
`v0.9/` (SHA-256 of the small core `61e02592287d31ef8ad2ba13b15a46deff7edfd0de0c8866fe245a641abd2419`) grows the
table to 38 forms and proves in `Proofs/FormsDecoder.lean` that the table and the decoder agree. Two from-scratch builds by project builders on one Mac gave the same bytes. v0.9 does not apply v0.10's bound-start refusal list; each operation still has its normal parsing, state and authorization conditions.

## `standalone-next/`: the adapter for bound records
The released adapter plus the bound start, the newer owner commands, and a refusal to SIGN the two old forms in a
bound record. `node standalone-next/bound-test.mjs v0.10/aukora-core-lite.wasm <its SHA-256> closed`.

## `bailiff-rehearsal/`: an effect that is refused when the core says no
A rehearsal of one effect sink that applies nothing without a current, exact approval admitted by the core; a pure
judge for one kind of promotion (`core-bailiff.mjs`); and a record the core keeps of its own verdicts
(`core-own-record.mjs`). LAB KEYS, made as the tests run. It is wired into nothing. It shows the shape of a lock;
it is not one, because nothing forces a real system to route through it.

## `skunkworks/`: lab pieces, each small, each with its own test
- `proved/backup-checker/`: "this backup only ever grew" as a Lean law (`append_only_iff`) and the same text as a
  72 KB Wasm checker. `backup/` is the plain-code twin with 435 stored vectors.
- `proved/onion-lean/` and `onion/`: a totals tree (a count kept at every level of a hash tree), which checks a
  disclosed region against a commitment the checker kept, as Lean laws, as Wasm, and as plain code, compared with
  each other.
- `proved/governed-organ/`: a small numeric part whose rule is proved in Lean, compiled to Wasm, and replaced only
  through a judged upgrade.
- `proved/cordis-lean/`: five small theorems about revertible effects, a sketch written while reading published
  work on the idea. It is ours, it is a sketch, and it claims nothing about anyone else's system.
- `proved/pentora-machine/` checks 20 listed vertices and five cube distance signatures in Lean. Among the 110
  sampled outer cells, only corners are shared. All five cubes also share the origin. Agreeing reports describe
  one unique body with a lossless 22-byte address. With four truthful organs, one false corner makes both owners
  suspects. The faulty organ owns every disagreement, and it is the sole suspect when the other four organs report
  truthfully and the only disagreements are at two corners whose only common owner is that organ. A private-only change to agreeing reports gives zero suspects. Given the excluded index and a valid
  fifth report as filler, `heal` reads all 20 global corners from the four truthful reports, including the
  excluded organ's eight. Its 18 private cells remain unknown, and the call writes nothing. Any four truthful
  views determine the seal trit. Every possible three-organ view is compatible with all three values
  (possibilistic hiding). Do not use this trit as a key or put secrets in it. `Twin.lean` adds a golden-flipped second figure: the two figures' lists of cell points share
  exactly 27 points, all in cube 0 (listed points, not solid cubes), a majority-of-three law, and twelve listed
  five-point sets that each meet every listed cube. `Sharper.lean` restates five
  claims exactly (a sole suspect with its precondition, the three-organ cycles of bodies, the 175-bit address, and what
  the Lean function `judge` says). The seven Lean files `check.sh` checks declare 97 theorems including helpers, and the stored axiom audit lists 76. `Stamp.lean` (12 theorems) defines a decision stamp over the five reports and states what it can and cannot force, with two limits shown by examples; `StampBytes.lean` (2 theorems) shows that the Lean function `judge` returns zero exactly for a well-formed packet whose decoded reports the stamp accepts; `stamp.mjs` checks the shipped file against values or ranges specified in JavaScript, on its examples only. `Degraded.lean` (6 theorems) states a four-report rule for acting with one organ offline, with its limit shown by an example; `degraded.mjs` checks a JavaScript copy of that rule on generated reports. `ArkPairs.lean` (6 theorems, optional `check-arkpairs.sh`) places ARK's ten rows on the ten pairs of organs; the README states that this stores the data five times over and saves nothing. `Rule.lean`, checked separately and optionally (`check-rule.sh`), adds 9 more theorems: a test on six whole numbers that passes exactly the 110 outer cells. The lab reports compiling the executable
  definitions to Wasm. `run-all.sh` runs the JavaScript comparison and its planted control. The verdict carries
  no authority. No live integration or outside rebuild is documented here.
- `delegation-exhibit/`, `bubble/`, `alibi/`: exhibits of delegation receipts and of two ways to show what a record
  did NOT contain. `alibi/` checks that an item is not in a committed set; it does not show that every read was
  logged.

The check scripts under `skunkworks/proved/` expect a pinned Lean toolchain at a path you set (`LAB`); they were
run in the lab and NOT from this tree. The plain-code tests run from this tree with Node 24; the backup test also needs Python 3 and uses your system's temporary folder (it removes what it makes).
This page documents lab checks, not live enforcement or deployment.
