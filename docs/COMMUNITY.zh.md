# 社区

[English](COMMUNITY.md) | 中文

## 适合谁

Aukora 面向这样的人：想要一个自己拥有、而不是租用的 AI，并且希望这个 AI 能修改自己的软件，却永远得不到凌驾于自己之上的权利。本仓库里的 AI 叫 Auma。她由小型、可替换的模块组成，这些模块称为 organ，她可以编写、编译、测试并暂存它们。另有一个独立的程序（目前是名为边缘端的 Cloudflare Worker）在敏感修改生效之前核对所有者的 passkey。

这里欢迎三类读者，每一页都尽量同时照顾到三类人：

- **普通人**：想了解为什么拥有一个 AI 很重要，以及它将来可能变成什么样。
- **工程师或安全研究者**：想看真实的机制、哪些尚未证明，以及哪里需要帮助。
- **读取本仓库的 AI**：应当从 [AI-START-HERE.zh.md](AI-START-HERE.zh.md) 开始，这样它给出的建议和贡献才会顺着项目的规则走，而不是与之相反。

本页使用的标签：IMPLEMENTED（代码和测试在这棵树里）、RECORDED RUN（见 [RUN-RECORD.zh.md](RUN-RECORD.zh.md)，一次属于较早的一棵树的运行）、INDEPENDENTLY VERIFIED（目前没有任何东西带这个标签）、UNVERIFIED（有人声称或写出来了，但这里没有测试守住它，或没有运行记录显示它）、DIRECTION（尚未构建）。

## 目前的治理方式

- **维护者**审查并合并修改。这棵树没有写出他们是谁，版权持有人也尚未署名（[OPEN-SOURCE-READINESS.zh.md](OPEN-SOURCE-READINESS.zh.md)，第 4 项）。
- **决定公开作出**，在本仓库的 issue 和 pull request 中。不存在其他渠道：没有声称有聊天服务器、论坛、邮件列表或会议。
- **安全缺陷**按 [SECURITY.zh.md](../SECURITY.zh.md) 的说明私下报告。
- **项目遵守自己的规则。** pull request 是一份提议；维护者的审查就是批准，针对被审查的那个确切提交。修改权限文件需要第二位审查者。完整规则在 [CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)。
- **AI agent 可以参与**，适用同样的规则。agent 提出的 pull request 和其他 pull request 一样是提议，由维护者批准。

## 你能发挥最大作用的地方

下面每个领域在树里都有真实的代码，也都有真实的缺口。每一行都写明了从哪里入手。

### 安全研究者

- **权限边界。** 对确切字节的批准只用一次（`deploy/cloudflare/src/aumlok.mjs`、`deploy/cloudflare/src/head-do.mjs`），什么算失败的证明的规则（`deploy/cloudflare/src/proof-failure-rule.mjs`），以及哪些修改需要 passkey（`server/ball-transition.mjs`）。IMPLEMENTED。待解决：passkey 签的是一个随机挑战，所有者只能通过提出请求的那个页面看到条款（`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`）。
- **恢复、重放与回滚。** `deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs` 复现了：恢复一整份存储的快照可能让一次已用掉的批准重新生效。旁边有十个 todo 用例（九个已点名的缺口和一个正向恢复用例）。树里没有修复。
- **密钥处理。** 设备登记（`deploy/cloudflare/src/passkey-devices.mjs`）、七个词（所有者的恢复短语）和密封根（由该短语与 passkey 共同释放的加密密钥）（`packages/client/ui-layout/src/client/spatial/aumlok/aumlok-ceremony.ts`、`aumlok-root.ts`），以及目前还是合成的检查点签名密钥（`mirror/home/auma/seed/organs/seed-receipts.js`）。
- 未作出的声明的完整清单见 [SECURITY.zh.md](../SECURITY.zh.md)。

### Rust 和 Wasm 工程师

- **cell 的源码与可复现构建。** `apps/web/public/cells/` 中 25 个 Wasm cell（小型、密封的 WebAssembly 模块）里有 24 个不附源码发布，树里也没有 `Cargo.toml`。把它们重新构建到固定哈希，是 [OPEN-SOURCE-READINESS.zh.md](OPEN-SOURCE-READINESS.zh.md) 的第一项。只有版权持有人才能发布那份源码。
- **受限执行。** cell 加载器按大小、哈希和内存上限接纳一个 cell，要求零导入，对每次调用计量，并在 5 秒后结束它的 worker（`packages/experimental/webworker-runtime/src/x6/wasm-cells.ts`；测试 `wasm-cells.spec.ts`）。IMPLEMENTED。待解决：边缘端的决策是 JavaScript，`deploy/` 下没有任何东西调用裁判 cell 和身份 cell。把决策移入 Wasm 是 DIRECTION。

### agent 工程师

