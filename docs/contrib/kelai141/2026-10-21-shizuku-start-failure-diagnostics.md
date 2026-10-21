# issue 471：Shizuku 用户服务启动即崩的诊断、退避与降级引导（2026-10-21）

## 现场

- 设备：联发科（MTK）ROM 真机，Shizuku 13.6.0。
- 现象：授权正常、Shizuku 服务在运行，但客户端永久停在「已授权，通道建立中」；每约 20 秒重试一次，日志可见 676+ 次失败。
- 子进程：`com.dsharnessmobile.shell:dsh-vdisplay` 以 shell/root UID 启动即崩，`System.exit(1)`；Shizuku 30 秒后判 `not started`。
- 堆栈：ROM 在 `LoadedApk.makeApplicationInner` 里调用 `Application.getProcessName()`（Shizuku 的 `app_process` 启动路径返回 null），随后 `.equals()` 抛 `NullPointerException`。

## 为什么客户端此前看不见

binder 回调只有三种：连上、同步抛异常、看门狗超时。子进程崩溃不产生其中任何一种（在 MTK 场景里连 `onServiceConnected` 都不会到达可用 binder），客户端只能看到「没有回调」，于是永远报「正在建立」。真实堆栈只存在于子进程的 logcat 里。

同时 `kickBind` 没有任何节流：设置页与虚拟屏面板每 2 秒轮询 `status()`，每次都会在「已运行、已授权、未绑定」时拉起一次后台绑定，失败后下一拍继续。这就是重试风暴。

## 修法

壳侧（Kotlin，纯逻辑 + Android 面分离）：

- `ShizukuBindState` 增加连续失败计数与退避排期：超时、发起即抛、无效 binder 各记一次；连接成功或用户重置清零。
- `retryDelayMs`：15s 起、每次翻倍、上限 300s。`canAutoRetry/autoRetryAfterMs` 只约束 `kickBind` 的自动重试，用户显式动作（建屏、命令、重置后）不受限。
- 连续失败达 3 次进入 `startFailed`：`status()` 返回 `shizuku-user-service-start-failed`，并附 `connectFailures/startFailed/retryAfterMs`。
- 达阈值后由后台守护线程执行一次 `logcat -d -t 800`，`ProcIo.readBounded` 有界读取，`shizukuDiagnosticsExcerpt` 只保留 `dsh-vdisplay` / `ShizukuServiceStarter` / `LoadedApk` / `FATAL EXCEPTION` 等行；结果过 `EngineAuth.redact` 后随 `diagnostics` 字段返回。连接成功后清空。
- `classifyShizukuStartFailure` 纯函数识别 `makeApplicationInner`（或 `LoadedApk` + `NullPointerException`）为 `ROM_LOADED_APK_NPE`，否则按 `FATAL EXCEPTION` / `System.exit` 归为 `PROCESS_EXITED`。只有前者会引导降级 Shizuku 13.5.4 或改 ADB 通道，避免把普通崩溃误导成 ROM 问题。
- `ShellOps.canFallbackBeforeDispatch` 接受该 code：绑定从未成功，命令一定未派发，回退 su 不构成重放。

页面侧（`phone-control.tsx`）：

- 新增状态词「已授权，用户服务启动失败」；`binding` 仍优先（新尝试在飞时不说失败）。
- `diagnostics` 非空时渲染可展开的 `<details><pre>`，默认折叠；通道正常时不出现。

## 证据

- Kotlin：`ShizukuBindStateTest` 40 例，覆盖退避序列与上限、三次失败阈值、无效 binder 计数、看门狗计数、成功/重置清零、MTK 与普通崩溃分类、中英文案、诊断截取过滤、`kickBind` 退避闸与 status 字段的源码级接线。
- UI：`phone-control.spec.tsx` 覆盖新状态词、兜底引导、字段解析与渲染；typecheck 通过。
- 设备限制：模拟器无法制造 MTK ROM 的 `makeApplicationInner` 崩溃，X1/X2/X3 的真机结论需在报告者设备回收；本机设备层只验证「通道正常时不出现诊断块」与页面可操作性。
