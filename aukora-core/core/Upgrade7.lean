import core.Upgrade6

namespace Aukora.Upgrade7
open Bound5 (Machine)
open R6.KernelCell (Context)
open Upgrade6 (Upgrade Input)
open private Upgrade6.isOldUpgrade from core.Upgrade6

private def wideHeader : Wire4.Reader (Digest × Nat × Digest × Nat) := do
  let parent ← Wire4.digestField
  let seq ← Wire4.uint 8
  if (← Wire4.byte) != 18 then Wire4.invalid else
    return (parent, seq, ← Wire4.digestField, ← Wire4.uint 4)

/-- Tag 18 uses a four-byte LE proof length. The target, intent and all the old tags
    keep their prior wire format. Copy certificate bytes directly from the input. -/
def decode (wire : ByteArray) : Option Input :=
  if Upgrade6.tag wire != 18 then Upgrade6.decode wire else do
    let ((parent, seq, target, size), []) ← wideHeader (wire.extract 0 77).data.toList | none
    guard (size ≤ 1024 * 1024 && 77 + size ≤ wire.size)
    let (intent, []) ← Wire4.intentField (wire.extract (77 + size) wire.size).data.toList | none
    return .certified ⟨parent, seq, target, wire.extract 77 (77 + size), intent⟩

/-- Slots 0 and 1 have independent private goals, Lawful R6Machine and Lawful OtherMachine. -/
inductive Entry where
  | roundSix
  | fixedOwner

def primaryDigest : Digest := ⟨[
  0x92, 0xba, 0xf6, 0x00, 0x40, 0xe4, 0x80, 0x0c, 0x4d, 0xfd, 0x00, 0x40, 0xbb, 0xc3, 0x2e, 0xff,
  0x86, 0x9e, 0xa8, 0x65, 0xd6, 0x28, 0x5b, 0x8f, 0x05, 0x47, 0x76, 0xe9, 0x40, 0xae, 0xd1, 0xf5]⟩

def fixedOwnerDigest : Digest := ⟨[
  0x34, 0x50, 0x1e, 0xb2, 0x05, 0x98, 0xfd, 0x7a, 0xa8, 0xab, 0x51, 0x98, 0x73, 0xae, 0x2e, 0xc9,
  0xc7, 0x8b, 0x78, 0x45, 0x7f, 0xea, 0x51, 0x18, 0xb7, 0x7d, 0xb9, 0xe1, 0xbd, 0x6a, 0xc8, 0x36]⟩

def lookup (digest : Digest) : Option Entry :=
  if digest = primaryDigest then some .roundSix
  else if digest = fixedOwnerDigest then some .fixedOwner else none

def Entry.context (primary other : Context) : Entry → Context
  | .roundSix => primary
  | .fixedOwner => other

def certified (primary other : Context) (wire : ByteArray) (s : Machine) (u : Upgrade) : Option Machine := do
  let entry ← lookup u.target
  let ctx := entry.context primary other
  let inner ← Bound4.next (fun _ => Bound4.digest wire) s.inner (u.frame ctx)
  return ⟨inner, s.ownerKey⟩

@[export r7_step]
def step (primary other : Context) (wire : ByteArray) (s : Machine) : Option Machine :=
  match decode wire with
  | none => none
  | some (.ordinary x) => if Upgrade6.isOldUpgrade x.action then none else Bound5.next Ed25519.verify s x
  | some (.certified u) => certified primary other wire s u

structure Admission (primary other : Context) (wire : ByteArray) (s t : Machine) (u : Upgrade) (entry : Entry) : Prop where
  listed : lookup u.target = some entry
  checked : R6.KernelCell.check (entry.context primary other) u.proof = true
  staged : Bound4.digest s.inner.candidate = u.target
  installed : t.inner.ledger.book.auth.core = Bound4.digest s.inner.candidate
  intent : u.intent.body = .install (Bound4.digest s.inner.candidate)
  granted : u.intent ∈ s.inner.ledger.book.auth.grants
  generation : u.intent.generation = s.inner.ledger.book.auth.generation
  spent : u.intent ∉ t.inner.ledger.book.auth.grants
  parent : u.parent = s.inner.ledger.head
  sequence : u.seq = s.inner.ledger.book.seq + 1
  head : t.inner.ledger.head = Bound4.digest wire
  owner : t.ownerKey = s.ownerKey

/-- Even correctly signed bytes need a proof accepted for their own manifest entry. -/
theorem admission {primary other wire s t u} (dec : decode wire = some (.certified u))
    (ok : step primary other wire s = some t) : ∃ entry, Admission primary other wire s t u entry := by
  cases listed : lookup u.target with
  | none => simp [step, dec, certified, listed] at ok
  | some entry =>
    cases hn : Bound4.next (fun _ => Bound4.digest wire) s.inner (u.frame (entry.context primary other)) with
    | none => simp [step, dec, certified, listed, hn] at ok
    | some inner =>
      have same : (⟨inner, s.ownerKey⟩ : Machine) = t := by
        simpa [step, dec, certified, listed, hn] using ok
      subst t
      have yes := Bound4.accepted hn
      have staged : Bound4.digest s.inner.candidate = u.target := by
        simpa [Upgrade.frame, Bound4.candidateOK] using yes.1
      obtain ⟨checked, intent, granted, generation, installed, spent⟩ :=
        Bound4.upgrade_facts (target := u.target) (checked := R6.KernelCell.check (entry.context primary other) u.proof)
          (i := u.intent) hn rfl
      obtain ⟨allowed, appended⟩ := R2.next_spec yes.2
      exact ⟨entry, listed, checked, staged, installed, intent, granted, generation, spent,
        allowed.1, allowed.2.1, congrArg R2.Ledger.head appended, rfl⟩
#print axioms admission

theorem core_change_requires_entry_proof {primary other wire s t} (ok : step primary other wire s = some t)
    (changed : t.inner.ledger.book.auth.core ≠ s.inner.ledger.book.auth.core) :
    ∃ u entry, decode wire = some (.certified u) ∧ Admission primary other wire s t u entry := by
  cases dec : decode wire with
  | none => simp [step, dec] at ok
  | some input =>
    cases input with
    | certified u =>
      obtain ⟨entry, evidence⟩ := admission dec ok
      exact ⟨u, entry, rfl, evidence⟩
    | ordinary x =>
      simp only [step, dec] at ok
      split at ok
      next => contradiction
      next old =>
        obtain ⟨_, ev, _⟩ := Bound5.core_change_only ok changed
        simp [Upgrade6.isOldUpgrade, ev] at old
#print axioms core_change_requires_entry_proof

end Aukora.Upgrade7
