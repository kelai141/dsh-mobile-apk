# 0.14.0-preview 发布说明（versionCode 38，预览版）

覆盖安装 0.13.8(37)。本版是**缺陷收口 + 门禁闭环 + 特性接入**的一版：按迭代计划
`dsh-mobile` 仓 `docs/NEXT-ITERATION-PLAN-2026-09-12.md` 的**全部批次（B0-B4）**执行——
先把「已证存在、且会让功能不可用或让安全面敞开」的缺陷收口，再把能拦住同类问题的门禁接进
**本地构建链 / 两仓 CI / 发布组装链**三条路径（上一轮四道门禁只在 CI 生效，是这批缺陷的根因），
然后接入用户可感特性（系统返回手势、通知分级与通知内应答、侧边栏浏览器控制、虚拟屏）。
另含文档外 issue **#214（v0.13.8 无法启动）**的修复。

> 状态：**开发中草稿**。每条随对应验收条目拿到「命令 + 原始输出」证据后回填；未回填项一律不得
> 当作已完成。验收台账：`docs/0.14.0-preview-ACCEPTANCE-LEDGER.md`。

## 发布阻断项（B0）

- **语义控件树在默认通道拿不到（#204 / ui_dump schema 族）**：`android_ui_dump` 的
  `output.schema` 与返回键集合脱钩（`detailHandle`/`detailPath`/`unchanged`/`gen` 未声明），
  引擎按 `additionalProperties: false` **整值拒绝** —— 无障碍通道（默认后端）下的首次调用即失败，
  30 s 内第二次调用换一组键名再次失败，设备控制退回「截图 + 归一化坐标」。
  同时修掉同源的 `android_ui_detail` 未注册（工具死代码）与未变快路径的 `gen` 非 lossless JSON。
- **有效句柄寻址错位（#206.1）**：控制协议 V2 把「载荷行下标」当句柄，而壳侧寻址用全量行表，
  探针下 86/86 全错且失效形态是**静默点错**（错位行落在同一子树时父链回退会点到可点祖先并返回 ok）。
- **来件三条路由无鉴权（#205）**：同机任意 App 可 `GET /clean` 清空待收工作区、读清单（来件绝对路径 +
  会话 id + 占用字节）、删队列条目、把任意工作区文件入队并触发新建会话；`kind:'exact'` 路由还绕过
  `/api` 前缀的 cookie 鉴权与 Host 校验（DNS rebinding 下可读到响应体）。加鉴权与改调用方**同一批**。

## 数据与自愈（B1）

- **壳侧半死状态机四缺口（#210）**：看门狗退避恒 5 s、熔断早退冻结副作用、DEGRADED 态旁路任务完成标记
  消费、恢复入口被服务路径早退跳过、主线程同步网络探测造成 4-8 s 卡顿。
- **壳侧 IO 三处（#211）**：`ProcIo` 排水超时降级成空串（与真空输出同形）、来件投递/重试期被
  `cleanupTmp` 清空（双重静默丢件）、诊断镜像无界读 + 日志轮转先删后 rename。
- **状态陈旧 P0（真源 + 同步路径）**：门1「完全访问档位」镜像三写零读回、悬浮球开关读偏好即当真相、
  模型能力补给触发签名漏真源本身（换网关后旧思考方言永久留存）、快照指纹声明值无对账门禁、
  headless profile 装配清单永不被权威覆盖、云端自包含链编排器自身陈旧。
- **控制令牌优先级反转（ST-07）**：env 快照永久压过壳偏好实时值，会把「配置陈旧」伪装成「服务未开启」。

## 门禁与发布链（B2）

- 新增门禁：快照指纹对账（`check-snapshot-fingerprint`）、工具返回值 schema 自检
  （`check-tool-output-schema`，运行时校验 + 源码级 `defineTool` 与注册名差集）、控制 op 六处登记链
  一致性（`check-control-ops`）、发布链门禁聚合入口（`check-release-gates`）。
- 接线面收敛为唯一一套：`scripts/build-apk-013.ps1` + 两仓 `.github/workflows/pr-gate.yml` +
  `dsh-mobile-apk/scripts/build-apk.mjs` + `build-release.ps1`（两树同版）。任何 `SKIP` 必须计数。
- 每条门禁附**反向验证**：故意注入违规（改一个字节 / 漏一个登记 / 单边演进 / NSC 全域明文）必须被拒。

