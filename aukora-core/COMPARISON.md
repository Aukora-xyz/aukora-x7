# How this core sits beside published work

Each row says only what the cited source states, as we read it in November 2026. "Not stated" means we did not
find it in the source we read; it does not mean the system lacks it. Corrections are welcome.

| | This core | Tether | Cedar | Progent | AgentSpec | OpenShell |
| --- | --- | --- | --- | --- | --- | --- |
| Source | this tree | arXiv 2611.25599 | AWS announcement (2023) and the `cedar-spec` repository README | arXiv 2504.11703 | arXiv 2503.18666 | NVIDIA OpenShell docs, architecture and policy pages (v0.1.9) |
| What is decided | whether a signed frame is admitted to an agent's append-only record (acts, approvals, owner commands) | whether an agent's shell action is allowed, over a stateful security label | whether a request is authorized under a policy | whether a tool call with its arguments is allowed | whether a rule fires at a hook in the agent loop, and what it enforces | network, file, process limits of a sandbox, applied outside the agent |
| Where the decision logic is machine-checked | Lean 4: the decision function itself, 46 named laws for one machine (v0.10), kernel-checked | Lean 4: the policy language and four properties | Lean: a formal model with proofs | not stated; an SMT solver checks whether a policy update narrows | not stated | an SMT-based prover checks a policy against a boundary |
| Is the code that runs the checked code? | the same Lean text is compiled to WebAssembly; the Lean definitions, run by Lean's interpreter, are compared with the compiled file on generated inputs (`drt/model/`), and the compiled files with each other (`drt/`); not proved equal | the prototype runs the Lean definitions directly; a compiled runtime would need differential testing (the paper's own note) | the production engine is tested against the Lean model by differential random testing | not stated | not stated | not stated |
| With no matching rule | acts that need approval are refused; unsigned lines are admitted | allowed | not stated in what we read | blocked | allowed | network: denied |
| How the rules change | the refused list is fixed at the record's start and never loses a member (v0.10); the law set changes only through a proof-checked install | not stated in what we read | not stated in what we read | narrowing applied automatically; widening sent to an approver | not stated | network rules at runtime; file and process rules at start |
| Who approves | the owner, with two signatures (Ed25519 and ML-DSA-65) over the exact act; the newer forms also sign the record's head, and a bound record refuses the older ones | not stated | not stated | an approver module, which can be a person | a person can inspect | an administrator; agent proposals are risk-checked |
| Tamper-evident record | hash-chained, replayable by anyone holding the core file; detecting a shortened record needs an expected head kept elsewhere | not stated | not stated | not stated | not stated | logs and traces; no tamper evidence stated |
| Undo | revertible store rehearsal; its laws kernel-checked separately (`skunkworks/proved/cordis-lean/`) | denied actions are discarded before commit | not stated | not stated | not stated | not stated |

Revertible effects follow "A Programming Paradigm for Spatiotemporal Composability" (Shi, Zhang, Cui). That paper
proves its statements on paper; `skunkworks/proved/cordis-lean/` checks five of them, in a simplified form, with the
Lean kernel. We claim nothing about the paper's own system.

## What we took from each
- From Tether's list of properties: the four are now named obligations for this core (see `NEXT-LINE.md`), and the
  no-op on refusal is also checked on the compiled bytes by `drt/`.
- From Cedar's method: differential testing of what runs against what was proved, with structured generators and a
  kept corpus of every disagreement (`drt/`, `drt/model/`).
- From Progent's split of narrowing and widening: in this core a record's refused list is fixed at its start and never shrinks; letting the owner add to it while the record runs is not built.
- From OpenShell's prover: `tools/within.mjs` answers within, exceeds or unsupported for two restriction lists, and
  fails closed.
- From AgentSpec: the weak point of any checker is whether every action passes through it. This core says plainly
  that it does not enforce that (see `THREATS.md`).
