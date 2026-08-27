# dshmarketplace-plugin（vendored，已固化修复）

本目录是第三方插件 **dshmarketplace-plugin@0.1.5** 的 vendored 副本（上游：
<https://github.com/DshMarketPlace/dsh-plugins-store>，npm 包名 `dshmarketplace-plugin`，
MIT）。来源为 npm 发布的 `dshmarketplace-plugin-0.1.5.tgz`（解包即本目录，除
`lib/index.js` 一处修复外与上游逐字节一致）。

## 为什么 vendor（而非直接依赖 npm 版本）

版本 0.1.5 存在一个**全工具崩溃级缺陷**（设备实测，详见
`docs/review-0.13.0-20260823.md`）：

- 插件向 `tools/pre-execute` 注册的 listener 形如 `async t => { if(...) return; ... }`，
  即对**非安装调用、fullName 为空、安装完成**三条路径都直接 `return undefined` 且
  **不调用 waterfall 的 `next()`**。
- 结果：任何非 `dshmarketplace_install` 工具调用经 pre-execute 后
  gate=`undefined`，执行器读 `gate.kind` 抛
  `Cannot read properties of undefined (reading 'kind')` —— **全部工具全灭**。

上游 0.1.6 尚未发布修复，故 0.13.0 快照 vendored 本修复版本。

## 与上游的差异（唯一一处）

`lib/index.js` 中 `tt()`（pre-execute listener）：

| 行（minified 单行内） | 上游 0.1.5 | 本副本 |
| --- | --- | --- |
| 签名 | `async t=>{` | `async (t,n)=>{` |
| 非安装调用 | `return;` | `return n();` |
| fullName 为空 | `return;` | `return n();` |
| 安装完成尾部 | （无） | `});return n()` 追加 |

其余文件（`lib/client.js`、`package.json`、`cordis.patch.yml`、
`skills/dsh-plugin-store/SKILL.md`、README/LICENSE）与 0.1.5 逐字节一致。
校验方式：

```powershell
node scripts/patch-marketplace.mjs vendor/dshmarketplace-plugin/lib/index.js
# 输出 "already fixed (3/3 return n() 路径在场)——跳过" 且退出码 0 即为修复版
```

## 重新 vendor（上游出新版时）

1. 下载新 tgz：`npm pack dshmarketplace-plugin@<ver> --pack-destination .deploy-tmp/`
2. 解包到临时目录，比对修复：先 `node scripts/patch-marketplace.mjs <new>/lib/index.js`
   （上游若已修则直接输出 already fixed）；若未修则本脚本会就地打补丁并退出 0。
3. 覆盖本目录文件（保留本文件），更新版本号与差异表。
4. 回归：注入链测试（`verify-013.sh` 或设备端 `/api/undo/status` + 工具调用冒烟，
   见 `docs/review-0.13.0-20260823.md`）。
