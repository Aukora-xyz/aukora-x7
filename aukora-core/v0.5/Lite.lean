import Machine

namespace Aukora.Lite
open R6.KernelCell (Context)

/-- Record/replay hosts can reject all install packages without loading a proof environment. -/
@[export release_lite_step]
def step (w : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  if w[0]? = some (27 : UInt8) then none else Policy9.step w s

theorem ordinary (ctx : Context) (w : ByteArray) (s : Policy9.Machine) (h : w[0]? ≠ some (27 : UInt8)) :
    step w s = Core9.step ctx w s := by simp [step, Core9.step, h]

theorem no_install (w : ByteArray) (s : Policy9.Machine) (h : w[0]? = some (27 : UInt8)) :
    step w s = none := by simp [step, h]

theorem accepted_by_full (ctx : Context) {w s t} (h : step w s = some t) :
    Core9.step ctx w s = some t := by
  by_cases tag : w[0]? = some (27 : UInt8)
  · simp [step, tag] at h
  · rwa [← ordinary ctx w s tag]

end Aukora.Lite
