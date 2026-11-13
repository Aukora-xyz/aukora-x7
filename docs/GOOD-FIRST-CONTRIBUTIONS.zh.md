# 适合上手的贡献

[English](GOOD-FIRST-CONTRIBUTIONS.md) | 中文

十个真实的起步任务。每个任务都对应本树中的一个文件，以及一个失败的测试或一处已写明的缺口。没有一个已经完成。

**这些任务没有作为 issue 开出。** 它们只存在于本页。开始其中一个之前，请先开一个 issue 或草稿 pull request，并写明它在本页的编号，这样两个人就不会重复做同一件事。某个任务完成后，关闭它的 pull request 也要把它从本页删除。

适用于每个任务的规则（[CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)）：不削弱任何测试、上限或关卡；[KNOWN-RED-TESTS.zh.md](KNOWN-RED-TESTS.zh.md) 上的红色条目，只有在写明原因后才能改动；每一条声明都带有这些标签之一：IMPLEMENTED、RECORDED RUN（属于较早的一棵树）、INDEPENDENTLY VERIFIED（目前没有任何内容带此标签）、UNVERIFIED 或 DIRECTION。

下文用到三个词：organ 是 Auma（本仓库中的 AI）的一个可替换模块；ball 是按哈希列出每个 organ 的清单；genesis head 是第一个 ball，处于 epoch（版本号）1，每个节点都从它出发。

## 1. 在第二台机器上运行测试套件

- **缺口：** 唯一的一次运行由作者在一台 macOS 机器上完成（[RUN-RECORD.zh.md](RUN-RECORD.zh.md)）（这份记录属于较早的一棵树）。没有任何内容是 INDEPENDENTLY VERIFIED。有两个运行时规格只在 Linux 上运行（`vitest.config.ts`，第 69 至 76 行）。
- **完成标准：** 提交一个 pull request，其中的记录与 RUN-RECORD.md（一份属于较早的一棵树的记录）格式相同：工具版本、各套件的计数、与 KNOWN-RED-TESTS.md 对照过的每个失败用例名，以及 dry-run 的 ball id。Linux 最有用。RUN-RECORD.md（属于较早的一棵树）没有给出耗时，所以请记下安装和各套件各花了多长时间。
- **检查：** 一位维护者重复运行其中一个套件，得到相同的计数。这将是第一个 INDEPENDENTLY VERIFIED 的项目。

## 2. 让 `server/read-limits.test.mjs` 能够加载

- **红色：** 该文件加载失败（KNOWN-RED-TESTS.md，“Red for reasons not yet investigated”）。
- **完成标准：** 在该条目中写明加载错误，并且要么该文件的用例能在 `node --test` 下运行，要么该条目说明它们为什么不能。
- **检查：** 在 `pnpm install --frozen-lockfile` 之后运行 `node --test server/read-limits.test.mjs`。

## 3. 查明 `node-stubs.spec.ts` 为什么失败

- **红色：** `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`，“execa refuses 1 called symbol(s)”（第 96 行构建的用例），由已记录的那次运行（属于较早的一棵树）发现。
- **完成标准：** 写明被调用的符号和原因；修复桩或测试，并在提交说明中写明原因，或者由该条目说明为什么不修。
- **检查：** `pnpm exec vitest run packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts`。

## 4. 诊断收据和预测测试

- **红色：** 15 个用例：`server/receipts.test.mjs` 6 个，`server/receipts-policy.test.mjs` 3 个，`server/predict.test.mjs` 6 个。它们测试收据日志（`mirror/home/auma/seed/organs/seed-receipts.js`）和预测 organ（`seed-predict.js`），前部页面对这两者都有描述。
- **完成标准：** 每个用例第一个失败的断言及其原因，写入 KNOWN-RED-TESTS.md 的对应条目。修复可以随后在单独的 pull request 中进行；`seed-receipts.js` 和 `seed-predict.js` 是仅限所有者的 organ，所以对它们的改动需要第二位审阅者。
- **检查：** `node scripts/verify-lite.mjs` 会运行 `receipts-policy` 和 `predict`，无需安装；`receipts` 需要先安装。

## 5. 一个原因还是多个原因：`server/recall.test.mjs`

- **红色：** 一个文件中有 50 个用例。`server/absence.test.mjs`（9 个）和 `server/memory.test.mjs`（3 个）属于同一类。
- **完成标准：** 在 KNOWN-RED-TESTS.md 的条目中写一条说明，判断是否一个原因就能解释全部 50 个用例，然后要么修复，要么按组写出各自的原因。之后对另外两个文件做同样的事。
- **检查：** 安装后运行 `node --test server/recall.test.mjs`。`memory` 会在 `node scripts/verify-lite.mjs` 中运行；`absence` 被有意排除在外（见该脚本中的注释），所以请运行 `node --test server/absence.test.mjs`。

## 6. 断言随附的 head，而不是长期运行的那个

