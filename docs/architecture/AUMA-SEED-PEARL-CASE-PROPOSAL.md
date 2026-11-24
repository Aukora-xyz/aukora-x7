# Proposed seed-pearl retention case

**Proposed.** Confirm the input fields before adding the case.

## Why this exists

The retention suite used as a test fixture has no case for `seed-pearl` or `auma-scion`. The proposed case exercises the promotion judge itself.

## Test fixture

The synthetic fixture at `packages/experimental/webworker-runtime/tests/x6/fixtures/retention-suite-approved.json` contains 21 cases and 10 fixtures. Its cases exercise eight organs. One example is `receipts.chain.verify`.

```json
{ "id": "receipts.chain.verify", "scar": null,
  "args": { "organ": "seed-receipts", "fixture": "two-receipts",
            "input": { "action": "verify" }, "pick": ["receiptsVerified"] },
  "expect": { "ok": true, "receiptsVerified": 2 } }
```

`seed-pearl` exposes exactly four actions: **`observe | remember | challenge | seed`**.

In `mirror/home/auma/seed/organs/seed-pearl.js`, equal pass counts give `winnerId: null`. The proposed case expects `decidedBy: "inconclusive"` and `qualifiedForPromotion: false`.

## The proposed case

```json
{
  "id": "pearl.tie.inconclusive",
  "scar": null,
  "args": {
    "organ": "seed-pearl",
    "fixture": "base",
    "input": {
      "action": "challenge",
      "candidates": [
        { "label": "arm-a", "specifier": "<ball that passes every case>" },
        { "label": "arm-b", "specifier": "<different ball that passes every case>" }
      ]
    },
    "pick": ["decidedBy", "qualifiedForPromotion", "winnerId"]
  },
  "expect": { "ok": true, "decidedBy": "inconclusive",
              "qualifiedForPromotion": false, "winnerId": null }
}
```

**Why it discriminates and does not just add coverage:** both arms pass all cases, so pass-count
cannot separate them. The only observable difference is the tie policy. A case where one arm passes
more would test the arena, not this organ — which is exactly the redundancy error that has filled
this suite with cases that agree on both arms.

## What is unconfirmed, and must be before merging

1. The exact key the `challenge` action reads for candidate specifiers (`candidates`? `arms`?
   `candidateA`/`candidateB`?) — read from `seed-pearl.js` before writing the case.
2. Whether a trial inside a retention fixture can load two distinct ball specifiers, or whether it
   needs a fixture that already holds both. If it cannot, the correct location for this test is the
   arena's own test suite, not the retention suite — and saying so is more honest than shipping a
   case that ties for the wrong reason.
3. `winnerId` must be checked to be absent rather than `null` if `pick` returns `undefined`, per the
   canonical-JSON grading rule (`expect` must contain `ok` and exactly the picked keys).
