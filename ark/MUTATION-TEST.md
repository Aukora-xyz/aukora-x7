# Mutation test of accept/run.sh (2026-11-21)

Tag: RAN (every line below was observed in a run in a scratch copy; nothing is a plan).

## Setup
- Scratch copy: `proof-mut/`, a copy of this folder (cp -R, `run/` emptied) made beside it. The original was not modified; this file is the only thing written in it.
- `accept/run.sh` needed NO edit: it derives its root from its own location (`P="$(cd "$(dirname "$0")/.." && pwd)"`), so the copy ran against its own `a/bin` launchers and `b/` Go tools.
- Only `proof-mut/a/receiver.mjs` was ever changed, one mutation at a time. After each run it was restored from `a/receiver.mjs` and checked byte-identical with `diff` (REVERTED-OK each time).
- Each run took about 11 s. One run at a time.

## Baseline (unmodified copy)
`accept: 15 PASS, 0 FAIL`

## Results

| Mutation | Applied | Checks that turned FAIL | Verdict |
|---|---|---|---|
| M1 epoch not enforced | `receiver.mjs:170` the line `if (a.obj.epoch !== epoch) return refuse('STALE_EPOCH')` commented out, so an approval signed at an older epoch is accepted | none | **SURVIVED** (still 15 PASS, 0 FAIL) |
| M2 op ids not remembered | `receiver.mjs:139` `const stored = storedOutcome(H, op)` replaced by `const stored = null`, so a retry with the same op id runs the effect again | 5, 6, 8, 9, 10 (sub-checks e and f), 12 | CAUGHT (6 FAIL, 9 PASS) |
| M3 no write lock after restore | `receiver.mjs:158` the line `if (restoreInfo(H)) return refuse('LOCKED_AFTER_RESTORE')` commented out | 12 | CAUGHT (but see the note below: it was caught only on the reason code) |
| M4 effect without approval | `receiver.mjs:165-171` the NO_APPROVAL refusal skipped (approval checks run only when an approval is present), plus null guards at 177, 179, 183 so the code does not crash on a missing approval | 13 | CAUGHT |
| M5 lost answer reported as DONE | not applied | n/a | SKIPPED (see below) |

### Supplementary runs (extra, same method, each reverted)
| Variant | Applied | FAIL | Verdict |
|---|---|---|---|
| M1b epoch + grant-in-authority both removed | `receiver.mjs:160` (GRANT_NOT_IN_AUTHORITY) and `:170` (STALE_EPOCH) commented out | 10 (sub-checks b and f) | CAUGHT. 10(b) answered `DONE OK` for the epoch-1 approval. |
| M3b faithful M3: restore reinstalls the newest archived authority as current and writes no lock file | `receiver.mjs:293` replaced | 12 (write at the restored epoch answered `DONE OK`; epoch showed `epoch 2`, no lock) | CAUGHT, on the effect itself |
| M4w every approval check skipped (decision, proposal match, receiver, epoch, expiry, plus NO_APPROVAL) | `receiver.mjs:165-171` wrapped in `if (false)` | 13, 14 | CAUGHT |
| (accidental) M1 + SCOPE_MISMATCH line removed, wrong line number | `:163` and `:170` | 11 (answer `REFUSED UNSUPPORTED_ACTION` instead of `SCOPE_MISMATCH`) | not a requested mutation; shows check 11 pins the reason code |

## Findings

