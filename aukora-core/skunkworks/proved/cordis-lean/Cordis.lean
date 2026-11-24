/-! A first sketch of the Cordis paper's revertible effects in core Lean (side lab, in no repository).
Source: "A Programming Paradigm for Spatiotemporal Composability" (Shi, Zhang, Cui), Section 3.1 and Theorem 40.
The paper's proofs are on paper. These are the same statements, or small parts of them, checked by the kernel.
What is here: the tracked context, Theorem 7 (one tracked step preserves what recovery gives), the n-step
consequence used by Theorem 16 (after any sequence of witnessed effects, recovery returns the starting state),
unloading in reverse order step by step, and Theorem 40 for a keyed store (writes at distinct keys commute).
What is NOT here: independence in general (Theorem 20, Corollary 21), coeffects, the calculus of Section 4. -/
namespace Cordis
variable {Γ : Type}

/-- The effect context ∂Γ: the state, and the function that would recover the origin from it. -/
abbrev Tracked (Γ : Type) := Γ × (Γ → Γ)

/-- track (f, g): do f, and remember g in front of what was already owed. -/
def track (f g : Γ → Γ) (s : Tracked Γ) : Tracked Γ := (f s.1, s.2 ∘ g)

/-- recover: run everything owed, and owe nothing. -/
def recover (s : Tracked Γ) : Tracked Γ := (s.2 s.1, id)

/-- THEOREM 7. If g undoes f at this state, tracking the pair changes nothing about what recovery gives. -/
theorem recover_track (f g : Γ → Γ) (s : Tracked Γ) (w : g (f s.1) = s.1) :
    recover (track f g s) = recover s := by
  simp [recover, track, w]

/-- An effect chooses its inverse per state (the paper's 𝔈Γ). -/
abbrev Effect (Γ : Type) := Γ → Γ × (Γ → Γ)

/-- Witnessed everywhere (𝔈Γ*): the inverse an effect yields takes its own result back. -/
def Witnessed (e : Effect Γ) : Prop := ∀ γ, (e γ).2 (e γ).1 = γ

/-- Apply an effect on the tracked context (the paper's `effect`). -/
def apply (e : Effect Γ) (s : Tracked Γ) : Tracked Γ := ((e s.1).1, s.2 ∘ (e s.1).2)

def run (es : List (Effect Γ)) (s : Tracked Γ) : Tracked Γ := es.foldl (fun s e => apply e s) s

theorem recover_apply (e : Effect Γ) (w : Witnessed e) (s : Tracked Γ) : recover (apply e s) = recover s := by
  simp [recover, apply, w s.1]

/-- TEMPORAL COMPOSABILITY, the n-step form. However many witnessed effects a component performed, and whatever
    they were, recovery returns exactly what recovery would have returned before it started. -/
theorem recover_run (es : List (Effect Γ)) (w : ∀ e ∈ es, Witnessed e) (s : Tracked Γ) :
    recover (run es s) = recover s := by
  induction es generalizing s with
  | nil => rfl
  | cons e es ih =>
    have h := ih (fun x hx => w x (List.mem_cons_of_mem e hx)) (apply e s)
    simp only [run, List.foldl] at h ⊢
    rw [h]
    exact recover_apply e (w e (List.mem_cons_self ..)) s

/-- From a clean start, unloading puts the state back. -/
theorem unload_restores (es : List (Effect Γ)) (w : ∀ e ∈ es, Witnessed e) (γ₀ : Γ) :
    (recover (run es (γ₀, id))).1 = γ₀ := by
  rw [recover_run es w]; rfl

/-! ## Theorem 40 for a keyed store: operations at distinct keys commute. -/
abbrev Store (K V : Type) := K → V

def update {K V : Type} [DecidableEq K] (k : K) (u : V → V) (σ : Store K V) : Store K V :=
  fun j => if j = k then u (σ j) else σ j

theorem distinct_keys_commute {K V : Type} [DecidableEq K] (k k' : K) (ne : k ≠ k') (u u' : V → V) (σ : Store K V) :
    update k u (update k' u' σ) = update k' u' (update k u σ) := by
  funext j
  simp only [update]
  by_cases a : j = k
  · by_cases b : j = k'
    · exact absurd (a.symm.trans b) ne
    · subst a; simp [b]
  · by_cases b : j = k'
    · subst b; simp [a]
    · simp [a, b]

/-- A write and its undo, as an effect on the store: set a key, and the inverse puts the old value back. -/
def setE {K V : Type} [DecidableEq K] (k : K) (v : V) : Effect (Store K V) :=
  fun σ => (update k (fun _ => v) σ, update k (fun _ => σ k))

theorem setE_witnessed {K V : Type} [DecidableEq K] (k : K) (v : V) : Witnessed (setE k v) := by
  intro σ; funext j; by_cases a : j = k <;> simp [setE, update, a]

/-- So any plugin that only sets keys can be unloaded cleanly, whatever it set and in whatever order. -/
theorem plugin_unloads {K V : Type} [DecidableEq K] (writes : List (K × V)) (σ₀ : Store K V) :
    (recover (run (writes.map fun p => setE p.1 p.2) (σ₀, id))).1 = σ₀ := by
  apply unload_restores
  intro e he
  obtain ⟨p, _, rfl⟩ := List.mem_map.mp he
  exact setE_witnessed p.1 p.2

#print axioms recover_track
#print axioms recover_run
#print axioms unload_restores
#print axioms distinct_keys_commute
#print axioms plugin_unloads
end Cordis
