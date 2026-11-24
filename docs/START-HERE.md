# Start here: Aukora X7

Choose what you want to check.

## I have five minutes

Read [the README](../README.md) and [what is built](WHAT-IS-BUILT.md). X7 is a cleaned source export of a personal AI node, not that node itself. For a short, self-contained replay, use the example in [Aukora Core](https://github.com/Aukora-xyz/aukora-core), a separate repo (the whole Core is also in [`aukora-core/`](../aukora-core/) here). It checks what was supplied in a public sample; it does not connect to X7 or enforce an action.

## I want to run this checkout's light checks

Use Node.js 24.9 or newer:

```sh
node scripts/probe.mjs
node scripts/verify-lite.mjs
```

Inspect the probe's JSON. Verify-lite exit 0 means the failure counts fit the file-level allowances, not that every test passed. Include the exact commit, Node version, platform, and full result in any report. See [known failures](KNOWN-RED-TESTS.md) and [historical runs](RUN-RECORD.md). Run code you don't trust inside an isolated environment.

## I want to understand the boundary

[Architecture](ARCHITECTURE-MAP.md) walks through a change; [security](../SECURITY.md) states where trust stops; [size and origin](SIZE-AND-ORIGIN.md) traces the inherited runtime; [Core](CORE.md) separates shipping files from what actually runs. Look for explicit evidence of each claim rather than treating builds, tests, and production as interchangeable. A cloud conversation window is not disaster recovery, the seven words don't replace owner enrollment, and this checkout does not contain the authors' private Auma state.
