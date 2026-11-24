# Security

Please use this repository's GitHub **Security → Report a vulnerability** form for suspected vulnerabilities. Do not open a public issue containing a possible vulnerability, real record, credential, or owner information.

## In scope

The public Core model and compiled engines, their record parsers, the standalone tools, and the source-build and artifact verification tooling in this repository. For an experimental folder, identify the exact version. Deployment and Auma app issues belong with the relevant app repository, not this lab release.

A useful report includes the exact commit, platform, command, affected artifact digest, expected result, observed result, and whether the issue is limited to the model, compiled code, verifier, or host. Use synthetic data and lab keys; do not test live systems without explicit permission.

## Known limits

- v0.8 accepts two old forms that do not bind to a record: the old one-time approval and the old key change. Cross-record acceptance and use was observed for the approval. Experimental v0.10 refuses the two decoded forms in tested bound records; this is not a fix for old-start records or all ways to produce an effect.
- v0.8 has a known long-history trap risk; the prior measurement was on an older build and is not a safe capacity limit.
- Core does not govern a deployed effect or prove that the host supplied a complete record. See [NOT-PROVED](v0.8/NOT-PROVED.md).

If you find a different impact, an affected version not documented here, or a vulnerability in how these limits are handled, please report it privately.
