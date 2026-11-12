# 实际架构

[English](ARCHITECTURE-ACTUAL.md) | 中文

本页钉住文件和符号。它不描述一次现场部署。**UNPERFORMED.** 这里没有记录工作者、本地宿主或 Cloudflare 的启动。别人报告的本机运行是 **REPORTED RUN**。

## 浏览器 WebWorker

**SOURCE.** `connectWorkerHost` 在 `packages/experimental/webworker-runtime/src/client/index.ts`。球清单和变更在 `packages/experimental/webworker-runtime/src/x6/ball-loader.ts`。

**SOURCE.** `computeBallId` 对 `{ version, parentBallId, epoch, entries, modules }` 做 `JSON.stringify` 再哈希。条目和模块的键被排序。每个值内部的键序保留。`version` 是字符串 `x6.1-ball/v1`。

**SOURCE.** `completeMutation` 调用 `seed-receipts`，`action: 'append'`，从而追加收据。kind 是变更种类（在各调用点，种类为 `tree.patch`、`tree.undo`、`snapshot.restore` 或 `seed.bootstrap`）。数据对象是 `{ entryId, ballId, parentBallId, epoch }`。这次调用的 kind 不是 `ball.promote`。

**SOURCE.** 页面读出用 `POST /__x6__/call-tool` 读状态。该约定写在 `apps/web/src/spatial/superagent/contract.ts` 的文件头。读出不再开第二个会话。

## 本地宿主

**SOURCE.** `server/local-host.mjs` 是 Node 宿主。它从 `server/ball-head.mjs` 导入 `createBallHeadStore`。模型门处理从 `pathname.startsWith('/door/')` 开始。

**SOURCE.** `server/ball-manifest.mjs` 定义 `legacyManifestPreimage` 和 `validateManifestStructure`，由本地与 Cloudflare head 适配器共享。哈希原像保留 `computeBallId` 的字段顺序和嵌套键顺序。结构验证保留首个失败码并接受未知字段。`server/ball-head.mjs` 保持同步哈希，接受旧式摘要或 `manifestIdCanon`；后者对除 `ballId` 外的每个字段做排序键 JSON 再哈希，并省略值为 undefined 的对象字段。

**SOURCE.** `server/ball-head.mjs` 的 `publish`拒绝候选，除非 `ball.parentBallId` 是当前所选球且 `ball.epoch` 是所选纪元加一。失败码是 `REBASE_REQUIRED`。同一函数还要求写者租约。`validateManifest` 和 `publish` 里没有 Ed25519 检查。

## Cloudflare DO 镜像

**SOURCE.** `deploy/cloudflare/src/worker.mjs` 把 `/door/` 交给 `providerDoor`，并把 `/_head/ball`、`/_head/lease`、`/_head/ws` 转到 head 绑定，并把镜像路由转到镜像绑定。

**SOURCE.** `deploy/cloudflare/src/head-do.mjs` 使用共享的哈希原像和结构验证器，保持异步哈希与验证。其 `manifestIdCanon` 保留 `canonicalBootstrap`，即用于种子身份、由 `deploy/cloudflare/src/mirror-do.mjs` 导入的有界排序键遍历。与本地规范化遍历不同，它拒绝 undefined 值、非有限数字以及超限结构。这两种规范化策略保持独立。共享模块不执行哈希、存储或授权；head 选择、写者租约和持久化仍由适配器负责。这些文件不读取 Ed25519 清单签名。

## 模型门

**SOURCE.** `packages/experimental/webworker-runtime/src/model-doors.ts` 列出供应商前缀，其中包括把 `https://api.deepseek.com/` 映射为门名称 `deepseek`。`modelDoorFor` 把匹配的 URL 改写成 `{origin}/door/{name}/...`。

**SOURCE.** 本地宿主和 Cloudflare worker 都有 `/door/` 路径，上文已引用。本页不声称观察到这两扇门注入过密钥。本地宿主的文件头说凭据留在仓库之外。本页不抄写那条文件系统路径。

## 收据与检查点

**SOURCE.** `mirror/home/auma/seed/organs/seed-receipts.js` 的 `append` 写入带 `prevHash` 和 Merkle 叶子的 `aukora.receipt.v3`。它不签名那一行。`checkpoint` 用 Ed25519 签名 `aukora.x5.edge-head.v1`、一个 NUL、以及检查点正文的规范 JSON。读出把两把公钥钉在 `apps/web/src/spatial/superagent/authority.ts` 的 `PINNED_RECEIPT_SIGNERS`，并且不把文件里带来的钥匙加入该集合。

**SOURCE.** 已提交的 `mirror/home/balls/HEAD.json` 是创世球头：纪元 1，没有父球，每个种子器官一个条目、一个模块。仓库里没有已提交的收据或检查点；节点在运行时写入 `receipts.v3.jsonl` 和 `checkpoints.v1.jsonl`。这些是检出字节，不是对活动宿主的观察。

## 提议中的清单签名

**PROPOSED.** `apps/web/src/spatial/superagent/manifest.ts` 里的读出辅助函数检查下面这个封套。**UNPERFORMED.** `server/ball-head.mjs` 和 `deploy/cloudflare/src/head-do.mjs` 不接受也不要求它。辅助函数通过并不等于发布了一个球。

```json
{
  "schema": "aukora.x6.manifest-signature.v1",
  "ballId": "<64 lowercase hex>",
  "idForm": "loader",
  "publicKeyHex": "<64 lowercase hex>",
  "signatureHex": "<128 lowercase hex>"
}
```

`idForm` 是 `loader` 或 `canon`。被签名的消息是 `aukora.x5.edge-head.v1\0` 的 UTF-8，加上该形式的前像。`loader` 是 `computeBallId` / `manifestId` 那条字符串。`canon` 是 `manifestIdCanon` 那条字符串。`ballId` 必须等于该前像的 SHA-256。辅助函数只信任调用时传入的钥匙列表。默认列表是两把钉住的收据签名者。写在清单上或封套里的钥匙不会被加入。没有封套时，`unsigned-optional` 返回 `verified: false` 且状态为 `unsigned`。没有封套时，`strict` 返回状态 `missing`。两种状态都不是已核验。

**SOURCE.** 同一文件里的 `monotoneParent` 给宿主规则起了本地名字：父标识等于所选球，纪元等于所选纪元加一。服务器仍然报告 `REBASE_REQUIRED`，而不是这些本地原因字符串。
