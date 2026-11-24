# Architecture

**SOURCE:** X7 is a source export for a personal AI node. The browser hosts the agent and presents proposed changes. The edge checks requests and keeps the selected code state and acknowledged data.

## Who can change what?

- **SOURCE · Agent:** A proposal is a candidate, not permission to select it. The candidate manifest names the modules; staging it does not change the selected program.
- **SOURCE · Owner:** The identity layer checks the enrolled passkey. Signing in is not approval for every protected action. When the path requires separate approval, the challenge binds the exact terms. For a protected content-addressed replacement, those terms identify the candidate, the changed entry, and its content digest.
- **SOURCE · Edge:** HEAD checks the candidate and the applicable authorization. On the protected replacement path, consuming the approval and selecting the candidate occur in the same storage transaction. Certain ordinary changes can use a bounded, previously authorized grant; it does not cover protected changes.
- **SOURCE · Repository and deployment:** A proposal branch, a repository merge, HEAD selection and deployment are separate. A proposal-card merge has its own approval. Direct publication and head sync follow separate rules. A passing check is evidence, not authorization; a merge or a selected HEAD does not itself establish a deployment.

## Where to read

**SOURCE:** In the source tree, start with `deploy/cloudflare/src/worker.mjs` for routing, `deploy/cloudflare/src/aumlok.mjs` for identity and approval, `deploy/cloudflare/src/head-do.mjs` for selection, and `deploy/cloudflare/src/cloud-brokers.mjs` for repository proposals. See the [README](../README.md) and [Start here](START-HERE.md) for orientation.

**UNVERIFIED:** This source reading does not establish a live deployment, a fresh end-to-end passkey ceremony, or independently verified recovery. The approval page, edge and current storage are trusted for these controls.
