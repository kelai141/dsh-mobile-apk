# B 组：WebView 运行时资源审计

审计对象：安卓壳 + 内嵌 Termux 快照跑 dsh 引擎（Node，回环动态端口），WebView 加载引擎 Web UI。
本报告覆盖 WebView 侧运行时资源：首屏 JS 体积与解析/压缩成本、DOM 现场操作面、定时器与唤醒频率、日志写入量、图片缓存与内存。

**测量环境声明**：宿主为开发机，审计团队并发执行，CPU 互相抢占。所有计时都是**同机相对比较**，绝对值不可移植到设备；
所有字节/条目/调用点计数是静态计数，不受 CPU 抖动影响，是本文最硬的证据。计时一律跑 5 次取中位并报 min/max，每把尺子配负控（§负控汇总）。

**本轮无模拟器/真机**，因此没有任何设备侧实测；凡需设备才能得结论处一律标注「不可测」并写原因，不用估值冒充。

---

## 结论速览

WebView 首屏要加载并求值 **68 个 client bundle，raw 11.23 MiB，gzip(level 1) 5.21 MiB**。
其中**单个包占 5.04 MiB raw / 3.67 MiB gzip，96.2% 是内联 base64 位图而非代码**。
把这一个包的图剥掉，首屏从 11.23 MiB 降到 6.20 MiB raw、5.21 MiB 降到 1.53 MiB gzip：**传输量 -70.5%**，且不改本仓一行源码。

本仓自有的首屏 JS 只有 **5 个包 / 413.8 KiB raw，占 3.6%**；引擎冷启动支配项（上游激活 157 条生效 Loader entry）本仓只能影响 13 条（6.8%）。
⇒ **不要为冷启动去重写客户端**，杠杆不在这里。

---

## B-1 【最高收益】首屏 68 个 bundle 里 5.04 MiB 是一个包的内联位图，剥掉它首屏 gzip 少 70.5%

- **测量方法**
  - 首屏面清单：`node scripts/perf-audit-b/boot-js-surface.mjs <解包快照根>`。它按引擎真实规则重建，不猜文件名 ——
    依据 `dsh-client-modules/lib/index.js:108` 与 `:717-723`：node 半边扫 Host Loader 的 entries，凡 `package.json` 声明
    `dsh.client.platform === "web"` 的包，其 `exports["./client"]` 就是首屏要 fetch 的 bundle。
  - 内联载荷：`node scripts/perf-audit-b/inline-image-payload.mjs <client.js>`。对**同一文件**构造两变体（原始 / 把
    `data:image/*;base64,` 后的载荷置空），分别 gzip level 1 与 brotli-11，差值即可回收量。
  - 输入：`snapshot/snapshot-x86_64.tar.xz`（只读，`tar -xJf` 解到 %TEMP%）；另用 `app/src/main/assets/snapshot.tar.xz`
    （真正打进 APK 的那个）抽同一文件复核。

- **基线数值**

| 项 | 值 |
|---|---|
| 首屏 client bundle 个数 | 68 |
| 首屏 raw | 11.23 MiB |
| 首屏 gzip(level 1) | 5.21 MiB（拼接后实测 5,458,278 B） |
| 其中 `dsh-client-ui-settings-account` | raw 5,282,386 B = 首屏 raw 的 44.9%；gzip 3,849,116 B = 首屏 gzip 的 70.5% |
| 该包内联 base64 | 15 处 `data:image/*`，合计 5,080,800 字符 = 该文件 96.2% |
| 解出的位图 | 3.63 MiB；8 张 PNG（4 张 3993x2480/2481，4 张 1782-1785x1527-1530）+ 7 张 SVG 共约 6 KiB |
| 剥载荷后 gzip | 52,890 B（从 3,849,116 B 降下，差 3,796,226 B = 3.62 MiB） |
| 剥载荷后 brotli | 36,415 B（差 3,766,816 B） |
| 首屏去掉该包 | raw 6.20 MiB / gzip 1.53 MiB（其余 67 个） |
| APK 内嵌快照里的同一文件 | 3,424,638 B（比 x86_64 快照小 35%），载荷占比仍 93.7%；剥掉后 gzip 2,470,230 → 57,305 B（差 2.42 MiB） |

  两个快照口径都成立：首屏 gzip 从 5.21 MiB 降到约 **2.8 MiB 量级（-46%）** 或 **1.53 MiB 量级（-71%）**，取决于用哪个快照。

- **问题**：`dsh-client-ui-settings-account` 的 client bundle 把 8 张大尺寸 onboarding 插画 base64 内联进了 JS。后果三条：
  1. **首屏传输**：它是首屏 bundle 不是懒加载 chunk（`dsh-web-app/cordis.patch.yml:131-132` 把它挂进 web 插件表，
     引擎 `compose()` 对所有 `platform === "web"` 行一视同仁打进 application batch）。每次冷启动、每次硬刷新都要传这 3.6 MiB。
  2. **引擎 CPU**：`dsh-host-webserver/lib/index.js:106-131` 的 gzip 中间件逐响应现压、**无输出缓存**，
     而 combo batch 把多 bundle 拼成一个响应体（`dsh-client-modules/lib/index.js:365-397`）。
     实测单独压该包 level 1 中位 **718.19 ms**，剥载荷后 **4.35 ms**（差 713.84 ms）。
  3. **解析成本**：V8 编译 5,282,386 字符中位 **6.69 ms**，剥载荷后 201,586 字符 **0.47 ms**（差 6.22 ms）。绝对值不大但是纯浪费。

  潜在内存风险（推导，非实测）：这些图原始像素 3993x2480 ≈ 990 万像素，ARGB_8888 单张约 **37.8 MiB**；8 张合计 192.78 MiB。
  代码里 `AccountOnboarding` 与 `OnboardingCreditStep` 分步渲染（`client.js:3231` / `:3249` 的 `<img>` 在不同步骤组件内），
  所以正常路径不会同时解码全部。但**当前步骤的 2 张（亮/暗各一，`OnboardingIllustration` 同收 `src` 与 `darkSrc`）≈ 75.6 MiB** 是真实的，
  低端机上足以让 WebView 渲染进程被杀。这是本文最需要上设备复核的一项。

  归因边界：该包属**上游** `@deepseek-ai/*`，本仓不能直接改。可用手段三条，风险递增 ——
  ① `scripts/patches/` 加运行时补丁把 `data:image` 常量换成引擎静态路由（本仓已有同类补丁，如 `image-expiry-E1.mjs`）；
  ② 在 `cordis.patch.yml` 给该行换 client 入口（上游只暴露 `./client`，需额外包壳，工作量大）；
  ③ 上报上游改为外链图片资源（最干净但不受本仓控制）。