- **自我修改。** 各个部件已经写出。在一次性 worker 中试运行候选 organ，并在父级重新给它的输出评分（`packages/experimental/webworker-runtime/src/x6/scion-growth.ts`；测试 `scion-growth.spec.ts`），以及为所有者暂存它（`ball-loader.ts`；测试 `stage-organ-promotion.spec.ts`），都是 IMPLEMENTED。在单独的 worker 中编译它（`scion.ts`），以及安装并测试它（`mirror/home/auma/seed/organs/seed-cycle.js`），没有任何测试调用它们：UNVERIFIED。为这两处写测试是待做的工作，而且没有任何一次经所有者批准的端到端自我修改被记录为从这棵树运行过。
- **独立评分。** Pearl 是候选 organ 所要通过的留存测试套件（`mirror/home/auma/seed/organs/seed-pearl.js`），它是自我声明的：其收据写的是 `authorityVerified: false`，它的试验 worker 也不是经过证明的隔离。
- **模型可移植性。** 为六家供应商开的七扇同源门（`packages/experimental/webworker-runtime/src/model-doors.ts`；测试 `model-doors.spec.ts`）。作为源码中的固定清单是 IMPLEMENTED。没有任何模型调用被记录，也没有给本地模型开的门。

### 分布式系统工程师

- **状态连续性。** 她的 home 保存在浏览器里，并以有序更新发送到边缘端的副本，称为 MIRROR（`packages/experimental/webworker-runtime/src/storage/idb-persist.ts`、`deploy/cloudflare/src/mirror-do.mjs`；测试 `server/mirror-replay.test.mjs`）。IMPLEMENTED。记忆版本的历史没有实现：边缘端的回答是 `MEMORY_HISTORY_NOT_IMPLEMENTED`。
- **签名事件与 Nostr。** 一条对当前 head 的签名公告，文件自己说明它不是 relay（`deploy/cloudflare/src/nostr-anchor.mjs`；测试 `nostr-anchor-door.test.mjs`）。可选签名的本地消息（`deploy/cloudflare/src/messages-store.mjs`）。IMPLEMENTED。relay 客户端、她自己与他人交换的签名事件日志，以及由不同所有者运行的节点彼此对话，都是 DIRECTION：树里没有它们的代码。

### 界面设计者

- **让批准、后果和不确定性一目了然。** 批准卡片从字节重建条款（`packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts`），差异视图显示确切的代码修改（`packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts`），而 Aura，也就是她的连贯性读数，在宿主提供数据之前把每个 cell 都画成 Undetermined（`packages/client/ui-layout/src/client/spatial/aura/model.ts`）。IMPLEMENTED，在 jsdom 中测试，而 jsdom 不做布局。Spatial 是每个界面都遵循的那一套工作区设计，位于 `docs/foundations/SPATIAL-DESIGN-RULES.md`。没有记录任何浏览器会话。

### 文档与翻译

- 较早的页面使用了上面五个之外的成熟度用词（[START-HERE.zh.md](START-HERE.zh.md)、[ARCHITECTURE-ACTUAL.zh.md](ARCHITECTURE-ACTUAL.zh.md)、[RUN-RECORD.zh.md](RUN-RECORD.zh.md)（属于较早的一棵树）、[GLOSSARY.zh.md](GLOSSARY.zh.md)）。把它们统一到同一套用词是有用的工作。
- `.github/` 里的 issue 和 pull request 模板是继承来的，而且是中文的。
- `docs/` 下大多数页面都有中文对页，由 `scripts/verify-translation-pairing.ts` 检查。新页面也有中文对页；对页与英文页不一致时，以英文页为准。对照英文页阅读中文页并报告不一致之处，是有用的工作。

### 研究

- **记忆。** recall 和 memory 两个 organ 已写出（`mirror/home/auma/seed/organs/seed-recall.js`、`seed-memory.js`），它们的测试是红的，原因尚未调查：`server/recall.test.mjs` 中 50 个用例，`server/memory.test.mjs` 中 3 个（[KNOWN-RED-TESTS.zh.md](KNOWN-RED-TESTS.zh.md)）。五个 Kira cell（记忆一侧的 Wasm cell）附带固定的操作，只有一个被测试调用。跨越多年的持久回忆是 DIRECTION。
- **可信的评分。** 如何给一个可能试图伪造自己结果的候选评分。目前，父级忽略 worker 的通过标志，并重新给输出评分；`scion-growth.spec.ts` 植入了伪造的通过。这些是植入的攻击，不是隔离的证明。

## 行为准则

- 写明文件、行和测试，并给每个声明贴上标签；说清你运行了什么、没有运行什么。
- 批评工作，不批评人。
- 公开地、带着理由提出异议，并接受带有理由的决定。
- 不骚扰，不人身攻击，不分享任何人的私人数据。
- 按 [SECURITY.zh.md](../SECURITY.zh.md) 的说明私下报告安全缺陷。
- 维护者可以隐藏违反以上几条的评论。
