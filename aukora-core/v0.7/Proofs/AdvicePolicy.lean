import ReleaseInterface
import Proofs.Advice

namespace Aukora.Release
open R6.KernelCell (Context)
open private Advice7.Pair Advice7.pairMap Advice7.pairGet Advice7.InnerEq Advice7.inner_pair
  Advice7.Similar Advice7.used_eq Advice7.StateEq Advice7.InnerEq.mk Advice7.InnerEq.led
  Advice7.InnerEq.stage Advice7.LedgerEq.mk Advice7.LedgerEq.book Advice7.LedgerEq.active
  Advice7.LedgerEq.hist Advice7.StateEq.mk Advice7.anyRead from Proofs.Advice
open private Upgrade6.isOldUpgrade from Compatibility.Certificate
open private Policy9.applyBase Policy9.append Policy9.setPool Policy9.hadGrant from Policy
open private Core8.act Core8.actRoute Core8.append Core8.slice Core8.assessment Core8.thresholdControl
  Core8.metadata Core8.header from Ledger.Assessed

namespace Advice

/-- The two frames address their respective prior states. -/
structure Here (s : State) (parent : Digest) (seq : Nat) : Prop where
  head : parent = (ledger s).head
  next : seq = (ledger s).book.seq + 1

/-- Fields other than an ordinary advisory score have identical ledger meaning. -/
inductive Peers : R2.Action → R2.Action → Prop
  | same (a) : Peers a a
  | scores (cell i j) : Peers (.base (.advise cell i)) (.base (.advise cell j))

/-- A successful decode identifies the policy branch independently of a model's verdict. -/
def Parsed (wire : ByteArray) (cmd : Policy9.Command) : Prop :=
  wire[0]? ≠ some (27 : UInt8) ∧ Policy9.decode wire = some cmd

/-- Equal ordinary requests may vary an advise score. Owner controls can be separately
    signed over each run's local header if both hybrid verifiers give the same combined verdict. -/
inductive Ordinary (s t : State) (x y : Wire5.Frame) (ex ey : Hybrid7.Extra) : Prop
  | equal (act : x.action = y.action) (extra : ex = ey) (nc : ∀ op sig, x.action ≠ .control op sig)
  | advice (cell a b) (left : x.action = .plain (.base (.advise cell a)))
      (right : y.action = .plain (.base (.advise cell b))) (extra : ex = ey)
  | control (op ax ay mx my) (left : x.action = .control op ax) (right : y.action = .control op ay)
      (exSig : ex = .signed mx) (eySig : ey = .signed my)
      (signature : Hybrid7.signatureOK Core8.verifiers s.base.hybrid
          (Hybrid7.controlMessage (owner s) (Policy9.generation s) x op) ax mx =
        Hybrid7.signatureOK Core8.verifiers t.base.hybrid
          (Hybrid7.controlMessage (owner t) (Policy9.generation t) y op) ay my)

/-- The threshold authorization check, independent of ledger admission. -/
def thresholdSignature (s : State) (w : ByteArray) (p : Digest) (n : Nat) (level : UInt8) : Bool :=
  let ed := Core8.slice w 42 106
  let ml := Core8.slice w 106 w.size
  ed.length == 64 && ml.length == 3309 && Hybrid7.verifyHybrid Core8.verifiers (owner s)
    (Risk8.thresholdMessage (owner s) (Policy9.generation s) p n level) ed ml

/-- Signed controls and rebinding can need different signatures at different local heads.
    The Boolean compares the existing hybrid credentials independently of the candidate step. -/
