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
release published --+
```

Publication refresh uses the `release: published` event after a draft becomes public. Site sources are checked out from the repository's default branch rather than the release tag. Draft creation alone does not refresh the site. Manual dispatch and site-source pushes remain supported.

### 线路（镜像）与版本解绑

靶是 `releases/latest/download/MANIFEST.txt`（约 1.4 KB 的稳定小文件），**不是当前版本的 APK**。
理由：把靶绑到当前版本资产上，一旦资产改名或该版本发布不完整，检查会整体失效、用户被钉死在默认线路上。
`probeUrl()` 与 `assetUrl()` 因此是两个独立函数。

**判活与测速是两件事，不可合并**（2026-10-15 实修，见 gotchas 301-305）：

- **判活**用 `<script>` 标签：它对 HTTP 错误状态可靠触发 `onerror`、对 2xx 触发 `onload`，且不受 CORS 限制。
  代价是**会真正加载响应体**，所以靶必须是小文件（换成 APK 就是 150 MB）。
- **测速**用 `fetch(mode:'no-cors')` 打**真实资产** URL，到响应头到达即 `abort`（不消耗 150 MB 流量）。
  为什么不复用判活的耗时：MANIFEST 由 `github.com` 直接回，而 APK 会重定向到
  `release-assets.githubusercontent.com`，是**另一条链路**，两者首字节延迟不同源。

**`fetch(mode:'no-cors')` 绝不能用来判活**：它拿到的是不透明响应，**读不到状态码**——
403 与 200 在探针眼里完全一样，而 403 回得更快，于是死线每次都被选成"最快线路"。

**已知局限（如实记，勿当已解决）**：测的是 TTFB，不是**吞吐**。静态页在 `no-cors` 下拿不到响应体，
无法真正测下载速度，因此"首字节快、后续慢"的线路仍可能被排前；用户可手动切换，这是该局限的兜底。
排序时 `ms<=0`（可达但没测到速度）一律排到最后，否则 `0` 会被当成最快。

线路选择器是**独立组件**，在"架构未知""该版本无匹配资产"等任何状态下都可用，与实际下载的版本无耦合。

### 页面运行期的数据优先级

1. **HTML 内联数据**（构建期写死）——首屏零额外请求；
2. `api.github.com` 后台校验（失败静默）——只提示有新版，不擅自改下载目标；
3. `data/releases.json` 兜底。

为什么内联是主源而不是纯前端拉 API：实测 `api.github.com` 未认证额度为 **60 次/小时/IP**，
而 C 端用户大量共享 CGNAT 出口 IP，被限流是常态。实测中本站构建机就被限流到 403，
页面仍完整渲染——这正是该设计要保住的性质。

## 搜索引擎可见性（SEO）

爬虫需要的东西全部由构建期产出，且**不需要 JS**：

- `<title>` / `description` / `keywords` / `canonical` / `robots`（`index, follow`）/ Open Graph / Twitter Card；
- **JSON-LD**（`schema.org` 的 `WebSite` + `SoftwareApplication`，含每个架构的 `downloadUrl`、
  `fileSize`、`sha256`）。只声明**确有其资产**的 downloadUrl —— 声明一个 404 比不声明更糟；
- `robots.txt`（显式 Allow + 声明 sitemap）；
- `sitemap.xml`。

**一个已修的真实缺陷**：早期版本的 `robots.txt` 声明了 `Sitemap: .../sitemap.xml`，
但构建脚本**从不生成该文件**，爬虫取到 404——站点自己给自己制造坏信号。
现在两者由同一次构建产出，并有门禁守着（`sitemap.xml 与 robots.txt 由同一次构建产出`）。
宿主机 `kelai141.github.io/robots.txt` 不存在，因此**无法**从上层目录声明 sitemap；
这是 GitHub Pages 项目站的固有限制，不影响收录（站点自身的 robots 与 sitemap 均可访问）。

正文另有 `关于 dsh-mobile` / `该下载哪个架构` / `安装说明` / `常见问题` 四段静态文字，
不依赖 JS 渲染即可被抓取，同时服务真人用户。

提交站点到搜索引擎（可选，提升收录速度）：**Google Search Console** 与 **Bing Webmaster Tools**
均可添加 `https://kelai141.github.io/dsh-mobile-apk/`；但 GitHub Pages 用户**无法**验证域名所有权，
只能验证 URL 前缀（部分功能受限）。百度对 `github.io` 收录普遍较差，且不提供前缀验证，
如需百度收录需自有域名。

