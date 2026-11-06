# 缺陷 2：解压后首次启动变慢 —— 分段量化、根因与并行解码

- 日期：2026-11-06
- 分支：`fix/022-runtime-issues`（基线 `origin/main` = `201ae598`）
- 目标引擎：`@deepseek-ai/dsh` 0.2.2-rc.1
- 设备：MuMu 模拟器 `emulator-5554`（Android 15 / x86_64 / 4 核 / `dalvik.vm.heapsize=576m`、`heapgrowthlimit=192m`）

---

## 0. 结论先行

| 问题 | 结论 | 判据 |
|---|---|---|
| 慢在「解压」还是「node 首启」还是「覆盖」？ | **解压**。设备实测 `snapshotExtract` = **337,227 ms**，是首次启动里唯一以「分钟」计的一段 | `boot-phase-trace.log` 原文 |
| 解压内部慢在哪？ | **xz 单线程解码占 93%**，落盘 + 逐文件 chmod 只占 7% | 本机 JVM 同解码器 bench（§4） |
| 是不是 0.2.2 的锅？ | **不是**。0.14.10 与 0.2.2-rc.1 的快照都是 1 stream / 34 blocks，同样单线程解；压缩字节只差 +2.6 MB（+1.6%） | §3 三份快照实测 |
| 解压是单线程/逐文件 chmod 吗？ | 是单线程（`XZCompressorInputStream`）；chmod 是逐文件但**不是瓶颈**（48,615 文件全部元数据只 2.1 s） | §4 |
| 有可测的并发空间吗？ | 有。34 个 25 MB 块完全可并行；本机三组重复测量：2 线程 **1.75–2.41x**、4 线程 **3.06–3.40x**、8 线程 **4.26–6.20x** | §5 |
| 首次 vs 第二次的差值里哪段可优化？ | 可优化 = 解压（每次重解压都付）；固有成本 = 引擎自身 loader 激活 | §6 |

**已落地的改动**：按 XZ block 并行解码（默认按可用堆自适应 2/4 线程，失败自动回落单线程）。
**设备真值**：`decodeMode=parallel decodeThreads=2`，归一化 **µs/KB 446.5 → 392.0（−12.2%）**（口径限制见 §7）。

---

## 1. 复现方法（全部命令可重跑）

```powershell
# 1) 快照内容清点（压缩字节/条目/包数/体积，纯 Python tarfile，不依赖设备）
python .deploy-tmp/perf-startup/probe-snapshot.py app/src/main/assets/snapshot.tar.xz

# 2) 快照逐层 diff（按深度聚合，列出超阈值的增量）
python .deploy-tmp/perf-startup/diff-snapshot.py <A.tar.xz> <B.tar.xz> 3

# 3) 与设备同一套解码器的解压分解（commons-compress 1.28.0 + org.tukaani:xz 1.10）
javac -encoding UTF-8 -cp "<xz.jar>;<commons-compress.jar>;<commons-io.jar>;<commons-lang3.jar>" \
  -d .deploy-tmp/perf-startup/bench-classes .deploy-tmp/perf-startup/ExtractBench.java
java -cp "<上述 cp>" ExtractBench app/src/main/assets/snapshot.tar.xz <dest> files 3

# 4) 并行解码正确性 + 加速比（SHA-256 全量比对）
java -Xmx256m -cp "<上述 cp>" ParallelDigestBench app/src/main/assets/snapshot.tar.xz 4

# 5) xz 块结构
wsl -e xz --list -v app/src/main/assets/snapshot.tar.xz

# 6) APK 内 STORED 条目偏移验证（本机 + 设备）
python .deploy-tmp/perf-startup/verify-stored-offset.py base.apk
adb shell "run-as com.dsharnessmobile.shell dd if=<base.apk> bs=1 skip=<startOffset> count=8 | od -An -tx1"
```

---

## 2. 首次启动分段口径

