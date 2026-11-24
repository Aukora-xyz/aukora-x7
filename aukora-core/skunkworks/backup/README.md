# Backup checkpoint

A record is a list of byte strings ordered oldest to newest; a line may be empty.
Genesis `g` is exactly 32 bytes. Set `h = g`; for each line set
`h = SHA-256(h || line)`. The final `h` is the head.
A checkpoint holds the number of retained lines and their head as `count` and `top`.
Verdict 1: the supplied record has fewer than `count` lines.
Otherwise hash its retained prefix of `count` lines from `g`.
Verdict 0: that head equals `top`; verdict 2: it differs.

This assumes SHA-256 has no collisions for these inputs; the draft proves no such property.
Keep the checkpoint and genesis separately from the copy being examined.
The reader re-reads and hashes every retained line when enough lines are available.
There is no length prefix: the running head is always 32 bytes, which separates it
from each line. Moving a boundary changes the step inputs and counts as a rewrite.
An accepted prefix says nothing about who wrote it, the appended lines, or whether
a newer copy exists.

`node skunkworks/backup/make-vectors.mjs` regenerates the checked-in fixture.
`node skunkworks/backup/test.mjs` checks both implementations with Node 24 and Python 3.

The JSON cases use one shared genesis per comparison. A separate direct check
compares checkpoints made and verified under different genesis values.
