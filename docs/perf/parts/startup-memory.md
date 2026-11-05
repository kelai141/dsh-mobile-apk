# C 块审计报告：冷启动静态路径 + 引擎/壳进程内存驻留

- 审计日期：2026-11-02
- 工作区：`D:\coding\dsh-mobile\dsh-mobile-apk\_dsh-wt\perf-audit`（worktree，分支 `perf/audit-2026-11-02`，基线 `47869404`）
- 设备：**无**。全部结论来自静态代码路径推导 + 构建产物字节 + 宿主侧可复现微基准 + 仓库内已有设备实测数据。
- 辅助脚本：`scripts/perf-audit-c/`（bench-extract.ps1 / bench-ladder.ps1 / jvm/ExtractBench.java）
- 原始读数：`scripts/perf-audit-c/out/*.txt`（报告引用的每个数字都在这五个文件里）

## 度量口径免责（先读，否则会误用本文的数字）

1. **宿主并发负载**：本轮同机还有 3 个审计 agent 在跑 CPU 密集任务。所有宿主计时读数的**绝对值偏高**，只用于**相对比较**（同一份输入、同一段循环、A 变体 vs B 变体的差分）。
2. **宿主 != 手机**：宿主是 x86_64 JVM 17 + **NTFS** + 桌面 SSD；Android 是移动 SoC + **f2fs/ext4** + UFS。本报告只在两处使用宿主绝对值：(a) 纯 CPU 的 xz 解码吞吐（同为单线程 LZMA 实现，量级可比）；(b) 逐文件 syscall 的**差分方向**（同构但设备更慢）。**凡是「设备上的真实秒数」一律写「不可测 + 原因」，绝不拿宿主数字冒充**（见附 B）。
3. 有一条宿主产物**明确不可搬用**并已单独标注：`File.getCanonicalPath()` 在 Windows 上约 2.5 ms/次，在 Linux/Android（`realpath(3)`）上便宜一到两个数量级。见 **C-15**。

---

# 第一部分：冷启动关键路径的静态拆解（C1）

## 0. 一张图说清冷启动全链

```
MainActivity.onCreate（主线程，同步）           ← C-02 / C-03 / C-04
  ├─ StartupPrefsNormalizer.resetOnUpgrade      1 stat + 2 次 SharedPreferences 解析
  ├─ photoCaptureController.restoreNow()        1 次 isFile
  ├─ installCrashMarker()                       装全局 UncaughtExceptionHandler
  ├─ FileIncoming.sweepExpired(this)            ★ 主线程目录遍历 + N 次 JSON 解析（C-03）
  ├─ noteNotificationPermissionState()
  ├─ WebView(this) 构造                         ★ 首个 WebView（C-04）
  ├─ guideRenderer.buildGuideView()             构建引导页视图树
  ├─ provisionPublicRepoAndRefreshChip()        同步读 status；随后自己起后台线程
  ├─ BrowserHost(this,...)                      仅老 WebView 设备 bindService（C-04）
  ├─ VdisplayHost / VdisplayFloat
  ├─ configureWebView() + addJavascriptInterface
  └─ startEngineFlow() → EngineStartFlow.start()   起 worker 线程（非主线程）
        │
        └─ Thread "engine-start"（后台，串行，全程阻塞）
             ├─ ShizukuTransport.prepareStartupOwnership   root/Shizuku 面，可达数秒
             ├─ startupRecoverThenProbe
             │    ├─ recoverInterruptedRefresh()   读 marker；常态 1 次 stat
             │    └─ probeAvailability()           HTTP 探活（connect/read 各 800ms）
             ├─ snapshotFresh()                   读指纹文件 + stat node
             ├─ [仅在陈旧时] refreshSnapshot()    ★★ 解压 191MiB→716MiB（C-05/C-06）
             └─ startEngine()（spawn node）
                  ├─ prelude 6 步（repair/retire/profile/provision/migrate/patches）
                  └─ spawn → Thread.sleep(200)
             └─ 轮询 EngineProbe.check() 每 1000ms，预算 90s（C-07）
                  └─ 成功 → markFirstHttp() → showWeb()
```

## 1.1 关键常量（全部来自源码，非估计）

| 常量 | 值 | 位置 |
|---|---|---|
| `ENGINE_BOOT_BUDGET_MS` | 90_000 | EngineStartFlow.kt:2195 |
| `ENGINE_BOOT_POLL_STEP_MS` | 1_000 | EngineStartFlow.kt:2198 |
| `START_COOLDOWN_MS` | 90_000 | EngineManager.kt:2668 |
| `LISTEN_WATCH_WINDOW_MS` | 90_000 | EngineManager.kt:3191 |
| `WEB_REVEAL_FALLBACK_MS` | 1_200 | MainActivity.kt:249 |
| `SPLASH_TIMEOUT_MS` | 90_000 | MainActivity.kt:253 |
| `VDISPLAY_REAP_INTERVAL_MS` | 120_000 | MainActivity.kt:266 |
| `ENGINE_HEAP_FLOOR_MB` / `CAP_MB` | 512 / 4096 | EngineManager.kt:2805 / 2820 |
| `SnapshotExtractor.Limits` | 240k 条目 / 8 GiB / 单文件 2 GiB | SnapshotExtractor.kt:111-120 |
| engine.log 增量读上限 | 256 KiB | LogCollector.kt:31 |
| `MAX_FILE_BYTES`（日日志） | 5 MiB | LogCollector.kt:30 |
| 解压写缓冲 | 64 KiB | SnapshotExtractor.kt:235 |
| 摘要预检缓冲 | 64 KiB | SnapshotExtractor.kt:45 |
| `MAX_VIRTUAL_DISPLAYS` | 1 | VdisplayController.kt:40 |
| `MAX_TABS` | 8（每会话） | BrowserHost.kt:80 |
| `IDLE_RECLAIM_MS`（虚拟屏） | 600_000 | VdisplayController.kt:92 |

---

# 第二部分：逐条发现（15 条）

> 编号 C-01..C-15。C-15 排在 C-09 之后是因为它是在写完内存那节之后、作为 C-05 的负控补测出来的，刻意保留在原位以免与 C-05 的归因梯脱节。

## 2.1 启动路径

### C-01 冷启动帧里**没有**同步解压：解压只在快照不新鲜时付，「首装/升级」与「日常冷启」是两类完全不同的启动

- **测量方法**: 读 `EngineStartFlow.start()` 全文（EngineStartFlow.kt:567-1130）+ `EngineManager.snapshotFresh()`（EngineManager.kt:152-163）+ `refreshSnapshot`（EngineManager.kt:188-425）。
- **基线数值**:
  - `snapshotFresh()` 的常态成本 = 1 次 `readText`（`.snapshot-fingerprint`，64 hex 字符）+ 1 次 `nodeBin.exists()`（`stat`）。
  - 解压路径 `SnapshotExtractor.extract` 只在 `if (!snapshotFresh())` 分支里（EngineStartFlow.kt:758）。
  - 解压本身跑在 `Thread("engine-start")` 后台线程上（EngineStartFlow.kt:1129 `caller.start()`），**不阻塞首帧**。