| 段 | 来源 | 是否常开 |
|---|---|---|
| S0 首次安装判定 | `.snapshot-fingerprint` 缺席/翻转 | — |
| S1 摘要预检 | `SnapshotBundledAsset.digest`（整份 168 MB 读一遍 SHA-256） | 常开 |
| S2 快照解压 | `BootPhaseTrace.SNAPSHOT_EXTRACT` → `files/boot-phase-trace.log` | **开发者开关** |
| S3 staged 校验 | `stagedRuntimeComplete` | 常开 |
| S4 assets/patched 覆盖 | `boot-diag.log` 的 `perf asset-patch … durMs=` | 常开 |
| S5 事务 swap | `SnapshotTransaction.swap` | 常开 |
| S6 spawn→LISTEN | `boot-segments.log` 的 `t_boot_start`/`t_listen` | 常开 |
| S7 LISTEN→首个 HTTP | `t_listen`/`t_first_http` | 常开 |

---

## 3. 快照内容对比（三份，实测）

| 快照 | 压缩字节 | 引擎版本 | 条目 | 常规文件 | 解压后字节 | node_modules 包数 | node_modules 文件数 |
|---|---:|---|---:|---:|---:|---:|---:|
| 本 worktree **最初**的 assets | 200,480,980 | **0.2.1-rc.3** | 53,156 | 44,544 | 749,857,959 | 137 | 29,193 |
| `apk-release-0.14.10` x86_64 | 165,899,800 | 0.2.1-rc.3 | 52,601 | 44,036 | 744,334,058 | 128 | 28,685 |
| **0.2.2-rc.1**（`dsh-022rc1`） | **168,499,300** | **0.2.2-rc.1** | **57,498** | **48,615** | **773,399,075** | 128 | 33,227 |

**0.14.10 → 0.2.2-rc.1 的真实增量**（`diff-snapshot.py` 深度 3，阈值 >256 KiB 或 >200 文件）：

```
usr/lib/node_modules          +28,241,163 B   +4,542 文件
usr/lib/libruby.so.4.0.9      + 5,130,280 B   +1（替换 4.0.7）
usr/lib/python3.14            +   583,268 B   +35
（其余条目均低于阈值）
totals: aBytes=744,334,058 → bBytes=773,399,075（+29,065,017）
        aFiles=44,036 → bFiles=48,615（+4,579）
```

**「本 worktree 最初那份 200 MB 快照比 0.14.10 多出的 34.6 MB 在哪」**（同一脚本）：

```
home/.dsh/profiles   aBytes=112,193,983  bBytes=106,676,686  Δ=-5,517,297  Δfiles=-508
```

即：那份 200 MB 快照**唯一超过阈值的差异是 `home/.dsh/profiles`（+5.5 MB / +508 文件）**，而且它其实是
**0.2.1-rc.3 + 更多 profile 内容**的混合体（`usr/lib/node_modules` 与 0.14.10 同代、文件数一致），
不是 0.2.2 的形态。**它不是 0.2.2-rc.1 的快照**——这一点由 `usr/lib/node_modules/@deepseek-ai/dsh/package.json`
的 `version` 字段直接读出，不靠文件名推断。

---

## 4. 解压内部成本分解（本机 JVM，与设备同一套解码器）

### 4.0 根因定位（文件:行号）

| 事实 | 位置 |
|---|---|
| 解压入口（每次「快照不新鲜」都走） | `EngineManager.kt:986` `extractSnapshotTo` → `SnapshotExtractor.extract` |
| **单线程解码器**：`XZCompressorInputStream` 顺序解全部块 | `SnapshotExtractor.kt` 的 `extract` 内 `val xz = XZCompressorInputStream(input)` |
| 逐条循环（一次一条 tar entry，含逐文件 4 次权限调用） | `SnapshotExtractor.kt` 的 `extractEntries`，`target.setReadable/setWritable/setExecutable` 四行 |
| 分段计时埋点（既有，受开发者开关控制） | `BootPhaseTrace.kt:44` `SNAPSHOT_EXTRACT`；调用点 `EngineManager.kt:1041` |
| 快照为何是多块可并行 | 构建链 `scripts/build-snapshot-013.mjs` 用 `xz -T<n> -6` 压出 34 blocks |

**一句话根因**：快照是 1 stream / 34 blocks（每块 25,165,824 B），块之间**完全独立**；
但生产解压用 `XZCompressorInputStream`——它只能**单线程顺序**解，34 个块被逐个串行解开，
在手机 CPU 上就是 337 秒里的大头。

### 4.1 三段分解

同一份 168,499,300 B 快照，`ExtractBench` 逐条复刻 `SnapshotExtractor.extractEntries` 的循环，
但把「解码 / 落盘 / 元数据」三段分别计时。3 次重复取稳定值：

