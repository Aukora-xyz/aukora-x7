import Compatibility.ListGate

namespace Aukora.Hybrid7
open R6.KernelCell (Context)

structure Keys where
  ed : Bytes
  ml : Bytes
  deriving DecidableEq

structure Verifiers where
  ed25519 : Bound5.Verifier
  mlDsa65 : Bound5.Verifier

/-- A grant and a rebind each require BOTH verifiers to accept the same message. -/
def verifyHybrid (v : Verifiers) (k : Keys) (msg edSig mlSig : Bytes) : Bool :=
  v.ed25519 k.ed msg edSig && v.mlDsa65 k.ml msg mlSig

def Both (v : Verifiers) (k : Keys) (msg edSig mlSig : Bytes) : Prop :=
  v.ed25519 k.ed msg edSig = true ∧ v.mlDsa65 k.ml msg mlSig = true

theorem verifyHybrid_iff (v k msg edSig mlSig) : verifyHybrid v k msg edSig mlSig = true ↔ Both v k msg edSig mlSig := by
  simp [verifyHybrid, Both, Bool.and_eq_true]

-- The first signature lives in the ordinary wire's 64-byte signature field. The
-- second signature and, on rebind, the new ML-DSA-65 key have their own fields.
inductive Extra where
  | unsigned
  | signed (mlSig : Bytes)
  | binding (newML mlSig : Bytes)

structure Request where
  wire : ByteArray
  extra : Extra

structure Machine where
  inner : Bound4.Machine
  owner : Keys

def validKey (k : Keys) : Bool := Ed25519.validKey k.ed && k.ml.length == 1952

def genesis (k : Keys) : Option Machine :=
  if validKey k then some ⟨(Bound5.initial k.ed).inner, k⟩ else none

def reset (s : Machine) : Machine := {s with inner := Bound4.reset s.inner}
def feed (bytes : ByteArray) (s : Machine) : Machine := {s with inner := Bound4.feed bytes s.inner}

-- Accepted keys have fixed component widths (32 and 1952). Old pair, new pair,
-- generation, and intent/control use separate fixed-width or length-delimited fields.
def keyBytes (k : Keys) : Bytes := Wire4.putBlob k.ed ++ Wire4.putBlob k.ml
def domain (role : String) (k : Keys) := Wire4.putText ("AUKORA/R7/hybrid/" ++ role) ++ keyBytes k

def grantMessage (old : Keys) (i : Intent) := domain "grant" old ++ Wire4.putIntent i
def rebindMessage (old : Keys) (generation : Nat) (new : Keys) :=
  domain "rebind" old ++ Wire4.putUInt 8 generation ++ keyBytes new
def controlMessage (old : Keys) (generation : Nat) (x : Wire5.Frame) (op : Wire5.Control) :=
  domain "control" old ++ Wire5.controlBytes generation x op

def generation (s : Machine) := s.inner.ledger.book.auth.generation
def edView (s : Machine) : Bound5.Machine := ⟨s.inner, s.owner.ed⟩

def signatureOK (v : Verifiers) (s : Machine) (msg sig pq : Bytes) : Bool :=
  pq.length == 3309 && verifyHybrid v s.owner msg sig pq

open private isOldUpgrade from Compatibility.Certificate

def authorized (v : Verifiers) (s : Machine) (x : Wire5.Frame) (extra : Extra) : Bool :=
  match x.action, extra with
  | .plain a, .unsigned => Wire5.plainOK a && !isOldUpgrade x.action
  | .grant i sig, .signed pq =>
    Bound5.intentFits i && !Bound5.usedNonce (edView s) i && signatureOK v s (grantMessage s.owner i) sig pq
  | .rebind ed sig, .binding ml pq =>
    let newKey := Keys.mk ed ml
    generation s < 2^64 && validKey newKey &&
      signatureOK v s (rebindMessage s.owner (generation s) newKey) sig pq
  | .control op sig, .signed pq =>
    generation s < 2^64 && signatureOK v s (controlMessage s.owner (generation s) x op) sig pq
  | _, _ => false

def after (old : Keys) (act : Wire5.Action) (extra : Extra) : Keys :=
  match act, extra with
  | .rebind ed _, .binding ml _ => ⟨ed, ml⟩
  | _, _ => old

def reqDigest (r : Request) : Digest :=
  match r.extra with
  | .unsigned => Bound4.digest (0 :: r.wire.data.toList).toByteArray
  | .signed sig => Bound4.digest (([19] : Bytes) ++ sig ++ r.wire.data.toList).toByteArray
  | .binding ml sig => Bound4.digest (([20] : Bytes) ++ ml ++ sig ++ r.wire.data.toList).toByteArray

private def append (s : Machine) (d : Digest) (f : R2.Frame) (nextOwner : Keys) : Option Machine :=
  (Bound4.next (fun _ => d) s.inner f).map fun next => ⟨next, nextOwner⟩

