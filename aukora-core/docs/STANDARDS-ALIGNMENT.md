STANDARDS ALIGNMENT: 11 items checked, 31 facts verified from primary pages fetched on 2026-11-22, 15 marked UNVERIFIED

"Verified" means I fetched the page named. Datatracker pages were read through a summarising fetcher, so quote them again before you cite them in a paper.

## Top 6 to act on

| # | Item | Verdict | Single change to your wire format or record | Effort |
|---|------|---------|---------------------------------------------|--------|
| 1 | A. C2SP tlog-checkpoint + tlog-witness | ALIGN | Publish each record head as a signed-note checkpoint (origin, tree size, RFC 6962 Merkle root). This needs a Merkle tree over the records, not only a hash chain, so consistency proofs exist. | medium |
| 2 | B. COSE (RFC 9052/9053) with ML-DSA (RFC 9964) and COSE Receipts (RFC 9942) | ALIGN | Carry owner approvals as COSE_Sign1, ML-DSA-65 = alg -49. Express the head receipt as an RFC 9942 receipt. | medium |
| 3 | D. TUF root rotation | ALIGN | Key-change event: version must be exactly previous+1, signed by a threshold of OLD keys and a threshold of NEW keys; every approval and checkpoint carries an expiry. | small |
| 4 | E. KERI pre-rotation | ALIGN | Each key-change event commits to a digest of the NEXT key set, so a lost or stolen current key cannot name its own successor. | small |
| 5 | F. WebAuthn L3 | ALIGN | Add an approval type that verifies an assertion: signature over authenticatorData and SHA-256(clientDataJSON), challenge = hash of the exact approval bytes. | medium |
| 6 | G. Composite ML-DSA (RFC 10073) | ALIGN | Replace "two independent signatures" with one composite construction (id-MLDSA65-Ed25519-SHA512 style, with a domain-separation label), or document why not. | small |

## A. Transparency logs and witnessing
1. RFC 9162 (CT v2) is "Experimental... not an Internet Standards Track specification", December 2021, obsoletes RFC 6962. Obsoleted-by: UNVERIFIED. https://datatracker.ietf.org/doc/rfc9162/
2. C2SP specs carry no status line on the page; they cite tlog-checkpoint@v1.1.0, signed-note@v1.1.0, tlog-cosignature@v1.1.0, tlog-witness@v1.1.0, tlog-mirror@v0.1.0. https://c2sp.org/tlog-checkpoint , https://c2sp.org/tlog-witness , https://c2sp.org/tlog-cosignature
3. Mechanism: a checkpoint is a signed note with 3 body lines (origin, tree size, base64 RFC 6962 root). A witness (POST add-checkpoint with old size + consistency proof) cosigns only a checkpoint that extends the last one it cosigned; size check and persist are atomic. This defeats split views and rolled-back heads. https://c2sp.org/tlog-witness
4. Signed-note line: key name + base64(4-byte key ID || signature); Ed25519 type byte 0x01. https://c2sp.org/signed-note
5. Cosignatures: ML-DSA-44 "SHOULD be used for new deployments"; Ed25519 also defined. ML-DSA-65 is not the named choice. https://c2sp.org/tlog-cosignature
6. Witness network (witness-network.org) is labelled "experimental / work-in-progress"; witness count not stated on the page. https://witness-network.org , https://github.com/transparency-dev/witness-network . Sigstore/Go sumdb witnessing today: UNVERIFIED (search only).
Verdict: ALIGN. This is the only item that closes gap (a) with infrastructure that already exists. Caveat: witnesses expect an RFC 6962 Merkle tree, so a plain hash chain cannot be witnessed as is.