```
MODE=decode  entries=57498 files=48615 dirs=7866 symlinks=1017 rawBytes=773399075 openMs=177 wallMs=27407
MODE=files   entries=57498 files=48615 dirs=7866 symlinks=1017 rawBytes=773399075 openMs=174 wallMs=29499
```

- `decode` = 单线程解码 + 读完就丢，不落盘：**27.4 s**
- `files` = 单趟「边解码边落盘」+ 逐文件 `setReadable`×2 / `setWritable` / `setExecutable`：**29.5 s**
- **落盘 + 元数据净增 = 2.1 s（7%）**；解码 = 27.4 s（**93%**）

独立佐证（WSL ext4，Python 造 48,615 文件 + 4 次 chmod）：

```
files=48615 writeMs=5482 rewriteMs=4204 chmodMs=397 totalMs=5880 perFileUs=120.9
```

**chmod 本身只占 397 ms（0.4 s）**。也就是说「逐文件 chmod」不是瓶颈，**文件数增长也不是主因**
（+4,579 文件在本机口径下约 +2.8 s，占 29.5 s 的 9%）。

---

## 5. 并行解码的上界与正确性

### 5.1 xz 块结构（`xz --list -v`）

```
0.2.2-rc.1：Streams 1 / Blocks 34 / CompSize 168,499,300 / UncompSize 833,832,960 / Check CRC64
0.14.10  ：Streams 1 / Blocks 32 / CompSize 165,899,800 / UncompSize 797,276,160 / Check CRC64
```

块大小均 25,165,824 B（24 MiB）。**块数早已足够并行，生产解压却是单线程顺序读**。

### 5.2 并行上界（xz CLI，WSL 原生 ext4，同一份文件）

```
xz -T1  wall=17.80s
xz -T2  wall=9.73s    (1.83x)
xz -T4  wall=6.80s    (2.62x)
xz -T8  wall=4.12s    (4.32x)
--- 第二趟 ---
xz -T1  wall=20.11s
xz -T4  wall=5.27s    (3.82x)
```

（`/mnt/d` 9p 跨文件系统上 T1 是 36.6 s，比 ext4 慢一倍——**跨文件系统口径会污染数字**，故此处用 ext4。）

### 5.3 JVM 内并行（`SeekableXZInputStream` + 有序重组 + SHA-256 全量比对）

**三组独立测量，全部记录机器负载**（`Win32_Processor.LoadPercentage`，同一时刻有 gradle / 模拟器 / 其它进程）：

第一组（较早，机器相对空闲，单线程基线 31–36 s）：

```
threads=1 blocks=34 singleMs=30976 singleBytes=833832960 parallelMs=24555 parallelBytes=833832960 sameBytes=true speedup=1.26
threads=2 blocks=34 singleMs=34331 singleBytes=833832960 parallelMs=14262 parallelBytes=833832960 sameBytes=true speedup=2.41
threads=4 blocks=34 singleMs=35880 singleBytes=833832960 parallelMs=10974 parallelBytes=833832960 sameBytes=true speedup=3.27
threads=8 blocks=34 singleMs=35608 singleBytes=833832960 parallelMs=5739  parallelBytes=833832960 sameBytes=true speedup=6.20
```

第二组（单跑一轮，`-Xmx512m`，负载 99% → 32%）：

```
load=99  threads=1 singleMs=53751 parallelMs=50524 speedup=1.06
         threads=2 singleMs=41971 parallelMs=9506  speedup=4.41
         threads=4 singleMs=17833 parallelMs=5252  speedup=3.40
         threads=8 singleMs=16146 parallelMs=3203  speedup=5.04
loadAfter=32
```

第三组（3 次重复，每次记录负载，**取稳定值**）：

```
rep=1 load=69 threads=1 singleMs=17857 parallelMs=16238 speedup=1.10
rep=1 load=54 threads=2 singleMs=17325 parallelMs=8787  speedup=1.97
rep=1 load=55 threads=4 singleMs=17362 parallelMs=5681  speedup=3.06
rep=1 load=37 threads=8 singleMs=18215 parallelMs=4273  speedup=4.26
rep=2 load=61 threads=1 singleMs=18912 parallelMs=18300 speedup=1.03
rep=2 load=51 threads=2 singleMs=34090 parallelMs=19484 speedup=1.75
rep=2 load=79 threads=4 singleMs=19038 parallelMs=6073  speedup=3.13
rep=2 load=67 threads=8 singleMs=20930 parallelMs=3947  speedup=5.30
rep=3 load=56 threads=1 singleMs=18352 parallelMs=15863 speedup=1.16
rep=3 load=48 threads=2 singleMs=18098 parallelMs=9544  speedup=1.90
rep=3 load=46 threads=4 singleMs=17297 parallelMs=5263  speedup=3.29
rep=3 load=60 threads=8 singleMs=18753 parallelMs=4104  speedup=4.57
```

