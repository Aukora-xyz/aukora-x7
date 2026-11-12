---
kind: upgrade-guide
description: "AUMLOK 解封必须提供短语承诺值，治理发布则将受保护转换与仅供审核的暂存分离。"
---
# Round 24 托管与治理

[English](guide.md) | 中文

## 变更

解封必须同时具备新鲜 UV 和已验证的短语承诺值，WebAuthn 与短语预算相互独立。可选的外部 pepper 保护新存储。治理涵盖八个固定器官，以及任一 manifest（元数据清单）上的治理声明；暂存不授予任何权限。Worker 直接加载会刷新已更改的模块字节，并拒绝损坏的球路径。

## 迁移

1. 使用 [`aumlokCommitment`](../../../../packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts)，根据当前规范化短语而非替换后的词语，以及已绑定的 `nodePubkeyHex` 派生 `commitmentSha256`。将值为 64 个小写十六进制字符的自有字段与 `challengeId` 和 `credential` 一同放入 `POST /_host/aumlok/unseal` 完成请求，而不是挑战请求。释放加密根前必须具备新鲜 UV，并通过短语预算检查及 `aukora.aumlok.recovery.v2` 验证；成功始终返回 `phraseVerified: true`。UV 和预算检查通过后，承诺值缺失或格式错误返回 `AUMLOK_COMMITMENT_INVALID`；不匹配返回 `AUMLOK_RECOVERY_COMMITMENT_MISMATCH`。绝不发送原始词语。在线限制无法阻止对已获取密文的离线猜测。
2. 保持短语锁定独立。断言成功时仅重置 WebAuthn 失败计数，包括通过最终新鲜度检查后发生已识别短语拒绝的情况。注册、挑战签发、重放和超时失败均不重置任何预算。将 `phraseBlockers` 与 `blockers` 分开展示；短语验证被拒绝不会禁用通行密钥批准。刷新响应不确定时，先比较 `lastRotationChallengeId`、`rotationSeq` 和 `keyCommitmentId`，再重试。
3. 对于经过独立批准、使用外部秘密值的安装，将 32 字节编码为规范 base64url，写入 `AUMLOK_PEPPER_SECRET`。[托管实现](../../../../deploy/cloudflare/src/aumlok.mjs) 初始化 `aukora.aumlok.pepper.v2` 和 `aukora.aumlok.escrow.v4`。已初始化的旧版存储，包括尚未绑定的存储，保留密钥，并在提供秘密值时报告 `pepperMigrationRequired`；不存在自动迁移或迁移 API。采用外部秘密值的新绑定存储报告 `pepperSeparated: true`。秘密值缺失或不匹配时，分别返回 `AUMLOK_PEPPER_SECRET_REQUIRED`/`AUMLOK_PEPPER_SECRET_MISMATCH`（503），即使是状态读取也如此，且不写入状态。恢复原始秘密值。[Round 23](../round23-security-bridge/guide.zh.md) 中关于 v3 和 pepper 与密文共同存储的建议仅适用于旧版模式。
4. 使浏览器分类和批准绑定与[宿主策略](../../../../deploy/cloudflare/src/owner-grant-policy.mjs)一致。新增的固定器官为 `seed-predict`、`seed-recall`、`seed-memory` 和 `auma-body-map`。前一或候选 manifest 的条目或配置中的 `governance` 声明，会使相应变更和移除受到保护；格式错误的声明不能降低保护级别。
5. 使用 [`stage_head_promotion`](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts) 或 `POST /__x6__/stage-head-promotion`，生成 `/dsh/home/auma/staged/head-promotion.json`。工具接收 `{body: envelope}`；HTTP 直接接收该请求封装。完整 UTF-8 内容上限为 4 MiB，发布请求上限为 16 MiB。提供全部模块源码；源码不可用时停止暂存。替换要求匹配 `expectedStagedSha256`。拒绝存在硬链接或并非普通文件的目标。暂存不提供激活、授权、资格或持久保存确认。描述文件不携带租约、持有即授权的批准令牌或资格声明。绝不能通过 WorkerTunnel 传递持有即授权的批准令牌。浏览器在批准后获取新鲜的写入租约，并在发布前重新检查父级。
6. [Worker 模块加载](../../../../packages/experimental/webworker-runtime/README.zh.md#known-limitations-and-deferred-work) 在下次直接加载时重新读取被覆盖的文件，但不重新加载已缓存的导入方。明确逐出或重新加载依赖方。完整球路径现在会以 `Ball integrity check failed` 拒绝不匹配的字节；恢复匹配的字节，或使用内容对应的正确哈希与路径。
7. 激活前验证短语匹配时成功，承诺值缺失、格式错误或不匹配时被拒绝、独立失败计数、旧版可读性、秘密值缺失或错误时被拒绝、陈旧审核被拒绝，以及浏览器与宿主分类一致性。没有独立安装的 Pearl 验证器时，`governancePromotion` 保持 false；暂存字节不能提供该验证器。

生产秘密值、部署和线上状态均未更改。浏览器集成与激活需要分别验证。
