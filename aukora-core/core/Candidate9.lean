import core.Laws7

namespace R9Candidate
open Aukora Laws7

/-- Published RFC 8032 test key 2. Every fresh instance starts with this public fixture key. -/
def ownerKey : Bytes := [
  0x3d, 0x40, 0x17, 0xc3, 0xe8, 0x43, 0x89, 0x5a, 0x92, 0xb7, 0x0a, 0xa7, 0x4d, 0x1b, 0x7e, 0xbc,
  0x9c, 0x98, 0x2c, 0xcf, 0x2e, 0xc4, 0x96, 0x8c, 0xc0, 0xcd, 0x55, 0xf1, 0x2a, 0xf4, 0x66, 0x0c]

def honest (ctx : R6.KernelCell.Context) : Machine :=
  {R6Machine ctx with genesis := fun _ => (R6Machine ctx).genesis ownerKey}

theorem honest_lawful : Lawful honest := lawful_precompose r6_lawful (fun _ => ownerKey)

/-- This candidate falsely reports confirmation even in a ledger with no outcomes. -/
def broken (ctx : R6.KernelCell.Context) : Machine :=
  {R6Machine ctx with outcomes := fun _ _ => .confirmed}

theorem broken_unlawful : ¬ Lawful broken := by
  intro law
  obtain ⟨env⟩ := (inferInstance : Nonempty Lean.Kernel.Environment)
  let ctx : R6.KernelCell.Context := ⟨env, Lean.mkConst ``False⟩
  let intent : Intent := ⟨.deliver [], "", 0, 0⟩
  have impossible := ((law ctx []).outcome [] intent).1.mp rfl
  simpa [entries, kept] using impossible

#print axioms honest_lawful
#print axioms broken_unlawful
end R9Candidate
