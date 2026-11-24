# Aukora Core, standalone: a record that shows when it was changed, and acts that need the owner's approval

Plain Node 24 or newer, no dependencies. It runs a pinned small core (`aukora-core-lite.wasm`); `Core.load()`
refuses any file whose SHA-256 is not in the adapter's pin list. In a release tree the file beside this page is
that release's small core. The Wasm file decides everything; these files only build frames from the wire
document (`core/WIRE.md` in a release tree), sign with the owner's two keys, store accepted frames and replay
them. `node standalone/test.mjs` runs 34 end-to-end checks and prints the core's fingerprint.

| File | What it is |
| --- | --- |
| `aukora.mjs` | The adapter: `Core.load()`, `init`, `say`, `grant`, `grantUntil`, `revoke`, `act`, `outcome`, `correctOutcome`, `assess`, `setThreshold`, `exportRecord`, `replay`. Refuses to load a file that is not a pinned release |
| `store.mjs` | A record on disk: `record.log`, `intents.json`, and the secret `owner.key` |
| `cli.mjs` | `aukora init|say|propose|approve|act|outcome|revoke|head|verify <dir>` |
| `mcp-server.mjs` | An MCP server over stdio for any agent: `aukora_say`, `aukora_propose`, `aukora_act`, `aukora_outcome`, `aukora_head`. It never reads the owner key |
| `checkpoint.mjs` | Checkpoints over a record (RFC 6962 tree): `aukora checkpoint <dir> [earlier checkpoint file]`. Computes only; decides and gates nothing |

## The loop
1. The agent proposes: `aukora_propose` (nothing runs).
2. The owner approves exactly that proposal: `aukora approve <dir> a1` (shows the exact words, then signs with
   BOTH an Ed25519 key and an ML-DSA-65 key).
3. The agent asks: `aukora_act`. The core admits it once. A second try, a changed payload, a cancelled or expired
   approval, or a stranger's signature are all refused by the core, not by this code.
4. `aukora verify <dir> [head you remembered]` replays every line in a fresh core.

## What this does NOT do (read before relying on it)
- **Nothing forces the agent to obey.** `aukora_act` returning `admitted:false` stops nothing by itself. Until
  the thing that has the real effect checks a permit, this is a witness, not a lock.
- **The owner key is a file.** An agent that can read `owner.key` can approve for itself. Keep it where the agent
  cannot reach (`AUKORA_OWNER_KEY=/some/other/place`); a passkey or hardware key is the real answer and is not built.
- **The last lines can be dropped.** A record cut at the end still replays; only a head someone remembered, or an
  outside witness, shows it (`verify <dir> <head>` does the comparison).
- `intents.json` is not protected: a changed proposal is caught only because the approval covers the exact bytes.
- No file lock: two writers at once can lose a line. One writer per record.
- Every call replays the whole record (simple, slow for long records). At most 65,535 proposals per record.
- The proofs are about the Lean model of this core, not its compiled bytes; the cryptography is tested, not proved.

## Checkpoints: seeing a cut or a fork (uses an existing verifier, unchanged)
The core cannot see two things by itself: a record cut at its end, and a second, different history started from
the same beginning. Both still replay. A checkpoint kept OUTSIDE the host shows them.
1. `aukora checkpoint <dir> > kept.json` and store `kept.json` where the host cannot change it. It holds two
   values: the number of lines and one fingerprint of all of them. It reveals no line.
2. Later: `aukora checkpoint <dir> kept.json > now.json`, then run the minimal append-only verifier on the pair:
   `python3 verify.py kept.json now.json`. Only the printed line `VERDICT: APPEND_ONLY` is a pass. Do not go by
   the exit status. `OBSERVATION_CONFLICT` means the earlier lines were replaced. `UNDETERMINED` is not a pass.
The verifier (`verify.py`) is a separate, small file and is NOT in this tree; the comparison is two numbers and
can be done by any implementation of an RFC 6962 consistency check.

What this does NOT do, in the verifier's own terms: it does not show that any recorded event happened, that a
line is true, that code ran, who anyone is, or that the host keeps only one record. A checkpoint kept at a size
that is a power of two cannot earn the accusation of a rewrite (the result is `UNDETERMINED`, still not a pass).
Nothing here is checked by the core or blocks an act; a checkpoint nobody keeps outside the host checks nothing.
Not done: comparison against the verifier's second implementation; signed checkpoints; any outside witness service.