## B. SCITT and COSE
1. SCITT architecture is RFC 9943, Proposed Standard, June 2026 (was draft rev 22). Signed Statements are COSE_Sign1; receipts follow RFC 9942. https://datatracker.ietf.org/doc/draft-ietf-scitt-architecture/
2. SCRAPI is draft-ietf-scitt-scrapi-11, "RFC Ed Queue", no RFC number yet. https://datatracker.ietf.org/doc/draft-ietf-scitt-scrapi/
3. COSE Receipts is RFC 9942, Proposed Standard, June 2026 (was draft-ietf-cose-merkle-tree-proofs rev 18). https://datatracker.ietf.org/doc/draft-ietf-cose-merkle-tree-proofs/
4. ML-DSA for JOSE and COSE is RFC 9964, Proposed Standard, May 2026. IDs: ML-DSA-44 = -48, -65 = -49, -87 = -50; key type AKP (7). So yes, registered. https://datatracker.ietf.org/doc/draft-ietf-cose-dilithium/
5. RFC 9052/9053 status not fetched: UNVERIFIED (I know them as Standard 96; not checked today).
Mechanism for you: gap (e). A COSE_Sign1 envelope plus an RFC 9942 inclusion/consistency receipt replaces your bespoke receipt without changing your core.
Verdict: ALIGN on encoding, CITE for SCITT service APIs (you are not running a transparency service).

## C. RFC 3161 and OpenTimestamps
1. RFC 3161: Proposed Standard, August 2001, updated by RFC 5816, no obsoleting RFC listed. https://datatracker.ietf.org/doc/rfc3161/
2. OpenTimestamps: four free default calendars (Alice, Bob, Finney, Catallaxy), Bitcoin attestations; the site links no format specification. https://opentimestamps.org/ . The format is defined by the reference code (python-opentimestamps "consensus-critical" core modules); no spec document found. https://github.com/opentimestamps/python-opentimestamps
Mechanism: an upper time bound for a head hash. It proves existence before a time, not completeness, so it does not solve gap (a) alone.
Verdict: CITE. Keep your opaque stamp field; store the raw .ots bytes and the checkpoint hash it covers.

## D. TUF, in-toto, SLSA
1. TUF specification 1.0.37, last modified 8 October 2026. https://theupdateframework.github.io/specification/latest/
2. Rollback: versions must not decrease; root N+1 exactly +1; snapshot cannot drop listed files. Freeze: every role has an expiry checked against a fixed start time. Mix-and-match: timestamp pins the snapshot hash, snapshot pins each targets version. Threshold: each KEYID counts once. Root rotation: new root signed by a threshold of old AND new root keys, clients walk each intermediate root. (same URL)
3. in-toto and SLSA specs not fetched: UNVERIFIED.
Verdict: ALIGN. Copy the rules for your key-change and upgrade events, plus expiry on head checkpoints. This covers part of gap (b) and the freeze half of gap (a).

## E. KERI, DID, VC
1. KERI specification v1.1 (ToIP KSWG, Samuel Smith, editor K. Griffin); publication date not on page: UNVERIFIED. https://trustoverip.github.io/kswg-keri-specification/ . IETF: only an individual draft, expired, last rev 00, 2023-07-27; no WG, no RFC. https://datatracker.ietf.org/doc/draft-ssmith-keri/
2. Pre-rotation: inception commits to digests of next keys plus a threshold; a rotation reveals them, must be signed to that threshold, and commits to the next digests. Witnesses sign receipts of each event; backer threshold M-of-N; duplicity (two signed versions of one event) is provable evidence. (first URL)
3. W3C DID 1.1: Candidate Recommendation Snapshot, 5 March 2026 (may have advanced since). https://www.w3.org/TR/did-1.1/ . DID 1.0 status: UNVERIFIED.
4. W3C VC Data Model 2.0: Recommendation, 15 May 2025. https://www.w3.org/TR/vc-data-model-2.0/
Verdict: ALIGN with pre-rotation only (cheap, fixes the lost-key story). CITE the rest; do not adopt KERI's event syntax or DID/VC.

