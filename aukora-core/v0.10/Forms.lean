import ReleaseInterface

/-! Root v2 skeleton, step 3 (split by effect in step 3a, decision A8): the form table. Every form the machine implements today, in one
closed list, each with a number that is fixed for ever. `formOf` reads the WIRE BYTES ONLY: no
state, no key, no record. What a restriction means can therefore never shift under the record.
Nothing in the machine reads this table, `refused` or `enabled` yet. -/

namespace Aukora.Forms

/-- Today's forms, one per effect (decision A8). The number of each is `code` below. Numbers are
    fixed from the first released root on. -/
inductive FormId where
  /-- tag 00, action byte (offset 41) 00: say -/
  | say
  /-- tag 00, action byte 01: remember -/
  | remember
  /-- tag 00, action byte 02: correct -/
  | correct
  /-- tag 00, action byte 06: advise -/
  | advise
  /-- tag 00, action byte 05: unsigned outcome report -/
  | report
  /-- tag 00, action byte 0d: budget spend -/
  | spend
  /-- tag 00, action byte 10: read -/
  | read
  /-- tag 13, action byte (offset 3350) 03: plain approval (legacy grant, signs no head) -/
  | approval
  /-- tag 13, action byte 09: signed retract -/
  | retract
  /-- tag 13, action byte 0a: signed standing mandate -/
  | mandate
  /-- tag 13, action byte 0c: signed grant budget -/
  | budget
  /-- tag 13, action byte 0e: signed pass -/
  | pass
  /-- tag 13, action byte 0f: signed revoke -/
  | revoke
  /-- tag 14: legacy key change (signs no head) -/
  | legacyKeyChange
  /-- tag 15: historical assessment -/
  | assessment
  /-- tag 16: threshold -/
  | threshold
  /-- tag 17: act (spends an approval) -/
  | act
  /-- tag 18: timed approval -/
  | timedApproval
  /-- tag 19: cancel -/
  | cancel
  /-- tag 1a: corrected report -/
  | correction
  /-- tag 1b: install -/
  | install
  /-- ff 02 28: evidence assessment -/
  | evidenceAssessment
  /-- ff 02 29, byte 43 = 00: evidence read -/
  | evidenceRead
  /-- ff 02 29, byte 43 = 01: evidence source -/
  | evidenceSource
  /-- ff 02 29, byte 43 = 02: evidence outcome -/
  | evidenceOutcome
  /-- ff 02 2a: premise -/
  | premise
  /-- ff 02 2b: owner-signed evidence ceiling -/
  | ceiling
  /-- ff 02 32: halt -/
  | halt
  /-- ff 02 33: clear -/
  | clear
  /-- ff 02 34: refused act -/
  | refusedAct
  /-- ff 02 35: key change -/
  | keyChange
  /-- ff 03 01: cell receipt -/
  | cellReceipt
  /-- ff 03 02: cell assessment -/
  | cellAssessment
  /-- the stamp input (sidecar channel, not a frame) -/
  | stamp
  /-- the staging feed input (not a frame) -/
  | feed
  /-- the staging reset input (not a frame) -/
  | reset
  /-- the seal trailer (seal export, not a frame) -/
  | seal
  /-- the continuation descriptor (continue export, not a frame) -/
  | continuation
  deriving DecidableEq, Repr

/-- The fixed number of each form. -/
def FormId.code : FormId → Nat
  | .say => 1
  | .remember => 2
  | .correct => 3
  | .advise => 4
  | .report => 5
  | .spend => 6
  | .read => 7
  | .approval => 8
  | .retract => 9
  | .mandate => 10
  | .budget => 11
  | .pass => 12
  | .revoke => 13
  | .legacyKeyChange => 14
  | .assessment => 15
  | .threshold => 16
  | .act => 17
  | .timedApproval => 18
  | .cancel => 19
  | .correction => 20
  | .install => 21
  | .evidenceAssessment => 22
  | .evidenceRead => 23
  | .evidenceSource => 24
  | .evidenceOutcome => 25
  | .premise => 26
  | .ceiling => 27
  | .halt => 28
  | .clear => 29
  | .refusedAct => 30
  | .keyChange => 31
  | .cellReceipt => 32
  | .cellAssessment => 33
  | .stamp => 34
  | .feed => 35
  | .reset => 36
  | .seal => 37
  | .continuation => 38

/-- The closed list, in code order. -/
def FormId.all : List FormId :=
  [.say, .remember, .correct, .advise, .report, .spend, .read, .approval, .retract, .mandate, .budget, .pass, .revoke, .legacyKeyChange, .assessment, .threshold, .act, .timedApproval, .cancel, .correction, .install, .evidenceAssessment, .evidenceRead, .evidenceSource, .evidenceOutcome, .premise, .ceiling, .halt, .clear, .refusedAct, .keyChange, .cellReceipt, .cellAssessment, .stamp, .feed, .reset, .seal, .continuation]

/-- Byte `i` of the wire as a number, 256 past the end. -/
def byteAt (w : ByteArray) (i : Nat) : Nat := (w[i]?).elim 256 UInt8.toNat

/-- The form a frame's bytes select. A function of the wire bytes only. Bytes that select no
    form the machine implements give `none` (the machine refuses them today). Offsets: 41 is the
    action byte of a tag-00 frame (1 + 32-byte parent + 8-byte sequence), 3350 that of a tag-13 frame
    (1 + 3,309-byte ML-DSA signature + 40), 43 the discriminant of an ff 02 29 envelope (3 + 40). -/
