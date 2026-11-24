import ReleaseInterface
import Proofs.Stamp

namespace Aukora.Release
open R6.KernelCell (Context)
open private Policy9.ran Policy9.parsed Policy9.bound from Proofs.Policy
open private Policy9.applyBase Policy9.append Policy9.setPool from Policy

def acceptedBytes (m : Ops) (ctx : Context) (s : State) : Input → List ByteArray
  | .frame w => if (m.step ctx w s).isSome then [w] else []
  | _ => []

def inputRecord (m : Ops) (ctx : Context) (s : State) : List Input → List ByteArray
  | [] => []
  | c :: cs => acceptedBytes m ctx s c ++ inputRecord m ctx (execute m ctx s c) cs

def RawRecordLaw (m : Ops) : Prop :=
  ∀ ctx s xs, (run m ctx s xs).base.record.toList = s.base.record.toList ++ inputRecord m ctx s xs

private theorem appendedBytes {s w f t} (ok : Policy9.append s w f = some t) :
    t.record = s.record.push w := by
  obtain ⟨_, _, eq⟩ := Policy9.bound ok
  cases Option.some.inj eq
  rfl

private theorem submitted {ctx w s t} (ok : Core9.step ctx w s = some t) :
    t.base.record = s.base.record.push w := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · obtain ⟨_, _, _, _, _, _, record⟩ := Core9.package_admission tag ok
    exact record
  have p : Policy9.step w s = some t := by simpa [Core9.step,tag] using ok
  obtain ⟨c, dec⟩ := Policy9.parsed p
  have h := (Policy9.ran dec p).1
  cases c with
  | issue =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    have recEq := appendedBytes h
    exact recEq
  | cancel =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨_, _, h⟩ := Policy9.bound h
    have recEq := appendedBytes h
    exact recEq
  | rebind =>
    obtain ⟨_, _, h⟩ := Policy9.bound h
    obtain ⟨b, app, eq⟩ := Policy9.bound h
    exact (congrArg Core8.Machine.record (Option.some.inj eq)).symm.trans (appendedBytes (t := b) app)
  | report | ordinary =>
    obtain ⟨_, _, app⟩ := Policy9.bound h
    exact appendedBytes app
  | use i =>
    have permitted := Policy9.use_requires_permission dec p
    simp only [Policy9.applyBase, permitted, if_true, Option.map_eq_some'] at h
    obtain ⟨_, _, eq⟩ := h
    exact (congrArg Core8.Machine.record eq).symm
  | assessment | threshold =>
    simp only [Policy9.applyBase, Option.map_eq_some'] at h
    obtain ⟨_, _, eq⟩ := h
    exact (congrArg Core8.Machine.record eq).symm

private theorem commandBytes (ctx : Context) (s : State) (c : Input) :
    (execute newest ctx s c).base.record.toList = s.base.record.toList ++ acceptedBytes newest ctx s c := by
  cases c with
  | reset | feed => simp [execute,newest,acceptedBytes,Core9.reset,Core8.reset,Core9.feed,Core8.feed]
  | stamp w =>
    cases ok : Core8.stamp w s.base with
    | none => simp [execute,newest,Core9.stamp,ok,acceptedBytes]
    | some b => simp [execute,newest,Core9.stamp,ok,acceptedBytes,(Stamp8.accepted ok).2]
  | frame w =>
    cases ok : Core9.step ctx w s with
    | none => simp [execute,newest,ok,acceptedBytes]
    | some t => simp [execute,newest,ok,acceptedBytes,submitted ok]

theorem newest_rawRecord : RawRecordLaw newest := by
  intro ctx s xs
  induction xs generalizing s with
  | nil => simp [run,inputRecord]
  | cons c cs ih => simp only [run,inputRecord,ih,commandBytes,List.append_assoc]

end Aukora.Release
