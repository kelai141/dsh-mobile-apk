# 缺陷 3「整体卡顿（无量化数据）」：先量化、再只修真瓶颈

用户报的是「整体卡顿」，没有任何量化数据。本轮的顺序是：**先把三条量出来**（bundle 体积 / 每帧与每批
DOM 扫描 / 静止常驻跨桥），再按「影响面 × 触发频率」排序，最后只改排在最前的那几处。设备侧（CDP 与
ADB 用户层）本轮**未执行**，理由见文末。

## 0. 结论先行

| 热点 | 触发频率 | 影响面 | 修复前 | 修复后 |
|---|---|---|---|---|
| `back-stack.ts` 的 `detect()` 每批 10 次整文档查询 | 每个 DOM 提交批（流式输出时每秒数十次） | 全部会话视图，随会话长度线性恶化 | 10.00 次/批 | 1.00 次/批 |
| 无弹层时滚动仍跑整文档查询（guard + fold + header-popups 三处 capture scroll） | 每个滚动帧 | 滚动时；无弹层时是纯浪费 | 4.00 次/帧 | 0.00 次/帧 |
| 静止常驻 1 Hz 同步跨语言桥（无会话上屏时） | 常驻 | 全局 | 1 次/秒 | 0 次/秒 |
| 聚合每批整文档查询（n=400 / n=1600） | 同上 | 同上 | 12.60 / 13.00（两档不等） | 5.00 / 5.00（相等） |

判据落点：`dsh-client-ui-responsive/tests/` 下四个 spec，全部**可测量**（真 DOM + 真流式提交，
数 `querySelector` 调用次数），不读源码字符串。反向对照（防假绿）每条都有。

## 1. 三条量化（命令 + 原始数字）

### 1.1 注入后 bundle 体积：对 **0.14.x 发布产物**，不是对上一 commit

基线取 `git tag v0.14.10`（其 `package.json` 版本同为 0.3.3），用 `git archive`
解到临时目录后 `npm ci` + `npm run build`，**不改本仓 git 状态**：

```powershell
$tmp = Join-Path $env:TEMP 'dsh-perf-baseline-v01410'
git archive v0.14.10 dsh-client-ui-responsive | tar -x -C $tmp
Push-Location "$tmp\dsh-client-ui-responsive"; npm ci --no-audit --no-fund; npm run build; Pop-Location

# 本 worktree
cd dsh-client-ui-responsive; npm ci; npm run build
node -e "const fs=require('fs'),z=require('zlib');const b=fs.readFileSync(process.argv[1]);console.log('raw='+b.length,'gzip='+z.gzipSync(b,{level:9}).length)" lib/client.js
```

原始读数：

```
本 worktree HEAD : client.js raw=1,002,801 B / gzip=299,140 B
v0.14.10         : client.js raw=  822,297 B / gzip=238,947 B
差               : +180,504 B（+22.0% raw）/ +60,193 B（+25.2% gzip）
```

涨在哪（按 sourcemap 的 `sourcesContent` 逐模块字符数差，可复现）：

```
+61,403  src/client/mobile/composer-sheet.ts
+20,194  src/client/mobile/file-card-actions.ts
+17,048  src/client/linux-environment/LinuxEnvironmentSection.tsx
+14,944  src/client/linux-environment/transport.ts
+13,397  src/client/mobile/composer-sheet.css.ts
+13,047  src/client/mobile/activation-guard.ts
+12,384  src/client/mobile/lightbox-zoom.ts
 +8,763  src/client/index.ts
 +8,247  src/client/dev-section/phone-control.tsx
 +4,036  src/client/mobile/settings-nav.ts
-15,841  src/client/mobile/attachment-picker-menu.ts（退役）
-11,209  src/client/mobile/clipboard-model-drafts.ts（退役）
 -4,081  src/client/mobile/clipboard-model-config.ts（退役）
```