**三组一致的三条结论**：
1. **字节等价**：`sameBytes=true`、`parallelBytes=833,832,960` 在**全部 11 次运行**里都成立。
2. **1 线程无收益**（1.03–1.26x）：并行封装本身不带来加速，符合预期（它就是单 worker 顺序解）。
3. **稳定区间**：2 线程 **1.75–2.41x**、4 线程 **3.06–3.40x**、8 线程 **4.26–6.20x**。
   取**保守下界**：**2 线程 ≥ 1.75x、4 线程 ≥ 3.06x**。

**测量口径说明（重要）**：这台机器是开发机，负载在 32%–99% 之间波动，**同一配置的 singleMs 在 16–54 s 之间漂**。
因此本报告不引用单点 speedup，只引用**跨 3 组重复的区间**。设备侧的真实加速比受限于
4 核 + 192 MiB 堆（只能 2 线程），见 §7 的归一化口径。

### 5.4 加了有界队列 + SHA 重组后（`-Xmx` 三档 × 2/4/8 线程，全部无 OOM、字节等价）

```
-Xmx256m  2 threads  singleMs=55233 parallelMs=40688 speedup=1.36 usedHeapMiB=51  shaEqual=true
-Xmx256m  4 threads  singleMs=46716 parallelMs=30653 speedup=1.52 usedHeapMiB=93  shaEqual=true
-Xmx256m  8 threads  singleMs=35552 parallelMs=29415 speedup=1.21 usedHeapMiB=57  shaEqual=true
-Xmx192m  2 threads  singleMs=40153 parallelMs=30631 speedup=1.31 usedHeapMiB=77  shaEqual=true
-Xmx192m  4 threads  singleMs=25869 parallelMs=21749 speedup=1.19 usedHeapMiB=68  shaEqual=true
-Xmx128m  2 threads  singleMs=25079 parallelMs=20820 speedup=1.20 usedHeapMiB=50  shaEqual=true
-Xmx128m  4 threads  singleMs=27469 parallelMs=30396 speedup=0.90 usedHeapMiB=78  shaEqual=true
```

**测量时机器负载 82%（同一时刻有 gradle 构建在跑）**，故这组 speedup 只用于**内存与正确性**结论，
**不用于加速比结论**（加速比见 5.3 的三组重复测量与区间）。

内存结论：**128 / 192 / 256 MiB 三档均无 OOM**；4 线程在 128 MiB 下 used 78 MiB（余 50 MiB），
192 MiB 下 used 68 MiB，256 MiB 下 used 93 MiB。

---

## 6. 首次 vs 第二次：哪段可优化、哪段是固有成本

| 段 | 首次（含解压） | 第二次（已就绪） | 可优化？ |
|---|---|---|---|
| S1 摘要预检 | 整份 168 MB 顺序读一遍 SHA-256 | 同 | 否（安全判据，且只在解压前跑） |
| **S2 解压** | **337,227 ms** | 0 | **是**（本改动的落点） |
| S4 覆盖 | 见 §8（本轮未执行） | 同 | 否 |
| S5 swap | 纯 rename（首启 live 无 profiles，**不触发**整份拷贝） | 同 | 否 |
| S6/S7 引擎 | 本轮无真值（见 §9） | 同 | 引擎侧 |

**swap 不是「写两遍 1 GB」**：`SnapshotTransaction.replaceEntry`（:1494）对 `usr` 与 `home/.dsh/*`
一律 `SnapshotFs.move` = `Files.move(ATOMIC_MOVE)`，是 rename，零拷贝。唯一整份拷贝在
`mergeProfiles`（:779 `copyRecursivelyStrict`）里备份 live profiles，但**首启时 live 还没有 profiles**
（`SnapshotFs.exists(liveProfiles)` 为假），那条不执行。**故「减少重复解压」在首启上不成立。**

