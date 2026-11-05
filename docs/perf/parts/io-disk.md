# D 块：IO / 磁盘审计 + 度量工具链与可复现基线

- 审计日期：2026-11-02
- 工作区：`D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\perf-audit`（git worktree，分支 `perf/audit-2026-11-02`，基线 `47869404`）
- 产物来源（只读）：主工作区 `D:\coding\dsh-mobile\dsh-mobile-apk`
- 环境：无模拟器/无真机（设备已全部关闭）。**本报告不含任何设备实测**；证据分三类：静态源码分析、真实构建产物的字节级读数、宿主侧可复现微基准。
- 可复现入口：`scripts/perf-audit-d/measure.mjs`（一条命令输出本节全部基线数值）

---

## 0. 一句话总结

本块的三个硬结论：

1. **`audit.ndjson` 是本仓唯一「只增不减、无轮转、无上限」的运行时状态文件**，而它的每条记录都用 `File.appendText`（每次 open+write+close）追加。宿主负控显示该形态比常驻句柄慢 **11.2 倍**。其余所有同类文件（engine.log 保 5 代、dsh-day.log 5MB 轮转、notify-responder.log 128KB 轮转、截图 128MiB+TTL+32 个上限）都有界——唯独它在设计上漏了。
2. **「复制当前引擎日志」是一次无上限的整文件读**，而且跑在主线程：`GuidePageRenderer.copyGuideLog` → `readEngineLogFull` → `f.readText()`，点击处理器就在 UI 线程上。engine.log 本身没有大小上限，冷启动失败循环可以把它撑到很大，此时一次点击 = 主线程读 N MB + 一次全文脱敏 + 一次剪贴板拷贝。同文件里已有更好的实现（`mirrorLogBounded`，2MB 尾部有界读）没被这条路径复用。
3. **门禁基线的真实状态是 19 绿 / 11 绿但 SKIP / 2 依赖缺席 / 9 红，且 9 红里没有一条是代码缺陷**——6 条是「净检出没构建产物/没跑单测」的环境缺口，3 条是「裸跑没给位置参数 tar」的调用姿势问题（给了参数就绿/另有真因）。这意味着**当前 worktree 的门禁基线无法用来证明「第二阶段没弄坏东西」**，必须先建一次插件产物。同时发现了两个位级证据：`check-snapshot-secrets` 在真实注入产物上**判红**（cmake 的 `Windows_TemporaryKey.pfx` 命中 `.pfx` 判据），以及`check-inject-completeness`判红（`dsh-shell-termux` 成员多 2 项）。

---

## 1. 测量口径与复现方式

### 1.1 环境与纪律

| 项 | 值 |
|---|---|
| Node | v24.17.0 |
| JDK | OpenJDK 17.0.2（有无，用于判定哪些门禁**本可**跑） |
| tar | GNU tar 1.35（via Git for Windows msys；**不支持 Windows 绝对路径**，见 §1.3） |
| 宿主 | Windows，多 agent 并发跑测量 |
| 设备 | 无。禁止 adb 操作 |

计时类一律按纪律处理：≥5 次、报中位数 + min/max、显式标注「宿主并发负载下测得，绝对值偏高，相对比较有效」。**字节级/静态计数类是本节的主证据**，它们不受 CPU 抖动影响。

### 1.2 可复现入口

```
node scripts/perf-audit-d/measure.mjs \
  --artifacts D:\coding\dsh-mobile\dsh-mobile-apk \
  --json .deploy-tmp\perf-audit-d\baseline.json \
  --with-gates --timing-rounds 5
```

本报告 §2 的全部体积/计数数字由它一条命令产出。`--artifacts` 指向主工作区是因为 worktree 是净检出（`app/src/main/assets/snapshot.tar.xz` 被 `.gitignore` 忽略，必然缺席）——**191MB 的产物没有被复制进工作区**。

三个脚本的分工：

| 脚本 | 作用 | 是否交付物 |
|---|---|---|
| `scripts/perf-audit-d/measure.mjs` | 基线读数总入口（体积 / APK 构成 / 静态计数 / 计时 / 门禁汇总） | **是（最重要）** |
| `scripts/perf-audit-d/gates-baseline.mjs` | 逐门禁基线（每条的真实状态 + 真实耗时） | 是 |
| `scripts/perf-audit-d/audit-append-io.mjs` | D1-1 的负控微基准（三种追加形态对照） | 是 |

### 1.3 踩到的坑（写下来省下一个人的时间）

- **GNU tar 1.35（msys 版）不认 `D:\...` 形式的 `-C`/归档路径**：报 `tar (child): Cannot connect to D: resolve failed`（它把 `D:` 当成远程主机语法）。解法：`Push-Location` 到目标目录、用**相对路径**传归档名与 `-C`。本报告所有 tar 读数都是用相对路径取的。
- **`check-release-gates.mjs --run` 不能直接用来取基线**：它在第一条非零退出处**中止组装**。干净 worktree 上第 2 条 `check-dead-tokens` 就因缺上游树 exit 2，后面 35 条**一条没跑**（实测日志：`--run 段 37 项` 只执行了 2 项就 `中止组装`）。基线需要「每条各自的真实状态」，所以本块改用逐条 spawn 的 `gates-baseline.mjs`。**这不是缺陷，聚合器的语义就是"断了就停"；但用它当基线会得到一个假象：门禁全绿（因为压根没跑到红的）。**

---

## 2. 基线读数（第二阶段的前后对比锚点）

以上命令的实跑输出（`--timing-rounds 5`）：

### 2.1 产物体积

| 产物 | 字节 |
|---|---:|
| `app/src/main/assets/snapshot.tar.xz`（真正打进 APK 的那份） | 200,877,488 |
| `snapshot/snapshot-x86_64.tar.xz` | 149,201,056 |
| `snapshot/snapshot-arm64.tar.xz` | 153,784,504 |
| `out/v0.14.9/dsh-mobile-apk-v0.14.9-arm64.apk` | 163,133,182 |
| `base/base-dsh.tar.xz` | 45,830,328 |
| `base/base-usr-x86_64.tar.xz` | 80,933,336 |
| `base/base-usr-arm64.tar.xz` | 68,959,460 |

### 2.2 APK 构成（读 zip 中央目录，无第三方依赖）

**163,133,182 B / 239 条目；其中 stored（method=0，不压缩）36 条共 157,969,592 B。**

| 桶 | 压缩后 | 占 APK | 原始 | 条目数 |
|---|---:|---:|---:|---:|
| `snapshot.tar.xz`（内嵌快照） | 157,861,552 | **96.77%** | 157,861,552 | 1 |
| `classes*.dex`（代码） | 4,825,223 | 2.96% | 12,165,904 | 3 |
| `assets/`（其余） | 141,920 | 0.09% | 417,111 | 14 |
| 其它（顶层杂项） | 114,099 | 0.07% | 279,986 | 137 |
| `resources.arsc` | 95,488 | 0.06% | 95,488 | 1 |
| `res/` | 26,655 | 0.02% | 44,743 | 52 |
| `META-INF/` | 22,152 | 0.01% | 60,010 | 31 |

