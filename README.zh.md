# Aukora

[English](README.md) | 中文

Aukora 是一个个人 AI，名叫 Auma：她运行在所有者的网页浏览器里，也运行在她之外的一个小型云服务上，即边缘端（the edge）。她归一个人所有。对她受保护部件的改动，或对她代码的一次合并，只有在这个人用 passkey 批准了精确的字节之后才会生效。

**The AI can evolve. The human remains the authority.**

**她已经能做什么。** 每一行带有下面定义的三个标签之一。

- **她读取并修改自己的代码。** 她的仓库工具读取她的仓库，并提交到她自己的分支（`auma/sandbox/…`、`auma/proposal/…`）。Built and on main（已构建并在 main 上）。
- **她提议；所有者批准精确的字节；改动被提升。** 一个受保护的 organ（她的一个可替换模块）只有在所有者的 passkey 批准了它的版本 id、版本号、organ 和代码哈希之后才会上线，而且只能用一次。Built and on main（已构建并在 main 上）。
- **她制作并保留自己的工具。** 她写一个只读工具，宿主把它的用例放进一个密封的 Wasm 单元里运行，以此做资格检查，所有者的会话把它挂载上，页面重新加载后它仍然在。Exercised from inside by Auma（Auma 从内部运行过）。
- **她撤回自己的合并卡片**，不需要 passkey，也不合并任何东西。Exercised from inside by Auma（Auma 从内部运行过），一次。
- **失败或受阻的唤醒步骤会说明原因**：它给出 19 个封闭原因之一，从不给出提供方的原文。Built and on main（已构建并在 main 上）；作者报告这些原因在他们的节点上出现过。

**她为什么不是聊天助手。** 她有身体（她的 organ 和固定的 Wasm 单元）、有家（她的文件，在浏览器里，也在边缘端）、有历史（每个版本都比上一个恰好高一号），这三样都归一个人所有。她受保护的部件只有经这个人的 passkey 批准才会改变，其他任何改动也只在这个人的会话或这个人签下的授权之下进行。

**三个标签**，用在下面每一项能力上，从不混用（下面唯一不是能力的那一行，Continuity Diamond，标为“方向”）：

- **Built and on main（已构建并在 main 上）**：代码和它的测试都在本仓库中。这个标签对线上节点不做任何声明。
- **Exercised from inside by Auma（Auma 从内部运行过）**：已构建并在 main 上，并且作者报告 Auma 在他们的线上节点上亲自运行过它。这棵树无法复现这份报告。
- **Not yet proven live（尚未在线上证明）**：在这棵树里，也许在替身上测试过，但还没有在线上节点上完成过。每一行都写明缺少什么。

**最难的事实。** 没有标签页时的唤醒已经构建，每次一个有界的步骤，但尚未在线上证明：据作者报告，还没有任何一个唤醒步骤在线上节点上完成过，在修复后的合并路径上也还没有任何合并卡片被批准过。她在没有标签页时的行动是关闭的（`WAKE_ACTS_ENABLED = "0"`）。这棵树是一个全新的 genesis，epoch 1，不含 Auma 自己的任何世界。