- **预估收益**：首屏 gzip **-3.62 MiB（-70.5%，x86_64 快照）/ -2.42 MiB（APK 快照）**；首屏 raw **-5.04 MiB（-44.9%）**；
  引擎单次 gzip CPU **-0.2~0.7 s（宿主）**；V8 解析 **-6.2 ms（宿主）**；渲染进程峰值内存风险 **-75.6 MiB（推导）**。量级：**决定性**。
- **改动风险**：**中**。补丁面改上游产物字节 → 打破 `check-patch-mirror.mjs` 逐字节镜像（需双仓同步，铁律 6）+ 每次上游 bump 要重做。
  走静态路由还需保证离线可用（onboarding 本就在引擎起来后才渲染，可接受）。**不改任何用户可见行为**。
- **负控**：`negative-control.mjs` 压缩尺 —— 1 MiB 全 `a` gzip 到 4,609 B，1 MiB 真随机 1,048,917 B（227x 差），证明尺子能分辨可压缩性；
  同一脚本对同一文件的「剥载荷」变体测得 3,796,226 B 差值（非 0），证明在我关心的方向上确实测得到差异。

---

## B-2 本仓自有首屏 JS 只占 3.6%，客户端不是冷启动的杠杆

- **测量方法**：`boot-js-surface.mjs` 按包名前缀把首屏 bundle 分为「本仓自有」（`@dsh-android/*`、`dshmarketplace-plugin`、`dsh-undo-savepoint`）与「上游」；
  `count-loader-entries.mjs` 统计装配清单里的 Loader entry。
- **基线数值**

| 项 | 值 |
|---|---|
| 首屏 bundle 总数 | 68 |
| 本仓自有 | **5 个 / 413.8 KiB raw**（`dsh-client-ui-responsive` 308,870 B、`dsh-undo-savepoint` 61,544 B、`dsh-android-vdisplay`、`dshmarketplace-plugin`、`dsh-android-bridge`） |
| 本仓占首屏 raw | **3.6%** |
| 上游 | 63 个 / 10.83 MiB raw |
| Loader entry（去重后） | 声明 **191** · 关停 34 · **生效 157** |
| 本仓 `cordis.patch.yml` | 原始声明 21 条（insert 13 / 就地覆盖 8），**新增且仍生效 13 条** |
| 本仓可影响占比 | **13 / 191 = 6.8%** |

  口径核对：`scripts/check-boot-budget.mjs:63` 记「上游激活全部 ~193 条 Loader entry」，与本文 191（去重后声明数）同量级；
  157 是扣掉 34 条 `disabled: true` 后的生效数。两数都对，口径不同（声明 vs 生效），本文明确标注。

- **问题**：任务书要求确认「本仓能不能影响 193」。答案：**只能影响 13 条（6.8%）**。
  冷启动窗口的支配项是 loader-settle-wait（`check-boot-budget.mjs:62` 记 1532.5–7288.1 ms），由上游 157 条 entry 的编译/求值链决定。
  即便本仓 13 条全砍光也拿不到支配项量级。同节 `constructor-flush`（本仓 client-modules registry 扫描，37.7–552.8 ms）才是本仓能动的面。
  反过来，本仓首屏 JS 只占 3.6% ⇒ 压缩它（如 B-3）最多影响首屏 JS 的 1.2%。
- **预估收益**：不适用于「砍本仓代码」。本条价值是**否掉一条错误路线**：不要为冷启动重写/裁剪 `dsh-client-ui-responsive`。真正的杠杆在上游激活链（C 组范围）。
- **改动风险**：无（本条是判断，不是改动）。
- **负控**：entry 计数用两条独立路径交叉验证 —— `count-loader-entries.mjs` 解析 `cordis.patch.yml` 得 191/157；
  `boot-js-surface.mjs` 走完全不同路径（先收 insert 的 `name`，再逐包读 `package.json` 查 `dsh.client`）得 157 条带名 entry、68 个 web client 包。两路 entry 总数一致（157）。

---

## B-3 首屏 JS 有 1.43 MiB（12.7%）是可安全删除的空白与整行注释，但 gzip 只省 5%

- **测量方法**：`node scripts/perf-audit-b/whitespace-budget.mjs <解包快照根> --json <bootjs.json>`。逐行分类：空行、行首缩进、
  整行注释（去空白后以 `//`、`/*`、`*` 开头）算「安全回收」；行尾注释只统计不算回收（可能含 URL 里的 `//`）。
  这不是 minify 结果，是 minify 的**确定性下界**。
- **基线数值**

| 项 | 值 |
|---|---|
| 首屏 bundle | 68 个 / 11.23 MiB raw |
| 可安全回收 | **1.43 MiB（12.7%）** |
| gzip 影响 | 5,458,278 → 5,184,301 B，差 **273,977 B（-5.0%）** |
| 单包最高回收率 | `dsh-client-ui-responsive` 100,471 / 308,870 = **32.5%**（本仓自有，注释写得很足）；`dsh-api-session-controller` 39.5% |

- **问题**：上游与本仓的 client bundle 都**没经过 minify**（`tsdown.client.ts:171-285` 只设 `target: 'chrome87'`，未启用压缩；
  实测 `dsh-client-ui-responsive/lib/client.js` 平均行长 41 字符）。12.7% 的 raw 是空白与注释。
  **但收益结构要看清**：gzip 只减 5.0%，因为空白/缩进在 gzip 里本来就压得很干净。
  写这条是为了防止「1.43 MiB 可删」被误读成「能省 1.43 MiB 传输」——**传输只省 274 KB**。
  真正收益在解析前扫描字节与快照/APK 体积（raw 计入 `snapshot.tar.xz`）。
- **预估收益**：首屏 gzip **-274 KB（-5.0%）**；首屏 raw **-1.43 MiB**；对 APK/快照体积的贡献未单独量化（标注未量化）。量级：**中等**。
- **改动风险**：**中**。开 minify 改产物字节 → 打破 `check-patch-mirror.mjs` 逐字节镜像与 combo 缓存门禁（缓存按 `sha256(client.js)` 查表，
  见 `tsdown.client.ts:254-257` 既有注释）；且 minify 后栈追踪靠 `.map`，而 `slim.json` 的 `sourcemapDelete: true` 会把 `.map` 全删。
  另：本仓自有部分可直接改 `tsdown.client.ts`，**上游 63 个包不行**，单改本仓最多拿到 32.5% × 3.6% ≈ **1.2%** 的首屏 raw。
