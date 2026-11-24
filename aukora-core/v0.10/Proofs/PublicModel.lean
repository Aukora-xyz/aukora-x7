import Public
import Proofs.Round11Safe

/-! Root v2 step 3a-ii: the public machine is the inner machine behind the refusal wrapper. -/

namespace Aukora.Safe11
open R6.KernelCell (Context)

/-- The public full machine: the v0.9 machine (`innerModel`) behind the refusal wrapper. -/
def fullModel : Release.Model := Refusal.wrap innerModel

/-- Its operations are exactly the exported ones. -/
theorem full_step (ctx : Context) (w : ByteArray) (s : Policy9.Machine) : fullModel.step ctx w s = Public.step ctx w s := rfl
theorem full_feed (b : ByteArray) (s : Policy9.Machine) : fullModel.feed b s = Public.feed b s := rfl
theorem full_reset (s : Policy9.Machine) : fullModel.reset s = Public.reset s := rfl
theorem full_stamp (w : ByteArray) (s : Policy9.Machine) : fullModel.stamp w s = Public.stamp w s := rfl
theorem full_genesis : fullModel.genesis = Core9.genesis := rfl

end Aukora.Safe11