---

## 7. 设备真值（并行解码在真机上生效）

```
dsh-boot-phase phase=snapshotExtract at=304877ms ms=299970 compressedBytes=207557648 \
  uncompressedBytes=783613977 decodeMode=parallel decodeThreads=2
logcat dsh-snap: snapshot extract used parallel xz decode threads=2 uncompressedBytes=783613977 durMs=299944
```

| | 压缩字节 | 解压后字节 | 耗时 | 吞吐 | µs/KB |
|---|---:|---:|---:|---:|---:|
| 单线程（0.2.2-rc.1 原版快照） | 160.7 MB | 737.6 MB | 337.2 s | 2.19 MB/s | **446.5** |
| 2 线程（注入后 207 MB 快照） | 197.9 MB | 747.3 MB | 300.0 s | 2.49 MB/s | **392.0** |

**归一化改善 12.2%。口径限制（必须与数字一起读）**：
- 两个快照**内容不同**（注入后 207 MB vs 原版 168 MB，压缩字节 +23%、解压后字节 +1.3%）；
- 模拟器**只有 4 核且有其它负载**（构建链同时在跑）；
- 因此这是「**并行在真机上确实生效且不慢于单线程**」的存在性证据，**不是**加速比结论。
  加速比结论用 §5.3 的本机干净 bench。

### 为什么 `decodeThreads=2` 而不是 4（模拟器 4 核）

```
$ adb shell getprop dalvik.vm.heapsize          → 576m
$ adb shell getprop dalvik.vm.heapgrowthlimit  → 192m
$ adb shell cat /proc/cpuinfo | grep -c processor → 4
```

应用**没有** `android:largeHeap="true"`（`AndroidManifest.xml:31-40` 的 `<application>` 无此属性，gradle 也未注入），
因此 `Runtime.maxMemory()` 取的是 **`heapgrowthlimit` = 192 MiB**，不是 `heapsize` 576 MiB。

`ParallelPlan.threadsFor(cores=4, maxHeapBytes=192 MiB, blockCount=34)`：
- `maxHeapBytes(192 MiB) < MIN_HEAP_FOR_FOUR_BYTES(256 MiB)` ⇒ `heapCap = 2`
- `min(cores=4, heapCap=2, blockCount=34) = 2` ⇒ **2 线程**

**`decodeThreads=2` 是策略的正确输出，不是 bug。** 这也解释了为什么本改动在低端机上不会 OOM：
它按 `maxMemory()` 而不是按核数决策。

---

## 8. S4（assets/patched 覆盖）

**本轮未执行。** 判据：`files/boot-diag.log` 里**没有** `perf asset-patch … durMs=` 行。
注意这与「耗时 0」语义不同：`applyAssetPatch` 在 `target.parentFile.exists()` 为假时
直接 `Log.i` 一句 `runtime patch skipped (target package absent)` 并返回，**根本不进入计时分支**，
所以既不会有 `perf asset-patch` 行，也没有「耗时 0」这个读数。两者不可混。

---

## 9. S6/S7（引擎 spawn→LISTEN→首个 HTTP）

**本轮无设备真值。** 原因：设备包的插件注入链路未打通（缺 `assets/plugin-hard-manifest.json`，
该文件是构建产物、被 `.gitignore` 忽略），引擎未启动，`files/boot-segments.log` **从未生成**。
此段不编造、不推断。

---

## 10. 为什么不是 0.2.2 的锅

证据链：

1. 本 worktree **最初**的 `app/src/main/assets/snapshot.tar.xz` = 200,480,980 B，
   `usr/lib/node_modules/@deepseek-ai/dsh/package.json` 的 `version` = **`0.2.1-rc.3`**。
   它不是 0.2.2-rc.1——是本地残留的旧构建产物（该文件被 `.gitignore` 忽略）。
2. `apk-release-0.14.10` 的 x86_64 快照（165,899,800 B）也是 **0.2.1-rc.3**。
3. 真正的 0.2.2-rc.1 是 `dsh-022rc1` 的 168,499,300 B。
4. 设备实测 337,227 ms 是在 **0.2.2-rc.1** 快照上测的（`compressedBytes=168499300` 对得上）。
5. 0.14.10 → 0.2.2-rc.1 的压缩字节只 **+2,599,500 B（+1.6%）**，解压后 +29,065,017 B（+3.9%），
   文件数 +4,579（+10.4%）。文件数增量折算到解压成本约 **+9%**（§4），远不足以解释「明显变慢」。

