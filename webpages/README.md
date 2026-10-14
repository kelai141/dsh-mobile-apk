# webpages —— 面向 C 端的发布页站点

静态站点，部署到 GitHub Pages，供用户下载 APK。自动识别设备架构，自动挑选下载线路。

## 定位与边界

- 只做**分发页**：不托管安装包字节，下载链接直接指向 GitHub Releases（及加速镜像）。
  因此 Pages 的 100 GB/月软带宽限制与用户量基本脱钩（页面仅约 34 KB）。
- **不碰** gradle / 快照 / LFS / 打包链。工作流只做「读 release 元数据 -> 生成静态站 -> 部署」，整链约 30 秒。
- 零第三方脚本、零 Cookie、零统计（GitHub Pages 禁止用途条款要求不得收集用户数据）。

## 目录

```
webpages/
  src/index.html            页面模板（含 __STYLES__ / __RELEASE_DATA__ 两个构建期占位符）
  src/assets/styles.css     样式（令牌照抄 dsh ui-theme，见文件头）
  src/assets/release.js     发布源拼接与架构判定的唯一真源（浏览器与 Node 共用）
  src/assets/app.js         首屏交互
  src/manifest.webmanifest  PWA 清单（display: browser，不劫持安装体验）
  tools/build.mjs           构建：内联样式与数据 -> dist/
  tests/release-url.test.mjs 命名与 URL 拼接门禁（绑定发布链产物名）
  data/releases.json        种子数据：GitHub API 不可用时回落
  dist/                     构建产物（不入库）
```

## 数据流

```
push webpages/**  --+
workflow_dispatch --+--> node tools/build.mjs --> dist/ --> upload-pages-artifact --> deploy-pages
release 完成      --+
```

发版后自动刷新走 `workflow_run: release/completed`，**无需改动 release.yml 一行**。

页面运行期的数据优先级：

1. **HTML 内联数据**（构建期写死）——首屏零额外请求；
2. `api.github.com` 后台校验（失败静默）——只提示有新版，不擅自改下载目标；
3. `data/releases.json` 兜底。

为什么内联是主源而不是纯前端拉 API：实测 `api.github.com` 未认证额度为 **60 次/小时/IP**，
而 C 端用户大量共享 CGNAT 出口 IP，被限流是常态。实测中本站构建机就被限流到 403，
页面仍完整渲染——这正是该设计要保住的性质。

## 架构识别与"暂无支持版本"

判定优先级与 App 侧 `UpdateChecker.abiFrom` 同源，但**多一档"判不出"**：

| confidence | 触发条件 | 界面行为 |
|---|---|---|
| `certain` | `userAgentData` 的 architecture+bitness 等明确信号 | 直接给对应安装包 |
| `likely` | 只有 32 位字符串线索（如 `Linux armv8l`） | 按主流机型给 arm64，并提示可"换架构" |
| `unknown` | 毫无线索（桌面浏览器 / reduced UA） | **不猜**，直接列出两个架构供选择 |
| `unsupported` | 明确 32 位（`architecture=x86,bitness=32`）或异构架构 | 报"暂无支持版本" |

为什么 `armv8l` 兜底为 arm64 而不是判不支持：arm64 手机上的浏览器常把它报成 32 位用户态字符串，
若判不支持，**主流机型**会看到"暂无支持版本"——对 C 端分发页是不可接受的假阴性。

一个必须知道的事实：两个 APK **都没有 `lib/<abi>/` 原生库**，架构差异全在 `assets/snapshot.tar.xz` 里，
所以装错架构**不会**被系统拒绝，而是在运行期以"引擎起不来"的形态炸掉。因此自动识别是主防线，
但必须同时给出手动出口（"换架构"），两者缺一不可。

## 命名门禁（本目录最有价值的一条判据）

`tests/release-url.test.mjs` **直接读发布链源码**（`.github/workflows/release.yml` 与
`scripts/build-apk-013.ps1` 的 `--artifact-name`），与站点的资产名形态逐字比对：**发布链改名即判红**。

真因：arm64 资产名在线发布史上翻转过（`v0.14.2-fx-2` 及更早是 `-arm64-v8a.apk`，`v0.14.2-fx-3` 起是
`-arm64.apk`；`x86_64` 两条链同名故不可见）。App 侧因此有过真实缺陷（`docs/AGENTS/gotchas.md` 坑 172）。
网页若按字符串臆造资产名会重演该缺陷，且症状更隐蔽：页面正常显示、按钮可点，只是下载 404。
故站点**从 release 的真实 assets 清单里挑**，候选名清单与 App 侧 `assetNameCandidates` 同构。

## 本地运行

```bash
node --test webpages/tests/release-url.test.mjs   # 门禁
node webpages/tools/build.mjs                     # 构建到 webpages/dist/
node webpages/tools/build.mjs --refresh           # 同时刷新 data/releases.json 种子
```

部署：`.github/workflows/pages.yml`（push main 的 webpages/**、release 完成、手动 dispatch）。

## 验证范围（如实说明）

本目录是**网页**，不适用壳侧 `docs/AGENTS/emulator-test-protocol.md` 的三层验收（CDP/ADB 层无从谈起）。
替代判据与已完成证据：

- **代码层**：命名门禁 25 项全绿（含受控负控，证明门禁仍会判红）；
- **渲染层**：CDP 设备仿真覆盖竖屏 390x844 / 横屏 844x390 / 深色 / 桌面判不出 / 32 位不支持 五种形态，
  逐形态核对界面文案与下载 URL；
- **网络层**：真实网络下镜像测速与资产直链实测（`HEAD` 200 / `content-length` 158453224 / `accept-ranges: bytes`）；
- **性能**：首屏 FCP 约 208 ms（本地静态服务），首屏仅 1 个文档请求，`index.html` 约 12 KB。

**未覆盖**：真机浏览器（Android Chrome / 微信内置浏览器 / 国产浏览器）实测、Pages 线上真实部署后的
可达性与自定义域名。前者建议在正式对外前补一次，后者待 Pages 开启后验证。
