# 已知的红色测试

[English](KNOWN-RED-TESTS.md) | 中文

本仓库中有些测试会失败，而且这是预期的。没有任何测试为了变绿而被删除、跳过或削弱。本页逐一列出它们，附上失败数和原因，免得新读者感到意外。失败数来自编写本清单时逐个文件单独运行。作者对本仓库较早的一棵树的一次运行记录在 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 中；最后一列说明那次运行对每一行的结果。它的日志没有随附，请自己运行测试核对。

## 它们在本仓库中无法通过

本仓库从创世种子开始，其工作流的自动触发器一开始是关闭的。这些测试断言的是一个长期运行节点的状态，而本仓库没有这样的节点。

| 文件 | 失败 | 原因 | 在记录的运行（属于较早的一棵树）中 |
| --- | --- | --- | --- |
| `scripts/ci-workflow.spec.ts` | 68 个中 6 个 | 它们断言工作流的自动触发器。在本仓库有自己的运行器和密钥之前，这些触发器被注释掉了。 | 未运行 |
| `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` | 4 | 同样的原因：它们读取部署工作流的自动触发器。 | 失败 4 个 |
| `.github/issue-management/policy.test.mjs` | 51 个中 1 个 | 同样的原因：它读取 issue 工作流的触发器。 | 未运行 |
| `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` | 1（"her real head"） | 它断言一个长期运行节点的 head（纪元和条目）。本仓库提供的是创世 head，纪元 1。 | 失败 1 个 |
| `apps/web/src/spatial/superagent/superagent.test.ts` | 12 个中 3 个 | 部分用例读取节点自己在 `mirror/home/auma/` 下的世界（收据、语料、记忆 DAG）。这里只提交了创世种子。 | 未运行 |
| `apps/web/src/spatial/superagent/read.spec.ts` | 50 个中 8 个（第 9 个 "exactly 256 referenced nodes fit the file and concurrency budgets" 对时间敏感，机器繁忙时可能失败） | 同样的原因。 | 未运行 |
| `deploy/cloudflare/src/__tests__/world-holder.test.mjs` | 59 个中 6 个 | 需要私有的提交历史；公开的树只随附一份快照。这六个用例用 `git show` 与两个较早的提交比较，而这些提交不在本仓库中。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/ci/frozen-paths.test.mjs` | 17 个中 2 个 | 一个用例断言冻结清单上的每个文件都在树中；清单列出了她在 `mirror/home/auma/seed/` 下的收据文件，而本仓库不随附它（只提交了 genesis 种子）。另一个用例断言 `proposal-checks.yml` 的自动触发器，而它在这里和其他工作流一样被注释掉了。请在 git 检出中运行它：另有四个用例会调用 `git ls-files`。 | 在记录的运行（属于较早的一棵树）之后加入 |

要让它们通过：基于创世种子或合成的 home 重写它们；在本仓库有自己的运行器后再打开触发器。

## 原因尚未调查的失败

这些测试在本仓库起始的提交上以同样的方式逐项失败。其原因尚未调查。

| 文件 | 失败 | 在记录的运行（属于较早的一棵树）中 |
| --- | --- | --- |
| `server/absence.test.mjs` | 9 | 失败 9 个 |
| `server/memory.test.mjs` | 3 | 失败 3 个 |
| `server/predict.test.mjs` | 6 | 失败 6 个 |
| `server/recall.test.mjs` | 50 | 失败 50 个 |
| `server/receipts.test.mjs` | 6 | 失败 6 个 |
| `server/read-limits.test.mjs` | 1 | 失败 1 个（文件无法加载） |
| `server/receipts-policy.test.mjs` | 3 | 失败 3 个 |
| `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | 1 | 失败 1 个 |
| `deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 个中 5 个（用 `node --experimental-strip-types --test` 运行；vitest 不收集这个文件） | 98 个中失败 5 个 |

## 记录的运行新发现的失败

记录的运行（属于较早的一棵树）中有一个失败的用例不在本清单上，而且它仍然是红色的。它已加入这里，尚未修复。

| 文件 | 失败 | 原因 |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` | 34 个中 1 个（"execa refuses 1 called symbol(s)"） | 尚未调查。导出没有改动这个 spec 和它测试的桩；它在起始提交上是否失败，没有检查。 |