## 修复文档外 issue：#214「v0.13.8 无法启动」

现场：客户端一屏 `Failed to load plugins` / `web boot: 13 entries did not activate`，13 条客户端插件
全部 `pending (waiting for service: layout / uiWorkspace / uiConversation / sidebarRightTabs)`。

根因（代码锚点）：`SnapshotTransaction.kt:196` 的 `cordis.patch.yml` 合并规则是「**live 内容为基**，
追加 live 缺失的工厂块」。0.13.7 之前的出厂 profile patch 曾**禁用 `ui-layout`**；从那种版本升级上来的
设备，live patch 里的 `ui-layout` 条目始终在场 → 工厂块永不追加/永不被纠正 → 根服务 `layout` 不激活
→ 客户端全部 pending。干净安装/干净设备因此复现不了（与维护者观察一致）。

修复：<待 dev-shell 回报后回填：迁移/自检与降级的具体行为 + 反向自证>

## 验收证据（回填区）

| 检查 | 命令 | 结果 |
|---|---|---|
| 主机门禁全链 | `pwsh -File scripts\build-apk-013.ps1 -Fast` | **13 道门禁全绿 + BUILD SUCCESSFUL + exit 0**（快照指纹 `4efde80f…`） |
| bridge 冒烟 | `node scripts/smoke-bridge.mjs` | **SMOKE PASS** |
| WebView DOM 断言 | `node dsh-mobile-apk/scripts/verify-webview-015.mjs <ws>` | **ALL PASS (28)**（改动前基线同为 28） |
| #205 路由鉴权（设备） | 宿主 `adb forward` + curl | 无凭据 **401** / 伪造 Host **403** / 伪造 Origin **403** / 错令牌 **401** / 合法令牌 POST **200** / `GET /clean` **405 + allow: POST** / 未注册路径 401 |
| 引擎内工具端到端（设备） | CDP 注入一条指令 + 读回 | dump「80 个节点（原始 157）」成功（`o` 列在场）；click `n24` 回传坐标 **(228,186)** 与 dump 中 n24 中心**逐位一致**；`^nX` 父链在场；`detailHandle` 非空 |
| 升级用户数据零变化 | 升级前后比对 | sessions=4、workspaces=1 一致；settings.yaml 仅因本机配置改动而变 |
| 插件/子仓单测 | 各 `npm test` | manage 49/49、file-open 19/19、bridge **55/55**、ui-responsive **132/132**、model-capability 41/41、browser **18/18**、vdisplay 自检 24/24 |
| Kotlin 单测 | `gradlew :app:testDebugUnitTest` | **28 类 199 tests / 0 failed / 0 errors / 1 skipped**（BUILD SUCCESSFUL） |
| 状态同步（设备） | `dsh-mobile-apk/scripts/verify-state-sync.mjs --serial 127.0.0.1:16416` | **PASS 10 / FAIL 0**（ST-01/02/10/11/12 × on/off，权限类 205-2221ms、配置类 1953-2221ms） |
| 返回手势（设备，dev 档热推复验） | `input keyevent 4` 逐级 + `__dshBackDepth/kinds` + logcat `dsh-back` | IX-BG-01..06/08/10..14 **通过**（02/03/04/05/12 逐级与退出均为原文级）；07 部分（下钻无夹具）、09 无夹具 |
| 引擎内工具端到端 | CDP 注入一条指令 + 读回 | dump「80 个节点（原始 157）」、click 坐标逐位命中；**L2 五条**（IX-TW-05 / FX-204.2 / FX-206.3 / D5 / ST-03）全通过 |
| #214 设备实证 | 注入 `ui-layout: disabled` → 冷启动 | 修复前构建：**逐字复现** 13 条 pending 死屏；修复包：**自动清除** + `.bak` + `repaired=1` + 完整正常 UI |

> 完整逐条证据见 `docs/0.14.0-preview-VERIFICATION-LOG.md`；144 条验收条目状态见 `docs/0.14.0-preview-ACCEPTANCE-LEDGER.md`。