**注意：我这份产物的 xz 是 157,861,552 B，与任务书里写的 191.57MB（200,877,488）对不上。** 原因已定位：主工作区 `app/src/main/assets/snapshot.tar.xz` 的**当前磁盘大小是 200,877,488 B**（重新注入过，更新），而 `out/v0.14.9/` 里的 APK 是**更早一次构建**的残留。也就是说：**`out/v0.14.9/` 这个已发布包已经不能代表当前源码树的快照体积**——它内嵌的是 157.86MB 的旧快照，当前的会是 200.88MB（APK 预计 ≈ 206MB）。A 块（构建链/体积）如果拿这个 APK 当基线，会低估约 43MB。**这条是给 A 块的交叉发现，见 §5-①。**

### 2.3 静态计数（最硬的证据：不受 CPU 抖动）

| 指标 | 值 |
|---|---:|
| 生产 Kotlin | 158 文件 / 3,304,559 B |
| 测试 Kotlin | 238 文件 / 2,361,783 B |
| `check-*.mjs` | 73 |
| `readText` 命中 | 107 |
| `readBytes` / `Files.readAllBytes` 命中 | 31 |
| `copyTo` 命中 | 8 |
| `createTempFile` 命中 | 16 |
| `appendText` 命中 | 13 |
| `writeText` 命中 | 58 |
| `RandomAccessFile` 命中 | 13 |
| `ByteArray(...)` 有界分配 | 124 |
| `MAX/LIMIT/CAP` 尺寸常量 | 90 |
| 「无界读 / 有界设施」比 | **0.645** |

最后一行是本块自定义的一个代理量：`(readText + readBytes) / (ByteArray() + 尺寸常量)`。它**只是趋势指标，不是判据**——分母里的常量不一定服务于分子里的读点。把它当基线用（第二阶段这个数应当下降），不要当质量评分。

### 2.4 计时（唯一一条；宿主并发负载下测得）

内嵌快照全量流式 SHA-256（`app/src/main/assets/snapshot.tar.xz`，200,877,488 B，64KB 缓冲，纯读不进内存）：

- **median 1304.3 ms / min 1244.8 / max 1412.1，n=5，146.9 MB/s**

这条数字对应 App 启动前 `bundledAssetDigestProblem()` 的预检（`EngineManager.kt:129`），见 §3 D1-2。

### 2.5 门禁基线（41 条逐条实跑）

分布：**GREEN=19 / GREEN-WITH-SKIP=11 / DEPENDENCY-ABSENT=2 / RED=9**，总耗时 **216,520 ms**。

单条最贵的五条（宿主并发负载下，绝对值偏高）：

| 门禁 | 耗时 | 产出 | 结论 |
|---|---:|---:|---|
| `check-gate-skips.mjs` | 174,660 ms | 3,007 B | GREEN-WITH-SKIP |
| `check-snapshot-secrets.mjs` | 116,355 ms | 361 B | **RED** |
| `check-inject-completeness.mjs` | 40,542 ms | 9,914 B | **RED** |
| `check-patch-test-manifest.mjs` | 30,401 ms | 640 B | GREEN |
| `check-strip-noop.mjs` | 20,042 ms | 1,610 B | GREEN |

**`check-gate-skips` 一条占了 216.5s 里的 174.7s（80.7%），只为产出 3,007 B。** 它自己就是「耗时/产出」比最差的一条。这不是缺陷指控——它的设计就是「把每个门禁当子进程真跑一遍」（这一点是对的，见 §4.2）——但它现在是全量门禁墙钟时间的支配项，而它守的是「门禁自身的 SKIP 纪律」，**不守任何产品面**。A 块要的构建链耗时分解里，这一条必须单列。

---

## 3. D1：重复读写与整文件读入

### D1-1 `audit.ndjson` 追加形态每次 open+write+close，且该文件是全仓唯一无轮转上限的状态文件

- **测量方法**：读 `app/src/main/java/com/dsharnessmobile/shell/ControlAudit.kt:75-78`；对全仓 `MAX_BYTES|MAX_FILE_BYTES|...` 常量做静态枚举（`Get-ChildItem -Recurse -Filter *.kt | Select-String`）；宿主侧负控微基准 `node scripts/perf-audit-d/audit-append-io.mjs --records 2000`。
- **基线数值**：
  - `ControlAudit.appendTo` 的实现是一行 `File(auditDir, "audit.ndjson").appendText(record.toString() + "\n")`。Kotlin 的 `File.appendText` 每次调用 = open(APPEND) + write + close，**无常驻句柄、无缓冲**。
  - 微基准（2000 条，宿主 NTFS）：
    - A：open+write+close 每条（**当前形态**）= 548.4 ms，**274.2 us/record**
    - B：常驻句柄（下界）= 49.0 ms，24.5 us/record → **A/B = 11.2x**
    - C：open+write+**fsync**+close = 576.5 ms，288.2 us/record → C/A = 1.05x
  - 全仓 23 个尺寸上限常量里，**没有一个落在 `audit.ndjson` 上**。有界的是：`engine.log`（5 代轮转）、`dsh-<date>.log`（5MB 轮转，`LogCollector.kt:30`）、`notify-responder.log`（128KB 轮转，`NotifyProbe.kt:22`）、截图（128MiB + 1h TTL + 32 个，`ShotCachePolicy.kt:22-28`）、`notify-debug.log`（512KB，`WatchdogV2.kt:527`）。
  - 写入频率：`ControlAudit.log` 只有一个调用点 `ShellOps.kt:1321`（`audit()`，覆盖 shExec/shPull/shPush/shRemove），即**每次特权命令一条**。它不是热路径，但它是**无界增长**。
- **问题**：单条 274 us 本身不致命；问题在**它是唯一漏掉上限的那一个**。审计文件随特权命令次数单调增长，永不回收。对比同一份报告里 D1-3 的模式，这不是新问题类型，而是**同一套纪律唯一漏掉的落点**。另外：微基准 C/A=1.05x 说明「加 fsync」几乎不涨价——也就是说这条路径**本来可以**在几乎不增加成本的前提下做成「常驻句柄 + 定期 flush」，而当前形态付了 11 倍的 open/close 却**并没有**换来耐久性。
  - 附带一条**判据不对称**：插件侧 `plugins/dsh-android-bridge/src/index.ts:148-161` 的 `writeAudit` **有**滚动截断（`>2MB` 保留尾部 500 行），壳侧 `ControlAudit.kt` **没有**。同一个文件会被两个写者写，只有一个做到有界。
- **预估收益**：单条 IO 从 274 us 降到 ~25 us（-91%）。但**真正的收益是「不再无界」**：审计文件的可预期上限 vs 当前的无上限。按每天 1000 条特权命令估算，一年 ~365k 条 × ~290 B ≈ **106 MB** 无界增长（这个量级的估算依赖命令频率假设，标为推导值不是实测值）。
- **改动风险**：**低**。变成一个 `@Synchronized` 的常驻 `BufferedWriter`（或复用既有 `logExecutor` 单线程写面，与 `LogCollector.log` 同构，见 `LogCollector.kt:36-41`）+ 一个与插件侧对齐的 2MB 轮转。会破坏的东西：`ControlAuditTest` 断言的是「追加后逐字节可读」，需要保留 `flush()` 或在测试里用 `appendTo` 的同步面。**注意审计是 L2 安全敏感面**（`ControlAudit` 的 G-7 三态语义是取证正确性的一部分），改动必须带即时三层或等价负控。
- **负控**：同一脚本里三个对照同机同时段跑。A/B=11.2x 证明尺子能区分「每条 open+close」与「常驻句柄」；C/A=1.05x 证明尺子在「更快/更慢」两个方向上都还有分辨力，不是「三种形态天然一样」。**如果 A、B、C 三个数字互相接近，就是这个基准失效的信号**——本次不接近。