def formOf (w : ByteArray) : Option FormId :=
  match byteAt w 0 with
  | 0x00 =>
    match byteAt w 41 with
    | 0x00 => some .say
    | 0x01 => some .remember
    | 0x02 => some .correct
    | 0x06 => some .advise
    | 0x05 => some .report
    | 0x0d => some .spend
    | 0x10 => some .read
    | _ => none
  | 0x13 =>
    match byteAt w 3350 with
    | 0x03 => some .approval
    | 0x09 => some .retract
    | 0x0a => some .mandate
    | 0x0c => some .budget
    | 0x0e => some .pass
    | 0x0f => some .revoke
    | _ => none
  | 0x14 => some .legacyKeyChange
  | 0x15 => some .assessment
  | 0x16 => some .threshold
  | 0x17 => some .act
  | 0x18 => some .timedApproval
  | 0x19 => some .cancel
  | 0x1a => some .correction
  | 0x1b => some .install
  | 0xff =>
    match byteAt w 1, byteAt w 2 with
    | 0x02, 0x28 => some .evidenceAssessment
    | 0x02, 0x29 =>
      match byteAt w 43 with
      | 0x00 => some .evidenceRead
      | 0x01 => some .evidenceSource
      | 0x02 => some .evidenceOutcome
      | _ => none
    | 0x02, 0x2a => some .premise
    | 0x02, 0x2b => some .ceiling
    | 0x02, 0x32 => some .halt
    | 0x02, 0x33 => some .clear
    | 0x02, 0x34 => some .refusedAct
    | 0x02, 0x35 => some .keyChange
    | 0x03, 0x01 => some .cellReceipt
    | 0x03, 0x02 => some .cellAssessment
    | _, _ => none
  | _ => none

/-- The form of a model input: a frame's bytes, or the fixed form of a non-frame channel. -/
def inputForm : Release.Input → Option FormId
  | .frame w => formOf w
  | .feed _ => some .feed
  | .reset => some .reset
  | .stamp _ => some .stamp

/-- The frame's form is in the owner's refused register. -/
def Refused (s : Release.State) (w : ByteArray) : Prop :=
  ∃ f, formOf w = some f ∧ f.code ∈ s.policy.refused

/-- The same for any model input. -/
def RefusedIn (s : Release.State) (op : Release.Input) : Prop :=
  ∃ f, inputForm op = some f ∧ f.code ∈ s.policy.refused

instance (s : Release.State) (w : ByteArray) : Decidable (Refused s w) :=
  match h : formOf w with
  | none => isFalse (by intro ⟨f, e, _⟩; rw [h] at e; cases e)
  | some f =>
    if m : f.code ∈ s.policy.refused then isTrue ⟨f, h, m⟩
    else isFalse (by intro ⟨g, e, n⟩; rw [h] at e; cases e; exact m n)

instance (s : Release.State) (op : Release.Input) : Decidable (RefusedIn s op) :=
  match h : inputForm op with
  | none => isFalse (by intro ⟨f, e, _⟩; rw [h] at e; cases e)
  | some f =>
    if m : f.code ∈ s.policy.refused then isTrue ⟨f, h, m⟩
    else isFalse (by intro ⟨g, e, n⟩; rw [h] at e; cases e; exact m n)

/-! ### The table, pinned by the kernel -/

/-- The numbering, for ever. -/
theorem table : FormId.all.map (fun f => (f, f.code)) =
    [(.say,1), (.remember,2), (.correct,3), (.advise,4), (.report,5), (.spend,6), (.read,7), (.approval,8), (.retract,9), (.mandate,10), (.budget,11), (.pass,12), (.revoke,13), (.legacyKeyChange,14), (.assessment,15), (.threshold,16), (.act,17), (.timedApproval,18), (.cancel,19), (.correction,20), (.install,21), (.evidenceAssessment,22), (.evidenceRead,23), (.evidenceSource,24), (.evidenceOutcome,25), (.premise,26), (.ceiling,27), (.halt,28), (.clear,29), (.refusedAct,30), (.keyChange,31), (.cellReceipt,32), (.cellAssessment,33), (.stamp,34), (.feed,35), (.reset,36), (.seal,37), (.continuation,38)] := rfl

/-- The list is closed: every form is in it. -/
theorem all_complete (f : FormId) : f ∈ FormId.all := by
  cases f <;> simp [FormId.all]

/-- Different forms have different numbers. -/
theorem code_injective {f g : FormId} (h : f.code = g.code) : f = g := by
  cases f <;> cases g <;> first | rfl | (simp [FormId.code] at h)

/-- A7: the default enabled register is the full table, written out; an empty register means no form. -/
theorem enabled_default : ({} : Policy9.Policy).enabled = FormId.all.map FormId.code := rfl

/-- The default refused register is empty. -/
theorem refused_default : ({} : Policy9.Policy).refused = [] := rfl

/-- With an empty refused register nothing is refused. -/
theorem not_refused {s : Release.State} (h : s.policy.refused = []) (w : ByteArray) : ¬ Refused s w := by
  intro ⟨_, _, m⟩; rw [h] at m; cases m

theorem not_refusedIn {s : Release.State} (h : s.policy.refused = []) (op : Release.Input) : ¬ RefusedIn s op := by
  intro ⟨_, _, m⟩; rw [h] at m; cases m

/-- Selector facts for the two legacy owner forms of the binding conflict. -/
theorem formOf_approval {w : ByteArray} (tag : w[0]? = some (0x13 : UInt8)) (act : w[3350]? = some (0x03 : UInt8)) :
    formOf w = some .approval := by
  unfold formOf byteAt; rw [tag, act]; rfl

theorem formOf_legacyKeyChange {w : ByteArray} (tag : w[0]? = some (0x14 : UInt8)) :
    formOf w = some .legacyKeyChange := by
  unfold formOf byteAt; rw [tag]; rfl

#print axioms table
#print axioms all_complete
#print axioms code_injective
#print axioms enabled_default
end Aukora.Forms
