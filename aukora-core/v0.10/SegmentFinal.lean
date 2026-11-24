import SessionFinal
import Judge12

namespace Aukora.SegmentFinal

private instance : DecidableEq ByteArray := fun ⟨a⟩ ⟨b⟩ =>
  if h : a = b then isTrue (congrArg ByteArray.mk h) else isFalse (fun eq => h (congrArg ByteArray.data eq))

def digest (b : ByteArray) := (Sha256.hash b).toByteArray

def entryTag := "AUKORA/R12B/entry".toUTF8

def entryData (prior : ByteArray) (kind : UInt8) (w : ByteArray) :=
  entryTag ++ prior ++ (ByteArray.empty.push kind) ++ w

@[export r12b_entry] def entry (prior : ByteArray) (kind : UInt8) (w : ByteArray) : ByteArray :=
  digest (entryData prior kind w)

def keyData (s : Release.State) := (s.base.hybrid.owner.ed ++ s.base.hybrid.owner.ml).toByteArray

def genesisData (sealedHead law keys : ByteArray) : ByteArray :=
  "AUKORA/R12B/genesis".toUTF8 ++ sealedHead ++ law ++ keys

@[export r12b_genesis_data] def expectedGenesis (sealedHead law : ByteArray) (s : Release.State) :=
  genesisData sealedHead law (keyData s)

/-- The first journal accumulator authenticates the original keys and law. The externally
    visible first ledger head keeps the existing genesis encoding for record replay. -/
@[export r12b_first] def first (law : ByteArray) (s : Release.State) :=
  digest ("AUKORA/R12B/first".toUTF8 ++ law ++ keyData s)

def sealTag := "AUKORA/R12B/seal".toUTF8

def sealHeader (prior law : ByteArray) (s : Release.State) :=
  sealTag ++ prior ++ law ++ (Safe11.head s).bytes.toByteArray ++ keyData s

def sealHead := digest

/-- The trailer names the ordered frame/stamp accumulator, the active law, ledger
    head and both current public keys. Signatures cover the entire header. -/
@[export r12b_seal] def closeRecord (prior law wire : ByteArray) (s : Release.State) : Option ByteArray := do
  let hdr := sealHeader prior law s
  guard (prior.size == 32 && law.size == 32 && wire.size == hdr.size + 64 + 3309 &&
    wire.extract 0 hdr.size == hdr &&
    wire.extract sealTag.size (sealTag.size + 32) == prior)
  let ed := (wire.extract hdr.size (hdr.size + 64)).data.toList
  let ml := (wire.extract (hdr.size + 64) wire.size).data.toList
  guard (Hybrid7.verifyHybrid Core8.verifiers s.base.hybrid.owner hdr.data.toList ed ml)
  return sealHead wire

theorem seal_authentic {prior law wire s head} (ok : closeRecord prior law wire s = some head) :
    let hdr := sealHeader prior law s
    wire.extract 0 hdr.size = hdr ∧ wire.extract sealTag.size (sealTag.size + 32) = prior ∧
    head = sealHead wire ∧ Hybrid7.Both Core8.verifiers s.base.hybrid.owner hdr.data.toList
      (wire.extract hdr.size (hdr.size + 64)).data.toList (wire.extract (hdr.size + 64) wire.size).data.toList := by
  unfold closeRecord at ok
  dsimp only at ok ⊢
  obtain ⟨_,first,rest⟩ := Option.bind_eq_some.mp ok
  obtain ⟨_,signed,eq⟩ := Option.bind_eq_some.mp rest
  have permitted {b : Bool} {u : Unit} (h : (guard b : Option Unit) = some u) : b = true := by
    cases b <;> simp_all [guard]
  have fields := permitted first
  simp only [Bool.and_eq_true,beq_iff_eq] at fields
  exact ⟨fields.1.2,fields.2,(Option.some.inj eq).symm,(Hybrid7.verifyHybrid_iff ..).mp (permitted signed)⟩

/-- The closed phase and current seal are private adapter state. Continue consumes
    the exact descriptor and commits its digest as the next ledger head. Global
    sequence numbers, evidence indices and the ledger used for law succession stay intact. -/
@[export r12b_continue] def continueAt (sealedHead law packed : ByteArray) (s : Release.State) :
    Option Release.State :=
  if packed = expectedGenesis sealedHead law s then
    some {s with base.hybrid.inner.ledger.head := ⟨(digest packed).data.toList⟩}
  else none

