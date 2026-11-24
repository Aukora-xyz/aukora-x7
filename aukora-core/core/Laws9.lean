import core.Laws7

/-! Round-nine interface to the complete pinned law contract. -/
namespace Laws9

abbrev Lawful := Laws7.Lawful
abbrev Laws := Laws7.Laws

namespace Laws
export Laws7.Laws (stale passive advice restore memory outcome)

/-- L1. From any state, filtering out refused submissions leaves the replay result unchanged. -/
abbrev replay := @Laws7.Laws.replay

/-- L2. Accepted entries extend history from any state. For a trace from the start
state, each active line ID identifies a statement in that history. -/
abbrev record := @Laws7.Laws.record

/-- L4. Adding a grant requires a verified owner signature. An accepted direct spend
consumes its current-generation grant. Further direct spends fail along any trace
in which that intent receives no new grant. -/
abbrev once := @Laws7.Laws.once

/-- L8. Changing the core consumes the exact install grant, matches the staged digest,
and checks the proof against the supplied context. The gate binds that context's
goal to the candidate. -/
abbrev upgrade := @Laws7.Laws.upgrade

end Laws
end Laws9
