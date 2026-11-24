import Ledger.GrantEvents
import Crypto.Sha256

namespace Aukora.Bound4

structure Machine where
  ledger : R2.Ledger
  candidate : ByteArray

def digest (bytes : ByteArray) : Digest := ⟨Sha256.hash bytes⟩

@[export r4_genesis]
def initial (_ : UInt8) : Machine :=
  let zero : Digest := ⟨List.replicate 32 0⟩
  ⟨R2.initial zero zero "owner", ByteArray.empty⟩

@[export r4_reset]
def reset (s : Machine) : Machine := {s with candidate := ByteArray.empty}

@[export r4_feed]
def feed (chunk : ByteArray) (s : Machine) : Machine :=
  {s with candidate := s.candidate ++ chunk}

-- Hash the whole concatenation once, on an upgrade. No hash field from the host
-- can populate the staging area. Other events need no candidate hash.
def candidateOK (bytes : ByteArray) : R2.Action → Bool
  | .base (.upgrade target _ _) => decide (digest bytes = target)
  | _ => true

private def remaining (bytes : ByteArray) : R2.Action → ByteArray
  | .base (.upgrade ..) => ByteArray.empty
  | _ => bytes

def next (hashFrame : R2.Frame → Digest) (s : Machine) (x : R2.Frame) : Option Machine :=
  if candidateOK s.candidate x.action then
    (R2.next hashFrame s.ledger x).map fun ledger => ⟨ledger, remaining s.candidate x.action⟩
  else none

theorem accepted {d s x t} (ok : next d s x = some t) :
    candidateOK s.candidate x.action = true ∧ R2.next d s.ledger x = some t.ledger := by
  unfold next at ok
  split at ok
  next h =>
    cases hn : R2.next d s.ledger x with
    | none => simp [hn] at ok
    | some l =>
      rw [hn] at ok
      change some (Machine.mk l _) = some t at ok
      have ht := Option.some.inj ok
      subst t
      exact ⟨h, rfl⟩
  next => contradiction
#print axioms accepted

theorem feed_chunks (s : Machine) (chunks : List ByteArray) :
    chunks.foldl (fun st c => feed c st) s =
      {s with candidate := chunks.foldl (· ++ ·) s.candidate} := by
  induction chunks generalizing s with
  | nil => rfl
  | cons c cs ih => exact ih (feed c s)
#print axioms feed_chunks

/-- A matching upload and an eligible grant actually admit the replacement. -/
theorem upgrade_accepts {d : R2.Frame → Digest} {s : Machine} {x target checked i}
    (ev : x.action = .base (.upgrade target checked i)) (matchBytes : digest s.candidate = target)
    (allowed : R2.Allowed s.ledger x) :
    next d s x = some ⟨R2.append d s.ledger x, ByteArray.empty⟩ := by
  simp [next, R2.next, ev, candidateOK, matchBytes, allowed, remaining]
#print axioms upgrade_accepts

theorem upgrade_facts {d s x t target checked i} (ok : next d s x = some t)
    (ev : x.action = .base (.upgrade target checked i)) :
    checked = true ∧ i.body = .install (digest s.candidate) ∧
    i ∈ s.ledger.book.auth.grants ∧ i.generation = s.ledger.book.auth.generation ∧
    t.ledger.book.auth.core = digest s.candidate ∧ i ∉ t.ledger.book.auth.grants := by
  obtain ⟨bound, okR2⟩ := accepted ok
  have hashEq : digest s.candidate = target := by simpa [ev, candidateOK] using bound
  obtain ⟨flag, body, grant, gen⟩ := Events4.upgrade_requires_grant okR2 ev
  obtain ⟨coreEq, spent⟩ := Events4.upgrade_spent okR2 ev
  exact ⟨flag, hashEq.symm ▸ body, grant, gen, coreEq.trans hashEq.symm, spent⟩
#print axioms upgrade_facts

theorem core_change_only {d s x t} (ok : next d s x = some t)
    (changed : t.ledger.book.auth.core ≠ s.ledger.book.auth.core) :
    ∃ i, x.action = .base (.upgrade (digest s.candidate) true i) ∧
      t.ledger.book.auth.core = digest s.candidate ∧ i.body = .install (digest s.candidate) ∧
      i ∈ s.ledger.book.auth.grants ∧ i.generation = s.ledger.book.auth.generation := by
  obtain ⟨i, ev, _⟩ := Events4.core_change_requires_upgrade (accepted ok).2 changed
  obtain ⟨_, body, grant, gen, h, _⟩ := upgrade_facts ok ev
  exact ⟨i, h ▸ ev, h, body, grant, gen⟩
#print axioms core_change_only

/-- No collision hypothesis is needed for an unequal digest, even if the proposed
    target field is arbitrary. Refusal preserves the ledger AND the staged bytes. -/
theorem wrong_digest {d s x target checked i approved}
    (ev : x.action = .base (.upgrade target checked i)) (body : i.body = .install approved)
    (wrong : digest s.candidate ≠ approved) :
    next d s x = none ∧ (next d s x).getD s = s := by
  cases ok : next d s x with
  | none => exact ⟨rfl, rfl⟩
  | some t => exact False.elim (wrong (Body.install.inj ((upgrade_facts ok ev).2.1.symm.trans body)))

#print axioms wrong_digest

/-- Only this passage from different *bytes* to different digests needs a
    cryptographic hypothesis, local to the approved and submitted byte strings. -/
theorem different_bytes {d s x target checked i} (approvedBytes : ByteArray)
    (ev : x.action = .base (.upgrade target checked i)) (body : i.body = .install (digest approvedBytes))
    (different : s.candidate ≠ approvedBytes)
    (noSecondPreimage : digest s.candidate = digest approvedBytes → s.candidate = approvedBytes) :
    next d s x = none ∧ (next d s x).getD s = s :=
  wrong_digest ev body (fun eq => different (noSecondPreimage eq))
#print axioms different_bytes

@[export r4_head_byte]
def headByte (s : @& Machine) (index : UInt32) : UInt8 :=
  s.ledger.head.bytes.getD index.toNat 0

@[export r4_core_byte]
def coreByte (s : @& Machine) (index : UInt32) : UInt8 :=
  s.ledger.book.auth.core.bytes.getD index.toNat 0

end Aukora.Bound4
