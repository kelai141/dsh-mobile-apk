# 两处并发状态字段缺 @Volatile，控制台的「只起一次」守卫非原子（issue #1008）

分支 `fix/1008-volatile-state`（基 `origin/main` f45aa988）。两处都是**跨线程可见性/原子性**缺陷，
不是「偶发卡顿」——它们只在真并发下现形，单线程读代码永远看着是对的。

## 1. `EngineManager.lastRefreshFailureUnclassified` 缺 `@Volatile`

- **现象**：刷新失败后 boot-fail 的码与真因对不上——上一轮「已归类」的判定被当成这一轮的结果，
  于是排障文案指向错误的恢复动作（该换快照的提示「端口被占」之类）。
- **真因**：写点在 `refreshSnapshot` 的 catch 路径（刷新线程），读点在 UI 线程消费
  `refreshFailureLabel` 处。没有 `@Volatile` 时 JMM 不保证写对其他线程可见，读端可能一直拿到
  构造时的默认值或上一轮的缓存。同组的 `lastRefreshFailureCode` / `lastRefreshDeferred` 本来就有
  `@Volatile`——漏的只有这一个，所以肉眼扫过去像「这一组都带注解」。
- **修法**：补 `@Volatile` 并在 KDoc 写明两个端点分别在哪个线程，避免下次再漏。
- **判据**：`ConsoleSessionSingleStartGuardTest.刷新失败未归类标记必须跨线程可见` 读源码文本，
  断言**该字段的声明区**（该行 + 上方两行）里有 `@Volatile`。刻意不做全文 `contains("@Volatile")`——
  那在本文件恒真（同组字段都有注解），等于恒绿假判据。
  同一条用例还顺带断言相邻两个字段仍带注解，证明「声明区取样」没取错行。

## 2. `ConsoleActivity.startSessionNow()` 的两次检查两次赋值

- **现象**：同一个控制台界面里起了两条 bash（两个读线程），输出互相串、输入落到其中一条；
  日志里同一时刻出现两次 console start。
- **真因**：旧实现是

  ```
  if (sessionStarted || sessionStarting) return
  startPending = false
  handler.removeCallbacks(pendingStartRunnable)
  if (sessionStarted || sessionStarting) return   // 第二遍检查
  sessionStarting = true                           // 后置位
  ```

  而 `ConsoleSession.start()` **不幂等**（直接 spawn 进程、起读线程）。两个入口
  （`onStart` 的 600ms 延时任务、页面首帧 `resize()` 的桥调用）同时进来时都能通过检查。
  此外 `sessionStarted` 本身也没有 `@Volatile`——后台线程写完，主线程可能读不到。
- **修法**：把「判定 + 置位」收进 `ConsoleSessionStartGuard.claimStart()/claimRestart()` 的一个
  `synchronized` 单元；Activity 只剩「拿准入 → 后台线程跑 start → handler 回主线程 settle」。
  **锁只护守卫与置位**，start/restart 的文件 IO 仍在后台线程，不进锁内。
  为什么必须抽成独立类：Activity 无法在 JVM 单测里实例化，行为面（并发只放行一次）就永远测不到。
- **判据**：`并发启动只许起一个 PTY`——4 个线程用**自旋栅栏**同时抢准入，任何一轮放行数不为 1
  即判红，**没有「低于阈值就算过」**。另有三条形态用例钉住 Activity 不自持标志、先拿准入再起会话。

## 3. 负控为什么会「假绿」——起跑方式决定竞态能不能被观测

这是本轮最值得记的一条：

- **CyclicBarrier / CountDownLatch 起跑测不出这个竞态**。实测（本机 JDK 17，x 4 线程）：
  CyclicBarrier 起跑 **0/300 轮**撞上竞态；自旋起跑（全部就位 → 一个 `go` 标志放行）
  修前形态 **132/200 轮**撞上，最多 4 个线程同时通过。
  原因很直白：`await()` 的唤醒抖动在毫秒级，线程一个接一个醒，后到者看到的 `starting` 早已为 true，
  竞态窗口被完全跳过。**用例会绿，但它证明的是「没有并发」，不是「守卫正确」。**
- **判据：先证明负控会红，再相信它会绿。** 本轮的做法是拿掉 `synchronized`（只留同样的判定与置位）
  跑一次，确认并发用例判红并打印实际轮数（49/60），再恢复。
- **别在用例里加睡眠**：`Thread.sleep` 只会把窗口撑大到所有线程都错过它；
  正确的做法是用一个「主线程放行」的闸把**全部准入尝试**卡在同一时刻，由主线程控制顺序。

## 4. 复验

- 修前（`origin/main` f45aa988）：`ConsoleSessionSingleStartGuardTest` 3 条全红——
  `lastRefreshFailureUnclassified` 缺注解（声明区实测只有相邻两行）、Activity 仍自持
  `sessionStarted`/`sessionStarting`、守卫文件不存在。
- 受控负控（把 `claim` 的 `synchronized` 拿掉、判定与置位照旧）：并发用例判红，
  实测 `有 49 轮出现多个线程同时通过首次启动准入（最多 4 个）`（60 轮 x 4 线程）。
  恢复 `synchronized` 后同一用例恒为 1。
- 修后：5 条全绿（含 60 轮自旋并发，用例耗时约 4s）。
- 套件：`:app:testDebugUnitTest` 全量 198 个测试类 / 2065 例，0 失败 0 错误（2 skipped 为既有）。
- 门禁：`check-code-map` PASSED（新增 `ConsoleSessionStartGuard.kt` 已登记覆盖；另有 8 条
  **既有**行号锚点因本仓 main 上 EngineManager.kt 内容下移而漂移，按提示重指行号并补
  `#expect=`，未跑 `--refresh-anchor-baseline`）；`check-kotlin-comments` PASSED；
  `check-kotlin-test-count` PASSED（2065 >= 基线 2060，无缺席、结果新鲜）。
- 未做设备验证：本轮只改可见性与守卫的原子性，无 UI/交互面变化；真机双启 PTY 的现场复现
  需要人为制造 onStart 与首帧 resize 同时到达，按 §4.2 记「未做设备验证」，随版本候选补验。