- **问题**: 被反复讨论的「191MB xz 解压」**不在日常启动里**。它只在三种情况下发生：① 首次安装；② 覆盖安装（内嵌指纹变）；③ 运行时树被外部改坏（`invalidateSnapshotFreshness`）。把它当成「每次启动都要付」会算错 100% 的量级。反过来，**在这三种情况里它确实是唯一的支配项**（19-28 s CPU，见 C-05/C-06），而日常冷启动的快照相关成本只有 5-8 次文件系统调用（见第三部分末）。
- **预估收益**: 不适用——这是**口径纠正**不是优化项。它的价值是让第二阶段不要浪费时间在「日常冷启动优化解压」这个不存在的目标上。
- **改动风险**: 无（纯测量结论）。
- **负控**: 三个入口的判定条件都可逐字核对：`EngineManager.kt:253`（recover 后过早退一次）、`EngineManager.kt:758`（唯一进解压的入口）、`EngineManager.kt:152`（fresh 判据本身）。若解压在常态冷启上，则 `snapshotFresh()` 为 true 时也必须解压——代码里没有这条路径。

### C-02 onCreate 主线程被串行 IO 占据：6 处同步文件系统调用，其中 1 处是目录遍历

- **测量方法**: 逐行读 `MainActivity.onCreate`（MainActivity.kt:549-728），对每个调用点追到实现，判断是否触碰文件系统。
- **基线数值**（全部在主线程，`setContentView` 之前或紧随其后）:

| 调用点 | 行 | 触碰的 IO | 量级 |
|---|---|---|---|
| `StartupPrefsNormalizer.resetOnUpgrade` | 560 | `marker.exists()` + 2× `getSharedPreferences` | 1 stat + 2 次 prefs XML 解析 |
| `photoCaptureController.restoreNow()` | 553 | `pendingStateFile().isFile` | 1 stat（无在途状态时） |
| `FileIncoming.sweepExpired(this)` | 577 | **`dir.listFiles()` + 逐条 `lastModified`/`delete`** | 见 C-03 |
| `crashFile.exists()` + 可能 `readText` | 584-587 | 1 stat；崩溃后 1 次读 | 小 |
| `provisionPublicRepoAndRefreshChip` | 648 | `publicRepoStatus()` → `exists()` + `readText()` | 1 stat + 小文本 |
| `DevLogPrefs.isEnabled` + `LogCollector.start` | 590-591 | SharedPreferences 读 | 小 |

- **问题**: 单项都小（1-2 次 stat），但它们**串行叠在首帧之前**，且在 `super.onCreate` 之后、`setContentView` 周围的黄金路径上。有量级的只有 `sweepExpired`（C-03）。这是「首帧可见时间」的组成部分，与「引擎多久起来」是两笔独立账。
- **预估收益**: **未量化**。宿主无法复现设备上 `SharedPreferences` 首次加载的 XML 解析 + stat 毫秒数；本仓没有 `onCreate` 耗时埋点。**建议第二阶段在 `onCreate` 首尾加一对 `SystemClock.elapsedRealtime` 落 `boot-diag.log`**（成本一行，可测得真实数字）。
- **改动风险**: 低（只加埋点）；中（若移动 `sweepExpired`，见 C-03）。
- **负控**: 这 6 个调用点全部是直接方法调用，没有 `Thread`/`post`/`launch` 包装——可在函数体内逐行核对，不存在「看起来同步其实异步」。

### C-03 `FileIncoming.sweepExpired` 在主线程做目录遍历 + 逐文件 JSON 解析，而它只用于删 7 天前的临时文件

- **测量方法**: `MainActivity.kt:577` → `FileIncoming.sweepExpired`（FileIncoming.kt:203-221）→ `sweepWorkspace`（FileIncoming.kt:262-279）→ `readQueuedSessionPaths`（FileIncoming.kt:289-300）。
- **基线数值**:
  - 1 次 `dir.listFiles()`（`tmpWorkspace` 目录 = 来件临时工作区）
  - `readPending` 读 `.pending-notify.ndjson`（**整个文件**）
  - `readQueuedSessionPaths` → `.sessions` 目录 `listFiles { .json }` + **每个 json 一次 `readText` + `JSONObject` 解析**（FileIncoming.kt:292-296）
  - 然后对 `list` 中每个条目一次 `lastModified()`（`stat`）
  - 全部包在 `synchronized(pendingLock)` 里
- **问题**: 这是**唯一一处**在 `onCreate` 主线程上做「目录遍历 + N 次 JSON 解析」的地方。量级取决于用户攒了多少来件记录，**上界没有硬限**——`TTL_MS = 7 天`（FileIncoming.kt:195），7 天内所有来件都留着。重度用户（每天分享十几份文件）可以让 `.sessions` 有数百个 json，主线程逐个 `readText` + `JSONObject` 解析。**这是本块唯一「随用户使用量增长的主线程冷启动成本」**，其余都是常数级。
- **预估收益**: **未量化（缺设备数据）**，但**结构性可得**：整体挪到后台线程（或延后到 `onResume` 之后 / 引擎就绪之后）是**零行为变化**——它的语义是「7 天 TTL 回收」，早 2 秒晚 2 秒没有任何用户可见差异。成本构成 = `listFiles` + N×(`stat` + `open` + `read` + `JSONObject.parse`)。
- **改动风险**: **低**。唯一语义耦合是「`sweepExpired` 在 `processIncomingIntent`（MainActivity.kt:723）之前跑」。但 `sweepExpired` 保护的是**被 `.pending`/`.sessions` 引用的文件不删**，而 `processIncomingIntent` 是新增来件（age=0，不在 TTL 删除集里），时间窗重叠不构成正确性问题。**建议第二阶段核实并在 PR 里写清依据**。
- **负控**: 反方向——若 `sweepExpired` 便宜，`sweepWorkspace` 里就不该有 `listFiles` + 逐条 `lastModified`（:270-277），`readQueuedSessionPaths` 也不该对每个 json 做 `JSONObject(file.readText())`（:295）。这不是推断，是逐行可读的。

### C-04 首个 WebView 构造 + 引导页视图树在主线程；`BrowserHost` 只在老 WebView 设备上 `bindService`

- **测量方法**: `MainActivity.kt:613`（`webView = WebView(this)`）+ `:634`（`buildGuideView()`）+ `:649`（`BrowserHost(...)`）→ `BrowserHost.kt:56-185`。
- **基线数值**:
  - `WebView(this)` 构造会初始化 Chromium provider（首次加载 native 库）。**设备耗时不可测**（本仓无埋点，宿主无 Android WebView）。
  - `BrowserHost.init` → `remote?.connect { }`（BrowserHost.kt:184）；`remote` 非空的条件是 `!BrowserHostProfile.supported() && SDK >= 29`（:172-175），而 `supported()` = `WebViewFeature.isFeatureSupported(MULTI_PROFILE)`（BrowserHostProfile.kt:29-31）。**支持 MULTI_PROFILE 的现代设备上 `remote == null`，不会 bindService**；只有老 WebView（<114）设备才 bind 到 `:browser` 进程。
