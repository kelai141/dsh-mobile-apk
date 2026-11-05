# emulator-test-protocol.md — 模拟器验收规范（代码层 + CDP 层 + ADB 用户实际体验层，三层必跑）

> 本文件是 `AGENTS.md` §2.1「模拟器测试规范」的**详档**：AGENTS.md 只放强制条款，命令与判据在这里。
> 一句话：**任一层红都说明这个系统有问题**——代码层红是代码有问题，CDP 层绿而人做不到是交互逻辑错，
> ADB 用户层红而 CDP 全绿是内部没打通。只跑 CDP 不算验收。

---

## 0. 三层验收（任一层红即系统有问题）

| 层 | 手段 | 红了说明什么 |
|---|---|---|
| **代码层** | Kotlin 单测 + 静态门禁 + 本改动自带的反证用例 | 根本就是代码有问题 |
| **CDP 层** | `verify-*.mjs` 跑页面内断言 | 接口与实现脱钩，或跨层数据没打通 |
| **ADB 用户实际体验层** | adb 真操作真截图，真人能否完成同一件事 | 不符合人体交互逻辑 / 在用户视角里就是坏的 |

三层各自能证明的东西互不替代，**缺一层即未验收**。读法（对应 AGENTS.md §2.1 第 2 条的四类含义）：

- 代码层绿、CDP 层红 → **内部没打通**（引擎/壳侧/页面三方接口对不上）；
- CDP 层全绿、ADB 层失败 → **内部没打通**，或**在用户视角里就是坏的**（界面显示正常、用起来不对）；
- 两层都绿、真人做不到 → **不符合人体交互逻辑**（点不到、看不见、层级/遮挡/焦点/键盘错）；
- 代码层红 → 代码问题，先修代码再谈其余两层。

**禁止只修红的那一层。** 三层里任何一层失败，都要回到另外两层确认原因是否同源——
0.14.1 的三个 P0 缺陷（工具面报「Shizuku 未就绪」、virtual-only 下工具大面积不可用、跨屏拉起报假成功）
全部满足「代码层与 CDP 层都是绿的、只有真机用户层暴露」，先例见协调仓
`docs/0.14.1-preview-DEVICE-DEFECT-TRIAGE-AND-TEST-REFLECTION.md`。

## 1. 适用范围（按风险选择证据；A/B 两轨何时必跑）

### Risk classification

Apply the risk classification in `AGENTS.md` section 4 before selecting evidence:

| Class | Scope | Required evidence |
|---|---|---|
| L0 | Documentation and comments without behavior changes | Relevant CI and documentation checks |
| L1 | Internal script/build logic without changing a security-sensitive decision | Targeted tests or self-tests plus a controlled negative case |
| L2 | Snapshot transactions, signatures, bridge contracts, or a gate's acceptance/rejection criteria | Immediate code, CDP, and ADB validation of the affected behavior |
| L3 | UI/UX and Android shell behavior | Immediate emulator validation at all three layers |

The script exemption below applies only to L1 changes. A change to a gate's acceptance criteria is L2 even if its implementation is a script. Mixed changes use the highest applicable class. For L2 build-time gates, execute positive and negative checks against the actual gate and validate the affected runtime path on a device; a successful device boot alone does not prove rejection of corrupt input. Standalone web pages use browser validation of their own behavior rather than APK installation.

All release candidates still require the final-source, packaged-APK validation described in `AGENTS.md` section 2.2. Development hot-push or earlier integration evidence cannot substitute for that final run. PRs without device validation must state that explicitly.

Coordination-only tools and delivery plans are external prerequisites, not files shipped in this APK repository. In particular, `scripts/clean-deploy-tmp.mjs` referenced by `AGENTS.md` section 4 belongs to the coordination checkout. Its reviewable repository/commit must accompany a cleanup handoff before it can be treated as delivered here. This protocol does not certify or provide that deletion implementation.

