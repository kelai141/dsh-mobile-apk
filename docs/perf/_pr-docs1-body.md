# 审计留痕：#1 内联位图调查结论为不做

纯文档 + 只读分析脚本。**不改任何产品代码**（`git status -- app plugins vendor` 为空）。

## 结论

性能审计 `#1`「剥掉 `dsh-client-ui-settings-account` 的 5.08 MB 内联 base64 位图」——**不做**。

不是收益不成立，而是**收益的类型与量级和原判断不符**。调查推翻了自己报告里的核心论据。

## 三条推翻原判断的证据

### 1. 这不是设置页图标，是 onboarding 引导页插画

`lib/client.js` = 3,424,638 B，其中 **93.7% 是 15 张内联图**：

| 类型 | 张数 | 解码后字节 | 尺寸 |
|---|---:|---:|---|
| **WebP** | **8** | **2,400,254（99.7%）** | 最大 **3993x2480**（约 990 万像素） |
| SVG | 7 | 6,349 | 19x22 / 40x40 |

8 张 WebP 全在 `DesktopOnboarding` 的欢迎页/充值页里，按 `locale`（中/英）x 明暗 x 两页四选一，**任一时刻最多显示 1 张**。
设置页图标是那 7 张 SVG，合计 **6 KB**——原任务里「设置页图标必须照常显示，否则放弃」这条约束**不适用**。

### 2. 引擎根本没开 gzip（这条最关键）

原报告的核心论据是「引擎逐响应现压，压这个包 **718 ms**」。前提不成立：

```js
const DEFAULT_COMPRESSION = "none";
this.gzip = resolved.compression === "gzip" ? createGzipMiddleware(resolved) : void 0;
if (this.gzip === void 0) next();
```

- 全快照搜 `compression` 只命中这处定义与 schema；`engine-overlay.json` 里的 `compression: "1.8.1"` 是 **npm 依赖版本号**。
- 壳侧 `*.kt` 与 `plugins/dsh-android-bridge/src/index.ts` 搜 `Content-Encoding|gzip` 只命中 `bitmap.compress(PNG)`（无关）。
- **718 ms 复现不出**：同文件、同 level 1、两方法各 5 次取中位：
  ```
  A gzipSync  level=1 median: 87.9 ms
  B streaming level=1 median: 95.3 ms
  ```
  约 **90 ms**，差 7.4 倍。

⇒ **「省引擎 gzip CPU」这条收益不存在。**

### 3. 真实可省的只有这些

| 项 | 实测 |
|---|---:|
| base64 解码（一次性，全部 15 张） | **5.4 ms** |
| V8 解析 | 测不出（两种变体都 <1 ms） |
| 首屏 raw 字节 | **-2.29 MiB** |
| 是否重复付 | **不重复**——`IMMUTABLE_CACHE = "public, max-age=31536000, immutable"` |

**唯一站得住的收益是「首屏 raw -2.29 MiB」**，走本机回环且有一年缓存 ⇒ **只有首次安装后的第一次启动**会付，日常冷启动不付。而本轮审计主题正是冷启动。

## 为什么不做的四条理由

1. **收益前提被证伪**：718 ms 不存在，真实 gzip 成本 90 ms，且引擎压根没开。
2. **唯一真实收益场景很窄**：一年 `immutable` 缓存意味着只有首装首启付。
3. **改动面与收益不成比例**：上游产物补丁 + 破坏 `check-patch-mirror.mjs` 逐字节镜像（铁律 6 双仓同步）+ 每次上游 bump 重做。
4. **验收证据拿不到**：无设备（本轮前提约束）；onboarding 是首装才出现的状态机（`completion: completed|skipped|api-key` 落盘后直接 `step: "done"`）；要看全 8 张需清数据重装 x locale x 明暗 x 两页 = **8 种组合**，而插画正确性只能人眼判断。按铁律 2，拿不到证据的 L3 改动不得进发版候选。

**这是「减了体积但收益不成立」，不是「为了减体积硬拆」的反面。**

## 本 PR 内容

| 文件 | 作用 |
|---|---|
| `docs/perf/#1-INVESTIGATION-2026-11-03.md` | 三问完整结论 + 复现入口 |
| `docs/perf/AUDIT-2026-11-02.md` | `#1` 标注改为「已调查：不做」，并注明 718 ms 与「决定性量级」判断**已被推翻，保留原文仅为留痕** |
| `docs/AGENTS/known-gaps.md` | 新增「引擎该不该开 gzip」待评估条目（见下） |
| `scripts/perf-audit-lead/b1-*.mjs` | 4 个只读复现脚本 |

## 顺带登记的待评估问题

调查发现一个比 `#1` 本身更值得单独看的问题：**引擎该不该开 gzip**。已写进 `known-gaps.md`，标「待评估，不在本轮」，含三条权衡：

1. **回环带宽不是瓶颈**（引擎与 WebView 同机，不经真实网络链路）。
2. **开 gzip 是拿 CPU 换字节**（该包 level 1 要 90 ms，剥载荷后只要 2.1 ms，即这份 CPU 几乎全由内联图造成）。
3. **影响面是所有 bundle**（`createGzipMiddleware` 挂全局路由），收益与风险要按全集评估。

并记录了削弱该论据的既有事实：bundle 带一年 `immutable` 缓存，即使开 gzip 也只在**首次请求**压一次，不是每次冷启动。

## 复现

```bash
# 从快照取出目标 bundle
tar -xJf app/src/main/assets/snapshot.tar.xz -C .deploy-tmp/b1 \
  'usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-ui-settings-account/lib/client.js'

node scripts/perf-audit-b/inline-image-payload.mjs <client.js>   # 载荷构成 + gzip 差值
node scripts/perf-audit-lead/b1-what-are-they.mjs <client.js>    # 15 张图的类型/尺寸/变量名
node scripts/perf-audit-lead/b1-svg-usage.mjs <client.js>        # 每张图被谁引用
node scripts/perf-audit-lead/b1-gzip-method.mjs <client.js>      # gzip 成本（两方法对照，证伪 718ms）
```

## 验证

| 项 | 结果 |
|---|---|
| 产品代码改动 | **无**（`git status -- app plugins vendor` 为空） |
| `check-code-map.mjs` | 不适用（未改源码行号） |
| 文档改动 | 纯 markdown 追加/标注 |