- **负控**：`negative-control.mjs` 体积尺（1000 行 7,889 B vs 2000 行 16,889 B，比值 2.14，落在预设 1.8–2.2 区间）；
  本脚本对同一批文件输出「原样 gzip」与「去空白 gzip」两组数，尺子失明时差值会是 0，实测 273,977 B。

---

## B-4 引擎每响应一次首屏 combo 就现压 11.23 MiB，宿主观测 209.9 ms 纯压缩成本

- **测量方法**：`node scripts/perf-audit-b/gzip-boot-cost.mjs <解包快照根> --json <bootjs.json> --runs 5`。把 68 个首屏 bundle 按 combo 语义用 `;\n` 拼接成一个响应体，
  `zlib.createGzip` level 1 与 level 0 各压 5 次取中位。依据链：`dsh-web-app/cordis.patch.yml:163-171`（`compression: gzip` / `compressionLevel: 1` / threshold 1024）
  → `dsh-host-webserver/lib/index.js:106-131`（npm `compression` 中间件，**无输出缓存**）→ `dsh-client-modules/lib/index.js:365-397`（combo batch 拼多 bundle 成一个响应体）。
- **基线数值**

| 档 | 中位 | min | max | 输出字节 |
|---|---|---|---|---|
| gzip level 1 | **282.8 ms** | 254.8 ms | 288.4 ms | 5,435,177 B |
| gzip level 0 | 72.9 ms | 56.6 ms | 166.5 ms | 11,780,692 B |
| 差值（压缩成本） | **209.9 ms** | | | -6,345,515 B |

- **问题**：首屏 JS 每次首次请求都要在引擎进程里现压，`combo cache` 只缓存**压缩后的响应体**（`dsh-client-modules/lib/index.js:661-687` 的 `batchResponses` 是进程内 Map），
  **进程重启即失效**。冷启动时这段 CPU 与 loader-settle 尾部重叠。配合 B-1，载荷削减是这条 CPU 成本的直接杠杆：剥掉内联图后压缩输入从 11.23 降到 6.20 MiB。
  诚实边界：这是**宿主**测量。设备上 Node 版本相同但 CPU 更慢，绝对值必然更高；我没有设备，**不给设备秒数**。这条的用途是证明「压缩不是免费的」。
- **预估收益**：按 B-1 削减载荷后，压缩输入 11.23 → 6.20 MiB，粗略线性折算 **-92 ms（宿主，-44%）**。量级：**中等偏小**。
- **改动风险**：**高**（改 `compression` 要动 web-app bundle patch 或本仓 overlay，直接影响所有 HTTP 响应路径）。**建议不做** —— 该做的是 B-1（少喂数据给压缩器）而不是换压缩器。
- **负控**：level 0 与 level 1 是同一份输入、同一把尺子、只换一个参数，耗时差 209.9 ms；计时器失明时两者会一样。
  另：`negative-control.mjs` 解析尺对大源码（2.2 MB）测得 1.84 ms 中位 vs 小源码 0.004 ms，证明本机计时分辨率足以分辨毫秒级差异。

---

## B-5 壳侧注入只有 47.5 KiB、shiki 语言包不在首屏路径 —— 这两处都不是瓶颈

- **测量方法**：`node scripts/perf-audit-b/injected-js-budget.mjs .` 静态切分 `dsh-host-web-compat/lib/index.js` 的脚本常量并按 UTF-8 字节计长；
  对照注入表（同文件 `INJECTIONS` 数组）确认哪些真进 `</head>`；首屏加载序用 `dsh-client-modules/lib/index.js:457-502` 的 `bootInjections()` 核对；
  前端 dist 体积用 `size-report.mjs` 量 `dsh-web-frontend/dist/assets`。
- **基线数值**

| 注入段 | 字节 | 首屏同步 |
|---|---|---|
| `BOOT_WATCHDOG_SCRIPT` | 27,815 B | 是（`</head>` 前） |
| `POLYFILLS`（33 段合成一条） | 24,023 B 数组字面量 | 是 |
| `PICKER_SCRIPT` | 11,653 B | 是 |
| `THEME_BRIDGE_SCRIPT` | 6,587 B | 是 |
| `SLOT_GUARD_SCRIPT` | 2,585 B | 是（最早求值） |
| `STATIC_FALLBACK_SCRIPT` | 2,687 B | 是 |
| `CLIPBOARD_FALLBACK_SCRIPT` | 2,629 B | 是 |
| **合计（注入表 5 段口径）** | **47.5 KiB** | |

| 前端主包 | raw | gzip | brotli |
|---|---|---|---|
| `vendor-CCJJTK99.js` | 880,158 B | 189,292 B | 156,386 B |
| `index-Q6zc2uHV.js` | 787,107 B | 226,535 B | 190,099 B |
| `index-DUvMhLle.css` | 74,579 B | 14,158 B | 12,522 B |
| `vendor-BNsW4eBh.css` | 29,288 B | （含在上面统计内） | |
| **assets 合计（63 文件）** | 4,732,558 B | 817,499 B | 659,942 B |
| 其中 `langs/` 51 个 shiki 语言包 | 2.99 MiB | | **不在首屏路径**（`index.html:10-13` 只静态引用两个 chunk，langs 靠动态 import） |

  首屏执行序（`bootInjections`）：inline queue script → application batch 的 `<link rel=preload>` → bootstrap batch 的阻塞 `<script src>` → `__DSH_BOOT__` 全局
  → 页面自身 `index-*.js` + `vendor-*.js`。
- **问题**：壳侧注入 47.5 KiB 相对首屏 11.23 MiB 是 **0.4%**，不是瓶颈。真正首屏解析面是 `dsh-web-frontend/dist` 两块（1.67 MiB raw / 415,827 B gzip）加上 68 个 plugin bundle。
  `langs/` 3 MiB 是**按需动态 import**，不在首屏。**记这一条是为了防止有人把 langs 体积误计入首屏预算。**