**结论**：体积涨的是**新功能**（加号底部 sheet、交付文件卡、Linux 环境页、激活纪律），不是某个热点模块
膨胀。1.0 MB 注入包在 Chromium 87 上的解析/编译是 TTI 的一项固定成本，但它是「新增能力」的代价，
**不是本轮要修的对象** —— 砍功能换体积不在这个缺陷的范围内。

### 1.2 每帧 / 每批 DOM 扫描（主线程长任务来源）

用 jsdom + vitest 造「正文追加 3 个节点 = 一次 React 提交」的流式形状，在 `Document.prototype`
与 `Element.prototype` 上打桩数 `querySelector(All)` 调用次数与扫描元素数
（工具：`tests/dom-scan-counter.ts`）。两类分开记：`documentCalls` 是整树遍历（代价 ∝
文档大小），`elementCalls` 是子树遍历（代价 ∝ 子树大小）。判据只看前者。

聚合（boot 时全部无条件自动挂载的观察者一起开）：

```
n=525   元素 → 19.9 次查询/批， 9,279 元素/批，相对无观察者基线 +191%
n=1,725 元素 → 20.0 次查询/批，33,340 元素/批，+847%
n=3,325 元素 → 20.0 次查询/批，65,340 元素/批，+1,394%
```

逐观察者拆（calls/batch，n=400 → n=1,600）：

```
back-stack              10.0 → 10.0   ← 单点最大，占聚合 20 次的一半
form-marker              2.0 →  2.0
session-log-dialog       2.0 →  2.0
trajectory-panels        2.0 →  2.0
composer-popup-guard     1.2 →  1.0
top-bar-fold             1.1 →  1.0
snapshot-panels          1.0 →  1.0
file-card-capsule        1.0 →  1.0
settings-nav             1.0 →  1.0
main-panel-back          1.0 →  1.0
drawer-overlay-dismiss   0.0 →  0.0（只观察 frame 的单个属性）
```

滚动帧（无任何弹层打开，60 帧）：**6.00 次查询/帧，7,248 元素/帧**。其中 2 次是子树查询，
真正整文档的是 4 次 —— 来源是三个在 `window` 上挂**捕获阶段** scroll 的模块。

### 1.3 启动到可交互

本地可做的部分只有「注入包体积」（见 1.1）与「每批扫描」（见 1.2）；真正的 TTI 分段（DCL / load /
首绘 / 注入标记出现）需要页面侧 `performance` 读数，已写进 `scripts/verify-frame-timing.mjs`
的 C 组探针，**等设备**。

## 2. 影响面 × 触发频率排序

| 序 | 热点 | 触发频率 | 影响面 | 静止也跑 |
|---|---|---|---|---|
| 1 | `back-stack.ts` `detect()` 每批 10 次整文档查询 | 每个 DOM 提交批 | 全部会话视图，随会话长度线性恶化 | 否（要有 DOM 变更），但流式/输入时一直在跑 |
| 2 | `form-marker` / `session-log-dialog` / `trajectory-panels` 各 2 次整文档查询 | 同上 | 同上 | 否 |
| 3 | `composer-popup-guard` / `top-bar-fold` / `header-popups` 的 capture scroll | 每个滚动帧 + 每批变更 | 滚动时卡；无弹层时纯浪费 | 否 |
| 4 | `NativeBrowserPlacement` 1 Hz 同步跨语言桥 | 常驻 | 全局 | **是** |
| 5 | `index.ts:998` 4 s 来件轮询 | 常驻 | 全局 | **是**（本轮不改，见 §6） |

排序口径是**影响面 × 触发频率**，不是「代码看起来脏」。用户说的「整体卡顿」最匹配的是 1+2
（每次提交都付 20 次全文档扫描，会话越长越慢），这是本轮修的主体。

## 3. 判据（先红后绿）

### 3.1 back-stack 检测扫描预算（A）

`tests/back-stack-scan-budget.spec.ts`