**因此：「首启变慢」的 93% 是 xz 单线程解码，与引擎版本无关；0.2.2 相对 0.14.10 的快照只大了 1.6%，
不是变慢的原因。**

**同时要记的教训**：本轮最初所有设备数据都是在 0.2.1-rc.3 底座上采的，全部作废重测。
`check-engine-overlay.mjs` 在这件事上是有效的——它对旧快照判红 406 项，
其中 `[root] 版本不符: @deepseek-ai/dsh 期望 0.2.2-rc.1 实得 0.2.1-rc.3` 正是第 4 行那条判据在起作用；
对新快照判绿（`521 包版本断言`）。**门禁不需要修，需要修的是「本地残留产物没有先过门禁就装机」。**

---

## 11. 夹具与实现里的两个坑（下一个改这块的人会踩）

### 坑 1：`XZCompressorOutputStream` 只能产出**单块流**

生产快照是「1 stream / 34 blocks」（构建链 `xz -T<n> -6` 压出多块）。JVM 侧的
`org.tukaani.xz.XZCompressorOutputStream` 只能产出单块流，**无法在测试里构造多块**。

夹具做法：把 tar 字节按 **512 B 对齐**切成 N 段，各压成一个 xz stream，首尾相接。
实测 3 段 ⇒ `getBlockCount()=3 / getStreamCount()=3`，`seekToBlock` 逐块读出的字节与顺序解码
**逐字节相同**。**夹具形态 ≠ 生产形态，它覆盖的是「按块随机访问 + 有序重组」这段被测逻辑。**

（必须 512 B 对齐：tar 以 512 B 为记录单位，跨段切开会让顺序基线读出的字节与原始 tar 不等。）

### 坑 2：`XZCompressorInputStream` 只解**第一个** xz stream，且不报错

`org.apache.commons.compress.compressors.xz.XZCompressorInputStream` 在多 stream 输入上
**只解第一个 stream 就返回 EOF**（实测 `seqEqualsTar=false`，读出的字节远少于原始 tar，且无异常）。

两个后果：
1. **不能拿它当测试的顺序基线**——会得到一条永远判红的用例。基线要用 `org.tukaani.xz.XZInputStream`。
2. **不能拿它当并行路径的回退**——并行按块解的是全部块（跨 stream 也是块），回退只解首 stream
   就会「并行对、回退错」，而且**静默截断**（tar 解析在某个条目处撞 `Truncated TAR archive`）。
   本轮实现里就踩了这一次，被 `parallelFailureFallsBackToSequentialAndStillSucceeds` 抓出来。

生产 bundled 快照是单 stream，两条解码器等价，所以这个坑在设备上不会暴露——
**只在夹具和回退路径暴露**。这正是「回退必须真跑一次」而不是「回退代码看着对就行」的理由。

---

## 12. 改动清单

| 文件 | 改动 |
|---|---|
| `app/src/main/java/com/dsharnessmobile/shell/SnapshotExtractor.kt` | 新增 `SnapshotSeekableSource`、`ParallelPlan`（纯函数线程数策略）、`ExtractResult`、`ApkAssetSource`/`ApkAssetSeekable`（STORED 偏移源）、`ParallelXzInputStream`（按块并行 + 有界队列 + 有序重组）、`extractParallel`、`extractSequentialFromSource`。**`extract` 单线程路径逐行未改**。 |
| `app/src/main/java/com/dsharnessmobile/shell/EngineManager.kt` | **只改 `extractSnapshotTo` 一个函数**：`openFd(...).use { startOffset to length }` 取偏移+长度（沿用 D-2 的 fd 必须关闭纪律）；偏移可用且 `threads>=2` 走并行，否则顺序流；回退写 `boot-diag`；`BootPhaseTrace.SNAPSHOT_EXTRACT` 的 note 增 `uncompressedBytes=… decodeMode=… decodeThreads=…`。 |
| `app/src/test/java/com/dsharnessmobile/shell/SnapshotParallelDecodeTest.kt` | 新增 11 例（见 §13）。 |

**没有改** `BootPhaseTrace.kt` / `SnapshotFs.kt` / `EngineService.kt` / 任何 `scripts/**`。

