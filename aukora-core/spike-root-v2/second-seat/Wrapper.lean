/-! Second seat, for root v2 step 3a-ii: is the hint in the resume note true?
A reduced machine. The inner step never changes the refused list (as `policy_carried` shows for the real one). The
wrapper refuses an input whose form is refused and otherwise calls the inner step. Claim: a run of the wrapper equals
a run of the INNER machine over the inputs that the STARTING state does not refuse. One fixed filter, decided at
the start. If this holds, every law about whole runs is carried across by one lemma. Core Lean only. -/
namespace Wrapper

structure St (D : Type) where
  refused : List Nat
  data : D

variable {D I : Type}

def refusedBy (form : I → Option Nat) (p : List Nat) (c : I) : Bool :=
  match form c with
  | some f => p.contains f
  | none => false

def wrap (form : I → Option Nat) (inner : I → St D → Option (St D)) (c : I) (s : St D) : Option (St D) :=
  if refusedBy form s.refused c then none else inner c s

def exec (step : I → St D → Option (St D)) (s : St D) (c : I) : St D := (step c s).getD s
def run (step : I → St D → Option (St D)) (s : St D) (xs : List I) : St D := xs.foldl (exec step) s

/-- The inner machine carries the list unchanged. -/
def Carried (inner : I → St D → Option (St D)) : Prop := ∀ c s t, inner c s = some t → t.refused = s.refused

theorem exec_refused {inner : I → St D → Option (St D)} (car : Carried inner) (s : St D) (c : I) :
    (exec inner s c).refused = s.refused := by
  unfold exec
  cases h : inner c s with
  | none => rfl
  | some t => exact car c s t h

/-- THE LEMMA. Wrapper run = inner run over the inputs the starting state does not refuse. -/
theorem run_wrap (form : I → Option Nat) {inner : I → St D → Option (St D)} (car : Carried inner) :
    ∀ (xs : List I) (s : St D),
      run (wrap form inner) s xs = run inner s (xs.filter fun c => !refusedBy form s.refused c)
  | [], _ => rfl
  | c :: cs, s => by
    cases r : refusedBy form s.refused c with
    | true =>
      have step : exec (wrap form inner) s c = s := by simp [exec, wrap, r]
      simp only [run, List.foldl_cons, step, List.filter_cons, r, Bool.not_true, Bool.false_eq_true, if_false]
      exact run_wrap form car cs s
    | false =>
      have step : exec (wrap form inner) s c = exec inner s c := by simp [exec, wrap, r]
      have same : (exec inner s c).refused = s.refused := exec_refused car s c
      have ih := run_wrap form car cs (exec inner s c)
      rw [same] at ih
      simp only [run, List.foldl_cons, step, List.filter_cons, r, Bool.not_false, if_true]
      exact ih

/-- The wrapper carries the list too, so the same lemma applies to the wrapped machine's own runs. -/
theorem wrap_carried (form : I → Option Nat) {inner : I → St D → Option (St D)} (car : Carried inner) :
    Carried (wrap form inner) := by
  intro c s t h
  unfold wrap at h
  split at h
  · cases h
  · exact car c s t h

/-- A refused input changes nothing at all. -/
theorem refused_noop (form : I → Option Nat) (inner : I → St D → Option (St D)) (s : St D) (c : I)
    (r : refusedBy form s.refused c = true) : exec (wrap form inner) s c = s := by
  simp [exec, wrap, r]

/-- With nothing refused the wrapper IS the inner machine (the ordinary start is unchanged). -/
theorem empty_same (form : I → Option Nat) (inner : I → St D → Option (St D)) (s : St D) (e : s.refused = []) (c : I) :
    wrap form inner c s = inner c s := by
  have : refusedBy form s.refused c = false := by
    unfold refusedBy; rw [e]; cases form c <;> rfl
  simp [wrap, this]

#print axioms run_wrap
#print axioms wrap_carried
#print axioms refused_noop
#print axioms empty_same
end Wrapper
