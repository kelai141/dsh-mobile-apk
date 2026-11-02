# #1 三问调查结论：5.08 MB 内联位图 —— **不做**

调查日期 2026-11-03。**未改任何代码**（`git status -- app plugins vendor` 为空）。

## 结论先行

**不做。** 不是收益不成立，而是**收益的类型与量级和审计报告的判断不符**，且改动面（上游产物补丁 + 每次 bump 重做）与真实收益不成比例。

三条推翻原判断的证据，逐条可复现。

---

## 第一问：这 5.08 MB 到底是什么

### 精确构成（实测）

包：`@deepseek-ai/dsh-client-ui-settings-account`，文件 `lib/client.js`，**3,424,638 B**。

`node scripts/perf-audit-b/inline-image-payload.mjs <client.js>`：

```
内联图片 15 张，base64 3,208,828 字符 = 原文件 93.7%
解出 2.3 MiB 位图
gzip(level 1) 原件 2,470,230 B → 剥掉载荷 57,305 B（差 2,412,925 B）
```

### 15 张图的逐个身份（`b1-what-are-they.mjs`）

| # | 类型 | 解码后字节 | 尺寸 | 变量名 |
|---|---|---:|---|---|
| 2 | webp | 415,118 | **3993×2480** | `onboarding_welcome_default` |
| 3 | webp | 408,088 | 3993×2481 | `onboarding_welcome_dark_default` |
| 4 | webp | 392,680 | 3993×2481 | `onboarding_welcome_zh_default` |
| 5 | webp | 390,100 | 3993×2481 | `onboarding_welcome_zh_dark_default` |
| 6 | webp | 182,360 | 1782×1527 | `onboarding_recharge_default` |
| 7 | webp | 206,786 | 1785×1530 | `onboarding_recharge_dark_default` |
| 8 | webp | 180,360 | 1785×1530 | `onboarding_recharge_zh_default` |
| 9 | webp | 224,762 | 1785×1530 | `onboarding_recharge_zh_dark_default` |
| 10 | svg | 872 | 40×40 | `onboarding_office_default` |
| 11 | svg | 476 | 40×40 | `onboarding_code_default` |
| 12-15 | svg | 527+871+640+335 | 图标 | 匿名（选择器/返回图标） |
| 1 | svg | 2,628 | 19×22 | spinner |

**8 张 WebP 占 2,400,254 B（99.7%），7 张 SVG 合计仅 6,349 B。**

### 三个关键修正

**修正 1：这不是「设置页图标」，是 onboarding 引导页插画。**

审计报告标题写的是「设置页图标必须照常显示」，但实测这 8 张 WebP 全部是 `DesktopOnboarding` 组件的
**欢迎页与充值页插画**，与设置页图标无关。设置页图标是那 7 张 SVG，加起来 6 KB——剥不剥都无所谓。

引用点（各 1 处，`b1-svg-usage.mjs`）：
```jsx
<OnboardingIllustration src={locale === "zh" ? onboarding_welcome_zh_default : onboarding_welcome_default}
                       darkSrc={locale === "zh" ? onboarding_welcome_zh_dark_default : onboarding_welcome_dark_default} />
```
**这直接消解了原任务里那条约束**（「设置页图标必须照常显示，否则放弃」）——剥掉这 8 张图不会碰到任何设置页图标。

**修正 2：不是 PNG，是 WebP；不是多倍图，是单张超大图。**

3993×2480 ≈ **990 万像素**，是给桌面端设计的一张原图，在 1080p 屏幕上按 CSS 缩放显示。
它不是 @1x/@2x/@3x 多倍图方案——就是一张大图。

**修正 3：8 张里一次只用 1 张。**

按 `locale`（zh/en）× 明暗（default/dark）四选一，再加 welcome/recharge 两页。
**任一时刻最多显示 1 张**，但 8 张的 base64 全都在同一个 bundle 里、全部要被下载和解析。

### 为何当初内联

上游打包方式：这是 desktop onboarding 的产物，用 base64 内联换取「单文件分发、零额外请求、离线可用」。
对桌面 Electron/Web 场景是合理取舍；对本机回环 + WebView 场景，代价与收益不对等。

---

## 第二问：能不能外链/懒加载

**技术上能，但收益远小于报告估计。**

### 能否外链：能

改成静态资源路由 + `<img src="/assets/onboarding/welcome.webp">` 即可。onboarding 本就在引擎起来后才渲染，离线可用性可接受。

### 能否懒加载：**收益有限，因为那张图在首屏就要显示**

`DesktopOnboarding` 的 `step: "welcome"` 是**首屏第一屏**。用户首次安装打开就看到它。
所以「按需解码」只能省下**没被选中的 7 张**（约 1.6 MB 的 base64），不能省下当前这张。

### 关键：真实收益比报告小得多，因为引擎**根本没开 gzip**

这是本次调查最重要的发现。审计报告的核心收益论证是：
> 「`dsh-host-webserver/lib/index.js:106-131` 的 gzip 中间件逐响应现压、无输出缓存……实测单独压该包 level 1 中位 **718.19 ms**」

**实测与源码都指向这个前提不成立：**

1. **源码默认关闭**：`dsh-host-webserver/lib/index.js`
   ```js
   const DEFAULT_COMPRESSION = "none";
   this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;
   if (this.gzip === void 0) next();
   ```
2. **整个快照里没有任何地方把它设成 `gzip`**：全树搜 `compression` 只命中上面这 3 行定义与 schema，
   `engine-overlay.json` 里的 `compression` 是 **npm 依赖版本号 1.8.1**，不是配置项。
3. **壳侧与桥接侧也没有 gzip**：`app/src/main/java/.../*.kt` 与 `plugins/dsh-android-bridge/src/index.ts`
   搜 `Content-Encoding|gzip` 只命中 `bitmap.compress(PNG)`（无关）。
