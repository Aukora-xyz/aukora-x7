---
kind: upgrade-guide
description: "器官读取接受有界的 256 KiB 文件，回执连续性与不可用的签名者策略保持区分。"
---
# 器官读取与检查点连续性

[English](guide.md) | 中文

## 变更

body-map 的 NORTH-STAR 探测和 Cloudflare 允许路径的仓库读取现在接受最大 256 KiB 的文件，而非 64 KiB。编码后的读取响应具有单独的有界额度；发布、通用 broker 和私有路径限制保持不变。

在检查点 14 之后，经过身份验证的 checkpoint-policy 读取器不可用时，回执验证和普通追加仍可继续。哈希、签名、签名者检查、前缀链接和 Merkle 根仍须验证。验证成功时报告 `signerStatus: 'unanchored'`、`signerAnchored: false` 和 `checkpointPolicyError: 'CHECKPOINT_SIGNER_POLICY_UNAVAILABLE'`；这表示链的一致性，而非独立身份或所有者同意。追加不会扩大已签名的检查点前缀。

Pearl 的定向挑战要求测试用例声明独立作者；候选项的 UTF-8 字节数比当前基准增长超过 10% 时，须提供去除首尾空白后至少 24 个字符的说明。这些声明不能认证作者身份。试验读取使用提供的 VFS，读取失败后不回退。输入变化、限制性权限上限，以及无效或不受支持的授权文件都会导致资格被拒绝。目前没有持续授权验证器：`standingGrantEligible` 保持为 false，`qualificationId` 保持为 null。缺少授权文件时，受保护候选项可以等待主机 passkey 审核；`passkeyPromotionEligible` 不表示批准，`authorityVerified` 保持为 false。直接的运行时准入保持不变；这些封装检查并非无法绕过的隔离边界。结论区分候选项获胜（`retention-passes`）、基准获胜（`baseline-retained`），以及已有观测的平局或比较不完整（`inconclusive`）；标签不授予权限。

当任一试验分支缺失、报告 `total` 或 `totalCases` 为零、缺少非空结果数组，或评分器控制检查未通过时，Pearl 现在返回 `PEARL_ARENA_UNAVAILABLE`，不生成结论或回执。`unavailableArms` 标明受影响的分支；`trialErrors` 仅提供已知代码或 `TRIAL_ERROR_REDACTED`。已有观测的零通过结果仍为数值结果；非空但格式错误的结果行仍返回 `PEARL_COMPARISON_INCOMPLETE`。

## 迁移

1. 将解码后的仓库文件保持在 `256 * 1024` 字节以内，并保留现有路径准入。更大的文件仍被拒绝；此变更不会开放私有文件读取或更大的发布。
2. 将 `checkpointPolicyError` 与回执完整性分开处理。策略中断期间保留回执；不要将未锚定结果视为已验证记忆、所有者授权或提升头部的权限。
3. 请求检查点 15 或更高序号之前，恢复经过身份验证的策略读取器。缺少策略时仍拒绝创建检查点；格式错误、过期、不匹配和不受支持的混合策略仍被拒绝。此变更不会创建生产签名者或策略。
4. 提供与每个保留的目标用例 `author` 不同的 `candidateAuthor`，并在增长超过 10% 时提供 `sizeGrowthJustification`。历史用例若没有作者声明，现在会拒绝定向挑战；应取得经审核的用例元数据，而不是编造作者或自动修改运行中的测试套件。缺少授权文件不表示允许无人值守变更。提升之前，主机必须单独验证所有者批准。将 `baseline-retained` 视为基准获胜，而非候选项具备资格；保留历史回执。将 `PEARL_ARENA_UNAVAILABLE` 视为证据不可用，绝不能视为数值平局。
5. 部署前验证有界读取、超大文件拒绝、未锚定追加连续性、损坏链拒绝和策略不可用时的检查点拒绝。源码测试不能确定运行中的浏览器已加载哪些代码。