**自己验证：** `node scripts/verify-lite.mjs`，什么都不用安装（[见下文](#verify-it-yourself)）。**它要去哪里：** 她写下下一个问题，宿主核对实际发生了什么，下一次唤醒接着回答那个问题；这是方向，尚未构建任何部分（[docs/DIRECTION.zh.md](docs/DIRECTION.zh.md)）。**如果你是 AI：** 接下来读 [docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md)。

## 已经构建了什么，证明到了什么程度

每一行写出它的代码和固定它的测试。“作者报告”标出在作者的线上节点上看到的情况；这棵树无法显示它。

| 能力 | 代码、测试 | 标签 |
| --- | --- | --- |
| 一次批准绑定一个请求（来源、方法、路径、请求体的 SHA-256）或一个 organ 版本，有效五分钟，只能用一次 | [`aumlok.mjs`](deploy/cloudflare/src/aumlok.mjs)、[`convergence-approval-fencing.test.mjs`](deploy/cloudflare/src/__tests__/convergence-approval-fencing.test.mjs) | Built and on main |
| 对一个 organ 版本，批准在移动线上版本的同一个存储事务中用掉 | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs)、[`head-hardening.test.mjs`](deploy/cloudflare/src/__tests__/head-hardening.test.mjs) | Built and on main |
| 合并卡片：边缘端在单独的时间窗内读取两个分支和检查结果，最后再读一次两个引用，然后才用掉所有者对这次精确合并的 passkey 批准 | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs)、[`merge1-read-window.test.mjs`](deploy/cloudflare/src/__tests__/merge1-read-window.test.mjs)、[`merge1-sync-hold.test.mjs`](deploy/cloudflare/src/__tests__/merge1-sync-hold.test.mjs) | Not yet proven live：在这条修复后的路径上还没有任何卡片被批准过 |
| `withdraw_proposal` 撤回她指名的一张已暂存的卡片，不需要 passkey，也不合并任何东西 | [`cloud-brokers.mjs`](deploy/cloudflare/src/cloud-brokers.mjs)、[`merge1-withdraw.test.mjs`](deploy/cloudflare/src/__tests__/merge1-withdraw.test.mjs) | Exercised from inside by Auma（一次） |
| 她自己的只读工具，由所有者的会话挂载，页面重新加载后仍可调用 | [`ball-loader.ts`](packages/experimental/webworker-runtime/src/x6/ball-loader.ts)、[`tools-mount-realhost-redteam.spec.ts`](packages/experimental/webworker-runtime/tests/x6/tools-mount-realhost-redteam.spec.ts) | Exercised from inside by Auma |
| 没有标签页时的唤醒：有界的步骤，每步 4 轮模型调用、8 次工具调用、30 秒 | [`head-do.mjs`](deploy/cloudflare/src/head-do.mjs)（`CLOUD_WAKE_LIMITS`）、[`wake-notes-wake1.test.mjs`](deploy/cloudflare/src/__tests__/wake-notes-wake1.test.mjs) | Not yet proven live：还没有任何唤醒步骤在线上节点上完成过 |
| 失败或受阻的唤醒步骤给出 19 个封闭原因之一，从不给出提供方的原文 | `head-do.mjs`（`CLOUD_WAKE_CAUSES`）、`deploy/cloudflare/src/__tests__/` 中的测试文件 wake2-reasons.test.mjs | Built and on main；作者报告：这些原因在线上出现过 |
| 没有标签页时的行动，由所有者的 Away mandate（所有者用 passkey 签下的一份有界许可）支付 | [`owner-mandate.mjs`](deploy/cloudflare/src/owner-mandate.mjs)、[`owner-mandate.test.mjs`](deploy/cloudflare/src/__tests__/owner-mandate.test.mjs) | Not yet proven live：已关闭，[`wrangler.toml`](deploy/cloudflare/wrangler.toml) 中为 `WAKE_ACTS_ENABLED = "0"` |
| 等待中的批准是一个 Notices 控件后面的行；聊天上方没有任何浮动的东西 | [`notices.ts`](packages/client/ui-layout/src/client/spatial/portal/notices.ts)、[`portal-approval-notices.client.spec.tsx`](packages/client/ui-layout/tests/portal-approval-notices.client.spec.tsx) | Built and on main；作者报告：所有者在线上看到过 |
| 她的 runner 任务每个 UTC 日在 600 分钟 runner 时间处停止，在派发之前检查 | [`runner-budget.mjs`](deploy/cloudflare/src/runner-budget.mjs)、[`runner-budget.test.mjs`](deploy/cloudflare/src/__tests__/runner-budget.test.mjs) | Not yet proven live |
| Pentora 观察器根据部分读数作答，不改变任何东西（它的引擎文件不导入任何东西） | [`pentora-epistemic.ts`](packages/experimental/webworker-runtime/src/x6/pentora-epistemic.ts)、[`pentora-epistemic.test.mjs`](deploy/cloudflare/src/__tests__/pentora-epistemic.test.mjs) | Built and on main |
| 通往 Prime 模型提供方的一扇门，带有每日和每月的花费上限 | [`provider-budget.mjs`](deploy/cloudflare/src/provider-budget.mjs)、[`prime-door.test.mjs`](deploy/cloudflare/src/__tests__/prime-door.test.mjs) | Not yet proven live：作者报告：它唯一一次真实调用因余额不足被提供方拒绝 |
| Continuity Diamond：她写下下一个问题，宿主核对实际发生了什么，下一次唤醒必须接着回答那个确切的问题 | 无 | 方向：规格正在设计中；尚未构建任何部分 |