## F. WebAuthn Level 3
1. W3C Recommendation, 25 August 2026. https://www.w3.org/TR/webauthn-3/
2. The authenticator "signs over the combination of the hash of the serialized client data, and its own authenticator data" (the byte order authenticatorData || SHA-256(clientDataJSON) is standard, but the exact sentence was not on the fetched portion: that ordering is UNVERIFIED here). (same URL)
3. A "Pseudo-random function extension (prf)" exists (§10.1.4); its behaviour text was not fetched: UNVERIFIED. It would let a passkey derive a stable secret, useful for sealing a recovery blob, not for signing.
4. Post-quantum: spec fragments I read list only ES256, ESP256/384/512, EdDSA, RS256, PS256; no ML-DSA seen (rest of text unread). Individual draft draft-vitap-ml-dsa-webauthn-05, 15 Sept 2026, "I-D Exists", IDs only "requested". https://datatracker.ietf.org/doc/draft-vitap-ml-dsa-webauthn/ . Shipping authenticators: a Mozilla bug and a 1Password post say none certified / limited; both seen in search results only: UNVERIFIED.
Verdict: ALIGN. Passkeys sign with ES256/EdDSA today, so a passkey approval is classical-only and must sit beside an ML-DSA key.

## G. Composite signatures
1. RFC 10073, "Composite ML-DSA for Use in X.509 PKI", Proposed Standard, page updated 2026-11-06 (was draft-ietf-lamps-pq-composite-sigs rev 19). Defines id-MLDSA65-Ed25519-SHA512 (OID 1.3.6.1.5.5.7.6.48), SHA-512 pre-hash. https://datatracker.ietf.org/doc/draft-ietf-lamps-pq-composite-sigs/
2. A COSE/JOSE composite profile: UNVERIFIED (not searched). Mechanism: one signature value that verifies only if both components verify, bound by a label, so stripping one half is impossible.
Verdict: ALIGN. Check if your two-signature scheme lets an attacker present only one half.

## H. Capability tokens
- Biscuit 3.x: holder appends blocks of checks, each signed with a fresh key chained to the previous; blocks cannot be removed; later blocks see only authority + own facts, so they cannot widen rights; seal stops attenuation. https://doc.biscuitsec.org/reference/specifications
- UCAN: spec v1.0.0 (editor Zelenka); each delegation "MUST either directly restate or attenuate" its capabilities; checked at execution time. https://github.com/ucan-wg/spec
- Macaroons: NDSS 2014, chained HMACs; enforcement text not on the page fetched: UNVERIFIED. https://research.google/pubs/macaroons-cookies-with-contextual-caveats-for-decentralized-authorization-in-the-cloud/
- ZCAP-LD: spec versions v0.3.0 to v0.4.0 listed; mechanism not fetched: UNVERIFIED. https://w3c-ccg.github.io/zcap-spec/
Verdict: CITE. If you add delegation, copy Biscuit's rule that a later block cannot add facts that widen rights.

## I. Remote attestation
RFC 9334 (RATS architecture) is Informational, January 2023. https://datatracker.ietf.org/doc/rfc9334/ . RFC 9711 is the Entity Attestation Token, Proposed Standard, April 2025. https://datatracker.ietf.org/doc/rfc9711/ . Mechanism for gap (c): an attester produces signed evidence (EAT claims, including a measurement of the running code) and a verifier appraises it against reference values. Wasm-specific attestation of a module digest: I found nothing from a primary source: UNVERIFIED. A module digest would simply be a measurement claim in an EAT. Verdict: CITE; ask hosts for a hardware-rooted EAT that includes the Wasm SHA-256, but the core cannot enforce it.

