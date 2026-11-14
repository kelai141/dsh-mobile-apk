# 2026-11-15：白屏缺一条判据（issue #1744）

## 现象

打开应用后 WebView 长时间白屏，不闪退、无错误页。引擎健康（`boot-segments.log` 有 `t_listen` / `first-http` 成功），
页面侧零 console，`boot-diag.log` 里 `page-ready` 有 9 条、`page-stall` 0 条、`shell-stall` 0 条。

## 先纠正一个错误归因

issue 第一部分把 `engine-start-deferred-no-transaction` / `-timeout` 这对 stage 读成「多个启动入口互相争锁、
引擎始终未被拉起」。源码链路表明它只描述**本次请求**，不描述引擎：

- `flowOwnership.begin(entry)` 抢世代所有权（进程内 AtomicReference）；
- 抢不到 → 写 `engine-start-deferred-no-transaction`，按 200ms 步进重试，累计 15 拍 = 3000ms；
- 用尽 → 写 `-timeout` 然后 return。

被拒的那次请求本来就不负责 spawn，3s 预算也只决定它自己还等不等。设备证据同一份日志里，
成对的 timeout 行**自带有效的 `t_boot_start`**，说明 3 秒后另一条流已经 spawn 完。
所以这对 stage 与「引擎起来了」可以同时成立，不能当「引擎未拉起」的证据。

## 真正的缺口

壳侧唯一就绪判据是页面自报 `[dsh-boot-ready]`（`pageReadyReported`）。拿不到它时壳只写一条
`shell-stall` 诊断，**不改相位、不盖视图、不弹错误页**。而页面侧就绪判据只看 DOM（`#root` 子节点 /
`[data-dsh-frame]` / `main` 文本）——一个 client bundle entry 崩掉即整树卸载，且这类崩溃常常
一条 console 都不留（上游 slot outlet 对 entry 没有 per-entry 错误边界）。

于是「引擎健康 + 页面白 + 零提示」是一个没有判据、也没有出口的稳态。

## 修法

**唯一能在「零 console」下拿到判据的通道，是壳侧自己注入的探针。**

1. `BlankScreenGate`（新文件，纯状态机，可离线判红）：
   - 连续 3 拍「根节点缺失且可见文本极少」才判白屏 → 一次抖动不误报，最迟 30s（拍长 10s）判出；
   - 判过之后**粘滞**（`BLANK_STICKY`），不重复动作——否则每 10 秒重建一次页面；
   - 页面报 `rendered` 时解除粘滞，下一轮可重新判（否则一次白屏之后永久沉默）；
   - **探针失败不参与白屏计数**（`probeFailed` 分支）：渲染进程真死是 `FreezeRecoveryGate` 冻结链的输入，
     两条自愈链不互相抢动作。
2. `RenderProbe`：解析 `evaluateJavascript` 回调。回调参数是**脚本 return 值的再编码**
   （脚本自己 `JSON.stringify` 过，所以是两层 JSON），必须解两层；解不出来时标 `failed`，
   **绝不能**当成 `root=0`——那会让坏探针永久判白屏，是最坏的方向。
3. 接线：把冻结看门狗原本每 10 秒发的 `evaluateJavascript("1")` 换成返回
   `{root,text,err,bundle}` 的探针。**同一次往返同时喂两条判据**（应答到达 = 页面真活，
   原有 `freezeGate.onAck` 语义不变；读数 = 渲染真值），不额外增加主线程/binder 往返，拍长不变。
4. 判出白屏时：`writeBootDiag("blank-screen", …)` + `mirrorDiagnosticsToShared("page-blank")`
   + 切 `GuidePhase.Recovering` 并显示引导页。

## 为什么兜底动作不是「直接重建页面」

重建页面在「插件树本身坏了」时会变成 reload 环（CONTRACT §4 那条闸门就是为此存在）。
先落取证并让用户看到「正在自动恢复」，重建交给既有的页面恢复策略——那条路径已带一次性闸门
与失败预算，不在这里实现第二套。

## 判据

`BlankScreenGateTest`，15 例，全部行为断言：

```
com.dsharnessmobile.shell.BlankScreenGateTest: tests=15 fail=0 err=0
com.dsharnessmobile.shell.BootStallClockTest: tests=6 fail=0 err=0      （回归）
com.dsharnessmobile.shell.FreezeRecoveryReArmTest: tests=7 fail=0 err=0 （回归）
```

负控（把 `BLANK_BEATS_THRESHOLD` 改成 99 = 永不判白屏）：

```
NEG1_EXIT=1
BlankScreenGateTest > consecutiveBlanksReachTheVerdictAtThreshold FAILED
BlankScreenGateTest > verdictIsStickyUntilThePageRenders FAILED
BlankScreenGateTest > tinyFrameworkTextIsNotContent FAILED
BlankScreenGateTest > aRenderedBeatAfterBlankLiftsTheStickyState FAILED
```

恢复后全绿（`Copy-Item` 备份还原，未用 git stash）。

## 边界

- 未做设备验证：本环境无打包预算（`build-apk-013.ps1` 全链需 WSL 快照重建），且该缺陷需要
  真机上「页面加载成功但没渲染」的现场。进入发版候选前必须补：
  ① 造一个 client bundle entry 崩溃（或直接把 root 清空），确认最迟 30s 内出现 `blank-screen`
  诊断行 + 引导页；② 确认健康页面**不会**被误判（连续多轮冷启动零 `blank-screen`）。
- 本 PR 只做「判据 + 兜底相位 + 取证」三件最小集。issue 建议里的第三项
  （把 `pendingBundles`/`badBundles`/`outerHTML` 也塞进取证）留作后续——探针已带 `bundle` 计数，
  再多收字段属于取证的细化，不影响「有没有判据」这件事。