### D1-2 启动前的内嵌快照摘要预检：一次全量 200.88MB 读取（有界，但仍是启动路径的大块固定成本）

- **测量方法**：读 `EngineManager.kt:129-141`（`bundledAssetDigestProblem`）与 `EngineManager.kt:294-304`（在 `extractAndValidate` **之前**调用）；digest 实现 `SnapshotExtractor.kt:45`（`bufferSize = 64 * 1024`，流式）；宿主侧计时 `measure.mjs` 的 `timeFullSha256`（同一份文件、同一 64KB 缓冲形态）。
- **基线数值**：**200,877,488 B 全量读 + SHA-256 = median 1304.3 ms（min 1244.8 / max 1412.1，n=5，146.9 MB/s）**，宿主侧、并发负载下。设备上会不同（存储类型、page cache 命中、CPU 都会影响）。
- **问题**：这条路径**本身做对了**——它是流式的、有界的、不整读入内存（源码注释与 `SnapshotBundledAssetTest` 都锁住了这一点，值得肯定）。问题在**什么时候跑**：它在**每次触发快照刷新时**、在解码**之前**跑一遍。而快照刷新只在「升级 / 指纹不匹配」时发生，不是每次冷启动。所以：
  - **不是**每次启动 +1.3s。**是每次快照刷新 +1.3s（宿主尺度）**。
  - 但由于解压本身（191MB xz → 750MB / 44568 文件，见 §3 D2-1）才是真正的大头，这 1.3s 相对解压占比很小。**结论：这条不值得优化**，此处记录是为了让 A/C 块不要把它误算成「每次启动的开销」。
- **预估收益**：**≈ 0（建议不动）**。若真要省，唯一无损手段是「已解压且指纹匹配时完全跳过预检」——但 `snapshotFresh()` 已经在做这件事（`EngineManager.kt:152-163`），即当前设计**已经**只在必要时付这笔钱。
- **改动风险**：**高**（如果动）。这是「解码器内部异常 → 输入本身对不上」这一取证链的唯一来源，`check-snapshot-secrets`/`boot-fail.log` 的 expected/actual/bytes 三项目前完全依赖它。**建议：明确标注「不优化」，别让第二阶段顺手把它删了。**
- **负控**：用同一脚本的 `timeFullSha256` 读同一个文件，得到的结果与该文件的 `snapshot.sha256` 声明值可对账（`measure.mjs` 不落 digest 值，但对账手段是现成的）。另外 n=5 的 min/max 跨度 1244.8↔1412.1（13%）本身就是「宿主并发抖动」的量化——**任何小于 13% 的「优化」在本环境下都不可信**。

### D1-3 「复制引擎日志」是无上限整文件读，且在主线程

- **测量方法**：读 `GuidePageRenderer.kt:1064-1093`（`copyGuideLog` → `readEngineLogFull` → `f.readText(Charsets.UTF_8)` → `EngineAuth.redact(raw)`）；点击接线 `GuideChrome.kt:344-356`（`val copyLog = TextView(...)` + `setOnClickListener { callbacks.onCopyLog() }`，标准 UI 线程监听器）；`GuidePageRenderer.kt:386` 的 `onCopyLog = { copyGuideLog() }`；`MainActivity.kt:1811` 的 `copyTextNative`。
- **基线数值**：
  - `readEngineLogFull()` 对 `files/engine.log` 做**整份** `readText()`。**没有大小上限**。
  - `engine.log` 是引擎 stdout/stderr 的重定向目标（`EngineStartFlow.kt:1041` 注释：`redirectErrorStream(true)` + `redirectOutput(engine.log)`），且每次 spawn 被截断重写。**单代的长度完全由引擎自己的输出量决定，壳侧没有任何上限。**
  - 整个调用链在**主线程**上：点击 → `copyGuideLog` → `readText` → `redact`（正则全文替换）→ `copyTextNative`（剪贴板）。
  - 对照：同一个仓库里**已经有**正确实现——`EngineManager.kt:3256 mirrorLogBounded`（`MIRROR_LOG_LIMIT_BYTES = 2MB` 尾部有界读，`RandomAccessFile.seek` + 截断标注）。这条路径**没有复用它**。
  - 宿主观测量级参考：按 §2.4 的 146.9 MB/s 顺序读吞吐，一个 200MB 的 engine.log 单次 `readText` ≈ 1.3s 纯读 + UTF-8 解码 + 正则全文替换 + 剪贴板拷贝。
- **问题**：三件事叠在一起——
  1. **无上限**：engine.log 有多大就读多大；
  2. **主线程**：同文件 `GuidePageRenderer.kt:575-579` 的注释自己写着「含诊断镜像……**必须离开 UI 线程**，原地调用就是一条真实的 ANR 路径」，而**这条复制路径违背了同文件里已经写下的纪律**；
  3. **已有更好实现没被复用**：`mirrorLogBounded` 就在同一个类体系里。
  - 触发条件是「启动失败 → 引导页 → 用户点『复制日志』」，而这**恰恰**是 engine.log 最可能很大的时刻（崩溃循环 / 反复 spawn 会把输出堆满单代）。
- **预估收益**：未量化（没有设备，无法给「用户点击时的实际主线程阻塞毫秒数」）。可量化的是**风险面的消除**：把「无上限」变成「2MB 上限」，主线程最长阻塞从「随日志线性增长」变成「常数」。参照同仓 `MIRROR_LOG_LIMIT_BYTES` 的取值，改动后单次 ≤2MB 读 + 脱敏 ≈ 数十毫秒量级（推导值）。
- **改动风险**：**低到中**。低在：同仓有现成的有界实现可抄。中在：**用户可见行为变化**——当前是「复制全文」，改为有界后只能是「复制尾部 N MB + 截断标注」。这必须同步改文案（`R.string.ds_log_copied` / `ds_copy_log_empty` 附近），且违反「不做用户可见行为改变」这条本阶段约束，**所以本阶段只记录不实施**。折中方案（推荐给第二阶段）：**保留全文语义但移到后台线程**，主线程只负责最后 `copyTextNative`；这是零可见行为变化的纯架构修正。
- **负控**：源码路径是直接可读的三行调用链（`copyGuideLog` → `readEngineLogFull` → `readText`），无需推断。反证方式也明确：**若这条路径真有上限，全仓 23 个 `MAX_*` 常量里应当有一个被它引用**——实际 grep 结果为 0。同时 `mirrorLogBounded` 的存在证明「有界读」在本仓是已确立的纪律，不是我的外部标准。

### D1-4 SafeMode 的「写后立刻整份重读校验」模式：设计正确，但有 6 处重复读同一份小文件

- **测量方法**：读 `SafeMode.kt:174-176, 182-191, 272-277, 302-330`。
- **基线数值**：`enter()` 一条路径上对**同一批小文件**（`cordis.patch.yml` 2976 B、`profiles/web/package.json` 207 B，尺寸取自 `base/base-dsh.tar.xz` 的条目表）的读取次数：
  - `ensureRecoveryCopy`：`copy.readBytes()` **两次**（一次校验 `sha256`，一次 `contentEquals`，第 174/176 行）
  - `loadBackup`：`primary.readBytes()` + `recovery.readBytes()`（第 182/190 行）
  - `enter` 主体：`packageFile.readBytes()`（286）、`patch.readBytes()`（302）、`backup.readBytes()`（306）、`homePatch.readBytes()` + `homeBackup.readBytes()`（315/317）、`packageBackup.readBytes()`（326）
  - 合计 **≥6 次**对 ≤3KB 文件的整份读。
