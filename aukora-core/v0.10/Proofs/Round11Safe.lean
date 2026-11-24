import Proofs.Safe11
import Round11

namespace Aukora.Safe11

open R6.KernelCell (Context)

def noClearInputs (m : Release.Ops) (ctx : Context) (s : Machine) : List Input → Prop
  | [] => True
  | c :: cs => (match c with | .frame w => ¬ValidClear s w | _ => True) ∧
    noClearInputs m ctx (Release.execute m ctx s c) cs

/-- The five safe-state laws as one predicate over arbitrary public candidate operations. -/
structure PublicLaws (m : Release.Model) : Prop where
  /-- H1. The halted ordinary-frame allowlist is enforced, including denial of every installation. -/
  boundary : ∀ ctx w s, halted s = true → route w = .ordinary → allowedOrdinary w = false →
    m.step ctx w s = none
  /-- H2. Sequences of frames, feeds, resets and stamps lacking an authorized clear preserve the halt. -/
  confinement : ∀ ctx s xs, halted s = true → noClearInputs m ctx s xs →
    halted (Release.run m ctx s xs) = true
  /-- H3. A clear retains the pool and preserves every expired, revoked or stale closure. -/
  grants : ∀ ctx s w t, route w = .clear → m.step ctx w s = some t →
    Policy9.pool t.base = Policy9.pool s.base ∧
    ∀ i, Policy9.Closed s i → Policy9.Closed t i ∧ Policy9.grantOK t i = false
  /-- H4. Every continuation preserves the complete prior byte record as a prefix. -/
  history : ∀ ctx s xs, ∃ suffix,
    (Release.run m ctx s xs).base.record.toList = s.base.record.toList ++ suffix
  /-- H5. A properly addressed signed clear or rebind succeeds from every state, including every halted state. -/
  recovery :
    (∀ ctx s w, ValidClear s w → ∃ t, m.step ctx w s = some t ∧ halted t = false) ∧
    ∀ ctx s w, route w = .rebind → shape s w 53 = true → Both s w 53 →
      Hybrid7.validKey (newKeys s w) = true → ∃ t, m.step ctx w s = some t ∧
        t.base.hybrid.owner = newKeys s w ∧ Policy9.pool t.base = [] ∧
        Policy9.generation t = Policy9.generation s + 1 ∧ halted t = halted s

/-- The INNER machine (the v0.9 full machine): the full release-2 step and the original feed, reset, stamp,
    outcome and genesis operations. The public machine `Safe11.fullModel` wraps it (`Refusal.wrap`). -/
def innerModel : Release.Model := {Release.newest with step := Round11.step, grammar := Root12.Grammar.installed}

private abbrev prior (ctx : Context) := Evidence11.step (Ratchet11.step ctx)

private theorem execute_full (ctx s c) :
    Release.execute innerModel ctx s c = execute (prior ctx) s c := by
  cases c <;> rfl

private theorem run_full (ctx s xs) : Release.run innerModel ctx s xs = run (prior ctx) s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    simp only [Release.run, execute_full, ih, run, List.foldl_cons]

private theorem noClear_full (ctx s xs) :
    noClearInputs innerModel ctx s xs ↔ NoClear (prior ctx) s xs := by
  induction xs generalizing s with
  | nil => rfl
  | cons c cs ih =>
    cases c <;> simp [noClearInputs, NoClear, execute_full, ih]

/-- All five laws hold for the same composed step that the full Wasm export calls. -/
theorem full_safe : PublicLaws innerModel where
  boundary := fun _ _ _ stopped r barred => H1_blocked stopped r barred
  confinement := by
    intro ctx s xs stopped no
    rw [run_full]
    exact H2_no_escape _ _ _ stopped ((noClear_full ..).mp no)
  grants := fun _ _ _ _ r ok => H3_clear_closed r ok
  history := by
    intro ctx s xs
    rw [run_full]
    exact H4_record _ _ _
  recovery := ⟨fun ctx _ _ good => H5_clear (prior ctx) good,
    fun ctx _ _ r format sigs valid => H5_rebind (prior ctx) r format sigs valid⟩

/-- Any properly signed public clear witnesses a conflict between the full machine and the old record law. -/
theorem full_excludes_frozen {s w} (ctx : Context) (good : ValidClear s w) : ¬Release.Lawful innerModel :=
  valid_clear_excludes_R10 (ctx := ctx) (next := prior ctx) rfl good

-- R10 L2 quantifies over every public state, including this empty ledger.
private def blank : Machine :=
  ⟨⟨⟨Bound4.initial 0, ⟨[], []⟩⟩, Risk8.initial, #[], #[]⟩, [], [], {}⟩

private def unsuccessful : ByteArray :=
  let intent : Intent := ⟨.deliver [], "", 1, 1⟩
  let frame : Wire5.Frame := ⟨head blank, 1, .plain (.base (.act intent))⟩
  ((23 :: List.replicate 32 0) ++ Wire5.encode frame).toByteArray

private def witness : ByteArray := (header blank 52 ++ unsuccessful.data.toList).toByteArray

set_option maxRecDepth 4096 in
/-- An accepted host halt on a wrong-generation act refutes frozen L2 without a signature assumption. -/
theorem full_violates_L2 (ctx : Context) : ¬Release.Lawful innerModel := by
  have good : (innerModel.step ctx witness blank).isSome = true := by rfl
  obtain ⟨t, ok⟩ := Option.isSome_iff_exists.mp good
  exact incompatible_L2 (w := witness) (by decide) ok

#print axioms full_violates_L2
#print axioms full_safe
#print axioms full_excludes_frozen
end Aukora.Safe11
