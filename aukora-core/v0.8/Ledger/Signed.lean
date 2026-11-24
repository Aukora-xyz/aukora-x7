import Ledger.Bound
import Wire.Signed
import Crypto.Ed25519

namespace Aukora.Bound5

open Wire5 (Frame Action intentBytes rebindBytes controlBytes)

abbrev Verifier := Bytes → Bytes → Bytes → Bool

structure Machine where
  inner : Bound4.Machine
  ownerKey : Bytes

/-- The C initializer passes a 32-byte public key through `genesis` exactly once. -/
def initial (key : Bytes) : Machine :=
  let zero : Digest := ⟨List.replicate 32 0⟩
  ⟨⟨R2.initial zero zero (Wire5.keyName key), ByteArray.empty⟩, key⟩

@[export r5_genesis]
def genesis (key : ByteArray) : Option Machine :=
  let k := key.data.toList
  if Ed25519.validKey k then some (initial k) else none

@[export r5_reset]
def reset (s : Machine) : Machine := {s with inner := Bound4.reset s.inner}

@[export r5_feed]
def feed (chunk : ByteArray) (s : Machine) : Machine := {s with inner := Bound4.feed chunk s.inner}

/-- A signature has no freshness by itself. An accepted generation/nonce pair
    can never be issued again, even after the grant leaves the unspent pool. -/
def usedNonce (s : Machine) (i : Intent) : Bool :=
  s.inner.ledger.history.any fun x => match x.action with
    | .base (.grant j true) => i.generation == j.generation && i.nonce == j.nonce
    | _ => false

/-- The decoder enforces these widths. Keep the pure transition's canonical
    signing domain equally narrow when called on constructed Lean values. -/
def intentFits (i : Intent) : Bool :=
  i.nonce < 65536 && i.generation < 65536 && (Wire4.textBytes i.audience).length < 65536 &&
    match i.body with
    | .deliver payload => payload.length < 65536
    | .install d => d.bytes.length == 32

def authorized (verify : Verifier) (s : Machine) (x : Frame) : Bool :=
  match x.action with
  | .plain op => Wire5.plainOK op
  | .grant i sig => intentFits i && !usedNonce s i && verify s.ownerKey (intentBytes i) sig
  | .rebind newKey sig => Ed25519.validKey newKey &&
      verify s.ownerKey (rebindBytes s.inner.ledger.book.auth.generation newKey) sig
  | .control op sig => verify s.ownerKey (controlBytes s.inner.ledger.book.auth.generation x op) sig

def afterKey (s : Machine) : Action → Bytes
  | .rebind newKey _ => newKey
  | _ => s.ownerKey

def frameDigest (x : Frame) : Digest := Bound4.digest (Wire5.encode x).toByteArray

/-- The R4 ledger receives only the projected decision and the digest of the
    whole R5 frame (including the exact signature). Its policy still applies. -/
def next (verify : Verifier) (s : Machine) (x : Frame) : Option Machine :=
  if authorized verify s x then
    (Bound4.next (fun _ => frameDigest x) s.inner x.project).map fun inner =>
      ⟨inner, afterKey s x.action⟩
  else none

theorem accepted {verify s x t} (ok : next verify s x = some t) :
    authorized verify s x = true ∧
    Bound4.next (fun _ => frameDigest x) s.inner x.project = some t.inner ∧
    t.ownerKey = afterKey s x.action := by
  unfold next at ok
  split at ok
  next h =>
    cases hn : Bound4.next (fun _ => frameDigest x) s.inner x.project with
    | none => simp [hn] at ok
    | some inner =>
      rw [hn] at ok
      change some (Machine.mk inner _) = some t at ok
      have ht := Option.some.inj ok
      subst t
      exact ⟨h, rfl, rfl⟩
  next => contradiction
#print axioms accepted

theorem grant_verified {verify s x t i sig} (ok : next verify s x = some t)
    (action : x.action = .grant i sig) :
    verify s.ownerKey (intentBytes i) sig = true ∧ usedNonce s i = false := by
  have h := (accepted ok).1
  simp [authorized, action, Bool.and_eq_true] at h
  exact ⟨h.2, h.1.2⟩
#print axioms grant_verified

/-- Every newly unspent intent was added by its own internally verified grant.
    This covers *every* action, including malformed plain projections. -/
theorem new_grant_requires_signature {verify s x t i} (ok : next verify s x = some t)
    (old : i ∉ s.inner.ledger.book.auth.grants) (newGrant : i ∈ t.inner.ledger.book.auth.grants) :
    ∃ sig, x.action = .grant i sig ∧ verify s.ownerKey (intentBytes i) sig = true := by
  have h := accepted ok
  have r2 := (Bound4.accepted h.2.1).2
  have ev : x.project.action = .base (.grant i true) := by
    by_cases yes : x.project.action = .base (.grant i true)
    · exact yes
    · exact False.elim ((Events4.grant_absent_after r2 old yes) newGrant)
  have gate := h.1
  cases act : x.action with
  | plain op =>
    have opEq : op = .base (.grant i true) := by simpa [Frame.project, Wire5.Action.project, act] using ev
    simp [authorized, act, opEq, Wire5.plainOK] at gate
  | grant j sig =>
    have ji : j = i := by simpa [Frame.project, Wire5.Action.project, act] using ev
    subst j
    exact ⟨sig, rfl, (grant_verified ok act).1⟩
  | rebind => simp [Frame.project, Wire5.Action.project, act] at ev
  | control op sig => cases op <;> simp [Frame.project, Wire5.Action.project, act, Wire5.Control.project] at ev