**Code evidence follows the affected inputs**: use relevant Kotlin tests, static gates, and regression/negative cases for runtime changes. L0 documentation does not require unrelated Kotlin tests; L1 requires targeted script evidence as specified above.

**另加 A/B 两轨**（A 轨 CDP 断言 + B 轨 adb 用户级操作）——凡改动会让用户**看见或摸到**不同：

- 页面/注入层（`dsh-client-ui-responsive`、`dsh-host-web-compat`）：任何 DOM 标记、几何、样式、polyfill、入口按钮增删；
- 壳侧 UI：引导页、控制台、悬浮球/光环/面板、通知与通知内应答、返回网关；
- 视图宿主：浏览器宿主与地址栏、虚拟屏 viewer/浮窗；
- 交互路径：点击/长按/滑动/文本输入/按键、键盘与 IME、权限弹窗与授权引导；
- 桥面：任何页面可调用的桥方法增删改（页面侧可见行为变化）。

**不强制 B 轨**（按上表 L0/L1 分类，仍需对应证据）：纯文档、构建脚本内部逻辑、不改变验收判据的门禁脚本维护、Kotlin 内部重构（不改可见行为，且单测覆盖）。L2 判据和安全敏感面不适用此豁免。

判据只有一句：**改完之后，一个真人用这块屏幕能不能完成同一件事**。CDP 断言回答不了这个问题。

## 2. 两轨各自能证明什么（缺一不可）

| 轨 | 手段 | 能证明 | 证明不了 |
|---|---|---|---|
| A：CDP 断言 | `verify-*.mjs`（WebView devtools 协议，跑页面内 JS 断言） | 状态语义（loading/error/blockedRequests）、事件绑定、polyfill 活性、DOM 契约、跨层状态同步 | 用户是否**真的**点得到、看得见；几何/层级/遮挡/焦点/键盘 |
| B：adb 用户级 | `input tap/swipe/text/keyevent` + `screencap` + `uiautomator dump` + `logcat` | 真实触达（点击落到哪个像素）、视觉结果（截图）、系统层反应（日志、窗口栈、通知栏） | 内部状态语义（为什么错、状态机在哪一步错） |

历史实锤（详见 `gotchas.md`）：

- 坑 50：弹出面板几何缺陷——**只有按实测矩形（截图）才能发现**，DOM 断言当时全绿；
- 坑 61：polyfill 片段文本全在、grep 全绿，但整个 `<script>` 被解析器拒绝、页面不可用——**注入类缺陷只能按「能不能用」判**；
- 坑 147：`screencap -d <displayId>` 对虚拟屏必然失败，虚拟屏截图面与普通截图不同（B 轨证据要选对命令）。

## 3. 设备与前置检查（跑之前先过一遍）

设备矩阵、装机命令、CDP 端口与探活见 `AGENTS.md` §2 与 `docs/AGENTS/adb-chain.md`。本规范只列**跑验收前**必须确认的前置：

```bash
# 0. 设备在线（MuMu 开发主用 16416 竖屏 / 16384 横屏）
adb devices -l

# 1. 快照就绪：唯一完成标志 = 指纹在场且 marker 已消失；刷新期间禁跑（假失败）
#    指纹与 marker 都在 filesDir 根（context.filesDir），不在 files/home/ 下
adb -s <serial> exec-out run-as com.dsharnessmobile.shell ls -l files/.snapshot-fingerprint
adb -s <serial> exec-out run-as com.dsharnessmobile.shell ls -l files/.snapshot-transaction   # 报 No such file 才是刷新已完成

# 2. 应用在前台（后台会被 CDP 目标解析拒绝）
adb -s <serial> shell input keyevent 3
adb -s <serial> shell am start -n com.dsharnessmobile.shell/.MainActivity

# 3. 无障碍通道在线（需要 a11y 面的用例才查；重启后需重设，见坑 46）
adb -s <serial> shell dumpsys accessibility | grep -A2 "Bound services"
```

已知会制造**假失败**的环境残留（先清再判）：

