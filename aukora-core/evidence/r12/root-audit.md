| Frozen clause | Safety (S) and availability (A), by conjunct |
|---|---|
| L1 replay | S: dropping refused frames/stamps preserves replay. S+A: total feed appends every byte and reset clears staging, with every other field fixed. |
| L2 record | S: exact raw append order, every admission decodes, exact projected ledger history, active IDs resolve. No A: the premise already requires acceptance. |
| L3 stale | S: wrong parent or sequence means refusal and the same state. |
| L4 once | S: preexisting current-generation grant, admission logged, grant consumed, no further use without a new signed issue. |
| L5 passive | S: accepted legacy passive frames preserve owner, ledger authority and grant rules. |
| L6 advice | S: two aligned runs preserve equal authority and equal verdicts. Both may refuse. |
| L7 restore | S: accepted legacy rebind clears rules/pool, increments generation and prevents old spends in every continuation. |
| L8 upgrade | S: a core change demands tag 27, decoded package, original checker success, eligible grant, staged model/file digests, target/body equality and grant spending. Exact file equality assumes no collision. |
| L9 memory | S: claims grow by suffix, accepted corrections preserve claims, each reachable claim has earlier accepted provenance. |
| L10 outcome | S: historic confirmed/unknown reflect accepted reports. The findings list and latest query equal the old report decoder's result. |
| H1 grants | S: every new grant has signed provenance. Successful genesis empties history/pool, every reachable grant is signed. |
| H2 binding | S: any key change decodes as an old rebind with both signatures. Accepted old rebind installs the named keys with both signatures. |
| H3 control | S: old owner controls and single-grant cancels require both signatures. |
| D1 monotone | S: raising only the risk score preserves a refusal. |
| D2 floor | S: installs spend an exact signed grant, old rebind needs both keys, high-score deliveries spend a signed grant. |
| D3 threshold | S: initial threshold zero, changes need a decoded signed threshold control. A: every reference-valid threshold control succeeds. |
| D4 missing | S: missing assessment requires grant route, default digest, recorded score 255 and missing flag. |
| D5 bundle | S: accepted delivery records exact route, bundle and score. S: every frame must decode as install or old risk transition. A: reference-valid assessments succeed. |
| S1 stamping | S: success appends only the stamp to this head's sidecar. A: reference-valid stamps succeed. |
| P1 revoke | S: exact victim, matching parent/sequence, preserved generation, all other grants and rules unchanged. S: every frame must decode as install or old rule transition. A: reference-valid cancellation succeeds. |
| P2 expiry | S: signed live issue, pool insertion, inclusive cutoff, immediate and continued denial after expiry/revocation without renewal. A: reference-valid timed issues succeed. |
| O1 correction | S: returned code, correction flag, prior full intent and exactly prepended report. A: reference-valid reports succeed. |
| O2 retention | S: every command trace leaves the previous complete outcome list as a suffix. |