- ① 每批提交的整文档查询 ≤ 2 次。
- ② 反证：三个「属性在创建时写好、随后整棵子树插入」的层（dialog / 触发器菜单 / 附件 sheet）
  仍靠 `childList` 进场，深度 = 3，uplink 每次可用性翻转恰好一条。
- ③ 反证：ModelSelect 门户与右侧全屏层仍被识别（合成选择器不得漏层）。
- ④ **交叉场景**：同一个元素同时命中 `[data-trigger-menu]` 与 `.dshm-overlay` 时仍是
  **两层**，且顺序仍是 `menu` 在 `marketplace` 之前（旧实现两个 `querySelector`
  各自命中，合成后必须保持）。
- ⑤ **交叉场景**：`[data-trigger-menu] nav` 是**关系查询**。第一个菜单没有 nav、第二个有时，
  必须命中第二个菜单里的 nav，且不能误配到菜单之外的 nav。

修复前红（原始输出）：

```
stdout | tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ① 每批提交的全文档查询 ≤ 2 次
① per_batch_queries=10.00
 × tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ① 每批提交的全文档查询 ≤ 2 次 1927ms
   → 每批提交的全文档查询次数（修复前 10.00）: expected 10 to be less than or equal to 2
```

修复后绿（原始输出）：

```
stdout | tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ① 每批提交的全文档查询 ≤ 2 次
① per_batch_queries=1.00
 PASS tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ① 每批提交的全文档查询 ≤ 2 次 2243ms
 PASS tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ② 反证：三个「属性在创建时写好」的层仍靠 childList 进场，深度=3
 PASS tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ③ 反证：ModelSelect 门户与右侧全屏层仍被识别（合成选择器不得漏层）
 PASS tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ④ 交叉场景：一个元素同时命中两个选择器时仍是两层，且顺序与旧实现一致
 PASS tests/back-stack-scan-budget.spec.ts > back-stack 检测扫描预算 > ⑤ 交叉场景：关系查询 [data-trigger-menu] nav 只认菜单之内的面包屑
```

### 3.2 滚动帧扫描预算（C）

`tests/scroll-frame-budget.spec.ts`

- ① 没有弹层打开时，滚动 30 帧的整文档查询次数 = 0。
- ② 反证（防假绿）：**真的打开一个会被几何修正的弹层**（输入卡里带 `aria-controls` 的触发器 +
  body 门户 `role=menu` + `data-menu-material=translucent`，即 ModelSelect 的真实形态）后
  滚动，查询次数必须 > 0，且 `--dsh-mobile-popup-shift` 真的被写过。只把 scroll 监听删掉的改法
  在这里红。

修复前红（原始输出）：

```
stdout | tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0
① per_frame_queries=4.00
 × tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0 3034ms
   → 无弹层时的每帧全文档查询次数（修复前 6.00）: expected 4 to be +0 // Object.is equality
```

（读数从早期 6.00 变 4.00，是因为计数器口径从「全部 querySelector」收窄为「只数
`document.querySelector`」——4.00 才是真值，6.00 里混了 2 次子树查询。）

**只改 guard + fold 时停在 1.00**（这是本轮真排查的一步，不是凑数）：

```
stdout | tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0
① per_frame_queries=1.00
 × tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0 2456ms
   → 无弹层时的每帧全文档查询次数（修复前 6.00）: expected 1 to be +0 // Object.is equality
```

查下去发现**第三个**在 `window` 上挂 capture scroll 的模块：`header-popups.ts:45`，
它的 `sync()` 里有 `document.querySelector(FOLD_SELECTOR)`。补上这一处才归零。

修复后绿（原始输出）：

```
stdout | tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0
① per_frame_queries=0.00
 PASS tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ① 没有弹层打开时，滚动一帧的全文档查询 = 0 2401ms
stdout | tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ② 反证：真的打开一个被几何修正的弹层后，滚动必须仍然测量它
② per_frame_queries=2.00 shift="248px"
 PASS tests/scroll-frame-budget.spec.ts > 滚动帧扫描预算 > ② 反证：真的打开一个被几何修正的弹层后，滚动必须仍然测量它 2478ms
```

