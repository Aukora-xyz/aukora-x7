# 术语表

[English](GLOSSARY.md) | 中文

通俗说法写在项目用语旁边。这里的定义不是一项授权。

| 项目用语 | 通俗说法 | 标签 |
|---|---|---|
| 球 Ball | 一组内容寻址的模块包。标识是清单前像的 SHA-256。 | SOURCE: `computeBallId` 与 `manifestId` |
| 器官 Organ | 球里的一个 Cordis 插件条目（清单上的 `entries`）。 | SOURCE: 球条目记录 |
| 纪元 Epoch | 球清单上的整数版本字段。 | SOURCE: `x6.1-ball/v1` 上的 `epoch` |
| 收据 Receipt | 一行只追加的 JSON。它的叶子哈希链到上一行。这一行不必须被签名。 | SOURCE: `seed-receipts.js` 的 append |
| 检查点 Checkpoint | 对 Merkle 根和收据条数的 Ed25519 签名。它认证日志的那个前缀。它不是通行密钥。 | SOURCE: `seed-receipts.js` 的 checkpoint |
| 头 Head | `HEAD.json` 里被选中的清单。它的 `parentBallId` 是该文件上的字段，不是一次已检查的行走。 | SOURCE: `HEAD.json` 与读出 |
| 推进边 Promote edge | 收据数据 `{ ballId, parentBallId, epoch }`，出现在 `tree.patch`、`tree.undo`、`snapshot.restore`、`seed.bootstrap`、`ball.promote` 或 `ball.epochN`。 | SOURCE: 加载器 `completeMutation` 与收据日志 |
| 谱系 `promoted` | 从授予球到所选球的一条完好边路径，纪元每次加一，最后纪元等于头。它不把授权变成 `owner-confirmed`。 | SOURCE: `authority.ts` |
| 谱系 `head-claim-only` | 头的父字段点名授予球，且不存在唯一的完好边路径。 | SOURCE: `authority.ts` |
| 分叉 Fork | 两条完好的边离开同一父球，指向不同的球。读出不挑选其中一条。 | SOURCE: `promote-fork` |
| 授权 Mandate | 一份记录下来的工作范围授予。所有者确认是另一次检查。 | SOURCE: superagent 状态与 `mandate.grant` |
| 模型门 Model door | 模型 API 前面的同源改写 `/door/<provider>/`。 | SOURCE: `model-doors.ts` |
| 钉住的签名者 Pinned signer | 编译进读出的公钥。仅仅出现在文件里的钥匙不是钉住的。 | SOURCE: `PINNED_RECEIPT_SIGNERS` |

**SOURCE.** 宿主发布要求下一纪元正好大一（`server/ball-head.mjs`）。**SOURCE.** 收据器官在追加一行时不应用这条规则。单调性不是每份日志的性质。
