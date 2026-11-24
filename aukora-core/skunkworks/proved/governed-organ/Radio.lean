/-! Governed organ v2, the judge's model. Lab fixture. Core Lean only.

STRUCTURE DERIVED, EXACTNESS PINNED.
Derived (form taken from "attention is a radio head", arXiv 2611.13146, Eqs. 11 and 12): each line of evidence
adds gain squared over detuning squared to a coupling sum; below the critical coupling the committed share
EQUALS that sum and the remainder is unread; the receiver may lock only when the sum reaches one.
Pinned by the author of this fixture: the whole P = 144; the coupling constant K² = 1/4; detuning = 1 + age,
so its minimum is 1 and no declared line is resonant; ages 0, 1, 2 (older lines are not heard); gains at
most 2; denominators cleared once into the integer table `scale`.
Declared property of the domain: lines are ORTHOGONAL BY CONSTRUCTION. Each line contributes its own energy
and nothing else; no cross term exists in this model.
The law speaks for the SILENT side only. Above the threshold the split of the committed share between the
two sides is by energy proportion; that part is authored, not derived.

The organ is 96 three-valued weights (its address is one number below 3^96, 20 bytes). It does one thing:
for each kind of line it says how loudly to listen, from -2 to +2. Everything else is the judge's arithmetic. -/
namespace Radio

def P : Nat := 144

structure Line where
  source : Nat      -- 0 trusted, 1 untrusted
  side : Nat        -- 0 for, 1 against
  kind : Nat        -- 0..3
  level : Nat       -- how well the line matches the question, 0..2
  age : Nat         -- 0..2 are heard
  deriving DecidableEq, Repr

/-- base-three digits, least significant first -/
def digits : Nat → Nat → List Nat
  | 0, _ => []
  | k + 1, n => (n % 3) :: digits k (n / 3)

/-- The organ, read from its address. -/
def trits (addr : Nat) : List Nat := digits 96 addr

/-- Which pair of weights a line reads: 48 entries. -/
def entry (l : Line) : Nat := ((l.source * 2 + l.side) * 4 + l.kind) * 3 + l.level

/-- Signed gain of an entry: the sum of two weights, each -1, 0 or +1. Entries outside the 48 are not heard. -/
def gainAt (w : List Nat) (e : Nat) : Int :=
  if e < 48 then ((w.getD (2 * e) 1 : Nat) : Int) - 1 + (((w.getD (2 * e + 1) 1 : Nat) : Int) - 1) else 0

def gain (w : List Nat) (l : Line) : Int := gainAt w (entry l)

/-- 144 · K² / detuning², with K² = 1/4 and detuning = 1 + age. -/
def scale : Nat → Nat
  | 0 => 36 | 1 => 9 | 2 => 4 | _ => 0

def energy (w : List Nat) (l : Line) : Nat := (gain w l).natAbs * (gain w l).natAbs * scale l.age

def forE (w : List Nat) : List Line → Nat
  | [] => 0
  | l :: ls => (if gain w l > 0 then energy w l else 0) + forE w ls

def agE (w : List Nat) : List Line → Nat
  | [] => 0
  | l :: ls => (if gain w l < 0 then energy w l else 0) + agE w ls

/-- The committed share: the coupling sum, capped at the whole. -/
def committed (w : List Nat) (E : List Line) : Nat := min P (forE w E + agE w E)

def belief (w : List Nat) (E : List Line) : Nat :=
  if forE w E + agE w E = 0 then 0 else committed w E * forE w E / (forE w E + agE w E)
def doubt (w : List Nat) (E : List Line) : Nat := committed w E - belief w E
def rest (w : List Nat) (E : List Line) : Nat := P - committed w E

/-- 0 NOW, 1 ASK, 2 REFUSE. NOW only when nothing is left unread and belief wins. -/
def decision (w : List Nat) (E : List Line) : Nat :=
  if rest w E = 0 ∧ doubt w E < belief w E then 0
  else if 0 < doubt w E ∧ belief w E ≤ doubt w E then 2 else 1

