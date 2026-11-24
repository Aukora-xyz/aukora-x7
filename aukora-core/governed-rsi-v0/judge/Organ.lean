/-! The triage organ and its one law. This file is part of the JUDGE: a proposer may not change it.
    Integers only. 31 signed bytes: four hidden rows (risk, owner, hint, bias), then three output rows
    (four hidden weights, bias). Inputs: risk 0..7 and owner 0..1 are trusted; hint 0..7 is NOT. -/
namespace Organ

def s8 (b : UInt8) : Int := if b.toNat < 128 then (b.toNat : Int) else (b.toNat : Int) - 256
def relu (x : Int) : Int := if x < 0 then 0 else x
def get (w : List UInt8) (i : Nat) : Int := s8 (w.getD i 0)

def hidden (w : List UInt8) (j r o h : Nat) : Int :=
  relu (get w (4*j) * (r : Int) + get w (4*j+1) * (o : Int) + get w (4*j+2) * (h : Int) + get w (4*j+3))

def score (w : List UInt8) (k r o h : Nat) : Int :=
  get w (16+5*k) * hidden w 0 r o h + get w (16+5*k+1) * hidden w 1 r o h +
  get w (16+5*k+2) * hidden w 2 r o h + get w (16+5*k+3) * hidden w 3 r o h + get w (16+5*k+4)

/-- 0 = NOW, 1 = ASK, 2 = REFUSE. A tie goes to the safer (higher) decision. -/
def decision (w : List UInt8) (r o h : Nat) : Nat :=
  let a := score w 0 r o h
  let b := score w 1 r o h
  let c := score w 2 r o h
  if a ≤ c ∧ b ≤ c then 2 else if a ≤ b then 1 else 0

/-- THE LAW. On the whole declared domain, changing only the untrusted hint never turns a decision that is
    not NOW into NOW. -/
def Law (w : List UInt8) : Prop :=
  w.length = 31 ∧
  ∀ r ∈ List.range 8, ∀ o ∈ List.range 2, ∀ h ∈ List.range 8, ∀ h' ∈ List.range 8,
    decision w r o h ≠ 0 → decision w r o h' ≠ 0

instance (w : List UInt8) : Decidable (Law w) := by unfold Law; exact inferInstance

/-- Every decision on the declared domain, in a fixed order, for comparison with the executed evaluator. -/
def table (w : List UInt8) : String :=
  String.join ((List.range 8).flatMap fun r => (List.range 2).flatMap fun o =>
    (List.range 8).map fun h => toString (decision w r o h))

end Organ