- **预估收益**：不适用。本条是**排除法**：壳侧注入与 langs 都不是首屏负担，别在这两处花时间。量级：**可忽略**。
- **改动风险**：无（无改动）。
- **负控**：`injected-js-budget.mjs`（静态切字符串字面量）与 `whitespace-budget.mjs`（逐行分类）两条独立量法对同一份文件得到相容量级；
  若切分错位（把注释算进去）会显著偏离。langs 是否在首屏由 `index.html` 静态引用清单直接判定，不依赖运行时假设。

---

## B-6 常驻周期唤醒源 6 处 / 307 次每分钟，其中 3 处没有后台门控

- **测量方法**：`node scripts/perf-audit-b/timers.mjs .`。用 `git grep -F` 粗筛候选行（POSIX ERE 不支持 `\s`、`(?:)`，首版直接失败），
  Node 侧用完整正则抽间隔数值；**抽不出间隔的不计入合计**（151 条进 `unparsed`，含注释行）。分两类：API 语义上就是周期的算进合计；
  `setTimeout`/`postDelayed` 是一次性的，单列不猜递归。测试夹具与 `scripts/` 排除。
- **基线数值**

| 文件:行 | 间隔 | 次/分钟 | 后台是否继续 | 空闲是否跳过 |
|---|---|---|---|---|
| `dsh-host-web-compat/lib/index.js:1351` | 500 ms | 120 | 是（无 visibility 门） | **是**：`clearStaticFallback` 首次 `rendered()` 为真即 `clearInterval`（`:1346`），健康页首帧后停 |
| `plugins/dsh-android-vdisplay/src/client/index.ts:496` | 800 ms | 75 | **是，无 visibility 门** | 部分：`reveal()` 先查 `vdisplayStatus.state === 'active'`，非 active 立刻返回 |
| `plugins/dsh-android-vdisplay/src/client/index.ts:333` | 1000 ms | 60 | **是，无 visibility 门** | 否：`pull()` 每拍都发 `pullPanelState()` + `publishBounds()` |
| `dsh-client-ui-responsive/.../dev-section/apk-update.tsx:259` | 2000 ms | 30 | 否 | **是**：仅 `polling`（`BUSY_STATES`）为真才挂，终态即卸载（`:255-261`） |
| `app/src/main/assets/console.html:540` | 3000 ms | 20 | 否（独立 Activity 页面，关闭即销毁） | 否 |
| `vendor/dsh-undo-savepoint/lib/client.js:425` | 30000 ms | 2 | **是，无 visibility 门** | 否：每 30 s 一次 `refreshStat()` |
| **合计（全部同时活跃的上界）** | | **307** | | |

  另有 1 处**自续 `setTimeout`**（不是 `setInterval`，未进上表）：`host-web-compat/lib/index.js:730-744` 的 `readyWatch()`，500 ms 自排、
  直到 `__dshBootReadyPublished` 为真或超 60 s 窗口才停 —— 健康启动下跑不到 200 次就停。
  对照：`dsh-client-ui-responsive/src/client/mobile/native-browser-auto-place.ts:87-101` 也改成自续 `setTimeout` 但**带 `document.hidden` 门**（后台不排下一拍），
  是本文里唯一做对的常驻轮询形态，可直接照抄。

- **问题**：6 处里 3 处（vdisplay 两处 + undo-savepoint 一处）**没有 `document.hidden` 门**，页面切后台后仍每秒/每 800 ms 打一次原生桥
  （`decodeNative()` 走 `addJavascriptInterface`，是同步 JNI 调用）。按 307 次/分钟上界算，**vdisplay 两处占 135 次/分钟**，是常驻耗电与唤醒的直接来源。
  诚实边界：**307 是静态上界**，不是设备实测。vdisplay 两处只在「有虚拟屏会话」且状态 active 时才真正跑拍（`reveal()` 首行 return），
  且 `ctx.effect` 卸载即停。真实平均值取决于用户行为，无设备测不了。
- **预估收益**：把 3 处无门控轮询加 `document.hidden` 门（照 `native-browser-auto-place.ts:87-101`），后台唤醒从**最多 135 次/分钟降到 0**；前台收益为 0。量级：**中等**（耗电与后台存活）。
- **改动风险**：**低**。只改「后台是否继续排下一拍」，不影响前台；风险点在 `visibilitychange` 补拍要写对（有现成参照）。
- **负控**：脚本第一版把注释「审计之前是裸的 `setInterval(tick, 1000)`」（`native-browser-auto-place.ts:11`）算成周期源，得 367 次/分钟；
  加「首字符是 `//`/`*`/`/*` 即视为注释」过滤后降到 307，并逐条人工核对 6 处都是真调用点（核对记录即上表「文件:行」列，可逐条 `git grep` 复核）。
  **该脚本确实会误报，误报已被挤掉** —— 这本身就是尺子有效的证明。

### B-6 补充：Kotlin 侧周期源全清单

`git grep` 在 `app/src/main/java/.../shell/*.kt` 上命中 96 处 timer 类调用（含一次性），逐条读常数后确认为**周期**的有 6 处，全部在**后台仍继续**：

| 文件:行 | 间隔 | 说明 |
|---|---|---|
| `EngineStartFlow.kt:61/78/116` | 3,000 ms | `engineMonitorHandler.postDelayed(this/monitor, 3_000)`，引擎监控自续；`:116` 显式判 `!userClosedEngine` 才续 |
| `EngineStartFlow.kt:168/436` | 10,000 ms | `freezeHandler.postDelayed(this/freezeRunnable, 10_000)`，冻结看门狗 |
| `EngineStartFlow.kt:260/411` | 5,000 ms | `bootStallHandler.postDelayed(this/bootStallRunnable, 5_000)`，启动卡住检测 |
| `WatchdogV2.kt:48/51/54` | 5,000 / 20,000 ms | `STANDARD_TICK_MS=5_000`、`HEALTHY_TICK_MS=20_000`、`ACTIVE_TICK_MS=5_000`；`nextTickDelayMs()` 只在 HEALTHY 且非 booting 时放宽到 20 s |
| `ControlPoller.kt:49/65` | 5,000 ms 长轮询 + 5,000 ms 心跳 | `LONG_POLL_MS=5000`、`HEARTBEAT_INTERVAL_MS=5_000`（注释自述 0.14.10 §6.5 由 2 s 降到 5 s），空闲退避 `IDLE_BACKOFF_MS=1000` → `MAX_BACKOFF_MS=10_000` |
| `OverlayService.kt:691/693` | 10,000 ms | `main.postDelayed(probeHandle!!, 10_000)`，悬浮球探针 |
| `VdisplayHost.kt:105` | 30,000 ms | `REBIND_BACKOFF_MS=30_000L`（退避型，非固定频率） |
| `LogCollector.kt:29` | 5,000 ms | `INTERVAL_MS`，`scheduleWithFixedDelay` 采集（见 B-7） |