/-! ## Universal theorems: true for EVERY organ and EVERY list of lines. Proved once; no enumeration. -/

theorem belief_le (w : List Nat) (E : List Line) : belief w E ≤ committed w E := by
  unfold belief
  split
  · exact Nat.zero_le _
  · apply Nat.div_le_of_le_mul
    calc committed w E * forE w E ≤ committed w E * (forE w E + agE w E) :=
          Nat.mul_le_mul_left _ (Nat.le_add_right _ _)
      _ = (forE w E + agE w E) * committed w E := Nat.mul_comm _ _

/-- CONSERVATION. The three shares always add to the whole. No organ can mint or lose mass. -/
theorem conserved (w : List Nat) (E : List Line) : belief w E + rest w E + doubt w E = P := by
  have hb := belief_le w E
  have hc : committed w E ≤ P := Nat.min_le_left _ _
  unfold doubt rest
  omega

/-- SILENCE (Eq. 12 as an equality). Below the threshold the organ does not act, and each side's share is
    exactly its energy: the committed share equals the coupling sum and the remainder is unread. -/
theorem silent (w : List Nat) (E : List Line) (h : forE w E + agE w E < P) :
    decision w E ≠ 0 ∧ belief w E = forE w E ∧ doubt w E = agE w E := by
  have hc : committed w E = forE w E + agE w E := by
    unfold committed; exact Nat.min_eq_right (Nat.le_of_lt h)
  have hb : belief w E = forE w E := by
    unfold belief
    split
    · omega
    · rename_i ne
      rw [hc]; exact Nat.mul_div_cancel_left _ (Nat.pos_of_ne_zero ne)
  have hd : doubt w E = agE w E := by unfold doubt; omega
  refine ⟨?_, hb, hd⟩
  have hr : ¬ (rest w E = 0 ∧ doubt w E < belief w E) := fun ⟨z, _⟩ => by unfold rest at z; omega
  unfold decision
  rw [if_neg hr]
  split <;> decide

/-! ## The three laws a candidate organ must satisfy. Each is checked by the kernel on the exact weights. -/

/-- DEAF: the organ gives no gain to any untrusted line (entries 24 to 47). -/
def Deaf (w : List Nat) : Prop := ∀ e ∈ List.range 24, gainAt w (24 + e) = 0

/-- NO LOUDER THAN THE MATCH: an entry's gain never exceeds the line's own match level (entry mod 3). -/
def NoAmp (w : List Nat) : Prop := ∀ e ∈ List.range 48, (gainAt w e).natAbs ≤ e % 3

/-- TRUE TO ITS SIDE: a line for may be heard or ignored, never counted against, and the reverse. -/
def SideTrue (w : List Nat) : Prop :=
  ∀ e ∈ List.range 48, (gainAt w e > 0 → (e / 12) % 2 = 0) ∧ (gainAt w e < 0 → (e / 12) % 2 = 1)

instance (w : List Nat) : Decidable (Deaf w) := by unfold Deaf; exact inferInstance
instance (w : List Nat) : Decidable (NoAmp w) := by unfold NoAmp; exact inferInstance
instance (w : List Nat) : Decidable (SideTrue w) := by unfold SideTrue; exact inferInstance

/-! ## What the laws buy, for every list of lines (again universal, no enumeration). -/

theorem deaf_gain {w : List Nat} (h : Deaf w) {l : Line} (u : l.source = 1) : gain w l = 0 := by
  unfold gain
  by_cases lt : entry l < 48
  · have ge : 24 ≤ entry l := by unfold entry; rw [u]; omega
    have := h (entry l - 24) (List.mem_range.mpr (by omega))
    have e : 24 + (entry l - 24) = entry l := by omega
    rw [e] at this
    exact this
  · unfold gainAt; rw [if_neg lt]

theorem skip_for {w : List Nat} (h : Deaf w) {l : Line} (u : l.source = 1) (E : List Line) :
    forE w (l :: E) = forE w E := by
  simp [forE, deaf_gain h u]