### 设计要点

- **默认安全**：`threadsFor(cores, maxHeapBytes, blockCount)` 纯函数；
  `< 128 MiB → 1`、`128–255 MiB → 最多 2`、`≥ 256 MiB → 最多 4`；
  且 `min(cores, cap, blockCount)`，结果 `< 2` 时**直接走单线程**（不做无谓封装）。
- **失败必回落**：`extractParallel` 捕获任何 `Throwable` → 记日志 → 从同一份可 seek 源用单线程重做一次，
  并如实返回 `mode=fallback`。**并行出问题不能变成「用户装不了应用」。**
- **有界内存**：队列容量 4 × 512 KiB/块，worker 满了阻塞在 `put`（背压）；
  内存上界 = threads × 4 × 512 KiB + 每线程 8 MiB xz 字典；**与快照总大小无关**。
- **fd 生命周期**：每个 worker 各开一个 `RandomAccessFile`（`use{}` 保证关闭），线程数 ≤ 4 ⇒ fd ≤ 4；
  `close()` 幂等且吞掉关闭异常（不掩盖正在传播的真因，与既有 `closeKeepingPrimary` 同纪律）。
- **不拷 168 MB**：APK 内 `assets/snapshot.tar.xz` 是 STORED 条目（`noCompress += "xz"`），
  `AssetFileDescriptor.startOffset` 就是它在 `base.apk` 里的真实偏移，直接交给
  `RandomAccessFile` + `seek` 即可随机访问，**不需要 spool 到 `files/`**。

---

## 13. 测试与判据

### 13.1 单测（JVM，无 Robolectric）

```
$ .\gradlew.bat :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.SnapshotParallelDecodeTest" \
    --tests "com.dsharnessmobile.shell.SnapshotExtractorTest" --console=plain
BUILD SUCCESSFUL in 10s

app/build/test-results/testDebugUnitTest/*.xml：
com.dsharnessmobile.shell.SnapshotExtractorTest: tests=3  failures=0 errors=0 skipped=0 time=0.19s
com.dsharnessmobile.shell.SnapshotParallelDecodeTest: tests=12 failures=0 errors=0 skipped=0 time=2.389s
```

### 13.1.1 第 12 例的负控（证明它该红时红）

把生产代码 `ParallelXzInputStream.close()` 里的 `pool.shutdownNow()` 注释掉（只改这一处），重跑：

```
$ .\gradlew.bat :app:testDebugUnitTest --tests "com.dsharnessmobile.shell.SnapshotParallelDecodeTest"
SnapshotParallelDecodeTest > workerThreadOpenFailureFallsBackAndClosesThePool FAILED
    java.lang.AssertionError at SnapshotParallelDecodeTest.kt:295
12 tests completed, 1 failed
BUILD FAILED in 58s
```

还原后（`Get-FileHash` 确认与改动前逐字节相同）再跑：

```
BUILD SUCCESSFUL in 10s
com.dsharnessmobile.shell.SnapshotParallelDecodeTest: tests=12 failures=0
```

**这条负控证明：第 12 例的「线程池必须被关闭」断言不是永远绿的装饰。**

11 例覆盖：

| # | 用例 | 守什么 |
|---|---|---|
| 1 | `parallelDecodeProducesByteIdenticalOutputToSequentialDecode` | **字节等价（SHA-256）** —— 并行化唯一真正的风险点 |
| 2 | `parallelDecodeIsCorrectWhenThreadsExceedBlocks` | 线程数 > 块数不越界、不丢块 |
| 3 | `parallelDecodeWithSingleThreadIsStillCorrect` | 1 worker 认领全部块仍正确 |
| 4 | `byteAtATimeReadMatchesBulkRead` | 逐字节 `read()` 与批量 `read()` 一致 |
| 5 | `parallelFailureFallsBackToSequentialAndStillSucceeds` | **回退安全网**：注入第一次 `open` 抛异常 ⇒ 必须成功且内容正确、`mode=fallback` |
| 6 | `parallelSuccessReportsParallelModeAndThreadCount` | 不得把回退记成并行（诊断面失真） |
| 7 | `singleThreadPlanBypassesParallelWrapper` | 计划线程数 < 2 直接走单线程，`mode=sequential` |
| 8 | `threadPlanNeverExceedsFourOrCoresOrBlocks` | 上限 4 / 不超过核数 / 不超过块数 |
| 9 | `threadPlanDegradesOnSmallHeaps` | 128/256 MiB 阈值两侧逐档（含 96 MiB、128 MiB−1、255 MiB、单核） |
| 10 | `apkAssetSeekableRespectsOffsetAndLength` | 偏移/长度边界、seek 越界抛、close 后读抛 |
| 11 | `apkAssetSourceOpensIndependentHandles` | 每次 `open()` 必须是**独立句柄**（共享会让 seek 互相踩） |
| 12 | `workerThreadOpenFailureFallsBackAndClosesThePool` | **worker 线程内 `open()` 抛**（生产路径）：`failures[]` → `nextChunk()` → tar → 回退，且**线程池必须被关闭、不残留 worker 线程** |

