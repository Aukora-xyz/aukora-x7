# AUKORA Core, standalone (lab)

A small proved core that any agent system can run beside itself to keep a record nobody can quietly rewrite.
Lab status: research, not a product. Licence intent: AGPL-3.0-or-later, like the rest of AUKORA.

## What is in this folder
| File | What it is |
| --- | --- |
| `aukora-core.wasm` | the core from lab round 5: 355,910 bytes, SHA-256 `d74a5e0170299d62e8349496b9c0e31b2a4091b51273ef8bf82204b39222350a`. Compiled from Lean text whose laws were accepted by the Lean kernel. No imports; private memory |
| `aukora-core.mjs` | a 100-line adapter: append an event, read the head, replay a log. It decides nothing |
| `cli.mjs` | a command line over the adapter |
| `mcp-server.mjs` | the same three reads and one write as MCP tools, so an agent host can attach |
| `demo-*/record.log` | a real record kept by a Claude Code session of its own lab actions |

## Try it (Node 20 or newer, nothing to install)
```
node cli.mjs init my-record
node cli.mjs say my-record "RAN: the tests passed at commit abc123"
node cli.mjs approve-and-act my-record "github:me/repo" "push commit abc123"
node cli.mjs verify my-record/record.log
```
`verify` needs no key. Change one character in an earlier line of the log, or delete a line, and it says NOT VALID.

## What the core guarantees (each is a theorem accepted by the Lean kernel, about the model the file is compiled from)
- Every accepted event extends the record; nothing accepted earlier changes or moves.
- An event that names a stale parent or a wrong sequence number is refused and changes nothing.
- An approval exists only with the owner's signature over that exact action, and is used at most once.
- Plain lines, memories, advice and outcomes can never change who is the owner or what is approved.
- The owner key changes only by a handover signed with the old key, which cancels every unspent approval.

## What it does not guarantee (read before relying on it)
- It records what an agent SAYS it did. It cannot see whether that was true.
- The newest lines can be dropped or altered without breaking replay; only a head that was remembered or
  witnessed elsewhere (for example a Bitcoin timestamp) detects that.
- The signature and hash code inside is tested against independent implementations, not proved; the Lean and Wasm
  compilers and about 350 lines of build and interface code are trusted.
- `cli.mjs init` makes a LAB key in a file. A real owner key belongs in a passkey or hardware key, never beside
  the agent.
- This build checks Ed25519 only. Post-quantum (hybrid) signatures and the proof-carrying upgrade gate are later
  lab rounds, not in this file.
