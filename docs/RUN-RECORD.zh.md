# 运行记录

[English](RUN-RECORD.md) | 中文

这是这棵树按原样发布后的一次运行，在一台机器上，由它的作者完成。它是一份记录，不是保证。除标为 SOURCE 的内容外，这里的一切都是 RAN。安装没有退回到链接模块，但离线安装需要一份 pnpm 注册表元数据缓存的副本（见“安装”一行）。这次运行以它启动的创世 head 命名：ball `a26b7a027014e6af067a0a8433c49c56639ac09642726110c91f8300e9e81624`，纪元 1。要重复它，在这棵树的一份新副本中运行同样的命令，并把 `HOME` 设为一个空文件夹，然后对照。这次运行的日志没有随附。

## 工具与步骤

Node v24.11.1、pnpm 11.28.5（`package.json` 固定的版本）、vitest 4.1.11。每个进程运行时，`HOME`、XDG 文件夹、npm 缓存和 `TMPDIR` 都指向一个临时文件夹。重的步骤一次只运行一个。

| 步骤 | 命令 | 结果 |
| --- | --- | --- |
| 安装 | `pnpm install --frozen-lockfile --offline --store-dir <a local pnpm store>` | 第四次尝试退出码 0：1,458 个包，下载 0 个，生命周期脚本已运行。第 1 到 3 次失败：缓存中没有注册表元数据时，pnpm 无法解析它自己固定的版本，随后无法离线检查锁文件。供应链策略检查一直开着，并且通过（1,779 条）。 |
| 构建 | `DSH_CLIENT_COMMIT_HASH=0000000 PORT=<a free port> node server/build-preview.mjs` | 退出码 0：封存了 104 个不可变资源，`apps/web/dist` 中有 260 个文件。不设 `DSH_CLIENT_COMMIT_HASH` 时退出码为 1：副本没有 `.git`，而桌面包步骤会运行 `git rev-parse HEAD`。`0000000` 是编造的值。设置了 `NODE_OPTIONS=--max-old-space-size=5632`。 |
| 启动 | `PORT=<a free port> X6_OWNER_EMAIL=<made up> X6_OWNER_PUBLIC_KEY_HEX=<64 random hex> pnpm run x6:start` | 在 127.0.0.1 上监听，它的 vault 文件夹在临时 `HOME` 之内。用 SIGTERM 停止。 |
| 演练 | `node server/cloudflare-bootstrap-cli.mjs --dry-run` | 退出码 0：上面的 ball id，纪元 1，一个 552,542 字节的批次。 |

## 测试

每条命令运行一次，只有应用那一行在同一份副本上运行了两次。它的第一次运行还因失误在设置了 `CI=1` 的情况下多运行了一次，结果与那第一次相同。

| 套件 | 命令 | 用例 | 通过 | 失败 |
| --- | --- | --- | --- | --- |
| Node，107 个文件 | `node --test server/*.test.mjs deploy/ci/*.test.mjs deploy/cloudflare/src/__tests__/*.test.mjs` | 2,581 | 2,486 | 82（另有 1 个跳过，12 个 todo） |
| 边缘端 Worker | `node --test deploy/cloudflare/src/__tests__/worker.spec.ts` | 98 | 93 | 5 |
| 应用，63 个文件，第二次运行 | `pnpm exec vitest run packages/client/ui-layout/tests scripts/spatial-catalogue.spec.ts --maxWorkers=3` | 1,112 | 1,112 | 0 |
| 运行时，88 个文件 | `pnpm exec vitest run packages/experimental/webworker-runtime/tests --maxWorkers=3` | 1,711 | 1,708 | 3 |
| 合计 | | 5,502 | 5,399 | 90 |

合计一行是它上面四行之和，每个套件取其最后一次运行：应用那一行取第二次运行，其他三行取它们唯一的一次运行。应用那一行的第一次运行结果是 1,112 个用例，通过 1,111 个，失败 1 个。那一个失败是由本仓库的导出造成的（见“失败的用例”）。导出已经更正，它改动的文件被复制进同一份副本，然后应用那一行又运行了一次；其他三行没有再运行。