- **问题**: 主线程上第一个 WebView 的构造是冷启动首帧的固定成本，**无法延后**（`WebView` 必须在有 Looper 的线程构造、必须在 UI 线程 addView）。这条不是缺陷，但它是「首帧可见」与「引擎就绪」之间那段空白的主要来源之一；第二阶段若量化首帧必须把它算进去。
- **预估收益**: 不可测（无设备埋点）。**不主张改**。
- **改动风险**: 高（动它就是动首帧语义）。**本报告不建议动**，只作口径登记。
- **负控**: `remote` 的构造条件在 :172-175 是显式布尔表达式；`supported()` 只有一行 `WebViewFeature.isFeatureSupported`。不存在隐藏的 binder 调用。
### C-05 解压成本几乎全部是 xz 解码的 CPU 地板；per-file 优化上界 ~7%，且只在首装/升级付一次

- **测量方法**:
  1. **自建 JVM 微基准**（`scripts/perf-audit-c/jvm/ExtractBench.java` + `bench-ladder.ps1`）：用**与产品完全相同的两个依赖**（`commons-compress 1.28.0` + `org.tukaani:xz 1.10`，见 `app/build.gradle.kts:122-123`）逐行复刻 `SnapshotExtractor.extractEntries`（SnapshotExtractor.kt:167-258），输入是**APK 里真正打进包的那份** `app/src/main/assets/snapshot.tar.xz`（200,877,488 B）。
  2. **归因梯**（每级只加一件事，用相邻两级之差归因）：`nullsink`（只解码）→ `mkdirwrite`（+mkdirs+写盘）→ `noperms`（+`deleteIfExists`）→ `full`（+`canonicalPath` 校验 + 4×`setXxx`）。
  3. 交叉验证：系统 `xz -t`（native liblzma）与 `xz --list`（块结构，见 C-06）。

- **基线数值 — 我的宿主测量（受并发干扰，只看方向与差分）**:

| 变体 | 做了什么 | 耗时（ms） | 吞吐 |
|---|---|---|---|
| `digest` | 流式 SHA-256，不解码（= `SnapshotBundledAsset.digest` 复刻） | 988 / 1073 / 1112 / 1159 / 1345（n=5，median **1112**） | 165-194 MB/s |
| `nullsink` | xz 解码 + tar 解析，**零写盘** | 36,359（本轮干净串行 n=1）；先前批 n=5：23,136 / 24,032 / 24,225 / 24,341 / 24,553（median 24,225） | 19.7-29.5 MB/s |
| `mkdirwrite` | + 7,593 次 mkdirs + 44,568 次建流写 715.67 MiB | 122,993（n=1）；先前批：107,995 / 112,465 | 5.8-6.6 MB/s |
| `noperms` | + 44,568 次 `Files.deleteIfExists` | 114,341 | 6.3 MB/s |
| `full` | + `getCanonicalPath` 校验 + 4 次 `setXxx` | 248,958 | 2.9 MB/s |
| `xz -t`（native liblzma 校验，含解码） | 负控 | 10,947 / 11,280 / 11,410 / 11,661 / 12,461（median **11,410**） | — |

- **基线数值 — 权威值（Lead 在 WSL/ext4 上测得，Linux、syscall 与 Android 同构，单线程）**:
  - 纯 xz 解码、不写盘（**CPU 地板**）：**19.43 s / 19.91 s**
  - tar 列表（解码 + 解析 53k 头，零写入）：25.27 s
  - 真实解压到 ext4（建 44,568 文件 + 写 715.67 MiB）：**25.20 s / 27.69 s**
  - Android 特有的 per-file 开销（1× `deleteIfExists` miss + 4× chmod）：chmod×4 = **1,161 ms**，unlink-miss×44,568 = **714 ms**，**合计约 1.9 s，占解压总时间 ~7%**

- **问题（关键判断）**: 我的宿主绝对值**不可搬用**——`nullsink` 37 s 与 `full` 249 s 差 6.7 倍，其中「写 715 MiB 到 NTFS」在宿主机上异常昂贵（NTFS + Defender + 并发 agent 抢盘），在 Android 的 f2fs/ext4 上便宜得多。**因此结论以 ext4 那组为准（19-28 s 区间）**，我的测量只用来提供两条独立佐证：
  - **成本在解码不在读盘**：`digest`（纯顺序读 + SHA-256，165-194 MB/s）比 `nullsink`（解码，19.7-29.5 MB/s）**快 6-9 倍**。同一个文件、同一个磁盘，差别只在「有没有解码」。
  - **`deleteIfExists` 在宿主上是噪声级**：`noperms`(114.3 s) 与 `mkdirwrite`(123.0 s) 在噪声内不可分——与 ext4 上测到的 714 ms 同向（都是「小到测不出来」）。

- **预估收益**: **per-file 优化上界 = 7%（≈1.9 s / 25-28 s）**。其中：
  - 4 次 `setReadable/setWritable/setExecutable` → 一次 `android.system.Os.chmod` 合成，理论省 ~1.16 s 的 3/4 ≈ **0.87 s**（注意 `setReadable(false,false)` 是「先清后设」，合并需保持语义）；
  - `deleteIfExists` miss → 「只在目标已存在时才删」的 stat 前置，省 ~714 ms 的一半（stat 本身也要钱）；
  - **合计约 1.5 s 上限**，且**只在首装/升级时付一次**（C-01）。
- **改动风险**: **中**（改 `SnapshotExtractor` = 动快照事务/解压沙盒边界，属 L2 安全敏感面，需即时三层验收）。
- **负控**: 归因梯本身即负控——每一级都真的跑通并产出 `ondisk-files=44568 ondisk-bytes=750434969`（与 tar 索引逐字节一致，说明我复刻的循环行为与产品一致）。若尺子失明（例如 buffered 到内存假装写盘），`mkdirwrite` 与 `nullsink` 会读出同一读数；实测差 **3.4 倍**（37.0 s vs 124.0 s）。
### C-06 单块流（Blocks: 1）⇒「并行解码」整条路线在设备上零收益 —— 硬证据

- **测量方法**: `xz --list --verbose` 对**真正打进 APK 的那份**归档 + 交叉核对构建链的两个压缩点。
- **基线数值**:
```
app/src/main/assets/snapshot.tar.xz
  Streams: 1   Blocks: 1
  Compressed size:   191.6 MiB (200,877,488 B)
  Uncompressed size: 767.0 MiB (804,229,120 B)
  Blocks:  Stream 1 / Block 1 / CompOffset 12 / UncompOffset 0 / UncompSize 804,229,120

snapshot/snapshot-x86_64.tar.xz
  Streams: 1   Blocks: 1
  Compressed size:   142.3 MiB (149,201,056 B)
  Uncompressed size: 720.4 MiB (755,384,320 B)
```
（注：`767.0 MiB` 是 xz 的块级读数，含 tar 填充块；实际 tar 成员字节 = **715.67 MiB = 750,434,969 B**，我的 ExtractBench 独立复现了这个数。）