### 3.3 聚合扫描的规模不变性（B）

`tests/dom-scan-budget.spec.ts`

**不设绝对阈值**：绝对阈值（「每批 ≤ N 次」）在观察者增删时会变成噪声源——加一个观察者就红，
与卡顿无关。这里只断言**规模不变性**：同一批提交在 n=400 与 n=1,600 两档会话上，整文档查询次数必须
相同。它守的是一条结构性质：注入层每批的代价是常数，不随会话长度增长。常数本身太大这件事，由 3.1 与
3.2 两条针对性预算守。

- ① n=400 与 n=1,600 两档读数必须相等。
- ② 反向对照：计数器能数出真实调用（两档夹具都读到 5 次）。

修复前红（原始输出）：

```
stdout | tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ① 每批整文档查询次数与文档规模无关（n=400 与 n=1600 同值）
① small=12.60 large=13.00
 × tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ① 每批整文档查询次数与文档规模无关（n=400 与 n=1600 同值） 3806ms
   → 小文档每批整文档查询次数: expected 12.60 to be 13
```

**注意**：这条红最初不是产品缺陷，是**测量不确定度** —— 本包的合帧窗口不止一种（rAF /
`setTimeout(0)` / microtask），早期 `settle()` 只等两轮宏任务，rAF 那一类会跨批漂移
（约 16ms 节拍追不上），两档读数差 0.4。把 `settle()` 改成「先等一帧 rAF，再等两轮宏任务」后
两档严格相等。**0.4 的容差是尺子的问题，不是产品属性**，所以修的是尺子，不是放宽判据。

修复后绿（原始输出）：

```
stdout | tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ① 每批整文档查询次数与文档规模无关（n=400 与 n=1600 同值）
① small=5.00 large=5.00
 PASS tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ① 每批整文档查询次数与文档规模无关（n=400 与 n=1600 同值） 4000ms
stdout | tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ② 反向对照：计数器能数出真实调用（两档夹具都读到 5 次）
② fixture_readings=[5,5]
 PASS tests/dom-scan-budget.spec.ts > 注入层扫描的规模不变性 > ② 反向对照：计数器能数出真实调用（两档夹具都读到 5 次） 844ms
```

### 3.4 静止常驻轮询的必要性

`tests/idle-poll-budget.spec.ts`

判据口径 = 「没有可对账的对象就不该跨桥」：没有会话上屏（`mounted() === undefined`）就没有 GUI
挂载点，也没有 AI 新建原生 Tab 的落点，这一拍无论原生侧答什么都不可能产生写操作。

- ① 没有会话上屏、也没有 pending 时，1 秒窗口内 `browserHostCommand` 调用 = 0。
- ② 正向用例：出现一个浏览器 Tab 后必须继续轮询并 `claim`（`select` 真的被发出去）。
- ③ 正向用例：有未完成 claim 的 pending 会话时必须继续轮询。
- ④ 正向用例：会话重新上屏后轮询必须自己恢复（不能停在 idle）。

修复前红（原始输出）：

```
stdout | tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ① 没有浏览器 Tab 也没有 pending 时，1 秒内不跨桥
① attach_calls=1 idle_window_calls=1
 × tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ① 没有浏览器 Tab 也没有 pending 时，1 秒内不跨桥 1401ms
   → 空闲 1 秒内的跨桥调用次数（修复前 1）: expected 1 to be +0 // Object.is equality
```

修复后绿（原始输出）：