- **红色：** `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts`，第 226 和 227 行的用例，读取 `mirror/home/auma/HEAD.json`，并期望得到一个长期运行节点的 epoch（171 或更高）。本仓库在该位置随附的是 genesis head：epoch 1，26 个条目。
- **完成标准：** 新增一个用例来断言 genesis head；原来的断言改为针对一个合成的长期运行 fixture 运行；不放宽任何内容。
- **检查：** `pnpm exec vitest run packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` 通过，并且原来的期望仍在该文件中。

## 7. 给 superagent 测试一个合成的 home

- **红色：** `apps/web/src/spatial/superagent/superagent.test.ts`（12 个中的 3 个）和 `read.spec.ts`（50 个中的 8 个）读取的是 `mirror/home/auma/` 下某个节点的 world，而它并未随附。`read.spec.ts` 中的第九个用例（“exactly 256 referenced nodes fit the file and concurrency budgets”，第 1551 行）取决于机器负载。这两个文件都不在已记录的那次运行（属于较早的一棵树）中。
- **完成标准：** 两个文件都针对由测试自己创建的合成 home 运行；计时用例不再取决于负载。
- **检查：** 运行这两个文件，并报告你用的命令；它还不在 RUN-RECORD.md 中（这份记录属于较早的一棵树）。

## 8. 让 workflow 触发器测试适应触发器已关闭的仓库

- **红色：** `scripts/ci-workflow.spec.ts`（6 个）、`deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs`（4 个）、`.github/issue-management/policy.test.mjs`（1 个）。它们断言的自动触发器在这里已被注释掉，并带有禁用标记（例如 `.github/workflows/deploy-*.yml` 的第 44 行）。
- **完成标准：** 这些测试接受该标记，断言只有手动触发处于启用状态，并且对被注释掉的触发器文本仍保留原来的断言。
- **检查：** 这三个文件通过，并且 diff 中没有删除任何原有断言。

## 9. 部署值只用一个来源

- **缺口：** 占位符 `your-node`、`node.example.invalid` 和 `your_org_x/your-node` 除了写在 `deploy/cloudflare/wrangler.toml` 中，也写进了代码：`server/deploy-cloudflare.mjs`（第 21、24 行）、`deploy/cloudflare/src/cloud-brokers.mjs`（第 8、1700 行）、`server/seed-cloudflare.mjs`（第 14 行）、`server/cloudflare-bootstrap-cli.mjs`（第 6 行），以及更多（下面的 grep 会列出）。在全新账户中部署是 UNVERIFIED。
- **完成标准：** 下面的 grep 所列出的每个非测试代码文件，都从同一个配置来源读取这些值。
- **检查：** `grep -rlE 'your-node|example\.invalid|your_org_x' server deploy` 只列出该配置、测试和文档，并且 `node --test deploy/ci/*.test.mjs` 没有失败（KNOWN-RED-TESTS.md 中那里没有列出任何失败）。

## 10. 默认情况下不让构建触碰正在运行的宿主

- **缺口：** `server/build-preview.mjs`（第 43 至 55 行）在构建前后向 `http://127.0.0.1` 的 `PORT`（默认 4610）发送 POST 请求。正在那里监听的程序会被改动。
- **完成标准：** `PORT` 未设置时它不发出任何请求；一个带监听桩的测试显示调用次数为零；文档中的警告变得更短。
- **检查：** 新测试通过，并且在按 RUN-RECORD.md 所述设置 `PORT` 时，构建仍能完成（这份记录属于较早的一棵树）。

## 上面未计入的更多候选项

- 恢复演练中未完成的一项“clock rollback across restart”（`deploy/cloudflare/src/__tests__/aumlok-restore-rehearsal.test.mjs`，第 148 行）。这涉及权限文件，需要第二位审阅者（[CONTRIBUTING.zh.md](../CONTRIBUTING.zh.md)，第 6 条规则）。
- 一个调用编译器（`packages/experimental/webworker-runtime/src/x6/scion.ts`）的测试，和一个调用自我构建步骤（`mirror/home/auma/seed/organs/seed-cycle.js`）的测试。目前没有任何测试调用二者，所以两者在每一页上都是 UNVERIFIED。`scion.ts` 在权限清单上，因此适用第 6 条规则。
- 对照英文页面阅读新的前部页面的中文页面（`*.zh.md`），并报告不一致之处；不一致时，以英文页面为准。
- 运行已记录命令之外的测试文件，先从 `deploy/cloudflare/src/__tests__/owner-login-lockout.spec.ts`（命令见 `deploy/cloudflare/README.md` 第 167 行）和 `apps/web/src/spatial/superagent/manifest.spec.ts` 开始，并报告结果。
- 把 [START-HERE.zh.md](START-HERE.zh.md) 和 [ARCHITECTURE-ACTUAL.zh.md](ARCHITECTURE-ACTUAL.zh.md) 中较早的标签用词，改为上述五个标签。
- 用适合本项目的模板，替换 `.github/` 中继承来的中文 issue 和 pull request 模板。
