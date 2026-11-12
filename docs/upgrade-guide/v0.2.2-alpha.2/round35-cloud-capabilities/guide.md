---
kind: upgrade-guide
description: "Ambiguous provider dispatch now returns terminal HTTP 422 instead of retryable HTTP 503."
---
# Cloud provider unknown-outcome handling

English | [中文](guide.zh.md)

## Change

Cloudflare `/door/*` callers receive HTTP 422 instead of HTTP 503 when an upstream dispatch throws and the provider may have processed the request. The response includes `x-should-retry: false`, `code: PROVIDER_OUTCOME_UNKNOWN`, `outcome: unknown`, `retry: do-not-repeat-automatically` and `error.type: provider_outcome_unknown`. The reserved quota remains spent. The Worker does not retry.

Default LLM clients no longer classify this response as a retryable server failure. Explicit `mode: always` retry policies can still repeat it. This response does not establish that the provider rejected or completed the request, and it provides no deduplication guarantee. The [Cloudflare host reference](../../../../deploy/cloudflare/README.md) owns the bounded repository, owner-approved publication and trusted-document capabilities. Source changes do not activate production credentials or deployments.

## Migration

1. Update custom `/door/*` response handlers to recognize HTTP 422 and the nested `provider_outcome_unknown` error. Preserve the top-level outcome and retry fields when displaying or forwarding the failure.
2. Remove automatic resubmission of unknown outcomes, including any applicable `mode: always` override. Inspect provider-side evidence before deliberately submitting a new request; a missing response does not prove nonexecution.
3. Exercise a synthetic lost-response case with the actual client retry policy. Confirm one upstream dispatch, retained quota and a terminal unknown-outcome report. Verify live model access and the loaded deployment separately with the owner's authorization; synthetic model-ID compatibility checks do not establish either.