4. **我复现不出 718 ms**：同一文件、同 level 1、两种方法各跑 5 次取中位：
   ```
   A gzipSync    level=1 median: 87.9 ms  out=2470230
   B streaming   level=1 median: 95.3 ms  out=2470230
   ```
   **约 90 ms，不是 718 ms（差 7.4 倍）。** 报告那个数我无法复现，可能是别的机器状态或别的文件。

**结论**：既然引擎不压缩，那么「省 gzip CPU」这条收益**不存在**。真实可省的是：

| 项 | 实测 | 说明 |
|---|---:|---|
| base64 解码 | **5.4 ms** | 一次，全部 15 张 |
| V8 解析 | **< 1 ms** | 两种变体都测不出（`new vm.Script` 中位 0.0 ms） |
| 传输字节 | **-2.29 MiB** | 唯一真实收益，但走的是**本机回环**，不是网络 |
| 浏览器缓存 | **不重复付** | `IMMUTABLE_CACHE = "public, max-age=31536000, immutable"` |

**唯一站得住的收益是「首屏 raw 字节 -2.29 MiB」**，而这份字节走本机回环、且有 `immutable` 一年缓存。
它对**首次安装后的第一次启动**有意义（少读 2.29 MiB 磁盘 + 少 2.29 MiB 内存驻留），对日常冷启动**无意义**（命中缓存）。

---

## 第三问：改完怎么证明没影响

**拿不到合格的证明，这也是不做的直接理由之一。**

### 为什么拿不到「图标清单前后对比」

1. **没有设备**：本轮模拟器与真机全部关闭（这是整个审计的前提约束）。
   而 onboarding 插画的正确性**只能靠人眼看**——它是插画，不是有明确语义的图标，
   DOM 断言只能证明 `<img>` 存在且 `src` 非空，证明不了「图画对了」。
2. **onboarding 是首次安装才出现的状态机**：`completion: "completed"|"skipped"|"api-key"` 一旦落盘，
   后续启动直接跳过（`step: "done"`）。要在设备上复看必须清数据重装，且要看全 8 张需要
   切换 locale（zh/en）× 明暗主题 × welcome/recharge 两页 = **8 种组合**，每种都要重新走一遍 onboarding。
3. **改的是上游产物字节**：走 `scripts/patches/` 运行时补丁面会打破 `check-patch-mirror.mjs` 逐字节镜像，
   需要铁律 6 双仓同步，且**每次上游 bump 都要重做**。

### 退一步说，即使能做，验收成本也高于收益

| 收益 | 成本 |
|---|---|
| 首次安装首屏少 2.29 MiB 本机回环读取 | 上游补丁面 + 双仓同步 + 每次 bump 重做 |
| base64 解码省 5.4 ms（一次性） | 8 种组合 × 设备人眼验收 |
| 内存驻留少约 2.3 MB | 拿不到可复现的前后对比证据 |

---

## 最终结论：不做

**理由（按重要性）**

1. **收益前提被证伪**：报告的核心论据是「引擎逐响应现压 gzip，压这个包要 718 ms」。
   实测引擎 `compression` 默认 `none` 且全树无人开启，我复现出的 gzip 成本是 90 ms 而非 718 ms。
   **「省 CPU」这条不存在**，剩下的只有本机回环上的字节数。
2. **唯一真实收益的场景很窄**：`immutable` 一年缓存意味着只有**首次安装后的第一次启动**会付这份字节，
   日常冷启动命中缓存。而本轮审计的主题是**冷启动**。
3. **改动面与收益不成比例**：上游产物补丁 + 逐字节镜像 + 每次 bump 重做，换「首装首屏少 2.29 MiB」。
4. **验收证据拿不到**：无设备、8 种组合、插画正确性只能人眼判断。按本仓铁律 2，
   拿不到证据的 L3 改动不得进发版候选。

**这不是「为了减体积硬拆」的反面，而是「减了体积但收益不成立」**——所以不做。

---

## 如果将来要重开这条，先做这三件事

1. **先确认引擎是否该开 gzip**。如果开（`compression: "gzip"`），那么 90 ms/次的压缩成本是真实的，
   而且影响的是**所有** bundle 而不只这一个——那时剥内联图的优先级会显著上升。
   **这是一个比 #1 本身更值得单独评估的问题**，建议记入 known-gaps。
2. **确认日常冷启动是否真的命中 `immutable` 缓存**。若 WebView 因某种原因不复用缓存，
   则每次冷启动都要重读 3.4 MB，收益会回升。这需要设备侧 CDP 看 `Network` 面板的 `fromDiskCache`。
3. **先量首装首屏的真实耗时差**，而不是字节差。字节差已确证是 2.29 MiB，但它在回环上的时间可能只有几十毫秒。

## 复现入口

```bash
# 1. 从快照取出目标 bundle
tar -xJf app/src/main/assets/snapshot.tar.xz -C .deploy-tmp/b1 \
  'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'

# 2. 载荷构成与 gzip 差值
node scripts/perf-audit-b/inline-image-payload.mjs <client.js>

# 3. 15 张图的类型/尺寸/变量名
node scripts/perf-audit-lead/b1-what-are-they.mjs <client.js>

# 4. 每张图被谁引用
node scripts/perf-audit-lead/b1-svg-usage.mjs <client.js>

# 5. gzip 成本（两种方法对照，证伪 718 ms）
node scripts/perf-audit-lead/b1-gzip-method.mjs <client.js>

# 6. 引擎是否开 gzip
grep -n 'DEFAULT_COMPRESSION\|compression ===' <webserver>/lib/index.js
```
