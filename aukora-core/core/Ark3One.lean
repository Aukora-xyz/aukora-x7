import Ark3

namespace Aukora.Ark3

theorem lastFour : TwoSided (minor (6,7,8,9)) (entry 0x6ca1b9cda16ccdb949dc4d3ddc493d4d) := check_spec _ _ |>.mp (by decide)
#print axioms lastFour

end Aukora.Ark3