```
stdout | tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ① 没有会话上屏、也没有 pending 时，1 秒内不跨桥
① attach_calls=0 idle_window_calls=0
 PASS tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ① 没有会话上屏、也没有 pending 时，1 秒内不跨桥 1689ms
stdout | tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ④ 正向用例：会话重新上屏后轮询必须自己恢复（不能停在 idle）
④ calls_after_wake=1
 PASS tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ④ 正向用例：会话重新上屏后轮询必须自己恢复（不能停在 idle） 1531ms
stdout | tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ② 正向用例：出现一个浏览器 Tab 后必须继续轮询并 claim
② total_calls=3 select_calls=1
 PASS tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ② 正向用例：出现一个浏览器 Tab 后必须继续轮询并 claim 1209ms
stdout | tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ③ 正向用例：有未完成 claim 的 pending 会话时必须继续轮询
③ tabs_calls=3
 PASS tests/idle-poll-budget.spec.ts > 静止常驻轮询的必要性 > ③ 正向用例：有未完成 claim 的 pending 会话时必须继续轮询 2516ms
```

### 3.5 全包回归

```
cd dsh-client-ui-responsive; npx vitest run
 Test Files  87 passed (87)
      Tests  1213 passed (1213)
```

## 4. 7 个文件逐个说明

| # | 文件 | 改动 | 为什么 |
|---|---|---|---|
| 1 | `src/client/mobile/back-stack.ts` | +106/−38 | `detect()` 原来每批跑 10 次 `document.querySelector(All)`（10 次全树遍历），改成 **1 次并集选择器** `CANDIDATE_SELECTOR` + 内存归类。观察面、合帧窗口、层语义、栈顺序一个不动；#5 兜底 / #13 关系查询 / #6 全部 dialog 三处语义在代码注释与 ④⑤ 用例里逐条钉住。 |
| 2 | `src/client/composer-popup-guard.ts` | +17/−2 | `onViewportChange` 加 `openPopups > 0` 闸：没有弹层时 scroll/resize 不再排队进 `apply()`。闸门由 `apply()` 自己维护（`clear()` 归零），弹层出现仍由 mutation observer 拾取，所以「弹层打开后仍必须测量」不受影响。 |
| 3 | `src/client/mobile/top-bar-fold.ts` | +15/−2 | scroll 走新的 `onScroll`（`open` 为假不 schedule）。`resize` 仍无条件 —— 跨形态断点要改整个呈现。 |
| 4 | `src/client/mobile/header-popups.ts` | +14/−2 | **不在初始计划，是 C 的必要补充**。它是第三个在 `window` 上挂 capture scroll 的模块，`sync()` 里 `document.querySelector(FOLD_SELECTOR)` 也是整文档查询。只改前两处时 C ① 停在 1.00（原始输出见 §3.2），所以必须一起收。闸门 = `this.active !== null`（后台任务浮窗没打开时无事可做）。 |
| 5 | `src/client/mobile/native-browser-adapter.ts` | +15 | 新增只读方法 `hasNativeInterest()`：有绑定 / 有帧 / 上次读失败，三者有其一才算有兴趣。不改任何既有行为。 |
| 6 | `src/client/mobile/native-browser-auto-place.ts` | +35/−3 | `schedule()` 收尾改为 `if (!document.hidden && this.needsPolling()) this.schedule()`；新增 `needsPolling()`（pending 非空 / 有会话上屏 / 某个 workspace 有兴趣）与 `wake()`（新 workspace 或上屏时重启循环）。 |
| 7 | `src/client/index.ts` | +9/−2 | `placement.attach()` 外面订阅 `scope.sidebarRight.mounted`，会话重新上屏时调 `placement.wake()`。没有这一条，轮询停掉后 AI 新建的原生 Tab 永远拿不到 GUI 挂载点 —— spec ④ 就是钉这个的。 |

新增文件（都在 `dsh-client-ui-responsive/tests/`）：

- `dom-scan-counter.ts`：`document` / `element` 两类查询分开计数（量纲不同，混一起会
  失真）；`settle()` 先等一帧 rAF 再等两轮宏任务（三种合帧窗口都要结算一次）。
- `dom-scan-fixtures.ts`：boot 面观察者统一 attach，**任何一步抛异常都会把已挂上的逐个 detach
  再抛**（实测：构造中途抛异常会让观察者漏给下一个用例，下一用例多读到 50 次查询）。
