# Glossary

English | [中文](GLOSSARY.zh.md)

Plain words sit beside the project word. A definition here is not an authority grant.

| Project word | Plain words | Label |
|---|---|---|
| Ball | A content-addressed bundle of modules. The id is a SHA-256 of a manifest preimage. | SOURCE: `computeBallId` and `manifestId` |
| Organ | One Cordis plugin entry inside a ball (`entries` on the manifest). | SOURCE: ball entry records |
| Epoch | The integer version field on a ball manifest. | SOURCE: `epoch` on `x6.1-ball/v1` |
| Receipt | One append-only JSON line. Its leaf hash chains to the previous line. The line is not required to be signed. | SOURCE: `seed-receipts.js` append |
| Checkpoint | An Ed25519 signature over a Merkle root and a receipt count. It authenticates that prefix of the log. It is not a passkey. | SOURCE: `seed-receipts.js` checkpoint |
| Head | The selected manifest in `HEAD.json`. Its `parentBallId` is a field on that file, not a checked walk. | SOURCE: `HEAD.json` and the readout |
| Promote edge | Receipt data `{ ballId, parentBallId, epoch }` on `tree.patch`, `tree.undo`, `snapshot.restore`, `seed.bootstrap`, `ball.promote`, or `ball.epochN`. | SOURCE: loader `completeMutation` and the receipt log |
| Lineage `promoted` | A single intact edge path from the grant ball to the selected ball, epochs stepping by one, last epoch equal to the head. It does not make the mandate `owner-confirmed`. | SOURCE: `authority.ts` |
| Lineage `head-claim-only` | The head's parent field names the grant ball, and no unique intact edge path does. | SOURCE: `authority.ts` |
| Fork | Two intact edges leave the same parent toward different balls. The readout does not pick one. | SOURCE: `promote-fork` |
| Mandate | A recorded grant of scope for work. Owner confirmation is a separate check. | SOURCE: superagent status and `mandate.grant` |
| Model door | A same-origin `/door/<provider>/` rewrite in front of a model API. | SOURCE: `model-doors.ts` |
| Pinned signer | A public key compiled into the readout. A key that merely appears in a file is not pinned. | SOURCE: `PINNED_RECEIPT_SIGNERS` |

**SOURCE.** Host publication requires the next epoch to be exactly one greater (`server/ball-head.mjs`). **SOURCE.** The receipt organ does not apply that rule when it appends a line. Monotonicity is not a property of every log.