inductive Matched (s t : State) (wx wy : ByteArray) : Prop
  | ordinary (x y : Wire5.Frame) (ex ey)
      (dx : Parsed wx (.ordinary x ex)) (dy : Parsed wy (.ordinary y ey))
      (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
      (op : Ordinary s t x y ex ey)
  | rebind (px py nx ny keys ex mx ey my)
      (dx : Parsed wx (.rebind px nx keys ex mx)) (dy : Parsed wy (.rebind py ny keys ey my))
      (hx : Here s px nx) (hy : Here t py ny)
      (signed : Hybrid7.signatureOK Core8.verifiers s.base.hybrid
          (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ex mx =
        Hybrid7.signatureOK Core8.verifiers t.base.hybrid
          (Hybrid7.rebindMessage (owner t) (Policy9.generation t) keys) ey my)
  | report (px py nx ny i val corrected)
      (dx : Parsed wx (.report px nx i val corrected)) (dy : Parsed wy (.report py ny i val corrected))
      (hx : Here s px nx) (hy : Here t py ny)
  | use (i g : _) (x y : Wire5.Frame)
      (dx : Parsed wx (.use i)) (dy : Parsed wy (.use i))
      (lx : 33 ≤ wx.size) (ly : 33 ≤ wy.size)
      (ax : Wire5.decode (wx.extract 33 wx.size) = some x)
      (ay : Wire5.decode (wy.extract 33 wy.size) = some y)
      (rx : Core8.actRoute x = some (i,g)) (ry : Core8.actRoute y = some (i,g))
      (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
      (same : x.project.action = y.project.action)
      (bundle : Core8.slice wx 1 33 = Core8.slice wy 1 33)
  | issue (px py nx ny expiry i ex mx ey my)
      (dx : Parsed wx (.issue px nx expiry i ex mx)) (dy : Parsed wy (.issue py ny expiry i ey my))
      (hx : Here s px nx) (hy : Here t py ny)
      (signature : Policy9.signed s (Policy9.issueMessage s px nx expiry i) ex mx =
        Policy9.signed t (Policy9.issueMessage t py ny expiry i) ey my)
  | cancel (px py nx ny d ex mx ey my)
      (dx : Parsed wx (.cancel px nx d ex mx)) (dy : Parsed wy (.cancel py ny d ey my))
      (hx : Here s px nx) (hy : Here t py ny)
      (signature : Policy9.signed s (Policy9.cancelMessage s px nx d) ex mx =
        Policy9.signed t (Policy9.cancelMessage t py ny d) ey my)
  | assessment (px py nx ny score)
      (dx : Parsed wx .assessment) (dy : Parsed wy .assessment)
      (lx : wx.size = 106) (ly : wy.size = 106)
      (ax : Core8.header wx = some (px,nx)) (ay : Core8.header wy = some (py,ny))
      (hx : Here s px nx) (hy : Here t py ny)
      (intent : Core8.slice wx 41 73 = Core8.slice wy 41 73)
      (sx : wx[73]? = some score) (sy : wy[73]? = some score)
      (bundle : Core8.slice wx 74 106 = Core8.slice wy 74 106)
  | threshold (px py nx ny level)
      (dx : Parsed wx .threshold) (dy : Parsed wy .threshold)
      (lx : wx.size = 3415) (ly : wy.size = 3415)
      (ax : Core8.header wx = some (px,nx)) (ay : Core8.header wy = some (py,ny))
      (hx : Here s px nx) (hy : Here t py ny)
      (sx : wx[41]? = some level) (sy : wy[41]? = some level)
      (signature : thresholdSignature s wx px nx level = thresholdSignature t wy py ny level)
  | install (x y : Upgrade9.Package)
      (tx : wx[0]? = some (27 : UInt8)) (ty : wy[0]? = some (27 : UInt8))
      (dx : Upgrade9.decode wx = some x) (dy : Upgrade9.decode wy = some y)
      (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
      (target : x.target = y.target) (model : x.model = y.model)
      (proof : x.proof = y.proof) (intent : x.intent = y.intent)

private structure BaseEq (s t : Core8.Machine) : Prop where
  inner : Advice7.InnerEq s.hybrid.inner t.hybrid.inner
  keys : s.hybrid.owner = t.hybrid.owner
  risk : s.risk = t.risk

private structure Equiv (s t : State) : Prop extends BaseEq s.base t.base where
  rules : s.rules = t.rules
  findings : s.outcomes = t.outcomes

private theorem Equiv.refl (s : State) : Equiv s s :=
  ⟨⟨Advice7.InnerEq.mk (Advice7.LedgerEq.mk rfl rfl rfl) rfl,rfl,rfl⟩,rfl,rfl⟩

private theorem Equiv.grant {s t : State} (h : Equiv s t) (i : Intent) :
    Policy9.grantOK s i = Policy9.grantOK t i := by
  simp [Policy9.grantOK, Policy9.generation, Hybrid7.generation, Policy9.nextSeq, Advice7.LedgerEq.book (Advice7.InnerEq.led h.inner), h.rules]

private theorem similar {a b : R2.Action} (h : Peers a b) : Advice7.Similar a b := by
  cases h with
  | same => exact .same _
  | scores => exact .advice _ _ _

private theorem Equiv.book {s t : State} (h : Equiv s t) : (ledger s).book = (ledger t).book :=
  Advice7.LedgerEq.book (Advice7.InnerEq.led h.inner)

private theorem Equiv.nonce {s t : State} (h : Equiv s t) (i : Intent) :
    Bound5.usedNonce (Hybrid7.edView s.base.hybrid) i = Bound5.usedNonce (Hybrid7.edView t.base.hybrid) i :=
  Advice7.used_eq (Advice7.StateEq.mk h.inner (congrArg Hybrid7.Keys.ed h.keys)) i

private theorem ordinaryGuards {s t x y ex ey} (h : Equiv s t) (op : Ordinary s t x y ex ey) :
    Peers x.project.action y.project.action ∧
    Hybrid7.authorized Core8.verifiers s.base.hybrid x ex = Hybrid7.authorized Core8.verifiers t.base.hybrid y ey := by
  have gen : Hybrid7.generation s.base.hybrid = Hybrid7.generation t.base.hybrid := congrArg (fun b : Book => b.auth.generation) h.book
  cases op with
  | equal eq extras nc =>
    constructor
    · simp only [Wire5.Frame.project,eq]; exact .same _
    · subst ey
      cases a : x.action with
      | control op sig => exact False.elim (nc _ _ a)
      | _ => cases ex <;> simp only [Hybrid7.authorized, ← eq, a, h.keys,gen, h.nonce, Hybrid7.signatureOK]
  | advice cell a b left right extra =>
    constructor
    · simp only [Wire5.Frame.project, Wire5.Action.project,left,right]; exact .scores _ _ _
    · subst ey; cases ex <;> simp [Hybrid7.authorized,left,right,Wire5.plainOK,Upgrade6.isOldUpgrade]
  | control op ax ay mx my left right exSig eySig signature =>
    constructor
    · simp only [Wire5.Frame.project,Wire5.Action.project,left,right]; exact .same _
    · simp only [Hybrid7.authorized,left,right,exSig,eySig]
      have both := congrArg (fun b : Bool => decide (Hybrid7.generation s.base.hybrid < 2^64) && b) signature
      simp only [Policy9.generation, owner, gen] at both ⊢
      exact both

private theorem matched_inner {s t : State} (h : Equiv s t) {x y : R2.Frame} {wx wy : ByteArray}
    (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq) (action : Peers x.action y.action) :
    Advice7.Pair Advice7.InnerEq (Bound4.next (fun _ => Bound4.digest wx) s.base.hybrid.inner x)
      (Bound4.next (fun _ => Bound4.digest wy) t.base.hybrid.inner y) :=
  Advice7.inner_pair h.inner _ _ hx.head hy.head hx.next hy.next (similar action)

private theorem parsed_step {w cmd} (h : Parsed w cmd) (ctx : Context) (s : State) :
    Core9.step ctx w s = Policy9.submit s w cmd := by
  simp [Core9.step, Policy9.step, h.1, h.2]

private theorem paired_append {s t wx wy x y} (h : Equiv s t)
    (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq) (action : Peers x.action y.action) :
    Advice7.Pair BaseEq (Policy9.append s.base wx x) (Policy9.append t.base wy y) := by
  have hp := matched_inner (wx := wx) (wy := wy) h hx hy action
  cases l : Bound4.next (fun _ => Bound4.digest wx) s.base.hybrid.inner x <;>
    cases r : Bound4.next (fun _ => Bound4.digest wy) t.base.hybrid.inner y <;>
    rw [l,r] at hp <;> cases hp
  · simpa [Policy9.append, l, r] using (Advice7.Pair.none (r := BaseEq))
  · rename_i same
    simpa [Policy9.append, l, r] using (Advice7.Pair.some (r := BaseEq)
      (a := {s.base with hybrid.inner := _, record := s.base.record.push wx})
      (b := {t.base with hybrid.inner := _, record := t.base.record.push wy})
      ⟨same,h.keys,h.risk⟩)

private theorem same_apply {s t wx wy cx cy} (_h : Equiv s t)
    (base : Advice7.Pair BaseEq (Policy9.applyBase s wx (Policy9.selected s cx) cx)
      (Policy9.applyBase t wy (Policy9.selected t cy) cy))
    (rules : Policy9.rulesAfter s.rules (Policy9.selected s cx) cx =
      Policy9.rulesAfter t.rules (Policy9.selected t cy) cy)
    (outcomes : Policy9.outcomesAfter s.outcomes cx = Policy9.outcomesAfter t.outcomes cy) :
    Advice7.Pair Equiv (Policy9.submit s wx cx) (Policy9.submit t wy cy) := by
  cases l : Policy9.applyBase s wx (Policy9.selected s cx) cx <;>
    cases r : Policy9.applyBase t wy (Policy9.selected t cy) cy <;>
    rw [l,r] at base <;> cases base
  · simpa [Policy9.submit,l,r] using (Advice7.Pair.none (r := Equiv))
  · rename_i same
    simp only [Policy9.submit,l,r,Option.bind_some, pure]
    exact .some ⟨same,rules,outcomes⟩

private theorem ordinary {s t wx wy x y ex ey} (h : Equiv s t)
    (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
    (act : Peers x.project.action y.project.action)
    (credentials : Hybrid7.authorized Core8.verifiers s.base.hybrid x ex =
      Hybrid7.authorized Core8.verifiers t.base.hybrid y ey) :
    Advice7.Pair Equiv (Policy9.submit s wx (.ordinary x ex)) (Policy9.submit t wy (.ordinary y ey)) := by
  apply same_apply (cx := .ordinary x ex) (cy := .ordinary y ey) h _ h.rules h.findings
  cases ok : Hybrid7.authorized Core8.verifiers t.base.hybrid y ey with
  | false => simp [Policy9.applyBase, credentials, ok]; exact .none
  | true => simpa [Policy9.applyBase, credentials, ok] using (paired_append h hx hy act)

private theorem reports {s t wx wy px py nx ny i val fix} (h : Equiv s t)
    (hx : Here s px nx) (hy : Here t py ny) :
    Advice7.Pair Equiv (Policy9.submit s wx (.report px nx i val fix))
      (Policy9.submit t wy (.report py ny i val fix)) := by
  apply same_apply (cx := .report px nx i val fix) (cy := .report py ny i val fix) h _ h.rules (by simp [Policy9.outcomesAfter,h.findings])
  cases ok : Policy9.reportOK t.outcomes i fix with
  | false => simp [Policy9.applyBase, h.findings, ok]; exact .none
  | true =>
    simpa [Policy9.applyBase, h.findings, ok] using
      (paired_append (x := ⟨px,nx,.base (.outcome i val)⟩) (y := ⟨py,ny,.base (.outcome i val)⟩) h hx hy (.same _))

private theorem pairBind {a : Option α} {b : Option β} {r : α → β → Prop} {q : γ → δ → Prop}
    {f : α → Option γ} {g : β → Option δ} (h : Advice7.Pair r a b)
    (next : ∀ x y, r x y → Advice7.Pair q (f x) (g y)) :
    Advice7.Pair q (a >>= f) (b >>= g) := by
  cases h with
  | none => exact .none
  | some eq => exact next _ _ eq

private theorem rebinds {s t wx wy px py nx ny keys ex ey mx my} (h : Equiv s t)
    (hx : Here s px nx) (hy : Here t py ny)
    (signed : Hybrid7.signatureOK Core8.verifiers s.base.hybrid
          (Hybrid7.rebindMessage (owner s) (Policy9.generation s) keys) ex mx =
        Hybrid7.signatureOK Core8.verifiers t.base.hybrid
          (Hybrid7.rebindMessage (owner t) (Policy9.generation t) keys) ey my) :
    Advice7.Pair Equiv (Policy9.submit s wx (.rebind px nx keys ex mx))
      (Policy9.submit t wy (.rebind py ny keys ey my)) := by
  apply same_apply (cx := .rebind px nx keys ex mx) (cy := .rebind py ny keys ey my) h _ rfl h.findings
  let x : Wire5.Frame := ⟨px,nx,.rebind keys.ed ex⟩
  let y : Wire5.Frame := ⟨py,ny,.rebind keys.ed ey⟩
  have credential : Hybrid7.authorized Core8.verifiers s.base.hybrid x (.binding keys.ml mx) =
      Hybrid7.authorized Core8.verifiers t.base.hybrid y (.binding keys.ml my) := by
    have gen : Hybrid7.generation s.base.hybrid = Hybrid7.generation t.base.hybrid :=
      congrArg (fun b : Book => b.auth.generation) (Advice7.LedgerEq.book (Advice7.InnerEq.led h.inner))
    simp only [Hybrid7.authorized,x,y,gen,owner,Policy9.generation] at signed ⊢
    simpa only [gen] using congrArg
      (fun z : Bool => decide (Hybrid7.generation s.base.hybrid < 2^64) && Hybrid7.validKey keys && z) signed
  cases valid : Hybrid7.authorized Core8.verifiers t.base.hybrid y (.binding keys.ml my) with
  | false =>
    dsimp only [x,y] at credential valid
    simp [Policy9.applyBase, credential, valid,guard]
    exact .none
  | true =>
    dsimp only [x,y] at credential valid
    simp [Policy9.applyBase,credential,valid,guard]
    apply pairBind (paired_append (x := x.project) (y := y.project) h hx hy (.same _))
    intro _ _ eq
    exact .some ⟨eq.inner,rfl,eq.risk⟩

private theorem uses {s t wx wy i g x y} (h : Equiv s t)
    (lx : 33 ≤ wx.size) (ly : 33 ≤ wy.size)
    (ax : Wire5.decode (wx.extract 33 wx.size) = some x)
    (ay : Wire5.decode (wy.extract 33 wy.size) = some y)
    (rx : Core8.actRoute x = some (i,g)) (ry : Core8.actRoute y = some (i,g))
    (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
    (action : x.project.action = y.project.action)
    (bundle : Core8.slice wx 1 33 = Core8.slice wy 1 33) :
    Advice7.Pair Equiv (Policy9.submit s wx (.use i)) (Policy9.submit t wy (.use i)) := by
  apply same_apply (cx := .use i) (cy := .use i) h _ h.rules h.findings
  cases ok : Policy9.grantOK t i with
  | false =>
    simp only [Policy9.applyBase, h.grant, ok, Bool.false_eq_true, if_false]
    exact .none
  | true =>
    simp only [Policy9.applyBase, h.grant, ok, if_true]
    apply Advice7.pairMap (r := BaseEq) _ _ _ (fun _ _ eq => ⟨eq.inner,eq.keys,eq.risk⟩)
    simp [Core8.act, lx, ly, guard, ax, ay, rx, ry,
      Core8.append, h.risk, bundle]
    have similar : Peers x.project.action y.project.action := action ▸ Peers.same _
    have inner := matched_inner (x := x.project) (y := y.project) (wx := wx) (wy := wy) h hx hy similar
    cases l : Bound4.next (fun _ => Bound4.digest wx) s.base.hybrid.inner x.project <;>
      cases r : Bound4.next (fun _ => Bound4.digest wy) t.base.hybrid.inner y.project <;>
      rw [l,r] at inner <;> cases inner
    · exact .none
    · rename_i eq
      cases q : Risk8.act t.base.risk (Risk8.intentDigest i) ⟨Core8.slice wy 1 33⟩ g (!g) with
      | none => simp [q]; exact .none
      | some z => simp [q]; exact .some ⟨eq,h.keys,rfl⟩

private theorem packages {ctx s t wx wy} {x y : Upgrade9.Package} (h : Equiv s t)
    (tx : wx[0]? = some (27 : UInt8)) (ty : wy[0]? = some (27 : UInt8))
    (dx : Upgrade9.decode wx = some x) (dy : Upgrade9.decode wy = some y)
    (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq)
    (target : x.target = y.target) (model : x.model = y.model)
    (proof : x.proof = y.proof) (intent : x.intent = y.intent) :
    Advice7.Pair Equiv (Core9.step ctx wx s) (Core9.step ctx wy t) := by
  have similar : Peers (Upgrade9.frame x).action (Upgrade9.frame y).action := by
    simp only [Upgrade9.frame, target,intent]; exact .same _
  have hp := matched_inner (x := Upgrade9.frame x) (y := Upgrade9.frame y) (wx := wx) (wy := wy) h hx hy similar
  simp [Core9.step,tx,ty,dx,dy,
    Upgrade9.install,Advice7.InnerEq.stage h.inner, model,proof,intent,h.grant]
  by_cases g : Policy9.grantOK t y.intent = true
  · by_cases c : ModelSection9.read t.base.hybrid.inner.candidate = some (Bound4.digest y.model)
    · cases k : Checker9.check ctx y.model y.proof with
      | false => simp [g,c,k,guard]; exact .none
      | true =>
        simp [g,c,k,guard]
        cases l : Bound4.next (fun _ => Bound4.digest wx) s.base.hybrid.inner (Upgrade9.frame x) <;>
          cases r : Bound4.next (fun _ => Bound4.digest wy) t.base.hybrid.inner (Upgrade9.frame y) <;>
          rw [l,r] at hp <;> cases hp
        · exact .none
        · rename_i eq; exact .some ⟨⟨eq,h.keys,h.risk⟩,h.rules,h.findings⟩
    · simp [g,c,guard]; exact .none
  · simp [g,guard]; exact .none

private def replaceGrants (s : State) (g : List Intent) : State :=
  {s with base := Policy9.setPool s.base g}

private theorem Equiv.filtered {s t : State} (h : Equiv s t) (g : List Intent) :
    Equiv (replaceGrants s g) (replaceGrants t g) := by
  have led := Advice7.InnerEq.led h.inner
  have stage := Advice7.InnerEq.stage h.inner
  have hist := Advice7.LedgerEq.hist led
  have active := Advice7.LedgerEq.active led
  refine ⟨⟨Advice7.InnerEq.mk (Advice7.LedgerEq.mk ?_ active hist) stage,h.keys,h.risk⟩,h.rules,h.findings⟩
  exact congrArg (fun b : Book => {b with auth.grants := g}) h.book

private theorem Equiv.grants {s t : State} (h : Equiv s t) : Policy9.pool s.base = Policy9.pool t.base :=
  congrArg (fun b : Book => b.auth.grants) h.book

private theorem Equiv.had {s t : State} (h : Equiv s t) (i : Intent) : Policy9.hadGrant s i = Policy9.hadGrant t i := by
  apply Advice7.anyRead (Advice7.LedgerEq.hist (Advice7.InnerEq.led h.inner)) (fun a =>
    match a with | .base (.grant prior true) => decide (prior = i) | _ => false)
  intro x; cases x <;> try rfl
  rename_i e; cases e <;> rfl

private theorem Equiv.choose {s t : State} (h : Equiv s t) (d : Digest) :
    Policy9.resolve s d = Policy9.resolve t d := by
  simp [Policy9.resolve,Policy9.matchingGrants,h.grants,h.grant]

private theorem filteredAppend {s t wx wy x y} (h : Equiv s t)
    (g : List Intent) (hx : Here s x.parent x.seq) (hy : Here t y.parent y.seq) (act : Peers x.action y.action) :
    Advice7.Pair BaseEq (Policy9.append (Policy9.setPool s.base g) wx x) (Policy9.append (Policy9.setPool t.base g) wy y) :=
  paired_append (h.filtered g) ⟨hx.head,hx.next⟩ ⟨hy.head,hy.next⟩ act

private theorem issues {s t wx wy px py nx ny expiry i ex mx ey my} (h : Equiv s t)
    (hx : Here s px nx) (hy : Here t py ny)
    (signature : Policy9.signed s (Policy9.issueMessage s px nx expiry i) ex mx =
      Policy9.signed t (Policy9.issueMessage t py ny expiry i) ey my) :
    Advice7.Pair Equiv (Policy9.submit s wx (.issue px nx expiry i ex mx))
      (Policy9.submit t wy (.issue py ny expiry i ey my)) := by
  apply same_apply (cx := .issue px nx expiry i ex mx) (cy := .issue py ny expiry i ey my) h _
    (by simp [Policy9.rulesAfter,h.rules]) h.findings
  have clock : nx = ny := hx.next.trans ((congrArg (fun b : Book => b.seq+1) h.book).trans hy.next.symm)
  have base := filteredAppend (wx := wx) (wy := wy) (x := ⟨px,nx,.base (.grant i true)⟩)
    (y := ⟨py,ny,.base (.grant i true)⟩) h ((Policy9.pool t.base).filter (fun j => decide (j ≠ i))) hx hy (.same _)
  subst ny
  simp only [decide_not] at base
  cases sig : Policy9.signed t (Policy9.issueMessage t py nx expiry i) ey my <;>
    cases fresh : (!Bound5.usedNonce (Hybrid7.edView t.base.hybrid) i || (!Policy9.grantOK t i && Policy9.hadGrant t i)) <;>
    by_cases bounds : nx < expiry ∧ Bound5.intentFits i = true <;>
    simp [Policy9.applyBase, signature, sig, guard, h.nonce, h.grant, h.had, h.grants, fresh,
      Bool.and_eq_true, bounds] <;> first | exact base | exact .none

private theorem cancels {s t wx wy px py nx ny d ex mx ey my} (h : Equiv s t)
    (hx : Here s px nx) (hy : Here t py ny)
    (signature : Policy9.signed s (Policy9.cancelMessage s px nx d) ex mx =
      Policy9.signed t (Policy9.cancelMessage t py ny d) ey my) :
    Advice7.Pair Equiv (Policy9.submit s wx (.cancel px nx d ex mx))
      (Policy9.submit t wy (.cancel py ny d ey my)) := by
  apply same_apply (cx := .cancel px nx d ex mx) (cy := .cancel py ny d ey my) h _
    (by simp [Policy9.rulesAfter,Policy9.selected,h.choose,h.rules]) h.findings
  cases sig : Policy9.signed t (Policy9.cancelMessage t py ny d) ey my with
  | false => simp [Policy9.applyBase, signature, sig, guard]; exact .none
  | true =>
    cases pick : Policy9.resolve t d with
    | none => simp [Policy9.applyBase,Policy9.selected,h.choose,pick,signature,sig,guard]; exact .none
    | some victim =>
      simpa [Policy9.applyBase,Policy9.selected,h.choose,pick,signature,sig,guard,h.grants] using
        (filteredAppend (wx := wx) (wy := wy) (x := ⟨px,nx,.base (.advise "AUKORA/R9/revoke" 0)⟩)
          (y := ⟨py,ny,.base (.advise "AUKORA/R9/revoke" 0)⟩) h
          ((Policy9.pool t.base).filter (fun j => decide (j ≠ victim))) hx hy (.same _))

private theorem meta {s t wx wy px py nx ny} (h : Equiv s t) (hx : Here s px nx) (hy : Here t py ny)
    (label : String) (v : UInt8) (risk : Risk8.State) :
    Advice7.Pair BaseEq (Core8.metadata s.base wx px nx label v risk) (Core8.metadata t.base wy py ny label v risk) := by
  let x : R2.Frame := ⟨px,nx,.base (.advise label v.toNat)⟩
  let y : R2.Frame := ⟨py,ny,.base (.advise label v.toNat)⟩
  have hp := matched_inner (x := x) (y := y) (wx := wx) (wy := wy) h hx hy (.same _)
  cases l : Bound4.next (fun _ => Bound4.digest wx) s.base.hybrid.inner x <;>
    cases r : Bound4.next (fun _ => Bound4.digest wy) t.base.hybrid.inner y <;>
    rw [l,r] at hp <;> cases hp <;> dsimp only [x,y] at l r <;> simp [Core8.metadata,Core8.append,l,r]
  · exact .none
  · rename_i eq
    exact .some ⟨eq,h.keys,rfl⟩

private theorem assessments {s t wx wy px py nx ny score} (h : Equiv s t)
    (lx : wx.size = 106) (ly : wy.size = 106)
    (ax : Core8.header wx = some (px,nx)) (ay : Core8.header wy = some (py,ny))
    (hx : Here s px nx) (hy : Here t py ny)
    (intent : Core8.slice wx 41 73 = Core8.slice wy 41 73)
    (sx : wx[73]? = some score) (sy : wy[73]? = some score)
    (bundle : Core8.slice wx 74 106 = Core8.slice wy 74 106) :
    Advice7.Pair Equiv (Policy9.submit s wx .assessment) (Policy9.submit t wy .assessment) := by
  apply same_apply (cx := .assessment) (cy := .assessment) h _ h.rules h.findings
  unfold Policy9.applyBase
  apply Advice7.pairMap (r := BaseEq) _ _ _ (fun _ _ eq => ⟨eq.inner, eq.keys, eq.risk⟩)
  simp [Core8.assessment,lx,ly,guard,ax,ay,sx,sy,intent,bundle,h.risk]
  exact meta h hx hy _ _ _

private theorem thresholds {s t wx wy px py nx ny level} (h : Equiv s t)
    (lx : wx.size = 3415) (ly : wy.size = 3415)
    (ax : Core8.header wx = some (px,nx)) (ay : Core8.header wy = some (py,ny))
    (hx : Here s px nx) (hy : Here t py ny)
    (sx : wx[41]? = some level) (sy : wy[41]? = some level)
    (signature : thresholdSignature s wx px nx level = thresholdSignature t wy py ny level) :
    Advice7.Pair Equiv (Policy9.submit s wx .threshold) (Policy9.submit t wy .threshold) := by
  apply same_apply (cx := .threshold) (cy := .threshold) h _ h.rules h.findings
  unfold Policy9.applyBase
  apply Advice7.pairMap (r := BaseEq) _ _ _ (fun _ _ eq => ⟨eq.inner,eq.keys,eq.risk⟩)
  have gen : Hybrid7.generation s.base.hybrid = Hybrid7.generation t.base.hybrid := congrArg (fun b : Book => b.auth.generation) h.book
  let allow (z : State) (w : ByteArray) (p : Digest) (n : Nat) :=
    Risk8.setThreshold Core8.verifiers (owner z) (Policy9.generation z) p n level
      (Core8.slice w 42 106) (Core8.slice w 106 w.size) z.base.risk
  have allowed : allow s wx px nx = allow t wy py ny := by
    dsimp only [thresholdSignature] at signature
    simp only [allow,Risk8.setThreshold,signature,h.risk]
  have sxlen : wx.size == 106+3309 := by simp [lx]
  have sylen : wy.size == 106+3309 := by simp [ly]
  cases r : allow t wy py ny with
  | none =>
    have l := allowed.trans r
    dsimp only [allow, owner, Policy9.generation] at l r
    rw [gen] at l
    by_cases g : Hybrid7.generation t.base.hybrid < 2^64 <;>
      simp [Core8.thresholdControl, guard, ax,ay,sx,sy, gen, sxlen,sylen,g, r,l] <;> exact .none
  | some risk =>
    have l := allowed.trans r
    dsimp only [allow, owner, Policy9.generation] at l r
    rw [gen] at l
    by_cases g : Hybrid7.generation t.base.hybrid < 2^64 <;>
      simp [Core8.thresholdControl,guard,ax,ay,sx,sy, gen,sxlen,sylen,g, r,l]
    · exact meta h hx hy "AUKORA/R8/threshold" level risk
    · exact .none

private theorem one {s t wx wy ctx} (h : Equiv s t) (pair : Matched s t wx wy) :
    Advice7.Pair Equiv (Core9.step ctx wx s) (Core9.step ctx wy t) := by
  cases pair with
  | ordinary x y ex ey dx dy hx hy matched =>
    rw [parsed_step dx,parsed_step dy]
    obtain ⟨act, credentials⟩ := ordinaryGuards h matched
    exact ordinary h hx hy act credentials
  | rebind px py nx ny keys ex mx ey my dx dy hx hy signed =>
    rw [parsed_step dx,parsed_step dy]
    exact rebinds h hx hy signed
  | report px py nx ny i val fix dx dy hx hy =>
    rw [parsed_step dx,parsed_step dy]
    exact reports h hx hy
  | use i g x y dx dy lx ly ax ay rx ry hx hy same bundle =>
    rw [parsed_step dx,parsed_step dy]
    exact uses h lx ly ax ay rx ry hx hy same bundle
  | issue px py nx ny expiry i ex mx ey my dx dy hx hy signature =>
    rw [parsed_step dx,parsed_step dy]; exact issues h hx hy signature
  | cancel px py nx ny d ex mx ey my dx dy hx hy signature =>
    rw [parsed_step dx,parsed_step dy]; exact cancels h hx hy signature
  | assessment px py nx ny score dx dy lx ly ax ay hx hy intent sx sy bundle =>
    rw [parsed_step dx,parsed_step dy]; exact assessments h lx ly ax ay hx hy intent sx sy bundle
  | threshold px py nx ny level dx dy lx ly ax ay hx hy sx sy signature =>
    rw [parsed_step dx,parsed_step dy]; exact thresholds h lx ly ax ay hx hy sx sy signature
  | install x y tx ty dx dy hx hy target model proof intent =>
    exact packages h tx ty dx dy hx hy target model proof intent

/-- Each step pairs the same proposal at its local head; an ordinary advice score may differ. -/
inductive Aligned (m : Ops) (ctx : Context) : State → State → List Input → List Input → Prop
  | nil {s t} : Aligned m ctx s t [] []
  | frame {s t wx wy xs ys} (pair : Matched s t wx wy)
      (tail : Aligned m ctx (execute m ctx s (.frame wx)) (execute m ctx t (.frame wy)) xs ys) :
      Aligned m ctx s t (.frame wx :: xs) (.frame wy :: ys)
  | feed {s t b xs ys} (tail : Aligned m ctx (m.feed b s) (m.feed b t) xs ys) :
      Aligned m ctx s t (.feed b :: xs) (.feed b :: ys)
  | reset {s t xs ys} (tail : Aligned m ctx (m.reset s) (m.reset t) xs ys) :
      Aligned m ctx s t (.reset :: xs) (.reset :: ys)
  | stamp {s t wx wy xs ys}
      (tail : Aligned m ctx (execute m ctx s (.stamp wx)) (execute m ctx t (.stamp wy)) xs ys) :
      Aligned m ctx s t (.stamp wx :: xs) (.stamp wy :: ys)

private theorem stampOne (s : State) (wire : ByteArray) :
    let t := (newest.stamp wire s).getD s
    t.base.hybrid = s.base.hybrid ∧ t.base.risk = s.base.risk ∧ t.rules = s.rules ∧ t.outcomes = s.outcomes := by
  cases d : Core8.decodeStamp wire with
  | none => simp [newest,Core9.stamp,Core8.stamp,d]
  | some parts =>
    obtain ⟨p,b,r⟩ := parts
    by_cases ok : p = (ledger s).head <;> simp [newest,Core9.stamp,Core8.stamp,d,guard,ok,ledger] at * <;> exact ⟨rfl,rfl,rfl,rfl⟩

/-- The Boolean sequence includes the verdict of every ledger submission. -/
def verdicts (m : Ops) (ctx : Context) (s : State) : List Input → List Bool
  | [] => []
  | .frame w :: later => (m.step ctx w s).isSome :: verdicts m ctx (execute m ctx s (.frame w)) later
  | cmd :: later => verdicts m ctx (execute m ctx s cmd) later

private theorem pairedVerdict {r : α → β → Prop} {a : Option α} {b : Option β} (h : Advice7.Pair r a b) :
    a.isSome = b.isSome := by cases h <;> rfl

private theorem trace {s t xs ys ctx} (a : Aligned newest ctx s t xs ys) (h : Equiv s t) :
    Equiv (run newest ctx s xs) (run newest ctx t ys) ∧ verdicts newest ctx s xs = verdicts newest ctx t ys := by
  induction a with
  | nil => exact ⟨h,rfl⟩
  | frame pair _ ih =>
    have paired := one (ctx := ctx) h pair
    have tail := ih (Advice7.pairGet paired h)
    refine ⟨tail.1, ?_⟩
    simp only [verdicts,tail.2,List.cons.injEq,and_true]; exact pairedVerdict paired
  | feed _ ih =>
    have prev := Advice7.InnerEq.led h.inner
    exact ih ⟨⟨Advice7.InnerEq.mk prev
      (congrArg (· ++ _) (Advice7.InnerEq.stage h.inner)),h.keys,h.risk⟩,h.rules,h.findings⟩
  | reset _ ih =>
    have prev := Advice7.InnerEq.led h.inner
    exact ih ⟨⟨Advice7.InnerEq.mk prev rfl,h.keys,h.risk⟩,h.rules,h.findings⟩
  | @stamp s t wx wy _ _ _ ih =>
    have left := stampOne s wx
    have right := stampOne t wy
    apply ih
    change Equiv ((newest.stamp wx s).getD s) ((newest.stamp wy t).getD t)
    constructor
    · constructor
      · rw [left.1,right.1]; exact h.inner
      · rw [left.1,right.1]; exact h.keys
      · exact left.2.1.trans (h.risk.trans right.2.1.symm)
    · exact left.2.2.1.trans (h.rules.trans right.2.2.1.symm)
    · exact left.2.2.2.trans (h.findings.trans right.2.2.2.symm)

end Advice

def AdviceLaw (m : Ops) : Prop :=
  ∀ ctx s xs ys, Advice.Aligned m ctx s s xs ys →
    auth (run m ctx s xs) = auth (run m ctx s ys) ∧ Advice.verdicts m ctx s xs = Advice.verdicts m ctx s ys

theorem newest_advice : AdviceLaw newest := by
  intro ctx s xs ys aligned
  obtain ⟨same,verdicts⟩ := Advice.trace aligned (Advice.Equiv.refl s)
  exact ⟨Prod.ext same.keys (congrArg Book.auth (Advice7.LedgerEq.book (Advice7.InnerEq.led same.inner))),verdicts⟩

#print axioms newest_advice
end Aukora.Release
