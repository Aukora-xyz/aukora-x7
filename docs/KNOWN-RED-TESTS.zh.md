# 已知的红色测试

[English](KNOWN-RED-TESTS.md) | 中文

本仓库中有些测试会失败，而且这是预期的。没有任何测试为了变绿而被删除、跳过或削弱。本页逐一列出它们，附上失败数，已知原因的也附上原因，免得新读者感到意外。失败数来自编写本清单时逐个文件单独运行。作者对本仓库较早的一棵树的一次运行记录在 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 中；最后一列说明那次运行对每一行的结果。它的日志没有随附，请自己运行测试核对。

## 它们在本仓库中无法通过

本仓库从创世种子开始，其工作流的自动触发器一开始是关闭的。这些测试断言的是一个长期运行节点的状态，而本仓库没有这样的节点。

| 文件 | 失败 | 原因 | 在记录的运行（属于较早的一棵树）中 |
| --- | --- | --- | --- |
| `scripts/ci-workflow.spec.ts` | 68 个中 6 个 | 它们断言工作流的自动触发器。在本仓库有自己的运行器和密钥之前，这些触发器被注释掉了。 | 未运行 |
| `deploy/cloudflare/src/__tests__/deploy-workflow.test.mjs` | 4 | 同样的原因：它们读取部署工作流的自动触发器。 | 失败 4 个 |
| `.github/issue-management/policy.test.mjs` | 51 个中 1 个 | 同样的原因：它读取 issue 工作流的触发器。 | 未运行 |
| `apps/web/src/spatial/superagent/superagent.test.ts` | 12 个中 3 个 | 部分用例读取节点自己在 `mirror/home/auma/` 下的世界（收据、语料、记忆 DAG）。这里只提交了创世种子。 | 未运行 |
| `apps/web/src/spatial/superagent/read.spec.ts` | 50 个中 8 个（第 9 个 "exactly 256 referenced nodes fit the file and concurrency budgets" 对时间敏感，机器繁忙时可能失败） | 同样的原因。 | 未运行 |
| `deploy/cloudflare/src/__tests__/world-holder.test.mjs` | 59 个中 6 个 | 需要私有的提交历史；公开的树只随附一份快照。这六个用例用 `git show` 与两个较早的提交比较，而这些提交不在本仓库中。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/ci/frozen-paths.test.mjs` | 26 个中 8 个，在没有 `.git` 文件夹时运行（直接下载的副本） | 一个用例断言冻结清单上的每个文件都在树中；清单列出了她在 `mirror/home/auma/seed/` 下的收据文件，而本仓库不随附它（只提交了 genesis 种子）。一个用例断言 `proposal-checks.yml` 的自动触发器，而它在这里和其他工作流一样被注释掉了。六个用例调用 `git ls-files`，需要 git 检出；在这棵树的 git 检出中的失败数，本清单没有测量。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/cloudflare/src/__tests__/rescue-thread-join.test.mjs` | 64 个中 1 个 | 这个用例运行 `git grep`，而直接下载的这棵树没有 `.git` 文件夹。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/cloudflare/src/__tests__/fresh-link.test.mjs` | 14 个中 1 个，在没有 `.git` 文件夹时运行 | 用例“wired to nothing”运行 `git ls-files`，而直接下载的这棵树没有 `.git` 文件夹。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/cloudflare/src/__tests__/wake4-mirror-reads.test.mjs` | 1（文件无法加载） | 它在加载时读取她的交接笔记 `mirror/home/auma/HANDOFF.md`。那份笔记属于她的世界，本仓库不随附它。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/cloudflare/src/__tests__/capsule-act-shapes.test.mjs` | 18 个中 1 个 | 一个用例读取胶囊契约 `docs/capsule/CONTRACT.md`，本仓库不随附它（它的模式页面 `docs/capsule/SCHEMA.md` 随附，读取它的用例通过）。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `deploy/cloudflare/src/__tests__/capsule-envelope.test.mjs` | 17 个中 1 个 | 同样的原因：一个用例读取 `docs/capsule/CONTRACT.md`。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `packages/experimental/webworker-runtime/tests/x6/self-check.spec.ts` | 56 个中 1 个 | 一个用例读取她的页面 `docs/auma/self-check.md`，本仓库不随附它。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `packages/experimental/webworker-runtime/tests/x6/retention-real-head.spec.ts` | 14 个中 2 个 | 它们测试一个长期运行节点的 head 的 organ 模块。本仓库把那个 head 换成由通用种子集合构建的替身，所以这些模块在这里是另外的字节。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `packages/experimental/webworker-runtime/tests/x6/retention-infrastructure.spec.ts` | 21 个中 1 个 | 与上一行原因相同。 | 在记录的运行（属于较早的一棵树）之后加入 |
| `packages/experimental/webworker-runtime/tests/x6/voice-organ-readonly.spec.ts` | 14 个中 8 个 | 它在一个长期运行节点的 head 的 organ 字节上证明语音可调用的 organ 操作是只读的，并用这些字节核对 `voice-organ-pins.ts` 中的钉值。本仓库提供的是创世 head，其 organ 是另外的字节，所以这些钉值在这里匹配不到任何东西，语音会拒绝这些工具。 | 在记录的运行（属于较早的一棵树）之后加入 |

要让它们通过：基于创世种子或合成的 home 重写它们；在本仓库有自己的运行器后再打开触发器。

## 在导出它们的源码中以同样方式失败

这些测试在导出这棵树所用的私有源码的检出中，逐个用例以同样的方式失败。不是导出造成的。

| 文件 | 失败 | 原因 |
| --- | --- | --- |
| `deploy/cloudflare/src/__tests__/voice-bridge-fast-claude.test.mjs` | 24 个中 1 个 | 一个用例期望随附配置把 Claude 列为快速语音的提供方；源码已把那一行改为 DeepSeek（`deploy/cloudflare/wrangler.toml` 中的 `VOICE_FAST_PROVIDER = "deepseek"`），而这个用例没有随之更改。 |
| `deploy/cloudflare/src/__tests__/voice-provider-limits.test.mjs` | 1（文件加载失败） | 它在加载时因 TypeError 停止，在源码中也一样。未进一步调查。 |
| `apps/web/tests/auma-live-managed-voice-bundle.spec.ts` | 7 个中 1 个 | 这个用例重建托管语音的包，需要安装语音提供方的包（`@elevenlabs/client`）；没有检查对这棵树执行 `pnpm install` 是否会提供它。 |
| `apps/web/tests/pentora-live-bundle.spec.ts` | 1（构建步骤失败，所以它的 4 个用例被跳过） | 同样的原因：它的构建步骤打包 Auma Live 的模块，而这些模块导入那个包。 |

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
| `deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 个中 5 个（用 `node --experimental-strip-types --test` 运行；vitest 不收集这个文件） | 98 个中失败 5 个 |