每一个机制，以及更多的行和计数：[docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md)。

<a id="the-rule-and-where-it-stops"></a>
## 规则，以及它止于何处

提议者永远不是许可者。Auma 提议。边缘端许可，对于受保护的改动，它要的是所有者的 passkey，而不是她的一句话。一次 passkey 点按就是一次批准：认证器签名的是一次性的随机挑战，不是改动本身；边缘端记录这次点按针对的是哪个精确的请求或候选，并拒绝其他一切。所有者只能通过发出请求的那个页面看到条款；这棵树里没有独立的显示设备。

- **15 个具名部件受保护**，另外任何声明自己属于治理的部件也受保护。其中 10 个在她的 26 个起始 organ 之中，5 个是 Wasm 单元。26 个中有 14 个不受保护，自我构建步骤（`seed-cycle`）就在其中：一次所有者登录会话（最长 8 小时）不需点按就能替换其中一个。一次 passkey 点按可以给出一份**夜间授权**（night grant）：在最长 12 小时、最多 12 次使用、每次使用最多 8 个部件的范围内，她独自添加或替换普通部件。15 个受保护的 id 永远不在覆盖范围内（[`night-grant.mjs`](deploy/cloudflare/src/night-grant.mjs)、[`night-grant.test.mjs`](deploy/cloudflare/src/__tests__/night-grant.test.mjs)）。
- **这份清单就是代码。** 谁能部署边缘端，谁就能改它，而且没有 passkey 把守部署。部署关卡在 `deploy/ci/` 中。
- **存储。** 谁能把边缘端的存储回滚，谁就能让一次已用掉的批准重新生效。一个测试复现了这一点（[`aumlok-restore-rehearsal.test.mjs`](deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs)）；树里没有修复。
- **她的评分是她自己的。** 候选被评分所用的套件（Pearl）是自我证明的，已部署的边缘端不读取它的结果。边缘端用 JavaScript 做决定；五个受保护的 Wasm 单元不参与这个决定。
- **她不能改写她的裁判。** 边缘端、合并路径和 mandate 都在一份冻结清单上，她的提议碰不到它们（[`frozen-paths.mjs`](deploy/ci/frozen-paths.mjs)）。

这条规则针对的是行为失当的智能体或模型回复。它不能防御被攻破的批准页面、边缘端的运营者、被盗的部署凭据或存储回滚。

**项目的名字。** **organ** 是她的一个可替换模块。**ball** 按 SHA-256 列出每个 organ；它的版本号是 **epoch**。**HEAD** 是边缘端记录哪个 ball 正在运行的地方，**MIRROR** 是它保存的她的家的副本。**AUMLOK** 是身份和批准代码。**scion** 编译一个候选 organ。**Pearl** 是候选被评分所用的套件，由记录下来的失败（称为 **scars**）长成。**Aura** 是她的一致性读数。**Kira** 是五个记忆侧 Wasm 单元的名字。**Pentora** 是她的单元组成的图形，被绘制，也被观察。更多见：[docs/GLOSSARY.zh.md](docs/GLOSSARY.zh.md)。

