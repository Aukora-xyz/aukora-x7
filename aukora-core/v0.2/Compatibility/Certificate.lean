import KernelCell
import Ledger.Trace

namespace Aukora.Upgrade6
open Bound5 (Machine)
open R6.KernelCell (Context)

/-- The only entry in the lab manifest. Its fixed goal, Bound5.wrong_digest, is
    loaded by the private initializer for the same Wasm instance. -/
def candidateId : Digest := ⟨[
  0xd7, 0x4a, 0x5e, 0x01, 0x70, 0x29, 0x9d, 0x62, 0xe8, 0x34, 0x94, 0x96, 0xb9, 0xc0, 0xe3, 0x1b,
  0x2a, 0x40, 0x91, 0xb5, 0x12, 0x73, 0xef, 0x8b, 0xf8, 0x22, 0x04, 0xb3, 0x92, 0x22, 0x35, 0x0a]⟩

structure Upgrade where
  parent : Digest
  seq : Nat
  target : Digest
  proof : ByteArray
  intent : Intent

inductive Input where
  | ordinary (frame : Wire5.Frame)
  | certified (u : Upgrade)

private def upgradeField : Wire4.Reader Upgrade := do
  let parent ← Wire4.digestField
  let seq ← Wire4.uint 8
  if (← Wire4.byte) != 17 then Wire4.invalid else
    return ⟨parent, seq, ← Wire4.digestField, (← Wire4.blob).toByteArray, ← Wire4.intentField⟩

def tag (wire : ByteArray) : UInt8 := if h : 40 < wire.size then wire[40] else 255

def decode (wire : ByteArray) : Option Input :=
  if tag wire = 17 then
    match upgradeField wire.data.toList with
    | some (u, []) => some (.certified u)
    | _ => none
  else if tag wire = 7 then none
  else (Wire5.decode wire).map Input.ordinary

private def isOldUpgrade : Wire5.Action → Bool
  | .plain (.base (.upgrade ..)) => true
  | _ => false

def Upgrade.frame (u : Upgrade) (ctx : Context) : R2.Frame :=
  ⟨u.parent, u.seq, .base (.upgrade u.target (R6.KernelCell.check ctx u.proof) u.intent)⟩

private def applyUpgrade (ctx : Context) (wire : ByteArray) (s : Machine) (u : Upgrade) : Option Machine :=
  if u.target = candidateId then
    (Bound4.next (fun _ => Bound4.digest wire) s.inner (u.frame ctx)).map fun next => ⟨next, s.ownerKey⟩
  else none

@[export r6_step]
def step (ctx : Context) (wire : ByteArray) (s : Machine) : Option Machine :=
  match decode wire with
  | none => none
  | some (.ordinary x) => if isOldUpgrade x.action then none else Bound5.next Ed25519.verify s x
  | some (.certified u) => applyUpgrade ctx wire s u

theorem old_flag_refused {ctx s wire} (old : tag wire = 7) : step ctx wire s = none := by
  simp [step, decode, old]
#print axioms old_flag_refused

theorem ordinary_refines {ctx s wire x} (dec : Wire5.decode wire = some x)
    (old : tag wire ≠ 7) (fresh : tag wire ≠ 17) (ordinary : isOldUpgrade x.action = false) :
    step ctx wire s = Stateful5.stepBytes wire s := by
  simp [step, decode, old, fresh, dec, ordinary, Stateful5.stepBytes]
#print axioms ordinary_refines

/-- Facts about the exact submitted bytes, relative to this instance's private
    goal/environment. Neither the digest nor a host verdict can replace the proof. -/
structure Admission (ctx : Context) (wire : ByteArray) (s t : Machine) (u : Upgrade) : Prop where
  checked : R6.KernelCell.check ctx u.proof = true
  listed : u.target = candidateId
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

theorem upgrade_requires_proof {ctx wire s t u} (dec : decode wire = some (.certified u))
    (ok : step ctx wire s = some t) : Admission ctx wire s t u := by
  simp only [step, dec] at ok
  unfold applyUpgrade at ok
  split at ok
  next listed =>
    cases hn : Bound4.next (fun _ => Bound4.digest wire) s.inner (u.frame ctx) with
    | none => simp [hn] at ok
    | some inner =>
      rw [hn] at ok
      change some (Bound5.Machine.mk inner s.ownerKey) = some t at ok
      have same := Option.some.inj ok
      subst t
      have yes := Bound4.accepted hn
      have stageEq : Bound4.digest s.inner.candidate = u.target := by
        simpa [Upgrade.frame, Bound4.candidateOK] using yes.1
      obtain ⟨checked, intent, granted, generation, installed, spent⟩ :=
        Bound4.upgrade_facts (target := u.target) (checked := R6.KernelCell.check ctx u.proof)
          (i := u.intent) hn rfl
      obtain ⟨allowed, appended⟩ := R2.next_spec yes.2
      exact ⟨checked, listed, stageEq, installed, intent, granted, generation, spent,
        allowed.1, allowed.2.1, congrArg R2.Ledger.head appended, rfl⟩
  next => contradiction
#print axioms upgrade_requires_proof

theorem core_change_requires_proof {ctx wire s t} (ok : step ctx wire s = some t)
    (changed : t.inner.ledger.book.auth.core ≠ s.inner.ledger.book.auth.core) :
    ∃ u, decode wire = some (.certified u) ∧ Admission ctx wire s t u := by
  cases dec : decode wire with
  | none => simp [step, dec] at ok
  | some input =>
    cases input with
    | certified u =>
      refine ⟨u, ?_, upgrade_requires_proof dec ok⟩
      first | rfl | exact dec
    | ordinary x =>
      simp only [step, dec] at ok
      split at ok
      next => contradiction
      next old =>
        obtain ⟨_, ev, _⟩ := Bound5.core_change_only ok changed
        simp [isOldUpgrade, ev] at old
#print axioms core_change_requires_proof

end Aukora.Upgrade6