## 架构识别与"暂无支持版本"

判定优先级与 App 侧 `UpdateChecker.abiFrom` 同源，但**多一档"判不出"**：

| confidence | 触发条件 | 界面行为 |
|---|---|---|
| `certain` | `userAgentData` 的 architecture+bitness 等明确信号 | 直接给对应安装包 |
| `likely` | 只有 32 位字符串线索（如 `Linux armv8l`） | 按主流机型给 arm64，并提示可"换架构" |
| `unknown` | 毫无线索（桌面浏览器 / reduced UA） | **不猜**，直接列出两个架构供选择 |
| `unsupported` | 明确 32 位（`architecture=x86,bitness=32`）或异构架构 | 报"暂无支持版本" |

线路选择器在**任何**状态下都可用（含"架构未知""该版本无匹配资产"），并会**停用不可达的线路**：
死线按钮 `disabled` 并显示"（不可用）"，当前线路若被判死则自动换到最快可用线路。
点"下载"时若该线路本会话内尚未确认健康，会先做一次小文件判活再跳转——
把用户送到 403 错误页是最伤的失败形态（包 150 MB，失败一次代价很高）。
探测在环境不支持时（无 `document.head`）判为"未探测"而非"探测失败"，**不标死线**，
否则会把四条线路全部误标为不可用。

线路选择器在**任何**状态下都可用（含"架构未知""该版本无匹配资产"），并会**停用不可达的线路**：
死线按钮 `disabled` 并显示"（不可用）"，当前线路若被判死则自动换到最快可用线路。
点"下载"时若该线路本会话内尚未确认健康，会先做一次小文件判活再跳转——
把用户送到 403 错误页是最伤的失败形态（包 150 MB，失败一次代价很高）。
探测在环境不支持时（无 `document.head`）判为"未探测"而非"探测失败"，**不标死线**，
否则会把四条线路全部误标为不可用。

另有两条桌面/兼容规则，都是实测缺陷驱动：

- **桌面系统（Windows / macOS / ChromeOS）一律判 `unknown`**，即使 UA 里写着 `Win64; x64`。
  真因：PC 访客要装的是**手机**，而那台手机的架构在 PC 上无从得知；按 UA 判会把 PC 访客
  引到**模拟器专用**的 x86_64 包上。桌面下唯一诚实的答案是"请选择设备架构"。
  注意 MuMu 等模拟器**内部浏览器**是 Android UA，不走这一支，其架构由 `userAgentData` 的
  `architecture=x86` 确定（结构化字段优先于 UA 兜底）。
- **`architecture` 有值但 `bitness` 为空时不再丢信号**：Android 16 上的 Chromium 系
  （含夸克、H 浏览器）常只给 architecture。旧实现把 `arm` + 空 bitness 一路落到"无线索"，
  真机于是看到"未能识别设备架构"，而 PC 端正常——正是该缺陷的可识别特征。
- **`platform='Linux'` 且无任何架构线索时兜底 arm64**：这是手机浏览器的典型形态
  （Windows/macOS 不会是 'Linux'，真 Linux 桌面几乎必带 x86_64/aarch64）。

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
- **渲染层**：CDP 设备仿真覆盖竖屏 / 横屏 / 桌面（请选择架构）/ 夸克类无架构线索 / 32 位不支持 等形态，
  逐形态核对界面文案与下载 URL；
- **网络层**：真实网络下镜像测速与资产直链实测（`HEAD` 200 / `content-length` 158453224 / `accept-ranges: bytes`）；
- **性能**：首屏 FCP 约 208 ms（本地静态服务），首屏仅 1 个文档请求，`index.html` 约 12 KB。

**未覆盖**：真机浏览器（Android Chrome / 微信内置浏览器 / 国产浏览器）实测、Pages 线上真实部署后的
可达性与自定义域名。前者建议在正式对外前补一次，后者待 Pages 开启后验证。