- **uid-mode appop 残留**覆盖包级 op，会让状态同步用例稳定判红（实测现场：`appops get --uid <pkg>` 里出现 `Uid mode: allow`，与套件修改的包级 op 不一致）。清理：

```bash
adb -s <s> shell appops get --uid com.dsharnessmobile.shell            # 先看有没有 uid 模式残留
adb -s <s> shell appops set --uid com.dsharnessmobile.shell <OP> default   # 清掉那条 uid 覆盖
adb -s <s> shell appops reset com.dsharnessmobile.shell                 # 兜底：清该包全部 op 覆盖
```
- **prefs 僵尸 a11y 标记**（坑 46）：`am force-stop` 后 `enabled_accessibility_services` 不回写，需重设并确认 `Bound services` 非空；
- **应用被切到后台**：CDP `fetch failed` 多半是它，不是缺陷。

## 4. B 轨操作原语（可直接复制）

坐标基准：MuMu x86_64 **900x1600 / density 320**（竖屏 16416）；横屏 16384 为真 1600x900。
**换机型/分辨率必须重新校准**，并把每步截图落到证据目录（脚本先例：`scripts/e2e-provider-ui.ps1` 的 `Shot` / `Tap` / `TypeText` 三原语）。

```bash
# 截图（B 轨核心证据；每步一张）
adb -s <serial> exec-out screencap -p > .deploy-tmp/<round>/ui-01-start.png

# 点击 / 长按 / 滑动 / 文本 / 按键
adb -s <serial> shell input tap <x> <y>
adb -s <serial> shell input swipe <x> <y> <x> <y> 1200          # 起点终点相同 + 时长 = 长按
adb -s <serial> shell input swipe <x1> <y1> <x2> <y2> 350       # 滚动/拖拽
adb -s <serial> shell input text 'https://example.com'          # 特殊字符按 URL 编码
adb -s <serial> shell input keyevent 4                          # BACK / 3=HOME / 66=ENTER

# 坐标不确定时：先 dump 再算中心点（uiautomator 树）
adb -s <serial> shell uiautomator dump /sdcard/ui.xml && adb -s <serial> pull /sdcard/ui.xml .
# （同一条 adb 面也可用 MCP 封装：android_ui_describe / android_ui_resolve / android_ui_tap /
#   android_screenshot —— 底层就是上面这几条，交互式排查更省事，但证据仍要落盘成截图文件）

# 关键日志（按 tag 过滤；浏览器准入拒绝打 dsh-browser）
adb -s <serial> logcat -d -s dsh-browser:V AndroidRuntime:E System.err:W
```

三条定位坐标的路子，优先级从高到低：

1. `uiautomator dump` 拿 `bounds="[x1,y1][x2,y2]"` → 中心点，最可复现（推荐写进脚本）；
2. 复用既有校准坐标（`e2e-provider-ui.ps1` 里的注释就是校准记录），并在 PR 里写明机型/密度；
3. 目测截图坐标——只允许交互式排查临时用，**不得**作为留档证据的唯一来源。

## 5. A 轨套件与连接

For late cold-start recovery, run only `LateColdStartDeviceTest` with instrumentation's `-e class` filter. Its real-Activity fixture preserves and restores the repair preferences, uses an isolated loopback HTTP endpoint and does not replace engine credentials or the active engine log. Compare the same test APK against the affected shell and the fixed shell: late-page and resume cases must detect the old failure; new repair decisions, including those made during an HTTP request, must remain blocking. Then separately start the actual engine with the historical gate intact, record page readiness and ledger convergence, and perform real portrait/landscape tasks. Fixture HTTP success is not qualification of the actual engine or a release APK.
For Safe Mode migration qualification, filter instrumentation to `SafeModeMigrationDeviceTest`. It uses an isolated cache profile with the production web path layout and real Android links/directories. Run the same test APK against the affected older shell and a shell whose `SafeMode.kt` matches the reviewed main revision. Separately verify actual console `dsh safe` on/status/off, comment retention and byte-exact restoration in both orientations. Back up the active profile first; do not replace an existing Safe Mode marker for a fixture. Configuration transaction verification does not imply the engine has restarted with the filtered configuration.