- **问题**: xz 的**块**是并行解码的最小单位——多线程解码只能把**不同的块**分给不同线程。单块流 ⇒ **无论 xz-utils `-T`、还是 Java 侧自建分块解码，都只能有一个线程在解**。因此：
  - 「改用 native liblzma 解码」（`xz -dT`）在单块输入上退化为单线程，**收益 ≈ 0**；
  - 「Java 分块解码」在不重写归档格式的前提下不可能；
  - **唯一能获得解码并行度的方式是重新生成归档为多块流**（`xz --block-size=...`）。

- **根因（构建链，属 A 块；此处只留证据）**:
  - `scripts/build-snapshot-013.mjs:1404`：`xz -T${XZ_THREADS} -6 -c ... > archive.part` —— **多线程压缩**
  - `scripts/inject-snapshot.py:70-71`：`with lzma.open(src,"rb") as f: raw = f.read()` —— 整读进内存
  - `scripts/inject-snapshot.py:123`：`with lzma.open(dst,"wb", preset=...) as f:` —— **Python lzma 单线程重压**（preset 默认 9）
  - ⇒ 多线程压缩的产物被单线程 Python 重压覆盖，最终归档是单块流。**与 `xz --list` 读数完全吻合。**

- **预估收益**: 解码侧 **0%（结构性不可得）**。可得收益在**编码侧**（属 A 块）：Lead 实测 preset 6 `-T16` 编码 105 s vs preset 9 `-T16` 编码 393 s，**差 288 s**。
- **改动风险**: 改归档为多块流会改变 APK 内嵌资产字节 ⇒ **签名/指纹门禁全链重跑**，且 `snapshot.sha256` 必须同步（`check-snapshot-asset.ps1` 会判红）。风险**高**，但收益同样明确。
- **负控**: 反方向——若归档是多块流，`xz --list --verbose` 的 Blocks 段会**列出多行**（每块一行 CompOffset/UncompOffset）。实测只列出**一行**（Block 1，CompOffset 12）。另有一个天然负控：`build-snapshot-013.mjs:110-115` 的注释写明**基座** tar.xz 是多块流（21/5 块）——**基座多块、最终产物单块**，这个反差本身就是负控。

### C-07 冷启动的**支配项不在本仓**：loader-settle-wait 1.5-7.3 s 是上游引擎激活 ~193 条 Loader entry 的成本

- **测量方法**: 读 `scripts/check-boot-budget.mjs` 头注释（第 44-75 行的设备实测记录）+ 读 `scripts/perf/count-compose.mjs` 探针实现 + 实跑两个 `--self-test`。
- **基线数值**（**设备实测，MuMu 模拟器，n=24，两台机**，来自门禁头注释）:
  - 冷启窗口事件循环 p99（ms，升序）：1371.4 1372.7 1426.2 1468.4 1471.9 1518.9 1525.1 1525.6 1533.0 1654.6 1696.9 1753.9 1869.8 2005.6 2184.0 2188.7 2241.2 2533.4 2798.8 2886.5 3820.9 4709.4 4779.9 6260.6
  - min 1371.4 / **median 1811.8** / p75 2533.4 / p90 4709.4 / max 6260.6（max/min ≈ 4.6x）
  - 分解：compose 单次最大 **4-22 ms**；**constructor-flush（我们的 client-modules registry 扫描）37.7-552.8 ms**；**loader-settle-wait 1532.5-7288.1 ms ← 支配项**
  - 门禁原文结论：支配项是**上游引擎自身激活全部 ~193 条 Loader entry**
  - 早期设备实测（同注释第 6 行）：`LISTEN_MS=2981`，`[perf] compose #1 at=5198ms dur=2795ms`
- **本仓的份额**: 只有 constructor-flush（37.7-552.8 ms）。相对 loader-settle-wait 是 **2.5%-7.6%**；按中位数比（~100 ms / ~1800 ms）约 **5.5%**。
- **问题**: 第二阶段若优化本仓启动代码，**上界 ~550 ms（最坏）/ ~100 ms（典型）**，相对 1.8 s 窗口是**个位百分比**。决策上很重要：**不要把冷启动大头算在本仓账上**。门禁自己也这么写——`LOOP_P99_BUDGET_MS = 7200` 是「回归哨兵」不是性能目标，注释明写「不得用它的红/绿宣称冷启动性能达标」。
- **预估收益**: 本仓可控部分 = **≤550 ms（最坏）/ ~100 ms（典型）**，占窗口 5% 量级。
- **改动风险**: 无（纯引用已有实测数据）。
- **负控**: 这批数据的可信度由门禁自身的纪律保证——`check-boot-budget.mjs --self-test` 我实跑了，**全绿**（`BOOT-BUDGET SELF-TEST PASSED`，30 项 PASS，含「构造 p99=7220ms → 判红」等反向对照）；`count-compose.mjs --self-test` 也全绿（`COUNT-COMPOSE SELF-TEST PASSED`，11 项 PASS）。即这套尺子能区分快慢、且能对「恒为 -1」「文本在场但值未知」等假绿形态判红。
### C-08 真实设备 `boot-segments.log` 样本：t_listen 4.5-5.4 s、t_first_http 5.2-7.5 s（同机两次冷启）

- **测量方法**: 读仓库内保留的真实设备产物 `.deploy-tmp/issue-499/revival/boot-segments.success.log`（6 行，2 次冷启 × 3 段）。
- **基线数值**:
```
冷启 #1: t_listen_ms=5408  t_first_http_ms=7461  t_http_minus_listen_ms=2053  t_compose_total=6  engineHeapMb=2971
冷启 #2: t_listen_ms=4480  t_first_http_ms=5237  t_http_minus_listen_ms=757   t_compose_total=4  engineHeapMb=2971
```
  - `engineHeapMb=2971` ⇒ 该设备总内存 ≈ 5942 MB（`engineHeapMb = clamp(totalRam/2, 512, 4096)`），即 6 GB 机型。
- **问题/价值**: 这是**本仓唯一可直接读到的、未经手填的真实 boot-segments 产物**。它给出三点：
  - `t_listen_ms` 4.5-5.4 s 与门禁注释里的 `LISTEN_MS=2981` 同量级（不同设备/版本）；
  - `t_http_minus_listen_ms` 2053 / 757 ms —— 这是 C1 判据（阈值 4000 ms）的真实形态，**两次都在阈值内**，「LISTEN 快、首个响应慢」在该现场**没有**发生；
  - `t_compose_total=4~6 ms` —— 本仓 compose 实测值，与门禁注释「compose 单次最大 4-22 ms」一致。
- **预估收益**: 不适用（基线数据）。
- **改动风险**: 无。
- **负控**: 两次冷启的 `note=boot-start/listen/first-http` 三行齐备且 `t_boot_start` 两次不同（1792829141806 / 1792829219585）⇒ 不是复制粘贴的假样本；`t_compose_source=preload-total` 与门禁的解析口径一致。

