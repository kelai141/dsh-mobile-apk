# Root 策略与固定属主维护（0.14.3，PR #308）

> 源码契约，不是验收报告。本文源自 0.14.3 交接，现行语义按源码维护；旧版本的交付状态不能作为当前测试、发布授权或设备通过的证据。本次原生重构证据见协调仓 `docs/phonecontrolrebuild/`。

## 1. 模型执行与应用维护分开

模型 root 执行须满足实际 root 通道、用户开启 AI root 及覆盖当前免责声明内容版本 `RootGrant.DISCLAIMER_REVISION` 的知情同意。RootGrant.isGranted 是有效授权，不只读原始开关；root Shizuku 与显式授权 su 是替代通道，uid2000 不是 root。APK 升级本身不使同意失效，免责声明内容版本变化才需重新确认；旧 `consentVersionCode` 只用于迁移。重新同意不恢复旧开关；关闭和撤销始终允许。su 只对明确的派发前通道不可用回退一次；拒绝、命令非零 exit、超时、Binder 派发后结果不明不重跑。

应用维护只修固定本应用 dataDir，目标为 ApplicationInfo 的完整 Android UID。su 从已安装签名 APK 的 sourceDir 加载 RootRepairMain；固定五参数 fullUid、dataDir、relativeSubpath、cap、timeoutMs，逐项检查并独立 shell 引用。无可写快照 dex/JAR、任意 uid/gid、任意命令、递归 restorecon 入口。Shizuku v4 追加 configuration 回读确认完整 UID/可信 anchor；旧或未确认服务不派发。

## 2. 耐久租约：先记账，后真正 UID0 派发

