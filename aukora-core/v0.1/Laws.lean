import Proofs.PolicyEffects
import Proofs.Spending
import Proofs.AdvicePolicy
import Proofs.RawRecord
import Proofs.OutcomeTrace

namespace Aukora.Release

/-- The checker applies this single proposition to the final carried definition.
    Operations quantify over all public states unless the law explicitly starts at genesis. -/
structure Lawful (m : Model) : Prop where
  /-- L1. Dropping refused frames and stamps preserves replay; feed and reset only append or clear staged bytes. -/
  replay : ReplayLaw m
  /-- L2. Accepted frames decode and extend both records in order; active line IDs from genesis name recorded statements. -/
  record : RawRecordLaw m ∧ (∀ ctx w s t, m.step ctx w s = some t → ∃ f, projected w = some f) ∧
    ∀ key start, m.genesis key = some start → RecordLaw m start
  /-- L3. A decoded frame with a stale parent or wrong sequence is refused and leaves the state unchanged. -/
  stale : StaleLaw m
  /-- L4. Direct spends consume a current-generation grant and cannot recur along a trace without a new signed issue. -/
  once : OnceLaw m
  /-- L5. Accepted passive events, outcome reports and assessments leave owner keys, ledger authority and grant rules unchanged. -/
  passive : PassiveLaw m
  /-- L6. Locally addressed, aligned traces with matching credential verdicts and differing ordinary advice scores give equal authority and frame verdicts. -/
  advice : AdviceLaw m
  /-- L7. A rebind clears rules and grants, advances the generation and bars old-generation spends on every continuation. -/
  restore : RestoreLaw m
  /-- L8. A core change checks the committed model and proof and consumes the exact grant for the staged file's digest. -/
  upgrade : UpgradeLaw m
  /-- L9. Claims grow, corrections preserve them and every claim from genesis names an earlier accepted source. -/
  memory : ∀ key start, m.genesis key = some start → MemoryLaw m start
  /-- L10. Historical confirmation means an accepted confirmation exists; the latest query reads the newest accepted report. -/
  outcome : ∀ key start, m.genesis key = some start → HistoricalOutcomeLaw m start ∧ OutcomeTraceLaw m start
  /-- H1. Genesis has empty history and grants, every new grant carries both signatures, and every reachable grant has hybrid provenance. -/
  grants : GrantLaw m ∧ ∀ key start, m.genesis key = some start →
    (ledger start).history = [] ∧ pool start = [] ∧ ∀ ctx xs i, i ∈ pool (run m ctx start xs) →
      GrantOrigin9.Signed (owner (run m ctx start xs)) i
  /-- H2. Changing either owner key requires a decoded rebind; both old keys verify every accepted binding. -/
  binding : BindingLaw m
  /-- H3. Every accepted legacy owner control and single-grant revocation has both current signatures. -/
  control : ControlLaw m
  /-- D1. Raising only the recorded score for a bundled delivery preserves a refusal of the same wire and route. -/
  monotone : MonotoneLaw m
  /-- D2. Rebinds require both old keys at every score; reachable installs and high-score deliveries consume signed grants. -/
  floor : ∀ key start, m.genesis key = some start → FloorLaw m start
  /-- D3. The initial threshold is zero; changes need both signatures, and valid threshold controls remain available. -/
  threshold : ThresholdLaw m ∧ Supports m isThreshold ∧ ∀ key s, m.genesis key = some s → s.base.risk.threshold = 0
  /-- D4. A delivery with no assessment uses the signed-grant route and records score 255 with the intent's missing-evidence digest. -/
  missing : MissingLaw m
  /-- D5. Deliveries record their effective score and bundle; assessments remain available and only risk commands update risk state. -/
  bundle : BundleLaw m ∧ Supports m isAssessment ∧ RiskStateLaw m
  /-- S1. A valid reference stamp can be attached; success appends only that stamp to the current head's sidecar. -/
  stamping : StampLaw m ∧ ∀ w s t, Core9.stamp w s = some t → ∃ u, m.stamp w s = some u
  /-- P1. A valid revocation remains available, removes one eligible grant and preserves the generation and every other grant rule. -/
  revoke : RevokeLaw m ∧ Supports m isRevocation ∧ RulesLaw m
  /-- P2. Timed issues remain available and sign an inclusive cutoff; revoked or expired intents cannot be readmitted without renewal. -/
  expiry : ExpiryLaw m ∧ Supports m isIssue
  /-- O1. Valid reports remain available, and a correction names the same full intent and returns a labelled result code. -/
  correction : CorrectionLaw m ∧ Supports m isReport
  /-- O2. Every command history retains the complete prior list of outcome reports. -/
  retention : RetentionLaw m