theorem continuation {sealedHead law packed s t} (ok : continueAt sealedHead law packed s = some t) :
    packed = expectedGenesis sealedHead law s ∧ Safe11.head t = ⟨(digest packed).data.toList⟩ ∧
    s.base.hybrid.owner = t.base.hybrid.owner ∧ Ratchet11.current s = Ratchet11.current t ∧
    Safe11.halted s = Safe11.halted t ∧ s.rules = t.rules ∧ Policy9.pool s.base = Policy9.pool t.base ∧
    (∀ i, Policy9.Closed s i ↔ Policy9.Closed t i) ∧
    (∀ i, Policy9.grantOK s i = Policy9.grantOK t i) ∧
    (Release.ledger s).history = (Release.ledger t).history ∧ s.outcomes = t.outcomes := by
  unfold continueAt at ok
  split at ok
  · rename_i named
    generalize (digest packed).data.toList = hashBytes at ok ⊢
    cases Option.some.inj ok
    exact ⟨named,rfl,rfl,rfl,rfl,rfl,rfl,fun _ => Iff.rfl,fun _ => rfl,rfl,rfl⟩
  · contradiction

theorem no_restoration {sealedHead law packed s t} (ok : continueAt sealedHead law packed s = some t)
    {i} (closed : Policy9.Closed s i) : Policy9.Closed t i ∧ Policy9.grantOK t i = false := by
  obtain ⟨_,_,_,_,_,_,_,same,_⟩ := continuation ok
  have after_ := (same i).mp closed
  exact ⟨after_,Policy9.closed_refuses after_⟩

/-- A sealed head belongs to the outgoing state, never to the caller. The immutable
    seal and the submitted descriptor determine the next open segment. -/
structure Session where
  machine : Release.State
  quota : SessionFinal.Quota
  journal : ByteArray
  sealPin : Option ByteArray := none

def finish (x : Session) (law wire : ByteArray) : Option Session := do
  guard (!x.quota.closed)
  let pin ← closeRecord x.journal law wire x.machine
  return {x with quota.closed := true, sealPin := some pin}

def resume (x : Session) (law packed : ByteArray) : Option Session := do
  guard x.quota.closed
  let pin ← x.sealPin
  let t ← continueAt pin law packed x.machine
  return ⟨t,{},digest packed,none⟩

theorem seal_reserved (x : Session) (law wire pin) (opened : x.quota.closed = false)
    (signed : closeRecord x.journal law wire x.machine = some pin) :
    finish x law wire = some {x with quota.closed := true, sealPin := some pin} := by
  simp [finish,opened,guard,signed]

theorem sealed_admits_nothing {x : Session} (closed : x.quota.closed = true)
    (m : Release.Model) (ctx law w) :
    SessionFinal.frame m ctx x.quota x.machine w = none ∧
    SessionFinal.stamp m x.quota x.machine w = none ∧ finish x law w = none := by
  have old := SessionFinal.sealed_frames m ctx x.quota x.machine w closed
  exact ⟨old.1,old.2,by simp [finish,closed,guard]⟩

theorem exact_successor {x y : Session} {law packed} (ok : resume x law packed = some y) :
    x.quota.closed = true ∧ ∃ pin, x.sealPin = some pin ∧
      packed = genesisData pin law (keyData x.machine) ∧ y.quota = {} ∧ y.sealPin = none ∧
      y.journal = digest packed ∧ Safe11.halted y.machine = Safe11.halted x.machine ∧
      (∀ i, Policy9.Closed x.machine i → Policy9.grantOK y.machine i = false) := by
  obtain ⟨_,guarded,rest⟩ := Option.bind_eq_some.mp ok
  obtain ⟨pin,selected,rest⟩ := Option.bind_eq_some.mp rest
  obtain ⟨t,actual,eq⟩ := Option.bind_eq_some.mp rest
  cases Option.some.inj eq
  have closed : x.quota.closed = true := by
    cases c : x.quota.closed <;> simp_all [guard]
  obtain ⟨named,_,_,_,flag,_⟩ := continuation actual
  exact ⟨closed,pin,selected,named,rfl,rfl,rfl,flag.symm,fun _ h => (no_restoration actual h).2⟩

theorem continue_available {x : Session} {law wire pin} (opened : x.quota.closed = false)
    (signed : closeRecord x.journal law wire x.machine = some pin) :
    ∃ closed next, finish x law wire = some closed ∧ resume closed law (expectedGenesis pin law x.machine) = some next ∧
      next.quota = {} := by
  let desc := expectedGenesis pin law x.machine
  let t : Release.State := {x.machine with base.hybrid.inner.ledger.head := ⟨(digest desc).data.toList⟩}
  refine ⟨_,⟨t,{},digest desc,none⟩,seal_reserved x law wire pin opened signed,?_,rfl⟩
  simp [resume,continueAt,guard,t,desc]

#print axioms seal_reserved
#print axioms sealed_admits_nothing
#print axioms exact_successor
#print axioms continue_available
#print axioms seal_authentic
#print axioms continuation
#print axioms no_restoration
end Aukora.SegmentFinal
