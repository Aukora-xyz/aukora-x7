import Ratchet11
import Laws

namespace Aukora.Ratchet11
open R6.KernelCell (Context)
open Release (Model State)

def model : Model := {Release.newest with step := step}

/-- One named law contributes exactly its predicate to the candidate's contract. -/
def oneLaw (_label : String) (clause : Model → Prop) : Model → Prop := clause

/-- Appending a named law conjoins its predicate with every prior obligation. -/
def addLaw (prior : Model → Prop) (_label : String) (clause : Model → Prop) : Model → Prop :=
  fun m => prior m ∧ clause m

/-- A child set entails its parent and pins the exact grammar of its carried
    machine. Consequently every later model satisfying the child set must
    preserve all parser slots present at installation. -/
def Transition (newSet oldSet : Model → Prop) (child : Model) : Prop :=
  (∀ m, newSet m → oldSet m) ∧ ∀ m, newSet m → Root12.Grammar.Preserves child.grammar m

/-- Applying the next edge's universal implication to its satisfaction proof
    transports the previous carried machine's complete grammar. -/
theorem next_preserves_carried_grammar {old child next : Model → Prop} {parent successor : Model}
    (prior : Transition child old parent) (edge : Transition next child successor)
    (own : next successor) : Root12.Grammar.Preserves parent.grammar successor :=
  prior.2 successor (edge.1 successor own)

/-- The child goal applies its declared predicate to the carried machine; entailment ranges over every machine. -/
theorem goal_shapes {ctx law modelBytes proof g}
    (got : RatchetChecker.goals ctx law modelBytes proof = some g) :
    ∃ child old next name checked,
      RatchetChecker.spec modelBytes = some child ∧ RatchetChecker.expression child = some next ∧
      RatchetChecker.expression law = some old ∧ Checker9.machineName modelBytes = some name ∧
      Checker9.context ctx modelBytes = some checked ∧ g.env = checked.env ∧
      g.own = Lean.Expr.app next (.const name []) ∧
      g.entails = RatchetChecker.entailmentGoal next old (.const name []) := by
  unfold RatchetChecker.goals at got
  obtain ⟨child, h1, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨next, h2, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨old, h3, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨_, _, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨_, _, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨name, h4, got⟩ := Option.bind_eq_some.mp got
  obtain ⟨context, h5, got⟩ := Option.bind_eq_some.mp got
  cases Option.some.inj got
  exact ⟨child,old,next,name,context,h1,h2,h3,h4,h5,rfl,rfl,rfl⟩

/-- Both checked proof terms belong to this package and the prior pin comes from the ledger. -/
def Demands (ctx : Context) (s t : Release.State) (u : Upgrade9.Package) : Prop :=
  ∃ b law cert g next,
    basisAndSet ctx (current s) = some (b,law) ∧
    RatchetChecker.witnesses u.proof = some cert ∧ cert.basis = b ∧
    cert.parent = RatchetChecker.number (RatchetChecker.identity b law) ∧
    RatchetChecker.spec u.model = some next ∧ current t = some (b,next) ∧
    RatchetChecker.goals ctx law u.model u.proof = some g ∧
    RatchetChecker.verifies g.env g.own g.cert.own = true ∧
    RatchetChecker.verifies g.env g.entails g.cert.entails = true

/-- The candidate's own successful installation step checks satisfaction and universal entailment under the recorded foundation. -/
def Succession (m : Model) : Prop :=
  ∀ ctx w s t, w[0]? = some (27 : UInt8) → m.step ctx w s = some t →
    ∃ u, Upgrade9.decode w = some u ∧ Demands ctx s t u

/-- One named conjunction. The checker refers to this declaration by syntax so the law has no recursive definition. -/
structure Lawful (m : Model) : Prop where
  inherited : Release.Lawful m
  succession : Succession m

theorem model_succession : Succession model := by
  intro ctx w s t tag h
  have allowed : allow ctx w s = true := by
    by_contra no
    simp [model,step,no] at h
  have old : Core9.step ctx w s = some t := by simpa [model,step,allowed] using h
  obtain ⟨u,dec,_,_,_,_,rec⟩ := Core9.package_admission tag old
  have bound := allowed_owner_bound tag dec allowed
  have checked : packageReason ctx (current s) u.model u.proof = 0 := by
    simpa [allow,reason,tag,dec,bound] using allowed
  cases hb : basisAndSet ctx (current s) with
  | none => simp [packageReason,Id.run,hb] at checked
  | some pin =>
    obtain ⟨b,law⟩ := pin
    cases hc : RatchetChecker.witnesses u.proof with
    | none => simp [packageReason,Id.run,hb,hc] at checked
    | some cert =>
      by_cases bOK : cert.basis = b
      · by_cases pOK : cert.parent = RatchetChecker.number (RatchetChecker.identity b law)
        · cases hs : RatchetChecker.spec u.model with
          | none => simp [packageReason,Id.run,hb,hc,bOK,pOK,hs] at checked
          | some next =>
            cases hg : RatchetChecker.goals ctx law u.model u.proof with
            | none => simp [packageReason,Id.run,hb,hc,bOK,pOK,hs,hg] at checked
            | some g =>
              cases ha : RatchetChecker.verifies g.env g.own g.cert.own <;>
                cases he : RatchetChecker.verifies g.env g.entails g.cert.entails <;>
                simp [packageReason,Id.run,hb,hc,bOK,pOK,hs,hg,ha,he] at checked
              exact ⟨u,dec,b,law,cert,g,next,hb,hc,bOK,pOK,hs,
                by rw [current_push rec]; simp [update,Option.orElse,dec,packagePin,hc,hs,bOK], hg,ha,he⟩
        · simp [packageReason,Id.run,hb,hc,bOK,pOK] at checked
      · simp [packageReason,Id.run,hb,hc,bOK] at checked

/-- Every core change of any lawful carried model uses both ratchet checks. -/
theorem change_requires_both {m : Model} (h : Lawful m) {ctx w s t}
    (ok : m.step ctx w s = some t) (changed : (Release.ledger t).book.auth.core ≠ (Release.ledger s).book.auth.core) :
    ∃ u, Upgrade9.decode w = some u ∧ Demands ctx s t u :=
  h.succession _ _ _ _ (h.inherited.upgrade _ _ _ _ ok changed).1 ok

/-- Under actual entailment, a model satisfying the new set inherits the demand on its own upgrades. -/
theorem child_succession {newSet : Model → Prop} (entails : ∀ m, newSet m → Lawful m)
    {child : Model} (sat : newSet child) : Succession child :=
  (entails child sat).succession

/-- Two checked universal implications, when interpreted in the pinned foundation, compose. -/
theorem next_entails_root {child grandchild : Model → Prop}
    (first : ∀ m, child m → Lawful m) (second : ∀ m, grandchild m → child m) :
    ∀ m, grandchild m → Lawful m := fun m h => first m (second m h)

#print axioms child_succession
#print axioms change_requires_both
#print axioms model_succession
#print axioms next_preserves_carried_grammar
#print axioms goal_shapes
end Aukora.Ratchet11
