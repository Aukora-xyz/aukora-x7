# Contributing

Start with [the README](README.md) and [the repository map](docs/WHERE-THINGS-ARE.md). This repository separates the v0.8 release from newer experiments, earlier research builds and historical build inputs.

Use Node.js 24. From the checkout, run:

```sh
node examples/read-record.mjs examples/sample-record.txt
node standalone/test.mjs
sh run-all.sh
```

Compare the sample head with RELEASE.json. Python 3 is needed for the optional backup check; the runner reports a skip if Python is missing. It uses a temporary directory for that check. Source rebuilds are separate and target Apple-silicon macOS; Linux CI runs smoke checks on the supplied artifacts.

A useful issue or PR includes:

1. Exact revision, path, OS, tool versions and artifact digest if applicable.
2. Expected and observed behavior, the shortest safe command to check it, and whether you ran it.
3. For a change, a passing case and a refusal or error case; for a proof claim, the exact proposition and assumptions. Say which parts remain untested.
4. No real credentials, private conversations or user records. Use public samples and throw-away lab data. Use [private reporting](SECURITY.md) for suspected vulnerabilities.

Keep diffs small. Do not move historical build inputs or change pinned artifacts without a documented rebuild and updated evidence. New contributions are under this project's AGPL-3.0-or-later terms; do not copy third-party material without verified permission and the required notices.
