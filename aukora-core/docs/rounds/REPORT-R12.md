ROOT v1: one machine, 36 laws, composed no; package bound yes | JUDGE LINEAGE: byte-compared yes (option c, fixed executable) | BOUNDS: memory max yes, staging limit yes, record policy yes | HOSTILE PROOFS: 21 tried, 0 traps, 0 over 10 s | CELL EVENT: laws 3 of 3

**The full machine cannot satisfy ROOT v1 as specified.** Lean accepted the revised L2 on that machine, including exact raw and decoded histories. It also accepted a concrete unsigned halt that violates two other frozen safety clauses. D5 and P1 each require *every* admitted non-install frame to decode under the old grammar, even when risk and grant rules stay identical. A valid clear produces the same contradiction for any model promising H5. L8 independently pins the old checker goal, which the full model violates. Availability qualifiers cannot repair these safety predicates. [Counterexamples](v0.3/Proofs/Root12Conflict.lean) · [Versioned L2](v0.3/Proofs/Root12Record.lean) · [L8 and the combined contract](v0.3/Root12.lean)

**Audit of the frozen clauses.** S constrains an outcome. A promises success. ROOT v1 conditions A on an unhalted machine and permission under recorded owner rules. H5 requires valid clear and rebind from every state. Across all 36 clauses, E5 also fixes the baseline speech verdict, including valid speech during a halt. L2 itself contains only safety. [Conjunct-by-conjunct audit](logs/r12/root-audit.md) · [Safety projections](v0.3/Laws.lean)

| Clause | Safety and availability | Clause | Safety and availability |
|---|---|---|---|
| L1 | S replay and staging-only effects. A feed and reset. | L2 | S exact records, accepted grammar, active line IDs. |
| L3 | S stale address refuses unchanged. | L4 | S current grant, logged spend, no reuse without reissue. |
| L5 | S passive events preserve authority and rules. | L6 | S aligned advice preserves verdicts and authority. |
| L7 | S rebind clears grants/rules and bars old spends. | L8 | S checked model, proof, staged file and exact grant spend. |
| L9 | S claims grow, corrections preserve provenance. | L10 | S historical confirmation and latest decoded report. |
| H1 | S empty genesis pool/history and signed grant origin. | H2 | S key changes require legacy rebind and both signatures. |
| H3 | S both signatures on owner control and cancellation. | D1 | S higher score preserves refusal. |
| D2 | S signature and grant floors for rebind, installs and deliveries. | D3 | S zero initial threshold and signed changes. A valid controls. |
| D4 | S missing assessment forces grant route and score 255. | D5 | S route, score, bundle and closed risk grammar. A assessments. |
| S1 | S exact stamp-only effect. A valid stamps. | P1 | S targeted removal, generation, other grants and closed rule grammar. A revocations. |
| P2 | S signed inclusive cutoff and continued closure. A timed issues. | O1 | S correction intent, code and report order. A reports. |
| O2 | S preserve all earlier outcomes. | | |

**Gate and lineage.** Lean reused R11’s evidence, safe-state and succession proofs to establish all 13 obligations on the full model. The full Wasm pinned all 36. Its transition witness also commits descendants to every parser slot of the submitted machine. Same-set and 37-clause packages passed the transition check and failed satisfaction. The gate rejected the submitted transition witness for each of 12 one-law omissions. The round-nine file failed executable comparison. ROOT v1 weakens availability relative to v0.1. Moving from either earlier lab ratchet would break law lineage. All 193 accepted frames in four v0.1 non-install records replayed exactly. The old install grant replayed, then the install failed. [Wasm verdicts](logs/r12/gate-wasm.log) · [Witnesses](logs/r12/native-witnesses.log) · [Replay](logs/r12/record-compatibility.log)

The owner signs commitments to the file and both certificate blobs. All **440** proof mutations failed the binding check. The authentic bytes passed binding, then failed satisfaction. The judge comparison covers the actual compiled checker, runtime, goal constructor and initialized declaration bytes. Weakening a named test law in the embedded environment failed comparison. The unchanged executable passed. The comparison fixes every executable handler. Whether those handlers implement the carried model, and whether the host continues the ledger, remain unproved. [Binding sweep](logs/r12/package-binding.log) · [Judge test](logs/r12/judge-wasm.log)

**Finite sessions.** Both files cap WebAssembly memory at 256 MiB and allow 16 MiB staged. The record stops at 512 entries or 2 MiB, shared with stamps. The same signed clear succeeded with room and failed at capacity. The staging cap also limits L1’s open-state feed promise. Lean proved refusal preserves state in this finite model. Runtime allocation can still trap. The checker budgets 100,000 counted operations per invocation. The 21 cases included a 1 MiB certificate and 24 nested lets. Pathological reduction time remains unmeasured. [Limits and cases](logs/R12-CHECKS.txt)

**Cell receipts.** Lean checked prior committed output, passive authority and lite replay. Both files matched all 200 vectors, admitted 168 frames and reproduced the same head from their exported records. This was a synthetic lab session. [Proofs](v0.3/Proofs/Cell12.lean) · [Replay output](logs/r12/cell-wasm.log)

The clean rebuild reproduced 40 SHA-256 pins. Final disk use was 827,852 KiB for the lab, excluding the two reserved folders, and 9,164 KiB for v0.3. [Build and cleanup](logs/R12-CHECKS.txt)