- `back-stack-scan-budget.spec.ts` / `dom-scan-budget.spec.ts` /
  `scroll-frame-budget.spec.ts` / `idle-poll-budget.spec.ts`。

## 5. `scripts/verify-frame-timing.mjs`

设备侧原始读数采集器。**不是门禁**：不判红判绿，只把三类数字原样打出来；判据在 §3 的离线 spec 里。

- A 滚动帧：rAF 帧间隔 p50/p95/max、>50ms 帧数、longtask 条数与总阻塞时长。`summarizeFrames`
  给出机械判定：**帧间隔大 + longtask 有阻塞 → `main-thread`；帧间隔大而 longtask 为 0 →
  `renderer`**。这就是「主线程长任务 vs 渲染层」的区分依据。
- B 静止：5 秒内 `browserHostCommand` 的调用次数、每次调用前后 `performance.now()` 的差
  （同步跨语言调用在页面线程上的阻塞时长）、阻塞占比与最坏单次。
- C 启动分段：DCL / load / 首绘 / 注入标记出现时刻，以及「首绘→标记」「标记→load」两段差。

`--self-test`（无设备，10 例，含三条反向对照）：

```
▶ percentile
  PASS 空样本返回 NaN，单样本返回自身 (2.018ms)
  PASS 线性插值：10 个样本的 p50 落在第 5、6 个之间 (0.4723ms)
▶ summarizeFrames
  PASS 主线程形状：帧间隔大且 longtask 有阻塞 → main-thread (1.0405ms)
  PASS 渲染层形状：帧间隔大但一条 longtask 都没有 → renderer (0.5431ms)
  PASS 反向对照：同一函数在顺滑输入上给 smooth（判定不是恒真） (0.5532ms)
  PASS 短 longtask 不足以判主线程（阈值 50ms 阻塞） (0.708ms)
▶ summarizeIdle
  PASS 计数、频率、阻塞占比与最坏单次 (3.3077ms)
  PASS 反向对照：零调用时频率与阻塞都是 0（不是 NaN） (0.7458ms)
▶ summarizeStartup
  PASS 分段差值按「标记 − 首绘」与「load − 标记」算 (0.7974ms)
  PASS 缺项为 null，不伪造成 0（未知与零必须分开） (0.4674ms)
ℹ tests 10
ℹ pass 10
ℹ fail 0
```

## 6. 本轮**不改**的两处，以及为什么不改

### 6.1 `index.ts:998` 的 4 s 来件轮询

它打的是 `/api/android/file-incoming` —— **引擎侧路由**，不是壳桥。要做到「有来件才轮询」，需要
引擎侧提供推送/信号能力；本轮没有这条通道，能做的只有：

- 砍掉轮询 → **直接破 S3-21**（用户从别的应用分享文件进来，页面永远不知道），不可接受；
- 收窄成「前台 + 可见 + 在会话视图」→ 可见性判据已经有了（`document.visibilityState === 'visible'`），
  再收窄就要判断「当前视图能不能接附件」，那是把可达性赌在一个 UI 状态上。

判断依据：**这是已知常驻成本，代价未量化；本轮不改，是因为改法要么破可达性、要么依赖尚不存在的
引擎侧信号**，不是「待度量所以先放着」。代价本身由 `verify-frame-timing.mjs` 的 B 组在设备上采
（它拦的是 `androidBridge` 面，来件轮询走 fetch，要分开计需另加探针）。

### 6.2 同步跨语言调用的风险等级（只给结论，不改代码）

`window.androidBridge.browserHostCommand` 是 `@JavascriptInterface`：在 WebView 的
JavaBridge 线程上**同步**执行，页面线程等它返回。壳侧实现在 `BrowserHost.command`
（`BrowserHost.kt:563`），外层是 `onMain { ... }`（`BrowserHost.kt:2377`）：

