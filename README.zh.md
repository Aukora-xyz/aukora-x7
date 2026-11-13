# Aukora

[English](README.md) | 中文

Aukora 正在构建一个由个人拥有的 AI：它能修改自己的软件，同时由一个独立的权威方让拥有它的人掌控敏感操作。这是一个原型，发布时列出了它的缺口。项目之外还没有人记录过一次运行。

**The AI can evolve. The human remains the authority.**

## 最初的 60 秒

- **这个 AI 叫 Auma。** 她运行在所有者的网页浏览器里。她由小型、可替换的部件组成，能够编写、测试并提出这些部件的新版本。
- **她不能自己启用一项敏感改动。** 这件事由另一个程序来做。项目称它为**边缘端**（the edge）：一个小型云服务（一个 Cloudflare Worker），运行在她之外，保存着她的哪个版本正在运行的记录。目前“敏感”包括：对一份固定清单中她的核心部件的任何改动，以及她在 GitHub 上的任何发帖或合并。对普通部件的改动要求更低：见[规则，以及它止于何处](#the-rule-and-where-it-stops)。
- **所有者用 passkey 批准**，即手机和笔记本电脑内置的指纹、面容或安全密钥登录方式。边缘端把每一次批准绑定到一个精确的请求或改动上。一次批准有效五分钟，只能用一次。有一个例外，即夜间授权（night grant），见[规则，以及它止于何处](#the-rule-and-where-it-stops)：一次点按可覆盖对普通部件的改动，最长 12 小时。
- **为什么重要。** 如今大多数 AI 是租来的：谁托管它，谁就决定它能做什么。AI 智能体已开始替人行事，而一个能修改自己软件的智能体，也能修改自己的限制。当提出操作的程序同时决定这个操作是否被允许时，它的限制只是被限制对象内部的设置。Aukora 的规则把两者分开：提议者永远不是许可者。
- **今天什么是真的。** 这条规则的代码和测试都在本仓库中。作者在一台机器上做过一次测试运行，已有记录：5,502 个测试用例，5,399 个通过，90 个失败，这 90 个中有 89 个早已在项目的已知失败清单上。
- **缺少什么。** 除作者外没有人运行过它。没有任何一次由所有者从头到尾批准的完整自我修改被记录为在本仓库上运行过。从本仓库部署到全新账户的云部署是 UNVERIFIED：没有人记录过。有些部分只以编译后的文件提供，不带源码，而且底层的大部分代码继承自另一个项目。完整清单见[没有什么](#what-is-not)。
- **如何参与。** 不需要写代码：阅读[没有什么](#what-is-not)和 [docs/DIRECTION.zh.md](docs/DIRECTION.zh.md)，然后提一个 issue，写下问题，或写下不清楚或不对的地方；发现弱点则通过 [SECURITY.zh.md](SECURITY.zh.md) 报告。如果写代码：运行[自己验证](#verify-it-yourself)下的那一条命令，然后看[如何帮忙](#how-to-help)。读这个仓库的 AI 从 [docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md) 开始。
- **五个标签**说明这些首页上的一项说法被证明到了什么程度：IMPLEMENTED（代码和测试在这棵树里）、RECORDED RUN（见 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)）、INDEPENDENTLY VERIFIED（目前没有任何东西有这个标签）、UNVERIFIED（已声称或已写出，但这里没有测试支持，或没有运行结果显示）、DIRECTION（尚未构建）。较早的页面用别的词；[docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md) 第 5 节给出了对应关系。

## 最初的五分钟

<a id="the-rule-and-where-it-stops"></a>
### 规则，以及它止于何处

提议者永远不是许可者。Auma 提议。边缘端许可，对于受保护的改动，它要的是所有者的 passkey，而不是她的一句话。

**所有者实际批准的是什么。** 一次 passkey 点按就是一次批准。passkey 签名的是一次性的随机挑战，不是改动本身。边缘端记录这次点按针对的是哪个精确的请求，或哪段精确的候选代码，并拒绝其他一切。所有者只能通过发出请求的那个页面看到被批准的内容，所以一个被攻破的页面可能请求所有者没有读过的条款。这棵树里没有独立的显示设备。

**今天它止于何处。** 这条规则针对的是行为失当的智能体或模型回复。它不能防御被攻破的批准页面、边缘端的运营者、被盗的部署凭据或存储回滚。

- **并非每项改动都需要 passkey。** 15 个具名部件受保护，另外任何声明自己属于治理的部件也受保护。这 15 个中有 10 个在她的 26 个起始部件之中（其余五个是 Wasm 单元：小型的密封 WebAssembly 模块），26 个中另有两个声明属于治理。这样 26 个中有 14 个不受保护，其中就有运行她自我构建步骤的那个（`seed-cycle`）。每次可以用一次所有者登录会话（最长 8 小时）替换一个不受保护的部件，不需要点按 passkey。一次 passkey 点按还可以给出一份**夜间授权**（night grant）：在最长 12 小时、最多 12 次使用、每次使用最多 8 个部件的范围内，她独自添加或替换普通部件，不必每次改动都点按。15 个受保护的 id 永远不在覆盖范围内。IMPLEMENTED（[`night-grant.mjs`](deploy/cloudflare/src/night-grant.mjs)、[`night-grant.test.mjs`](deploy/cloudflare/src/__tests__/night-grant.test.mjs)）；没有记录在已部署节点上使用过这种授权。
- **这份清单就是代码。** 受保护清单是边缘端的源码，所以谁能部署边缘端，谁就能改它，而且没有 passkey 把守部署。真实节点上谁持有这份凭据是 UNVERIFIED。
- **存储。** 谁能把边缘端的存储回滚，谁就能让一次已用掉的批准重新生效。树里有一个测试复现了这一点。树里没有修复。
- **她的评分是她自己的。** 候选部件所依据的测试套件是自我声明的，而已部署的边缘端不读取它的结果（[`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) 在生产环境中没有为它提供校验器）。
- **边缘端用 JavaScript 做决定。** 五个属于 Wasm 单元的受保护名称不参与这个决定：边缘端不调用其中任何一个。

**它由哪些文件支撑。** IMPLEMENTED 的意思是代码和它的测试在这棵树里，不是说测试通过。除非某一行另有说明，记录的运行没有列出下列测试文件中的任何失败用例。这只是一个样本；更完整的清单是 [docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md)。

| 说法 | 位置 | 由什么支撑 | 标签 |
| --- | --- | --- | --- |
| 一次批准绑定到一个请求（来源、方法、路径、请求体的 SHA-256）或一个候选（版本 id、版本号、部件、代码哈希）。它不能被重放，不能用在别的字节上，五分钟后不能再用 | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs)、[`owner-grant-policy.mjs`](deploy/cloudflare/src/owner-grant-policy.mjs) | [`convergence-approval-fencing.test.mjs`](deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs)；passkey 数据是手工构造的 | IMPLEMENTED |
| 对版本改动，批准在移动正在运行版本的同一个存储事务里被用掉；已过期的批准会让两者一起回滚。其他已批准的请求在效果执行前一刻由边缘端用掉它 | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`head-hardening.test.mjs`](deploy/cloudflare/src/__tests__/head-hardening.test.mjs) | IMPLEMENTED |
| 这 15 个受保护 id 是一份固定清单，候选上的任何标签都不能降低它 | [`ball-transition.mjs`](server/ball-transition.mjs) | [`convergence-policy.test.mjs`](deploy/cloudflare/src/__tests__/convergence-policy.test.mjs) | IMPLEMENTED |
| 新版本必须把正在运行的版本指为父版本，并且正好高一级，否则会以 `REBASE_REQUIRED` 被拒绝 | [`ball-head.mjs`](server/ball-head.mjs)、[`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`ball-manifest.test.mjs`](server/ball-manifest.test.mjs)、[`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs) | IMPLEMENTED |
| 候选自己的“通过”被忽略：父版本会对它的输出重新评分 | [`scion-growth.ts`](packages/experimental/webworker-runtime/src/x6/scion-growth.ts) | [`scion-growth.spec.ts`](packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts)（另有 1 个用例已知为红） | IMPLEMENTED |
| 在所有者身份文件中，只有经过检查且确实错误的证明才会推动锁定计数器，所以垃圾输入不能把所有者锁在门外 | [`proof-failure-rule.mjs`](deploy/cloudflare/src/proof-failure-rule.mjs) | [`proof-failure-rule.test.mjs`](deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs) | IMPLEMENTED |
| 批准页面根据候选字节重建它的条款，并显示代码差异 | [`head-promotion.ts`](packages/client/ui-layout/src/client/spatial/aumlok/head-promotion.ts)、[`organ-code-diff.ts`](packages/client/ui-layout/src/client/spatial/portal/organ-code-diff.ts) | [`organ-code-diff.client.spec.ts`](packages/client/ui-layout/tests/organ-code-diff.client.spec.ts)，在模拟页面中；没有记录浏览器会话 | IMPLEMENTED |
| **尚未修复。** 有测试复现的缺口：整个存储回滚之后，一次已用掉的批准重新生效，发布会重复；只恢复身份状态同样会让一次已用掉的批准复活 | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs)、[`head-do.mjs`](deploy/cloudflare/src/head-do.mjs) | [`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs)；它只保存复现，树里没有修复 | IMPLEMENTED |
| 她在一个单独的 worker 里编译候选部件；她的自我构建步骤安装它、运行它的用例，然后保留或撤销它 | [`scion.ts`](packages/experimental/webworker-runtime/src/x6/scion.ts)、[`seed-cycle.js`](mirror/home/auma/seed/organs/seed-cycle.js) | 没有测试调用这两者 | UNVERIFIED |
| 本地宿主启动并用第一个版本应答；它的 `/_head/runtime` 应答是错误 `PEARL_QUALIFICATION_UNVERIFIABLE` | [`local-host.mjs`](server/local-host.mjs) | [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md) | RECORDED RUN |

**项目的名称，先说朴素的话。** 她的每一个可替换部件是一个 **organ**。她的一个版本，是每个 organ 连同其代码 SHA-256 哈希的一份清单，称为 **ball**，它的版本号是 **epoch**。边缘端对哪个 ball 正在运行的记录是 **HEAD**，它对她的主目录文件的副本是 **MIRROR**。身份与批准的代码是 **AUMLOK**。构建候选 organ 的编译器是 **scion**。候选所依据的用例套件是 **Pearl**，它由之生长出来的已记录失败是 **scars**。关于 ball、organ 和 epoch，[docs/GLOSSARY.zh.md](docs/GLOSSARY.zh.md) 说得更多；其他名称见 [docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md)。

### 一幅图

```text
        OWNER: a passkey device and a browser tab
          |                              ^
  one passkey tap per approval           | the terms and the code
          v                              | diff, rebuilt from bytes
+------------------------------------------------------------+
| THE EDGE (permits): one Cloudflare Worker and its storage  |
|  checks the passkey; one approval, one request, one use    |
|  HEAD   : which version of her is live (ball id, epoch)    |
|  MIRROR : a copy of her home files, receipts included      |
+------------------------------------------------------------+
    ^                      |                     ^
    | stage a candidate    | the live version    | home sync
    | (HEAD does not move) v (the tab reloads)   |
+------------------------------------------------------------+
| AUMA (proposes): the agent, in the owner's browser         |
|  propose -> compile (U) -> trial, parent grades again      |
|  -> self-build step (U) -> Pearl -> candidate, epoch + 1   |
|  25 Wasm cells, pinned by size and SHA-256, her tools      |
|  model replies reach her only through a door on the edge   |
+------------------------------------------------------------+
```

没有任何一个箭头曾在带有真实 passkey 的已部署节点上被端到端运行过：UNVERIFIED。方框之间的每个箭头都是 IMPLEMENTED。在 Auma 方框内部，标有 (U) 的两个步骤没有测试调用它们，而且没有任何代码把自我构建步骤接到 Pearl（顺序只是如图所画）：UNVERIFIED。模型是这棵树之外的托管服务。把边缘端的决定移入 Wasm 单元是 DIRECTION。逐步说明并为每一步标注标签：[docs/ARCHITECTURE-MAP.zh.md](docs/ARCHITECTURE-MAP.zh.md)。

### 一个例子

1. Auma 为她的 recall organ 提出一个新版本，它是 15 个受保护 id 之一：源文件和测试用例。
2. 她在一个单独的 worker 里编译它。UNVERIFIED：这棵树里没有测试调用编译器。
3. 她在一个一次性的 worker 里试用它，由父版本对输出重新评分，再用 Pearl 运行它，构建一个高一个 epoch 的候选 ball，并把它暂存到边缘端。受保护的 organ 只暂存，不挂载。IMPLEMENTED。Pearl 的结果是自我声明的，边缘端不读取它。
4. 所有者看到根据字节重建的条款和精确的代码差异（在模拟页面中为 IMPLEMENTED；没有记录浏览器会话）。在所有者的 passkey 批准该候选的 ball id、epoch、organ id 和代码哈希之前，HEAD 不会变。这次批准在移动 HEAD 的事务里被用掉。IMPLEMENTED；测试使用手工构造的 passkey 数据，没有记录真实的认证器。
5. 如果候选未通过它的用例，自我构建步骤会撤销或停用它并记录这次拒绝：UNVERIFIED，没有测试调用它。如果批准缺失、已过期、已被用掉或针对别的字节，边缘端拒绝，HEAD 留在原处：IMPLEMENTED。
6. 这些步骤都没有作为一次真实自我修改的一部分而有 RECORDED RUN。记录的运行没有调用模型，没有打开浏览器，也没有使用 passkey。

<a id="verify-it-yourself"></a>
### 自己验证

```sh
git clone https://github.com/Aukora-xyz/aukora-x7.git
cd aukora-x7
node scripts/verify-lite.mjs
# last line, as seen on one machine (Node 24.11.1, nothing installed):
# verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list
```

- **这是什么。** 一次冒烟检查：22 个测试文件，只需要 Node 24.9 或更新版本，不需要别的东西，覆盖 vault、救援包、三个部署门禁、模型门、Pearl 的规则和 Aura 焦点影子。其中三个（memory、predict、receipts policy）带有那 12 个失败。这 12 个全在已知红色清单上，所以命令以 0 退出。UNVERIFIED：它不属于记录的运行。它是另一次小得多的运行，所以不要把 564 和 12 当作项目的状态。
- **它不测试批准规则。** 权限测试要导入 npm 包。在 `pnpm install --frozen-lockfile` 之后（在线安装是 UNVERIFIED：记录的安装是从本地存储离线进行的），运行 `node scripts/verify-lite.mjs --with-packages`（UNVERIFIED 级别，另有 16 个文件），或者对 `deploy/cloudflare/src/__tests__/` 中的 `aumlok-restore-rehearsal.test.mjs`、`convergence-approval-fencing.test.mjs`、`convergence-policy.test.mjs` 和 `proof-failure-rule.test.mjs` 运行 `node --test`。记录的运行没有列出这四个文件中的任何失败用例。
- **完整的记录运行。** [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)：一次运行，一台机器，由作者完成。5,502 个测试用例，5,399 个通过，90 个失败；其余 13 个是 1 个跳过和 12 个标记为 todo。它的日志不随树提供。[docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md)：90 个失败中有 89 个在运行之前就已列出，每个文件附有它的数量。第 90 个是这次运行发现的，现已列出，仍然是红的。

<a id="what-is-not"></a>
### 没有什么

- **有二进制，没有源码。** 25 个 Wasm 单元中的 24 个，以及 Dakini Code 包（一个预构建的自带应用，三个文件），以二进制形式提供，不带源码。这些单元包括以裁判、身份和密钥命名的那几个。从这棵树里无法读取或重建它们，它们的说明写明，转发本仓库的人仅凭它不能履行 AGPL 的源码义务。[`cells/LICENSE.binaries`](apps/web/public/cells/LICENSE.binaries)、[`dakini-code/LICENSE.binaries`](apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries)
- **有一个文件没有许可证。** `pentora36.wasm` 以尚未授予任何许可证的状态提供。[`LICENSE.binaries`](apps/web/public/seed-library/pentora/LICENSE.binaries)
- **回滚缺口。** 恢复一份完整的存储快照，可能让一次已用掉的批准重新生效。树里有一个测试复现了这一点，旁边有十个 todo 用例，写明修复必须证明什么。树里没有修复。
- **没有运行过。** 没有任何端到端、由所有者批准的自我修改被记录为在这棵树上运行过。从这棵树部署到全新账户的云部署是 UNVERIFIED：部署值是占位符，其中一些写在代码里。
- **这棵树的大部分是继承来的。** `packages/` 的大部分是继承来的 DeepSeek Harness 运行时，organ 所建立在其上的插件框架是 Cordis，位于 `vendor/`。按项目自己的一次统计，取自它并不公开的历史，文本行的 10.5% 和代码行的 12.9% 是 Aukora 自己的。UNVERIFIED。[docs/SIZE-AND-ORIGIN.zh.md](docs/SIZE-AND-ORIGIN.zh.md)

没有做过安全审计（[SAFETY.zh.md](SAFETY.zh.md)）。这里没有任何东西是 INDEPENDENTLY VERIFIED。更多缺口，按分量排序：[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md)。项目不作的安全声明：[SECURITY.zh.md](SECURITY.zh.md)。

### 它要去哪里

- DIRECTION：一次由所有者批准的自我修改，从提议到已部署节点上的新 HEAD 全程记录。它的大多数步骤是 IMPLEMENTED，两个没有测试，而这个循环本身从未被记录过。
- DIRECTION：一个节点可以用任何浏览器和多台设备，带有持久的记忆和经过验证的恢复。通过 passkey 添加第二台设备是 IMPLEMENTED（[`passkey-devices.mjs`](deploy/cloudflare/src/passkey-devices.mjs)），救援、归档和恢复也是；回忆和记忆的测试在红色清单上。
- DIRECTION：可替换的模型，以及由别人编写的 organ。今天模型门是源码里的一张固定表，外部 organ 没有作者身份或注册表。
- DIRECTION：她的行动以 Nostr 格式（一种在中继服务器之间传递签名消息的开放格式）的签名记录保存，既作为她自己的日志，也在各自独立拥有的节点之间交换，不由任何中央权威授予身份。今天：一条对她的 HEAD 的签名公告，没有中继（[`nostr-anchor.mjs`](deploy/cloudflare/src/nostr-anchor.mjs)）。
- DIRECTION：更多决定放进 Wasm，除 Cloudflare 之外的宿主，以及之后的语音、可穿戴设备和机器人。细节和顺序：[docs/DIRECTION.zh.md](docs/DIRECTION.zh.md)。

**为什么开放。** 所有者的控制权不应建立在某一家公司、某一个模型提供商或某一位维护者继续在场、继续友善之上。所以，提议者与许可者之间的那条线必须是任何人都能阅读、fork 和替换的东西。今天只有一部分做到了：批准和版本规则是可读的 JavaScript，带有测试，而 25 个 Wasm 单元中的 24 个是密封的二进制，fork 无法重建它们，边缘端运行在一家厂商的平台上。让整条线可检查、可 fork、可替换是 DIRECTION。这棵树公开发布，是为了在公开中走到那一步，不是作为成品。

## 深入了解

```text
OWN LAYER  deploy/cloudflare/src/  the edge: passkey, approvals, HEAD, MIRROR
           deploy/ci/, server/     deploy gates; a local host like the edge
           mirror/                 first version: 26 organs, Pearl, 6 scars
           packages/experimental/webworker-runtime/src/x6/   loader, scion
           packages/client/ui-layout/src/client/spatial/     screens (Spatial)
BINARY     apps/web/public/cells/  25 Wasm cells; 24 have no source here
INHERITED  vendor/ (Cordis); DeepSeek Harness: most of packages/ and docs/
```

| 如果你想要 | 阅读 |
| --- | --- |
| 想法和前方的路 | [docs/DIRECTION.zh.md](docs/DIRECTION.zh.md) |
| 本项目的完整论证 | [docs/WHITEPAPER.md](docs/WHITEPAPER.md)，即白皮书，只有英文。它的 Book V 和 Book VI 已对照这棵树核对过：读了代码，没有运行 |
| 每个机制及其文件、测试和标签 | [docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md)、[docs/ARCHITECTURE-MAP.zh.md](docs/ARCHITECTURE-MAP.zh.md)。较早的文件级说明，用较早的标签用词：[docs/START-HERE.zh.md](docs/START-HERE.zh.md)、[docs/ARCHITECTURE-ACTUAL.zh.md](docs/ARCHITECTURE-ACTUAL.zh.md) |
| 什么未经证明或无法重建 | [SECURITY.zh.md](SECURITY.zh.md)、[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md)、[docs/SIZE-AND-ORIGIN.zh.md](docs/SIZE-AND-ORIGIN.zh.md) |
| 作为读这个仓库的 AI 开始 | 在你总结或修改任何东西之前，先读 [docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md)。除顶部的一个指引外，根目录的 `AGENTS.md` 是继承来的运行时的编码指南：用于 `packages/` 内的工作，不用于本项目的规则 |

<a id="how-to-help"></a>
### 如何帮忙

1. 不写代码：阅读、提问，并指出哪一页不清楚或不对。问题和决定发生在本仓库的 issue 和 pull request 中；不存在其他渠道（[docs/COMMUNITY.zh.md](docs/COMMUNITY.zh.md)）。
2. 安装，运行[自己验证](#verify-it-yourself)下点名的权限测试，并报告你的数量。
3. 在另一台机器上重复记录的运行并发回结果。它会是第一个 INDEPENDENTLY VERIFIED 的项目。再之后的里程碑，是在已部署节点上由所有者批准的一次自我修改，使用真实的 passkey，由作者之外的人记录。
4. 从 [docs/GOOD-FIRST-CONTRIBUTIONS.zh.md](docs/GOOD-FIRST-CONTRIBUTIONS.zh.md) 中选一个红色测试或一个已说明的缺口。规则见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

许可证：[AGPL-3.0-or-later](LICENSE)。上游 DeepSeek Harness 为 MIT（[声明](LICENSES/MIT-DeepSeek-Harness.txt)）；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Aukora 与 DeepSeek 没有隶属关系，也未获其认可。