## 记录的运行新发现的失败

记录的运行（属于较早的一棵树）中有一个失败的用例不在本清单上，而且它仍然是红色的。它已加入这里，尚未修复。

| 文件 | 失败 | 原因 |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` | 34 个中 1 个（"execa refuses 1 called symbol(s)"） | 尚未调查。导出没有改动这个 spec 和它测试的桩；它在起始提交上是否失败，没有检查。 |

## 在记录的运行中为红，在这棵树中不是红色

这两个文件在那次记录的运行（属于较早的一棵树）中各有一个用例失败。它们留在本页，是为了让那次运行的清单仍然对得上。在这棵树中，作者在安装了依赖包之后一起运行这棵树中改动过的测试文件时，两者都没有失败：9 个用例通过 9 个，118 个用例通过 118 个，这是测试运行器的计数（表驱动用例的每一行各算一个）。`organ-entry-states.spec.ts` 现在读取的是 `packages/experimental/webworker-runtime/tests/x6/fixtures/frozen-head/` 中一个冻结的替身 head；`scion-growth.spec.ts` 为什么变了，尚未调查。

| 文件 | 在这棵树中失败 | 在记录的运行（属于较早的一棵树）中 |
| --- | --- | --- |
| `packages/experimental/webworker-runtime/tests/x6/organ-entry-states.spec.ts` | 9 个中 0 个 | 失败 1 个 |
| `packages/experimental/webworker-runtime/tests/x6/scion-growth.spec.ts` | 118 个中 0 个 | 失败 1 个 |