### C-09 `liveRuntimeComplete()` 被重复调用 3 次、每次 stat 11-15 个路径 —— 但常态冷启上**不付**，量级 μs 级

- **测量方法**: `grep liveRuntimeComplete` 全仓 → 4 个调用点：`EngineManager.kt:878`（`shouldDegradeRefresh` 内）、`EngineManager.kt:1491`、`EngineStartFlow.kt:1498`、`EngineStartFlow.kt:1567`；追每个调用点的条件。
- **基线数值**:
  - 每次 `liveRuntimeComplete()` = `RuntimeTree.missingEntries` → `BASE_ENTRIES`(2) + `profileDir`(1) + `REQUIRED_LIBS`(8) = **11 次 stat**；其中 4 个 lib 还要额外 `isSymbolicLink` + `readSymbolicLink`（RuntimeTree.kt:136-152）⇒ **最多 15 次文件系统调用**。
  - 冷启路径上的调用链：`EngineStartFlow.kt:758` `if (!snapshotFresh())` 为 true 时才进 `shouldDegradeRefresh()`（EngineManager.kt:875-879）**此时才第一次 stat**；随后 `:1498`/`:1567` 在安全模式路径上再各一次。
- **问题**: **常态冷启动上不付**（`snapshotFresh()` 为 true 时整段跳过）。三次调用是**重复计算**（同一棵树、同一轮启动，结果只可能因刷新而变），但每次 15 次 stat ≈ 微秒级，**量级不重要**。列出它是为了**防止第二阶段误把它当热路径**。
- **预估收益**: ~0。**不建议优化**，只登记为「已核实非热点」。
- **改动风险**: 低（但缓存它有正确性风险：刷新后树会变）。
- **负控**: 反方向——`EngineStartFlow.kt:1471` 的注释把 `liveRuntimeComplete()` 列为「不能留在 UI 线程」的理由之一，但同函数里真正的 ANR 风险来自 `stopOwnedEngine()`（最长 1 s 探活），注释里也写了。11 个固定路径的 stat 不构成 ANR 级成本。

### C-15 `resolveEntry` 对每个 tar 条目调 `File.getCanonicalPath()` —— Android 上便宜（`realpath`），宿主上 ~2.5 ms/次，**宿主绝对值不可搬用**

- **测量方法**: 读 `SnapshotExtractor.resolveEntry`（SnapshotExtractor.kt:293-304）+ 我的 `full` 变体（同一行代码）与 `noperms`（无该行）之差。
- **基线数值**:
  - `resolveEntry` 对**每个**条目调一次 `target.parentFile.canonicalPath`（:299），共 **53,178 次**（含目录与符号链接）。
  - 宿主实测差：`full`(248,958 ms) − `noperms`(114,341 ms) = **134,617 ms** ⇒ 约 **2.5 ms/次**。
- **问题（关键：这条是负控，不是结论）**: Windows 的 `getCanonicalPath` 要对**每一级路径**做 `CreateFile`/`GetFinalPathNameByHandle`，非常昂贵；Linux/Android 上是 `realpath(3)`，纯内存路径解析 + 中间目录的 `stat`，通常 **10-100 μs/次** 量级。**因此这 134 s 是宿主产物，绝不能写成「Android 上要多花 134 秒」。**
- **预估收益**: **不可测（设备）**。理论上可优化成「dest 的 canonicalPath 只算一次，条目路径按字符串前缀判断」（不需要每条的 canonicalPath，因为 tar 名字已经过 `replace('\\','/')` + 拒绝 `..` + `trimStart('/')` 清洗）。但**没有设备数据前不建议动**——它属 L2 安全边界（路径穿越防护）。
- **改动风险**: **高**（改路径穿越防护 = 安全敏感面）。
- **负控（这一条本身就是负控案例）**: 同一段代码在两个平台上差 3 个数量级，正是「宿主测量不能冒充设备测量」的教科书例子。我在报告里保留它，是为了让第二阶段不要拿着 134 s 去做决策。**如果第二阶段要优化它，唯一合格的证据是在设备上跑 `prelude` 同款埋点。**

---

# 第三部分：可延后 / 可并行 / 可跳过（C2）

| 阶段 | 能否延后到首屏后 | 能否并行 | 能否缓存跳过 | 依据 |
|---|---|---|---|---|
| `StartupPrefsNormalizer.resetOnUpgrade` | 否（决定 autoStart 分支） | 否 | **是**：已有 `files/.version-<v>` marker 早退（StartupPrefsNormalizer.kt:49-50） | 源码 |
| `photoCaptureController.restoreNow()` | 是 | 是 | 是（无在途状态时 1 次 isFile） | 量级太小，不值得改 |
| `FileIncoming.sweepExpired` | **是**（7 天 TTL，晚 2 秒无差异） | 是 | 否（必须每轮扫） | **C-03：本块唯一有增长性的延后项** |
| `WebView(this)` 构造 | 否（首帧本体） | 否（UI 线程硬约束） | 否 | C-04 |
| `buildGuideView()` | 否（首帧可见） | 否 | 可考虑 ViewStub 化（未验证） | 未深挖 |
| `provisionPublicRepoAndRefreshChip` | 是 | **已经是**（内部起 `Thread("dsh-public-repo")`，MainActivity.kt:943-949） | 是（`needsRetry(status)` 早退） | 源码 |
| `BrowserHost.init` bindService | — | 已经是异步（`connect { }` 回调） | — | 仅老 WebView 设备触发 |
| `prepareStartupOwnership` | 否（顺序契约） | 否（`runBlocking`） | **是**：`reuseRecent=true` + 5 s 窗口（RootOwnershipJobs.kt:49） | 已在后台线程 |
| `recoverInterruptedRefresh` | 否 | 否（CAS 保护） | **是**：常态 1 次 `readMarker`，源码注释「Cheap when nothing is pending (one stat)」 | EngineManager.kt:615 |
| `snapshotFresh()` | 否 | 否 | **是**（本身即缓存判据） | C-01 |
| prelude 6 步 | 否（顺序语义：坏键迁移必须先于引擎读 settings） | 否 | 部分（`applyRuntimePatches` 有 fast-path） | EngineManager.kt:1593-1625 注释 |
| 解压 `refreshSnapshot` | 否 | 否（单块流，见 C-06） | **是**（`snapshotFresh` 早退；日常冷启完全不付） | C-01 / C-06 |

## 「第二次冷启动还要花多少时间在快照相关代码上」——决定解压优化值不值得

已解压且指纹匹配时，快照相关代码只剩：
1. `recoverInterruptedRefresh` 的 1 次 `readMarker`（`File.exists` + 小文本）
2. `snapshotFresh()` 的 1 次 `readText`（64 hex）+ 1 次 `node.exists()`
3. `prepareStartupOwnership` 内部对残渣的 `SnapshotFs.exists` 检查（2 次 stat）

**合计 5-8 次文件系统调用 + 读两个 64 字节级小文件。**

