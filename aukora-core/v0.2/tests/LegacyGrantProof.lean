import tests.LegacyModel
import Proofs.Authority

namespace Aukora.Release

set_option maxRecDepth 8192 in
set_option maxHeartbeats 180000 in
theorem legacySignatureVerified : Ed25519.verify R9Candidate.ownerKey
    (Wire5.intentBytes legacyIntent)
    legacySignature = true := by
  decide +kernel

/-- An arbitrary context suffices because this ordinary grant never invokes a proof checker. -/
noncomputable def exampleContext : R6.KernelCell.Context :=
  ⟨Classical.choice (inferInstance : Nonempty Lean.Kernel.Environment), Lean.mkConst ``False⟩

-- Kernel reduction computes the original verifier and the grant pool left by its true verdict.
set_option maxRecDepth 8192 in
set_option maxHeartbeats 360000 in
theorem legacyGrantHeld :
    (edOnly.step exampleContext legacyGrant legacyStart).any (fun t => decide (legacyIntent ∈ pool t)) = true := by
  decide +kernel

theorem legacyGrantAdded : ∃ t, edOnly.step exampleContext legacyGrant legacyStart = some t ∧
    legacyIntent ∉ pool legacyStart ∧ legacyIntent ∈ pool t := by
  cases run : edOnly.step exampleContext legacyGrant legacyStart with
  | none => have h := legacyGrantHeld; simp [run] at h
  | some t =>
    exact ⟨t, rfl, by change legacyIntent ∉ ([] : List Intent); simp, by simpa [run] using legacyGrantHeld⟩

theorem legacyGrantFails : ¬ GrantLaw edOnly := by
  intro grant
  obtain ⟨t, step, absent, held⟩ := legacyGrantAdded
  have issued := grant exampleContext legacyGrant legacyStart t legacyIntent step absent held
  simp [Issued, Tracked, legacyGrantNoCommand] at issued

#print axioms legacyGrantFails
#print axioms legacySignatureVerified
#print axioms legacyGrantAdded
end Aukora.Release
