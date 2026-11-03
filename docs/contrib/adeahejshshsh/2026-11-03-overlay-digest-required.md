# overlay 包缺 sha512 时不得接受远端字节（2026-11-03，issue #1415）

## 现象

`build-snapshot-013.mjs` 的 `overlayTgz()` 下载 overlay 包后这样校验：

```js
if (dist.sha512 && createHash('sha512').update(buf).digest('base64') !== dist.sha512) {
  throw new Error(`overlay sha512 不匹配: ${name}@${version}`)
}
```

镜像或代理不返回 `dist.sha512`（或只给 `integrity=sha1-…`）时，`&&` 左边为假 → 整段短路 →
**未校验的 tarball 被解压进引擎树**。overlay 覆盖 220 个包，一个被投毒的 tarball 就是一次
出厂级后门，而构建日志里没有任何异常。

## 真因

把「校验」写成了「有摘要才校验」。缺摘要只说明镜像不规矩，不说明内容可信——这两件事被混成了
一个布尔表达式。另一处同源问题：npm 的 SRI 写法 `integrity: "sha512-<base64>"` 从未被解析，
正规镜像给这种形态时同样零校验。

## 修法

判据抽成 `scripts/lib/overlay-integrity.mjs`（纯函数，`expectedSha512` + `assertOverlayDigest`）：

- `dist.sha512` 在场 → 用它比对；
- 只有 `dist.integrity` → 解析 `sha512-<base64>` 比对（混着 `sha1-…` 也能挑对那条）；
- 两者都没有 → **抛错**，构建链据此拒打包。

`build-snapshot-013.mjs` 的 `overlayTgz` 改为一行 `assertOverlayDigest(dist, buf, label)`。

为什么抽成模块：原来这条判据内联在构建脚本里，只能靠「真的跑一次双 ABI 全链」来验（要 WSL，
十几分钟），于是没人给它写负控。纯函数后毫秒级可测。

## 复验

新增 `scripts/overlay-integrity.test.mjs`（5 例）：sha512 匹配放行 / 不匹配拒绝 / `integrity`
回落 / 混有 sha1 时挑 sha512 / 两种摘要都缺时拒绝（含只有 sha1 的形态）。

改前形态用同一份输入跑旧判据（内联 `if (dist.sha512 && …)`）得到 `ACCEPTED`——缺陷成立；
改后 `assertOverlayDigest` 抛「overlay 缺少完整性摘要」。5 例在改后全绿。

- `node scripts/check-code-map.mjs` → PASSED（`build-snapshot-013.mjs` 的锚点因顶部新增 1 行
  import 整体 +1，按行手钉并补 `#expect`；未刷基线）。
- `node scripts/check-release-gates.mjs` → 除「构建/门禁脚本全部可解析（node --check）」外全 PASS；
  该项在本机恒红（`process.execPath` 指向 Android 动态链接器，issue #421 第 12 条），CI 上执行。
  其中「scripts/lib 公共模块均有真实消费者（12 个模块，豁免 0 个）」确认新模块有消费者。
- **未做设备验证**：纯构建链脚本，不涉及设备面。