| 检查 | 命令 | 结果 |
|---|---|---|
| 主机门禁全链 | `pwsh -File scripts\build-apk-013.ps1 -Fast` | 待回填 |
| bridge 冒烟 | `node scripts/smoke-bridge.mjs` | 待回填（改动前基线 PASS） |
| WebView DOM 断言 | `node dsh-mobile-apk/scripts/verify-webview-015.mjs <ws>` | 待回填（改动前基线 ALL PASS 28） |
| 插件单测 | 各 `plugins/*` 的 `npm test` | 待回填 |
| 快照/设备 | 见 `docs/0.14.0-preview-ACCEPTANCE-LEDGER.md` | 待回填 |

## 装配与注入链修复（本版内部）

- **profiles 合并口径修正**：`cordis.patch.yml` 与 `package.json` 的「并集/按 id 合并」只应用于 **profile 根**；
  `node_modules/**` 子树改为**工厂权威整份覆盖**。此前嵌套清单走并集只保住 `dependencies`，工厂新增的
  `exports`/`version`/`main` 全丢 → 表现为「新文件 + 旧清单」的混合体，插件 `import` 子路径直接
  `ERR_PACKAGE_PATH_NOT_EXPORTED`，**引擎启动即死**。同批修掉：bundles 并集只读扁键导致**工厂新增 bundle
  从未进入 live 清单**（长期静默）。
- **注入链双向对齐**：`inject-all.py` 由「只替换基座已有成员」改为**补齐 + 修剪**（本版实测 `added files: 284 |
  pruned stale: 24`）——既把插件新增文件带进快照，也清掉源码已删的陈旧成员（如 0.13.7 去 fork 遗留的
  `AppFrame`/`columns` 等）。新增产物级门禁 `check-inject-completeness.mjs`（26 包 × 2 profile：成员集合
  一致 + 相对导入可解析）。
- **新插件启动即死修复**：虚拟屏 host 半补 `inject: ['tools']` 且可选服务一律 `ctx.get`（`ctx.webServer`
  属性访问在兄弟 fiber 拓扑下同样抛错）；浏览器插件改为**完全自包含**（不跨包 import、不新增文件）。
- **新增门禁**：`check-kotlin-comments.mjs`（Kotlin KDoc 中 `node_modules/**` 会触发嵌套块注释吞掉整个文件）、
  `check-inject-completeness.mjs`；坑位 87-89 登记。

## 设备验收（本版，MuMu x86_64 / 127.0.0.1:16416）

| 项 | 结果 |
|---|---|
| 升级 | 指纹翻转 `db8fa91c… → 22f00030…`；用户数据零变化（sessions=4、settings md5 不变） |
| 引擎起活 | 3080 LISTEN（修复前构建曾 `exit=1` 启动即死） |
| WebView 回归 | `verify-webview-015.mjs` **ALL PASS (36)** |
| 状态同步 | `verify-state-sync.mjs` **PASS 10 / FAIL 0**（ST-01/02/10/11/12 × on/off） |
| 引擎内工具 | dump/click 端到端（80/157 行错位场景 + 坐标逐位命中）、L2 五条（IX-TW-05 / FX-204.2 / FX-206.3 / D5 / ST-03） |
| 返回手势 | IX-BG 逐级验收（dev 档全绿后随本版重出，正式复跑结果见 `docs/0.14.0-preview-VERIFICATION-LOG.md`） |
| #214 | 修复前构建注入 `ui-layout: disabled` → 逐字复现 13 条 pending 死屏；修复包 → 冷启动**自动清除** + `.bak` + `repaired=1` |

## 特性接入（本版）

### 系统返回手势（IX-BG-01..14）

壳侧把 legacy `onBackPressed()` 覆写升级为 `OnBackPressedCallback` + 独立上行接口 `BackGateBridge`（set/get 成对，过桥面对称性门禁）；
注入层新增 `mobile/back-stack.ts`（`BackStackSignal`）：MutationObserver 观测六类层锚点、维护有序层栈、暴露 `window.__dshBack/__dshBackDepth/__dshBackKinds`，
逐层走该层自己的关闭控件；层穷尽才允许退出。**设备实测 12 条通过**（逐级「后开先退」、草稿逐字不丢、跨文档历史腿优先、层穷尽可退出）；
2 条如实记「无夹具未驱动」（`@` 菜单下钻、图片灯箱）；1 条按裁决降级（设置弹层无「无子页列表态」，一层 = 整个弹层）。
设备实测抓到并修掉一条**真缺陷**：右栏收起时 `[data-sidebar-right-panel="fullscreen"]` 仍在 DOM → 被误判为可退层、**幻层永久劫持返回**（一次都退不出去）；
修法为选择器补「已呈现」判据（`[data-sidebar-right-open]:not([aria-hidden="true"])`）+ jsdom 回归。