⇒ **日常冷启动上，快照相关代码的成本可忽略**。解压优化的价值**只体现在首装/升级那一次**（一次性 19-28 s CPU，见 C-05/C-06）。**因此「优化解压」的 ROI 口径应该是「升级那一次的等待」，不是「每次启动」。**
---

# 第四部分：内存驻留（C3）

### C-10 壳进程没有「无限增长」的常驻大对象：所有大缓冲都有硬上限（逐项核过）

- **测量方法**: `grep` 全仓 `ByteArray(` / `Bitmap` / `ImageReader` / `LRU` / `MAX_`，对每个 >1 MiB 的分配点追到生命周期；再逐个抽查跨进程单例。
- **基线数值**（全部为源码常量）:

| 对象 | 上限 | 生命周期 | 位置 |
|---|---|---|---|
| 快照解压写缓冲 | 64 KiB（每文件新建一次） | 每文件作用域 | SnapshotExtractor.kt:235 |
| 摘要预检缓冲 | 64 KiB（1 个实例复用） | 一次调用 | SnapshotExtractor.kt:49 |
| 引擎日志增量读 | 256 KiB / tick | 每次 tick | LogCollector.kt:31 |
| 日日志文件 | 5 MiB（超限轮转 2 代） | 磁盘 | LogCollector.kt:30 |
| logcat 读 | 1 MiB（`ProcIo.readBounded` 10 s 有界） | 每次 tick | LogCollector.kt:994 |
| 诊断包单条 / 整包 | 2 MiB / 12 MiB | 分享时 | LogShare.kt:43/46 |
| 截图缓存 | 32 文件 / 1 h TTL | 磁盘 | ShotCachePolicy.kt:22/25 |
| 来件单文件 | 200 MiB（拒绝） | 磁盘 | FileIncoming.kt:124 |
| 下载单文件 | 200 MiB（拒绝） | 磁盘 | DownloadSaver.kt:252 |
| Shizuku 传输 / 单次 capture | 512 MiB / 256 MiB | 磁盘 staging | ShizukuTransport.kt:862 / ShizukuUserService.kt:366 |
| Mux 帧 | 8 MiB | 每帧 | MuxClient.kt:46 |
| 虚拟屏 ImageReader | **每屏 1 个，全局上限 1 屏**；RGBA_8888 双缓冲 | 常驻至销毁/空闲 10 min | VdisplayController.kt:40/92/372 |
| 浏览器工作台 | 每会话 1 个 WebView；每会话最多 8 tab | 会话关闭时 `destroy()` | BrowserHost.kt:80/1883-1895 |
| 修复会话 | 50 条 | 磁盘索引 | RepairConversationStore.kt:27 |

- **问题**: **没有发现无界集合**。三点值得注意：
  1. **虚拟屏 ImageReader 是常驻像素缓冲**：`ImageReader.newInstance(w, h, RGBA_8888, 2)`（VdisplayController.kt:372）—— 2 × w×h×4 B。以 1260×2800 真机、默认 `scale=0.75`（VdisplayPrefs，VdisplayController.kt:902）计：945×2100×4×2 = **15.9 MiB** native 像素缓冲。有上限（1 屏）+ 有回收（10 min 空闲）⇒ **不是泄漏**。
  2. **浏览器 WebView 每会话一个**（BrowserHost.kt:330-334 `Workspace`）。`workspaces.remove` **只在显式关会话时发生**（BrowserHost.kt:412）——若会话被上游删除而未走这条路径，`Workspace` 会留在 map 里。这是**潜在**驻留增长点，但需上游配合才触发，静态无法判定实际发生率。**建议第二阶段在设备上用 `dumpsys meminfo` 观察多次开关会话后的 RSS 曲线**（本阶段无设备，**不可测**）。
  3. **`LogCollector` 的 `StringBuilder`**（LogCollector.kt:965-972）每 5 s 重建一次并 append 整个 logcat 尾部 + engine.log 尾部。`readBounded` 已把 logcat 限到 1 MiB、engine.log 限到 256 KiB，**但 StringBuilder 在 GC 前会短暂持有 ~1.25 MiB**。5 s 一次、对象很快死 ⇒ **分配抖动**而非驻留。且仅在开发者日志开关打开时跑（`EngineService.kt:65` / `MainActivity.kt:590` 都判 `DevLogPrefs.isEnabled`）。
- **预估收益**: 无可量化收益（当前不存在无界驻留）。**唯一值得跟进的是第 2 点**，需设备实测才能定性。
- **改动风险**: 高（动 WebView 生命周期 = 动浏览器面板语义）。
- **负控**: 反方向——若存在无界驻留，应能找到「只增不减的 companion object 集合」。我 grep 了全部 `companion object` + `mutableListOf/mutableMapOf/LinkedHashMap`（93 处命中），逐个抽查跨进程单例（`BrowserHostHolder`、`EngineAuth.cached`、`EngineEndpoint.state`、`VdisplayController.records`、`NotifyStore`、`ControlPoller.executed`）——**每个都有显式清理路径或硬上限**（如 `ControlPoller.EXECUTED_LRU_CAPACITY=64` 的 `removeEldestEntry`、`MAX_TABS=8`）。`BrowserHostHolder.host` 在 `MainActivity.onDestroy` 里被置 null（MainActivity.kt:1088）。

### C-11 引擎进程内存不被壳侧「副本」放大：`--max-old-space-size` 自适应，解压产物只有一份

- **测量方法**: 读 `EngineManager.shellEnv()`（EngineManager.kt:2596-2620）+ `engineHeapMb`（:2852-2855）+ `heapOptionFrom`（:3133-3135）+ `SnapshotTransaction.swap` 的 rename 语义。
- **基线数值**:
  - `NODE_OPTIONS = --max-old-space-size=clamp(设备总RAM/2, 512, 4096)`。
  - 6 GB 设备（`engineHeapMb=2971` 反推）⇒ 引擎 V8 老生代上限 ≈ 2971 MB。
  - `NODE_COMPILE_CACHE` 指向 `<files>/.node-compile-cache`（EngineManager.kt:2596）—— **磁盘**缓存，不是内存索引。
  - 解压产物 = `files/usr` + `files/home`，**磁盘上只有一份 live 树**；swap 用 `rename`（SnapshotTransaction `replaceEntry`/`SnapshotFs.move`），不复制字节。
  - 解压**后**同一份字节不在内存驻留：`SnapshotExtractor` 逐文件 64 KiB 缓冲流式写盘，函数返回即释放。
- **问题**: 不存在「壳进程持有 716 MiB 树的内存副本」这种形态。唯一的相关双份是**磁盘**上的 `.snapshot-stage` + `.snapshot-previous`（解压期峰值 ≈ 716 MiB × 2 + 原 live 树），这是 IO/磁盘问题 ⇒ **归 D 块**（见交叉发现 1）。
- **预估收益**: 无（当前无缺陷）。
- **改动风险**: 无。
- **负控**: 反方向——若存在内存副本，`SnapshotExtractor.extract` 里就该有把整个流读进内存的语句。实际是逐块 `out.write(buf, 0, n)`（SnapshotExtractor.kt:234-246）。唯一的「整读」在 `inject-snapshot.py:70-71`（**构建期**，不在设备上）。

