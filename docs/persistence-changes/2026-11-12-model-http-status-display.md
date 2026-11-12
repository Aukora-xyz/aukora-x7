---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-12-model-http-status-display

English | [中文](2026-11-12-model-http-status-display.zh.md)

## Summary

Adds the optional numeric httpStatus display field to model failures so non-JSON model errors can render as one plain status line without a raw response body.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

```yaml persistence-change
schemaVersion: 1
id: 2026-11-12-model-http-status-display
baseline: false
changes:
  - root: "event:assistant/attempt"
    previous: "2026-09-16-session-format-v4"
    after: "036c70a4f49c16d31da10596ac35a5f1c3b9abd098a7aca851663df4516b8563"
    decision: same-version
  - root: "event:assistant/message"
    previous: "2026-09-16-session-format-v4"
    after: "ed51074c163b678a38bf9df2da7b3633a2e8bb720493c6bd920ad5c2af078e75"
    decision: same-version
  - root: "event:llm/retry"
    previous: "2026-09-14-image-offload"
    after: "1be4d80d27f3c7ce0667c1c041eeb92d0beebecb508c21b60ec8d8f0a4daa2ec"
    decision: same-version
  - root: "event:turn/end"
    previous: "2026-09-16-session-format-v4"
    after: "a52f1d4e789f9fcf142100557a9362c8997c6470527291b1258606b9e5d9b8a5"
    decision: same-version
```

<a id="compatibility"></a>
## Compatibility

Existing records omit httpStatus and retain their failure classification and ordinary rendering. Older readers ignore the additional optional field and still receive the safe HTTP status message, code and status. New readers validate the field and sanitize legacy HTML documents only in the read projection, without changing stored events. The field does not change retry decisions or authorization.

<a id="verification"></a>
## Verification

Focused provider, normalization and Chat suites: 614 tests passed. Real agent-loop Session recording: 2 tests passed; one provider call, sanitized attempt and turn failure, and no HTML/body persisted. Exact English rendering has a plain text node only. Full live/browser and built-artifact checks are not recorded here.

<a id="dev-note"></a>
## Dev Note

None.