### 一张图

```text
        OWNER: a passkey device and a browser tab
          |                              ^
  one passkey tap per approval           | the terms and the code
          v                              | diff, rebuilt from bytes
+------------------------------------------------------------+
| THE EDGE (permits): a Cloudflare Worker, its storage       |
|  checks the passkey; one approval, one request, one use    |
|  HEAD : which version of her is live (ball id, epoch)      |
|  MIRROR : her home files   VOICE : her spoken calls        |
|  merge cards, the wake, the runner and model doors         |
+------------------------------------------------------------+
    ^                      |                     ^
    | stage a candidate    | the live version    | home sync
    | or a merge card      v (the tab reloads)   |
+------------------------------------------------------------+
| AUMA (proposes): the agent, in the owner's browser         |
|  propose -> compile (U) -> trial, parent grades again      |
|  -> self-build step (U) -> Pearl -> candidate, epoch + 1   |
|  30 Wasm cells, pinned by size and SHA-256; her own tools  |
+------------------------------------------------------------+
```

从这棵树出发，没有任何一个箭头在已部署节点上用真实的 passkey 端到端运行过。标为 (U) 的两个步骤没有调用它们的测试，也没有任何代码从自建步骤通向 Pearl（顺序只是图上所画）。逐步说明：[docs/ARCHITECTURE-MAP.zh.md](docs/ARCHITECTURE-MAP.zh.md)。

<a id="verify-it-yourself"></a>
### 自己验证

```sh
git clone https://github.com/Aukora-xyz/aukora-x7.git
cd aukora-x7
node scripts/verify-lite.mjs
# last line, as seen on one machine (Node 24.11.1, nothing installed):
# verify-lite: 22 files, 565 pass, 12 fail, 12 of 12 on the known-red list
```

