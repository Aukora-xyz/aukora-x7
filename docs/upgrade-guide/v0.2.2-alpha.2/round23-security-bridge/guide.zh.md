---
kind: upgrade-guide
description: "Round 23 更改托管密文包装、Class 3 批准有效期、治理发布和检查点签名者准入。"
---
# Round 23 安全桥接

[English](guide.md) | 中文

## 变更

SOURCE：宿主运维人员和检查点生成方必须保留现有托管状态，同时采用从批准时刻起算的五分钟批准、由宿主分类的治理转换，以及独立配置的签名者区间。这些源码变更不能证明已部署或已满足生产条件。

## 迁移

1. 保留现有 AUMLOK 状态和 pepper。[托管实现](../../../../deploy/cloudflare/src/aumlok.mjs) 使用 HKDF-SHA256 和 AES-GCM 写入 `aukora.aumlok.escrow.v3`；现有 HMAC 包装的 v2 托管密文仍可读取，状态查询不会触发重写。旧版 v1 仍需显式迁移；绝不能通过重置来重新登记。pepper 与密文仍存放于同一状态中：完整状态外泄仍会使离线攻击成为可能。
2. 配置独立的 `OWNER_PUBLIC_KEY_HEX` 和审批精确意图的 `authorizeEnrollment`。登记要求经过验证的 Owner Access、注册、断言、节点密钥持有证明、未绑定状态和零次登记。审计记录与绑定原子提交。拒绝重复登记，以及与所有者授权密钥或 Ed25519 WebAuthn 凭据相同的节点密钥。仅有 Access 不足以登记；生产环境尚未安装登记审批器。
3. 将 `x-x6-class3-approval` 与变更请求正文分开发送。新批准在 `approvedAt + 300000` 到期，不受 120 秒挑战有效期限制。轮换响应不确定时，检查 `rotationSeq` 和不透明的 `keyCommitmentId`。`approvedGrants` 和公开 ID 只是元数据，绝不是授权。绝不能通过 WorkerTunnel 传递持有即授权的令牌：同一执行域中的器官能够观察该共享通道。
4. [Cloudflare 发布](../../../../deploy/cloudflare/src/head-do.mjs) 独立将受保护器官的 `specifier`、`disabled` 或 `config` 变更，以及器官移除，归类为 Class 3。保留 `scope.organ` 和 `scope.candidateSha256`；批准绑定受众、`head.promote`、候选 ball、epoch、器官和哈希。宿主验证不消耗批准；浏览器直接向 Cloudflare 发布时，将批准的单次消耗与 HEAD 选择原子提交，并重新检查有效期。仍拒绝多个受保护条目的变更。不支持运行时持有即授权的令牌交接；`seed-superagent` 确认需要另行安装可信提供方。本地受保护发布仍拒绝 Class 3；原子化本地晋升和生产环境 Pearl 验证仍不可用。此检出缺少 `mirror/home/auma/seed/candidates/seed-pearl.js`；下一个纪元的晋升尚未准备就绪。
5. 独立于镜像文件配置有限的 `CHECKPOINT_SIGNER_POLICY` 区间，或有限的 `CHECKPOINT_SIGNER_PIN.validToCheckpoint`。[验证实现](../../../../server/verified-facts.mjs) 要求每个 v2 条目携带即将退出的密钥对 `aukora.checkpoint-signer-bridge.v2\0` 加规范化条目字段的联署签名，字段不包含联署签名本身。绝不能信任简报中拼写错误的密钥或自行提供的固定信任密钥。[检查点生成方](../../../../mirror/home/auma/seed/organs/seed-receipts.js) 从检查点 15 起要求经过身份验证的宿主策略、匹配的有限 v1 区间和现有签名身份。混合签名切换在混合签名器可用前保持拒绝；切换后绝不恢复 v1。未迁移真实密钥、固定信任密钥或状态。
6. 公共 HTTPS 抓取仍默认返回 `PUBLIC_NETWORK_GUARD_UNAVAILABLE`。[Node 辅助模块](../../../../server/public-https-transport.mjs) 仅支持 IPv4，拒绝任何非公网 DNS 应答，在保留原始 TLS 主机名的同时固定选中地址，拒绝重定向，并将请求限制为十秒和 256 KiB。两个宿主均未安装此模块。激活前，验证登记、批准重放与竞态，以及签名者切换行为。[离线约定检查](../../../../server/verify-contracts.test.mjs) 仍有未解决的 TODO，并未全部闭环。

UNVERIFIED：未更改生产设置、部署、线上数据，也未执行纪元晋升。