- **问题**：**量级上这不是问题**——6 × 3KB = 18KB，一次安全模式进入总共几十 KB 的 IO。**但它与 D1-1 是同一种代码形态**（「写后重读校验」在某些路径上变成「写后重读多次」）。此处如实记录为**可读性问题而非性能问题**，并明确：**不建议优化**。源码注释（`SafeMode.kt:180`「Read once, verify the exact bytes that will later be written; never verify then reopen」）已经把纪律写明，实现也基本遵守。
- **预估收益**：≈ 0（<0.1ms 量级）。
- **改动风险**：**高**（不值得）。这是「用户插件永久消失」这类事故的防线（issue #683 / #982 的修复面）。
- **负控**：文件尺寸来自真实 tar 条目表（`tar -tvJf base-dsh.tar.xz` 的 2976 B / 207 B 两行），不是估的。18KB 的结论直接由「6 × 3KB」得出，量级判断不依赖计时。

### D1-5 JS 侧：`NotifyStore` / `NotifyCenter` 已是增量读，`ConfigTransfer` 是唯一的整份文本传递

- **测量方法**：grep `readText|readLines|readBytes|RandomAccessFile` 于 `NotifyStore.kt`（0 命中 readText，3 处 `RandomAccessFile`：145/403/500）；`ConfigTransfer.kt:37/55/57`。
- **基线数值**：
  - `NotifyStore.kt`：**全部走 `RandomAccessFile` + 偏移推进**，并保留了「读后写前追加会丢行」的历史修正注释（第 17 行）。**这是本仓反面例子的正确修法。**
  - `ConfigTransfer.kt:37`：`AtomicFileReplace.writeText(dst, src.readText())`——整份 `settings.yaml` 读成 String 再写。`importFromShared`（第 57 行）则用 `readBytes()` + `writeBytes`（正确形态）。**同一个文件里两种形态并存。**
  - `settings.yaml` 的实际量级：这是用户手改的配置文件，典型 <10KB。量级无关紧要。
- **问题**：`exportToShared` 用 `readText()`/`writeText()` 会做一次「字节 → String → 字节」的往返，在非 UTF-8 内容上还可能失真。**但量级是 KB 级，不构成性能问题**；真正的点是**形态不一致**（同文件里 `importFromShared` 已经是 `readBytes`）。
- **预估收益**：≈ 0（<1ms）。一致性收益为主。
- **改动风险**：**低**（改成 `readBytes`/`writeBytes` 是纯形态统一），但**不值得单独开 PR**——建议搭车到任何碰 `ConfigTransfer.kt` 的改动里。
- **负控**：`NotifyStore` 的 0 命中 `readText` + 3 处 `RandomAccessFile` 是可证伪的静态事实；`ConfigTransfer` 的两行（37 与 57）直接对比即见形态差异。

---

## 4. D2：临时文件残留与清理策略

### D2-1 快照解压峰值：191MB 归档 → 750MB / 44568 文件，同时存在 2 份 = 1.5GB 峰值

- **测量方法**：`Push-Location app/src/main/assets; tar -tvJf snapshot.tar.xz`（全量条目表）→ 汇总 `-` 行的字节列；读 `SnapshotTransaction.kt:21-39, 161, 268-338` 与 `EngineManager.kt:249-310`。
- **基线数值**：
  - 内嵌归档 **200,877,488 B（191.57 MiB）**
  - 解压后：**53,178 条目 / 44,568 普通文件 / 750,434,969 B（715.67 MiB）**
  - 压缩比 **3.74x**
  - 事务目录名：`.snapshot-stage`（解压目标）、`.snapshot-previous`（被置换的旧树）、`.snapshot-stage-orphan-<ts>`（stage 删不掉时改名挪开的残渣）、`.snapshot-transaction`（marker）
  - 峰值：swap 期间 `usr`（新，~750MB）+ `usr-old`（旧，同等量级）**同时存在** ⇒ **1.4–1.5 GB 峰值**
- **问题**：这是全仓最大的磁盘峰值，但**清理策略是完整的**——
  - `SnapshotTransaction.finish()`（268-286）在 `try/finally` 里删 `stage`，且注释明确「marker 的清除**不得依赖另一个组件的容错策略**」（274-277），并记录了真机实测「用户实测 920 MB + .snapshot-stage 176 MB」的残留案例；
  - `reclaimResidue`（293-371）覆盖 `previous` / `stage` / `stage-orphan-<ts>` / `.failed-`；
  - `stage` 删不掉时**改名挪开**（`EngineManager.kt:268-271`，注释说明「改名只需动父目录项，不触碰坏子项，因此比删除更容易成功」），并留下 `stageOrphanStamp` 判据供后续清理。
  - **结论：这不是「只增不减」的目录，是有明确回收路径的事务面。**
- **预估收益**：**不建议优化解压/峰值**。可优化点在别处：见 §5-②（若是构建侧把 200MB 的 xz 注入 APK，则 APK 体积与安装时间都是 1:1 的代价，归 A 块）。
- **改动风险**：**高**。快照事务是 L2 安全敏感面，任何改动都要即时三层。本块只做记录。
- **负控**：750MB / 44568 文件是从**真实归档的完整条目表**汇总的（`tar -tvJf` 53,178 行），不是估算。交叉核对：`base-dsh.tar.xz` 的解压总量是 114,718,099 B——与注入后的 750MB 一致（注入后包含 `usr` + 四个 profile 的 `node_modules`）。

### D2-2 运行时临时目录：`files/home/tmp/dsh-tmp/` 是唯一自管目录，且有完整配额

- **测量方法**：grep `cacheDir|externalCacheDir|getExternalFilesDir|createTempFile` 于生产 Kotlin（23 + 16 命中）；读 `ShotCachePolicy.kt` 全文；`BrowserHost` 的 `createTempFile` 前缀 `browser-shot-`。
- **基线数值**：
  - 截图落点：`files/home/tmp/dsh-tmp/`（**不是** `cache/`，源码注释明说「系统不会把它当缓存回收，所以清理只能由壳侧自己负责（issue #672）」）
  - 配额：**TTL 1 小时 + 最多 32 个 + 总计 128 MiB**（`ShotCachePolicy.kt:22-28`），且 `prunePublished` 在发布后**再列一次目录校验限额**（101-114），超限直接删掉刚写的那张
  - 例外豁免：`preserve` 参数保证「不删刚写下的那张」（因为工具回执要先交给调用方）
  - 清理是 best-effort，任何失败都只跳过、绝不抛（33-34 行注释）
- **问题**：**这个点做对了**，而且是全仓唯一「自己管目录 + 完整配额 + 事后校验」的实现。**建议把 `ShotCachePolicy` 当模板**（见 D1-1 的修法引用它）。
- **预估收益**：0（已是最优形态）。
- **改动风险**：低（不动）。
- **负控**：`ShotCachePolicy` 的三条上限是代码常量（22/25/28 行），`prunePublished` 的二次校验是 101-114 行的实际代码，不是文档承诺。

### D2-3 与开发侧 `.deploy-tmp` 的对照：产品侧没有同类失控点，但**有一个失控点被漏在 D1-1**

