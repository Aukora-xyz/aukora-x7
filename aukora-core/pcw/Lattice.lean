namespace PCW

/-- A row contains two signed, two's-complement weight bytes and one bias byte. -/
structure Row where
  w0 : UInt8
  w1 : UInt8
  bias : UInt8

/-- Widths 2 → 2 → 1. Every row, including the readout, ends in ReLU. -/
structure Lattice where
  hidden0 : Row
  hidden1 : Row
  readout : Row

abbrev Input := Bool × Bool
abbrev Output := UInt32

@[inline] private def signedWord (b : UInt8) : UInt32 :=
  (b.toUInt32 ^^^ 128) - 128

@[inline] private def unit (w0 w1 bias : UInt8) (x y : UInt32) : UInt32 :=
  let z := signedWord w0 * x + signedWord w1 * y + signedWord bias
  if z < 0x80000000 then z else 0

/-- Scalar entry point shared by the Lean interpreter and the Wasm export.
    The Input ABI supplies x,y ∈ {0,1}. All signed preactivations then fit in 32 bits. -/
@[export pcw_run]
def runWords (a b c d e f g h i : UInt8) (x y : UInt32) : UInt32 :=
  unit g h i (unit a b c x y) (unit d e f x y)

def bit (b : Bool) : UInt32 := if b then 1 else 0

def run (n : Lattice) (input : Input) : Output :=
  runWords n.hidden0.w0 n.hidden0.w1 n.hidden0.bias
    n.hidden1.w0 n.hidden1.w1 n.hidden1.bias n.readout.w0 n.readout.w1 n.readout.bias
    (bit input.1) (bit input.2)

/-- The v0 payload is exactly nine bytes in row order. No header or padding. -/
def encode (n : Lattice) : List UInt8 :=
  [n.hidden0.w0, n.hidden0.w1, n.hidden0.bias, n.hidden1.w0, n.hidden1.w1,
   n.hidden1.bias, n.readout.w0, n.readout.w1, n.readout.bias]

def decode : List UInt8 → Option Lattice
  | [a,b,c,d,e,f,g,h,i] => some ⟨⟨a,b,c⟩, ⟨d,e,f⟩, ⟨g,h,i⟩⟩
  | _ => none

theorem decode_encode (n : Lattice) : decode (encode n) = some n := rfl

theorem encode_injective {n m : Lattice} (h : encode n = encode m) : n = m :=
  Option.some.inj ((decode_encode n).symm.trans ((congrArg decode h).trans (decode_encode m)))

def Meets (n : Lattice) (spec : Input → Output) : Prop :=
  ∀ x y : Bool, run n (x, y) = spec (x, y)

instance (n : Lattice) (spec : Input → Output) : Decidable (Meets n spec) :=
  inferInstanceAs (Decidable (∀ x y : Bool, run n (x, y) = spec (x, y)))

/-- The receiver supplies both indices. A witness must be the lattice decoded from those bytes. -/
structure Certificate (payload : List UInt8) (spec : Input → Output) : Prop where
  valid : ∃ n, decode payload = some n ∧ Meets n spec

def xorSpec (v : Input) : Output := bit (v.1 != v.2)
def andSpec (v : Input) : Output := bit (v.1 && v.2)

#print axioms decode_encode
#print axioms encode_injective

end PCW
