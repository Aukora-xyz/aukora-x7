import Proofs.RecordBinding
import Proofs.FinalPolicies

/-! Round 12c D2, item 2: law b4, re-addressed frames.

B2 is about the same bytes. b4 is about a frame built for record B that CARRIES
record A's signatures: for each head-signed kind listed below, if a frame of that
kind is admitted by a state of bound record A, then no frame of the same kind whose
signature fields equal its signature fields is admitted by any state of a bound record
with a different identifier.

The assumption `SignatureOnce` is about Ed25519 and ML-DSA-65 as implemented here
(`Hybrid7.Both Core8.verifiers`): for the two messages that actually occur, one pair of
signatures does not verify for two different (keys, message) pairs. It is TESTED, not
proved. Together with B1's `NoCollision` it is the whole assumption of b4.

Kinds covered: timed approval (tag 18 hex), cancel (19 hex), signed control (13 hex
carrying a control action), threshold (16 hex). NOT covered here: the ff 02 halt, clear
and key change and the seal; see NOT-PROVED. Plain approvals (13 hex) and legacy key
changes (14 hex) are not head-signed and are forced replayable by `PriorVerdicts`. -/

namespace Aukora.RootFinal.Rebinding
open Release
open Safe11 (fullModel)
open R6.KernelCell (Context)
open RecordBinding
open private Policy9.applyBase from Policy
open private Policy9.ran Policy9.parsed from Proofs.Policy
open private Core8.thresholdControl Core8.header Core8.slice from Ledger.Assessed

/-- The named signature assumption, for one pair of occurring messages. -/
def SignatureOnce (kx ky : Hybrid7.Keys) (mx my ed ml : Bytes) : Prop :=
  Hybrid7.Both Core8.verifiers kx mx ed ml → Hybrid7.Both Core8.verifiers ky my ed ml → kx = ky ∧ mx = my

/-- Signature fields of a threshold control, read from its own bytes. -/
def field (w : ByteArray) (a b : Nat) : Bytes := (w.extract a b).data.toList

/-- b4. Written once per kind; `x` is any point of bound record 1 and `y` any point of
    bound record 2, with different identifiers. -/