- **测量方法**：`Get-ChildItem D:\...\dsh-mobile-apk\.deploy-tmp -Recurse -File | Measure-Object Length -Sum`；对照 `scripts/clean-deploy-tmp.mjs` 的判定口径。
- **基线数值**：
  - 开发侧 `.deploy-tmp`：**30,875 文件 / 4,966,032,870 B（4.63 GiB）**，其中单目录最大 `task16` = 1,414,410,629 B / 3,726 文件，`pr-landing` = 848,974,168 B / 10,374 文件
  - 产品侧运行时按「有界性」逐项核对（§2.3 的 23 个尺寸常量 + §D2 的清理路径）：`engine.log`（5 代）、`dsh-<date>.log`（5MB 轮转）、`notify-responder.log`（128KB 轮转）、`notify-debug.log`（512KB 轮转）、截图（TTL+配额）、boot-diag/boot-fail（64/128KB）、lease-clear（8KB 先清后写）、`WorkSpacePickGate`（8 个 sweep 上限）、`LogShare`（单条 2MB / 总量 12MB）、`RepairTools`（读 256KB / 写 512KB / 备份 16MB）、`ProcIo`（1MB）、`Shizuku`（512MB）、`DownloadSaver`/`FileIncoming`（200MB）——**全部有界**
  - **唯一例外：`audit.ndjson`（D1-1）**
- **问题**：产品侧**没有**`.deploy-tmp` 那种「只增不减」的目录（这一点值得肯定，说明「有界写」在本仓是成体系的）。**但体系里漏了一个落点**，而漏的恰好是审计文件——一个「越久越重要、越不该丢」的文件，这与「有界」的策略取向天然冲突，所以当初大概是有意跳过的。**建议：不是简单地加轮转，而是加「归档 + 上限」**（例如 `.ndjson` 超过 N MB 就 rename 成带时间戳的归档并保留 K 份），既保住取证面又给上限。
- **预估收益**：把「无界」变成「可预期上限」。具体数字取决于 N/K 取值，未量化。
- **改动风险**：**中**。审计是 L2 面；轮转策略本身会影响取证完整性（这也是为什么不能简单照抄 day-log 的「超限就滚掉」）。
- **负控**：4.63 GiB / 30,875 文件是直接 `Measure-Object` 出来的。产品侧的「全部有界」结论是**逐个文件核对 23 个常量与对应写入点**得出，不是抽样——若有一条无界而我没列出，本表就自相矛盾。

---

## 5. D3：度量工具链与可复现基线

### D3-1 门禁基线的真实分布：19 绿 / 11 绿但 SKIP / 2 依赖缺席 / 9 红，**9 红无一为代码缺陷**（6 条缺构建产物/单测，3 条缺位置参数 tar）

- **测量方法**：`node scripts/perf-audit-d/gates-baseline.mjs --json .deploy-tmp/perf-audit-d/gates-baseline.json`（逐条 spawn，不从流中断言）；每条红的再单独跑一次看输出。
- **基线数值**：共 41 条（声明 42 条，`check-profile-undici-resolution.mjs` 因 `--list` 表格排布被我的解析器漏掉，已单独手跑：`SKIPPED` exit 0）。**总耗时 216,520 ms。**

  9 条 RED 的逐条真因（**没有一条是代码缺陷**）：

  | 门禁 | 退出码 | 真因 |
  |---|---:|---|
  | `check-protocol-v2.mjs` | 1 | `plugins/dsh-android-manage/lib/protocol-v2.js` 缺席（净检出未构建） |
  | `check-tool-surface-budget.mjs` | 1 | `plugins/dsh-android-bridge/lib/index.js` 未导出 `apply()`（同上，lib 缺席） |
  | `check-tool-output-schema.mjs` | 2 | 缺 peer 依赖 `@deepseek-ai/dsh-tools`（净检出无 `node_modules`） |
  | `check-browser-syntax-floor.mjs` | 2 | `typescript` 缺席（6 条候选路径全未命中） |
  | `check-plugin-tests.mjs` | 2 | 插件 `lib/` 未构建 |
  | `check-kotlin-test-count.mjs` | 1 | 缺 `app/build/test-results/testDebugUnitTest`（没跑过单测） |
  | `check-snapshot-secrets.mjs` | — | **需要位置参数 tar**，裸跑只打用法行 |
  | `check-inject-completeness.mjs` | — | 同上 |
  | `check-strip-noop.mjs` | — | 同上 |

  其中 3 条「裸跑却只在等位置参数」的，我给 `gates-baseline.mjs` 加了 `--injected` 通道（指向主工作区的注入产物，**191MB 没有复制进工作区**），重跑结果见 D3-3。
- **问题**：**当前 worktree 的门禁基线不具备「回归判据」能力**。第二阶段改代码后跑同一套，会看到同样的 9 红——但那 9 红跟改动无关。若不做区分，就会出现两种坏结果：① 把 9 红当噪声忽略，于是真的弄坏了也看不见；② 为了让它变绿去改判据，那是「改判据来借绿」，明令禁止。
  - **正确用法**：把本表当作**对照基线**——第二阶段应当看到「这 9 条仍是同样 9 条、同样真因」，而 GREEN 集合是**只能变大不能变小**的集合。
- **预估收益**：不适用（这是基线而非优化项）。但它决定了第二阶段能不能证明「没弄坏」。
- **改动风险**：低（只是记账）。若要真绿，需要建插件产物（`cd plugins/<x> && npm run build`）+ 装 peer 依赖，**属一次性环境动作，不是代码改动**。
- **负控**：每条红都单独跑了一次并贴出真因原文（见上表「真因」列）。**「9 红全是环境缺口」这个结论是可证伪的**：只要有一条的真因不是「缺产物/缺依赖/缺位置参数」，本结论即失效。实际逐条核对结果：全部命中三类。

### D3-2 门禁质量评估：SKIP 纪律做得好，**但有两处「用常量在场当判据」的脆弱点**

- **测量方法**：读 `check-gate-skips.mjs:1-90`（约 30 行头注释讲清了它自己的重做史）；读 `check-engine-heap-floor.mjs:11-21`；读 `check-snapshot-secrets.mjs:10-12, 342-348`；读 `check-release-gates.mjs:800-853`（耗时记账段）。
- **基线数值**：
  - **SKIP 审计是真做实了的**。`check-gate-skips.mjs` 的头注释（16-32 行）记录了旧实现的三类失败：「纯文本审计」在 8 个夹具里 **7 个隐形或误记**；修法是「把每个门禁当子进程真跑一遍，用 `--require` 预载的探针 hook 包住 `process.stdout.write`/`stderr.write` 抓**实际发射**的 SKIP 行」。**这是本仓门禁质量的天花板，值得作为其它门禁的模板。**
  - **「不得以 SKIP 结案」有强制档**：`--require` 档下 SKIP 即判红（`check-snapshot-secrets.mjs:346-347`、`check-gate-skips.mjs` 的 `SKIP_LINE_EXEMPT` 带 `reason + until + 到期检查`）。
  - **没有「恒为 SKIP 所以永远绿」**：`check-dead-tokens.mjs` 在缺上游树时 **exit 2 并打印 `NO-CRITERIA 本次没有执行任何判据`**——这一点它做对了（明确区分「没验」与「验过且绿」）。
  - **耗时记账已内建**：`check-release-gates.mjs:800-853` 逐门禁记 `ms` + `outBytes` 并落 JSON，注释明确「不设耗时阈值：阈值会把慢机器变成假红」+「耗时/产出比才是优化的判据」——这个口径与本次审计的度量纪律一致。
