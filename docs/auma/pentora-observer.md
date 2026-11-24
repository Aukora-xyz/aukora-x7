# Pentora partial-view observer

`x6_cell { action: "observe", input: { mode: "info" } }` names the observer profile, matrix digest, field, scale and limits. Add `node: 0` (or another packet index from 0 through 109) to ask which of its codec components carry equations. Packet indices match `pentora.encode`, not geometry-table IDs (the shared center is omitted).

To evaluate, pass `input: { profile, matrixSha256, snapshot, readings, claim, suggestNext? }`. Copy the profile and digest from `info`. Group only readings from the same snapshot; its 64-hex label is caller-supplied, not a freshness or authenticity proof. A reading is `{ node, component, value }` with the numerator reduced to a canonical residue 0 through 2,147,483,646. Submit one coefficient block, at most 96 distinct active rows. Leave structurally zero components out. The instrument never gets data from the network, storage or an organ by itself.

The claims are `{ kind: "coefficient", slot: 0 }` (any slot 0 through 71) and `{ kind: "spherical-mean" }`. The latter gives the two components of the normalized degree-five spherical mean in the golden basis, reduced into the field; it is not a raw surface integral, center-point value, or a general owner-window integral.

- `KNOWN`: the field claim is determined by the supplied observations under the pinned model. Its certificate combines those exact input rows into the claim.
- `UNDETERMINED`: two explicit abstract field states fit the same observations and give different answers. This does not assert two valid int16 codec states or any privacy guarantee.
- `DISAGREE`: the row combination is zero for every model state but its combined reading is nonzero. It does not assign blame.
- Input and work-limit refusals are errors, not evidence of certainty. A bounded, deterministic next-reading suggestion favors immediate claim gain, then rank gain, then fewer additional scalars. It is a greedy suggestion, not a globally minimal schedule.

These results never admit an operation, pin a cell, change Aura flow, or replace signed receipts. Consistent observations can still come from the wrong state or be stale. The same equation matrix with node labels removed is an equal-read control; it reaches the same conclusion. No superiority over erasure codes, full computation verification, or better wire cost is claimed.

## Checks

```sh
node server/pentora-epistemic.build.mjs
node --test deploy/cloudflare/src/__tests__/pentora-epistemic.test.mjs
```

The first checks the generated compact active-row table against the pinned carrier. The second independently checks certificates, a twin and syndrome against that matrix. In one synthetic fixture, 80 corner scalars determine the mean but leave a 32-dimensional field nullspace. These checks do not constitute live acceptance; the lead gates the branch and the inside-runtime smoke is `x6_cell` `observe` `info`, followed by one supplied same-snapshot fixture.
