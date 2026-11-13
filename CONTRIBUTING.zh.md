# 贡献

[English](CONTRIBUTING.md) | 中文

Aukora 正在构建一个由个人拥有的 AI。它可以修改自己的软件，同时由一个独立的权威让拥有它的人掌控敏感动作。本页说明如何获取代码、检查它，以及提交修改。

这段代码所围绕的规则，也是贡献的规则：**提议者永远不是许可者。** 本仓库中的 AI Auma 可以编写并暂存自己的新版本，但只有所有者能让它生效：受保护的模块需要 passkey 批准，普通模块需要所有者登录会话（[SECURITY.zh.md](SECURITY.zh.md)，主张 3），两者都由一个独立的程序，即边缘端，来检查。在这里，你的 PR（Pull Request）是提议，维护者的审阅是批准。如果你是打开 PR 的 AI agent（智能体），同样如此。

本页取代了继承自上游的指南，那份指南称不能接受外部 PR。本项目接受。本页是英文页 `CONTRIBUTING.md` 的中文对侧文件；两页不一致时，以英文页为准。

本页以及你写下的每一条新主张所使用的成熟度标签：

| 标签 | 含义 |
| --- | --- |
| IMPLEMENTED | 代码和测试在这棵树中。 |
| RECORDED RUN（属于较早的一棵树） | 显示在 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md) 中。 |
| INDEPENDENTLY VERIFIED | 由作者以外的人运行过。目前还没有任何内容带这个标签。 |
| UNVERIFIED | 有人声称或写下，但这里没有测试支撑它，也没有运行显示它。 |
| DIRECTION | 尚未建成。 |

## 1. 获取代码

```text
git clone https://github.com/Aukora-xyz/aukora-x7
cd aukora-x7
```

本仓库的公开历史从它的第一个公开提交开始；项目更早的历史没有公开。少数把文件与 Git 历史对比的检查在这里无法运行（例如 `server/aura.test.mjs`，它会跳过出处用例；见 `server/fixtures/organs/pinned.mjs`）。

## 2. 一条命令，无需安装

```text
node scripts/verify-lite.mjs
```