#print axioms new_grant_requires_signature

theorem rebind_verified {verify s x t newKey sig} (ok : next verify s x = some t)
    (ev : x.action = .rebind newKey sig) :
    verify s.ownerKey (rebindBytes s.inner.ledger.book.auth.generation newKey) sig = true ∧
    t.ownerKey = newKey ∧ t.inner.ledger.book.auth.grants = [] ∧
    t.inner.ledger.book.auth.generation = s.inner.ledger.book.auth.generation + 1 := by
  obtain ⟨gate, inner, key⟩ := accepted ok
  simp [authorized, ev, Bool.and_eq_true] at gate
  have signed := gate.2
  have led := (R2.next_spec (Bound4.accepted inner).2).2
  refine ⟨signed, by simpa [ev, afterKey] using key, ?_, ?_⟩ <;>
    simp [led, R2.append, Frame.project, ev, Wire5.Action.project, R2.nextBook, advance, changeAuth]
#print axioms rebind_verified

theorem owner_change_only {verify s x t} (ok : next verify s x = some t) (changed : t.ownerKey ≠ s.ownerKey) :
    ∃ sig, x.action = .rebind t.ownerKey sig ∧
      verify s.ownerKey (rebindBytes s.inner.ledger.book.auth.generation t.ownerKey) sig = true ∧
      t.inner.ledger.book.auth.grants = [] := by
  have eq := (accepted ok).2.2
  cases act : x.action with
  | rebind key sig =>
    obtain ⟨signed, newKey, empty, _⟩ := rebind_verified ok act
    exact ⟨sig, newKey ▸ rfl, newKey ▸ signed, empty⟩
  | _ => exact False.elim (changed (by simpa [act, afterKey] using eq))
#print axioms owner_change_only

theorem control_verified {verify s x t op sig} (ok : next verify s x = some t)
    (ev : x.action = .control op sig) :
    verify s.ownerKey (controlBytes s.inner.ledger.book.auth.generation x op) sig = true := by
  simpa [authorized, ev] using (accepted ok).1
#print axioms control_verified

/-- The only projection that can carry an upgrade is a plain upgrade. -/
private theorem is_upgrade {x : Frame} {d checked i}
    (ev : x.project.action = .base (.upgrade d checked i)) :
    x.action = .plain (.base (.upgrade d checked i)) := by
  cases act : x.action with
  | plain op => simpa [Frame.project, Wire5.Action.project, act] using ev
  | grant | rebind => simp [Frame.project, Wire5.Action.project, act] at ev
  | control op sig => cases op <;> simp [Frame.project, Wire5.Action.project, act, Wire5.Control.project] at ev
#print axioms is_upgrade

/-- R4's three head laws and its consumption guarantee, on the signed machine. -/
theorem core_change_only {verify s x t} (ok : next verify s x = some t)
    (changed : t.inner.ledger.book.auth.core ≠ s.inner.ledger.book.auth.core) :
    ∃ i, x.action = .plain (.base (.upgrade (Bound4.digest s.inner.candidate) true i)) ∧
      t.inner.ledger.book.auth.core = Bound4.digest s.inner.candidate ∧
      i.body = .install (Bound4.digest s.inner.candidate) ∧ i ∈ s.inner.ledger.book.auth.grants ∧
      i.generation = s.inner.ledger.book.auth.generation := by
  obtain ⟨i, ev, facts⟩ := Bound4.core_change_only (accepted ok).2.1 changed
  exact ⟨i, is_upgrade ev, facts⟩
#print axioms core_change_only

theorem upgrade_facts {verify s x t target checked i} (ok : next verify s x = some t)
    (ev : x.action = .plain (.base (.upgrade target checked i))) :
    checked = true ∧ i.body = .install (Bound4.digest s.inner.candidate) ∧
    i ∈ s.inner.ledger.book.auth.grants ∧ i.generation = s.inner.ledger.book.auth.generation ∧
    t.inner.ledger.book.auth.core = Bound4.digest s.inner.candidate ∧ i ∉ t.inner.ledger.book.auth.grants :=
  Bound4.upgrade_facts (target := target) (accepted ok).2.1 (by simp [Frame.project, ev, Wire5.Action.project])
#print axioms upgrade_facts

theorem wrong_digest {verify s x target checked i approved}
    (ev : x.action = .plain (.base (.upgrade target checked i))) (body : i.body = .install approved)
    (wrong : Bound4.digest s.inner.candidate ≠ approved) :
    next verify s x = none ∧ (next verify s x).getD s = s := by
  cases ok : next verify s x with
  | none => exact ⟨rfl, rfl⟩
  | some t => exact False.elim (wrong (Body.install.inj ((upgrade_facts ok ev).2.1.symm.trans body)))
#print axioms wrong_digest

theorem different_bytes {verify s x target checked i} (approved : ByteArray)
    (ev : x.action = .plain (.base (.upgrade target checked i))) (body : i.body = .install (Bound4.digest approved))
    (different : s.inner.candidate ≠ approved)
    (noSecondPreimage : Bound4.digest s.inner.candidate = Bound4.digest approved → s.inner.candidate = approved) :
    next verify s x = none ∧ (next verify s x).getD s = s :=
  wrong_digest ev body (fun same => different (noSecondPreimage same))
#print axioms different_bytes

@[export r5_head_byte]
def headByte (s : @& Machine) (index : UInt32) : UInt8 := Bound4.headByte s.inner index

@[export r5_core_byte]
def coreByte (s : @& Machine) (index : UInt32) : UInt8 := Bound4.coreByte s.inner index

end Aukora.Bound5