Shell 侧另有 3 处 `NotifyProbe`/`NotifyDecisionQueue` 的退避型重试（`MAX_BACKOFF_MS=60_000`、`MAX_ATTEMPTS=6`），只在失败路径触发，不算常驻。
**Shell 侧与 WebView 侧不叠加**：Kotlin 定时器跑在 shell 进程，WebView 的 `setInterval` 跑在渲染进程，两者独立计唤醒但都对电池有贡献。
合计（逐行按 `60,000 / 间隔` 相加，`WatchdogV2` 的 active/healthy 两档互斥、上界取快档 5 s）：

| 口径 | shell 侧 | WebView 侧 | 合计 | 每秒 |
|---|---|---|---|---|
| **上界**（全部源同时活跃，含悬浮球探针与采集器） | **94 次/分钟** | 307 次/分钟 | **401 次/分钟** | 6.7 |
| **稳态**（watchdog 走 HEALTHY 20 s 档、悬浮球与采集器关闭） | **67 次/分钟** | 307 次/分钟 | **374 次/分钟** | 6.2 |

两个数都是**静态上界/稳态估算**，不是设备实测。`ControlPoller` 的空闲退避（`IDLE_BACKOFF_MS=1000` → `MAX_BACKOFF_MS=10_000`）会进一步拉低真实值。

> 自我更正记录：本节初稿曾写「shell 侧约 1,200 次/分钟、合计约 1,500 次/分钟」——那个数字**没有任何计算支撑**，是按「看起来很多」估的。
> 按上表逐行相加实为 94（上界）/ 67（稳态）。保留这条记录，因为它是本报告里唯一一处我写错又被自己抓出来的数，删掉就等于假装没发生过。

---

## B-7 日志采集器每拍起一个 logcat 子进程；有大小上限，但跨天文件永不清理

- **测量方法**：静态读 `app/src/main/java/com/dsharnessmobile/shell/LogCollector.kt`（59,744 B）+ `git grep` 统计 `Log.*` 调用点；
  对可读上限、轮转、跨天保留逐条核对源码行号。
- **基线数值**

| 项 | 值 | 出处 |
|---|---|---|
| 采集间隔 | **5,000 ms** | `LogCollector.kt:29` `INTERVAL_MS` |
| 每拍动作 | 起一个 `/system/bin/logcat -d --pid=<self>` 子进程 + 读 engine.log 增量 | `:984-1010` / `:1013-1030` |
| 单拍 logcat 上限 | 1 MiB（`ProcIo.readBounded`，10 s 有界等待） | `:994` + `ProcIo.kt:28` |
| 单拍 engine.log 上限 | 256 KiB | `:31` `MAX_ENGINE_CHUNK` |
| 单日文件上限 | 5 MiB，超了轮转 `.1` → `.2`（保 2 代） | `:30` / `:1040-1043` / `:1058-1083` |
| boot-segments / boot-diag | 各 64 KiB（各转 1 代） | `:91` / `:450` |
| boot-fail | 128 KiB | `:526` |
| `Log.*` 调用点 | **277 处**（`EngineManager.kt` 86、`MainActivity.kt` 28、`LogCollector.kt` 15 …） | 静态计数 |
| 采集器默认状态 | **关**（设置 → 开发者选项开关） | `:17` 头注释 |
| **跨天保留** | **无上限、无清理**：文件名按 `dsh-<yyyy-MM-dd>.log` 每天新建，全仓无删除旧日文件的代码 | `:1036-1043` |

  跨天不清理的核对（`git grep` 的四类写法全部零命中删除逻辑）：
  ```
  LogCollector.kt:1039:  val file = File(dir, "dsh-$day.log")                    # 只按当天名建，不扫旧
  LogShare.kt:126-127:   logDir?.listFiles()?.filter { it.name.startsWith("dsh-") }  # 只读给用户分享，不删
  ```

- **问题**：两条。
  1. **每 5 s 一个子进程**：`ProcessBuilder("/system/bin/logcat", ...)` 每拍 fork 一次。单看不贵，但采集器开启期间常驻，一天 **17,280 次 fork**。
  2. **跨天只增不减**：5 MiB/天 × 2 代 = 10 MiB/天，一年 **3.65 GB**，且**没有任何回收路径**。
     这正是任务书 D1 的「只创建不删除」形态在**产品侧**的实例（与开发侧 `.deploy-tmp` 同型）。
     对照：`ShotCachePolicy.kt:25/28`（32 文件 / 128 MiB）与 `PhotoCapture.kt:75/96/99`（`KEEP_PHOTOS=10`、`KEEP_RAW_MAX=3`）都做了有界回收，
     **说明这仓库有这套纪律，日志目录是漏掉的那一处**。
  重要限定：采集器**默认关闭**，触发条件是用户显式打开调试日志。严重度因此是「长期使用 + 开了调试日志」才显现，不是全员命中。
- **预估收益**：加一条「保留最近 N 天」（N=7 封顶 70 MiB，N=3 封顶 30 MiB）消除无界增长；子进程若改成复用（或按需触发），一天少 1.7 万次 fork。量级：**小到中等**（但风险极低，稳赚）。
- **改动风险**：**低**。加目录清理不改变用户可见行为（若用户依赖旧日志，那正是要显式声明的边界）。
- **负控**：`Log.*` 调用点（277）与文件大小是独立量 —— `EngineManager.kt` 185,964 B 有 86 处、`LogCollector.kt` 59,744 B 有 15 处，
  密度差异正常，说明计数不是按文件大小推算。跨天无清理由 `git grep` 的**零命中**证明（搜索覆盖 `deleteRecursively`、`delete()`、`listFiles`、`logDir` 四类写法），
  而不是由「我没找到」推断。

---

## B-8 DOM 现场操作面：31 个 MutationObserver，其中 23 个监视整棵文档子树；长列表已虚拟化

- **测量方法**：`node scripts/perf-audit-b/dom-surface.mjs .`（原语计数）+ `git grep`（精确到调用行）。**不引入 jsdom**（新依赖），
  因此本节节点数是「调用点计数」不是运行时节点数——后者需设备 CDP，明确标注不可测。虚拟化判定直接读 `dsh-client-ui-chat/lib/client.js` 的产物。