- **问题（两处脆弱点）**：
  1. **`check-engine-heap-floor.mjs` 的核心判据 C 是「两个源的数字逐值相等」**，而这两个源一个是 `EngineManager.kt` 的常量、一个是 `build-snapshot-013.mjs` 里嵌的 shell 字符串。这是**文本在场型判据**：两边同时漂移到同一个错值，门禁仍然绿。它守不住「这个值本身对不对」。
  2. **`check-kotlin-test-count.mjs` 依赖上一次单测的产物**（`app/build/test-results/testDebugUnitTest`）。净检出上它必然红（见 D3-1），而在构建链里它由 `:app:testDebugUnitTest` 前置保证（`check-release-gates.mjs` 的 `evaluateBuildCanonicalPolicy` 断言这条前置存在）。**这是一个「顺序耦合」的判据**：单独跑它没有意义，而它自己不知道这件事（红得和真失败一模一样）。
- **预估收益**：不适用。
- **改动风险**：把 ① 改成「常量 + 一次真实读取对照」是 **L1 门禁改动**（需 `--self-test` + 一条受控负控）；② 建议在输出里加一行 `NOTE 本判据依赖 :app:testDebugUnitTest 的产物，单独跑必然红`，属纯可读性。两者都**不建议在本阶段做**。
- **负控**：① 的「文本在场型」判定是可证伪的——把两处常量改成同一个错值（例如都改成 999），门禁应仍然 PASS；这正是它的失效形态。② 的「顺序耦合」由 `app/build/test-results` 目录的缺失直接证明（RED 输出里贴了完整路径）。

### D3-3 两个**位级证据**：真实注入产物上有两条门禁判红

- **测量方法**：`node scripts/perf-audit-d/gates-baseline.mjs --only check-snapshot-secrets.mjs,check-inject-completeness.mjs,check-strip-noop.mjs --injected D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets\snapshot.tar.xz`（对主工作区的真实注入产物跑，不在工作区复制）。
- **基线数值**：

  | 门禁 | 耗时 | 结论 | 真因 |
  |---|---:|---|---|
  | `check-snapshot-secrets.mjs` | 116,355 ms | **RED** | `FAIL[private-key-file]: usr/share/cmake-4.4/Templates/Windows/Windows_TemporaryKey.pfx` |
  | `check-inject-completeness.mjs` | 40,542 ms | **RED** | `FAIL web 成员集合一致: @dsh-android/dsh-shell-termux（1 项） -> 多 2 项: [lib/index.js, lib/types/index.d.ts]` |
  | `check-strip-noop.mjs` | 20,042 ms | GREEN | — |

- **问题**：这两条**必须由 Lead 分派给对应块**（占位归属见下），我给出的是可复现的判定，不是解释：
  - `Windows_TemporaryKey.pfx`：我把它取出来核过字节——**2,560 B，头部 `30 82 09 fc 02 01 03 30 82 09 b8 06 09 2a 86 48`**，即 ASN.1 SEQUENCE (`30 82 09fc` = 2556 B) + PKCS#12 `PFX` 的 `version 3` (`02 01 03`) + OID `1.2.840.113549.1.7`（`pkcs7-data`）——**这是一个真实的 PKCS#12 容器，且是 cmake 自带的模板文件**（cmake 用它给 Windows 应用打包做默认签名）。它不是凭据泄漏（公开模板、密码为空），但它是**每一个 APK 里都躺着的一份真实密钥容器格式文件**。门禁按「路径即证据，内容无关」判红（`check-snapshot-secrets.mjs:330` 的 `.*\.(?:p12|pfx)$` 判据）。**判据本身没问题，是这个文件不该进发行快照。**
  - `dsh-shell-termux` 成员多 2 项：注入器只携带 `package.json + lib/**`，而注入产物里出现了 `lib/index.js` 与 `lib/types/index.d.ts`……**注意这里的具体语义是「多 2 项被判定为幽灵面/未登记面」**，而 `lib/**` 本应在允许面上。这条需要 `check-inject-completeness.mjs` 的规则细节 + 注入器实现来定论，**我把它作为待判事项交给负责构建链的 A 块，不在此下结论**。
- **预估收益**：若 `pfx` 可剔除，单文件 **2,560 B**（对 200MB 的归档可忽略）；**真正价值是「发行快照里不该有真实密钥容器」这条判据被满足了**。`inject-completeness` 的收益同样是判据面而非体积面。
- **改动风险**：**中**。剔除 `usr/share/cmake-4.4/Templates/Windows/*` 属于**修改快照内容**，可能影响需要 cmake 的场景（有用户会在 Termux 里跑 cmake 生成 Windows 工程吗？大概率不会，但这是行为面判断，不是我能单方面拍的）。剔除后必须重跑 `check-snapshot-secrets` + `check-strip-noop` + `check-inject-completeness`。
- **负控**：`check-snapshot-secrets.mjs --self-test` 跑过，**26 项全 PASS**（含「真密钥 `sk-live-123456` 仍命中」「`persist-credentials: false` 不命中」的正反两向）——说明这个判据不是「一律不命中」的坏判据。同时我核了该 `pfx` 在 `base/base-usr-arm64.tar.xz` 里**也**存在（`tar -tJf` 命中 exit 0），说明它是基座带进来的，不是本次注入引入的。

### D3-4 `measure.mjs`：一条命令的基线入口（本块最重要交付物）

- **测量方法**：`node scripts/perf-audit-d/measure.mjs --artifacts <产物根> --json <out> --with-gates --timing-rounds 5`
- **它产出什么**（全部见 §2）：产物体积（7 项，缺席记为 `absent` 不编造）、APK zip 中央目录构成（7 个桶 + Top-15 条目 + stored 条数/字节）、静态计数（Kotlin 文件/字节、`check-*.mjs` 数、7 类 IO 命中点、有界分配数、尺寸常量数、无界比）、一条计时（快照 SHA-256 流式全量，n 次中位数+min/max）、门禁汇总（`--with-gates` 时读 `gates-baseline.json`）。
- **为什么要自己解析 zip 中央目录**：不引依赖（约束 3）。实测能正确读出 APK 的 239 条目，含 zip64 兜底分支（本 APK 未触发，走标准 EOCD）。
- **局限（必须写明，别让第二阶段误读）**：
  - 计时那条是**宿主侧**，不是设备侧；绝对值不可迁移，只用于同机前后对比。n=5 的 min/max 跨度 **13%**（1244.8↔1412.1）就是本环境下**任何小于 13% 的「优化」都不可信**的量化界限。
  - 「无界比 0.645」只是趋势指标，不是判据（见 §2.3 脚注）。
  - 门禁汇总里的 RED **不代表代码坏**（见 D3-1）。
- **预估收益**：不适用。
- **改动风险**：不适用（只读脚本，不碰产品代码）。
- **负控**：APK 解析结果有独立对账——7 个桶的 `compBytes` 之和 = **163,087,089 B**，与 `statSync(apk).size` = **163,133,182 B** 差 **46,093 B**（0.028%），差额即「中央目录 + 本地头 + EOCD 的容器开销」。**如果解析器算错了桶，这个差额会明显偏离容器开销的量级**——239 个条目摊下来 46,093 B ≈ 193 B/条目，正好是中央目录记录（46 B 固定 + 文件名 + extra）+ 本地头（30 B + 文件名）的合理量级，说明桶划分与尺寸读取是对的。

---

## 6. D4：并发 / 唤醒相关的磁盘负载

### D4-1 周期性磁盘活动：默认配置下**零常驻写盘**，唯一的周期动作是 20 秒一次 4KB 的**只读**探活