theorem skip_ag {w : List Nat} (h : Deaf w) {l : Line} (u : l.source = 1) (E : List Line) :
    agE w (l :: E) = agE w E := by
  simp [agE, deaf_gain h u]

theorem decision_of_energies {w : List Nat} {E E' : List Line}
    (hf : forE w E = forE w E') (ha : agE w E = agE w E') : decision w E = decision w E' := by
  simp only [decision, rest, doubt, belief, committed, hf, ha]

/-- NON-INTERFERENCE. For a deaf organ, adding an untrusted line changes nothing: not the shares, not the answer. -/
theorem deaf_ignores {w : List Nat} (h : Deaf w) (l : Line) (u : l.source = 1) (E : List Line) :
    decision w (l :: E) = decision w E :=
  decision_of_energies (skip_for h u E) (skip_ag h u E)

/-- The honest coupling: what the trusted lines would give at their full match level. -/
def honest : List Line → Nat
  | [] => 0
  | l :: ls => (if l.source = 0 then l.level * l.level * scale l.age else 0) + honest ls

theorem gain_zero_far {w : List Nat} {l : Line} (far : 2 ≤ l.source) : gain w l = 0 := by
  unfold gain gainAt
  have : ¬ entry l < 48 := by unfold entry; omega
  rw [if_neg this]

theorem amp_gain {w : List Nat} (h : NoAmp w) (l : Line) : (gain w l).natAbs ≤ l.level := by
  unfold gain
  by_cases lt : entry l < 48
  · have := h (entry l) (List.mem_range.mpr lt)
    have m : entry l % 3 ≤ l.level := by unfold entry; omega
    exact Nat.le_trans this m
  · unfold gainAt; rw [if_neg lt]; exact Nat.zero_le _

theorem line_le {w : List Nat} (hn : NoAmp w) (hd : Deaf w) (l : Line) :
    (if gain w l > 0 then energy w l else 0) + (if gain w l < 0 then energy w l else 0) ≤
      (if l.source = 0 then l.level * l.level * scale l.age else 0) := by
  by_cases s0 : l.source = 0
  · have a := amp_gain hn l
    have e : energy w l ≤ l.level * l.level * scale l.age := by
      unfold energy
      exact Nat.mul_le_mul_right _ (Nat.mul_le_mul a a)
    rw [if_pos s0]
    by_cases p : gain w l > 0
    · have np : ¬ gain w l < 0 := by omega
      rw [if_pos p, if_neg np]; omega
    · rw [if_neg p]
      by_cases q : gain w l < 0
      · rw [if_pos q]; omega
      · rw [if_neg q]; omega
  · have z : gain w l = 0 := by
      by_cases s1 : l.source = 1
      · exact deaf_gain hd s1
      · exact gain_zero_far (by omega)
    rw [if_neg s0, z]
    simp

theorem coupling_le_honest {w : List Nat} (hn : NoAmp w) (hd : Deaf w) :
    ∀ E : List Line, forE w E + agE w E ≤ honest E
  | [] => Nat.le_refl _
  | l :: E => by
    have ih := coupling_le_honest hn hd E
    have one := line_le hn hd l
    simp only [forE, agE, honest]
    omega

/-- NO HALLUCINATED COUPLING. A lawful organ answers NOW only when the honest coupling of the TRUSTED lines
    reaches the threshold. Whatever the weights, it cannot act on evidence that is not there. -/
theorem acts_only_on_evidence {w : List Nat} (hn : NoAmp w) (hd : Deaf w) (E : List Line)
    (now : decision w E = 0) : P ≤ honest E := by
  have le := coupling_le_honest hn hd E
  by_cases h : forE w E + agE w E < P
  · exact absurd now (silent w E h).1
  · omega

/-! ## For the differential check against the executed evaluator -/
def gains (w : List Nat) : String :=
  String.intercalate "," ((List.range 48).map fun e => toString (gainAt w e))

#print axioms conserved
#print axioms silent
#print axioms deaf_ignores
#print axioms acts_only_on_evidence
end Radio
