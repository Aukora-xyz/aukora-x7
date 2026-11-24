import Proofs.InstalledControls
import Proofs.InstalledRecovery

namespace Aukora.RootFinal
open Release
open Safe11 (innerModel)
open R6.KernelCell (Context)
open Versions
open ControlAvailability (extensionValid)
open private Policy9.append from Policy

/-- The first two extension namespaces have immutable owner, evidence, and
    refusal handlers. Their decisions are evaluated against the candidate's
    interpreted history. Public quota checks are applied by PublicPorts. -/
def prefixVerdict (g : WireGrammar) (ctx : Context) (s : Release.State) (w : ByteArray) : Bool :=
  let history := Historical.state g s
  match Safe11.route w with
  | .halt => Safe11.ownerOK history w 50
  | .clear => Safe11.ownerOK history w 51
  | .rebind => Safe11.ownerOK history w 53 && Hybrid7.validKey (Safe11.newKeys history w)
  | .refusal => !Safe11.halted history && Safe11.refusedAct (Evidence11.step (Ratchet11.step ctx)) history w
  | .ordinary => !(Safe11.halted history && !Safe11.allowedOrdinary w) &&
    ((Evidence11.decode w).bind fun e => Evidence11.submit history w e).isSome

/-- Every new typed event has an admission test using decoded fields, independently
    of the candidate step. A historical evidence envelope also needs its own
    reference check over the installed interpretation of prior receipts. -/
def futureReady (g : WireGrammar) (s : Release.State) (w : ByteArray) (d : Root12.Grammar.Decoded)
    (op : ExtensionKind) : Prop :=
  slotAction d op ∧
  (∀ e, Evidence11.decode (Historical.wire g w) = some e →
    Historical.describes s e op ∧ e.parent = d.frame.parent ∧ e.seq = d.frame.seq ∧
    (Evidence11.submit (Historical.state g s) w e).isSome = true) ∧
  match op with
  | .passive => (Policy9.append s.base w d.frame).isSome = true
  | .report .. => extensionValid s w d .report op
  | .assessment .. => extensionValid s w d .assessment op
  | .threshold .. => extensionValid s w d .threshold op
  | .issue .. => extensionValid s w d .issue op
  | .cancel .. => extensionValid s w d .cancel op
  | .rebind p n keys ed ml => addressed s p n ∧ Hybrid7.validKey keys = true ∧
    Hybrid7.Both Core8.verifiers (owner s) (futureRebindMessage s p n keys) ed ml

def VersionVerdicts (m : Model) : Prop :=
  (∀ ctx s w (v : UInt8), w[0]? = some 255 → w[1]? = some v → (v = 2 ∨ v = 3) → ¬ Forms.Refused s w →
    (m.step ctx w s).isSome = prefixVerdict m.grammar ctx s w) ∧
  ∀ ctx s w (v : UInt8), w[0]? = some 255 → w[1]? = some v → 4 ≤ v.toNat → ¬ Forms.Refused s w →
    ((m.step ctx w s).isSome = true ↔
      ∃ d op, Root12.Grammar.decode m.grammar s w = some d ∧ d.payload = .later v w op ∧
        (Safe11.halted s = false ∨ haltAllowed m s w) ∧ futureReady m.grammar s w d op)

/-- The v0.7 text of `VersionVerdicts`, kept only for the growth edge and step 4. -/
def Old.VersionVerdicts (m : Model) : Prop :=
  (∀ ctx s w (v : UInt8), w[0]? = some 255 → w[1]? = some v → (v = 2 ∨ v = 3) →
    (m.step ctx w s).isSome = prefixVerdict m.grammar ctx s w) ∧
  ∀ ctx s w (v : UInt8), w[0]? = some 255 → w[1]? = some v → 4 ≤ v.toNat →
    ((m.step ctx w s).isSome = true ↔
      ∃ d op, Root12.Grammar.decode m.grammar s w = some d ∧ d.payload = .later v w op ∧
        (Safe11.halted s = false ∨ haltAllowed m s w) ∧ futureReady m.grammar s w d op)

