---
kind: upgrade-guide
description: "所有者授权及自构建消费方必须处理独立批准、有界保留、不完整的 Aura 证据及分开的预测评分尺度。"
---
# Round 19 自构建准入

[English](guide.md) | 中文

## 变更

本地 `POST /_host/owner-grant` 默认返回 `OWNER_APPROVAL_REQUIRED`；浏览器请求头不是同意。独立认证的提供方必须批准精确的规范化条款及其带域前缀的哈希；签发器检查当前 `ballId`、`epoch` 和有效期。范围路径不能授予批准权限，也不能允许重新绑定 HEAD。

授权签发拒绝 null、空、仅含工具、通配符及任意路径范围，包括此前接受的非自构建请求。治理目标 `seed-receipts`、`seed-superagent`、`seed-pearl` 和 `seed-aura` 要求恰好一个目标、非 null 的 `ticketId`、取有限未来值的 `expiresAt` 以及由 64 个小写十六进制字符组成的 `scope.candidateSha256`。签名字段和提升消费方保持不变；消费方必须保留并强制检查候选绑定。旧授权不会被撤销。

资产捕获可删除较旧且未固定的运行时闭包。它保留当前选中的版本、运行时 HEAD 历史引用且仍在缓存中的每个版本、显式固定的版本、传入版本及最新五个版本。受保护的历史仍可能耗尽预算。打开的候选标签页没有保留租约。

Aura 将 DAG、收据或 organ 的零分母视为不完整，不再用一代替，同时保留独立验证的计数。负零数值输入属于无效数据，而非状态正常的证据。

`seed-predict` 将 `receipt_error` 和 `surpriseScore` 报告为相对误差：`abs(observed - expected) / max(abs(expected), 1)`。原有的 0–100 启发式评分改称 `legacyPenaltyV0`。校准要求已验证的 register→promotion→observe 收据序列；存在歧义的重复收据或冲突收据仍未锚定。两种评分均不衡量任务完成度。

Pearl 的父运行器使用通过/失败及全部接受/全部拒绝的比较器对照来比较输出。提供的资格 ID 只能使用一次，绑定运行时、条目、源代码、HEAD 和套件，不授予所有者同意。具名 organ 源文件水合保留编辑及来源历史未知的文件。

[离线检查运行器](../../../../server/gate-audit.mjs)以宿主权限执行已提交的测试，不使用操作系统沙箱。验证要求准入签名通过独立固定的运行器密钥验证，并且运行器、源代码和套件摘要匹配。发布源代码不等于部署或激活。

## 迁移

1. 处理授权拒绝。使用 `organs` ID，或 `/dsh/home/auma/seed/organs/` 或 `mirror/home/auma/seed/organs/` 下精确的 `.js` `paths`。在依赖签名前，通过[所有者处理器](../../../../server/owner-grant.mjs)集成可信的 `approveOwnerGrant`。使用隔离的临时密钥，确认缺少批准、绑定被修改和 HEAD 已移动的情况均被拒绝。
2. 使用不含 `sub`/`iat` 的所有者 JWT。经所有者批准，上限和默认值从 12 小时扩大到 24 小时，增加了[被盗 bearer token 的可利用时长](../../../../deploy/cloudflare/README.zh.md)。可选的[签发工具](../../../../server/mint-owner-jwt.mjs)接受 1–24 小时，并要求 `~/.aukora-x6-vault/owner-ed25519.json` 已存在私有 JSON 密钥；它既不会配置密钥，也不会迁移密钥。签发凭据需要另行授权。
3. 使用[缓存的 `pinRelease`](../../../../server/asset-cache.mjs)保留标签页或回滚所需的较旧候选。处理 `ASSET_CACHE_BUDGET_EXHAUSTED`；清理不能删除受保护的历史。部署前使用临时缓存 fixture（测试前置数据）验证保留行为。
4. 读取[预测 `trajectory_export`](../../../../mirror/home/auma/seed/organs/seed-predict.js)：当 `calibrationStatus` 为 `receipt-anchored` 时使用 `receipt_error`，并单独显示 `legacyPenaltyV0`。不要重新标注历史 `surpriseScore`，也不要重写日志。在不编造评分或计数的前提下，验证未锚定收据及负零、零分母 [Aura 输入](../../../../server/aura-rules.mjs)。
5. 将更新后的 `seed-pearl.js` 与提供 `ctx.scion.trialRetentionCandidate` 的[运行时](../../../../packages/experimental/webworker-runtime/src/x6/ball-loader.ts)配套使用；旧运行时返回 `PEARL_TRIAL_UNAVAILABLE`。候选或套件变更后重新试验。提供的 `qualificationId` 必须保持精确绑定。确认已编辑的具名源文件在水合后保留。现有原始提升路径不受此保证约束；路径证据既不保证执行隔离，也不保证生产覆盖。