### 通知分级与通知内应答（NT-01..23）

渠道一次性定案（静默类 `LOW`、弹窗类 `HIGH`）；引擎侧修掉两处误读（`turn/end` 的 `reason` 被当 `outcome`、会话标题取自不存在的 `session.header.title`）；
壳侧新增 `NotifyStore`（FileObserver + 字节偏移消费，替代 5s 轮询）、`NotifyBridge`（专用 `$events` 应答流，独立于悬浮球）、`NotifyDecisionQueue`（先落盘再投递、退避封顶 60s）、`NotifyActionReceiver`（`exported=false` + 显式 Intent、`onReceive` 只入队）、以及**耐久探针 `NotifyProbe`**（`files/notify-responder.log`）。
设备实测通过：六类 kind 分流、静默渠道 `IMPORTANCE_LOW`、**事件驱动延迟中位 93 ms**、100 行追加零丢行、双读不双发、投递段无 BAL 拦截、
提问应答流端到端 **`waterfall → notify kind=question → result=POSTED`**（即「关悬浮球仍能送达」的核心语义）。
设备实测抓到并修掉两条真缺陷：`entry.popup` 解析后**无消费点**（按停的汇报仍弹窗）、应答流被**前台抑制**与**读线程异常**吞掉（一帧异常杀整条流）。

### 侧边栏「浏览器控制」（引擎侧已就绪，壳侧 host 未落地）

按用户约束（U-1）注册为**右侧栏 tab 类型**，其 guide 卡片与上游「工作区文件」同级（order 20）；只读状态端点复用 FX-205 的插件侧鉴权（GET-only / 405 / Host+Origin+令牌）；
`browserCaps` 三档接线（壳桥 → `DSH_BROWSER_FACTS` → P0 实测基线，**每次带来源标签**，绝不把基线伪装成已实测）。插件 18/18、ui-responsive 132/132。
**未落地**：壳侧 `browserCaps` 分支与 `BrowserHost.kt`（第二 WebView 宿主）——面板的视口/身份两个下拉当前为 disabled（诚实降级）。

### 虚拟屏（P0 探针已绿，特性不具备上线条件）

建屏矩阵在**应用 UID** 下实测：`PUBLIC|OWN_CONTENT_ONLY|SUPPORTS_TOUCH` **建成**（无投影权限）、私有屏对照建成、`DESTROY_CONTENT_ON_REMOVAL` 建成；
`TRUSTED` / `AUTO_MIRROR` / `ALWAYS_UNLOCKED` 三种组合抛**显式 SecurityException 且带被拒 flag 名**（可直接进 `vd-denied-flags`）；无泄漏断言 + 金丝雀两向验证通过。
**六环节绿数 = 1/6** → 按方案文档 No-Go 口径，虚屏特性仍不具备上线条件；本版只交付 P0 结论与插件骨架（未接默认路径）。

### 设备验收收口（通知线，2026-09-13）

通知线在设备上跑完四轮专项后收口，累计发现并修复 4 条真缺陷（另有 1 条为平台层事实）：

| 缺陷 | 症状 | 修法与验证 |
|---|---|---|
| DEF-NOTIFY-01 | `entry.popup` 解析后**无消费点** → 按停的汇报仍弹窗 | `formDecision` 四态（`report+popup=false` 降级静默、交互类不许降级）+ 保留会话级通知 ID；设备对照：`popup=false` 落 `dsh-silent`（importance=2、无公版）、`popup=true` 仍落 `dsh-report` |
| DEF-NOTIFY-02 | 提问通知未投递（应答流未 ready + 前台抑制把交互入口也吞掉 + 读线程异常杀整条流） | 异常边界（`notifyEvent`/`onFrame` 包 Throwable）+ 前台抑制收窄为只作用 `report` + 耐久探针；设备：`waterfall → notify kind=question → result=POSTED`，且**通知内回复闭环** `pending → submitted`、引擎收到并续跑回合 |
| DEF-NOTIFY-03/03b | 回复成功后通知不撤（停在「正在发送」） | 平台事实：**经 RemoteInput 直接回复过的通知，应用侧 `cancel()` 被系统忽略**（`LIFETIME_EXTENDED_BY_DIRECT_REPLY` / `mCanceledAfterLifetimeExtension`）→ 修法改为**同 `(tag,id)` 重投一次再撤**；设备：0.125s 抓到「已提交」版本 → 该 id 在场=0 |
| 重试循环不自愈 | 引擎未就绪 + 进程重启后 pending 决策**永不补投、也不出现在期失败**（通知被永久搁置） | `ensureScheduled()` + 纯函数 `resumePlan()`，触发点接 `NotifyBridge.start()`（覆盖 `EngineService.onCreate` 与动作接收器两条冷启动路径）；设备两档：`Resume` 重启后出现 `waitAttempts` 更大的新行且仍 pending、`Expired` 触发点立即 `failed` + 可见文案「提交失败，点击重试」 |