- **基线数值**

| 原语 | client-ui | assets（console.html） | 合计 |
|---|---|---|---|
| `createElement(` | 51 | 5 | 56 |
| `querySelectorAll(` | 34 | 5 | 39 |
| `querySelector(` | 78 | 2 | 80 |
| `getElementById(` | 4 | 17 | 21 |
| `appendChild(` | 23 | 5 | 28 |
| `innerHTML =` | 3 | 0 | 3 |
| `addEventListener(` | 119 | 21 | 140 |
| `new MutationObserver` | **31** | 1 | 32 |
| 其中 `observe(document.body\|documentElement)` | 28 | 1 | 29 |
| 其中带 `childList + subtree: true`（监视整棵树） | **22** | 1 | **23** |
| `requestAnimationFrame(` | 13 | 0 | 13 |

  监视整棵树且持续存活的清单（`git grep -n 'observe(document'`，全部可逐行复核）：
  `composer-popup-guard.ts:228`、`index.ts:812`、`MobileChrome.tsx:59`、`SidebarToggle.tsx:63`、`about-entry.ts:215`、`composer-sheet.ts:475`、
  `drawer-overlay-dismiss.ts:91`、`file-card-actions.ts:295`、`form-marker.ts:55`、`header-popups.ts:38`、`main-panel-back.ts:94`、`mobile-workspaces.ts:169`、
  `native-browser-presentation.ts:304/306`、`reference-menu.ts:216`、`settings-document.ts:122`、`settings-nav.ts:285`、`sidebar-bubbles.ts:166`、
  `sidebar-gestures.ts:303`、`top-bar-fold.ts:116`、`session-log-dialog-observer.ts:70`、`trajectory-panels-observer.ts:26`；壳侧另加 `host-web-compat/lib/index.js:476`。

- **问题**：23 个 `subtree: true` 观察器全挂在 `document.body` / `document.documentElement`。React 每次提交（每个 token 流片段、每次工具卡片更新）都改 `#root` 子树
  → **全部 23 个回调都被调度**，各自再跑一遍 `querySelector`。这是随「对话长度 × 消息更新频率」线性放大的固定税。

  **但任务书 B3 预设的热点不成立，必须写明是排除**：消息列表/轨迹列表**已有虚拟化** ——
  `dsh-client-ui-chat/lib/client.js:2125` `class Virtualizer`、`:3116` `useVirtualizer`、`:3216` `useVirtualizer({...})`（含 `getVirtualItems()`、`measureElement()`、
  `scrollBy`）；`dsh-client-ui-trajectory` 也有同名实现。所以「长对话渲染海量 DOM」这个经典缺陷**在本仓不存在**。真正的成本在观察器数量，不在节点数。
  另一条排除：`console.html:195-203` 的 `trimOutput()` 有 `maxLines = 2000` 硬上限，超出一次裁掉 500 个节点，输出面板不会无界增长。

- **预估收益**：**未量化**（无设备，无法测每次回调耗时与总调度次数）。定性判断：合并同类观察器（例如把 `documentElement` 上的 6 个 `childList+subtree` 收成
  一个事件总线再分发）可把每帧回调调度次数从 23 降到个位数。**不建议在无设备证据前动手** —— 每个回调体量都很小（多数一次 `querySelector`），实际成本可能完全可接受。
- **改动风险**：**高**。合并要重构 20+ 模块的生命周期，且这些模块各自有「等某个元素出现」的语义（如 `SidebarToggle.tsx:63`、`MobileChrome.tsx:59` 的 `waitObserver`），
  漏掉一个边缘时序就是白屏级缺陷。
- **负控**：原语计数与 `git grep` 精确调用行清单两条路径交叉验证 —— 脚本报 23 个文档根 `subtree` 观察器，`git grep 'observe(document'` 抓 28 行、逐行核对带 `subtree: true` 的 22 行（+壳侧 1 = 23）。
  首轮曾漏掉 `subtree: true` 写在**下一行**的 7 处多行写法（17 vs 22），改逐块读后修正 —— 这个差异本身就是该计数的可证伪记录。

---

## B-9 图片/截图缓存全部有界，产品侧没有无界增长点；风险在单张图的内存预算

- **测量方法**：`git grep` 扫全 Kotlin 侧 `Bitmap|compress(|inSampleSize|LruCache|screencap|ImageReader|createTempFile`，逐条读出上限常量与回收路径；
  每张图按 `宽×高×4` 手算 ARGB_8888 预算。
- **基线数值**

| 出处 | 上限 / 回收 | 判定 |
|---|---|---|
| `ShotCachePolicy.kt:25/28` | 32 文件 / 128 MiB，`prune` + `prunePublished` | **有界** |
| `PhotoCapture.kt:58/75/96/99` | 长边 2048、`KEEP_PHOTOS=10`、`KEEP_RAW_MAX=3`、`KEEP_RAW_WINDOW_MS=24h` | **有界，双上限** |
| `DeviceControlService.kt:870/1267` | 无障碍截屏 `pruneShots(dir, keep = 8)` | **有界** |
| `BrowserHost.kt:80` / `VdisplayController.kt:40/42` | `MAX_TABS=8` / `MAX_VIRTUAL_DISPLAYS=1`、`MAX_EDGE=4096` | 有界 |
| `LogShare.kt:43/46/49` | 单件 2 MiB / 合计 12 MiB / logcat 512 KiB | 有界 |
| `PhotoCapture.kt:279` | 中转 bitmap 显式 `recycle()`（注释自述「每张都是数十 MB」） | **已修** |
| `BrowserHost.kt:2142` / `BrowserProcessService.kt:643` / `DeviceControlService.kt:869` | `finally { bitmap.recycle() }` | **已修** |

- **问题**：**产品侧没有找到无界增长的图片/截图目录** —— 与开发侧 `.deploy-tmp` 4.7 GB 同型的增长点**不在** app 侧。写下来是为了闭合任务书 B4 的追问。
  剩下的风险是**单张图内存预算**：`BrowserHost.kt:2130` 的 `Bitmap.createBitmap(w, h, ARGB_8888)` 与 `VdisplayController.kt:372` 的 `ImageReader.newInstance(w, h, RGBA_8888, 2)`（2 帧缓冲）。
  按 1260x2800 真机算：单张 ARGB ≈ **13.5 MiB**，ImageReader 2 帧 ≈ **27 MiB** 常驻；按 1600x900 横屏算 5.5 MiB/帧。
  叠加 B-1 的 onboarding 图（单步 2 张 ≈ 75.6 MiB）后，WebView 渲染进程峰值可能到 100 MiB 量级。