- **测量方法**：grep `postDelayed|scheduleAtFixedRate|scheduleWithFixedDelay|Timer(` 于生产 Kotlin（70 命中）并逐个判定「是否写盘 / 是否默认开启」；读 `EngineService.kt:65,214,302,437`、`LogCollector.kt:29,36-41,962-974`、`WatchdogV2.kt:48-56,105,702-720,609-632`、`ControlPoller.kt:107-159`、`NotifyProbe.kt:22-46`。
- **基线数值**（按「默认安装」配置）：

  | 来源 | 间隔 | 默认开启 | 是否写盘 | 每拍字节 |
  |---|---:|---|---|---:|
  | `WatchdogV2` 探活拍 | **HEALTHY 20s / ACTIVE 5s** | 是 | **否**（只读 `engine.log` 尾部 `LOG_TAIL_BYTES = 4096`） | 0 写 |
  | `WatchdogV2.consumeTaskDoneMarkers` 调试日志 | 每拍 | **否**（`DevLogPrefs` 门控，默认关） | 是（开启后） | ~60 B/行 × 2-4 行 |
  | `LogCollector.tick` | **5s** | **否**（`DevLogPrefs.isEnabled` 门控，默认关） | 是（开启后，`appendToDayFile`） | logcat + `engine.log` 增量（≤256KB/次读） |
  | `ControlPoller` 长轮询 | **LONG_POLL_MS**（阻塞式，非忙轮） | 是（无障碍通道开启时） | 否 | 0 |
  | `ControlPoller` 心跳线程 | 5s（0.14.10 §6.5 由 2s 降为 5s） | 同上 | 否 | 0 |
  | `NotifyProbe.log` | 事件驱动（非周期） | 是 | 是 | ≤128KB 轮转 |
  | `NotifyStore` | 事件驱动，`RandomAccessFile` 偏移推进 | 是 | 仅消费时推进偏移 | 0（只读增量） |
  | `ShotCachePolicy` | 每次截图 | 是 | 清理 | 有配额 |
  | `CheckUpdate` / `DEATH_MIRROR` | 10 分钟 | 是 | 条件写 | 小 |

  **默认安装下的常驻周期写盘 = 0 处。** 唯一周期性的常驻动作是看门狗 20s 一次 `engine.log` 尾部 4KB **读**（`RandomAccessFile.seek` + 读 4096 B），加上 `NotifyStore` 的增量消费。

- **问题**：**这一块整体是健康的**，尤其是两处明显的历史修复痕迹值得记下来：
  1. `LogCollector.log` 从同步 `appendText` 改成 `logExecutor`（单线程 daemon）异步写（`LogCollector.kt:36-41`，注释写明「`log()` 曾同步 appendText——FileIncoming 来件管线与 MainActivity 通知链都在主线程调它，磁盘慢时直接卡首帧」）。**这是本仓「UI 线程写文件」问题已经被解决过的证据。**
  2. `WatchdogV2` 的看门狗拍从固定 5s 的 `scheduleWithFixedDelay` 改成「单次延迟重排 + 按状态自适应」（`EngineService.kt:214,302,437`），健康态 20s。
  - **剩下的真实问题**是 D1-3（主线程整文件读，不是写）和 D1-1（无界增长，不是频率）。
- **预估收益**：不适用（已经是对的）。
- **改动风险**：不适用。
- **负控**：「默认 0 处周期写盘」的关键依赖是 `DevLogPrefs` 默认值。可从 `MainActivity.kt:2258` 的 `object DevLogPrefs` 读到默认值，且 `WatchdogMarkerDebugGateTest.kt:26,100-101` 与 `DeferredEngineStartTest.kt:234` 两个单测**都在断言这条门控**（「默认配置（DevLogPrefs 关）下必须完全不写调试日志」「必须复用 MainActivity.DevLogPrefs，不得另造一套偏好」）。**若我这条读错了，那两个单测会红。**

### D4-2 UI 线程写文件：除 D1-3 外没有第二处

- **测量方法**：逐个核对 `appendText|writeText` 的调用点是否在 UI 线程上下文（点击监听器 / `runOnUiThread` / `postDelayed` 于 main looper）。
- **基线数值**：
  - `LogCollector.log` → 异步（D4-1）
  - `NotifyProbe.log` → `@Synchronized`，调用方均在事件链（非周期），量小
  - `ControlAudit.log` → 在 `ShellOps.audit()`（特权命令回调线程，非 UI）
  - `GuidePageRenderer.copyGuideLog` → **主线程，且是整文件读**（D1-3）
  - `EngineStartFlow.kt:1470` 的注释明确写着「**必须离开 UI 线程**：本方法由 `GuidePageRenderer.enterSafeMode` 的 `postDelayed` 在**主线程**上调用」——同仓已经有这条纪律的先例。
- **问题**：**唯一命中就是 D1-3**，且它的问题在读+脱敏，不在写。此处不重复计数。
- **预估收益 / 改动风险 / 负控**：并入 D1-3。

---

## 7. Top-N 排序（按 收益/风险 比）

| # | 结论 | 预估收益量级 | 改动风险 | 工作量 | 收益/风险 |
|---|---|---|---|---|---|
| 1 | **D1-1 `audit.ndjson`：常驻句柄 + 与插件侧对齐的有界轮转** | 单条 IO -91%（274→25 us，11.2x 负控确证）；**消除唯一无界状态文件**（年 ~106MB @1000 条/天，推导值） | 低（形态改动）；**中**（L2 取证面，需即时三层或等价负控） | **S** | **最高** |
| 2 | **D1-3 复制日志移出主线程**（保留全文语义，后台读+脱敏，主线程只做剪贴板） | 未量化；**消除一条无上限的 ANR 路径**（engine.log 无大小上限） | 低（零用户可见行为变化） | **S** | **高** |
| 3 | **D3-1 门禁基线建档 + 第二阶段用「9 红同真因、GREEN 只增不减」当回归判据** | 不直接省时；**是第二阶段「没弄坏」的唯一可证伪判据** | 无（只记账） | **S** | **高** |
| 4 | **D3-3 剔除 `usr/share/cmake-4.4/Templates/Windows/`（含真实 PKCS#12 容器）** | 体积 2,560 B（可忽略）；**满足「发行快照不含密钥容器」判据** | 中（改快照内容，需重跑 3 条门禁） | **S** | 中 |
| 5 | **D3-3 `dsh-shell-termux` 成员多 2 项（inject-completeness RED）** | 未量化；对齐注入器与注入产物 | 中（需先定论规则语义，交 A 块） | **M** | 中 |
| 6 | **D1-3 附带的「复制日志」有界化**（尾部 2MB + 截断标注） | 未量化；主线程阻塞从线性变常数 | 中（**用户可见行为变化**，本阶段禁止） | **S** | 中低（第二阶段再做） |
| 7 | **D2-3 `audit.ndjson` 改为「归档 + 上限」而非简单轮转** | 保住取证面 + 给上限 | 中（轮转策略影响取证完整性） | **M** | 中 |
| 8 | **D4-1 现状已健康**（默认 0 处周期写盘） | — | — | — | 无需动作 |
| 9 | **D1-2 快照摘要预检**（200.88MB / 1.3s 宿主） | **≈0，明确不建议动** | 高 | — | **不动** |
| 10 | **D1-4 SafeMode 6 次小文件重读**（18KB） | **≈0，明确不建议动** | 高（事故防线） | — | **不动** |

