import Proofs.Evidence11
import Proofs.FullSuccession

namespace Aukora.Root12
open Release (Model)
open Evidence11

def E1 (m : Model) : Prop := ∀ {ctx w s t i a c r},
  m.step ctx w s = some t →
  Names s w i a →
  c ∈ a.claims →
  r ∈ c.refs →
  ∃ bytes, s.base.record[r-1]? = some bytes ∧ 0 < r ∧ r < a.pos ∧ a.pos < Policy9.nextSeq s

def E1b (m : Model) : Prop := ∀ {ctx w s t i a c r},
  m.step ctx w s = some t →
  Names s w i a →
  c ∈ a.claims →
  r ∈ c.refs →
  ∃ wire parent body, s.base.record[r-1]? = some wire ∧
      decode wire = some ⟨parent,r,body⟩ ∧ fitsKind c.kind (some body) = true

def E2 (m : Model) : Prop := ∀ {ctx w s t i a c ancestor},
  m.step ctx w s = some t →
  Names s w i a →
  c ∈ a.claims →
  Derives s.base.record ⟨a.pos,c⟩ ancestor →
  let h := s.base.record
  let z := ceiling s
  c.stated.toNat ≤ (scoreAt h z a.pos c).bound ∧
    (scoreAt h z a.pos c).bound ≤ (scoreAt h z ancestor.pos ancestor.claim).bound ∧
    ancestor.claim.stated.toNat ≤ (scoreAt h z ancestor.pos ancestor.claim).bound

def GuessBound (m : Model) : Prop := ∀ {ctx w s t i a c ancestor},
  m.step ctx w s = some t →
  Names s w i a →
  c ∈ a.claims →
  Derives s.base.record ⟨a.pos,c⟩ ancestor →
  ancestor.claim.kind = .guessed →
  ancestor.claim.stated.toNat ≤ (ceiling s).toNat

def CeilingControl (m : Model) : Prop := ∀ {ctx w s t},
  m.step ctx w s = some t →
  ceiling t ≠ ceiling s →
  ∃ p n z ed ml, decode w = some ⟨p,n,.setCeiling z ed ml⟩ ∧
      Hybrid7.Both Core8.verifiers s.base.hybrid.owner (ceilingMessage s p n z) ed ml

def E4 (m : Model) : Prop := ∀ {ctx w s t i a c ancestor q},
  m.step ctx w s = some t →
  Names s w i a →
  c ∈ a.claims →
  Derives s.base.record ⟨a.pos,c⟩ ancestor →
  ancestor.claim.absence = some q →
  ∃ r wire parent read, r ∈ ancestor.claim.refs ∧ r < ancestor.pos ∧ s.base.record[r-1]? = some wire ∧
      decode wire = some ⟨parent,r,.read read⟩ ∧ read.empty = true ∧
      read.query = q ∧ read.first ≤ read.last ∧ read.last ≤ r