For console keyboard changes, measure both the visual viewport and the native IME overlap: an edge-to-edge WebView can retain its full layout viewport behind the keyboard. Assert that the command input and Send control stay above the actual keyboard edge and that output retains a nonzero height. Cover portrait, landscape, already-resized native views, keyboard dismissal and a subsequent command.

套件清单与参数约定见 `AGENTS.md` §2 的表（`verify-webview-015` / `verify-state-sync` / `verify-browser-host` / `verify-browser-panel` / `verify-vdisplay-viewer` / `verify-vdisplay-float` / `verify-engine-log-copy`）。

`verify-webview-015.mjs` supports the Chinese and English accessible names for settings, account menus, phone control, reset links and attachment commands. Its account-menu probe prefers the explicit accessible name over unrelated More buttons. Run `node scripts/verify-webview-015.mjs --self-test` for the locale and missing/disabled-control regressions; PR CI runs the same tests. Resolve a fresh WebView target before each device run.

硬性约束（违反会**静默连错目标**）：

- 每个套件**单独跑**，跑前重建 WebView target：`adb shell "cat /proc/net/unix | grep webview_devtools"` → `adb forward tcp:29225 localabstract:webview_devtools_remote_<pid>`；
- 参数约定各不相同：`verify-webview-015`/`verify-browser-host` 用 **positional** ws；`verify-vdisplay-viewer` 用 `--ws`；`verify-state-sync` **不要传 --ws**（会禁用 target 重解析）。传错不报错，只是连到旧 target。
- `verify-vdisplay-viewer` / `verify-vdisplay-float` 需要 Shizuku 已注册：未注册时 `vdisplayCreate` 一步就 FAIL——这是**前置不满足**（先按 §3 把 Shizuku 配起来），不是缺陷，别当回归报。

## 6. 证据与判据（每次验收必须产出）

落盘目录：`.deploy-tmp/<round>/`（已在 `.gitignore` 内），命名：

```
.deploy-tmp/<round>/
  ui-01-start.png            # B 轨逐步截图
  ui-02-<步骤名>.png
  commands.md                # 真实执行过的命令（含 serial 与参数）
  cdp-<套件名>.log           # A 轨套件输出原文（含 PASS/FAIL 计数与失败原句）
```

PR 描述里贴**结论表**（每行一条用户动作）：

| 步骤 | 操作（adb 原语） | 预期 | 截图 | 结论 |
|---|---|---|---|---|
| 1 | `input tap 62 62` 开侧边栏 | 左栏滑出且顶栏按钮变为关闭态 | `ui-01-sidebar.png` | 通过 |
| 2 | `screencap` | 面板未被状态栏压住 | `ui-02-panel.png` | 通过 |

判 **pass** 的充要条件：**代码层门禁全绿 且 A 轨全绿 且 B 轨每步截图与预期一致**（人工判读并写进结论表）。
三层各写一行结论，**缺任一层 = 未验收**，不得在 PR/提交里写「功能完好」。失败时追加：logcat 片段 + 复现步骤（哪台设备、哪个方向、第几步）。

## 7. 方向与 ABI 矩阵

| 阶段 | 竖屏 16416 | 横屏 16384 | arm64 真机 |
|---|---|---|---|
| 开发循环（每次改 UI 可见行为） | 必跑 | 几何/布局类改动必跑 | 不要求 |
| 发布前 | 必跑 | 必跑 | 必跑（V2425A，arm64 产物） |

说明：debug 包内嵌快照决定 ABI（坑见 `AGENTS.md` §6），x86_64 快照装 arm64 真机必崩——矩阵里「真机」一栏只能用 `-arm64.apk`。

## 8. 已知陷阱（会制造假通过/假失败）