[RootMaintenanceLease](<dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/RootMaintenanceLease.kt#L56-L105>) 使用私有 SharedPreferences 同步 commit epoch、startedAt、operation；不能取得启动 epoch 或不能持久化即拒绝派发。su 命令/helper 与 Shizuku 实际 uid0 的每个操作在派发前建立租约。Shizuku RpcLease 在持久化之后再次检查实际 UID 与有效 consent；pull/push 每个 chunk 均在本地准备完毕后、RPC 紧前重新检查，而非只检查传输开始。

**operationId 全链**（PRD 5.2 / AC-08）。每个作业在**置 running 之前**由 SecureRandom 生成 32 位小写十六进制 ID（newOperationId 按位取低 32 位分四段，曾因 minOf 截断退化成全 f 被单测抓住），写进 start() 返回的 Launch(id, latch) 与状态字段；worker 用 RootMaintenanceLease.withOperationId(jobId) 把这一个 ID 交给线程作用域，深处的 beginOperation 直接采用它，于是 su 与 Shizuku 两条通道的回执、租约、结果都指向同一次作业。结果发布前必须自证：ID 形态不符或缺失时由 worker 盖上 jobId。结算侧 finish(context, expectedOperationId) 走纯判据 finishAllowed，要求**原 owner 线程 + 租约非 unknown + ID 相等**；期望 ID 为 null/空串只按「未携带」处理，仍然受前两条约束。读取面 state() 只把 ID 与当前租约（或最近一次作业）相符的结果当作本次结果，其余标 resultStale；桥入口 rootOwnershipResult(operationId) 先过帧信任校验，再依次判非法 ID、ID 不符、运行中、无结果，绝不复用历史回执。

**并发收尾**。runBlocking 等待的永远是**本次启动自己**的那对 (ID, latch)；另一个入口已在跑时在同一临界区内成对取 Launch(operationId, latch) 加入它这一次，不跨作业拼接。worker 构造（含 isDaemon）与 start() 同在一段 try 内：构造阶段的 OOM / SecurityException 与 start 抛异常走同一个失败分支——复位 running、归零 latch、写入带 operationId 的 repair-worker-unavailable 结果并持久记下需复查。request() 认这条本次失败（launchFailure 要求失败 ID、当前 ID、结果 ID 三者相符）并直接回 ok:false + 该 ID，不再把一次确定失败说成 repair-running。

租约仅由原始 owner caller 在得到确定完成回执后 finish；普通异常、exit/drain 超时、readError、cleanupIncomplete、Binder 完成未知及清租约 commit 失败均转 UNKNOWN。杀 su 客户端、父进程退出、关闭本地管道或本地 reader 结束，都不能证明特权后代停止。UNKNOWN 阻止新受控 RPC/命令、维护和启动前读取快照事务，不自动重试副作用。

同一 boot 内应用重启/recreate/进程重建仍从耐久记录恢复 UNKNOWN，不能靠 app restart、重置 Shizuku 或手工清除解除。仅 saved/current epoch 均非空、同属 boot-id 或同属 boot-count、且值不同，才证明设备真正重启并允许清除旧租约；来源方案切换、epoch 缺失不算新 boot。没有产品手工清除出口。

su helper 必须有完整 JSON 信封（布尔 ok、非负整数 checked/healed/failures/unverifiedMutations、remaining 为 -1/0、布尔 truncated/deadlineExceeded）及已确认 exit0/2，且 transport 完整、未截断。已确认的失败/部分修复信封可以 finish 租约，但仍返回 repair-incomplete/ok=false；“工作已结算”不等于“修复成功”。信封缺失/畸形不 finish。完整成功还须 exit0、failures=unverifiedMutations=remaining=0、无 cap/deadline 截断。

2026-10-01 结算对齐落地（无 root/已撤 root 设备卡「等待属主维护」事故）：Shizuku 修复面以**信封完整性**决定结算——完整 ⇒ finish 并如实回 repair-incomplete/ok=false，缺失/畸形才停 UNKNOWN（此前 `definitive=verified` 未实现本节承诺）。`su-exec-failed`（进程拉不起来，从未派发、零副作用）同样 finish，且 granted 缓存立即降级 denied——缓存不得比 su 本体活得久。残留租约新增唯一非 owner 出口 `RootMaintenanceLease.clearWhenNoRootChannel(context, guard)`：仅当**肯定判定**所有真实 root 通道都不存在时调用——隔离没有可串行化的特权对象，留着只会把启动挂到整机重启。

2026-10-02 真机修正（小米 14 Pro，本地 vc45 变体）：清算必须发生在 **`RootOwnershipJobs.start()` 咨询租约之前**（`ShizukuTransport.clearLeaseWhenNoRootChannel`），不能只放在维护 worker 内（**worker 内的清算已移除**）——`start()` 的 `outstanding` 短路会绕过 worker，启动仍会挂死。A/B：注入同 boot 残留租约 + 撤 root 路后重启，修前 345s 无 boot-start / 引擎不起 / 租约原封不动；修后 15s HTTP 401 且租约被清空。

2026-10-02（review 收紧，第三版）——判据与原子性纪律。①**判据同源，且只有一条**：入口清算与维护 worker 共用 `ShizukuTransport.probeRootChannel`（唯一判据）与纯函数 `decideNoRootChannel`（真值表 `RootChannelDecisionTest`）；探测的原始信号经**可注入**的 `RootProbeEnv` 取（生产实现 `SystemRootProbeEnv` 走真 binder，单测注入假实现，整条链可在 JVM 上跑）。②**判据必须以真绑定实证**，顺序：`suGranted` ⇒ AVAILABLE；ping 明确 `false` ⇒ 服务端不在；ping 抛异常 ⇒ 不判断；其余**真去绑定 UserService**（`ensureBound(..., requestPermission = false, ignoreGranted = true)`）并读回 `remote.uid()` ⇒ BOUND 且 uid 0 为 AVAILABLE、BOUND 且非 0 为 ABSENT。**探测面两条硬约束**：`requestPermission = false` 不弹授权框（本机自检假阴性会让 `ensureBound` 去发授权请求、把启动卡在系统确认框上，2026-10-02 真机实测 165-225s 无启动）；`ignoreGranted = true` 绕过不可靠的客户端权限预检，真去尝试绑定。③**`decideNoRootChannel` 只认三类「证明」**：绑上且非 root uid ⇒ ABSENT；未装 Shizuku 且无 su 二进制 ⇒ ABSENT；服务端明确不在（ping `false`）或协议明确不支持 ⇒ ABSENT。**其余一律 UNKNOWN**——尤其 `DENIED`（`shizuku-denied` / `shizuku-permission-requested`，即权限面被拒）**只算 UNKNOWN**，因为它只证明客户端权限面不可信。**曾经的坑（复审第 1 点）**：旧实现在 `status.granted == false` 时**根本没尝试绑定**就直接判 ABSENT，而本机（服务端 v13.6）`checkSelfPermission()` 有假阴性、`getUid()` 撤权后仍返回 0 ⇒ 会把**真实存在的 root 通道判成 ABSENT** ⇒ 误清隔离。**为什么不能用 `getUid()` 可读性**：同上两个廉价信号都不可信。④**「通道不可用」不等于「旧特权任务已结束」（复审第 2 点）**：本模块的 `synchronized` 只覆盖本进程，**证明不了**外部 su 子进程 / Shizuku UserService 已退出，故 `RootMaintenanceLease` 新增**派发证据** `markDispatched(context, transport)`（`dispatched` 落盘 + `dispatchedAt`）：su 在 `RootAccess.execPrivileged` 派发前写 `"su"`，Shizuku 在 `RpcLease.beforeRpc` 拿到租约后写 `"shizuku"`；**写不进即把租约置为结果不明**（保守方向）。⑤**自动清算准入**（纯函数 `autoClearAllowed`）四条件缺一不可：通道被证实 ABSENT **且** 租约 `dispatched = false`（从未派发）**且** 租约结果可信（`RootMaintenanceLease.unknown(app) == false`，结果不明则不下任何处置）**且** 无在飞维护；锁内还会再复核一次（含 `!RootMaintenanceLease.dispatched(app)` 与 `!RootMaintenanceLease.unknown(app)`）。**为什么 `unknown` 也要否决**（复审第四轮）：「没有派发证据」≠「证明没有派发」——`markDispatched` 落盘失败只置 `unknown`（`dispatched` 仍为 false），`restore()` 恢复别的进程留下的租约也一律置 `unknown`，这两种情况下 `dispatched = false` 可能正意味着「证据没落盘」⇒ 一律不清；同理 `markDispatched` 落盘失败时**两条派发路径都拒绝派发**（`root-lease-evidence-unavailable`：su 侧 `RootAccess.execPrivileged`、Shizuku 侧 `RpcLease.beforeRpc`），与 `begin()` 的耐久性纪律同源。⑥**人工出口**（引导页「清除隔离并重试」→ `forceClearMaintenanceLease`）：锁外先给一句明确话术（`maintenance-active` 指引），命中了就在**锁内再复核 `!RootExecutionFence.maintenanceActive`**（复审第五轮：锁外那次检查与真正清除之间有窗口，中间可能有另一个入口启动维护并刚拿到新租约，此时清掉就会破坏在飞结算；用户授权 ≠ 可以拆掉并发保护。`clearWhenNoRootChannel(context, guard)` 的 `guard` **无默认值**，不带复核的调用编译期就不可能），只在「进程内确有在飞维护」时**拒绝**；对已派发**或状态不可信**的租约照清，但如实回 `terminationUnproven = dispatched || leaseUnknown` 并写审计，引导页把「清除不能证明那次工作已结束」讲给用户——**用户确认不等于终止证明**。⑦**已知受限场景（不粉饰）**：Shizuku 服务端在跑、但本应用授权被撤（`BindOutcome.DENIED`）⇒ 判据只给 UNKNOWN ⇒ 残留租约**不会**被自动清算（保留隔离），只能走引导页人工出口；这是刻意的保守取舍——权限面被拒只证明客户端权限面不可信，不构成「通道不存在」的第三类证明。**留痕**：每次判定写 `files/lease-clear-probe.log`（有界 8 KiB），记 `state/serverUid/decisive/forced/dispatched/leaseUnknown/allowed/detail`，`detail` 是**原始信号** `installed=… suBinary=… ping=true|false|throw bind=NOT_ATTEMPTED|BOUND|DENIED|SERVER_ABSENT|PROTOCOL_TOO_OLD|TIMEOUT|BINDER_THREW|UNKNOWN uid=…` ⇒ 「压根没尝试绑定」在日志里一眼可见。**原子清算**：`guard` 在 `RootMaintenanceLease` 的同一临界区内求值、与 `begin()` 互斥（不会清掉 worker 刚拿到的租约，也不会与刚发生的派发交错）；`commit()` 失败有界重试一次，仍失败如实返回 false。**产品出口**：引导页在租约 outstanding 时提供用户确认后的清除出口，重试预算用尽后转为**每 5 分钟**静默复查，不再只能重启设备。

## 3. 所有权边界与限制

OwnershipRepairCore 在访问前预留预算：上限 200000 entries、64 层、120000ms，默认维护 20000ms；cap/deadline 是变更前约束而非事后统计。Android adapter 用 O_PATH/O_NOFOLLOW pin 元数据，只对普通文件/目录 reopen 已持有 inode；后代经 held directory FD 与校验 basename 访问。fstat 对照身份后 fchown，再 fstat 验证；checked/healed/failures/unverifiedMutations 分别报告，应用 UID 祖先也继续深遍历。

symlink 不跟随；root-origin regular hardlink、foreign owner、跨 device、特殊节点、循环、深度/cap/deadline 与列举/变更异常显式报告。要求 protected_hardlinks=1，未知/关闭拒绝；root-origin group/other-writable regular 拒绝。fstat→fchown 不是抵御另一恶意 root 的原子事务，维护需要特权 namespace quiescence。RootExecutionFence 只串行本应用受控入口，不能锁外部 root 或已获授权命令主动脱离 stdout/父进程的后台后代；任意 root shell 不是进程树沙箱，维护前仍需 namespace quiescence。SELinux 不重标，selinuxRelabeled=false；uid 归一不证明标签或应用读写验收通过。remaining=0 只用于完整成功，部分/未知为 -1。

## 4. I/O、栅栏与共享维护状态

[RootExecutionFence](<dsh-mobile-apk/app/src/main/java/com/dsharnessmobile/shell/RootExecutionFence.kt#L18-L34>) 每次接收 Context 并在锁前/锁内检查耐久租约；公平 ReentrantReadWriteLock 的读锁使用零毫秒 timed tryLock，尊重排队写者，不用会插队的裸 tryLock。维护取写锁，命令取读锁；忙时不排无限等待。

ProcIo 的 destroy/各 stream close 都在独立 daemon cleanup worker，waiter 只按共同 cleanup 预算 join；read/close 不在输出内存锁内。返回 text/flags 是有界不可变部分快照，晚到 reader 不能改已返回结果；readError 不当 EOF。ShizukuCaptureIo 使用执行 UID 拥有的0700目录（root 在本应用 cache，shell 在自身目录），随机名、CREATE_NEW/NOFOLLOW_LINKS 创建 .part；不覆盖已存在输出路径。writer/flush/close 真结束且 exit、drain、cleanup、读取与 cap 均完整后才无覆盖发布；不完整返回 spoolReady=false、空路径与不可变 inline/size，不能作为可取的 ready spool。

RootOwnershipJobs 是进程级 single flight；状态锁 `lock` 只守字段（`state()` 与桥调用只取它，不被探测挡住），入口清算的真绑定探测在独立的 `entryLock` 内串行化（issue #319；方案与用例来自 PR #322 @Ni-ShuWu）；UI request 立即返回 repair-started/repair-running，root 状态既有轮询读实际结果。state 合并本地 worker 和当前耐久 lease：worker 已返回但 lease 未 finish 仍 running/pending、completedAt=0，UNKNOWN/超30s overdue；结果和 lease 分开呈现，不把旧 complete result 冒充当前租约完成。caller 最多等待30s，不取消共享 worker，也不以 caller 超时释放耐久隔离。相近 Activity/Service 启动仅复用5s内**已结算且 ID 相符**的结果；用户维护与普通重试重新检查。

**启动健康判据（PRD 5.2：属主修复是异常恢复，不是启动常态）**。prepareStartupOwnership → runBlocking(reuseRecent = true) → start(startup = true)：先做入口清算（只有确存在残留租约时才付真绑定探测成本），再在**置 running 之前**判 startupScanRequired(hasLease = false, lastReportedProblem = ...)。判定为健康时既不探测 root 通道也不做有界遍历，如实回 {ok:true, skipped:"no-maintenance-required"}，不假装修过。

lastReportedProblem 由**进程内结果**与**持久记录**共同决定：reportedProblem(result) 认 unknown、ok=false、非零 failures / unverifiedMutations、truncated、deadlineExceeded；持久面是独立 prefs dsh_root_maintenance_followup.needsFollowUp（与租约 prefs 分开，clear() 不会顺手抹掉这条证据），读取失败按「需要复查」处理。为什么必须持久：进程重启后内存结果为空，只看内存就会把「上次失败」误判成健康并跳过维护。写入顺序是**先盖本次 ID → 再落盘复查需求 → 最后发布结果**，所以启动路径读到结果时判据已同步。skipped 族结果（no-root-path / root-channel-unknown）说明维护压根没跑，followUpUpdate 返回 null，既不洗白也不记新失败，等下一次真跑过再改写。

## 5. 启动生命周期所有权

Activity 的 StartupFlowOwnership 用一份 CAS 状态绑定 running、token/generation、destroyed；旧 finally 不能清新 flow。Service 使用独立 ServiceEpoch，恢复/Binder 等待后每个后续副作用重新检查当前 epoch、instance、停机和 interrupt。销毁/关闭取消该 caller wait 与该 epoch 定时器，不取消 RootOwnershipJobs 共享 root worker。

维护 pending 使用独立有限六次延迟预算 [2,4,8,16,30,30] 秒；耗尽保持 pending，不自旋、不重复 helper，不重置已用预算。它与普通引擎失败的两次5/10秒重试不是同一预算。WatchdogV2 的 WakeLockOwner/EpochResourceOwner 按 epoch 获取、续期、释放；晚到 acquisition 被释放，旧 Service teardown 不能释放新实例锁。

## 6. 外部验证与未覆盖边界

新增 pure core、参数解析、I/O/capture settlement、RPC lease wiring、startup ownership fixtures 已写，未在本次 source/doc 分工执行。源码扫描类 fixture 只证明接线形状，不代替实际 UID0/Binder/设备副作用取证；RootMaintenanceLeaseTest已登记pure newBoot/scheme切换与源码wiring，但durable lease同boot新进程restore、真实boot、commit失败及late acknowledgement仍需外部行为反证。测试需求见 [0.14.3 测试交接](<docs/0.14.3-TEST-REQUIREMENTS.md>)。不得沿用原作者 head 的测试/设备证据，不宣称完整三层、安全或可发布验收通过。

## 7. 环境准备（prepareEnvironment）的边界

NativeEnvironmentExecution 只保留旧 android_env_prepare 里有效的一项能力：把三项框架动画倍率（window_animation_scale / transition_animation_scale / animator_duration_scale）置 0 并按可信原值恢复。**没有任何输入法逻辑**——不读不写 DEFAULT_INPUT_METHOD、不启用或切换输入法、不弹软键盘；默认 IME 全程不变。

通道固定为 Shizuku 服务端 shell 2000，经 ShizukuTransport.runController 执行固定 argv（只有 settings get global / settings put global），不接受模型拼命令；controlMemory 目标、NotScreenScoped、无屏幕。未配置或没有可用 Shizuku 时不执行，连读都不做。

先读三项原值并校验形态（有限十进制倍率）；任何一项读不到或不可信就一项都不写。原值由应用 UID 私有 prefs 先落盘再写；写前消费一次授权门，之后每一项写或恢复前都 refreshFacts + Rust validateDispatch 复核仍在 dispatching，超时或撤权立即停。恢复只针对当前仍是我们写下的 0 的键，用户后来自己改过的值一律不动，并清掉对应记录；没有可信原值就如实回 environment-nothing-to-restore。重新执行关闭时，若用户已把值改成别的非 0 数，记录改写为用户当前值而不是保留过期旧值。部分写或回读不一致一律 unknown + noReplay，禁止自动重试；单 worker、无队列，忙时直接拒绝。

接线：NativeControlRuntime 里用 NativeEnvironmentExecution(app, NativePrivilegeExecution(app, androidExecution)) 作为 Platform 传入 NativeControlHost.open；Rust 侧 OPERATIONS 已登记 prepareEnvironment，NativePrivilegeFacts 在 shell2000 功能就绪且 /system/bin/settings 可执行时把该 op 加进 supportedOps。模型面 TS 工具不在本适配器内。

验证边界：本类与 NativeEnvironmentExecutionTest 只做 JVM 行为验证（固定三键与 argv、原值信任、门与每步复核、unknown 不重放、恢复不覆盖用户改值、无输入法逻辑），未在设备上执行 settings 写，也未做三层验收。