open private RootFinal.noFuture from Proofs.Versions
open private Root12.header from Proofs.Root12Grammar

theorem Old.full_versionVerdicts : Old.VersionVerdicts innerModel := by
  constructor
  · intro ctx s w v ff ver version
    simp only [prefixVerdict,Historical.same_state (Historical.stable_current s)]
    cases rt : Safe11.route w with
    | halt | clear | rebind | refusal =>
      simp [innerModel,Round11.step,Safe11.step,Safe11.raw,rt]
      split <;> simp_all
    | ordinary =>
      have notAct : w[0]? ≠ some (23 : UInt8) := by simp [ff]
      have notInstall : w[0]? ≠ some (27 : UInt8) := by simp [ff]
      have oldNone : Core9.step ctx w s = none := by
        cases result : Core9.step ctx w s with
        | none => rfl
        | some t =>
          obtain ⟨f,_,proj,_⟩ := Release.step_projection result
          rw [Safe11.frozen_projection ff] at proj
          contradiction
      simp only [innerModel,Round11.step,Safe11.step,Safe11.raw,rt]
      split
      · rename_i stopped
        simp [stopped]
      · rename_i running
        simp only [Option.isSome_map, Bool.not_eq_true', Bool.and_eq_false_iff] at *
        have routeInput : (Evidence11.routed (Ratchet11.step ctx) w s).isSome =
            ((Evidence11.decode w).bind fun e => Evidence11.submit s w e).isSome := by
          rw [Evidence11.routed,if_neg notAct]
          split
          · rfl
          · rename_i unknown
            have dec : Evidence11.decode w = none := by
              cases code : Evidence11.subtag w <;> cases cell : Evidence11.cellSubtag w <;>
                simp_all [Evidence11.decode]
              rename_i tag
              have outside : ¬ (40 ≤ tag ∧ tag ≤ 43) := fun h => UInt8.not_lt.mpr h.2 (unknown h.1)
              simp [guard,outside]
            simp [dec,Ratchet11.step,Ratchet11.allow_ordinary notInstall,oldNone]
        cases halted : Safe11.halted s <;> simp_all [Evidence11.step]
  · intro ctx s w v ff ver large
    constructor
    · intro ok
      obtain ⟨t,hit⟩ := Option.isSome_iff_exists.mp ok
      obtain ⟨d,parsed⟩ := Root12.full_parses hit
      have different : v ≠ 2 := by rintro rfl; contradiction
      have idx : 1 ≤ v.toNat - 3 := by omega
      have noneAt : Root12.Grammar.installed.later[v.toNat - 3]? = none :=
        List.getElem?_eq_none (by simpa [Root12.Grammar.installed] using idx)
      simp [innerModel,Root12.Grammar.decode,Root12.Grammar.installed,ff,ver,different] at parsed
      have empty : ([{project := Root12.Grammar.third,interpret := fun _ _ => none}] : List WireSlot)[v.toNat - 3]? = none := noneAt
      simp [empty] at parsed
    · rintro ⟨d,op,dec,assign,_⟩
      exact False.elim (RootFinal.noFuture dec assign)

theorem full_versionVerdicts : VersionVerdicts innerModel :=
  ⟨fun ctx s w v ff ver vs _ => Old.full_versionVerdicts.1 ctx s w v ff ver vs,
   fun ctx s w v ff ver vs _ => Old.full_versionVerdicts.2 ctx s w v ff ver vs⟩

/-- A growth edge compares decisions on the same submitted bytes, ledger state
    and stored receipts. Previously assigned bytes keep both acceptance and
    refusal, including malformed messages inside an assigned namespace. -/
theorem verdict_edge {parent child : Model} (a : Old.VersionVerdicts parent) (b : Old.VersionVerdicts child)
    (pin : Root12.Grammar.Preserves parent.grammar child) {s : Release.State} {w v}
    (ff : w[0]? = some 255) (tag : w[1]? = some v) (covered : 2 ≤ v.toNat)
    (history : ∀ z ∈ s.base.record, Historical.Known parent.grammar z)
    (known : Historical.Known parent.grammar w) (ctx : Context) :
    (child.step ctx w s).isSome = (parent.step ctx w s).isSome := by
  have h := grows_of_pin pin
  have sameRecord : Historical.record child.grammar s = Historical.record parent.grammar s :=
    Array.map_congr_left (fun z mem => Historical.wire_stable h (history z mem))
  have sameState : Historical.state child.grammar s = Historical.state parent.grammar s := by
    simp [Historical.state,sameRecord]
  by_cases earlyTag : v = 2 ∨ v = 3
  · rw [a.1 ctx s w v ff tag earlyTag,b.1 ctx s w v ff tag earlyTag]
    simp [prefixVerdict,sameState]
  · have large : 4 ≤ v.toNat := by
      have two : v ≠ 2 := fun eq => earlyTag (.inl eq)
      have three : v ≠ 3 := fun eq => earlyTag (.inr eq)
      have neTwo : v.toNat ≠ 2 := fun h => two (UInt8.toNat_inj.mp h)
      have neThree : v.toNat ≠ 3 := fun h => three (UInt8.toNat_inj.mp h)
      omega
    have coveredWire : Root12.Grammar.Known parent.grammar w := by
      rcases known with old | no | ⟨idx,at_,small | ⟨yes,early | ⟨_,slot⟩⟩⟩
      · exact .inl old
      · exact .inr (.inl no)
      · exact .inr (.inr ⟨idx,at_,.inl (by omega)⟩)
      · exact .inr (.inr ⟨idx,at_,.inl (by rw [early]; decide)⟩)
      · exact .inr (.inr ⟨idx,at_,.inr slot⟩)
    have decoded := Root12.Grammar.Extends.decode_of_known pin s w coveredWire
    have wire := Historical.wire_stable h known
    have interp : interpretations child.grammar s w = interpretations parent.grammar s w := by
      simp [interpretations,decoded]
    have halted : haltAllowed child s w ↔ haltAllowed parent s w := by
      simp [haltAllowed,wire,interp,decoded]
    have ready (d op) : futureReady child.grammar s w d op ↔ futureReady parent.grammar s w d op := by
      simp [futureReady,wire,sameState]
    apply Bool.eq_iff_iff.mpr
    simp only [a.2 ctx s w v ff tag large,b.2 ctx s w v ff tag large,decoded,halted,ready]

/-- Ordinary 01 verdicts agree across a growth edge whenever every stored
    receipt comes from a previously assigned namespace. Tag 27 has the two
    live certificate goals and its separate succession obligation. -/
theorem legacy_verdict_edge {parent child : Model} (a : Old.PriorVerdicts parent) (b : Old.PriorVerdicts child)
    (pin : Root12.Grammar.Preserves parent.grammar child) {s : Release.State} {w}
    (old : Legacy w) (regular : w[0]? ≠ some (27 : UInt8))
    (history : ∀ z ∈ s.base.record, Historical.Known parent.grammar z) (ctx : Context) :
    (child.step ctx w s).isSome = (parent.step ctx w s).isSome := by
  have grow := grows_of_pin pin
  have same (z) (held : z ∈ s.base.record) := Historical.wire_stable grow (history z held)
  have hist : Historical.record child.grammar s = Historical.record parent.grammar s := Array.map_congr_left same
  have views : Historical.state child.grammar s = Historical.state parent.grammar s := by simp [Historical.state,hist]
  have pairs : s.base.record.map (fun z => (Historical.wire child.grammar z,z)) =
      s.base.record.map (fun z => (Historical.wire parent.grammar z,z)) :=
    Array.map_congr_left (fun z held => by simp only [same z held])
  have evidence (i : Intent) : Historical.allows child.grammar s w i = Historical.allows parent.grammar s w i := by
    simp [Historical.allows,Historical.pick,pairs,hist,views]
  rw [a ctx w s old regular,b ctx w s old regular]
  simp only [evidence]

#print axioms legacy_verdict_edge
#print axioms verdict_edge
#print axioms full_versionVerdicts
end Aukora.RootFinal
