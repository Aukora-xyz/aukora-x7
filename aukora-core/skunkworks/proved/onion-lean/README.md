# The totals tree ("onion") as laws, and as a checker in Wasm. 23 November 2026

`sh check.sh` checks the laws (seconds). `sh wasm/build.sh` makes `onion.wasm`. `node wasm/check.mjs` compares it
with the builder lane's tree (`lean-core-lab-2026-11-22/skunkworks/onion/onion.mjs`).

## What the kernel accepts (`Onion.lean`, `Entry.lean`; axioms propext, and Quot.sound for the last)
- `total_is_sum`: a node's total is exactly the sum of the leaves under it (the constant-sum law, at every node).
- `root_binds`: two trees with totals in range and the same root digest are the same tree.
- `climb_sound`: if a checked path from a node reaches the kept root (digest and total), that node is the root of a
  real part of the tree, and so is EVERY sibling the path named. Their totals are true sums. Nothing can be moved
  between neighbours and no total invented without changing the root.
- `included`: a checked path from a leaf means that leaf, with that total, is in the tree.
- `accept_sound`: the compiled checker's "accepted" implies `included`, for the lane's concrete format.
The laws are stated for ANY format; the lane's format (SHA-256, six totals of 8 bytes each, tags 2 and 3, totals at
most 2^53 - 1) is one instance.

## RAN
`onion.wasm`: 162,792 bytes, no imports, SHA-256 `346845cb…0bee8d2`, with the Core's own Lean SHA-256 inside.
Against the lane's tree on records of 1 to 40 lines made with the released adapter: 176 of 176 honest proofs accepted;
2,112 of 2,112 proofs with one changed bit refused; 175 of 175 "one byte of count moved from a leaf to its
neighbour" refused (the hole of the first brief); totals with all bits set refused; 4 of 4 malformed inputs
refused with a value; a planted wrong expectation is reported.

## NOT proved, NOT done
1. The NAMED ASSUMPTIONS (`Sound`): no collisions, fixed digest length, the encoding one-to-one on totals in range.
   None is proved here, not even the encoding's (true by inspection of eight-byte numbers; a small proof is owed).
2. POSITION. The laws prove a leaf is IN the tree, not WHERE. The lane's JavaScript check also ties a proof to an
   index and a size; that part has no law yet.
3. The range check is a hypothesis of every law and a step of the checker. A checker that skips it is outside
   the theorems. That is the "amount written as a huge number" pitfall, and it is why the hypothesis is there.
4. Not the seal a fresh core starts from (blocker 13): that needs the carried state to be a tree of this kind and
   a law joining it to the machine. This is the tree and its checker only.
5. Pruning, regions, growth between two roots: the lane's JavaScript has them with tests; no laws yet.
6. The path from Lean text to Wasm bytes is trusted, not proved. One Mac, one seat.
