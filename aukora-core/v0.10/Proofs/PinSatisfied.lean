import Proofs.InstalledPorts

/-! Round 12c A, law `pinned` (G1): the gate cannot pin a law set that the carried machine
has not been checked to satisfy.

For every step that changes the installed core or admits an installation, the set the
resulting state pins is the package's own declared set, and the pinned checker accepted a
proof that the carried machine satisfies the set it pins (not the parent's set, not an older
named goal). It does NOT say the machine satisfies the set: the checker's verdict is not proved
to imply the Lean proposition (standing limit 2).

This is a corollary of `succession` (`Ports.Succession`, which demands `Ratchet11.Demands`),
`upgrade` (`Ports.UpgradeInstalled`: every core change is an installation) and
`Ratchet11.goal_shapes`. It is a field of its own so that a later law set cannot drop the
property without that omission being refused.

Not proved here (standing limit): that the checker's `verifies` implies the Lean proposition,
and that the named machine is the compiled executable (compared by bytes, reason 11). -/

namespace Aukora.RootFinal.Pin
open Release
open Safe11 (innerModel)
open Ports

/-- What an admitted installation pins, and what was checked about it. -/
def Checked (ctx : R6.KernelCell.Context) (t : Release.State) (u : Upgrade9.Package) : Prop :=
  ∃ b law next set name g,
    RatchetChecker.spec u.model = some next ∧ Ratchet11.current t = some (b, next) ∧
    RatchetChecker.expression next = some set ∧ Checker9.machineName u.model = some name ∧
    RatchetChecker.goals ctx law u.model u.proof = some g ∧
    g.own = Lean.Expr.app set (.const name []) ∧
    RatchetChecker.verifies g.env g.own g.cert.own = true

/-- G1, field `pinned`. -/
def PinSatisfied (m : Model) : Prop :=
  ∀ ctx w s t, m.step ctx w s = some t →
    ((ledger t).book.auth.core ≠ (ledger s).book.auth.core ∨ (installation m.grammar s w).isSome) →
    ∃ u, installation m.grammar s w = some u ∧ Checked ctx t u

theorem of_demands {ctx s t u} (d : Ratchet11.Demands ctx s t u) : Checked ctx t u := by
  obtain ⟨b, law, cert, g, next, _, _, _, _, hs, cur, hg, own, _⟩ := d
  obtain ⟨child, old, set, name, checked, hc, he, _, hn, _, _, ho, _⟩ := Ratchet11.goal_shapes hg
  rw [hs] at hc
  cases hc
  exact ⟨b, law, next, set, name, g, hs, cur, he, hn, hg, ho, own⟩

/-- G1 follows from `succession` and `upgrade` for any model. -/
theorem of_clauses {m : Model} (succ : Ports.Succession m) (up : Ports.UpgradeInstalled m) : PinSatisfied m := by
  intro ctx w s t ok which
  have inst : ∃ u, installation m.grammar s w = some u := by
    rcases which with changed | some_
    · obtain ⟨u, hu, _⟩ := up ctx w s t ok changed
      exact ⟨u, hu⟩
    · exact Option.isSome_iff_exists.mp some_
  obtain ⟨u, hu⟩ := inst
  exact ⟨u, hu, of_demands (succ ctx w s t u hu ok)⟩

theorem full_pinned : PinSatisfied innerModel := of_clauses Ports.full_succession Ports.full_upgrade

#print axioms of_clauses
#print axioms full_pinned
end Aukora.RootFinal.Pin
