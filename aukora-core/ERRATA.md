# Errata: where an older page in this tree is out of date

Released and frozen folders (`v0.1/` to `v0.10/`) are not edited after their build, because their pages are pinned
with the files. Where one of their pages is now out of date, the correction is here. This page wins over them.

1. **v0.10 refuses the two old command forms in bound records.** `v0.10/WIRE.md` (the "Plain approval … or legacy
   key change" row, line 90) and `v0.10/NOT-PROVED.md` (item 7, lines 20 to 24) still describe the behaviour
   inherited from v0.6, where both forms are admitted. In v0.10, a record started BOUND refuses both decoded forms,
   whatever record or head their bytes name (`v0.10/Proofs/BoundRefuses.lean`, `bound_refuses_legacy`, lines 37 to
   54). Records started the old way keep the earlier behaviour. This does not rule out two records started with the
   same descriptor (a fork), or an equivalent effect reached through some other form; for two effects, a new grant
   and an owner key change, `hardening/BoundEffects.lean` proves there is no other route in a bound record.
2. **`v0.10/PROVED.md` describes an earlier law set** (its heading names v0.6 and 42 fields). v0.10's own index is
   [docs/V0.10-PROOF-INDEX.md](docs/V0.10-PROOF-INDEX.md).
3. **The end of a record was measured on the shipped files.** `v0.8/NOT-PROVED.md` (item on the record's end) says
   the trap was seen on an earlier core and "not re-measured on these bytes". It has since been measured on the
   shipped small cores, one run each on one Mac, lines of 3,000 bytes: v0.8 traps after 34,987 lines and v0.10 after
   34,988 lines (102.1 MiB, 68 sealed segments), and afterwards nothing can be added, not even a seal. One run, not a
   capacity. The run logs: `docs/long-chain-v0.8-lite-3000.txt` and `docs/long-chain-v0.10-lite-3000.txt`.
4. **`examples/make-sample.mjs`**: its comment said the sample approval lasts "until line 7". The signed expiry is 6,
   inclusive (the record's frame 6), as `examples/read-record.mjs` prints.
5. **`RELEASE-README.md`** (written for v0.5) and **`REBUILD.md`** (the rebuild of an early core, "Core5") are
   historical. Start from [README.md](README.md) and [docs/WHERE-THINGS-ARE.md](docs/WHERE-THINGS-ARE.md).