另：**NT-17B** 的「该请求已失效」文案经设备证实**不可达**（真实网关对未知 `eventId` 返回 200 no-op），已在计划 §6.7.6 记为未决项并注明需另找信号（cancel 帧 / 引擎端可区分状态）——**不写成已通过**。

## 验收计数与未达项（截至本文档定稿）

对照迭代计划 §1.5 的 **144 条**验收条目：**138 条已带证据通过**（含设备实测项），**2 条为部分/不可得**，逐条理由与**复评条件**如下——**未验项不写成已验**：

| 条目 | 状态 | 理由（复评条件） |
|---|---|---|
| IX-BG-07 | 部分 | 菜单层返回行为已通过；「`@` 菜单目录行下钻」需会话内存在**目录行**夹具（本机会话候选 37 行中可下钻 0 行）→ 复评：构造含子目录的会话工作区后再跑 |
| IX-TW-06 | 不可得（两条通道均无） | ① a11y 通道取不到悬浮球句柄——**overlay 不入 a11y 树**（落盘 dump 原文 8075B/84 行，仅一个 `win=916` 应用窗口、无 overlay 类节点）；② 坐标注入通道也没有——**球的坐标不落盘**（`shared_prefs/dsh-overlay.xml` 仅 `enabled=false`）→ 复评：坐标持久化或提供非 a11y 驱动入口后，可用 `input tap` 复测 |

另有两条**经评估不纳入本迭代**（附理由与复评条件，非「延期」托词）：**NT-20**（mux 归属收敛需动壳侧 `$events` 网关客户端身份归属，只加脚本门禁即半做；该组件正被设备项占用）、**IX-TW-10**（面板跟随属可选增强，不影响 R1-R3）。

计划内另两处**期望态与实际可达态不一致**（已记入未决项，不作为已验）：**NT-17B**「该请求已失效」文案——真实网关对未知 `eventId` 返回 200 no-op，该路径不可达，需另找信号（cancel 帧 / 引擎端可区分状态）；**NT-17A** 的「提交失败，点击重试」半支未跑（>2min 等待），且 NOT_READY 分支原为恒定 2s 无限重试（已批准改指数退避 + 墙钟预算）。

## 本迭代新增门禁（防复发）

`check-patch-mirror`（含新插件目录级递归比对）/ `check-manifest-hardening`（XML 语义）/ `check-bounded-io`（正则扩容）/ `check-protocol-v2` / `check-tool-output-schema`（13 工具 18 分支运行时校验）/ `check-control-ops`（六处集合差集 + 族级 toolSurface）/ `check-snapshot-fingerprint` / `check-release-gates`（聚合入口，15 项声明）/ `check-gate-skips`（SKIP 必计数、发布链要求 0）/ `check-state-registry` / `check-bridge-symmetry` / `check-perf-instrumentation` / **`check-inject-completeness`**（成员集合 == 源包 + 相对导入可解析）/ **`check-kotlin-comments`**（嵌套块注释）/ **`check-strip-noop`**（剥离清单后置断言 + 反 no-op）。全部接入「唯一接线面」五位置，并各带**故意注入违规必红**的反向验证。

## 发布链预演（发版前空跑，2026-09-13）

发版前以 **`pwsh -File scripts\build-apk-013.ps1 -Suffix ""`（只构建、不发布）** 完整空跑了一次发布链，结果：

```
EXIT=0        FAILED 行计数 = 0
BUILD SUCCESSFUL in 34s   （arm64 与 x86_64 各自的 gradle 构建）
=== 汇总。已产出 ABI: [arm64, x86_64] / 被拒 ABI: [] ===
```