1. **M1 SURVIVED. This is the important one.** The acceptance script has no check that fails when the receiver stops enforcing the approval epoch (`STALE_EPOCH`). Why (observed in the baseline output, check 10 line): the only "old-epoch approval" test, 10(b), is answered `REFUSED GRANT_NOT_IN_AUTHORITY`, not `STALE_EPOCH`. The epoch-2 authority drops grant A, so the grant check at line 160 refuses first and the epoch check at line 170 is never reached. 10(b) only asserts that the status starts with `REFUSED` and that no line was written, so it passes either way. Check 12 only uses approvals signed at the current epoch (2, then 3). When both line 160 and line 170 are removed (M1b), 10(b) turns `DONE OK` and check 10 FAILs, which confirms the epoch rule has no independent coverage today. A test that would catch it: an old-epoch approval for a grant that is still listed in the new authority (epoch 2 authority that keeps grant A, an approval signed at epoch 1, expect `REFUSED STALE_EPOCH`).
2. **M3 is caught only on the reason code in its simple form.** With just the lock check removed (M3a), a write after restore is still refused, but as `NO_AUTHORITY`, because restore does not install an authority (line 270 records it in history only). Check 12 fails because it requires the exact `LOCKED_AFTER_RESTORE`. That is good (the check is strict), but it means the script does not independently prove "no effect after restore without a new owner statement"; it relies on the reason string. In the faithful variant M3b (authority reinstalled, no lock) the write executes `DONE OK` and check 12 fails on that too.
3. **M4 narrow (no approval at all) is caught only by check 13.** Check 4 (verifier vectors and live bundles) and check 14 do not touch the receiver's NO_APPROVAL path, so they stayed PASS. With every approval check skipped (M4w) only 13 and 14 fail: no live receiver test fails for an approval that is for another proposal (`APPROVAL_MISMATCH`), a deny decision (`OWNER_REFUSED`) or an approval for another receiver. (Inference from M4w: those three receiver checks are also skipped in M4w and nothing but 13 and 14 failed; the Go verifier is tested on a mismatch vector, but the receiver path is not.)
4. **M2 is broadly covered** (5, 6, 8, 9, 10e, 12), as expected. Checks 7 and 11 did not fail under M2.

## M5 skipped
The "lost answer" fault is test-only injection in the receiver (`--fault drop-answer` just does not write the `.ans.json`, lines 232-235). The UNKNOWN semantics live in the clients (missing answer means exit 3, UNKNOWN) and the Go verifier (no outcome in the bundle means UNKNOWN), so the only simple way to get "DONE for a lost answer" is to change the client or the verifier to treat a missing answer as DONE. That is outside the receiver code this task allowed, so I did not do it. A receiver-only change (make `drop-answer` still write the answer) just disables the fault and trivially fails check 7; it says nothing useful, so I did not count it.

## Not done
- No client-side or verifier-side mutation (M5 client variant) was run.
- No mutation of the Go tools in `b/`.
- Only single mutations; no combinations besides the supplementary M1b.
- `proof-mut/` deleted at the end; run logs of the mutation runs are gone with it.

---

# Round 2 (2026-11-21, 19-check acceptance)

Tag: RAN. Same method as round 1: fresh scratch copy `proof-mut/` (cp -R of this folder, `run/` emptied), only `proof-mut/a/receiver.mjs` changed, one mutation at a time, restored from `a/receiver.mjs` and confirmed identical after each run. The receiver in `a` was byte-identical to round 1's (checked with `diff` before the baseline). `vectors/` and `CONTRACT.md` were not touched. Nothing in this folder changed except this file. `proof-mut/` deleted at the end.

## Baseline
`accept: 19 PASS, 0 FAIL` on the first copy (no second copy needed).

## Results