**排序口径说明**：收益/风险比是「每单位改动风险换到的确定收益」。第 1、2 条都是 S 级工作量 + 低风险 + 确定的收益方向，因此排在前面；第 9、10 条明确标注「不动」——把「不值得优化」写成结论，比留白更有价值（当前 D3-1 的教训就是「没跑到」被当成了「绿」）。

---

## 8. 交叉发现（不归本块，交给对应块）

| # | 发现 | 归属 | 证据 |
|---|---|---|---|
| ① | **`out/v0.14.9/` 的 APK 内嵌的是 157,861,552 B 的旧快照，而当前 `assets/snapshot.tar.xz` 是 200,877,488 B**。拿该 APK 当体积基线会**低估约 43MB**（APK 预计 ≈206MB 而非 156MB）。 | **A 块（构建链/体积）** | `measure.mjs` 的 zip 中央目录读数 vs `statSync(assets/snapshot.tar.xz)`；两者差 43,015,936 B |
| ② | 内嵌归档 200.88MB → 解压 750.43MB / 44,568 文件，压缩比 3.74x；APK 里它以 **stored（method=0）** 存在，占 APK **96.77%**。任何「换更好的压缩 / 减小快照」的结论都直接等同于 APK 体积结论。 | **A 块** | §2.2 + §4 D2-1 |
| ③ | `check-gate-skips.mjs` 单条 **174,660 ms**，占全量门禁墙钟 216,520 ms 的 **80.7%**，产出仅 3,007 B。它是构建链耗时分解里的头号支配项。 | **A 块** | §2.5 |
| ④ | 启动路径上一笔**固定**成本：内嵌快照全量 SHA-256 预检（200.88MB，宿主 median 1304.3ms / 146.9 MB/s）。**它只在快照刷新时付，不是每次冷启动都付**——C 块算冷启动时请不要重复计入。 | **C 块（冷启动/内存）** | §3 D1-2 + `EngineManager.kt:152-163`（`snapshotFresh()` 已做短路） |
| ⑤ | `LogCollector.log` 已从同步 `appendText` 改为 `logExecutor` 异步（历史 UI 卡帧问题已修）；`WatchdogV2` 已从固定 5s 改为自适应（HEALTHY 20s / ACTIVE 5s）。**这两处若在 B/C 块被当作现存问题，请复核。** | **B / C 块** | `LogCollector.kt:36-41`、`EngineService.kt:214,302,437`、`WatchdogV2.kt:48-56` |
| ⑥ | 默认安装下 `DevLogPrefs` 为关，因此 `dsh-day.log` **恒 absent**（`LogCollector.start` 被门控）。依赖 day-log 做设备实测的验收设计（如 boot-segments 落点）在默认配置下拿不到数据。 | **C 块 / 验收设计** | `EngineService.kt:65`、`MainActivity.kt:590`、`LogCollector.kt:18-20` |
| ⑦ | `ShotCachePolicy`（TTL 1h + 32 个 + 128MiB + 发布后二次校验）是**全仓最完整的自管目录配额实现**，可作为其它无界落点的模板。 | **B 块（图像/缓存）** | `ShotCachePolicy.kt:22-28, 101-114` |

---

## 9. 本块的已知局限（不掩饰）

1. **没有任何设备实测**。所有「毫秒」都是宿主侧的，绝对数值不可迁移到设备。可迁移的只有：字节级读数、代码路径事实、以及**同机相对比较**。
2. **计时只有一条**（快照 SHA-256）。这是刻意的：在 13% 抖动的宿主上，多测几条只会产出更多不可信的数字。字节级证据承担了主要论证负担。
3. **D1-3 的「主线程阻塞多久」未量化**——需要设备。但「无上限 + 主线程」这两件事本身是静态可证的，不依赖时长。
4. **D3-1 的红绿分布只对「当前这个净检出 worktree」成立**。建好插件产物后会变。
5. **`check-inject-completeness` 那条 RED 我没有下结论**（只给了判定与原文）。规则语义需要读注入器实现 + 门禁规则，那是 A 块的范围。
6. **`check-gate-skips` 与 `check-snapshot-secrets` 的耗时（174.7s / 116.4s）是在多 agent 并发下测的绝对墙钟**，只能用于「谁是大头」的相对判断，不能用于「优化了多少秒」的结论。

---

## 10. 附录：本报告的完整复现命令清单

```powershell
# 工作目录
cd D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\perf-audit

# ── 基线读数（一条命令，§2 的全部数字）──────────────────────────────────
node scripts/perf-audit-d/measure.mjs `
  --artifacts D:\coding\dsh-mobile\dsh-mobile-apk `
  --json .deploy-tmp\perf-audit-d\baseline.json `
  --with-gates --timing-rounds 5

# ── 逐门禁基线（§2.5 / §5 D3-1）─────────────────────────────────────────
node scripts/perf-audit-d/gates-baseline.mjs `
  --json .deploy-tmp\perf-audit-d\gates-baseline.json

# ── 三条需要位置参数 tar 的门禁（§5 D3-3；指向主工作区，不复制）───────
node scripts/perf-audit-d/gates-baseline.mjs `
  --only check-snapshot-secrets.mjs,check-inject-completeness.mjs,check-strip-noop.mjs `
  --injected D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets\snapshot.tar.xz `
  --json .deploy-tmp\perf-audit-d\gates-tar.json

# ── D1-1 负控微基准（三种追加形态对照）───────────────────────────────────
node scripts/perf-audit-d/audit-append-io.mjs --records 2000 `
  --json .deploy-tmp\perf-audit-d\audit-io.json

# ── D2-1 解压体积统计（注意：msys tar 不认 Windows 绝对路径，须相对）────
Push-Location D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets
tar -tvJf 'snapshot.tar.xz' *> <worktree>\.deploy-tmp\perf-audit-d\injected-list.txt
Pop-Location

# ── D3-3 取出 pfx 核字节（2,560 B，PKCS#12 头）────────────────────────────
Push-Location D:\coding\dsh-mobile\dsh-mobile-apk\app\src\main\assets
tar -xJf 'snapshot.tar.xz' -C <worktree>\.deploy-tmp\perf-audit-d\pfx `
  'usr/share/cmake-4.4/Templates/Windows/Windows_TemporaryKey.pfx'
Pop-Location

# ── D3-2 门禁自证（证明快照机密判据不是坏判据）──────────────────────────
node scripts/check-snapshot-secrets.mjs --self-test

# ── D2-3 开发侧 .deploy-tmp 对照 ────────────────────────────────────────
Get-ChildItem D:\coding\dsh-mobile\dsh-mobile-apk\.deploy-tmp -Recurse -File |
  Measure-Object Length -Sum     # 30,875 文件 / 4,966,032,870 B
```

**落盘产物**（均在 `.deploy-tmp/perf-audit-d/`，不入 git）：

| 文件 | 内容 |
|---|---|
| `baseline.json` | `measure.mjs` 全量读数（§2） |
| `gates-baseline.json` | 41 条门禁逐条状态 + 耗时（§2.5） |
| `gates-tar.json` | 3 条 tar 门禁的真实判定（§5 D3-3） |
| `audit-io.json` | 追加形态微基准三对照（§3 D1-1） |
| `gate-run.log` | 聚合入口 `--run` 的中止现场（§1.3 坑位证据） |
| `injected-list.txt` | 注入后快照的 53,178 行完整条目表（§4 D2-1） |
