import Proofs.Root12Conflict

namespace Aukora.Root12
open Release
open R6.KernelCell (Context)
open private Grammar.second Grammar.evidenceFrame from Laws

private abbrev parsed (s : Release.State) (w : ByteArray) :=
  (Grammar.decode Grammar.installed s w).isSome = true

private theorem legacy {ctx w s t} (ok : Ratchet11.step ctx w s = some t) : parsed s w := by
  unfold Ratchet11.step at ok
  split at ok
  · obtain ⟨f,_,proj,_⟩ := step_projection ok
    have old : w[0]? ≠ some (255 : UInt8) := by
      intro tag
      rw [Safe11.frozen_projection tag] at proj
      contradiction
    simp [parsed,Grammar.legacy_stable _ _ _ old,proj]
  · contradiction

private theorem evidence {w s e} (rt : Safe11.route w = .ordinary)
    (hit : Evidence11.decode w = some e) : parsed s w := by
  have tag : w[0]? = some (255 : UInt8) := by
    by_contra no
    simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,no] at hit
  by_cases v2 : w[1]? = some (2 : UInt8)
  · simp [parsed,Grammar.decode,Grammar.installed,tag,v2,Grammar.second,rt,hit]
  · have v3 : w[1]? = some (3 : UInt8) := by
      by_contra other
      simp [Evidence11.decode,Evidence11.subtag,Evidence11.cellSubtag,v2,other] at hit
    simp [parsed,Grammar.decode,Grammar.installed,tag,v3,Grammar.third,hit,guard]

private theorem routed {ctx w s t} (rt : Safe11.route w = .ordinary)
    (ok : Evidence11.routed (Ratchet11.step ctx) w s = some t) : parsed s w := by
  unfold Evidence11.routed at ok
  split at ok
  · obtain ⟨c,_,branch⟩ := Option.bind_eq_some.mp ok
    cases c <;> try contradiction
    obtain ⟨_,_,passed⟩ := Option.bind_eq_some.mp branch
    exact legacy passed
  · split at ok
    · obtain ⟨e,dec,_⟩ := Option.bind_eq_some.mp ok
      exact evidence rt dec
    · exact legacy ok

private theorem header {w : ByteArray} {r : Safe11.Route} (rt : Safe11.route w = r)
    (special : r ≠ .ordinary) : w[0]? = some (255 : UInt8) ∧ w[1]? = some (2 : UInt8) := by
  by_contra notHeader
  simp [Safe11.route,notHeader] at rt
  exact special rt.symm

private theorem control {w s r} (rt : Safe11.route w = r) (special : r ≠ .ordinary)
    (inside : (Grammar.second s w).isSome = true) : parsed s w := by
  obtain ⟨tag,version⟩ := header rt special
  simpa [parsed,Grammar.decode,Grammar.installed,tag,version] using inside

private theorem refusal {next w s} (rt : Safe11.route w = .refusal) (ok : Safe11.refusedAct next s w = true) :
    (Grammar.second s w).isSome = true := by
  simp only [Safe11.refusedAct,Bool.and_eq_true] at ok
  obtain ⟨⟨addressed,isAct⟩,_⟩ := ok
  cases dec : Policy9.decode (w.extract (Safe11.bodyStart s 52) w.size) with
  | none => simp [dec] at isAct
  | some cmd =>
    cases cmd <;> simp [dec] at isAct
    simp [Grammar.second,rt,addressed,guard,dec]

/-- Runs on the actual unbounded full dispatch, independent of any satisfaction
    assumption. Every accepted frame has a parse in the machine's installed grammar. -/
theorem full_parses {ctx w s t} (hit : Safe11.fullModel.step ctx w s = some t) :
    ∃ d, Grammar.decode Safe11.fullModel.grammar s w = some d := by
  apply Option.isSome_iff_exists.mp
  change parsed s w
  obtain ⟨u,raw,_⟩ := Option.map_eq_some'.mp hit
  cases rt : Safe11.route w with
  | ordinary =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · contradiction
    · obtain ⟨_,go,_⟩ := Option.map_eq_some'.mp raw
      exact routed rt go
  | halt =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i ownerOK
      apply control rt (by decide)
      simp [Grammar.second,rt,((Safe11.owner_iff ..).mp ownerOK).1,guard]
    · contradiction
  | clear =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i ownerOK
      apply control rt (by decide)
      simp [Grammar.second,rt,((Safe11.owner_iff ..).mp ownerOK).1,guard]
    · contradiction
  | rebind =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i allowed
      apply control rt (by decide)
      simp [Grammar.second,rt,((Safe11.owner_iff ..).mp (Bool.and_eq_true_iff.mp allowed).1).1,guard]
    · contradiction
  | refusal =>
    simp only [Safe11.raw,rt] at raw
    split at raw
    · rename_i allowed
      exact control rt (by decide) (refusal rt (Bool.and_eq_true_iff.mp allowed).2)
    · contradiction

private theorem one_record (ctx : Context) (s : Release.State) (c : Input) :
    (execute Safe11.fullModel ctx s c).base.record.toList =
      s.base.record.toList ++ acceptedBytes Safe11.fullModel ctx s c := by
  cases c with
  | feed | reset => simp [execute,Safe11.fullModel,newest,acceptedBytes,Core9.reset,Core8.reset,Core9.feed,Core8.feed]
  | stamp w =>
    cases ok : Safe11.fullModel.stamp w s with
    | none => simp [execute,ok,acceptedBytes]
    | some t =>
      have e := (newest_stamp w s t ok).2
      simp [execute,ok,acceptedBytes,e]
  | frame w =>
    cases ok : Safe11.fullModel.step ctx w s with
    | none => simp [execute,ok,acceptedBytes]
    | some t =>
      have rec : t.base.record = s.base.record.push w := by
        obtain ⟨u,raw,eq⟩ := Option.map_eq_some'.mp ok
        cases eq
        rfl
      simp [execute,ok,acceptedBytes,rec]

/-- The full versioned trace has exactly the accepted original bytes, in order. -/
theorem full_raw_record : RawRecordLaw Safe11.fullModel := by
  intro ctx s xs
  induction xs generalizing s with
  | nil => simp [run,inputRecord]
  | cons c cs ih => simp only [run,inputRecord,ih,one_record,List.append_assoc]

#print axioms full_raw_record
#print axioms full_parses
end Aukora.Root12