def Readdressed (m : Model) : Prop :=
  ∀ ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂,
    Bound12c.genesis law₁ keys₁ host₁ = some s₁ → Bound12c.genesis law₂ keys₂ host₂ = some s₂ →
    Bound12c.identifier law₁ keys₁ host₁ ≠ Bound12c.identifier law₂ keys₂ host₂ →
    NoCollision (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).2 (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).2 →
    let x := (walk m ctx (started law₁ keys₁ host₁ s₁) ops₁).1
    let y := (walk m ctx (started law₂ keys₂ host₂ s₂) ops₂).1
    -- timed approval (18 hex): same Ed25519 and ML-DSA fields
    (∀ w w' p n e i p' n' e' i' ed ml,
      Tracked w (.issue p n e i ed ml) → Tracked w' (.issue p' n' e' i' ed ml) → (m.step ctx w x).isSome →
      SignatureOnce (owner x) (owner y) (Policy9.issueMessage x p n e i) (Policy9.issueMessage y p' n' e' i') ed ml →
      m.step ctx w' y = none) ∧
    -- cancel (19 hex)
    (∀ w w' p n d p' n' d' ed ml,
      Tracked w (.cancel p n d ed ml) → Tracked w' (.cancel p' n' d' ed ml) → (m.step ctx w x).isSome →
      SignatureOnce (owner x) (owner y) (Policy9.cancelMessage x p n d) (Policy9.cancelMessage y p' n' d') ed ml →
      m.step ctx w' y = none) ∧
    -- signed control (13 hex with a control action)
    (∀ w w' f f' op op' ed ml,
      Tracked w (.ordinary f (.signed ml)) → f.action = .control op ed →
      Tracked w' (.ordinary f' (.signed ml)) → f'.action = .control op' ed → (m.step ctx w x).isSome →
      SignatureOnce (owner x) (owner y) (Hybrid7.controlMessage (owner x) (Policy9.generation x) f op)
        (Hybrid7.controlMessage (owner y) (Policy9.generation y) f' op') ed ml →
      m.step ctx w' y = none) ∧
    -- threshold (16 hex): signature fields at bytes 42..106 and 106..end
    (∀ w w' p n v p' n' v',
      w[0]? = some (22 : UInt8) → w'[0]? = some (22 : UInt8) →
      projected w = some ⟨p, n, .base (.advise "AUKORA/R8/threshold" v.toNat)⟩ → w[41]? = some v →
      projected w' = some ⟨p', n', .base (.advise "AUKORA/R8/threshold" v'.toNat)⟩ → w'[41]? = some v' →
      field w 42 106 = field w' 42 106 → field w 106 w.size = field w' 106 w'.size → (m.step ctx w x).isSome →
      SignatureOnce (owner x) (owner y)
        (Risk8.thresholdMessage (owner x) (Policy9.generation x) p n v)
        (Risk8.thresholdMessage (owner y) (Policy9.generation y) p' n' v')
        (field w 42 106) (field w 106 w.size) →
      m.step ctx w' y = none)

/-! ### Reading the head back out of two equal messages -/

theorem putUInt8_length (g : Nat) : (Wire4.putUInt 8 g).length = 8 := by
  simp [Wire4.putUInt]

/-- After a common prefix, an 8-byte field and a 32-byte head, equal messages name equal heads. -/
theorem same_head {pre g g' h h' r r' : Bytes} (lg : g.length = 8) (lg' : g'.length = 8)
    (lh : h.length = 32) (lh' : h'.length = 32) (e : pre ++ (g ++ (h ++ r)) = pre ++ (g' ++ (h' ++ r'))) :
    h = h' := by
  have a := List.append_cancel_left e
  have b := (List.append_inj a (by rw [lg, lg'])).2
  exact (List.append_inj b (by rw [lh, lh'])).1

/-- After a 8-byte field, equal messages give equal 32-byte heads. -/
theorem same_head0 {g g' h h' r r' : Bytes} (lg : g.length = 8) (lg' : g'.length = 8)
    (lh : h.length = 32) (lh' : h'.length = 32) (e : g ++ (h ++ r) = g' ++ (h' ++ r')) : h = h' := by
  have b := (List.append_inj e (by rw [lg, lg'])).2
  exact (List.append_inj b (by rw [lh, lh'])).1

theorem digest_eq {a b : Digest} (h : a.bytes = b.bytes) : a = b := by
  cases a; cases b; simp_all

/-! ### Facts about the full machine -/

private theorem headWidth {ctx law keys host s ops} (g : Bound12c.genesis law keys host = some s) :
    (ledger (walk fullModel ctx (started law keys host s) ops).1).head.bytes.length = 32 := by
  obtain ⟨_, a, _, _, h⟩ := inv_walk ctx ops _ (start_inv g)
  rw [h]
  exact hash_width a

/-- A legacy frame's projected parent is the current head of any state that admits it. -/
private theorem parent_is_head {ctx w s t f} (hit : fullModel.step ctx w s = some t)
    (width : (ledger s).head.bytes.length = 32) (old : w[0]? ≠ some (255 : UInt8)) (proj : projected w = some f) :
    f.parent = (ledger s).head := by
  have p := full_parent hit width
  simp [wireParent, old, proj] at p
  exact digest_eq p

private theorem projected_tracked {w c} (cmd : Tracked w c) : projected w = entryFor w c := by
  simp [projected, cmd.1, cmd.2]

/-- Two bound histories, different identifiers, equal heads: impossible (B1). -/
private theorem heads_differ {ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂}
    (g₁ : Bound12c.genesis law₁ keys₁ host₁ = some s₁) (g₂ : Bound12c.genesis law₂ keys₂ host₂ = some s₂)
    (ids : Bound12c.identifier law₁ keys₁ host₁ ≠ Bound12c.identifier law₂ keys₂ host₂)
    (safe : NoCollision (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).2
      (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).2)
    (bytes : (ledger (walk fullModel ctx (started law₁ keys₁ host₁ s₁) ops₁).1).head.bytes =
      (ledger (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1).head.bytes) : False := by
  exact full_separation ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ g₁ g₂ ids safe (digest_eq bytes)

/-- What the full machine checks when it admits a threshold control. -/
theorem threshold_signed {ctx w s t} (tag : w[0]? = some (22 : UInt8)) (hit : fullModel.step ctx w s = some t) :
    ∃ p n v, projected w = some ⟨p, n, .base (.advise "AUKORA/R8/threshold" v.toNat)⟩ ∧ w[41]? = some v ∧
      Hybrid7.Both Core8.verifiers (owner s) (Risk8.thresholdMessage (owner s) (Policy9.generation s) p n v)
        (field w 42 106) (field w 106 w.size) := by
  have old : w[0]? ≠ some (255 : UInt8) := by rw [tag]; decide
  have ntag : w[0]? ≠ some (27 : UInt8) := by rw [tag]; decide
  have core := RootFinal.legacy_step old hit
  have p9 : Policy9.step w s = some t := by simpa [Core9.step, ntag] using core
  have dec : Policy9.decode w = some .threshold := by unfold Policy9.decode; rw [tag]; rfl
  have h := (Policy9.ran dec p9).1
  simp only [Policy9.applyBase, Option.map_eq_some'] at h
  obtain ⟨b, th, _⟩ := h
  unfold Core8.thresholdControl at th
  obtain ⟨_, _, r1⟩ := Option.bind_eq_some.mp th
  obtain ⟨⟨p, n⟩, hdr, r2⟩ := Option.bind_eq_some.mp r1
  obtain ⟨v, lv, r3⟩ := Option.bind_eq_some.mp r2
  obtain ⟨_, _, r4⟩ := Option.bind_eq_some.mp r3
  obtain ⟨risk, st, _⟩ := Option.bind_eq_some.mp r4
  unfold Risk8.setThreshold at st
  split at st
  · rename_i cond
    simp only [Bool.and_eq_true] at cond
    refine ⟨p, n, v, ?_, lv, (Hybrid7.verifyHybrid_iff ..).mp cond.2⟩
    simp [projected, ntag, dec, entryFor, hdr, lv]
  · simp at st

theorem full_readdressed : Readdressed fullModel := by
  intro ctx law₁ keys₁ host₁ law₂ keys₂ host₂ s₁ s₂ ops₁ ops₂ g₁ g₂ ids safe
  have wx := headWidth (ctx := ctx) (ops := ops₁) g₁
  have wy := headWidth (ctx := ctx) (ops := ops₂) g₂
  refine ⟨?_, ?_, ?_, ?_⟩
  · intro w w' p n e i p' n' e' i' ed ml tw tw' admitted once
    cases hy : fullModel.step ctx w' (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
    | none => rfl
    | some ty =>
      exfalso
      obtain ⟨tx, hx⟩ := Option.isSome_iff_exists.mp admitted
      have sx := (full_expiry_installed.1 ctx w _ tx p n e i ed ml (.inl tw) hx).1
      have sy := (full_expiry_installed.1 ctx w' _ ty p' n' e' i' ed ml (.inl tw') hy).1
      obtain ⟨keys, msg⟩ := once sx sy
      have px := parent_is_head hx wx (RootFinal.tracked_old tw) (by rw [projected_tracked tw]; rfl)
      have py := parent_is_head hy wy (RootFinal.tracked_old tw') (by rw [projected_tracked tw']; rfl)
      dsimp only at px py
      simp only [Policy9.issueMessage, Policy9.message, List.append_assoc] at msg
      change Wire4.putText _ ++ (Hybrid7.keyBytes (owner _) ++ _) = _ at msg
      rw [keys] at msg
      have hp := same_head (putUInt8_length _) (putUInt8_length _)
        (by rw [px]; exact wx) (by rw [py]; exact wy) (List.append_cancel_left msg)
      exact heads_differ g₁ g₂ ids safe (by rw [← px, ← py]; exact hp)
  · intro w w' p n d p' n' d' ed ml tw tw' admitted once
    cases hy : fullModel.step ctx w' (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
    | none => rfl
    | some ty =>
      exfalso
      obtain ⟨tx, hx⟩ := Option.isSome_iff_exists.mp admitted
      have sx := full_control_installed.2 ctx w _ tx p n d ed ml (.inl tw) hx
      have sy := full_control_installed.2 ctx w' _ ty p' n' d' ed ml (.inl tw') hy
      obtain ⟨keys, msg⟩ := once sx sy
      have px := (full_revocation ctx w _ tx p n d ed ml (.inl tw) hx).1
      have py := (full_revocation ctx w' _ ty p' n' d' ed ml (.inl tw') hy).1
      simp only [Policy9.cancelMessage, Policy9.message, List.append_assoc] at msg
      change Wire4.putText _ ++ (Hybrid7.keyBytes (owner _) ++ _) = _ at msg
      rw [keys] at msg
      have hp := same_head (putUInt8_length _) (putUInt8_length _)
        (by rw [px]; exact wx) (by rw [py]; exact wy) (List.append_cancel_left msg)
      exact heads_differ g₁ g₂ ids safe (by rw [← px, ← py]; exact hp)
  · intro w w' f f' op op' ed ml tw act tw' act' admitted once
    cases hy : fullModel.step ctx w' (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
    | none => rfl
    | some ty =>
      exfalso
      obtain ⟨tx, hx⟩ := Option.isSome_iff_exists.mp admitted
      obtain ⟨mlx, ex, sx⟩ := full_control.1 ctx w _ tx f (.signed ml) op ed tw act hx
      obtain ⟨mly, ey, sy⟩ := full_control.1 ctx w' _ ty f' (.signed ml) op' ed tw' act' hy
      cases ex
      cases ey
      obtain ⟨keys, msg⟩ := once sx sy
      have px := parent_is_head hx wx (RootFinal.tracked_old tw) (by rw [projected_tracked tw]; rfl)
      have py := parent_is_head hy wy (RootFinal.tracked_old tw') (by rw [projected_tracked tw']; rfl)
      simp only [Wire5.Frame.project] at px py
      simp only [Hybrid7.controlMessage, Hybrid7.domain, Wire5.controlBytes, Wire5.header, List.append_assoc] at msg
      rw [keys] at msg
      have m1 := List.append_cancel_left (List.append_cancel_left (List.append_cancel_left msg))
      have hp := same_head0 (putUInt8_length _) (putUInt8_length _)
        (by rw [px]; exact wx) (by rw [py]; exact wy) m1
      exact heads_differ g₁ g₂ ids safe (by rw [← px, ← py]; exact hp)
  · intro w w' p n v p' n' v' tag tag' proj lv proj' lv' fe fm admitted once
    cases hy : fullModel.step ctx w' (walk fullModel ctx (started law₂ keys₂ host₂ s₂) ops₂).1 with
    | none => rfl
    | some ty =>
      exfalso
      obtain ⟨tx, hx⟩ := Option.isSome_iff_exists.mp admitted
      obtain ⟨p₁, n₁, v₁, proj₁, lv₁, sx⟩ := threshold_signed tag hx
      obtain ⟨p₂, n₂, v₂, proj₂, lv₂, sy⟩ := threshold_signed tag' hy
      rw [lv] at lv₁
      rw [lv'] at lv₂
      obtain rfl : v = v₁ := Option.some.inj lv₁
      obtain rfl : v' = v₂ := Option.some.inj lv₂
      rw [proj] at proj₁
      rw [proj'] at proj₂
      simp only [Option.some.injEq, R2.Frame.mk.injEq] at proj₁ proj₂
      obtain ⟨rfl, rfl, -⟩ := proj₁
      obtain ⟨rfl, rfl, -⟩ := proj₂
      rw [← fe, ← fm] at sy
      obtain ⟨keys, msg⟩ := once sx sy
      have old : w[0]? ≠ some (255 : UInt8) := by rw [tag]; decide
      have old' : w'[0]? ≠ some (255 : UInt8) := by rw [tag']; decide
      have px := parent_is_head hx wx old proj
      have py := parent_is_head hy wy old' proj'
      dsimp only at px py
      simp only [Risk8.thresholdMessage, List.append_assoc] at msg
      rw [keys] at msg
      have hp := same_head (putUInt8_length _) (putUInt8_length _)
        (by rw [px]; exact wx) (by rw [py]; exact wy) (List.append_cancel_left msg)
      exact heads_differ g₁ g₂ ids safe (by rw [← px, ← py]; exact hp)

theorem readdressed_congr {m m' : Model} (h : m.toOps = m'.toOps) : Readdressed m ↔ Readdressed m' := by
  have e : walk m = walk m' := funext fun ctx => funext fun x => funext fun ops => walk_congr h ctx x ops
  have hs : m.step = m'.step := congrArg Ops.step h
  simp only [Readdressed, e, hs]

#print axioms threshold_signed
#print axioms full_readdressed
end Aukora.RootFinal.Rebinding
