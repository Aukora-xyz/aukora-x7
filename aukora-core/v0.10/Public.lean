import Refusal
import Lite12

/-! Root v2 step 3a-ii: the exported public operations. ONE place reads the refused register: an input whose
form is refused (and not essential) is not admitted and leaves the state unchanged; every other input goes to
the inner operation, unchanged since v0.9. `Safe11.fullModel` is `Refusal.wrap Safe11.innerModel`, and these
are its operations (`Proofs/PublicModel.lean` checks that by `rfl`). -/

namespace Aukora.Public
open R6.KernelCell (Context)

@[export r11_step] def step (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  if Refusal.refuses s (.frame w) then none else Round11.step ctx w s

@[export r12_lite_step] def liteStep (w : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  if Refusal.refuses s (.frame w) then none else Lite12.step w s

@[export r9_feed] def feed (chunk : ByteArray) (s : Policy9.Machine) : Policy9.Machine :=
  if Refusal.refuses s (.feed chunk) then s else Core9.feed chunk s

@[export r9_reset] def reset (s : Policy9.Machine) : Policy9.Machine :=
  if Refusal.refuses s .reset then s else Core9.reset s

@[export r9_stamp] def stamp (bytes : ByteArray) (s : Policy9.Machine) : Option Policy9.Machine :=
  if Refusal.refuses s (.stamp bytes) then none else Core9.stamp bytes s

end Aukora.Public