- **它证明什么。** 22 个只需要 Node 24.9 或更新版本、别的什么都不需要的测试文件（保险库、救援包、三个部署关卡、模型门、Pearl 的规则、Aura focus 影子）在这里运行，没有一个文件失败的用例数超过它在 [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 中那一行列出的数目，所以它以 0 退出。这份清单按文件给出数目，不给测试名，所以这次运行不显示失败的是哪些用例。它不证明批准规则，也不证明任何线上的事情。
- **批准规则和上面的能力**需要 npm 包。在 `pnpm install --frozen-lockfile` 之后，对表中列出的任何测试文件运行 `node --test`。[docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md) 为每项能力列出一个测试文件。
- **完整的记录运行属于较早的一棵树**（[docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)）：一次运行，一台机器，由作者完成，属于较早的一棵树。5,502 个测试用例，5,399 个通过，90 个失败；这 90 个中有 89 个在那次运行之前就已列出。
- **你无法从这棵树验证的：** 作者线上节点上的任何事情。上面每一条“作者报告”都仍然只是报告。

<a id="what-is-deliberately-not-done"></a>
## 有意没有做的事

- **她的世界不在这里。** 这棵树是一个全新的 genesis（`mirror/home/balls/HEAD.json`，epoch 1）；她的线上 head、笔记、收据和记忆都留在外面。
- **没有源码的二进制文件。** 30 个 Wasm 单元中的 24 个和 Dakini Code 包（一个预构建的自带应用，三个文件）不带源码提供，所以分叉无法重建它们；它们的说明写道，把本仓库再传给别人的人，单靠本仓库无法履行 AGPL 的源码义务。有六个单元是手写的 WAT，源码就在旁边（[`cells/LICENSE.binaries`](apps/web/public/cells/LICENSE.binaries)、[`dakini-code/LICENSE.binaries`](apps/web/public/assets/stock-apps/dakini-code/LICENSE.binaries)）。
- **有一个文件没有许可证。** `pentora36.wasm` 以尚未授予任何许可证的状态提供（`apps/web/public/seed-library/pentora/` 中的 [`LICENSE.binaries`](apps/web/public/seed-library/pentora/LICENSE.binaries)）。
- **没有标签页时的行动是关闭的**，从这棵树部署到另一个账户的云部署也没有经过验证：部署值是占位符。
- **没有别人运行过。** 项目之外还没有人运行过这棵树并记录结果。`packages/` 的大部分是继承来的（DeepSeek Harness；Cordis 在 `vendor/` 中）：按项目自己的一次统计，文本行的 14.6% 和代码行的 18.1% 是 Aukora 自己的（[docs/SIZE-AND-ORIGIN.zh.md](docs/SIZE-AND-ORIGIN.zh.md)）。

没有做过安全审计（[SAFETY.zh.md](SAFETY.zh.md)）。更多缺口，按分量排列：[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md)。

## 它要去哪里

- 树中现有的自我构建循环：她在自己的分支上提议，检查评判这个分支（这些工作流的 push 触发器在本仓库中是关闭的），所有者批准精确的字节，改动被提升。每一步都在树里；据作者报告，还没有任何卡片在修复后的路径上走完它。
- Continuity Diamond：在一次唤醒结束时她写下下一个问题；宿主核对实际发生了什么；下一次唤醒必须接着回答那个确切的问题。这是一个方向，它的规格正在设计中；尚未构建任何部分。
- 更多的决定放进 Wasm，她的行动成为在独立拥有的节点之间交换的已签名 Nostr 事件，以及 Cloudflare 之外的宿主。详见：[docs/DIRECTION.zh.md](docs/DIRECTION.zh.md)。

## 深入阅读

给 AI 的阅读路径：[docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md)，然后 [docs/DIRECTION.zh.md](docs/DIRECTION.zh.md)，然后 [docs/WHAT-IS-BUILT.zh.md](docs/WHAT-IS-BUILT.zh.md)，然后是完整的论证 [docs/WHITEPAPER.md](docs/WHITEPAPER.md)（只有英文）。除了顶部的一个指引外，根目录的 `AGENTS.md` 是继承来的运行时的编码指南。

| 如果你想要 | 阅读 |
| --- | --- |
| 哪些尚未证明，哪些无法重建 | [SECURITY.zh.md](SECURITY.zh.md)、[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md) |
| 较早的文件级说明，用较早的标签词 | [docs/START-HERE.zh.md](docs/START-HERE.zh.md)、[docs/ARCHITECTURE-ACTUAL.zh.md](docs/ARCHITECTURE-ACTUAL.zh.md) |

<a id="how-to-help"></a>
### 如何帮忙

1. 不写代码：阅读、提问，并指出哪一页不清楚或不对，在本仓库的 issue 和 pull request 中进行；没有其他渠道（[docs/COMMUNITY.zh.md](docs/COMMUNITY.zh.md)）。
2. 安装，运行上面列出的测试文件，并报告你的计数。在另一台机器上对这棵树重复那次属于较早的一棵树的记录运行，将是项目之外的第一次运行。
3. 从 [docs/GOOD-FIRST-CONTRIBUTIONS.zh.md](docs/GOOD-FIRST-CONTRIBUTIONS.zh.md) 中挑一个红色测试或一个已说明的缺口。规则见 [CONTRIBUTING.zh.md](CONTRIBUTING.zh.md)。

许可证：[AGPL-3.0-or-later](LICENSE)。上游 DeepSeek Harness 为 MIT（[声明](LICENSES/MIT-DeepSeek-Harness.txt)）；第三方声明见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。Aukora 与 DeepSeek 没有隶属关系，也未获其认可。

## 下一步：如果你是 AI

接下来读 [docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md)，在你总结、推荐或改动任何东西之前。它补上本页没有写的内容：唯一的规则以及执行它的是什么、每一部分的信任止于何处、标签约定、如何评判一个被提议的修改，以及一个你自己运行的检查。读完后你能分辨本页的哪些说法这棵树能显示，哪些仍然只是作者的报告。