| 产物 | 大小 |
|---|---|
| `dsh-mobile-apk-v0.14.0-preview-arm64.apk` | 161.40 MB |
| `dsh-mobile-apk-v0.14.0-preview-x86_64.apk` | 158.70 MB |

即：双 ABI 纯净构建链（快照 → 双注入 → 全部快照门禁含 arm64 侧 → 双 gradle → 双 APK）**全程无一条判红**，两个 ABI 均产出、无被拒项。

**这次空跑抓出并修复了 4 处只在发版链上可见的问题**（`-Fast` 单 ABI 档覆盖不到）：

1. `engine-overlay.json` 的 `extraPresent` 缺 `@vscode/ripgrep-android-arm64` → arm64 快照反向面判红、**拒绝打包 arm64**；
2. arm64 快照陈旧（早于 A1 出厂 seed）→ 性能插桩门禁 A1 出厂值不为 `startup` → **拒绝打包 arm64**；
3. `build-snapshot-013.mjs` 的 strip 门禁调用把脚本路径拆成两个 argv 元素 → `MODULE_NOT_FOUND` → **拒绝出快照**；
4. per-ABI 门禁失败后构建链**仍以 exit 0 结束** → 会静默交付单 ABI 产物（已修：新增「已产出 / 被拒 ABI」汇总 + 被拒非空即 exit 1 + 常驻门禁 `check-build-chain-abort.mjs`，含「去掉守卫则 exit 0」的反证）。

上述 1-3 已修复，#4 由新增门禁与守卫锁住。**发布资产即由这条已验证的链路产出。**

### 发版命令全文空跑（含 `-ExportSnapshots`）

发版命令 `pwsh -File scripts\build-apk-013.ps1 -Suffix "" -ExportSnapshots` 亦已空跑通过（只构建、不发布）：

```
EXIT=0        FAILED 行计数 = 0
BUILD SUCCESSFUL in 30s / 29s   （arm64 与 x86_64）
快照资产导出: out\v0.14.0-preview\snapshot-arm64.tar.xz
快照资产导出: out\v0.14.0-preview\snapshot-x86_64.tar.xz
=== 汇总。已产出 ABI: [arm64, x86_64] / 被拒 ABI: [] ===
```

产出清单（`out/v0.14.0-preview/`）：

| 文件 | 大小 |
|---|---|
| `dsh-mobile-apk-v0.14.0-preview-arm64.apk` | 161.40 MB |
| `dsh-mobile-apk-v0.14.0-preview-x86_64.apk` | 158.70 MB |
| `snapshot-arm64.tar.xz` + `.sha256` | 157.20 MB |
| `snapshot-x86_64.tar.xz` + `.sha256` | 154.50 MB |

即发布资产的**四个核心件（双 APK + 双快照 xz/sha256）已由这条已验证的命令实际产出**；插件 tgz 与 `MANIFEST.txt` 由 `build-release.ps1` 在发布时组装。

## 真机待验（arm64，发布前补充门禁）

- 返回手势全面屏路径、A1 存量升级路径、通知锁屏批准与脱敏、OEM 折叠态动作可见性。
- 本版模拟器（MuMu x86_64）验收结论不替代真机结论；缺失项在本节如实标注。

## 已知缺口

- 通知分级与通知内应答（切片 3）、侧边栏浏览器与 Shizuku 特权通道（延后区）不在本版范围，
  复评触发条件见迭代计划 §1.4 / §7.6。
- `IX-UD-11`（V1 老壳 `data.screen` 多键兼容面）当前无老壳包可得，只能构造法单测，
  记入未验证项台账，不得写成已实证。

## 资产

| 资产 | 说明 |
|---|---|
| `dsh-mobile-apk-v0.14.0-preview-arm64.apk` | arm64 真机 |
| `dsh-mobile-apk-v0.14.0-preview-x86_64.apk` | x86_64 模拟器 / 设备 |
| `snapshot-{arm64,x86_64}.tar.xz(+.sha256)` | 注入后运行时快照（与 APK 内嵌同源） |
| `dsh-android-*.tgz` ×8 | 插件包（可单独更新） |

> 本版为 **preview**：发布动作须等用户口令；notes 在本版发布前按最终验收证据定稿。
