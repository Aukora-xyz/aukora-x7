import Forms

/-! Root v2 step 3a-ii: the machine reads the refused list. ONE place: a wrapper around a model's four
public operations. An input whose form is in the state's refused register is not admitted and changes
nothing; every other input goes to the inner operation unchanged. -/

namespace Aukora.Refusal
open Release Forms
open R6.KernelCell (Context)

/-- The essential forms (decision C2): halt, clear, the newer key change (ff 02 35), seal and continuation.
    The machine never refuses them, whatever the register says; `essentials_open` shows no input puts them there. -/
def essential : FormId → Bool
  | .halt | .clear | .keyChange | .seal | .continuation => true
  | _ => false

/-- The executable test: the input's form is in the state's refused register and is not essential. -/
def refuses (s : Release.State) (c : Input) : Bool :=
  match inputForm c with
  | some f => !essential f && s.policy.refused.contains f.code
  | none => false

/-- A refused, non-essential input form. -/
def Blocked (s : Release.State) (c : Input) : Prop :=
  ∃ f, inputForm c = some f ∧ essential f = false ∧ f.code ∈ s.policy.refused

theorem refuses_iff {s : Release.State} {c : Input} : refuses s c = true ↔ Blocked s c := by
  unfold refuses Blocked
  cases h : inputForm c with
  | none => simp
  | some f => cases e : essential f <;> simp [e]

/-- What the machine refuses is refused by the register. -/
theorem refuses_refusedIn {s : Release.State} {c : Input} (r : refuses s c = true) : RefusedIn s c := by
  obtain ⟨f, h, _, m⟩ := refuses_iff.mp r
  exact ⟨f, h, m⟩

theorem not_refuses {s : Release.State} {c : Input} (n : ¬ RefusedIn s c) : refuses s c = false := by
  cases r : refuses s c with
  | false => rfl
  | true => exact absurd (refuses_refusedIn r) n

/-- The test reads only the refused register. -/
theorem refuses_congr {s t : Release.State} (h : t.policy.refused = s.policy.refused) (c : Input) :
    refuses t c = refuses s c := by
  simp [refuses, h]

/-- The wrapper. -/
def wrap (m : Model) : Model :=
  { m with
    step := fun ctx w s => if refuses s (.frame w) then none else m.step ctx w s
    feed := fun b s => if refuses s (.feed b) then s else m.feed b s
    reset := fun s => if refuses s .reset then s else m.reset s
    stamp := fun w s => if refuses s (.stamp w) then none else m.stamp w s }

theorem execute_wrap (m : Model) (ctx : Context) (s : Release.State) (c : Input) :
    execute (wrap m) ctx s c = if refuses s c then s else execute m ctx s c := by
  cases c <;> simp only [execute, wrap] <;> split <;> rfl

/-- A model whose operations never change the refused register. -/
def Carries (m : Model) : Prop := ∀ ctx s c, (execute m ctx s c).policy.refused = s.policy.refused

theorem wrap_carries {m : Model} (car : Carries m) : Carries (wrap m) := by
  intro ctx s c
  rw [execute_wrap]
  split
  · rfl
  · exact car ctx s c

theorem run_refused {m : Model} (car : Carries m) (ctx : Context) :
    ∀ (xs : List Input) (s : Release.State), (run m ctx s xs).policy.refused = s.policy.refused
  | [], _ => rfl
  | c :: cs, s => by
    simp only [run]
    rw [run_refused car ctx cs, car]

/-- THE FIXED FILTER. A run of the wrapper equals a run of the inner model over the inputs the
    STARTING state does not refuse. -/
theorem run_wrap {m : Model} (car : Carries m) (ctx : Context) :
    ∀ (xs : List Input) (s : Release.State),
      run (wrap m) ctx s xs = run m ctx s (xs.filter fun c => !refuses s c)
  | [], _ => rfl
  | c :: cs, s => by
    cases r : refuses s c with
    | true =>
      simp only [run, execute_wrap, r, if_true, List.filter_cons, Bool.not_true, Bool.false_eq_true, if_false]
      exact run_wrap car ctx cs s
    | false =>
      have ih := run_wrap car ctx cs (execute m ctx s c)
      have same : ∀ d, refuses (execute m ctx s c) d = refuses s d := refuses_congr (car ctx s c)
      simp only [same] at ih
      simp only [run, execute_wrap, r, Bool.false_eq_true, if_false, List.filter_cons, Bool.not_false, if_true]
      exact ih

/-- A refused input changes nothing at all. -/
theorem refused_noop {m : Model} {ctx : Context} {s : Release.State} {c : Input} (r : refuses s c = true) :
    execute (wrap m) ctx s c = s := by
  rw [execute_wrap, if_pos r]

/-- A refused frame is not admitted. -/
theorem refused_step {m : Model} {ctx : Context} {s : Release.State} {w : ByteArray} (r : Blocked s (.frame w)) :
    (wrap m).step ctx w s = none := by
  show (if refuses s (.frame w) then none else m.step ctx w s) = none
  rw [if_pos (refuses_iff.mpr r)]

/-- With nothing refused the wrapper is the inner model. -/
theorem empty_refuses {s : Release.State} (e : s.policy.refused = []) (c : Input) : refuses s c = false := by
  unfold refuses; rw [e]; split <;> simp

theorem empty_same {m : Model} {ctx : Context} {s : Release.State} (e : s.policy.refused = []) (c : Input) :
    execute (wrap m) ctx s c = execute m ctx s c := by
  rw [execute_wrap, if_neg (by rw [empty_refuses e]; decide)]

#print axioms run_wrap
#print axioms wrap_carries
#print axioms refused_noop
#print axioms empty_same
end Aukora.Refusal
