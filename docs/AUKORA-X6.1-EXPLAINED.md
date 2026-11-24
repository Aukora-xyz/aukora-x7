# Aukora X6.1 in the browser

*A plain-language and technical briefing, written for an audio walkthrough.*

---

## Overview

The browser runs the agent loop and spatial interface. The agent can propose changes to its modules. The edge checks owner approval before selecting a protected replacement.

## The hook: the Bitcoin lesson

When Bitcoin appeared in 2009, none of its parts were new:
- public-key cryptography was decades old,
- hash chains and proof-of-work already existed,
- peer-to-peer networks were already running.

What was new was the combination. Arranged in one specific way, those old parts produced something that had never existed: money that no bank owns.

Aukora combines these components:
- browser web workers,
- agent runtimes,
- plugin systems,
- durable cloud objects,
- content-addressed code,
- event-log memory,
- WebAssembly sandboxes.

The browser loads the agent runtime from a web page. A content-addressed ball identifies the modules proposed for its next head.

---

## Where the node runs

The browser runs the interface and agent worker. The edge coordinates tabs, checks approvals and relays requests to model providers.

---

## The architecture, from easy to technical

### 1. The brain: a real agent runtime in the browser
X6 runs DeepSeek's experimental web-worker agent runtime, the same agent harness used for serious coding agents, compiled to run inside a browser tab.
- The "thinking loop" (plan, call tools, observe, continue) runs on your machine, in a background worker thread.
- It's built on a plugin system called Cordis. Every capability is a plugin that can be loaded, swapped or removed while the system runs.

The worker runs the loop locally. Model inference for a call through a provider door runs at the provider.

### 2. The face: a spatial interface
The interface is the full Spatial app: a spatial, layered workspace instead of a flat chat box. The brain runs underneath and the face sits on top.

**Easy version:** a cockpit for your mind, not a text message thread.

### 3. The door: keys never touch the page
Model providers such as DeepSeek are reached through a "door," a small server-side relay that holds the API key. The page never sees the secret.

**Easy version:** your AI can use powerful models without leaking your keys to every website and script.

### 4. The heartbeat: one coordinator, many tabs
A cloud coordinator (a Cloudflare Durable Object) keeps a short list of facts:
- the epoch, the sequence number and the active session,
- which tab currently holds the "lease" to act.

The coordinator uses request IDs and a lease to coordinate model calls across tabs.

### 5. The self-change loop: balls, fences and undo
This is the heart of it. Aukora can change its own code while running:
- A ball identifies the modules to load by their content digests.
- Loading a ball goes through fence, drain, dispose, start and commit. The old version drains before disposal. The new version starts before commit.
- The runtime attempts to restore the previous plugin if activation fails. `self_undo` handles supported edits, and `head_rollback` can restore a previous head or organ.

### 6. Memory: an event history, not a scrapbook
Memory is planned as an event DAG: an append-only graph of what happened and why, with anchored facts that survive closing the tab and starting fresh sessions.

**Easy version:** it doesn't just remember what you said; it remembers how it came to be who it is.

### 7. WebAssembly cells

The browser host admits pinned WebAssembly modules, checks their imports and memory bounds, and runs them with a fuel budget. The design groups multiple cells under one head.

---

## What X6.1 adds

The design goal is for the agent to take part in improving its own modules. Changes should be fenced, recorded, reversible and subject to owner control.

---

## How the pieces work together

1. The spatial interface and agent loop run in the browser.
2. A lease coordinates tabs, and request IDs distinguish model calls.
3. A plugin can add a capability without retraining the model.

## What this source establishes

The tree contains the browser worker, spatial interface, model relay, session persistence, multi-tab coordination, module replacement, rollback and Wasm cell host. Source inspection does not establish a successful deployment, a live self-edit or undo, or long-term recall across fresh sessions.
