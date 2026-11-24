# What is proved in v0.5 (the same machine and Wasm bytes as lab v0.4)

ONE proposition, `Aukora.RootFinal.Lawful`, with 37 named fields, proved for ONE machine: `theorem full_lawful : Lawful fullModel`
(`RootFinal.lean:58`). Accepted by the Lean 4.19.0 kernel in the original run, again in two
from-scratch builds by one reviewer, and again in an independent re-run by another, all on the same machine
(no error, no `sorryAx`). The full Wasm pins this set. Every statement is about the Lean MODEL.

"Never" is what the law forbids or fixes. "Available" is what the law promises succeeds, and only when the machine is
open (not halted, not sealed, within its limits); the owner's recovery (a valid clear, a valid key change) is the one
promise that holds from every state, including a full record (within the 16-entry recovery reserve).

| Law | Never / always exactly | Available when open |
| --- | --- | --- |
| L1 replay | Filtering refusals preserves replay. Feed and reset have exact staging-only effects. | Feed and reset in an open state. |
| L2 record | Exact accepted bytes, decoded ledger order and sound active line IDs. |  |
| L3 stale | Stale parent or sequence refuses with state unchanged. |  |
| L4 once | A direct spend needs a current grant, logs it, consumes it and bars reuse without reissue. |  |
| L5 passive | Passive frames preserve owner, authority and grant rules. |  |
| L6 advice | Aligned histories preserve authority and their frame-verdict sequence as advice scores vary. |  |
| L7 restore | Rebind clears grants and rules, advances generation and prevents old spends. |  |
| L8 upgrade | Package, file/model commitment, proof acceptance, exact intent, grant expenditure and conditional byte identity. |  |
| L9 memory | Claims grow, a correction preserves claims, every reachable claim has an earlier source. |  |
| L10 outcome | Historical confirmation agrees with an actual confirmed event. Findings, order and latest query are exact. |  |
| Grant H1 grants | Genesis is empty, new grants have both signatures, all reachable grants have signed origin. |  |
| Grant H2 binding | Both current signatures bind new keys. Every accepted binding installs the named pair. |  |
| Grant H3 control | Owner controls and targeted revocations have both current signatures. |  |
| D1 monotone | Raising only the effective risk score preserves a prior refusal. |  |
| D2 floor | Installs and high-score deliveries spend signed exact grants. Rebinding requires both old signatures. |  |
| D3 threshold | Genesis threshold zero. Every threshold change requires the actual level, keys and signed message. | Valid controls in an open state. |
| D4 missing | A missing assessment forces the grant branch, default digest, score 255 and missing flag. |  |
| D5 bundle | Exact admitted route, score, bundle, missing bit and risk-state transition. | Valid assessments in an open state. |
| S1 stamping | Success appends only the stamp and references the current head. | An available valid sidecar can attach. |
| P1 revoke | Exact victim, preserved generation, unaffected other grants and exact rule updates. | Valid revocation in an open state. |
| P2 expiry | Signed issue with inclusive cutoff. Closure persists until a signed renewal. | Valid timed issue in an open state. |
| O1 correction | Exact latest-result code, correction flag, complete prior intent and prepended report. | Valid report in an open state. |
| O2 retention | All earlier findings remain a suffix of the final list. |  |
| E1 e1 | Every cited raw position exists, is positive and precedes assessment and act. |  |
| E1b e1b | Every cited body has the declared kind and sequence at its recorded position. |  |
| E2 e2 | Confidence bounds hold along the complete inference chain. |  |
| E3 e3 | Guesses stay below the applicable ceiling. Any ceiling change has signed owner authorization. |  |
| E4 e4 | An absence claim identifies an earlier empty read with matching query and a closed range. |  |
| E5 e5 | The evidence gate preserves the unsigned port's speech verdict. | Successful reference speech remains available, including while halted. |
| E6 e6 | Weaker stated confidences use the same evidence basis. | A qualified, readdressed weaker act remains available. |
| Halt H1 h1 | During halt, an ordinary operation outside the allowlist is refused. |  |
| Halt H2 h2 | A trace with no valid clear preserves halt. |  |
| Halt H3 h3 | A clear leaves pool and prior closures intact. |  |
| Halt H4 h4 | The prior raw record remains a prefix. |  |
| Halt H5 h5 | Clear lifts the halt. Recovery binding installs keys, empties grants, advances generation and preserves the halt. | Valid recovery from every inner-model state. The finite session states available capacity. |
| Succession | The actual admission checks the carried child and universal transition against the recorded predecessor and pinned foundation. |  |
| W1 versions | A frame that decodes under an earlier wire version decodes to the same event under the installed one; the law's exact statement is `W1 m ∧ PriorVerdicts m ∧ Historical.Lineage m ∧ VersionVerdicts m` in `Versions.lean`. A per-version table in plain words is NOT written yet (asked for in round 12c). | |

## Also proved this round (names as in the build transcript)
- Capacity and recovery: `Bounds12.recovery_at_capacity`, `SessionFinal.reserve_owner_only`, `SessionFinal.stamp_cannot_use_reserve`, `SessionFinal.reserve_byte_bound`.
- Seal and continue: `SegmentFinal.seal_reserved`, `SegmentFinal.sealed_admits_nothing`, `SegmentFinal.seal_authentic`, `SessionFinal.sealed_frames`.
- Succession: `RootFinal.Strict.genuinely_stronger` (a strictly stronger set exists and is admitted), `RootFinal.omission_refused` (dropping any one named law fails the transition check).
- Bridges to the earlier law statements: 39 of the 40 names listed in `VERSION-AUDIT.md`'s bridge index exist as declarations (the fortieth, `Record.toRecord`, was not found by name in the review).

See `NOT-PROVED.md` before relying on any line above.
