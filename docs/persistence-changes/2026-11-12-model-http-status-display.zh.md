---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-12-model-http-status-display

[English](2026-11-12-model-http-status-display.md) | 中文

## 概述

为模型失败新增可选的数字展示字段 httpStatus，使非 JSON 模型错误显示为纯文本状态单行，而不保留原始响应体。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

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
## 兼容性

已有记录省略 httpStatus，保留失败分类和普通展示方式。旧读取方忽略新增的可选字段，仍收到安全的 HTTP 状态消息、code 和状态。新读取方校验该字段，仅在读取投影中清理旧 HTML 文档，不修改已存事件。此字段不改变重试决策或授权。

<a id="verification"></a>
## 验证

提供方、规范化和 Chat 的定向测试：614 个通过。真实 agent loop 的 Session 记录测试：2 个通过；一次提供方调用，尝试与轮次失败均已清理，未持久化 HTML 或响应体。精确英文展示只有纯文本节点。线上、浏览器和构建产物检查未在此记录。

<a id="dev-note"></a>
## 开发备注

无。
