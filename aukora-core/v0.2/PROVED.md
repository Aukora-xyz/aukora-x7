# Round 11 kernel results

The two profiles share the same public state and frozen round-ten definitions. The full research cell enters through `Round11.step`. Its seven evidence laws and five safe-state laws were checked in this round. The succession profile enters through `Ratchet11.step`. Its checked contract combines all 23 original fields with a succession clause. The full cell also enforces that clause on outgoing installs. [Full entry](Round11.lean) · [Succession entry](Ratchet11.lean) · [Round-ten contract](Laws.lean)

| Evidence law | Kernel result at the act boundary |
| --- | --- |
| E1 resolves | Each listed reference names an actual slot in the same pre-act record. Its position precedes the assessment, which precedes the act. |
| E1b kind | Each cited body has the required recorded kind. Direct observations use a read or outcome, reports use a named statement, and inferences use earlier premise claims. A guess has no references. |
| E2 no laundering | The stated byte is below or equal to the computed bound. That bound is below or equal to the bound of every transitive inference ancestor. Direct evidence uses its recorded value. Inference uses the minimum premise bound. |
| E3 guess ceiling | Guesses use the owner's ceiling. The checks cover transitive premises. Lowering today's ceiling can invalidate an old premise. Raising it cannot increase that premise's bound beyond its historical ceiling. A ceiling change requires both verifiers. |
| E4 looked | A claim of absence quotes the query digest of an earlier empty-result read. Its saved window is ordered and ends no later than the read's own committed sequence. |
| E5 speech | The evidence check preserves the underlying verdict for ordinary unsigned frames, including say, remember and advise. Each still uses its original grammar and ledger rules. |
| E6 weakening | Lowering stated confidences preserves an accepted, correctly readdressed act with the same evidence basis, claim classes, references and queries and a valid underlying authority route. Reclassifying an observation as a guess while retaining its reference supplies a checked counterexample. |

A premise with a stated confidence of 20 and a computed bound of 100 can support an inference stated at 80. Monotonicity follows the computed bounds. Legacy and missing assessments contribute an empty list. The machine cannot discover justifications omitted by the host. [Evidence theorems](Proofs/Evidence11.lean) · [Versioned records and evaluation](Evidence11.lean)

| Safe-state law | Kernel result on the full machine |
| --- | --- |
| H1 | The closed legal set excludes direct acts, mandate acts, spends, grants and installs at any score. |
| H2 | Across frames, staging, resets and stamps, a halted state stays halted without an accepted owner clear. |
| H3 | Clear preserves grant rules and cannot revive a cancelled or expired grant. |
| H4 | The old raw record is a prefix of every later record. This retains every committed halt across recovery. |
| H5 | A well-formed, currently addressed clear with both valid signatures succeeds from every state. The recovery rebind has the same availability with valid new keys and preserves the halted flag. |

The clear and recovery rebind use canonical, unbounded decimal sequence and generation fields in Lean. Each uses the current public head and next sequence. Signature availability, key loss and finite host resources lie outside the theorem. [Public safe laws and incompatibility](Proofs/Round11Safe.lean) · [Legal set and controls](Safe11.lean) · [Wire grammar](WIRE.md)

## Succession and the contract boundary

`Ratchet11.legacy_lawful` lifts the original contract to the narrower install gate by simulating the retained trace and checking that paired advice histories retain equal law identities. `model_succession` requires both checked witnesses on each accepted install. `goal_shapes` describes the satisfaction and universal entailment goals. The checker uses a syntactic reference to the current set, which avoids a recursive definition of its meaning. The new set must hold for its carried model. An unsatisfiable predicate entails every old law and has no inhabitant. [Preservation of all 23 fields](RatchetLegacy.lean) · [Succession clause](RatchetModel.lean) · [Witnesses](tests/SuccessionCandidates.lean)

`Round11.full_core_change` and `Round11.full_succession` tie core changes in the evidence-and-halt profile to the same gate. `Safe11.full_violates_L2` proves that this profile cannot itself satisfy the frozen contract. Its accepted versioned halt has no old projection. P2 independently requires admission of a valid timed issue even on a state where H1 requires refusal. Full-profile proofs are available for inspection. The inheritable gate contains the original 23 laws and succession. [Full outgoing gate](Proofs/FullSuccession.lean) · [Frozen-law contradiction](Proofs/Round11Safe.lean) · [Original availability requirement](Proofs/PolicyEffects.lean)
