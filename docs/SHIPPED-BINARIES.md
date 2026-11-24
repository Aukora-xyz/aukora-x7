# Shipped binaries

The table gives the byte size and SHA-256 of the listed prebuilt browser assets. Rows marked "no matching source here" are prebuilt and cannot be rebuilt from this repository. The listed cell recipes have source in this tree and use the pinned, prebuilt Skillsmith compiler; a recipe in the table does not mean the binary was rebuilt. The sizes and digests were recomputed from this tree when it was assembled.

| Path | Bytes | SHA-256 | Matching source or build recipe |
|---|---:|---|---|
| `apps/web/public/app/assets/decoderWorker.min.wasm` | 149534 | `cd1d29c43b3fa05719c3d024ed9b9f1528be92415bd6d39d413b262a61d1891f` | no matching source here (third-party audio codec worker) |
| `apps/web/public/app/assets/encoderWorker.min.wasm` | 149534 | `cd1d29c43b3fa05719c3d024ed9b9f1528be92415bd6d39d413b262a61d1891f` | no matching source here (third-party audio codec worker) |
| `apps/web/public/assets/stock-apps/dakini-code/assets/index-C2MMIvhO.css` | 149512 | `894bc70bd3165115b62cc0ef1b0d4c77a75bee34b301cb7673d55d23c74243b1` | no matching source here |
| `apps/web/public/assets/stock-apps/dakini-code/assets/index-t74FFCZZ.js` | 315451 | `86a20f0b66960990c79758b07506c9148e2bb66adac3951bc1ed5dd2fb16a2dc` | no matching source here |
| `apps/web/public/assets/stock-apps/dakini-code/assets/space-Bu4O81zr.js` | 590245 | `e31cc0bffed35a44b03c9aba5a1b7d9c1673cab72578b9c605d2918e06894e4a` | no matching source here |
| `apps/web/public/cells/aukora-kernel.wasm` | 188414 | `a543fa06b6c4a0d806627437ca766c55caf4be4ebd8e8f86ebee13b71ab6017a` | no matching source here |
| `apps/web/public/cells/aumlok-identity.wasm` | 638574 | `daf2b514917a673d53d9cd5d561c748914880f6267a3928011c87d4bdd6b89fc` | no matching source here |
| `apps/web/public/cells/aumlok-keys.wasm` | 302458 | `d4f9f3b435c26547f840e215d491102bf65dc71ffc92584c680c3637ba7d5735` | no matching source here |
| `apps/web/public/cells/aura-focus.wasm` | 12545 | `e3e617dcb04bb449908b019af607427383ef173356a000341c3fe3db4b9491a8` | `server/aura-focus-cell.build.mjs` |
| `apps/web/public/cells/aura-relay.wasm` | 464665 | `4eee340aac9781c5b2d79f67ddaceaa12942cdf976ea4c00cd0e8062b4b0d5eb` | no matching source here |
| `apps/web/public/cells/cord-echo.wasm` | 13530 | `9d5935d3c5062bb440c62489144ddce820659839b46cf22b8713316d5b5132fa` | `server/cord-echo-cell.build.mjs` |
| `apps/web/public/cells/gate-judge.wasm` | 126327 | `784f03150df3f9282bb4b2f66a4ae1ce90eaa559c781e197c932439583d17b7e` | no matching source here |
| `apps/web/public/cells/goal-receipts.wasm` | 199380 | `b899e987b0aab0f0852e57268271b757c16495e30526288505fd8bcbc002c00a` | no matching source here |
| `apps/web/public/cells/grant-ledger.wasm` | 250384 | `ed8e7c10b181c3019a6e850d99c02e0e198710402f9cc87bc6ac25c09776ccd6` | no matching source here |
| `apps/web/public/cells/kira-core.wasm` | 160671 | `4d1be5b5eb8cb2ba943cac58aff3e5ad46f3c3e779af3cc3c1778282f32caa3e` | no matching source here |
| `apps/web/public/cells/kira-membrane.wasm` | 228666 | `09fb8324bdb537dbc986da7eaee5f72209235d2bef1f88e46c08ad5abf884c92` | no matching source here |
| `apps/web/public/cells/kira-nostr.wasm` | 435590 | `3d9f71ddef4d3d91a2676269687283e092b0f8565fef772cfc8626bd446df767` | no matching source here |
| `apps/web/public/cells/kira-resume.wasm` | 167716 | `2ec1321ab07b4ceb33182dbd18cf8b7a5b162e07ce5a74d0b5aa750061874f45` | no matching source here |
| `apps/web/public/cells/kira-store-policy.wasm` | 331409 | `d8c1a74d4298b8f419934b2beefc50a6042cd0532945b2cd693bec08fa930e8c` | no matching source here |
| `apps/web/public/cells/kyber-cpu.wasm` | 9750 | `dcbd53f9cfb2d55753c07ee182dd7f247b32ae0e3f08b568b1266339ce92ee14` | `server/kyber-cpu-cell.build.mjs` |
| `apps/web/public/cells/lane-contract.wasm` | 97854 | `d8f04fd101cb711ead3ce11dea06c21de016da527d1c9320ba4803a849302b28` | no matching source here |
| `apps/web/public/cells/lane-judge.wasm` | 144344 | `5b998f76fc63daf964d4d1dd6f9d995cef8114fa1f9f30d312640357e5241aea` | no matching source here |
| `apps/web/public/cells/lane-profile.wasm` | 133392 | `f6917e45ca0d8009be4bc3a7b4104f84926a5e66816270129acd39c6631c6109` | no matching source here |
| `apps/web/public/cells/laya.wasm` | 187260 | `c3bf50eaf97a0f7f9eb7c3d56ab0be2b42062cb88c733bc6121ac21537643db5` | no matching source here |
| `apps/web/public/cells/menger-hive.wasm` | 25300 | `80fba1f9ea6de88c9618429044dfb1d04693696c4125e55b53fe8e69ca6e99c6` | `server/menger-hive-cell.build.mjs` |
| `apps/web/public/cells/nostr-core.wasm` | 757615 | `1b00e08461e6c2e9a99e5d32a93389d633aeb776a5d3e4a3e2b173cd6ce82530` | no matching source here |
| `apps/web/public/cells/nucleus.wasm` | 24654 | `4b85c891e9e9796665b12a7adb196cb1b48e609b12b6a94264f0e56596e8a703` | `server/nucleus-cell.build.mjs` |
| `apps/web/public/cells/organism-tools.wasm` | 368213 | `e647338d059f57e78d8827249303b1552fdd7335f80ab13a122c170f2a0a7e96` | no matching source here |
| `apps/web/public/cells/pair-judge.wasm` | 164343 | `b62500b472e9c2c5be185484541b3bea17c032c72feb2193555b96be2163959f` | no matching source here |
| `apps/web/public/cells/pentora-codec.wasm` | 104972 | `1c865fe9069b01277ad54450be4a9123007bcb6f39cf0962e777662edcb3811b` | `server/pentora-codec.build.mjs` |
| `apps/web/public/cells/prompt-assembly.wasm` | 122292 | `4cb8b80b04145cf12d5024ab4410f0b64d6d58e686f912890e22f5d0b3ca22e7` | no matching source here |
| `apps/web/public/cells/risk-signature.wasm` | 177342 | `abd15946427dbb882f1f3706e403362606591361264ccc63832d2bc2b8e895fa` | no matching source here |
| `apps/web/public/cells/seed-judge.wasm` | 95688 | `382edfbca89a2ae1959cb4b45449250ce01454c56af8fb2fdbe28eb9c3c0317b` | no matching source here |
| `apps/web/public/cells/skillsmith.wasm` | 592220 | `35cd471bcf029cc1f437803f6799b5469e525e83f113e5c775f95935e5ed24fa` | no matching source here |
| `apps/web/public/cells/spatial-layout.wasm` | 153348 | `1ab74435ddfaf4beb0c517d12e5374989a5864541d08226be350f694579f7e45` | no matching source here |
| `apps/web/public/core-cell/aukora-core-lite.wasm` | 679046 | `2f10eb8fd9adb3f25d854b642bba29ceaadcbcb2cc40a2fb05fca51f770b59e9` | bundled v0.8 build source in `aukora-core/v0.8/tools/`; an independent rebuild is not yet confirmed |
| `apps/web/public/seed-library/pentora/pentora36.wasm` | 64892 | `6e74ab85c86ba952432fead3b9cf120eadeb33004e243aa3ea4330398092d036` | no matching source here |

The bundled `aukora-core/` snapshot contains 2,737 files, including 877 binary files (Wasm files, serialized Lean proof data and compressed fixtures) with 614 distinct contents. These counts cover the Core snapshot alone. See public Core for the documented rebuild of the two released v0.8 Wasm artifacts on the stated macOS setup; this is not a rebuild of all 877 binary files.

No tracked compiled binary or Git LFS pointer was found under `vendor/` or `native/`.
