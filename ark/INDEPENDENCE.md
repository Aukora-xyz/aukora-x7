# INDEPENDENCE record, reader 2 (Go) (acceptance item 15)

Reader 2: machine-written by an AI coding model (its model id was checked at the start), 2026-11-21. Language: **Go 1.26,
standard library only** (`crypto/ed25519`, `crypto/sha256`, `encoding/base64`, `encoding/hex`, own strict JSON
parser; `encoding/json` only in the vector checker to read expected-verdicts.json). Reader 1 (Node): Node. Two languages.
Nothing downloaded (`GOTOOLCHAIN=local GOPROXY=off GOFLAGS=`), no network, no commit, no push.

## Files I read (complete list)
- my written instructions (not published)
- reader 1's hand-off note (not published)
- `CONTRACT.md`
- `vectors/`: `expected-verdicts.json`, `pins.json`, `pins-wrong-owner.json`, `done.demo.txt`,
  the first 1200 bytes of `done.bundle.json`; every other vector bundle was read only by my verifier program, as bytes.
- the private design review, sections 4 and 5 only (lines 113-202; I listed its headings with grep to find them).
- My own files under `b/`, `accept/`, and my own worlds `run/b-dev/`, `run/b-accept-*`.
- Directory listings only (names, not contents): this folder and `vectors/`. An `ls run` printed nothing.

## Commands I ran against reader 1's launchers (as black boxes)
- Probe world `run/b-dev/` (one time): `owner init`, `receiver init`, `receiver pins`, `client-a init`,
  `owner grant` (x2), `owner authority --epoch 1`, `owner deliver --wait-ms 0`, `receiver run-once` (x2),
  `receiver epoch`, `owner approve --yes`; plus my `clientb init|propose|send|collect|export` and `verifier`.
- `accept/run.sh` (once): `owner init|grant|authority|approve|deliver`, `receiver init|pins|run-once
  [--fault drop-answer|drop-request|die-after-effect]|epoch|status|archive|restore`, `client-a init|propose|send|
  collect|note|export`, all in fresh worlds under `run/b-accept-<stamp>/`.

## Results (RAN, by reader 2 (Go), its own code; a run by someone other than its author is the one that counts)
- `b/run-vectors.sh`: 23 of 23 vectors matched (bundle line, OP lines, header lines, exit code).
- `go test ./ark/`: 3 unit tests pass (PAE shape incl. DSSE spec vector, strict JSON, strict base64url).
- `accept/run.sh`, run once: 15 PASS, 0 FAIL, exit 0, about 9 s. World: `run/b-accept-20261121-124510-39025/`
  (log.txt there). The probe world `run/b-dev/` was deleted before the run. Build cache and binaries were
  deleted after the run; run.sh rebuilds them (needs the local Go 1.26 toolchain, nothing downloaded).

## Additions after the mutation test (2026-11-21, second round)
- The mutation test described three weak spots in plain terms, with no file names from `a/`. I read nothing new: no file
  under `a/`, no other world, and no other working file beyond the list above.
- run.sh now has checks 16-19: 16 an old-epoch approval while epoch 2 still lists A's grant (REFUSED STALE_EPOCH, same
  op_id stays REFUSED by R4, new op_id DONE once); 17 an approval for another proposal (APPROVAL_MISMATCH); 18 decision
  refuse (OWNER_REFUSED); 19 an approval naming recv-2 (WRONG_RECEIVER). Check 12 now also asserts REJECTED
  STALE_AUTHORITY for the epoch 1 and 2 replays after the restore, and ACCEPTED for epoch 3 (it already asserted
  REFUSED LOCKED_AFTER_RESTORE exactly).
- New launcher uses: `owner approve --decision refuse` and `owner approve --receiver-id recv-2`.
- RAN once: 19 PASS, 0 FAIL. World `run/b-accept-20261121-125127-50493/`. Contract issues 14-16 were added.

## Round 3: contract v0.1.2 (2026-11-21)
- Read: `CONTRACT.md` v0.1.2 (in full), `vectors/` listing and the two new entries of
  `expected-verdicts.json` (the two new bundles only through my verifier). I did NOT read CONTRACT-DECISIONS.md (it was
  not needed) or anything else; nothing under `a/`.
- Changed: strict parser gains an unsigned-file mode where true/false parse (C21); headers escaped (C22);
  `vectorcheck` compares exact stdout where given.
- RAN: `run-vectors.sh` 25 of 25 matched; `go test ./ark/` pass; `accept/run.sh` once: 19 PASS, 0 FAIL, exit 0
  (world `run/b-accept-20261121-125543-65767/`).

## Round 4: check 20 (2026-11-21)
- Added check 20 in its own fresh world: `owner grant --not-after -1000` (an already expired grant for client A),
  listed in an epoch-2 authority, a proposal under it with a fresh epoch-2 approval: must be REFUSED GRANT_EXPIRED,
  no effect. Read nothing new; nothing under `a/`.
- RAN once: `accept/run.sh` 20 PASS, 0 FAIL, exit 0 (world `run/b-accept-20261121-125804-67599/`).

## Issues log
`CONTRACT-ISSUES.md` (18 entries; none changed a vector result).

## Independence statement
I never opened, listed, grepped or read anything under `a/` other than running the three launchers
`a/bin/receiver`, `a/bin/owner`, `a/bin/client-a` and reading their printed output (and the request
and answer files they wrote inside my own worlds), and I read no other session's world under `run/`.

## Limits of this independence (UNVERIFIED beyond this)
Readers 1 and 2 were written by AI models of the same family. Two languages help; a third verifier by a model of another
family was asked for before any freeze (acceptance list, "claims still unproven"). Reader 3 (Swift, `c/`) is that verifier.
