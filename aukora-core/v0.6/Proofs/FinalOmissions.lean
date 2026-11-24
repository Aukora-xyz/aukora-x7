import Proofs.FinalUpgrade

namespace Aukora.RootFinal

/-- An omitted public name blocks installation for *every* certificate, including
    an alternative proof that the remaining clauses happen to entail the old set. -/
theorem omission_refused {ctx w s u b prior child}
    (tag : w[0]? = some (27 : UInt8)) (package : Upgrade9.decode w = some u)
    (predecessor : Ratchet11.basisAndSet ctx (Ratchet11.current s) = some (b,prior))
    (proposed : RatchetChecker.spec u.model = some child)
    (missing : RatchetChecker.retainsNames prior child = false) :
    Safe11.fullModel.step ctx w s = none := by
  cases hit : Safe11.fullModel.step ctx w s with
  | none => rfl
  | some t =>
    have run := Round11.install_is_ratchet tag hit
    have allowed : Ratchet11.allow ctx w s = true := by
      by_contra denied
      simp [Ratchet11.step,denied] at run
    have bound := Ratchet11.allowed_owner_bound tag package allowed
    have good : Ratchet11.packageReason ctx (Ratchet11.current s) u.model u.proof = 0 := by
      simpa [Ratchet11.allow,Ratchet11.reason,tag,package,bound] using allowed
    unfold Ratchet11.packageReason at good
    simp only [Id.run,predecessor,proposed,missing] at good
    cases cert : RatchetChecker.witnesses u.proof with
    | none => simp [cert] at good
    | some c =>
      cases goals : RatchetChecker.goals ctx prior u.model u.proof with
      | none => simp [cert,goals] at good <;> grind
      | some g =>
        cases edge : RatchetChecker.verifies g.env g.entails g.cert.entails <;>
          cases sat : RatchetChecker.verifies g.env g.own g.cert.own <;>
            simp [cert,goals,edge,sat] at good <;> grind

#print axioms omission_refused
end Aukora.RootFinal