### C-12 可累积的事务残渣（不属内存，但与启动相关，主体归 D 块）

- **测量方法**: grep 全部写盘路径 + 读每个的保留策略。
- **基线数值**:
  1. `.snapshot-stage` / `.snapshot-previous` —— 正常路径 `SnapshotTransaction.finish()` 会删（:284-289），但**只在 marker 存在时**；marker 丢失时靠 `reclaimResidue`，且只在 `snapshotFresh()` 时回收（EngineManager.kt:642）。用户实测曾留 920 MB（SnapshotTransaction.kt:271 注释）。
  2. `boot-segments.log` / `boot-fail.log` / `boot-diag.log` —— 各留一代 `.1`（LogCollector.kt:421 注释）。
  3. `engine.log` —— 5 代轮转。
- **问题**: 第 1 项是**唯一可能上 GB 的**。回收条件（`marker == null && hasResidue && snapshotFresh()`）在「marker 残留」时**不成立**（此时走 `applyRecovery` 而非 `reclaimResidue`）。这是既有设计（marker 是恢复权威），不是缺陷，但值得在第二阶段确认 `finish()` 清理失败路径在设备上的实际发生率。
- **预估收益**: 磁盘侧，最多 ~1.6 GB（716 MiB stage + 920 MB previous）。**归 D 块**。
- **改动风险**: 高（动事务语义 = L2）。
- **负控**: `hasResidue` 的判据在 SnapshotTransaction.kt:300-301 是显式两个 `exists()`；`reclaimResidue` 的调用点在 EngineManager.kt:642/669 两处，条件都含 `snapshotFresh()`。
---

# 第五部分：现有度量设施（C4）

### C-13 仓库内已有一套**带负控的**启动预算门禁，可直接作为第二阶段的回归哨兵