| 陷阱 | 现象 | 处置 |
|---|---|---|
| 快照刷新进行中跑验收 | 页面空白/超时，一堆假失败 | 先确认 `.snapshot-transaction` 消失、指纹翻转（§3） |
| 只跑 CDP 就宣称功能完好 | 「DOM 全绿但用户看不到」 | 本规范第 2 节；补 B 轨 |
| 截图代替断言 | 「看着没问题」但状态机走的是错误分支 | 补 A 轨断言 |
| CDP target 未重建 | 断言打在旧页面上 | 每个套件单独跑 + 重解析（§5） |
| uid-mode appop 残留 | 状态同步用例稳定判红 | §3 清理命令，之后重跑 |
| a11y prefs 僵尸标记 | 工具 8s 超时、队列无人取活 | 重设 `enabled_accessibility_services`（坑 46） |
| `screencap -d <displayId>` 取虚拟屏 | 拿到真实屏画面（假证据） | 虚拟屏走 SF token 路径（坑 147） |
| `Select -First N` 截断长任务 | 子进程被杀，日志不全 | 长任务全量重定向日志（`AGENTS.md` §6） |

## 9. 反模式清单（禁止）

1. 只跑 CDP 套件就下「功能完好」结论；
2. 只贴截图就下「逻辑正确」结论；
3. 用 `screencap -d <displayId>` 当虚拟屏证据；
4. 快照刷新期间跑设备验收；
5. 用 `Select -First` 截断构建/长脚本输出；
6. 不回写坐标校准信息（机型/分辨率/density）就复用旧坐标；
7. 把「前置不满足」（Shizuku 未注册、未配对、应用在后台）当缺陷上报；
8. **把验收任务写成步骤清单一条条喂给模型**（详见 §10）；
9. **只让模型做单步或两三步的操作就宣布验收通过**（详见 §10）；
10. **只修红的那一层**：另两层不复核，等于没修。

## 10. 真实任务验收（任务形态强制）

验收任务的形态与三层同等重要：**步骤简单、指令明确的任务证明不了系统能用**。

- **给什么**：只给「目标 + 约束 + 成功标准」。**不给操作序列**——不给工具名、不给参数、不给第几步该做什么。
- **谁编排**：模型自己规划、自己试错、自己纠错、最后汇报。
- **任务长什么样**（示例，不是清单）：让它自己去打开某个应用；让它在虚拟屏上试着玩一个小游戏；
  让它在某个网页应用里截图、发消息；然后向用户汇报做了什么、结果如何、哪里没做成。
- **为什么**：单步操作只测一个 API 的表面；真实任务才会同时压到编排、跨层串联、错误恢复与状态一致性——
  本仓缺陷恰恰藏在「多步之后的状态」与「跨层交接」里（先例：0.14.1 三个 P0 全是多步真实使用才暴露）。
- **留证**：工具调用序列（含失败的调用与重试）、每一步的设备截图、最终汇报原文；结论表按**目标是否达成**判，
  不按「某一步返回成功」判。**工具自报成功不算达成**——必须有设备侧可观察的结果（截图、落点 displayId、像素变化）。
- **反证**：同一任务在受限条件下重跑一次（如屏幕范围切 `real-only`、关掉某条通道），断言结果整体翻转；
  不翻转说明任务没有真正压到该条件。
- ScreenScope 矩阵的 `real-only` 反证必须覆盖 `android_vdisplay_input` 的真实调用：结果应为稳定
  `screen-out-of-scope`，且壳侧不得执行 `input -d`；引擎 bridge 服务面与壳侧 `VdisplayController.input`
  都有执行点门禁，工具文案或模型自行避让不构成安全证据。`virtual-only`/`all` 下仅允许已登记的
  虚拟别名；显式 target 必须对应实际注入 display，不能被 selected 屏静默替换。

Settings probes read section labels after excluding injected description and chevron nodes. The visible text of a mobile category row contains both its upstream name and the adaptation's description; matching the whole text against the bare section name misses the phone-control page. This changes only the navigation probe, not the user's settings flow.