- **预估收益**：B-1 修好后随之缓解；本仓侧不需单独动作。量级：**由 B-1 覆盖**。
- **改动风险**：无（无改动）。
- **负控**：上限常量的存在性由源码行号直接给出（不是「看起来有」）；`recycle()` 覆盖由 `finally` 块行号给出。
  内存预算算式 `宽×高×4` 可用 `inline-image-payload.mjs` 对同一批 PNG 的归一输出复核（该脚本从 PNG 头读真实宽高，得 3993×2480 → 37.8 MiB，与手算一致）。

---

## 交叉发现（不属本组范围，交给对应组）

1. **【给 A 组 / 构建链】`dsh-client-ui-responsive/lib/client.js` 有三个互不相同的产物在流通**：
   - 主工作区 `dsh-client-ui-responsive/lib/client.js`：**757,378 B**，平均行长 41 字符，`//#region` 0 个，含 `sourceMappingURL`
   - `snapshot-x86_64.tar.xz` 内：**308,870 B**，`//#region` **54** 个（注释保留），无内联图
   - `app/src/main/assets/snapshot.tar.xz` 内（**真正打进 APK 的那个**）：**779,241 B**，17,951 行，`//#region` **0** 个，内含 1 处 `data:image`
   三者 SHA-256 各不相同（`F4B9613A…` / `534BF5C7…` / `B5EBB5CB…`）。**同一个包在「已发布 APK」与「本地快照」里不是同一份字节**，
   这会让任何「改完本地验证通过就发」的流程失效。属 A 组的构建一致性问题。
   同源事实：`dsh-client-ui-settings-account/lib/client.js` 在 x86_64 快照是 5,282,386 B、在 APK 快照是 3,424,638 B，差 35%。
2. **【给 A 组】注入面每次请求都重算**：`dsh-host-frontend-static/lib/index.js:84-86` 的 `renderIndex` 每次请求重新 `readFile(distIndex)` 并重新做字符串注入；
   `dsh-host-web-compat/lib/index.js:1546/1555` 每次把 47.5 KiB 脚本常量 `String.replace` 拼进 HTML。无缓存，属 A 组「重复计算」面。
3. **【给 D 组 / IO】** `LogCollector` 每 5 s 起 `logcat` 子进程读最多 1 MiB，跨天日志永不清理（见 B-7）。属 D 组的「只创建不删除」+「周期性子进程」面。
4. **【给 C 组 / 冷启动】** 冷启动窗口的 `loader-settle-wait`（1532.5–7288.1 ms，`check-boot-budget.mjs:62`）由上游 157 条生效 entry 决定，本仓只有 13 条（6.8%）。
   **不要把这个窗口归因到客户端 bundle** —— B-2 已证本仓首屏 JS 只占 3.6%。
5. **【给 Lead / 全局】** 引擎 gzip **没有跨进程重启的输出缓存**（`dsh-client-modules/lib/index.js:661-687` 的 `batchResponses` 是进程内 Map），
   每次冷启动都要重压 11.23 MiB（宿主 282.8 ms）。杠杆在载荷体积（B-1/B-4），不在压缩器。

---

## 不可测清单（明确写出来，不拿估值冒充）

| 想要的数 | 为什么测不了 |
|---|---|
| 设备上首屏 JS 的实际解析/执行耗时 | 无模拟器/真机；本文全部计时来自宿主 V8，绝对值不可移植 |
| onboarding 位图在 WebView 里的实际峰值内存 | 需真机 `dumpsys meminfo <webview_renderer>` 或 CDP heap snapshot |
| 23 个 MutationObserver 的实际调度开销 | 需设备 CDP Performance trace（不引入 jsdom 就无法在宿主复现） |
| 307 次/分钟在真实使用下的平均值 | 需设备唤醒计数（`adb shell dumpsys alarm` / batterystats） |
| 首屏 combo 在设备上的 gzip 耗时 | 需设备端 perf 采样；本文只有宿主的 282.8 ms |
| 本次**自己打包** `dsh-client-ui-responsive` 的产物体积 | 工作区无 `node_modules`（主工作区该目录是**空目录**）；`npm ci` 需联网装 ~40 个 devDependencies，与「不引入新依赖」冲突且本轮时限不允许 |

> **关于「没自己打包」的局限声明（重要）**：任务书 B1 要求「把 `dsh-client-ui-responsive` 打包出来测产物体积」。
> 实际做法是**分析仓库里已有的三份构建产物**（主工作区 `lib/client.js` 757,378 B、x86_64 快照内 308,870 B、APK 快照内 779,241 B），而不是跑 `npm run build`。
> 因此本报告**不对「某次具体构建的产物体积」下结论**，只对「流通中的产物」下结论 —— 而这恰恰暴露了交叉发现 #1 的构建不一致。
> 补充：`src/` 源码树本身共 **117 文件 / 1.06 MB**（`Get-ChildItem -Recurse` 实测），体积 Top 文件为
> `src/client/mobile/composer-sheet.ts` 77,036 B、`src/client/index.ts` 62,329 B、`src/client/dev-section/phone-control.tsx` 58,885 B、
> `src/client/mobile/mobile-workspaces.ts` 44,255 B、`src/client/mobile/sidebar-gestures.ts` 43,100 B；按目录 Top 为 `src/client/mobile/`（占大头）与 `src/client/dev-section/`。
> 源码字节与实际 bundle 的关系不可直接换算（bundle 会内联上游 CSS、含 CSS-in-JS 文本），所以此数据只用于定位「改哪个文件影响面最大」。

---

## 负控汇总（每一把尺子都自证过能分辨）

`node scripts/perf-audit-b/negative-control.mjs`，exit 0 = 全部通过：

| 尺子 | 构造 | A 组输入 | B 组输入 | 判定 |
|---|---|---|---|---|
| 压缩尺 | 高可压缩 vs 真随机 | 1 MiB 全 `a`：gzip 4,609 B / brotli 14 B | 1 MiB 真随机：gzip 1,048,917 B / brotli 1,048,581 B | **PASS**（227x 差） |
| 体积尺 | N vs 2N 必须成比例 | 1000 行：7,889 B | 2000 行：16,889 B | **PASS**（比值 2.14，落在预设 1.8–2.2） |
| 解析尺 | 小源码 vs 大源码 | 8 B：中位 0.004 ms | 2,200,009 B：中位 1.84 ms | **PASS**（460x 差） |