| Mutation | Applied | Checks that turned FAIL | Verdict |
|---|---|---|---|
| M1 epoch not enforced | `receiver.mjs:170` STALE_EPOCH refusal commented out | 16 | CAUGHT (round 1 SURVIVED; the new check 16 closes the gap: old-epoch approval, grant still listed, now answers `DONE OK` and an extra line is written) |
| M3a simple: no lock check | `receiver.mjs:158` LOCKED_AFTER_RESTORE refusal commented out | 12 | CAUGHT (write is refused as `NO_AUTHORITY`, check 12 pins the exact reason) |
| M3b full: restore reinstalls newest authority, no lock file | `receiver.mjs:293` lock-file write replaced by installing the highest archived authority as current | 12 | CAUGHT (post-restore write answers `DONE OK`, epoch reads `epoch 2` with no lock) |
| M4 approval checks skipped | `receiver.mjs:165-171` all approval checks wrapped in `if (false)`, plus null guards at 177, 179, 183 | 13, 14, 16, 17, 18, 19 | CAUGHT (each of the six answers `DONE OK`) |
| M6 refuse decision treated as approval | `receiver.mjs:167` OWNER_REFUSED refusal commented out | 18, 19 | CAUGHT (18 is the real catch: `DONE OK`. 19 is a knock-on, see note 1) |
| M7 approval for a different proposal accepted | `receiver.mjs:168` APPROVAL_MISMATCH refusal commented out | 17, 18, 19 | CAUGHT (17 is the real catch: `DONE OK`. 18 and 19 are knock-ons, see note 1) |
| M8 approval naming another receiver accepted | `receiver.mjs:169` (the approval's) WRONG_RECEIVER refusal commented out | 19 | CAUGHT (`DONE OK`) |
| M9 grant not_after not checked | `receiver.mjs:162` GRANT_EXPIRED refusal commented out (the rule exists) | none | **SURVIVED** (still 19 PASS, 0 FAIL) |

## Findings

1. **M9 SURVIVED.** The receiver does have the rule (`if (at > g.obj.not_after) return refuse('GRANT_EXPIRED')`, line 162), and `run.sh` never mentions `GRANT_EXPIRED`. Guess (not run): every grant in every world is minted by `setup()` with `--not-after +86400000`, so no test ever presents an expired grant. The owner tool reads `--not-after` through the same `parseTime` as approvals (owner.mjs lines 36 and 66), and check 14 already uses `-1000` for an approval, so a test with `owner grant ... --not-after -1000`, then a fresh approval, expecting `REFUSED GRANT_EXPIRED` and no effect, should close it.
2. **Knock-on FAILs in checks 17-19.** Checks 17, 18 and 19 share one world (`w17`) and each asserts total lines = 0. When M6 or M7 lets one effect through, the lines left in that shared world also fail the later checks even though their answers are correct (M6: check 19 answers `REFUSED WRONG_RECEIVER` correctly but fails on `lines 1`; M7: check 18 answers `REFUSED OWNER_REFUSED` correctly but fails on `lines 1`). Harmless for catching the mutation, but the extra FAIL numbers are not independent evidence.
3. **M1 is now covered**: only check 16 turns FAIL; the baseline note that 10(b) is shadowed by `GRANT_NOT_IN_AUTHORITY` still holds for check 10, so check 16 is the sole guard for STALE_EPOCH.
4. **M3**: both variants fail only check 12, the sole guard for the post-restore lock (the new exact-reason assertions in 12 are what catch M3a).
5. **M4** shows the six approval-dependent checks (13, 14, 16, 17, 18, 19) cover the receiver's approval path.

## Not done (round 2)
- No client-side, verifier-side or Go-tool mutation; M5 (lost answer reported as DONE) still not run.
- Only single mutations (M4 is one multi-line change). No combinations.
- M9's closing test was not written or run; it is only a suggestion.

---

# Round 3 (2026-11-21, 20-check acceptance, M9 only)

Tag: RAN. Same method: fresh scratch copy `proof-mut/` (cp -R of this folder, `run/` emptied), receiver in the copy confirmed identical to `a/receiver.mjs` before the mutation, one mutation, restored and confirmed identical afterwards. Nothing in this folder changed except this file. `proof-mut/` deleted at the end.

## Baseline
`accept: 20 PASS, 0 FAIL` on the first copy.

## Result
| Mutation | Applied | Checks that turned FAIL | Verdict |
|---|---|---|---|
| M9 grant not_after not checked | `receiver.mjs:162` GRANT_EXPIRED refusal commented out | 20 | CAUGHT (an expired grant listed in the current authority, with a fresh valid approval, answered `DONE OK` and wrote 1 line; round 2 SURVIVED, the new check 20 closes the gap) |

Not done: still no client-side, verifier-side or Go-tool mutation, and M5 (lost answer reported as DONE) not run.
