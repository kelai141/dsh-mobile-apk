# Shizuku「探测未完成」不再算未就绪 + 接线判据改成行为断言（2026-11-04，issue #1506 / #1529）

## 现场

- #1476（已合并的 #1501）把「binder 活 + 已绑定」升级成「必须有功能探测成功的证据」，方向对，但把**还没测**折进了 `ok=false`：
  `readinessVerdict` 在 `probe.probed == false` 时返回 `ReadyVerdict(false, "shizuku-probe-pending")`。
- 探测是 `kickFunctionalProbe()` 异步发起的，而 `readyService()` 正是靠 `status().ok` 决定要不要派发。
  于是「通道刚建好」的第一条命令必被拒；面板/工具面同时读到「未就绪」——与坑 161 实测的
  「Shizuku isn't ready, which means I can't create a virtual display」是同一种病：把**未知**渲染成**不可用**。
- 同一条链上的 caps 面更硬：`ControlCarrier.shizukuReady()` 取 `status().optBoolean("ok")`，未知被折成 `false`，
  引擎侧 `shizukuChannel()` 于是收到布尔假值，三态（坑 161 的 `undefined` 档）在壳侧就被抹平了。

## 真因

两条同源，都是「三态被折成布尔」：

1. 就绪结论只有 `ok: Boolean`，"尚未探测完" 无处安放，只能借 `ok=false` 表达；
2. caps 消费面只有布尔字段，无法把未知传下去（`JSONObject.put(key, false)` 与「没探测」不可区分）。

## 修法

- 三态显式化（`ShizukuReadinessGate.kt`，新文件，纯函数）：
  `readinessState(verdict)` = `true` 就绪 / `false` 已实测未就绪 / `null` 尚未探测完；
  `status()` 尾巴（`statusReadinessJson`）同时落 `ready`（true/false/**JSON null**）与 `readyState`
  （`ready`/`not-ready`/`unknown`），`ok` 保持「未被证明就绪」的严格语义，不再冒充「不可用」。
- 首次探测加**有界同步短等**（`awaitFirstProbe`，预算 300ms）：只在「从未探过 + 允许阻塞」时等；
  主线程传 `blockingAllowed=false`（宁可给三态也不卡主线程）。执行面（后台线程）因此拿得到真结论，
  不再在绑定成功后的第一拍被 `readyService` 拒掉。
- caps 面改三态：`ControlCarrier` 用 `readinessTriState(status)`，未知写 `JSONObject.NULL`；
  引擎侧 `shizukuChannel()` 的 `typeof cached === 'boolean'` 判据天然把 null 读成 `undefined`（坑 161 的三态）。
- 未知档文案改成**可执行动作**（坑 161 的硬要求）：「首次功能探测还在跑（这不代表不可用）：现在就可以让 AI
  建屏或执行命令，探测一落地即转就绪」——不再说「尚不能证明可用」这种劝退句。
- #1529（判据质量）：删掉 `statusWiresTheEvidence` 的六条 `src.contains(...)`，改成跑**接线函数本身**并断言它落下的
  JSON（`ok`/`code`/`guidance`/`ready`/`readyState`）与催探测计数；`functionalProbeJson` 单独断言字段与语义
  （旧判据只说「`probeJson()` 返回空对象也绿」）；`elapsedMs` 加单调时钟注入点 `ShizukuTransport.monotonicClock`，
  断言**具体数值**而不是「字段在场」。

## 负控（都真打红过）

- 把 `elapsedMs` 换回 `System.currentTimeMillis()` → `shellFailureElapsedComesFromMonotonicClockNotWallClock` 红（1 例）；
- 去掉「pending → null」那一支（折成 false）→ 3 例红（`pendingProbeIsUnknownNotNotReady` / `pendingProbe_writesUnknownJsonAndKicksTheProbe` / `readinessTriStateReadsThreeStatesAndLegacySnapshots`）；
- `statusReadinessJson` 丢弃 verdict（恒 `ok=true` + `shizuku-ready`）→ 2 例红（failed / pending 两条）；
- `awaitFirstProbe` 忽略 `blockingAllowed`（主线程也等）→ `awaitFirstProbe_neverBlocksTheUiThread` 红。

## 证据与边界

- `testDebugUnitTest` 全量绿（2437 例量级）；`check-code-map` / `check-kotlin-test-count` / `check-release-gates` / `check-kotlin-comments` 全绿。
- 改动**零位移**：`ShizukuTransport.kt` 的 status 尾巴 13 行换 13 行、`ControlCarrier.kt` 5/5（`git diff --numstat`），
  新逻辑全在新文件里；执行地图新增 1 条锚点 + 1 条覆盖登记。
- **未做设备验证**：本改动属壳侧行为（L3）但依赖 Shizuku 运行时，模拟器上无可用 Shizuku 管理器的形态下
  「探测中 → 就绪」这条时序无法制造；已在 PR 描述显式标注，进发版候选前须补真机三层验收。