/-- The abstract machine's only submission entry. An old unsigned grant, single
    signature, or old upgrade flag cannot bypass this dispatch. Certified frames
    use the same manifest selection and proof/context combination as Upgrade7. -/
def step (v : Verifiers) (primary other : Context) (r : Request) (s : Machine) : Option Machine :=
  match Upgrade7.decode r.wire with
  | some (.ordinary x) =>
    if authorized v s x r.extra then append s (reqDigest r) x.project (after s.owner x.action r.extra)
    else none
  | some (.certified u) => match r.extra with
    | .unsigned => do
      let entry ← Upgrade7.lookup u.target
      append s (reqDigest r) (u.frame (entry.context primary other)) s.owner
    | _ => none
  | none => none

private theorem append_ok {s d f k t} (ok : append s d f k = some t) :
    Bound4.next (fun _ => d) s.inner f = some t.inner ∧ t.owner = k := by
  unfold append at ok
  cases hn : Bound4.next (fun _ => d) s.inner f with
  | none => simp [hn] at ok
  | some inner =>
    rw [hn] at ok
    change some (Machine.mk inner k) = some t at ok
    cases Option.some.inj ok
    exact ⟨rfl, rfl⟩

private theorem ordinary_ok {v p q r s t x} (dec : Upgrade7.decode r.wire = some (.ordinary x))
    (ok : step v p q r s = some t) :
    authorized v s x r.extra = true ∧ Bound4.next (fun _ => reqDigest r) s.inner x.project = some t.inner ∧
      t.owner = after s.owner x.action r.extra := by
  simp only [step, dec] at ok
  split at ok
  next h => exact ⟨h, append_ok ok⟩
  next => contradiction

private theorem certified_ok {v p q r s t u} (dec : Upgrade7.decode r.wire = some (.certified u))
    (ok : step v p q r s = some t) :
    ∃ entry, Upgrade7.lookup u.target = some entry ∧ r.extra = .unsigned ∧
      Bound4.next (fun _ => reqDigest r) s.inner (u.frame (entry.context p q)) = some t.inner ∧
      t.owner = s.owner := by
  simp only [step, dec] at ok
  cases side : r.extra <;> simp [side] at ok
  case unsigned =>
    cases lookup : Upgrade7.lookup u.target with
    | none => simp [lookup] at ok
    | some entry =>
      have appended : append s (reqDigest r) (u.frame (entry.context p q)) s.owner = some t := by
        simpa [lookup] using ok
      exact ⟨entry, rfl, rfl, append_ok appended⟩

private theorem both_of_sig {v s msg ed pq} (h : signatureOK v s msg ed pq = true) :
    Both v s.owner msg ed pq := by
  simp only [signatureOK, Bool.and_eq_true] at h
  exact (verifyHybrid_iff ..).mp h.2

theorem grant_verified {v p q r s t x i ed} (dec : Upgrade7.decode r.wire = some (.ordinary x))
    (ok : step v p q r s = some t) (act : x.action = .grant i ed) :
    ∃ ml, r.extra = .signed ml ∧ Both v s.owner (grantMessage s.owner i) ed ml ∧
      Bound5.usedNonce (edView s) i = false := by
  have gate := (ordinary_ok dec ok).1
  cases side : r.extra <;> simp [authorized, act, side] at gate
  case signed pq =>
    exact ⟨pq, rfl, both_of_sig gate.2, gate.1.2⟩

/-- Every addition to the unspent pool came from a grant bearing both signatures. -/
theorem new_grant_requires_both {v p q r s t i} (ok : step v p q r s = some t)
    (absent : i ∉ s.inner.ledger.book.auth.grants) (added : i ∈ t.inner.ledger.book.auth.grants) :
    ∃ x ed ml, Upgrade7.decode r.wire = some (.ordinary x) ∧ x.action = .grant i ed ∧ r.extra = .signed ml ∧
      Both v s.owner (grantMessage s.owner i) ed ml := by
  cases dec : Upgrade7.decode r.wire with
  | none => simp [step, dec] at ok
  | some input =>
    cases input with
    | certified u =>
      obtain ⟨entry, _, _, inner, _⟩ := certified_ok dec ok
      exact False.elim ((Events4.grant_absent_after (Bound4.accepted inner).2 absent (by simp [Upgrade6.Upgrade.frame])) added)
    | ordinary x =>
      obtain ⟨gate, inner, _⟩ := ordinary_ok dec ok
      have ev : x.project.action = .base (.grant i true) := by
        apply Classical.byContradiction
        intro no
        exact (Events4.grant_absent_after (Bound4.accepted inner).2 absent no) added
      cases act : x.action with
      | plain a =>
        have aEq : a = .base (.grant i true) := by simpa [Wire5.Frame.project, Wire5.Action.project, act] using ev
        cases side : r.extra <;> simp [authorized, act, side, aEq, Wire5.plainOK] at gate
      | grant j ed =>
        have eq : j = i := by simpa [Wire5.Frame.project, Wire5.Action.project, act] using ev
        subst j
        obtain ⟨pq, side, both, _⟩ := grant_verified dec ok act
        exact ⟨x, ed, pq, rfl, act, side, both⟩
      | rebind => simp [Wire5.Frame.project, Wire5.Action.project, act] at ev
      | control op sig => cases op <;> simp [Wire5.Frame.project, Wire5.Action.project, Wire5.Control.project, act] at ev