def E6 (m : Model) : Prop := ∀ {ctx w s t i a w' s' b},
  m.step ctx w s = some t →
  Names s w i a →
  Names s' w' i b →
  b.pos = a.pos →
  SameBasis s s' a.pos →
  List.Forall₂ Weaker a.claims b.claims →
  b.bundle = ⟨(w'.extract 1 33).data.toList⟩ ∧ 0 < b.pos ∧
      b.pos ≤ s'.base.record.size ∧ b.pos < Policy9.nextSeq s' →
  Safe11.halted s' = false →
  (Ratchet11.step ctx w' s').isSome = true →
  (m.step ctx w' s').isSome = true

def E3 (m : Model) : Prop := GuessBound m ∧ CeilingControl m

def E5 (m : Model) : Prop := ∀ ctx w s, w[0]? = some (0 : UInt8) →
  (m.step ctx w s).isSome = (Safe11.step (Ratchet11.step ctx) w s).isSome

open Safe11 (halted route allowedOrdinary noClearInputs ValidClear shape Both newKeys)

def H1 (m : Model) : Prop :=
  ∀ ctx w s, halted s = true → route w = .ordinary → allowedOrdinary w = false →
    m.step ctx w s = none

def H2 (m : Model) : Prop :=
  ∀ ctx s xs, halted s = true → noClearInputs m ctx s xs →
    halted (Release.run m ctx s xs) = true

def H3 (m : Model) : Prop :=
  ∀ ctx s w t, route w = .clear → m.step ctx w s = some t →
    Policy9.pool t.base = Policy9.pool s.base ∧
    ∀ i, Policy9.Closed s i → Policy9.Closed t i ∧ Policy9.grantOK t i = false

def H4 (m : Model) : Prop :=
  ∀ ctx s xs, ∃ suffix,
    (Release.run m ctx s xs).base.record.toList = s.base.record.toList ++ suffix

def H5 (m : Model) : Prop :=
  (∀ ctx s w, ValidClear s w → ∃ t, m.step ctx w s = some t ∧ halted t = false) ∧
    ∀ ctx s w, route w = .rebind → shape s w 53 = true → Both s w 53 →
      Hybrid7.validKey (newKeys s w) = true → ∃ t, m.step ctx w s = some t ∧
        t.base.hybrid.owner = newKeys s w ∧ Policy9.pool t.base = [] ∧
        Policy9.generation t = Policy9.generation s + 1 ∧ halted t = halted s

/-- Candidate-facing obligations are over its entry points, including traces through its own operations. -/
structure Supplement (m : Model) : Prop where
  e1 : E1 m
  e1b : E1b m
  e2 : E2 m
  e3 : E3 m
  e4 : E4 m
  e5 : E5 m
  e6 : E6 m
  h1 : H1 m
  h2 : H2 m
  h3 : H3 m
  h4 : H4 m
  h5 : H5 m
  succession : Ratchet11.Succession m

/-- The complete 36-clause target of the release gate. -/
structure Contract (m : Model) : Prop where
  inherited : Lawful m
  supplement : Supplement m

theorem full_supplement : Supplement Safe11.fullModel where
  e1 := fun {ctx w s t i a c r} => @resolves (Ratchet11.step ctx) w s t i a c r
  e1b := fun {ctx w s t i a c r} => @kind_matches (Ratchet11.step ctx) w s t i a c r
  e2 := fun {ctx w s t i a c ancestor} => @no_laundering (Ratchet11.step ctx) w s t i a c ancestor
  e3 := ⟨fun {ctx w s t i a c ancestor} => @guess_ceiling (Ratchet11.step ctx) w s t i a c ancestor,
    fun {ctx w s t} => @ceiling_owner (Ratchet11.step ctx) w s t⟩
  e4 := fun {ctx w s t i a c ancestor q} => @looked (Ratchet11.step ctx) w s t i a c ancestor q
  e5 := fun ctx w s => speech_free (Ratchet11.step ctx) w s
  e6 := @act_lowering
  h1 := Safe11.full_safe.boundary
  h2 := Safe11.full_safe.confinement
  h3 := Safe11.full_safe.grants
  h4 := Safe11.full_safe.history
  h5 := Safe11.full_safe.recovery
  succession := Round11.full_succession

/-- An actual entailment transports every named obligation to the child. -/
theorem inherits {child : Model → Prop} (entails : ∀ m, child m → Contract m)
    {model : Model} (own : child model) : Contract model := entails model own

/-- Unchanged L8 selects the old predicate on the submitted model. This is a fact
    about the constructed syntax and the actual checker verdict, independently of
    assumptions that give the checker a semantic interpretation. -/
theorem changed_core_checks_frozen {m : Model} (law : Contract m) {ctx wire s t}
    (hit : m.step ctx wire s = some t)
    (change : (Release.ledger t).book.auth.core ≠ (Release.ledger s).book.auth.core) :
    ∃ u name checked, Upgrade9.decode wire = some u ∧
      Checker9.machineName u.model = some name ∧ Checker9.context ctx u.model = some checked ∧
      checked.goal = Lean.mkApp (Lean.mkConst `Aukora.Release.Lawful) (Lean.mkConst name) ∧
      R6.KernelCell.check checked u.proof = true := by
  obtain ⟨_,u,decoded,passed,_⟩ := law.inherited.upgrade ctx wire s t hit change
  obtain ⟨name,checked,named,init,goal,proof⟩ := Checker9.checked_goal passed
  exact ⟨u,name,checked,decoded,named,init,goal,proof⟩

/-- If the pinned checker witnesses denote actual proofs, the inherited v0.1 L8 format
    independently requests a theorem already refuted for this same full machine. -/
theorem frozen_goal_impossible (ctx : R6.KernelCell.Context) :
    ¬ Release.Lawful Safe11.fullModel := Safe11.full_violates_L2 ctx

#print axioms full_supplement
#print axioms changed_core_checks_frozen
#print axioms frozen_goal_impossible
end Aukora.Root12
