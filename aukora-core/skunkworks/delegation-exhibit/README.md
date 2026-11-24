# Delegation evaluation exhibit

This synthetic exhibit evaluates a narrowing chain in plain Node 24, records
each evaluation as one unsigned Core speech frame, and re-checks the result
by replaying the exported record in a fresh Core. From the repo root:

    node skunkworks/delegation-exhibit/test.mjs

A receipt is a recorded evaluation, not an authorization. Anyone who can add
a speech line to the record can add one. Core records the text; it does not
endorse the evaluation. The record adds ordering and parent links: changing
an earlier frame breaks the link to its unchanged successor. Without an
independently retained head, an edited final speech frame or shortened tail can
still replay. The record contains profile IDs, not profile definitions. A
reader needs the exported record and the same exact held profile texts, but
not the original evaluator's state, to re-check evaluations.
Audit counts accepted frames, receipts and agreeing receipts; disagreement
indexes are zero-based accepted frame positions, excluding the two text headers.

Only the chain-validity attribute is modeled. The three bilateral attributes
(graduated self-deprioritization, non-binding preference signalling and opaque
policy tags) are not. Here “established” means the local comparisons and
adjacency checks succeeded, not that any real chain exists or anyone may act.
The authenticated binding between hops that the draft assigns to another
layer is not provided: this exhibit compares values in synthetic data.

Inspired by [section 9 of draft-ahuja-agent-routing-policy-03](https://datatracker.ietf.org/doc/html/draft-ahuja-agent-routing-policy-03#section-9),
not an implementation of the draft; no interoperability is claimed. The
draft supplies no test vectors; its numeric illustration is used in a check.
It names no hash for profile identifiers. This exhibit uses SHA-256 of the
exact UTF-8 profile text and checks that held text matches its identifier.
The equality check across hops uses the exact represented string or number.