```kotlin
private fun <T> onMain(block: () -> T): T? {
    if (Looper.myLooper() == Looper.getMainLooper()) return block()
    var result: T? = null
    val latch = CountDownLatch(1)
    main.post { try { result = block() } finally { latch.countDown() } }
    return if (latch.await(2, TimeUnit.SECONDS)) result else null
}
```

**最坏阻塞 = 2 秒**（`latch.await(2, TimeUnit.SECONDS)`），超时后返回
`commandUnavailable("", "main-thread-timeout")`。所以这条路径的理论最坏情况是**页面线程被阻塞
2 秒**——那已经越过「卡顿」进入 ANR 风险区间（Android 主线程 5 s 无响应即 ANR，而这里阻塞的是页面
线程，表现为整页冻结）。它**不可能发生在 Android 主线程上**（JavaBridge 线程调进来，壳侧再用
`onMain` 转投主线程），但「不在主线程」不等于「不卡」。

本轮做的是把这条调用的**触发频率**从「常驻 1 Hz」降到「有事才跑」，不改阻塞上限（那要改壳侧协议，
属于桥面契约变更，不在本缺陷范围）。**单次代价必须设备侧量**，`verify-frame-timing.mjs` 的
B 组就是量它。

## 7. 本轮**未执行**的验证层

- **CDP 层（设备）**：未执行。理由：本 worktree 没有连接的安卓设备（`adb devices` 为空），CDP 需要
  `adb forward` + WebView devtools socket；设备由 Lead 统一采，`verify-frame-timing.mjs`
  写成「给 ws 地址就能跑、只输出原始数字」的形态，等 ws。
- **ADB 用户实际体验层**：未执行，同上。**「滚动是否真的变顺」这一点本轮没有任何设备证据**，本轮能
  证明的只有「每帧/每批的整文档查询次数从 4.00/10.00 降到 0.00/1.00」这条可测量的中间量。
- **真机 arm64**：未执行。

因此本改动的风险分类是 **L3（UI/UX 与壳侧行为）**，按 `AGENTS.md` §4 第 2 条，
**未做设备验证必须在 PR 描述里显式标注「未做设备验证」，且进入发版候选前必须补验**。

## 8. 需要 Lead 统一处理的两项

1. `scripts/verify-frame-timing.mjs` 与 `scripts/verify-frame-timing.test.mjs` 在
   `check-code-map.mjs` 的覆盖账本里报 `[uncovered]`，需登记到
   `docs/AGENTS/EXECUTION-MAP.md` 的覆盖块。
2. `back-stack.ts` 与 `native-browser-adapter.ts` 的锚点因本轮改动产生行号位移
   （`back-stack.ts:445 / :286 / :551 / :334`、`native-browser-adapter.ts:204 / :205`），需重钉。

按 Lead 指示，本轮**未**改 `docs/AGENTS/EXECUTION-MAP.md` 与
`scripts/check-code-map-anchor-baseline.json`。

## 9. 附：本轮新增的本地度量工具一览

| 工具 | 用途 | 跑法 |
|---|---|---|
| `tests/dom-scan-counter.ts` | 数 `document` / `element` 两类 DOM 查询；`settle()` 覆盖 rAF + 宏任务 + microtask 三种合帧窗口 | 被 spec 引用 |
| `tests/dom-scan-fixtures.ts` | boot 面观察者统一 attach（失败回滚）+ 手机竖屏会话页夹具 | 被 spec 引用 |
| `tests/*-budget.spec.ts`（4 个） | 扫描预算与轮询必要性判据（含反向对照） | `npx vitest run tests/<name> --reporter=verbose` |
| `scripts/verify-frame-timing.mjs` | 设备侧 A/B/C 三组原始读数 | `node scripts/verify-frame-timing.mjs --ws <ws> [--json out.json]` |
| `scripts/verify-frame-timing.test.mjs` | 上者的纯函数自检（10 例） | `node scripts/verify-frame-timing.mjs --self-test` |
