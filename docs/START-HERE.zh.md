# 从这里开始

[English](START-HERE.md) | 中文

Aukora 是这个检出里的产品方向：一个面向用户所有、本地优先的环境，让 AI 能修改自己的模块，并展示改了什么。这个名字下面的代码是 DeepSeek Harness（全插件智能体运行时）和 Cordis（这些插件所运行的插件系统）。**SOURCE.** 这是对 `README.md`、`AGENTS.md` 和 `vendor/cordis` 的阅读。**PROPOSED.** “用户所有”和“带可核验连续性的自我修改”是目标。它们不是运行中系统已被测量的性质。

一个球可以放在三个地方，或从那里发布。浏览器跑一个 Web Worker。本机的 Node 进程提供服务。Cloudflare Worker 把请求转到 Durable Object。第四扇门是工作者把模型供应商 URL 改写到 `/door/<name>/` 的路径。这是四种角色，不是一个进程，本页也不声称它们曾被一起启动。**UNPERFORMED.** 这里没有记录现场本机部署或浏览器内检查。作者对本机 Node 进程的一次启动（未登录，没有浏览器）记录在 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 中；它是一次 **REPORTED RUN**（这份记录属于较早的一棵树）。别人报告那些运行时，标成 **REPORTED RUN**，不要标成 **OBSERVED RUN**。

球是一组内容寻址的模块包。器官是包里的一个 Cordis 插件条目。纪元是清单上的整数版本。收据是哈希链上的一行只追加记录。Ed25519 检查点认证这条链的一个前缀。收据行本身不是签名。**SOURCE.** `seed-receipts.js` 用 `prevHash` 和 `leafHash` 追加叶子。签名发生在检查点动作。宿主发布球时检查内容哈希，以及父球正好前进一个纪元。它不检查 Ed25519 清单签名。**PROPOSED.** 该签名封套写在 `ARCHITECTURE-ACTUAL.md`。服务器对它的强制执行是 **UNPERFORMED**。

接下来读：实际文件地图（[ARCHITECTURE-ACTUAL.zh.md](ARCHITECTURE-ACTUAL.zh.md)），然后术语表（[GLOSSARY.zh.md](GLOSSARY.zh.md)）。

## 四种角色

```text
Browser WebWorker          Local Host                 Cloudflare DO mirror         Model Door
ball-loader.ts             server/local-host.mjs      deploy/cloudflare/src/       model-doors.ts
connectWorkerHost          server/ball-head.mjs       worker.mjs, head-do.mjs,     /door/<provider>/
                                                      mirror-do.mjs
```

**SOURCE.** 上面的文件名在本检出中。文件和符号的位置在 [ARCHITECTURE-ACTUAL.zh.md](ARCHITECTURE-ACTUAL.zh.md)。

## 包地图

| 路径 | 它是什么 |
|---|---|
| `vendor/` | 钉住的 Cordis 及其库 |
| `packages/` | `@deepseek-ai/dsh-*` 工作区 |
| `apps/web` | Web 前端，含 `src/spatial/superagent` |
| `server/` | 本地宿主、球头、预览构建 |
| `deploy/cloudflare` | Worker 以及 Durable Object 的头与镜像 |
| `mirror/` | 创世种子：球头、种子器官、Pearl 种子文件 |
| `docs/` | Harness 文档，加上阅读顺序里的 Aukora 页 |

**SOURCE.** 分组与 `AGENTS.md` 开头以及本检出的目录一致。这不是说每个包都属于 Aukora 产品表面。

## 五项风险

1. **SOURCE.** 根目录 `package.json` 写 `AGPL-3.0-or-later`。根目录 `LICENSE` 是 AGPL-3.0 文本。依赖的许可证另计。不要把其中一个文件当成对其余文件的重新许可。
2. **SOURCE.** `mirror/` 只含创世种子：球头、种子器官和两个 Pearl 种子文件。节点在运行时把自己的世界写在那里，`.gitignore` 让这个世界不进入仓库。
3. **SOURCE.** `HEAD.json` 上的父标识是一项声称。完好的推进边是哈希链链接，不是所有者确认。检查点不是通行密钥。后继球不继承 `owner-confirmed`。
4. **SOURCE.** 宿主发布要求子纪元等于所选纪元加一（`server/ball-head.mjs`）。收据日志并不对每种 kind 执行这条规则。不要假设纪元单调性处处成立。
5. **UNPERFORMED.** 本页没有记录已启动的浏览器或 Cloudflare 部署。本地宿主的一次启动作为 **REPORTED RUN** 记录在 [RUN-RECORD.zh.md](RUN-RECORD.zh.md) 中（这份记录属于较早的一棵树）。读出的单元测试填不上这个空缺。
