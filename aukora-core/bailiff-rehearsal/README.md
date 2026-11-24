# Bailiff, rehearsal (lab only, LAB KEYS)

One effect sink that refuses without a current, exact permit from the core. `bailiff.mjs` is 41 lines over the
RELEASED adapter (`../standalone/aukora.mjs`), unchanged, and a byte-pinned core. It decides nothing itself.

Run: `node bailiff-rehearsal/test.mjs` (default: the lab's pinned v0.1 small core), or
`BAILIFF_CORE=$PWD/v0.5/aukora-core-lite.wasm node bailiff-rehearsal/test.mjs` (the 37-law small core, `8e7cca36…`).

## The three checks
1. CONTINUITY: the stored record replays in a fresh core and extends the head this sink last acknowledged.
2. PERMIT: an act frame built from the bytes about to be applied is admitted by the core. The intent is
   `SHA-256(patch) ‖ base` for the audience `x6.1/promotion/v1`, with the owner generation and a number used once.
3. RECORD WITH THE EFFECT: the new record and head are stored first, then the effect is made. It fails closed.

## CHECKED (RAN, 25 of 25, on the v0.1 small core and on v0.5 small and full)
Refused: no record; no approval; a stranger's approval; one changed byte in the patch; the same patch on another
base; the same patch under another number; the same permit a second time; an expired approval; a cancelled
approval; the record rolled back to before the act; an early line of the record changed; a record from the owner's
tool that forgets a spent act. Applied, once each: the exact approved bytes on the exact base. A core file that
is not a pinned release is not loaded at all.

## NOT true of this rehearsal
- The keys are LAB keys made by the test. Who holds the owner's two keys, and how his fingerprint releases a
  signature, does not exist and is the owner's decision.
- It is a sink in a test folder. Nothing shows it is the ONLY path that can write a tree; in the real system that is
  the whole point and the core cannot see a second path.
- The approvals are the head-signed timed form only. The core underneath would still admit the two old forms that
  name no record (readiness blocker 12) if the owner's keys ever signed one; this sink never submits an approval.
- Old-start record on the released line. 512 lines per segment, no seal handling here, end of life near 35,000 lines
  (blocker 13).
- "Record first, then effect" is two file writes here, not one transaction.
- Not wired into anything. Not in any application.

## The same sink on a BOUND record (`bailiff-bound.mjs`, `test-bound.mjs`; lab cores, LAB KEYS)
Run: `BAILIFF_CORE=$PWD/v0.8/aukora-core-lite.wasm node bailiff-rehearsal/test-bound.mjs [open|closed]`.
One more check, before the other three: IDENTITY. The sink pins the identifier of the record it was set up for;
every record it is handed must replay to that identifier. It uses the next-line adapter (`../standalone-next/`).
CHECKED (RAN, 16 of 16 on v0.8 small and full): an old-start record is not taken; a twin record of the same owner
is refused (`RECORD_NOT_THIS_ONE`), also when it carries a valid approval for the same patch; that approval frame
alone is refused by the core in the other record; a changed host value is refused as another record; and the
permit, reuse, changed-byte and roll-back refusals as before.
WATCH: the test signs ONE old-form approval (the form that names no record), uses it in a twin record, then
re-addresses the same signatures into this record. On v0.8 the sink then applies the patch: `YES (still open in
this core)`. That is readiness blocker 12 seen at the sink. When the core refuses those forms in bound records
(root v2 step 3a), run with `closed`: the line must read `NO`.