theorem Lawful.grant {m : Model} (h : Lawful m) : GrantLaw m := h.grants.1

private theorem empty_genesis {key start} (ok : newest.genesis key = some start) :
    (ledger start).history = [] ∧ pool start = [] := by
  change (Core8.genesis key).map _ = some start at ok
  obtain ⟨base, init, rfl⟩ := Option.map_eq_some'.mp ok
  obtain ⟨_, _, h⟩ := Option.bind_eq_some.mp init
  obtain ⟨hy, initial, eq⟩ := Option.bind_eq_some.mp h
  cases Option.some.inj eq
  unfold Hybrid7.genesis at initial
  split at initial
  · cases Option.some.inj initial
    exact ⟨rfl,rfl⟩
  · contradiction

theorem newest_lawful : Lawful newest where
  replay := newest_replay
  record := ⟨newest_rawRecord, fun _ _ _ _ ok => by
    obtain ⟨f, _, dec, _⟩ := step_projection ok
    exact ⟨f,dec⟩, fun _ _ ok => newest_record ok⟩
  stale := newest_stale
  once := newest_once
  passive := newest_passive
  advice := newest_advice
  restore := newest_restore
  upgrade := newest_upgrade
  memory := fun _ _ ok => newest_memory ok
  outcome := fun _ _ ok => ⟨newest_historicalOutcome ok, newest_outcomeTrace ok⟩
  grants := ⟨newest_grant, fun _ _ init =>
    ⟨(empty_genesis init).1, (empty_genesis init).2, reachable_grants init⟩⟩
  binding := newest_binding
  control := newest_control
  monotone := newest_monotone
  floor := fun _ _ ok => newest_floor ok
  threshold := ⟨newest_threshold, newest_supports _, fun _ _ ok => initial_threshold ok⟩
  missing := newest_missing
  bundle := ⟨newest_bundle, newest_supports _, newest_riskState⟩
  stamping := ⟨newest_stamp, fun _ _ t ok => ⟨t,ok⟩⟩
  revoke := ⟨newest_revoke, newest_supports _, newest_rules⟩
  expiry := ⟨newest_expiry, newest_supports _⟩
  correction := ⟨newest_correction, newest_supports _⟩
  retention := newest_retention

/-- Preprocessing genesis key bytes preserves all operations and merely selects a previously covered start. -/
theorem lawful_withGenesis {m : Model} (h : Lawful m) (f : ByteArray → ByteArray) : Lawful (withGenesis m f) where
  replay := h.replay
  record := ⟨h.record.1, h.record.2.1, fun key start => h.record.2.2 (f key) start⟩
  stale := h.stale
  once := h.once
  passive := h.passive
  advice := h.advice
  restore := h.restore
  upgrade := h.upgrade
  memory := fun key start => h.memory (f key) start
  outcome := fun key start => h.outcome (f key) start
  grants := ⟨h.grant, fun key start => h.grants.2 (f key) start⟩
  binding := h.binding
  control := h.control
  monotone := h.monotone
  floor := fun key start => h.floor (f key) start
  threshold := ⟨h.threshold.1, h.threshold.2.1, fun key start => h.threshold.2.2 (f key) start⟩
  missing := h.missing
  bundle := h.bundle
  stamping := h.stamping
  revoke := h.revoke
  expiry := h.expiry
  correction := h.correction
  retention := h.retention

#print axioms newest_lawful
#print axioms lawful_withGenesis
end Aukora.Release
