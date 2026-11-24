import Proofs.FinalPolicies
import Proofs.FinalUpgrade
import Proofs.FinalEvidence
import Proofs.Rollover
import Proofs.FinalPorts
import Proofs.InstalledControls
import Proofs.InstalledVerdicts
import Proofs.InstalledPorts
import Proofs.VersionAdvice
import Proofs.RecordBinding
import Proofs.BoundStart
import Proofs.Rebinding
import Proofs.PinSatisfied

namespace Aukora.RootFinal
open Release
open Safe11 (fullModel)

/-- The root law applies each obligation to the candidate's own operations.
    The same named fields are projected by the checked transition witness. -/
structure Lawful (m : Model) : Prop where
  replay : Root12.Replay m ∧ PublicPorts m
  record : Record m
  stale : Stale m
  once : Once m
  passive : PassiveFrames m
  advice : VersionAdvice m
  restore : Restore m
  upgrade : Ports.UpgradeInstalled m
  memory : ∀ key start, m.genesis key = some start → Memory m start
  outcome : ∀ key start, m.genesis key = some start → Outcome m start
  grants : GrantSource m ∧ ∀ key start, m.genesis key = some start →
    (ledger start).history = [] ∧ pool start = [] ∧ ∀ ctx xs i, i ∈ pool (run m ctx start xs) →
      GrantOrigin9.Signed (owner (run m ctx start xs)) i
  binding : Binding m
  control : Control m
  monotone : Ports.Monotone m
  floor : ∀ key start, m.genesis key = some start → Ports.Floor m start
  threshold : SignedThreshold m ∧ ControlAvailability.Supports m .threshold ∧ ∀ key s, m.genesis key = some s → s.base.risk.threshold = 0
  missing : Ports.Missing m
  bundle : Ports.Bundle m ∧ ControlAvailability.Supports m .assessment ∧ RiskState m
  stamping : Stamping m ∧ ControlAvailability.StampSupports m
  revoke : Revocation m ∧ ControlAvailability.Supports m .cancel ∧ Rules m
  expiry : Expiry m ∧ ControlAvailability.Supports m .issue
  correction : Correction m ∧ ControlAvailability.Supports m .report
  retention : RetentionLaw m
  e1 : Historical.E1 m
  e1b : Historical.E1b m
  e2 : Historical.E2 m
  e3 : Historical.E3 m
  e4 : Historical.E4 m
  e5 : Speech m
  e6 : Historical.E6 m
  h1 : Boundary m
  h2 : Historical.Confinement m
  h3 : Historical.ClearEffect m
  h4 : Root12.H4 m
  h5 : Historical.Recovery m ∧ SessionFinal.Recovery m ∧ SegmentFinal.Rollover m
  succession : Ports.Succession m
  w1 : W1 m ∧ PriorVerdicts m ∧ Historical.Lineage m ∧ VersionVerdicts m
  /-- B1 (round 12c D): two bound records with different identifiers never share a head. -/
  b1 : RecordBinding.Separation m
  /-- B2 (round 12c D): a head-signed owner frame admitted by one bound record is refused by
      every bound record with another identifier. Plain approvals (tag 13 hex) and legacy key
      changes (tag 14 hex) are not covered: `BindingConflict.forced_approval` and
      `BindingConflict.forced_key_change` show that PriorVerdicts forces their admission. -/
  b2 : RecordBinding.Refusal m
  /-- B3 (round 12c D2): the start clauses of the 37 (record view, memory, outcome, the start
      part of grants, floor, the initial threshold) for a record started by bound genesis. -/
  b3 : BoundStart.StartClauses m
  /-- B4 (round 12c D2): a frame of a head-signed kind (timed approval, cancel, signed control,
      threshold) that carries the signatures of a frame admitted by one bound record is refused by
      every bound record with another identifier. Assumption named in the statement:
      `Rebinding.SignatureOnce` (Ed25519 and ML-DSA-65 as implemented here; tested, not proved). -/
  b4 : Rebinding.Readdressed m
  /-- G1 (round 12c A): on every core change, the pinned checker accepted a proof that the carried
      machine satisfies the set it pins (the set the resulting state pins is the package's own set).
      A corollary of `succession` and `upgrade`, named so that it cannot be dropped silently. -/
  pinned : Pin.PinSatisfied m

theorem full_lawful : Lawful fullModel where
  replay := ⟨Root12.full_replay,ports_of_replay Root12.full_replay⟩
  record := full_record
  stale := full_stale_installed
  once := full_once_installed
  passive := full_passive_installed
  advice := full_versionAdvice
  restore := full_restore_installed
  upgrade := Ports.full_upgrade
  memory := fun _ _ g => full_memory g
  outcome := fun _ _ g => full_outcome g
  grants := ⟨full_grantSource,fun k s g =>
    ⟨(newest_lawful.grants.2 k s g).1,(newest_lawful.grants.2 k s g).2.1,full_signed g⟩⟩
  binding := full_binding
  control := full_control_installed
  monotone := Ports.full_monotone
  floor := fun _ _ g => Ports.full_floor g
  threshold := ⟨full_signedThreshold,ControlAvailability.full_supports .threshold,fun _ _ => initial_threshold⟩
  missing := Ports.full_missing
  bundle := ⟨Ports.full_bundle,ControlAvailability.full_supports .assessment,full_riskState⟩
  stamping := ⟨full_stamping,ControlAvailability.full_stampSupports⟩
  revoke := ⟨full_revocation,ControlAvailability.full_supports .cancel,full_rules⟩
  expiry := ⟨full_expiry_installed,ControlAvailability.full_supports .issue⟩
  correction := ⟨full_correction_installed,ControlAvailability.full_supports .report⟩
  retention := full_retention
  e1 := @Historical.full_e1
  e1b := @Historical.full_e1b
  e2 := @Historical.full_e2
  e3 := Historical.full_e3
  e4 := @Historical.full_e4
  e5 := full_speech
  e6 := @Historical.full_e6
  h1 := full_boundary
  h2 := Historical.full_confinement
  h3 := Historical.full_clearEffect
  h4 := Root12.full_supplement.h4
  h5 := ⟨Historical.full_recovery,SessionFinal.full_recovery,SegmentFinal.rollover fullModel⟩
  succession := Ports.full_succession
  w1 := ⟨full_w1,full_prior_verdicts,Historical.full_lineage,full_versionVerdicts⟩
  b1 := RecordBinding.full_separation
  b2 := RecordBinding.full_refusal
  b3 := BoundStart.full_start
  b4 := Rebinding.full_readdressed
  pinned := Pin.full_pinned

#print axioms full_lawful
end Aukora.RootFinal