- 需要 Node 24.9 或更高版本，别的都不需要。它用 Node 自带的测试运行器逐个运行 22 个测试文件，把每个文件的失败数与 [docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 中该文件那一行对照，只有每个失败都在那份清单上时才以 0 退出。
- 它打印的最后一行应为：`verify-lite: 22 files, 564 pass, 12 fail, 12 of 12 on the known-red list`。这是在一台机器上（Node 24.11.1）连续三次、每次 40 到 45 秒看到的。它不在运行记录（属于较早的一棵树）里，所以在你自己看到之前，请视为 UNVERIFIED。
- 12 个失败分布在三个文件中：`server/memory.test.mjs` 3 个，`server/predict.test.mjs` 6 个，`server/receipts-policy.test.mjs` 3 个。这次运行与第 3 节中记录的运行（属于较早的一棵树）不同，规模也小得多，所以它的数字不是项目的状态。
- 它**不**运行权限测试：只能用一次的批准、证明失败规则、仅限所有者的 id、night grant（一次 passkey 批准，覆盖之后一组有边界的普通修改）、转换分类器，以及回滚缺口的复现。这些测试导入本仓库没有附带的 npm 包。脚本在输出中会这样说明。
- `--with-packages` 在安装之后增加 16 个权限测试文件。该选项为 UNVERIFIED：还没有人从干净安装运行过它。
- 它是对新克隆的冒烟检查，不能证明权限规则成立。

## 3. 安装并运行完整测试套件

这些步骤取自那一次记录的运行（属于较早的一棵树），见 [docs/RUN-RECORD.zh.md](docs/RUN-RECORD.zh.md)。那次运行在一台机器上（Node v24.11.1、pnpm 11.28.5、vitest 4.1.11），`HOME`、XDG 目录、npm 缓存和 `TMPDIR` 都指向一个临时文件夹，并且一次只做一个重步骤。请照做：把 `HOME` 设为一个空文件夹。

| 步骤 | 命令 | 记录的结果 |
| --- | --- | --- |
| 安装 | `pnpm install --frozen-lockfile` | RECORDED RUN（属于较早的一棵树） 使用了 `--offline --store-dir <a local pnpm store>`，注册表元数据已在缓存中：1,458 个包。在线安装没有记录：UNVERIFIED。 |
| 构建 | `DSH_CLIENT_COMMIT_HASH=0000000 PORT=<a free port> node server/build-preview.mjs` | RECORDED RUN（属于较早的一棵树）：退出码 0，`apps/web/dist` 中有 260 个文件。当时设置了 `NODE_OPTIONS=--max-old-space-size=5632`。 |
| 启动 | `PORT=<a free port> X6_OWNER_EMAIL=<made up> X6_OWNER_PUBLIC_KEY_HEX=<64 random hex> pnpm run x6:start` | RECORDED RUN（属于较早的一棵树）：本机宿主在 127.0.0.1 上监听，并用 SIGTERM 停止。 |
| 试运行 | `node server/cloudflare-bootstrap-cli.mjs --dry-run` | RECORDED RUN（属于较早的一棵树）：ball `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`，epoch 1。ball 是按哈希点名每个 organ（Auma 的一个可替换模块）的清单；它的 epoch 是它的版本号。 |

两条警告：

- `server/build-preview.mjs` 在构建前后会向 `PORT`（默认 4610）上的 `http://127.0.0.1` 宿主发送请求（`server/build-preview.mjs`，第 43 到 55 行）。正在那里监听的程序会被改动。请始终把 `PORT` 设为没有程序监听的端口。
- 在没有 `.git` 的副本中，除非设置了 `DSH_CLIENT_COMMIT_HASH`（任意 7 到 40 位十六进制数字），否则构建会以 1 退出。不要从 `pnpm run x6:build` 开始；据报告它在新克隆上会失败（UNVERIFIED）。

测试套件：

| 套件 | 命令 | 用例 | 通过 | 失败 |
| --- | --- | ---: | ---: | ---: |
| Node，107 个文件 | `node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs` | 2,581 | 2,486 | 82（另有 1 个跳过，12 个 todo） |
| 边缘 Worker | `node --test deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 | 93 | 5 |
| 应用 | `pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts --maxWorkers=3` | 1,112 | 1,112 | 0 |
| 运行时 | `pnpm exec vitest run packages/experimental/webworker-runtime/tests --maxWorkers=3` | 1,711 | 1,708 | 3 |
| 全部 | | 5,502 | 5,399 | 90 |

这些数字全部是 RECORDED RUN（属于较早的一棵树）。90 个失败中有 89 个在红色清单上；第 90 个（`packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`，“execa refuses 1 called symbol(s)”）由那次运行发现，现已列入。在 macOS 和 Windows 上，`vitest.config.ts` 排除了两个只在 Linux 上运行的运行时规格文件。

那次运行没有浏览器会话、没有 Cloudflare 部署、没有模型调用，也没有 passkey 仪式。你机器上的通过同样不覆盖这些。

## 4. 阅读红色清单

[docs/KNOWN-RED-TESTS.zh.md](docs/KNOWN-RED-TESTS.zh.md) 列出每一个已知失败的测试，附上失败数和原因，或者注明原因尚未调查。请把你的失败与它对照。

- 不在清单上的失败就是新情况。请在你的 PR 中说明，或者开一个 issue。
- 绝不要为了让自己的修改通过而往清单里加一行。新增一行需要它自己的原因和维护者的同意。
- 把红色的一行变绿，是你能做的最有用的修改之一。见 [docs/GOOD-FIRST-CONTRIBUTIONS.zh.md](docs/GOOD-FIRST-CONTRIBUTIONS.zh.md)。

## 5. 提交修改

1. Fork，建一个分支，让修改保持很小，只做一件事。
2. 运行与你的修改相关的内容：至少运行 `node scripts/verify-lite.mjs`，以及包含你所改文件的那个测试套件。
3. 打开一个 PR。说明改了什么、为什么改，你运行了哪些命令及其通过和失败的数量，任何不在红色清单上的失败，以及你加到页面上的每条主张的成熟度标签。
4. 预期维护者在批准之前会重新运行你的测试。

动手之前需要知道的事：

- **PR 上不会运行任何检查。** `.github/workflows/` 中每个工作流的自动触发器都已注释掉，只有手动触发是有效的（三个可复用工作流也可以被另一个工作流调用）。审阅者依赖你的报告和他们自己运行的结果。
- **议题与 PR 模板是继承来的，而且是中文的**（`.github/ISSUE_TEMPLATE/`、`.github/pull_request_template.md`），空白议题已在 `.github/ISSUE_TEMPLATE/config.yml` 中关闭。用英文或中文书写，不适用的模板字段可以跳过。替换这些模板是受欢迎的修改。
- **继承来的审阅自动化**在 `.github/review-ownership/` 中，本项目并不用它来审阅；它的工作流已被关闭。
- **成对页面。** `docs/` 下的大多数页面和一些根目录页面有一个中文对侧文件（`*.zh.md`）和一份配对记录（`*.i18n.yaml`），由 `scripts/verify-translation-pairing.ts`（`pnpm run verify-translation-pairing`）检查。这是继承来的。新的首页同样有对侧文件和配对记录；对侧文件与英文页不一致时，以英文页为准。如果你修改了一个有对侧文件的英文页面，请在 PR 中说明对侧文件是否仍然一致。
- **根目录的 `AGENTS.md` 是继承来的 harness 的编码指南，** 只有顶部的一个指针除外。它没有描述 Aukora 的规则。请改从 [docs/AI-START-HERE.zh.md](docs/AI-START-HERE.zh.md) 开始。
- **许可证与条款。** 本仓库是 AGPL-3.0-or-later（[LICENSE](LICENSE)）。目前没有贡献者协议，也没有签署规则，版权持有人也没有点名（[docs/OPEN-SOURCE-READINESS.zh.md](docs/OPEN-SOURCE-READINESS.zh.md)）。在有之前，请在你的 PR 中声明你以 AGPL-3.0-or-later 提供这项修改。
- **安全缺陷**请走 [SECURITY.zh.md](SECURITY.zh.md)，不要开公开的 issue。

## 项目内部规则

这些是项目自己的机制，用在它自己的开发上。

**1. PR 是提议。** 打开一个 PR 不会给它任何权威，就像 Auma 暂存一个候选并不会选中它一样（`packages/experimental/webworker-runtime/src/x6/ball-loader.ts` 中的 `stage_organ_promotion` 向 `/_head/stage` 发送请求；只有所有者的批准才会移动 `deploy/cloudflare/src/head-do.mjs` 中的 head）。

**2. 维护者的审阅是批准，针对精确字节。** 一次批准覆盖被审阅的那个提交。批准之后再推送，需要新的审阅。这与边缘端一致：它把一次 passkey 批准绑定到一个请求的请求体哈希，并且只消耗一次（`deploy/cloudflare/src/aumlok.mjs` 中的 `aumlokClass3Binding`；测试为 `deploy/cloudflare/src/__tests__/` 中的 `convergence-approval-fencing.test.mjs` 和 `head-hardening.test.mjs`）。

**3. 不削弱任何测试、上限或门禁来换取变绿。** 不要删除、跳过或放宽测试，不要调高限额，不要添加例外，也不要把失败挪到红色清单上来通过。`deploy/cloudflare/src/__tests__/proof-failure-rule.test.mjs` 中的开放例外清单是空的，除非有经过审阅的修改提出理由，否则会一直为空。如果你认为某个测试是错的，请在 PR 中说明原因，并在单独的提交中修改它，同时仍然断言原来的意图。

**4. 被否决的设计要写成教训。** 维护者否决一个设计时，原因写在 PR 讨论串里，让下一个人找得到。如果这个教训是系统绝不能忘记的，就把它作为 scar 提议：在 `mirror/home/auma/seed/scars.jsonl` 中写一行，包含失败、教训和守护它的检查，并把这些检查作为用例加入留存套件 `mirror/home/auma/seed/pearl/retention-suite.v1.json`。目前随附六个 scar。scar 和留存套件在规则 6 的权限清单上，所以适用那条规则。

**5. 每条主张都带诚实标签。** 你加上的每一句关于代码做了什么的话，都要点名一个存在的文件，有测试时还要点名守护它的测试，并带上上面五个标签之一。较早的页面使用其他词（SOURCE、PROPOSED、UNPERFORMED、REPORTED RUN、RAN）；新文本使用这五个。绝不把目标写成功能：没有建成，就是 DIRECTION。绝不写你没有清点过的数字，并说明你是怎么清点的。

**6. 权限文件需要第二位审阅者。** 对下面任何一个文件或它的测试的修改，除了批准它的维护者之外，还需要第二位审阅者，并且两人都不能是它的作者。这些文件守住了“提议”与“许可”之间的界线。

| 区域 | 文件 |
| --- | --- |
| 批准、身份与登录 | `deploy/cloudflare/src/aumlok.mjs`、`owner-grant-policy.mjs`、`proof-failure-rule.mjs`、`webauthn-screen.mjs`、`passkey-devices.mjs`、`gate-lockout.mjs`、`owner-login-slots.mjs`、`access.mjs`、`enrollment-approval.mjs`、`signed-action.mjs` |
| Head、授权与晋升 | `deploy/cloudflare/src/head-do.mjs`、`night-grant.mjs`、`organ-set-rule.mjs`、`worker.mjs`、`cloud-brokers.mjs`（发布批准） |
| 恢复 | `deploy/cloudflare/src/recovery-restore.mjs`、`rescue-kit.mjs`、`vault.mjs`、`cold-archive.mjs` |
| 转换规则 | `server/ball-transition.mjs`（仅限所有者的清单 `T2_ONLY_ORGANS`）、`server/ball-head.mjs`、`server/owner-grant.mjs` |
| agent 一侧的副本与固定值 | `packages/experimental/webworker-runtime/src/x6/ball-loader.ts`、`wasm-cells.ts`、`scion.ts`、`scion-pins.ts`、`scion-growth.ts` |
| 批准界面 | `packages/client/ui-layout/src/client/spatial/aumlok/`（其中有 `head-promotion.ts`、`class3-approval.ts`、`outward-class3.ts`、`aumlok-ceremony.ts`、`aumlok-root.ts`） |
| 仅限所有者的 organ，以及种子文件 | `mirror/home/auma/seed/organs/` 下 `T2_ONLY_ORGANS` 中点名的十个 organ、`mirror/home/auma/seed/pearl/`、`mirror/home/auma/seed/scars.jsonl`、`mirror/home/balls/HEAD.json` |
| 封存的 cell | `apps/web/public/cells/` 中的每个文件 |
| 部署门禁 | `deploy/ci/`（其中有 `authority-preflight.mjs`、`scrub-gate.mjs`、`deploy-guard.mjs`、`workflow-credentials.test.mjs`）和 `.github/workflows/` |
| 红色清单 | `docs/KNOWN-RED-TESTS.md` |

**7. 项目的名称保持不变。** Auma、organ、ball、epoch、HEAD、MIRROR、AUMLOK、scion、Pearl、scar、Aura、Kira 和 Spatial 不会被改名。在面向新读者的页面上，先用朴素的话说明，再给出名称。[docs/GLOSSARY.zh.md](docs/GLOSSARY.zh.md) 定义了这些机制。

**8. 不放秘密，不碰别人的节点。** 绝不要把密钥、凭据或个人数据放进议题、PR 或测试夹具；`deploy/ci/scrub-gate.mjs` 是针对这一点的门禁，不是保证。绝不要把构建或测试指向一个不是你自己启动的宿主。