- **测量方法**: 实跑两个自检。
- **结果**:
```
node scripts/perf/count-compose.mjs --self-test   → COUNT-COMPOSE SELF-TEST PASSED  (11 项 PASS)
node scripts/check-boot-budget.mjs --self-test    → BOOT-BUDGET SELF-TEST PASSED    (30 项 PASS)
```
- **门禁质量评估**（逐条核对，C4 要求）:
  - ✅ **不用「文本在场」当判据**：头注释第 12-13 行明写纪律；`parseSegments`/`parseProbe` 都**解析成数值再做算术断言**；`present()` 只作存在性前置。
  - ✅ **每条判据自带反向对照**：`--self-test` 构造「LISTEN 快、首个响应慢」「`t_compose_total=-1`」「单条计数恒 0 且无正向对照」三类必须判红的输入。
  - ✅ **三态而非二态**：C4/C5 都有 pass/fail/**skip**，`skip` 明确不算绿。
  - ✅ **承认量程局限**：C4 注释明写「不得当作紧性能门禁、更不得用它的红/绿宣称冷启动性能达标」。
  - ✅ **样本量纪律**：n=8 的阈值 3400 ms 会误红 4/24，扩到 n=24 后重标 7200 ms —— 真实自我更正，不是调参放宽。
  - ⚠️ **已知盲区 1**：n=24 全部来自 MuMu x86_64 模拟器，**真机（arm64）未测**（注释第 74-75 行明写）。发布前须在真机补同口径采样。
  - ⚠️ **已知盲区 2**：C1 的**绝对**目标（`t_boot_start → 首个 HTTP`）「按详档 §6 第 2 项尚未重标」，默认只告警（`resolveBudgets` 里 `firstResponseMs: undefined`）。这**不是假绿**，因为 `listenToHttpObservationMs` 仍强制 4000 ms。
- **预估收益**: 不适用（基础设施盘点）。
- **改动风险**: 无。
- **负控**: 自检本身即负控，我实跑且两个都 PASS。那 30 项里多条是「构造超预算读数，断言判红」，走的是与生产同一条 `runChecks` 路径。

### C-14 现有启动埋点清单：4 项已接线，**3 项关键缺失**

| 埋点 | 覆盖什么 | 落点 | 状态 |
|---|---|---|---|
| `dsh-boot-segments`（`t_boot_start`/`t_listen`/`t_first_http`/`t_compose_total`） | 引擎启动四段 | `files/boot-segments.log` | ✅ 已接线（真实设备样本见 C-08） |
| `perf prelude step=... durMs=...` | spawn 前 6 步 | `boot-diag.log`（`perf-prelude`） | ✅ 已接线（EngineManager.kt:1593-1625） |
| `perf asset-patch ... outcome=... durMs=...` | 3 个运行时补丁应用耗时 | `boot-diag.log`（`perf-asset-patch`） | ✅ 已接线（EngineManager.kt:1387-1390） |
| `[perf] compose #N at=.. dur=..` / `[perf] TOTAL ... loopP99Ms=..` | 本仓 client-modules compose + 事件循环 | 引擎 stdout → `engine.log` | ✅（需 `count-compose.mjs` 注入） |
| **`onCreate` 主线程耗时** | 首帧可见前的壳侧串行 IO | — | ❌ **缺失**（C-02/C-03 无法量化即因于此） |
| **`WebView` 构造耗时** | 首个 WebView | — | ❌ **缺失** |
| **解压分段耗时**（extract / validate / restore / swap / finish） | 升级那一次的 19-28 s | — | ❌ **缺失**（只有 `onStage` 文案，无毫秒数） |
| **壳进程 RSS / 堆峰值** | 内存驻留 | — | ❌ **缺失**（`measure-steady.ps1` 有 `rssMiB`，但那是**引擎 node 进程**且需 adb） |

- **预估收益**: 补三个埋点（onCreate 首尾、WebView 构造前后、`refreshSnapshot` 五个分段）是**低成本高价值**：每处 2 行，直接让 C-02/C-03/C-05 从「结构性判断」变成「可量化」。
- **改动风险**: 低（纯埋点，不改行为）。注意 `refreshSnapshot` 属 L2 敏感面，埋点也要走三层验收。
- **负控**: 「已接线」四项都能在仓库里找到真实产物（C-08 的 boot-segments 样本、`perf prelude` 的 `reportLine()` 实现）；「缺失」三项在全仓 grep 不到对应 `writeBootDiag` 调用。

---

# 第六部分：交叉发现（不归 C 块）

1. **【D 块】解压**前**没有任何空间前置检查**，而升级期需要「stage 716 MiB + previous 树」同时在盘。`refreshSnapshotInternal` 在 `extractAndValidate` 之前只有指纹预检与 stage 清理，**没有 `StatFs` 断言**；唯一的空间检查在 `SnapshotTransaction.swap` 里，而它跑在解压**之后**（注释明说「stage 的空间已经付过了」，SnapshotTransaction.kt:570-583）。⇒ **「解压到一半 ENOSPC」是可达的**，这是 D 块的量级项，也是 C 块看到的最实际的启动失败风险。
2. **【A 块】构建链把多线程压缩产物用 Python 单线程重压覆盖**（`inject-snapshot.py:123`，`DSH_INJECT_PRESET` 默认 9）⇒ 最终归档单块流 + preset 9。编码侧收益明确（Lead 实测 preset 6 比 9 快 288 s）。
3. **【B 块】首屏可见 ≠ 可对话**：C-07 的 loader-settle-wait 数据（1532.5-7288.1 ms）表明两者相差 1.5-7.3 s，且那段全在上游引擎侧。B 块若测「首屏 JS 工作量」，请把这段时间单独标注，不要与壳侧 `onCreate` 混算。
4. **【D 块】日志写入频率不受控**：`boot-segments.log`/`boot-fail.log`/`boot-diag.log` 各只留一代，但 `boot-fail` 在失败重试路径上每轮至少一条，设备实测曾出现「44 次 boot-start 未到 listen」（LogCollector.kt:508-509 注释）⇒ 崩溃循环下的写入量值得量化。
5. **【B 块】`LogCollector` 的 5 s tick 会 `ProcessBuilder` 起 `/system/bin/logcat -d`**（LogCollector.kt:986-994）—— **每 5 s 一个进程**（12 次/分钟），只在开发者日志开关打开时生效。B5 的定时器普查应把它算进去。
6. **【A 块】`usr/lib 432.58 MiB (60.44%)` 与 `usr/bin/node 42.73 MiB` 的构成**（Lead 的 tar 索引）说明：若目标是缩小 APK/快照，`usr/lib` 是唯一有意义的战场，而 `home/.dsh 107.55 MiB` 是**用户数据目录**（不应随包分发的东西）。这条与 C 块无关但影响「解压后 716 MiB 的磁盘占用」这条 C 块结论的解释力。
---

# 第七部分：Top-N 排序（按 收益/风险 比）

| # | 结论 | 预估收益量级 | 改动风险 | 工作量 | 备注 |
|---|---|---|---|---|---|
| 1 | **把 `FileIncoming.sweepExpired` 移出 `onCreate` 主线程**（C-03） | 低-中（随来件量增长：N×(stat+open+read+JSON.parse)；典型的低） | **低** | **S** | 唯一随使用量增长的主线程冷启成本；零行为变化 |
| 2 | **补三个启动埋点**（onCreate 首尾 / WebView 构造 / refreshSnapshot 五分段）（C-14） | 0 直接收益，但让 #1 与后续优化**可量化** | **低** | **S** | 每处 2 行；没有它，本块一半结论只能是结构性的 |
| 3 | **构建链：去掉 Python 重压**（C-06，属 A 块） | **编码 288 s**（preset 9→6）+ 解锁未来解码并行度 | **高**（改归档字节 = 签名/指纹全链重跑） | **M** | 收益最大但在 A 块；我这边只提供「解码侧 0%」的否决证据 |
| 4 | **解压 per-file syscall 合并**（4×`setXxx`→1×`Os.chmod`；`deleteIfExists` 前置 stat）（C-05） | **上限 ~1.5 s / 25-28 s ≈ 5-6%**，且只在首装/升级付一次 | **中**（L2 快照事务面，需三层验收） | **M** | **明确不推荐优先做**：量级小、风险高 |
| 5 | **常规冷启动优化**（C-07） | 本仓可控上限 **~550 ms**，典型 **~100 ms**（占 1.8 s 窗口 5%） | 中 | L | **不建议作为第二阶段主攻方向**：支配项在上游 |
| 6 | **会话 `Workspace` 生命周期核查**（C-10 第 2 点） | 未量化（需设备 `dumpsys meminfo`） | 高 | M | 仅作风险登记 |

## 明确**不该做**的（防止第二阶段走弯路）

- ❌ **优化 per-file chmod / 改成流式写**：上界 7%。我在宿主上实测 `noperms`(114.3 s) 与 `mkdirwrite`(123.0 s) **不可分**（噪声内），ext4 上是 1.9 s。
- ❌ **换解码器 / 加并行解码**：单块流，结构性零收益（C-06，`xz --list` 硬证据）。
- ❌ **缓存 `liveRuntimeComplete()`**：每次 15 次 stat，微秒级；缓存反而有「刷新后失效」的正确性风险（C-09）。
- ❌ **把 `snapshotFresh()` 或 `recoverInterruptedRefresh` 也「优化」**：它们已是 5-8 次文件系统调用的常数成本（C2 表末两行）。
- ❌ **在「日常冷启动」上算解压账**：解压只在首装/升级付一次（C-01）。
- ❌ **拿我这份报告里的宿主 `full` 变体 249 s 去做「Android 上线」决策**：那是 Windows `getCanonicalPath` 的产物（C-15），Android 上差 3 个数量级。

---

# 附 A：可复现命令清单

```powershell
# 1. 解压吞吐与成本归因
pwsh -File scripts/perf-audit-c/bench-extract.ps1 -Runs 5     # digest + nullsink + xz -t 负控
pwsh -File scripts/perf-audit-c/bench-ladder.ps1 -Runs 1 -Variants 'nullsink,mkdirwrite,noperms,full'
# 原始读数落在 scripts/perf-audit-c/out/*.txt

# 2. 归档结构（单块流证据）
xz --list --verbose app/src/main/assets/snapshot.tar.xz

# 3. 门禁自检（证明这套尺子能区分快慢）
node scripts/perf/count-compose.mjs --self-test
node scripts/check-boot-budget.mjs --self-test
```

**环境**：Windows 11 / PowerShell 7 / OpenJDK 17.0.2 / Node v24.17.0 / xz（git 2.53.0 自带）/ 宿主 BABEL。
**JVM 依赖**（全部取自本机 Gradle 缓存，与 `app/build.gradle.kts:122-123` 同版本）：commons-compress 1.28.0、`org.tukaani:xz` 1.10、commons-io 2.20.0、commons-lang3 3.18.0。
**临时目录**：`%TEMP%\dsh-perf-c*`，脚本末尾自动清理。

# 附 B：本轮**不可测**清单（明确标注，不用估算冒充）

| 想知道什么 | 为什么不可测 | 需要什么才能测 |
|---|---|---|
| `onCreate` 主线程真实耗时（ms） | 无埋点；宿主无 Android 运行时 | 设备 + 一对 `elapsedRealtime` 埋点 |
| `WebView(this)` 构造耗时 | 同上 | 同上（`WebView` 前后各一个时间戳） |
| 解压的**设备**秒数 | 宿主 ≠ 设备（CPU/IO/文件系统全不同）；C-15 已证明同一段代码可差 3 个数量级 | 设备 + `refreshSnapshot` 五分段埋点 |
| `sweepExpired` 在真实用户设备上的成本 | 取决于来件数量，无样本 | 设备 + 该函数进出时间戳 + 真实来件量 |
| 会话 `Workspace` 泄漏的实际发生率 | 需要长时间会话开关循环 | 设备 + `dumpsys meminfo` 曲线 |
| 真机（arm64）冷启动分布 | 门禁 n=24 全来自 MuMu x86_64 | 真机补同口径采样（门禁注释已列为发布前必做） |