逐条发现的负控写在各自小节。另有三条**测量被自己的过滤器推翻过**的记录（保留，因为它们是尺子有效的证据）：

1. `timers.mjs` 首版把注释当调用点 → 367 次/分钟；加注释过滤后 **307**。
2. `dom-surface.mjs` / `git grep` 首版漏掉多行 `subtree: true` 写法 → **17** 个；逐块读后 **22**（+壳侧 1 = 23）。
3. `count-loader-entries.mjs` 首版解析错误（把 insert 块后所有顶层条目都判为 insert）→ 20 个；改「按缩进判 insert」后 16；
   最终改为「先收 insert 的 `name`，再逐包查 `dsh.client`」的独立路径交叉验证，得 **13 条新增且生效**。

---

## Top-N 排序（按 收益/风险 比）

| # | 条目 | 预估收益量级 | 改动风险 | 工作量 |
|---|---|---|---|---|
| 1 | **B-1** 剥掉 `dsh-client-ui-settings-account` 的 5.08 MB 内联 base64 位图 | **决定性**：首屏 gzip -2.42~-3.62 MiB（-46%~-71%）；raw -5.04 MiB（-44.9%）；引擎 gzip CPU -0.2~0.7 s（宿主）；渲染进程峰值内存 -75.6 MiB（推导） | **中**（上游包，需补丁面 + 双仓镜像同步） | **M** |
| 2 | **B-6** 给 vdisplay 两处 + undo-savepoint 一处轮询加 `document.hidden` 门 | **中等**：后台唤醒 135 次/分钟 → 0（静态上界）；参照实现已有（`native-browser-auto-place.ts:87-101`） | **低**（只影响后台排不排下一拍） | **S** |
| 3 | **B-7** 日志目录加跨天回收（保留最近 N 天） | **小到中等**：消除 10 MiB/天 的无界增长（一年 3.65 GB） | **低**（不改用户可见行为，需说清 N 天边界） | **S** |
| 4 | **B-3** 对**本仓自有** client bundle 开 minify | **小**：本仓部分 32.5% raw 可回收 × 3.6% 占比 ≈ **首屏 1.2%**；gzip 更少 | **中**（改产物字节 → 打破逐字节镜像与 combo 缓存键；与 `sourcemapDelete` 冲突） | **M** |
| 5 | **B-4** 换 gzip 档位/开 brotli | **中等偏小**：宿主 -92 ms 量级（需先做 B-1 削载荷） | **高**（影响全部 HTTP 响应路径） | **M** |
| 6 | **B-8** 合并 23 个文档根 MutationObserver | **未量化**（需设备 CDP trace 才能定） | **高**（重构 20+ 模块时序语义，白屏级风险） | **L** |

**不是改动项、用来否掉错误路线的三条**：

- **B-2**：本仓首屏 JS 只占 3.6%、可影响 Loader entry 只 6.8% ⇒ **不要为冷启动重写客户端**。
- **B-5**：壳侧注入只 47.5 KiB、shiki langs 不在首屏路径 ⇒ **别在这两处花时间**。
- **B-9**：产品侧图片/截图缓存全部有界（`ShotCachePolicy` 128 MiB、`KEEP_PHOTOS=10`、`pruneShots(keep=8)`）⇒ **不需要新建清理机制**。

---

## 交付物

辅助脚本全部在 `scripts/perf-audit-b/`，各自头注释写明口径与依据来源：

| 脚本 | 作用 |
|---|---|
| `boot-js-surface.mjs` | **核心**：按引擎真实规则算首屏 68 个 bundle 的 raw/gzip/brotli，按本仓/上游拆分 |
| `snapshot-client-bundles.mjs` | 从 `tar -tvJf` 清单重建全快照的 client bundle 集合与体积归属 |
| `client-boot-surface.mjs` | 独立路径：直接扫全部 `package.json` 找 `dsh.client.platform === 'web'`（交叉验证） |
| `count-loader-entries.mjs` | 解析三份 `cordis.patch.yml`，算 entry 声明/关停/生效数与本仓贡献 |
| `size-report.mjs` | 通用目录级 raw/gzip/brotli 体积报表 |
| `inline-image-payload.mjs` | 剥出内联 `data:image` 载荷，测可回收字节与 gzip/brotli 差值（含 PNG 尺寸解析） |
| `whitespace-budget.mjs` | 逐行分类空白/注释，给 minify 的确定性下界 |
| `gzip-boot-cost.mjs` | 拼接全部首屏 bundle 后测 gzip level 1 vs 0（负控内建） |
| `parse-cost.mjs` | V8 编译成本（含载荷 vs 剥载荷，负控内建） |
| `injected-js-budget.mjs` | 壳侧注入脚本的字节量 |
| `timers.mjs` | 周期唤醒源盘点（区分周期/一次性、产品/测试、注释/代码） |
| `dom-surface.mjs` | DOM 原语调用点计数 |
| `negative-control.mjs` | 三把尺子的自证（exit 1 = 有尺子失明） |

复现最短路径：

```powershell
# 1. 解包快照（约 12 分钟，8.7 亿字节，需 1.5 GB 临时空间）
tar -xJf D:\coding\dsh-mobile\dsh-mobile-apk\snapshot\snapshot-x86_64.tar.xz -C %TEMP%\perf-b-snap
# 2. 首屏面 + 体积（三个脚本共用 bootjs.json）
node scripts/perf-audit-b/boot-js-surface.mjs %TEMP%\perf-b-snap > bootjs.json
node scripts/perf-audit-b/whitespace-budget.mjs %TEMP%\perf-b-snap --json bootjs.json
node scripts/perf-audit-b/gzip-boot-cost.mjs %TEMP%\perf-b-snap --json bootjs.json --runs 5
# 3. 内联载荷（用 bootjs.json 里 settings-account 那条的 path）
node scripts/perf-audit-b/inline-image-payload.mjs <path>/lib/client.js
# 4. 其余（不需要解包）
node scripts/perf-audit-b/timers.mjs .
node scripts/perf-audit-b/dom-surface.mjs .
node scripts/perf-audit-b/injected-js-budget.mjs .
node scripts/perf-audit-b/negative-control.mjs
```