## J. Agent-specific work
- MCP authorization, spec version 2026-07-28: OAuth 2.1 draft-13, RFC 9728 protected-resource metadata, RFC 8707 resource indicators, RFC 9207, client-ID metadata documents (DCR deprecated); bearer tokens, audience-bound. https://modelcontextprotocol.io/specification/latest/basic/authorization . It authenticates a caller to a server; it does not record or prove actions.
- Individual Internet-Drafts, none adopted by a WG (as read on their pages): draft-nelson-agent-delegation-receipts-15, 21 Oct 2026, user-signed authorization before agent acts, https://datatracker.ietf.org/doc/draft-nelson-agent-delegation-receipts/ ; draft-farley-acta-signed-receipts-04, 21 Nov 2026, signed decision receipts, https://datatracker.ietf.org/doc/draft-farley-acta-signed-receipts/ ; draft-noa-scitt-ai-agent-receipt-01, 15 Aug 2026, one COSE_Sign1 statement per agent action, https://datatracker.ietf.org/doc/draft-noa-scitt-ai-agent-receipt/ . Others named in search only (AIP, draft-klrc-aiagent-auth): UNVERIFIED.
- "Proof of Execution: Runtime Verification for Governed AI Agent Actions", Rhodes and Kang, arXiv 2607.05397, submitted 26 Apr 2026 per the page. Validity predicate with five invariants, soundness proved under stated assumptions, single-node TypeScript prototype. https://arxiv.org/abs/2607.05397
- OpenTelemetry GenAI conventions moved to open-telemetry/semantic-conventions-genai; stability level not stated on pages fetched: UNVERIFIED. https://github.com/open-telemetry/semantic-conventions-genai
Verdict: ALIGN with draft-noa (COSE_Sign1 per act, SCITT-shaped) since it matches your event model; CITE the other drafts; IGNORE MCP auth for the core (an adapter concern; gap (d) is not addressed by any of these).

## K. Verification precedents
- seL4: proofs "from high-level specifications to binary code"; assumptions listed (assembly, boot, hardware, DMA). https://sel4.systems/Verification/
- CompCert 3.18, August 2026, verified C compiler. https://compcert.org/
- CakeML: verified compiler backend to machine code for six architectures, bootstraps itself. https://cakeml.org/
- WasmCert-Coq: Rocq mechanisation of Wasm 2.0, conformance suite in CI, binary parser unverified. https://github.com/WasmCert/WasmCert-Coq . Iris-Wasm (PLDI 2023), program logic for Wasm 1.0 on it. https://github.com/logsem/iriswasm
- Lean 4: "Verifying Compiler-Emitted WebAssembly in Lean" (NeurIPS 2026 workshop poster) proves properties of the compiled module, Lean small-step semantics, passes 99% of conformance records. https://neurips.cc/virtual/2026/171445 . A verified Lean-to-Wasm code generator: none found, UNVERIFIED.
- HACL*/EverCrypt: verified, includes Ed25519; page does not mention ML-DSA. https://hacl-star.github.io/
- ML-DSA: libcrux-ml-dsa 0.0.12 states only field arithmetic, NTT and serialization are verified with hax/F*, not the whole scheme. https://docs.rs/crate/libcrux-ml-dsa/latest . Apple corecrypto and Microsoft SymCrypt (Lean via Aeneas) verification claims: search only, UNVERIFIED. fiat-crypto: not checked, UNVERIFIED.
Verdict: CITE. Your gap is real: the nearest fix is the Lean-in-Wasm work, which proves the compiled module, not a Lean-source-to-Wasm translation. Say plainly that your laws cover the model.

## What I could not verify
- RFC 9162 obsoleted-by; RFC 9052/9053 status; in-toto/SLSA versions.
- Sigstore/Go sumdb current witnessing and the witness count.
- KERI spec date; DID 1.0 status; any COSE composite profile.
- Exact WebAuthn signed-data sentence and PRF behaviour; whether any shipping authenticator signs ML-DSA.
- Wasm-module attestation; macaroons and ZCAP enforcement; OTel GenAI stability level.
- AIP and draft-klrc agent drafts; fiat-crypto; Apple/Microsoft ML-DSA proofs.
- OpenTimestamps format specification (none found).
