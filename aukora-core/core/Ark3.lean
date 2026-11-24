namespace Aukora.Ark3

-- Binary polynomials as naturals. Reducing x*a by 0x11d keeps a byte a byte.
def timesX (a : Nat) : Nat :=
  if a < 128 then a <<< 1 else (a <<< 1) ^^^ 0x11d

def mulBits : Nat → Nat → Nat → Nat
  | 0, _, _ => 0
  | n+1, a, b =>
    if a == 0 || b == 0 then 0 else
    let tail := mulBits n (timesX a) (b >>> 1)
    if b % 2 == 0 then tail else a ^^^ tail

def mul := mulBits 8

-- Only denominators 4..11 occur at k=4,n=10. Both reciprocal
-- identities are recomputed below using the defining polynomial.
def reciprocal : Nat → Nat
  | 4 => 71 | 5 => 167 | 6 => 122 | 7 => 186
  | 8 => 173 | 9 => 157 | 10 => 221 | 11 => 152
  | _ => 0

def delta (i j : Nat) : Nat := if i == j then 1 else 0

def coeff (r j : Nat) : Nat :=
  if r < 4 then delta r j else reciprocal (r ^^^ j)

theorem actualParityEntries :
    ([4,5,6,7,8,9] : List Nat).all (fun r => [0,1,2,3].all (fun j =>
      let d := r ^^^ j
      let c := coeff r j
      d != 0 && c < 256 && mul c d == 1 && mul d c == 1)) = true := by decide
#print axioms actualParityEntries

abbrev Rows := Nat × Nat × Nat × Nat
abbrev Matrix := Nat → Nat → Nat

def minor (q : Rows) (i j : Nat) : Nat :=
  let r := match i with
    | 0 => q.1 | 1 => q.2.1 | 2 => q.2.2.1 | _ => q.2.2.2
  coeff r j

-- The witness is 16 bytes, in row-major order with the first entry in the low byte.
def entry (packed i j : Nat) : Nat := (packed >>> (8*(4*i+j))) % 256

def product (a b : Matrix) (i j : Nat) : Nat :=
  mul (a i 0) (b 0 j) ^^^ mul (a i 1) (b 1 j) ^^^
  mul (a i 2) (b 2 j) ^^^ mul (a i 3) (b 3 j)

def axis : List Nat := [0,1,2,3]

def check (a b : Matrix) : Bool :=
  axis.all (fun i => axis.all (fun j =>
    product a b i j == delta i j && product b a i j == delta i j))

def TwoSided (a b : Matrix) : Prop :=
  ∀ i ∈ axis, ∀ j ∈ axis,
    product a b i j = delta i j ∧ product b a i j = delta i j

theorem check_spec (a b : Matrix) : check a b = true ↔ TwoSided a b := by
  simp [check, TwoSided]
#print axioms check_spec

structure Certificate where
  rows : Rows
  inverse : Nat
  verifies : check (minor rows) (entry inverse) = true

end Aukora.Ark3