/-- Both OLD keys authorize the entire new pair and current generation, even if only the ML key changes. -/
theorem rebind_verified {v p q r s t x newEd ed} (dec : Upgrade7.decode r.wire = some (.ordinary x))
    (ok : step v p q r s = some t) (act : x.action = .rebind newEd ed) :
    ∃ ml pq, r.extra = .binding ml pq ∧ Both v s.owner (rebindMessage s.owner (generation s) ⟨newEd, ml⟩) ed pq ∧
      t.owner = ⟨newEd, ml⟩ ∧ t.inner.ledger.book.auth.grants = [] ∧ generation t = generation s + 1 := by
  obtain ⟨gate, inner, key⟩ := ordinary_ok dec ok
  cases side : r.extra <;> simp [authorized, act, side] at gate
  case binding ml pq =>
    have led := (R2.next_spec (Bound4.accepted inner).2).2
    refine ⟨ml, pq, rfl, both_of_sig gate.2, by simpa [after, act, side] using key, ?_, ?_⟩ <;>
      simp [generation, led, R2.append, R2.nextBook, Wire5.Frame.project, Wire5.Action.project, act, advance, changeAuth]

theorem owner_change_requires_both {v p q r s t} (ok : step v p q r s = some t) (changed : t.owner ≠ s.owner) :
    ∃ x ed pq, Upgrade7.decode r.wire = some (.ordinary x) ∧ x.action = .rebind t.owner.ed ed ∧
      r.extra = .binding t.owner.ml pq ∧ Both v s.owner (rebindMessage s.owner (generation s) t.owner) ed pq ∧
      t.inner.ledger.book.auth.grants = [] := by
  cases dec : Upgrade7.decode r.wire with
  | none => simp [step, dec] at ok
  | some input =>
    cases input with
    | certified u =>
      obtain ⟨_, _, _, _, owner⟩ := certified_ok dec ok
      exact False.elim (changed owner)
    | ordinary x =>
      have key := (ordinary_ok dec ok).2.2
      cases act : x.action with
      | rebind newEd ed =>
        obtain ⟨ml, pq, side, signed, owner, empty, _⟩ := rebind_verified dec ok act
        exact ⟨x, ed, pq, rfl, owner ▸ act, owner ▸ side, owner ▸ signed, empty⟩
      | _ => exact False.elim (changed (by simpa [after, act] using key))

theorem control_verified {v p q r s t x op ed} (dec : Upgrade7.decode r.wire = some (.ordinary x))
    (ok : step v p q r s = some t) (act : x.action = .control op ed) :
    ∃ pq, r.extra = .signed pq ∧ Both v s.owner (controlMessage s.owner (generation s) x op) ed pq := by
  have gate := (ordinary_ok dec ok).1
  cases side : r.extra <;> simp [authorized, act, side] at gate
  case signed pq => exact ⟨pq, rfl, both_of_sig gate.2⟩

/-- The abstract hybrid transition still obtains the proof verdict from the candidate's manifest entry. -/
theorem certified_requires_entry_proof {v p q r s t u} (dec : Upgrade7.decode r.wire = some (.certified u))
    (ok : step v p q r s = some t) :
    ∃ e, Upgrade7.lookup u.target = some e ∧ R6.KernelCell.check (e.context p q) u.proof = true ∧
      u.intent ∈ s.inner.ledger.book.auth.grants ∧ u.intent ∉ t.inner.ledger.book.auth.grants := by
  obtain ⟨e, listed, _, hn, _⟩ := certified_ok dec ok
  obtain ⟨check, _, grants, _, _, spent⟩ :=
    Bound4.upgrade_facts (target := u.target) (checked := R6.KernelCell.check (e.context p q) u.proof)
      (i := u.intent) hn rfl
  exact ⟨e, listed, check, grants, spent⟩

#print axioms verifyHybrid_iff
#print axioms grant_verified
#print axioms new_grant_requires_both
#print axioms rebind_verified
#print axioms owner_change_requires_both
#print axioms control_verified
#print axioms certified_requires_entry_proof
end Aukora.Hybrid7
