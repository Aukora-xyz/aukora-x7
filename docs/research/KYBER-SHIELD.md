# Kyber Shield: open research on child safety and private communication

## Summary

**DIRECTION.** Kyber Shield explores whether a personally owned AI can help protect young people from grooming, sexual exploitation and coercion while preserving private communication and human authority. The proposal combines explicit contact permissions, narrowly scoped local assistance and voluntary reporting. This document publishes the research direction for examination; it does not provide a deployed protection service or an effectiveness claim.

## Contents

- [What exists](#what-exists)
- [The proposed system](#the-proposed-system)
- [What must be demonstrated](#what-must-be-demonstrated)
- [Kyber Kernel and the evidence limit](#kyber-kernel-and-the-evidence-limit)
- [Sources](#sources)
- [Research notice](#research-notice)

<a id="what-exists"></a>

## What exists

**IMPLEMENTED.** X7 contains a pinned, import-free computation cell and admission checks for its imports, exports, memory and fuel: [`kyber-cell.mjs`](../../deploy/cloudflare/src/kyber-cell.mjs), [`kyber-cpu.wat`](../../apps/web/public/cells/kyber-cpu.wat), and [`kyber-cell.test.mjs`](../../deploy/cloudflare/src/__tests__/kyber-cell.test.mjs). That cell computes; it is not a grooming detector or a safety authority. Its checkpoint check is a checksum, not a signature or permission.

**IMPLEMENTED.** X7 also contains request-bound approval checks and signed receipt checkpoints: [`aumlok.mjs`](../../deploy/cloudflare/src/aumlok.mjs), [`convergence-approval-fencing.test.mjs`](../../deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs), [`seed-receipts.js`](../../mirror/home/auma/seed/organs/seed-receipts.js), and [`receipts-policy.test.mjs`](../../server/receipts-policy.test.mjs). The receipt tests have known failures. Code and tests being present do not establish a deployed safety service; consult the [current limitations](../AI-START-HERE.md) and [known failures](../KNOWN-RED-TESTS.md).

**DIRECTION.** Kyber Shield's youth policies, contact restrictions, local classifiers, reporting protocol and transition to adult independence are research proposals. It installs no scanner, imports no private conversation and grants no new permission.

<a id="the-proposed-system"></a>

## The proposed system

All mechanisms in this section are **DIRECTION**, unless the cited external research is being described.

### Contact permissions before contact

The proposed Vanguard youth account has explicit rules about who may contact it and which media it may render. Human-signed invitations could provide an accountable introduction path, while narrowly scoped capabilities would govern delivery. An invitation is evidence of an introduction, not proof of a unique human or a trustworthy person. Compromised keys, coercion, collusion and malicious inviters remain part of the threat model.

### Local help with separate permissions

The proposal separates permission to **view**, **retain**, **transmit** and **train**. A local assistant permitted to inspect an incoming item would not thereby gain permission to store it, upload it or train on it. A sealed Wasm computation cell is one candidate implementation component; the trusted host, model loader, memory storage, updates and operating system also need scrutiny. A no-import module is not an air-gapped device.

Private coaching, a temporary media blur and an explanation visible to the young person are candidate responses. A choice to involve a trusted adult would be explicit and specific. The design must account for abusive guardians, children who cannot safely contact a parent and emergency access to human support. Guardian access is not a standing right to read a young person's diary.

### Context across time, without automatic accusation

The research asks whether an assistant can recognize patterns of pressure, isolation and coercion across a conversation while distinguishing benign situations such as a surprise gift or a sensitive personal question. Exact typed local state could make the system's observations and decisions reviewable. It cannot make the underlying interpretation infallible.

Any pattern model would need consented, lawful evaluation data, explicit retention limits and independent safeguarding review. No illegal material, private child conversations or real-person accusations are included in this publication. Synthetic examples can test program behavior but cannot establish real-world detection accuracy. A model score would never be proof of abuse, a police report or permission for a permanent account ban.

### Reports selected by the recipient

[Message franking](https://eprint.iacr.org/2017/664) studies cryptographic reporting of selected abusive messages within an encrypted messaging system. Committing authenticated encryption can support a report that a recipient cannot freely change after receipt. Adapting such a protocol to X7 requires a precise security model, a reviewed construction and an explicit account of who can verify the report.

A payload hash alone does not establish its sender. A valid signature establishes a relationship to a key under the protocol's assumptions, not the identity, intent or guilt of the human using it. Selective disclosure must preserve unrelated conversations. Review, contestability, key compromise and recovery must be part of any consequential enforcement process.

### Independence as the young person grows

The proposed Vanguard-to-Unbound transition ends guardian control and leaves the person in charge of their own identity and history. Age assurance, local requirements, disputes, lost keys and recovery need a specified policy. A birthday field or a guardian signature alone cannot settle those questions. The transition must not allow a guardian to retain hidden access or hold someone's lifelong data hostage.

<a id="what-must-be-demonstrated"></a>

## What must be demonstrated

**DIRECTION.** The following are acceptance questions for future research, not tests passed by this document.

| Area | Required evidence | Failure that must remain visible |
| --- | --- | --- |
| Private computation | Public source, reproducible builds and tests for value, timing, output length, silence and call-count leaks | A legal port schema can still leak information. |
| Human contact | Adversarial tests for invitation farms, compromised keys, collusion and unwanted delivery | Invitation lineage is not a Sybil-free guarantee. |
| Assistance quality | Independently reviewed lawful datasets, false-positive and false-negative measurements, age/language coverage and adversarial evaluation | Synthetic success is not protection in real conversations. |
| Reporting | A reviewed protocol, tampering and false-report tests, selective disclosure and key-compromise handling | Authentic bytes can still be misinterpreted or lack context. |
| Human control | Revocation, guardian abuse, safe escalation, appeal, export and recovery exercises | A protective feature can itself become coercive. |
| Whole system | Independent security and safeguarding evaluation, including host, updates, storage and device compromise | Wasm isolation alone is not end-to-end privacy. |

The proposal takes the risks documented in [Bugs in our Pockets](https://arxiv.org/abs/2110.07450) seriously: moving inspection to a device does not by itself prevent surveillance, evasion or repurposing. A successful design would need to demonstrate its narrower permissions and failure behavior rather than assume that local processing resolves those risks.

<a id="kyber-kernel-and-the-evidence-limit"></a>

## Kyber Kernel and the evidence limit

**UNVERIFIED — author-reported lab work.** The Kyber Kernel research notes, which are not published here, report experiments in cross-engine checkpoint recovery, exact integer computation, mathematical limits of observation, separate Wasm memories, leakage through permitted ports and optical transport of checked bytes. The underlying lab harnesses, complete outputs and independent reproduction are unpublished. The report's numerical results are therefore not presented here as measured facts of the public X7 tree.

The important proposed connection is explicit: computation may produce a proposal or an observation, while permission remains outside it. For a mathematical model, two legal states that produce the same permitted observations but different answers can demonstrate that an answer is not inferable from those observations. This does not prove what a person intends or eliminate uncertainty in a language model.

Kyber Kernel is the project name for this runtime research. It is not a claim that the design is the ML-KEM/Kyber cryptographic algorithm or that it has post-quantum security.

<a id="sources"></a>

## Sources

- The Kyber Kernel research notes, which are not published here. These are architecture proposals, not executable evidence. This document is an edited research statement rather than a verbatim publication of their stronger claims.
- [X7: AI start here](../AI-START-HERE.md) defines the repository's evidence labels and current trust limits. [What is built](../WHAT-IS-BUILT.md) maps existing code. [Security](../../SECURITY.md) and [safety](../../SAFETY.md) describe the public prototype's limits.
- Paul Grubbs, Jiahui Lu and Thomas Ristenpart, [Message Franking via Committing Authenticated Encryption](https://eprint.iacr.org/2017/664), CRYPTO 2017.
- Hal Abelson and coauthors, [Bugs in our Pockets: The Risks of Client-Side Scanning](https://arxiv.org/abs/2110.07450), 2021.

<a id="research-notice"></a>

## Research notice

Kyber Shield is open research, not a deployed child-protection product, a guarantee of privacy, or a substitute for trusted human help. No classifier, trained model, reporting service or real-world safeguarding evaluation is supplied here. Discussion and review should use lawful, non-identifying material; do not submit abuse material or children's private messages to this repository. Publication invites scrutiny and contribution, not reliance on unverified protection.