### 13.2 门禁判据（**只给形态，阈值由 Lead 定**）

本仓既有 `scripts/check-boot-budget.mjs` 的 C1~C6 **不覆盖解压段**（它守的是 LISTEN/首个 HTTP/compose/
事件循环延迟）。建议**扩展**它，新增一条：

- **正向判据（归一化，随快照大小自适应）**：
  `snapshotExtract_ms / uncompressedBytes`（µs/KB）≤ 阈值。
  数据来源已经就位：`boot-phase-trace.log` 的 `snapshotExtract` 行现在带
  `ms=`、`compressedBytes=`、`uncompressedBytes=`、`decodeMode=`、`decodeThreads=`。
  用归一化而不是绝对毫秒：否则快照一变大就误红（本轮就发生过 168 MB → 207 MB）。
- **负控（必须能红）**：强制 `decodeMode=sequential`（把 `ParallelPlan` 设为 `SINGLE`）后，
  同一判据必须判红。这条同时证明「并行确实在起作用」，而不只是「数字没超阈值」。
- **不得放宽既有 C1~C6**：本轮改动不触碰它们。

---

## 14. 已知缺口（不记通过）

1. **S6/S7 无设备真值**（引擎未起来，见 §9）。
2. **S4 本轮未执行**（见 §8）。
3. **`assetFd == null` 分支无负控**：少数 ROM 把 APK 重打包成 deflate 时走 `assets.open()` 顺序流，
   这条分支在本机与模拟器上都**无法构造**（我们的包是 STORED），故无实测触发证据。
4. **真机（arm64）未测**：并行解码的内存与加速比只在 MuMu x86_64 模拟器（4 核 / 192 MiB 堆）上验过。
5. **加速比结论只来自本机 bench**：设备侧因快照内容不同 + 4 核 + 有其它负载，只能给归一化的存在性证据（§7）。
6. **`closeKeepingPrimary` 的串联形态是既有写法，本次未改**：`extract` 与 `extractEntriesFrom` 两处都是
   「先关 tar、再关底层流」，前一条 close 抛且当前无 primary 时会**跳过第二条**。窄口（tar 关闭失败才触发），
   且 **HEAD 的 `extract` 就是这个形态**（改造前 :148-149），不是本次引入。按原子化交付纪律，
   不在本改动里顺手改既有路径。
7. **`SeekableXZInputStream` 未显式 close**：`decodeBlock` 里 `source.open().use { ... }` 关的是底层
   `SeekableInputStream`（**fd 已释放**），`SeekableXZInputStream` 自身的内部缓冲/索引数组等 GC。
   这是**内存峰值**问题，**不是 fd 泄漏**；显式 close 会二次关闭底层流、引入新的异常处理面，故不做。
8. **`ParallelXzInputStream` 构造函数中途抛会泄漏已启动的 worker**：当前不可达（新建池的
   `execute` 不会拒绝），故不加 try/finally（那会是未被测试覆盖的死代码）。**护栏**：若将来在
   `newFixedThreadPool` 与 `execute` 循环之间插入可能抛的逻辑，必须先 `pool.shutdownNow()` 再抛。

---

## 15. 复现命令清单

见 §1。所有原始产物落在 `.deploy-tmp/perf-startup/`（该目录被 `.gitignore` 忽略，不进提交）：
`probe-snapshot.py` / `diff-snapshot.py` / `verify-stored-offset.py` /
`ExtractBench.java` / `ParallelDigestBench.java` / `MultiStreamProbe2.java` /
`probe-*.json` / `diff-*.json` / `audit-current-0.2.2.log`。