被跳过的用例对照 Git 历史检查夹具来源，而副本没有 Git 历史。运行时那一行收集了 88 个 spec 文件，而它的文件夹中有 90 个。 SOURCE：`vitest.config.ts` 在 Linux 以外的任何平台上都会排除其中两个（`const nonLinuxWebWorkerTests = process.platform === 'linux'`，列出 `packages/experimental/webworker-runtime/tests/node/fs-watch-stream.spec.ts` 和 `packages/experimental/webworker-runtime/tests/node/sandbox-stack.spec.ts`，并有 `exclude: platformUnsupportedTests`），而这次运行是在 macOS 上。

## 失败的用例

在每个套件的最后一次运行中，共有 90 个用例失败。其中 89 个列在 [KNOWN-RED-TESTS.zh.md](KNOWN-RED-TESTS.zh.md) 中，每个文件的数量与那里所列相同。`server/` 中：`absence.test.mjs` 9 个，`memory.test.mjs` 3 个，`predict.test.mjs` 6 个， `recall.test.mjs` 50 个，`receipts.test.mjs` 6 个，`receipts-policy.test.mjs` 3 个，`read-limits.test.mjs` 1 个（文件无法加载）。边缘端：`deploy-workflow.test.mjs` 4 个，`worker.spec.ts` 5 个。运行时：`organ-entry-states.spec.ts` > "her real head > every stored ball of mirror/home/auma/HEAD.json: her two misnamed organs say so, one support module, the rest running"，以及 `scion-growth.spec.ts` > "attaches bounded gateway model headers without consuming an open SSE response"。每条命令都会打印它失败的每个用例名称。

第 90 个不在那份清单上，现在已列入： `packages/experimental/webworker-runtime/tests/node/node-stubs.spec.ts` > "not-implemented stubs > execa refuses 1 called symbol(s)"。尚未调查；导出没有改动这个 spec 和它测试的桩（SOURCE）。

应用那一行的第一次运行还多失败了一个用例，它是由导出本身造成的： `packages/client/ui-layout/tests/media-drive-registration.client.spec.tsx` > "Media and Documents, registered by the portal > G2 the portal injects the files door into Media and the files scope sets and clears it"。导出重命名了门户的槽位 id，而这个测试仍按旧 id 查找 Media 槽位。现在导出也会重命名这次查找，并拒绝树中残留的任何旧槽位 id。在应用那一行的第二次运行中，没有用例失败。

清单上没有一行通过。清单上有四行不在上面的命令范围内，没有运行：`scripts/ci-workflow.spec.ts`、 `.github/issue-management/policy.test.mjs`，以及 `apps/web/src/spatial/superagent/` 中的两个 superagent 文件。

## 本地宿主的回答

未登录时：`GET /` 返回 200 和应用的 `index.html`（960 字节）；`GET /recovery/` 返回 200，"Auma recovery"。 `/_head/status`、`/_host/lifecycle`、`/_mirror/status`、`GET /_host/owner-key`、`POST /_host/owner-grant`、 `POST /door/anthropic/v1/messages` 和 `GET /door/deepseek/v1/models` 返回 403，"Missing or invalid session capability"。宿主没有公开的健康或构建戳路由（SOURCE）。使用副本自己的会话能力（未记录）时：`/_head/status` 给出上面的 ball id，纪元 1；`/_host/lifecycle` 给出阶段 `running`；`/_host/runtime-assets` 给出 104 个文件，`buildPhase` 为 `complete`；`/_head/runtime` 给出选择错误 `PEARL_QUALIFICATION_UNVERIFIABLE`。

## 这次运行没有覆盖什么

- 没有浏览器会话。应用的 HTML 只被获取，从未被打开或查看。
- 没有部署到 Cloudflare，没有 wrangler，没有网络：安装是离线的。
- 没有模型调用。门请求在调用任何提供方之前就被拒绝。
- 没有 passkey 仪式，没有 AUMLOK 注册，没有所有者登录。所有者的值是编造的。
- 只有一台机器。没有测量速度或负载，也没有运行 `pnpm run x6:build`。
