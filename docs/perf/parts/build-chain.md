# A 块：构建链耗时分解 + 构建缓存 + 产物体积构成

- 审计时间：2026-11-02 / 工作区 _dsh-wt/perf-audit（分支 perf/audit-2026-11-02，HEAD 47869404 = origin/main）
- 辅助脚本：scripts/perf-audit-a/（本报告所有数字可用其中脚本复现）
- 环境：Windows 宿主 / Node v24.17.0 / Python 3.14.9 / JDK 17.0.2 / C:\Windows\System32\tar.exe (bsdtar) / Git 自带 GNU tar 1.35 与 xz.exe
- 度量纪律：所有计时均在多 agent 并发负载的宿主上测得，绝对值偏高；体积/文件数/条目数/sha256 这类静态计数不受 CPU 抖动影响，是本报告最硬的证据。计时只用于同机同轮内做相对排序。

---

## 0. 结论速览

| # | 结论 | 收益量级 | 风险 | 工作量 |
|---|---|---|---|---|
| A-1 | check-gate-skips.mjs 单条 210.8s / 245.7s（两次实测），是链前门禁的单一支配项。根因 = 把 scripts/ 下全部 79 个 check-*.mjs 逐个 spawn（并发 8，串行总和 708.2s） | 单条可砍 140-190 s/次构建 | 低 | M |
| A-2 | **【已按 Lead 纠正修订，结论方向反转】** 磁盘上的 app/src/main/assets/snapshot.tar.xz 是一次 **-Fast 构建的残留产物**（实测 xz -1 -T1 逐字节复现 200,877,488 B / sha256 相同），**不是发布档产物**。因此它 191.57 MiB 的体积不代表发布包体积，**不能据此推断发布链有体积缺陷**。发布路径默认 preset 9（inject-all.py:8、:155「默认 9 保发布保真」），preset 1 是 -Fast 档刻意的 380s→75s/遍 取舍 | **无体积优化收益**（此项从改进项移出）。改列为**防线项**：FAST 档产物不应留在被视为发布输入的路径上 | 低 | S |
| A-3 | 构建链存在两次全量压缩，第一次（xz -T8 -6，85-87 s）的产物被 inject 步骤整份重压丢弃，对最终产物零贡献 | 白费 85-87 s/ABI，双 ABI 约 172 s | 低 | M |
| A-4 | out/v0.14.9 的 APK 不能当体积基线（内嵌 157.86 MB 旧快照，当前 assets 200.88 MB）。真实基线约 206 MB，snapshot 占 96.8% | — | — | — |
| A-5 | 内嵌快照 59.54 MiB（8.32%）是 node_modules 内可删集合；另有 90.79 MiB 基座文档/开发工具面 | 压缩后约 6-8 MiB APK | 中 | M |
| A-6 | Gradle 硬编码 --no-daemon，每次构建白付 28-30 s 配置阶段（Task Execution 只占 8.8%） | 全链省约 60 s | 低 | S |
| A-7 | 9 道快照门禁各自独立全量解码 tar（xz 不可随机寻址），地板成本 20-26 s/次 | 双 ABI 省约 344 s | 中 | M |
| A-8 | 三个 tar 体积差异已归因，**两半**：一半是**档位差**（assets 是 Fast 档 preset 1，snapshot/ 是发布档 preset 9）；另一半是**内容差**（assets 53,178 条目 / 引擎 0.2.1-rc.3 vs snapshot/ 49,113 条目 / 引擎 0.1.7-rc.2）。不是同一内容的不同 ABI 打包 | — | — | — |

---

## A0. 复现入口

所有辅助脚本在 scripts/perf-audit-a/：

| 脚本 | 用途 |
|---|---|
| tarls.py | tar 成员级统计（不落盘）：顶层目录/包名/扩展名/可删集合，输出 JSON |
| apkzip.mjs | 读 APK zip central directory，按条目统计 compressed/uncompressed/对齐 |
| apk-entry-hash.mjs | 从 APK 内 stored 条目直接算 sha256（判定 APK 里到底是哪份快照） |
| probe-apk-snapshot.py | 不落盘，把 APK 内 snapshot 条目不落盘喂 lzma+tarfile，判 ABI/引擎版本/条目数 |
| probe-tar-identity.py | 只读 usr/bin/node 的 ELF e_machine + 引擎 package.json，判 ABI 与版本 |
| compare-tars.mjs | 两份 tar 的成员集合差分 |
| prefix-rollup.mjs | 按路径前缀（深度 N）汇总字节数 |
| dup-instances.py | 同一包名多份实例的多余副本字节数 |
| dup-packages.py | 同一包名多版本清单 |
| scan-tarstream.py | 逐 512B 头扫 tar 流：数据块 vs 头开销 vs PAX 扩展头 |
| extract-paths.py | 只取指定成员（读 cordis.patch.yml / package.json 等小文件） |
| grep-in-tar.py | 在 tar 内按内容搜索（不落盘） |
| deflate-probe.py | 量化 noCompress 的代价（对 xz 做真 DEFLATE） |
| bytesio-mem-probe.py | 量化 inject-*.py 的 BytesIO 内存倍率 |
| xz-recompress-probe.py | 同输入不同压缩档的产物体积对照 |
| probe-gate-cost.mjs | 复现 check-gate-skips 的探针池：逐门禁 spawn + 计时 |

---

## A1. 全链耗时分解

### A1.0 链路结构（逐行读 scripts/build-apk-013.ps1，532 行）

```
build-apk-013.ps1
|- 0. node --test x4 回归（ps1:25）
|- 1. 注入集产物重建 npm run build xN（ps1:44-60，读 scripts/plugin-dirs.json）
|- 2. 链前门禁 24 道（ps1:66-224），与 ABI 无关，每次构建跑一次；含 check-gate-skips（ps1:104）
|- 3. foreach ($abi in arm64, x86_64)        <- 以下全部 x2
|     |- 3a. check-engine-overlay（ps1:276）
|     |- 3b. vendor 暂存 + 浏览器语法降级（ps1:336）
|     |- 3c. inject-all.py 单 pass 注入（ps1:356）   <- 解压+重压缩一次
|     |- 3d. 注入产物门禁 7 道（ps1:360-390）
|     |- 3e. 快照门禁 8 道（ps1:399-460）
|     |- 3f. build-apk-engine.mjs assemble（ps1:478）
|     |      = copyFileSync(snapshot) + sha256 + build-hard-manifest + fingerprint
|     |        + gradlew :app:assembleDebug --no-daemon
|     |- 3g. check-snapshot-decode（ps1:492，全量解码一遍）
|- 4. check-apk-signatures --self-test + verify --dir（ps1:523-526）
```

F-1（结构性事实）：-Fast 只改两处（ps1:15-19）—— OnlyAbi 缺省 x86_64 与 $env:DSH_INJECT_PRESET='1'。门禁集完全不缩。所以「Fast 迭代快」的收益全部来自少一个 ABI，不是门禁少。

### A1.1 Gradle JVM 启动基线

命令：.\gradlew.bat --version --offline --console=plain  x5

| run | ms |
|---|---:|
| 1 | 2224 |
| 2 | 1618 |
| 3 | 1577 |
| 4 | 1583 |
| 5 | 1658 |

中位 1618 ms，min 1577 / max 2224。这是「什么都不做也要付」的地板。

### A1.2 配置阶段（不执行任何 task）

命令：.\gradlew.bat :app:tasks --dry-run --offline [--no-daemon] --console=plain

无 daemon：38896 / 28457 / 31057 / 34868 / 38325 ms，中位 34868，min 28457 / max 38896
带 daemon：4651 / 4370 / 6106 ms，中位 4651，min 4370 / max 6106

F-2（核心，可直接落行）：build-apk-engine.mjs:86 硬编码了 --no-daemon：

```js
const gradleArgs = [':app:assembleDebug', '--no-daemon', `-PversionNameSuffix=${suffix}`]
```

--no-daemon 让纯配置阶段每次多付约 28-30 s。双 ABI 全链 = 调用 2 次 = 每次构建白付约 60 s。这是本块最廉价、风险最低的一项。

### A1.3 真实 assembleDebug：4 组对照

| 场景 | assets/snapshot.tar.xz | 结果 | ms |
|---|---|---|---:|
| A 冷（1 KB 占位） | 1024 B | BUILD SUCCESSFUL 1m44s，36 tasks: 17 executed, 19 from cache | 107320 |
| B 热（1 KB 占位） | 1024 B | BUILD SUCCESSFUL，全部 UP-TO-DATE | 97864 |
| C 冷（真实 200.88 MB） | 200877488 B | BUILD SUCCESSFUL 1m16s，36 tasks: 3 executed, 33 up-to-date | 78377 |
| D 热（真实，--profile） | 200877488 B | BUILD SUCCESSFUL 42.5s | 43167 |

D 的 Gradle 官方 profile（build/reports/profile/profile-2026-11-02-21-51-58.html）：

| 段 | 秒 |
|---|---:|
| Total Build Time | 42.519 |
| Startup | 13.813 |
| Settings and buildSrc | 3.174 |
| Loading Projects | 0.289 |
| Configuring Projects | 11.774 |
| Artifact Transforms | 0 |
| Task Execution | 3.746 |

关键读数：真正干活（Task Execution）只占 3.746 / 42.519 = 8.8%，其余 91.2% 是 Gradle 自身启动 + 配置。
另一份 profile（profile-2026-11-02-21-43-05.html，冷跑）：Startup 39.271 s / Configuring 28.271 s / Task Execution 4.617 s —— 冷跑时 94.2% 的时间与「编译」无关。

逐 task 耗时（from D 的 profile）：mergeDebugAssets 0.950 s / compileDebugAidl 0.621 s / compileDebugKotlin 0.514 s / mergeDebugResources 0.284 s / processDebugResources 0.178 s / packageDebug 0.163 s。
即 200.88 MB 的资产只花 0.950 s —— 印证 noCompress += "xz" 让它只做 copyFileSync，而不是压缩。

负控：同一个 assembleDebug，无 daemon 冷跑 107320 ms vs 带 daemon 配置 4651 ms，23 倍差，说明计时确实抓到了 daemon 冷启动。1 KB 占位（107320）反而比真实 200 MB 资产（78377）慢，因为前者首次填充 build cache —— 证明资产大小不是这个任务的主导项。

### A1.4 链前门禁（24 道，与 ABI 无关，每次构建跑一次）

| 门禁 | ms | exit |
|---|---:|---:|
| check-gate-skips | 299096 / 210835 / 245713 | 1 |
| check-patch-test-manifest | 61296 | 0 |
| check-build-chain-abort --self-test | 23386 | 0 |
| check-code-map | 2357 | 0 |
| check-plugin-tests | 1920 | 2 |
| check-patch-fixtures | 1830 | 0 |
| check-bounded-io | 1088 | 0 |
| check-kotlin-comments | 979 | 0 |
| check-tool-name-promises | 943 | 0 |
| check-build-parallel-cap | 741 | 0 |
| check-boot-budget | 642 | 0 |
| check-snapshot-builder-output | 427 | 0 |
| check-kotlin-test-count --allow-missing | 410 | 0 |
| check-control-ops | 401 | 0 |
| check-patch-mirror | 400 | 0 |
| check-bridge-symmetry | 400 | 0 |
| check-manifest-hardening | 397 | 0 |
| check-dead-tokens | 335 | 2 |
| check-state-registry | 309 | 0 |
| check-protocol-v2 | 293 | 1 |
| check-mirror-parity | 282 | 0 |
| check-engine-heap-floor | 252 | 0 |
| check-snapshot-fingerprint | 227 | 1 |
| check-op-registry-parity | 215 | 0 |

合计（已计时部分）：398,626 ms。其中 check-gate-skips 占 245,713 / 398,626 = 61.6%（按单次口径）。

注：exit 1/2 是净检出工作区缺前置导致的（无 assets/snapshot.tar.xz 声明值、无 plugins/*/lib、WSL 基座不在场），不是本审计引入的缺陷。

与 D 块的差异说明：D 块报「41 条合计 216,520 ms，其中 check-gate-skips 单条 174,660 ms = 80.7%」。我这两次独立实测为 210,835 / 245,713 ms。量级一致、绝对值更高（差值来自宿主并发负载不同）。结论不变且更强：check-gate-skips 是链前门禁的单一支配项。以 D 块的 80.7% 作为对外口径，以我的绝对值作为复核。
### A1.5 check-gate-skips 为什么这么慢（根因，已定位到行）

它把 scripts/ 下全部 79 个 check-*.mjs 真的 spawn 了一遍。代码在 scripts/check-gate-skips.mjs：

| 行 | 内容 |
|---|---|
| 263 | const PROBE_TIMEOUT_MS = 600 * 1000 |
| 265 | const PROBE_CONCURRENCY = 8 |
| 274-309 | probeGate()：spawn(process.execPath, ['--require', hookPath, join(SCRIPTS, file), ...extraArgs]) —— 每个门禁一个独立 node 进程 |
| 312-324 | probeAll()：8 路并发池 |
| 676 | allGateFiles = collectGateFiles(SCRIPTS).sort().filter(f => f !== 'check-gate-skips.mjs') |
| 684-686 | 第一轮：probeAll(gateFiles.map(file => ({file, args: []}))) —— 79 个全跑 |
| 689 | strictTargets = gateFiles.filter((file, i) => firstPass[i].ran && firstPass[i].skipLines.length > 0) |
| 693-696 | 第二轮：对「发射了 SKIP」的门禁再用 ['--require'] 重跑一遍 |

用 probe-gate-cost.mjs 复现这个探针池（只测量、不判据、不写 hook），实测：

```
gates = 79, concurrency = 8
wallMs           = 240,872 ms   <- 与门禁自身 210-246 s 同量级，互为验证
serialSumMs      = 708,206 ms   <- 串行总和
totalMsTop5      = 478,635 ms   <- Top-5 占串行总和的 67.6%
totalGatesOver1s = 31
```

Top-10 逐门禁耗时：

| 门禁 | ms | 占 serialSum |
|---|---:|---:|
| check-script-tests.mjs | 222,579 | 31.4% |
| check-release-gates.mjs | 103,251 | 14.6% |
| check-patch-test-manifest.mjs | 71,153 | 10.0% |
| check-code-map-anchors.test.mjs | 41,364 | 5.8% |
| check-snapshot-decode.mjs | 40,288 | 5.7% |
| check-upstream-patch-bytes.test.mjs | 40,142 | 5.7% |
| check-patch-mirror.test.mjs | 31,271 | 4.4% |
| check-apk-signatures.test.mjs | 18,029 | 2.5% |
| check-degrade-source-of-truth.test.mjs | 12,729 | 1.8% |
| check-runtime-assets-companions.test.mjs | 11,684 | 1.6% |

三个结构性问题（都能落到行）：

F-3（元门禁套娃）：check-release-gates.mjs 本身是聚合入口（103.3 s），check-gate-skips.mjs 又把它当普通门禁 spawn 一次；而 check-release-gates.mjs 的 --run 模式会再 spawn 一遍全部门禁。同一个门禁集在一轮构建里被跑了至少 2 遍。
F-4（单元测试被当门禁）：collectGateFiles 只按 check- 前缀 + .mjs 后缀过滤（676 行），于是 check-script-tests.mjs (222.6 s)、check-code-map-anchors.test.mjs (41.4 s)、check-patch-mirror.test.mjs (31.3 s) 等 test 入口全部被当成「门禁」spawn。这些在 CI 的 node --test 里本来已经跑过。
F-5（两轮探针）：第二轮对「发射 SKIP」的门禁再跑一遍 --require（693-696 行），又叠一遍成本。

预估收益（可量化）：

- 现状：单次 210-246 s。
- 方案 R1（最小改动）：把 *.test.mjs 排除出探针面 + 排除 check-release-gates.mjs（它已被 ps1 单独跑）。按上表，仅这两类就占 527,002 ms（serialSum 的 74.4%）-> 单条门禁可降到约 55-70 s，净省 140-190 s/次构建。
- 方案 R2（结构性）：check-gate-skips 改成只审计声明集合里的门禁（第 40 行已经解析出 declared），而不是扫全树 79 个。
- 方案 R3（最彻底）：复用第一轮探针的输出缓存跨构建持久化，按「门禁源码 hash + 输入 hash」做 key。风险：缓存失效策略本身要门禁守，属新增复杂度。

改动风险：低。check-gate-skips 的判据是「每个门禁是否按 SKIP 纪律发射并计数」，不是「跑了多少条」；缩小探针面等于把审计面从全树收到声明集合 —— 但这确实会降低覆盖面（scripts/source-build/ 下的门禁将不再被运行期实证）。必须同时在 check-gate-skips 里显式登记「哪些文件属于审计面」并在 --list 里可见，否则就是「把判据改小来借绿」。

负控：probe-gate-cost.mjs（240.9 s / 79 门禁 / 8 并发）与门禁自身（210.8 / 245.7 s）两次独立测量互相验证；serialSumMs=708 s / concurrency=8 约 88.5 s 低于实测 wall，说明并发池确实在跑，不是串行假象。单独跑最快的几条（check-apk-form.mjs 184 ms、check-snapshot-node-shims.mjs 245 ms）证明「不是所有门禁都慢」，区分度真实存在。

### A1.6 快照类门禁（per-ABI，跑 2 次/全链）

以 snapshot/snapshot-x86_64.tar.xz（142.29 MiB）为输入实测：

| 门禁 | ms | exit | 是否全量解码 tar |
|---|---:|---:|---|
| check-snapshot-secrets | 136,842 | 1 | 是（tar -tf 全量） |
| build-hard-manifest | 88,350 | 0 | 是（python tarfile r:xz） |
| elf-check | 77,485 | 0 | 是 |
| check-third-party | 75,041 | 0 | 是（tar 视图 + 写 notices） |
| check-inject-completeness | 47,253 | 1 | 是（tar -tf + tar -xf） |
| check-mcp-client-deps | 38,395 | 0 | 是（tar -tf + tar -xOf -T） |
| check-api-route-auth --snapshot | 37,556 | 0 | 是 |
| check-engine-overlay | 34,989 | 1 | 是（python tarfile r|xz） |
| check-combo-cache | 24,738 | 0 | 是（tar -tf） |
| check-snapshot-file-modes | 24,485 | 0 | 是（python tarfile r:xz） |
| check-snapshot-decode | 24,335 | 0 | 是（全量流式解码） |
| check-strip-noop | 19,574 | 0 | 是（tar -tf） |
| check-runtime-assets | 18,004 | 1 | 部分（tar -xf 白名单） |
| check-perf-instrumentation | 13,796 | 1 | 部分 |

已计时合计（14 条）：651,304 ms，x2 ABI 约 1,302,608 ms。

根因（脚本自己写了）：xz 不可随机寻址，任何「读一个成员」都要从头解一遍。

- check-snapshot-secrets.mjs:99-102 注释原文：「sh('tar -xOf ...') —— 对同一份归档第二次全量解码（xz 不可随机寻址，取一个成员 = 从头解一遍）」
- check-mcp-client-deps.mjs:102：execFileSync(TAR, ['-xOf', SNAP, '-T', listFile]) —— 又是一次全量解码

隔离实测（地板成本），对 app/src/main/assets/snapshot.tar.xz（200.88 MB / 53,178 条）：

```
tar -tf  x5 : 26436 / 22106 / 27464 / 25962 / 26310 ms   （中位 26085，min 22106，max 27464）
tar -xOf 单成员 x5 : 21967 / 20402 / 19461 / 16792 ms   （中位约 20402）
```

结论：每一次全量解码约 20-26 s。上面 14 道门禁里至少 9 道各自独立解了一遍 —— 这就是 651 s 的全部来源。

预估收益：方案 G1（单一解码、多门禁共享）—— 把 9 道门的「成员表 + 需要读的小文件」一次性解出并落盘（一次 tar -xJf 到临时目录），后续门禁从目录读。按隔离实测，9 次 x 约 22 s = 198 s -> 1 次约 26 s，每 ABI 省约 172 s，双 ABI 省约 344 s。
改动风险：中。G1 会让门禁共享中间产物，必须保证「共享的成员表就是本 ABI 的」—— $work 已经按 ABI 分目录（ps1:271），天然满足。

### A1.7 构建缓存现状

| 项 | 现状 | 位置 |
|---|---|---|
| org.gradle.parallel | true | gradle.properties:3 |
| org.gradle.caching | true | gradle.properties:4 |
| org.gradle.configuration-cache | 注释掉（未启用） | gradle.properties:5，注释写明「撤（2026-09-05 实测）：mergeDebugAssets 自定义校验 task 持 script object 引用，CC 不支持」 |
| org.gradle.jvmargs | -Xmx4g -Dfile.encoding=UTF-8 | gradle.properties:2 |
| --no-daemon | 硬编码启用 | build-apk-engine.mjs:86 |

build cache 命中率（Gradle 自报，非估算）：

| 场景 | Gradle 自报 |
|---|---|
| A 冷（1 KB） | 36 actionable tasks: 17 executed, 19 from cache |
| B 热（1 KB） | 全部 UP-TO-DATE |
| C 冷（200.88 MB） | 36 actionable tasks: 3 executed, 33 up-to-date |
| D 热（200.88 MB，--profile） | Task Execution 仅 3.746 s |

结论：build cache 已经在正常工作（19/36 从 cache 取）。真正的浪费不是「缓存没开」，而是 --no-daemon 每次重建 JVM，以及 configuration cache 被禁用导致每次重新配置 11.8-28.3 s。
预估收益：去掉 --no-daemon（或改成条件启用）-> 每 ABI 省约 30 s，双 ABI 约 60 s。
改动风险：低。--no-daemon 是有意的（CI 上避免 daemon 泄漏），改成「本地开发用 daemon / CI 用 --no-daemon」需要区分环境。

---
## A2. 产物体积构成

### A2.1 基线校正：out/v0.14.9 的 APK 不能当体积基线

用 apk-entry-hash.mjs 直接从 APK 的 stored 条目取字节算 sha256：

```
$ node scripts/perf-audit-a/apk-entry-hash.mjs .../dsh-mobile-apk-v0.14.9-arm64.apk assets/snapshot.tar.xz
{"bytes":157861552,"method":0,"dataOffset":4960192,
 "sha256":"6ad3a5f60eb1f2e45eefea72b3723649269843b59d169f5ba987353b84a1df06"}
```

当前 app/src/main/assets/snapshot.tar.xz：

```
$ Get-FileHash .../app/src/main/assets/snapshot.tar.xz -Algorithm SHA256
3dc9f3090822ea056bc5e53ad5455dd73a51d0f9cef465f9fb93061e8401002d   200,877,488 B
```

两者不同。用 probe-apk-snapshot.py 解出 APK 内那份的身份：

```json
{"entryCompressed":157861552,"entryMethod":0,"engineVersion":"0.2.1-rc.2",
 "nodeAbi":"aarch64","files":43663,"dirs":7356,"symlinks":1014,
 "uncompressedBytes":777793281,"uncompressedMiB":741.76,"dshAndroidEntries":569}
```

结论：out/v0.14.9 里的 APK 内嵌 157.86 MB / 741.76 MiB / 引擎 0.2.1-rc.2 的旧快照；当前 assets 是 200.88 MB / 引擎 0.2.1-rc.3。差距 43,015,936 B。（与 D 块的交叉发现一致）

### A2.2 APK 体积构成

口径一：out/v0.14.9 那个真实 APK 的字节（163,133,182 B / 239 条目）

| 条目 | compressed (B) | uncompressed (B) | 占 compressed |
|---|---:|---:|---:|
| assets/snapshot.tar.xz（method=0 stored） | 157,861,552 | 157,861,552 | 96.77% |
| classes*.dex（3 个） | 4,825,223 | 12,165,904 | 2.96% |
| resources.arsc（stored） | 95,488 | 95,488 | 0.06% |
| assets/patched/…（3 个） | 80,445 | 245,436 | 0.05% |
| assets/licenses/…（6 个） | 39,285 | 100,925 | 0.02% |
| res/（52 个） | 26,655 | 44,743 | 0.02% |
| META-INF/（31 个） | 22,152 | 60,010 | 0.01% |
| kotlin/（7 个） | 10,468 | 29,945 | 0.01% |
| 其余（console.html / undo-emergency.mjs / plugin-hard-manifest.json / AndroidManifest.xml / org/apache/commons/… 等） | 约 28,000 | 约 90,000 | 约 0.02% |
| 合计 | 163,087,089 | 170,924,794 | 100% |

central directory + headers + signing block 开销：46,093 B（可忽略）。

口径二：若用当前 assets 的 200,877,488 B 快照

| 组件 | 字节 | 占比 |
|---|---:|---:|
| assets/snapshot.tar.xz | 200,877,488 | 96.8%（结构不变，stored） |
| classes*.dex | 4,825,223 | 2.3% |
| 其余全部 | 约 530,000 | 0.25% |
| 推算 APK 总体积 | 约 206,278,000 B（196.7 MiB） | |

这是当前唯一正确的体积基线（与 D 块「真实 APK 约 206 MB」一致）。

### A2.3 noCompress += "xz" 的代价与收益（app/build.gradle.kts:41）

用 deflate-probe.py 对同一份 xz 做真 DEFLATE（raw deflate，与 zip 一致）：

```
input=200,877,488 bytes
deflate level=6 -> 200,929,572 bytes (100.0259% of input, delta +52,084) 15.86s
deflate level=9 -> 200,930,751 bytes (100.0265% of input, delta +53,263) 14.17s
```

结论：对已经 xz 过的数据再 DEFLATE 不但压不动，还大 52 KB，但要烧 14-16 s CPU。noCompress += "xz" 是正确决定 —— 它省掉 15.86 s 的纯浪费，体积上还多 52 KB。注释里说的「double-compressing it breaks openFd」是另一条更硬的理由（AGP 的压缩会破坏 asset 的随机读取）。

负控：同一把尺子（zlib level 6）压一个可压缩输入 THIRD_PARTY_NOTICES.md（11,566 B）：deflate level=6 -> 2602 bytes (22.4970% of input)。压到 22.5%，对比 xz 输入的 100.0259% —— 证明这把尺子真的能测出可压/不可压，不是恒返回 100% 的假探针。

对齐分析（apkzip.mjs 的 storedAlignment）：

```json
{"storedEntries":36,"deflatedEntries":203,"otherMethods":[8,0],
 "storedAlignment":{"4":36,"16384":0,"other":0},
 "storedBytes":157969592,"deflatedBytes":5117497}
```

36 个 stored 条目全部 4 字节对齐（zipalign 要求），0 个 16384 对齐（没有 -p 页对齐，对内存映射读取有潜在影响；但当前代码用 openFd 走 AssetFileDescriptor，不是 mmap，影响有限）。

### A2.4 内嵌快照（assets/snapshot.tar.xz，200,877,488 B）体积构成

```
$ python scripts/perf-audit-a/tarls.py .../app/src/main/assets/snapshot.tar.xz --json .perf-a/asset.json
entries=53178  files=45585  dirs=7593  symlinks=1017
totalBytes=750,434,969  totalMiB=715.67  compressRatio=3.736
```

按顶层目录：

| 前缀 | MiB | 文件数 | 占比 |
|---|---:|---:|---:|
| usr | 608.1 | 40,054 | 84.97% |
| home | 107.5 | 5,531 | 15.03% |

usr/ 二级：

| 前缀 | MiB | 文件数 | 占 usr |
|---|---:|---:|---:|
| usr/lib | 432.58 | 30,320 | 71.13% |
| usr/bin | 80.25 | 608 | 13.20% |
| usr/share | 63.66 | 7,872 | 10.47% |
| usr/libexec | 22.30 | 263 | 3.67% |
| usr/include | 8.84 | 865 | 1.45% |

usr/lib 三级：

| 前缀 | MiB | 文件数 | 占 usr/lib |
|---|---:|---:|---:|
| usr/lib/node_modules | 227.14 | 24,148 | 49.93% |
| usr/lib/perl5 | 53.75 | 1,877 | 11.82% |
| usr/lib/libicudata.so.78.3 | 31.58 | 1 | 6.94% |
| usr/lib/ruby | 29.58 | 2,650 | 6.50% |
| usr/lib/python3.14 | 20.88 | 1,150 | 4.59% |
| usr/libexec/git-core | 14.27 | 204 | 3.14% |
| usr/lib/libpython3.14.so | 5.49 | 1 | 1.21% |
| usr/lib/libcrypto.so.3 | 5.28 | 1 | 1.16% |

home/.dsh/profiles 分布：

| profile | MiB | 文件数 |
|---|---:|---:|
| web | 104.45 | 4,783 |
| headless | 3.07 | 301 |
| headless-bad | 0.03 | 9 |

web profile node_modules 里的 Top：

| 包 | MiB | 文件数 | 说明 |
|---|---:|---:|---|
| tesseract.js-core | 29.08 | 16 | OCR wasm，4 份 wasm + 4 份 wasm.js 双份 |
| dsh-attachment-formats | 23.88 | 26 | 含 chi_sim.traineddata.gz 11.43 MiB + eng.traineddata.gz 12.23 MiB |
| pdfjs-dist | 17.09 | 345 | |
| @mixmark-io/domino | 7.38 | 1,023 | |
| exceljs | 6.67 | 350 | |
| @dsh-android | 3.00 | 289 | 我方注入 |

重要：home/.dsh/profiles/web/cordis.patch.yml 已明确写了 dsh-attachment-formats 自 0.13.7 起退役、不再挂载（原文：「包体仍在基座快照内，不再装载即等于退役」），tesseract.js-core 正是它独占的依赖。23.88 + 29.08 = 52.96 MiB 是「装着但装配面不引用」的死重。

包名 Top-15（全树）：

| 包 | MiB | 文件数 | 位置 |
|---|---:|---:|---|
| tesseract.js-core | 29.08 | 16 | profiles/web |
| dsh-attachment-formats | 23.88 | 26 | profiles/web |
| @deepseek-ai/dsh-experimental-inspector | 22.38 | 780 | usr/lib/…/dsh/node_modules（嵌套） |
| pdfjs-dist | 17.09 | 345 | profiles/web |
| @deepseek-ai/dsh-client-ui-sidebar-documentpreview | 14.02 | 12 | 嵌套 x2 |
| openai | 10.40 | 1,590 | 嵌套 x2 |
| pnpm | 9.50 | 16 | usr/lib/node_modules |
| @img/sharp-wasm32 | 8.50 | 7 | 嵌套 x2 |
| @mixmark-io/domino | 7.38 | 1,024 | |
| @mixmark-io/domino（嵌套副本） | 7.38 | 1,022 | |
| react-dom | 6.98 | 43 | 嵌套 x3 |
| exceljs | 6.67 | 350 | |
| @vscode/ripgrep-android-x64 | 4.99 | 2 | 嵌套 x2 |
| node-pty | 6.02 | 252 | 嵌套 x2 |
| zod | 4.03 | 613 | 嵌套 x2 |

### A2.5 可删集合（去重后，可直接当「能砍多少」的上界）

tarls.py 的 deletableUnion 用优先级分类（一个文件只归入首个命中类目），保证各类相加 == 总量，不重复计数；且只统计 node_modules 内的文件（基座 usr/share/man 等不算，那是另一个决策面）。

```
deletableUnion: 62,435,587 B = 59.54 MiB / 10,899 文件 = 解压后总量的 8.32%
  按 scope: usr 47.46 MiB (79.71%) / home 12.08 MiB (20.29%)
```

| 类目 | MiB | 文件数 | 占可删集合 |
|---|---:|---:|---:|
| TypeScript 源码/声明（*.ts/*.mts/*.cts，含 .d.ts） | 24.65 | 4,635 | 41.40% |
| 测试/夹具/示例目录（/test/ /tests/ /__tests__/ /fixtures/ /examples/） | 14.02 | 2,310 | 23.55% |
| 文档（*.md/*.markdown） | 13.74 | 1,901 | 23.07% |
| locale/i18n 目录（全部语言） | 4.13 | 959 | 6.94% |
| LICENSE/COPYING 文件 | 2.16 | 1,039 | 3.62% |
| 测试文件（*.test.* / *.spec.*） | 0.84 | 55 | 1.41% |

### A2.6 已做过的瘦身（读 scripts/snapshot-config/slim.json，不要重复报）

已生效（不属本报告的新发现）：

| 项 | 状态 |
|---|---|
| sourcemaps 全树（*.map） | 已删；实测残留 0 个 .map |
| usr/share/man 整树 | 已删；usr/share 下已无 man |
| node-pty 的 win32/darwin prebuilds + reflink.*.node | 已删 |
| data/data/com.termux 错位目录 | 已删 |
| 全局 orphan 包 @img/sharp-wasm32 | 已删（仅覆盖 global node_modules 那一份） |
| 引擎子树 .d.ts、.pfx/.p12/.coveralls.yml | 已删 |

本报告的新数据（不在 slim 覆盖面内）：

1. node_modules 内 *.ts / *.mts / *.cts（含 .d.ts）= 24.65 MiB / 4,635 文件 —— slim 只删了引擎子树那一份 .d.ts，其余仍在。
2. LICENSE/COPYING 全树 2.16 MiB / 1,039 文件。
3. 测试/夹具/示例目录命中 14.02 MiB / 2,310 文件。
4. 文档 *.md 13.74 MiB / 1,901 文件。
5. 多实例包多余副本 21.52 MiB / 494 包。
### A2.7 三个 tar 为什么不一样大（已归因）

| 文件 | 字节 | MiB | 引擎版本 | ABI | xz blocks |
|---|---:|---:|---|---|---:|
| app/src/main/assets/snapshot.tar.xz | 200,877,488 | 191.57 | 0.2.1-rc.3 | x86_64 | 1 |
| snapshot/snapshot-x86_64.tar.xz | 149,201,056 | 142.29 | 0.1.7-rc.2 | x86_64 | 1 |
| snapshot/snapshot-arm64.tar.xz | 153,784,504 | 146.66 | 0.1.7-rc.2 | aarch64 | 1 |
| base/base-usr-x86_64.tar.xz | 80,933,336 | 77.18 | 0.1.1-rc.2 | x86_64 | 21 |
| base/base-usr-arm64.tar.xz | 68,959,460 | 65.76 | 0.1.1-rc.2 | aarch64 | 5 |
| base/base-dsh.tar.xz | 45,830,328 | 43.71 | 0.1.1-rc.2 | — | 5 |

用 probe-tar-identity.py（读 usr/bin/node 的 ELF e_machine + 引擎 package.json）：

```json
{"tar":"...app/src/main/assets/snapshot.tar.xz","engineVersion":"0.2.1-rc.3","nodeAbi":"x86_64"}
{"tar":"...snapshot/snapshot-arm64.tar.xz","engineVersion":"0.1.7-rc.2","nodeAbi":"aarch64"}
{"tar":"...snapshot/snapshot-x86_64.tar.xz","engineVersion":"0.1.7-rc.2","nodeAbi":"x86_64"}
```

归因：
1. assets 那份是 x86_64（不是 arm64），对应 0.2.1-rc.3 引擎。
2. snapshot/ 下两份是上一代引擎 0.1.7-rc.2 的产物，不是同一份内容的不同 ABI 打包 —— 所以「为什么 assets 更大」有一部分是版本差，不是 ABI 差。
3. 用 compare-tars.mjs 做成员级差分（arm64 基线 vs assets）：onlyInB 6,025 文件 / 133,408,708 B，onlyInA 2,822 文件 / 126,567,798 B，sameSizeFiles 35,469。

新增（only in assets）Top：

| 路径 | 字节 |
|---|---:|
| …/@deepseek-ai/dsh-experimental-inspector/lib/devtools/entrypoints/lighthouse_worker/lighthouse_worker.js | 9,204,549 |
| …/@img/sharp-wasm32/lib/sharp-wasm32-0.35.3.node.wasm | 8,900,872 |
| …/@vscode/ripgrep-android-x64/bin/rg | 5,228,584 |
| usr/lib/perl5/5.44.0/x86_64-android/CORE/libperl.so | 4,012,096 |
| usr/lib/libsqlite3.54.1.so | 1,320,240 |

消失（only in arm64）Top：

| 路径 | 字节 |
|---|---:|
| home/.dsh/profiles/web/node_modules/@napi-rs/canvas-android-arm64/skia.android-arm64.node | 26,870,888 |
| …/@vscode/ripgrep-android-arm64/bin/rg | 4,868,920 |

回答「双 ABI 是否会两个都塞 x64」：不是。arm64 那份装 ripgrep-android-arm64（4,868,920 B），x86_64 那份装 ripgrep-android-x64（5,228,584 B），各自替换。@vscode/ripgrep/lib/index.js 全文 594 B，运行时按 process.arch 动态 require.resolve(`@vscode/ripgrep-${process.platform}-${arch}/bin/${binaryName}`)。

---

## A3. 构建链里的浪费

### A3.1 【核心】两次全量压缩，第一次零贡献

代码链（已逐行确认）：

| 步骤 | 文件:行 | 做什么 | 压缩耗时实测 |
|---|---|---|---:|
| 1 | build-snapshot-013.mjs:1201 | tar -c --mtime=@… usr home/.dsh home/.gitconfig \| xz -T${XZ_THREADS} -6 > snapshot.tar.xz | 86,909 / 85,041 ms（-T8 -6，804 MB 输入） |
| 2 | inject-snapshot.py:70-71 | lzma.open(src,"rb").read() —— 整份读进内存 | 解压 16,341 ms（实测） |
| 3 | inject-snapshot.py:123 | lzma.open(dst,"wb",preset=9) —— 整份重新压缩，丢弃第 1 步结果 | 未测完，见 A6 |
| 3' | inject-all.py:170 / 340 | 同样模式（单 pass 版，ps1:356 实际调用的是它；默认 preset=9，见 inject-all.py:155） | 未测完，见 A6 |

事实陈述（不做同 payload 归因）：第 1 步产出的是 snapshot/snapshot-<abi>.tar.xz（142.29 / 146.66 MiB，压缩比 0.198 / 0.196）；第 3 步产出的是最终并入 APK 的 app/src/main/assets/snapshot.tar.xz（200,877,488 B，压缩比 0.250）。这两份 payload 不同（第 3 步的输入是「注入后、经过全部 profile 覆盖与修剪」的树）。

但结构事实是确定的：第 3 步从「解压后的裸 tar」重新压，第 1 步的压缩产物在整条链上没有任何下游消费者被最终产物采用 —— 所以第 1 步那 85-87 s 对最终产物零贡献。

注：ps1:356 实际调用的是 inject-all.py（单 pass 合并器），它同样从 lzma.open(src).read() 起、以 lzma.open(dst, preset=preset) 终。inject-snapshot.py 是旧三步链的一员，本轮不是主路径，但压缩形态相同。

#### 最终归档的压缩档位身份（决定性证据）

```
$ xz -dc assets/snapshot.tar.xz > %TEMP%/raw.tar     # 804,229,120 B
$ xz -1 -T1 -c %TEMP%/raw.tar > %TEMP%/re.xz
$ Get-FileHash -Algorithm SHA256
xz -1 -T1 : 200877488 B  sha256=3dc9f3090822ea056bc5e53ad5455dd73a51d0f9cef465f9fb93061e8401002d
shipped   : 200877488 B  sha256=3dc9f3090822ea056bc5e53ad5455dd73a51d0f9cef465f9fb93061e8401002d
```

逐字节相同。即当前随包分发的快照，其压缩参数等价于 xz -1 -T1（preset 1 + 单线程 + 单块流）。而 DSH_INJECT_PRESET 的默认值是 9（inject-all.py:155），当前 shell 环境里 DSH_INJECT_PRESET 为空。

【按 Lead 纠正修订】解释是：这份 assets 是 build-apk-013.ps1 **-Fast 档**产出的（ps1:15-18：if ($Fast) { $env:DSH_INJECT_PRESET = '1' … 「产物体积增大，禁止用于发布资产」}）。

**结论方向（已反转）**：

- preset 1 是 -Fast 档**刻意的取舍**（注释写明压缩 380s→75s/遍），发布路径默认就是 9。所以「把 preset 提到 6/9 来减体积」**不成立**，此项**不是**发布链的体积缺陷，**不得列为改进项**。
- 正确表述：**磁盘上这份 app/src/main/assets/snapshot.tar.xz 是一次 Fast 构建的残留产物，不是发布档产物；它 191.57 MiB 的体积既不能代表发布包体积，也不能据此推断发布链有体积缺陷。**
- 它为什么能被误当发布产物：build-apk-engine.mjs:72 原样 copyFileSync(sourceSnapshot → assets)，而 dev 档（build-apk-dev-fast.mjs）按 AGENTS.md 明写「不重建/不注入快照，**复用 app/src/main/assets/snapshot.tar.xz**」。于是 dev 循环会把 Fast 产物留在那里，后续任何**直接读 assets** 的度量或打包路径都会拿到它。

【保留的真实结论】本条唯一成立的改进项是**防线**，不是优化：加一条判据，使得 FAST 档产物（DSH_INJECT_PRESET=1）不能停留在被视为发布输入的 assets 路径上（例如 assemble 时校验 preset 标记，或 dev 档写到独立路径）。风险低、工作量 S。

#### 压缩档位全景（同一份 804,229,120 B tar 输入，本机实测）

| 压缩方式 | 产物字节 | MiB | 耗时 |
|---|---:|---:|---:|
| xz -0 -T1 | 218,384,548 | 208.27 | 88,213 ms |
| xz -1 -T1（= 当前发货档） | 200,877,488 | 191.57 | 88,459 ms |
| xz -2 -T1 | 191,207,308 | 182.35 | 132,889 ms |
| xz -1 -T8 | 203,238,124 | 193.82 | 18,757 ms |
| xz -6 -T8 | 166,571,964 | 158.85 | 86,909 / 85,041 ms |
| xz -9 -T16（Lead 在 WSL 实测） | 154,110,288 | 146.97 | 393,000 ms |
| xz -6 -T16（Lead 在 WSL 实测） | 166,571,964 | 158.85 | — |

注：xz -6 -T8 与 -T16 字节数相同（166,571,964），因为 xz 的块大小由 preset 的 dict_size 决定，两者都是 8 MiB dict，块边界一致。

#### 量化

「第一次压缩白做」：第 1 步 xz -6 -T8 实测 85,041 / 86,909 ms（两次），其产物对最终产物零贡献。可省下的就是这 85-87 s / ABI。
（不是去「优化第 1 步」，而是让注入直接输出未压缩 tar、把唯一那次压缩交给多线程 xz。）

「档位对照（仅作事实记录，不再作为改进收益）」：当前磁盘产物 191.57 MiB；同一 tar 流 xz -6 -T8 为 158.85 MiB；xz -9 -T16 为 146.97 MiB。

**但这 32.72 MiB 不是「发布链可省的体积」**——发布链走 preset 9，本来就不产出 191.57 MiB 这一档。这些数字只能说明「磁盘上这份是 Fast 档产物」，不能说明发布包有体积缺陷。

【修订后的准确表述】本条成立的只有**一件事**：构建链上第一次压缩（xz -T8 -6）的产物被注入步骤整份重压覆盖，对最终产物零贡献 —— 这是**时间**浪费（85-87 s/ABI），与**体积**无关。先前把它写成「两头都亏（多花时间换来更大产物）」是**错误归因**，已按 Lead 纠正撤回。

#### 改法方向（按风险排序）

- R1（推荐，低风险）：inject-all.py / inject-snapshot.py 输出未压缩的裸 tar（tarfile.open(dst,"w",PAX_FORMAT) 直接写文件），把「最后一次压缩」交给已有的一次多线程 xz。一次压缩、多线程、preset 6。风险：注入步骤的产物不再是 .tar.xz，check-inject-completeness.mjs 等 9 道门禁全部要改成读裸 tar（它们多数已经支持 tar -tf，兼容层很低）。
- R2（中风险）：保留两段式，但把 Python lzma 换成「xz 子进程 + -T${XZ_THREADS} -6」。改动小，但仍浪费第 1 步的解压+压缩。
- R3（**改为防线项，不再算优化**）：在发布链上显式断言 DSH_INJECT_PRESET 没被 -Fast 设成 1；并让 dev/Fast 档不把产物写到 assets。这解决的是「Fast 残留被误当发布输入」，不是「体积」。

#### 必须同时加的防线

-Fast 档产物（DSH_INJECT_PRESET=1）不应该**留在** app/src/main/assets/snapshot.tar.xz 这个被视为发布输入的路径上。现状：dev 档按设计复用该路径（AGENTS.md：「不重建/不注入快照，复用 app/src/main/assets/snapshot.tar.xz」），于是 Fast 产物会停在这里（证据：sha256 等于 xz -1 -T1）。建议：给 assets 里的 tar 打一个「压缩档位」标记并由 check-snapshot-fingerprint 校验，或让 dev 档写到独立路径。**这是防线，不是体积优化。**

#### 块结构的影响（只陈述边界，不越界到设备侧）

xz --list 显示发货归档 Blocks: 1（单块流）。块结构改变会影响：
1. 设备侧解码并行度（单块 = 无法多线程解码）—— 归 C 块定量；
2. 门禁的 tar -tf 语义不受影响；
3. zip 对齐：noCompress 保证 stored，块结构不影响 zip 对齐。

#### 负控

1. 用 xz -1 -T1 复现出逐字节相同的 sha256 —— 如果「档位推定」错了，不可能撞上同一个 sha256。
2. xz -0/-1/-2/-6/-9 五个档位给出五个不同字节数，证明这把尺子能区分压缩档。
3. xz -1 -T8（203,238,124）vs xz -1 -T1（200,877,488）差 2.36 MB，证明分块本身也有可测的体积代价（T8 切块损失跨块字典匹配）。

### A3.2 注入步骤的内存峰值

inject-all.py（ps1:356 实际调用者）的内存形态：

```python
170: with lzma.open(src, "rb") as f:
171:     raw = f.read()                    # 整个解压流进内存 = 716 MiB
187: with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tin, \
188:         tarfile.open(fileobj=outbuf, mode="w", format=tarfile.PAX_FORMAT) as tout:
...
340: with lzma.open(dst, "wb", preset=preset) as f:
341:     f.write(outbuf.getvalue())        # outbuf 内部 + getvalue() 再复制一份
```

用 bytesio-mem-probe.py 实测 CPython 的 BytesIO 复制语义（这是判据，不是猜测）：

```
$ python scripts/perf-audit-a/bytesio-mem-probe.py --mib 16
raw MiB = 16.0, tracemalloc cur = 32.0 MiB, delta over raw = 16.0 MiB (= 1.00 x raw)
$ python scripts/perf-audit-a/bytesio-mem-probe.py --mib 128
raw MiB = 128.0, tracemalloc cur = 256.0 MiB, delta over raw = 128.0 MiB (= 1.00 x raw)
```

结论：io.BytesIO(raw) 会复制初始 bytes（delta 恒等于 raw 大小，与 raw 大小线性相关）。

因此 inject-all.py 的真实峰值（推导）：

| 项 | 大小 |
|---|---:|
| raw（解压后裸 tar） | 716 MiB（750,434,969 B） |
| io.BytesIO(raw) | +716 MiB |
| outbuf = io.BytesIO() 写入整棵树 | +716 MiB |
| outbuf.getvalue() 复制 | +716 MiB |
| 最低峰值 | 约 2.8 GiB |

未测 + 原因：没有在 716 MiB 真实输入上跑 tracemalloc（需约 3 GB 常驻 + 数分钟），只测了 BytesIO 的复制倍率（1.00x raw，线性可外推）。这是推导不是实测，明确标注。

预估收益：改成流式（lzma.open(src) -> tarfile.open(fileobj=…, mode="r|") -> lzma.open(dst,"wb") 直接写，不经过 BytesIO）-> 峰值从 2.8 GiB 降到数十 MiB。
改动风险：中。inject-all.py 的「单 pass 修剪 + 替换」逻辑依赖随机访问的 BytesIO（scan_buf 预扫描 + inbuf 主循环各持独立流，第 73-75 行注释明确说了原因）；改流式要重写预扫描逻辑（existing 集合），可能破坏 inject-completeness 门禁的语义。
### A3.3 按「运行时是否真的被加载」判据的死重清单

#### 【问题 1】@deepseek-ai/dsh-experimental-inspector = 22.38 MiB

判据链（三条独立证据）：

1. 装配面：home/.dsh/profiles/web/cordis.patch.yml（17,271 B）里没有任何 inspector 行（grep-in-tar.py 扫 45 个 profile 相关 yml，hits=0）。dsh-web-app/cordis.patch.yml、dsh-base/cordis.patch.yml 同样 hits=0。
2. 它怎么被引用的：只有 dsh-experimental-inspector-profile 的 cordis.patch.yml 里有一行 insert：

```yaml
- insert:
    - id: experimental-inspector
      name: '@deepseek-ai/dsh-experimental-inspector'
      disabled: false
      config:
        captureFetch: true
```

   而该包的 package.json 描述是 "Optional Web bundle for raw Session logs and Chat node inspection" —— Optional bundle。
3. Optional bundle 的装配机制：dsh-app-boot/lib/index.js 的 PROFILE_TEMPLATES：

```js
const PROFILE_TEMPLATES = {
    acp: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-acp-app"] },
    web: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app"] },
    headless: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless"] },
    ...
};
```

   web 模板只有 base + web-app 两个 bundle，没有 inspector-profile。源码注释原文：「The bundles the dsh installation ships for a person to switch on … offered switched off by the plugin manager」。

结论：@deepseek-ai/dsh-experimental-inspector 是可选调试 bundle，默认关闭，引擎正常运行期不加载。它的 22.38 MiB（其中 lighthouse_worker.js 单文件 9,204,549 B、legacy-dM_vujv7.js 1,702,294 B）是纯死重。

风险标注：用户可以在插件管理器里打开它。删掉 = 该功能不可用。这属产品决策，不是纯技术优化。
预估收益：解压后 22.38 MiB，压缩后估计 3-4 MiB。风险：中。

#### 【问题 2】@img/sharp-wasm32 = 8.50 MiB（不要删）

判据：
1. 位置在嵌套路径 usr/lib/node_modules/@deepseek-ai/dsh/node_modules/@img/sharp-wasm32（不是 slim.json 覆盖的 global orphan 那份）。
2. sharp/dist/utility.cjs 等文件里有 require('@img/sharp-wasm32/versions') —— 是真实引用。
3. Android 上没有任何 @img/sharp-*android* 原生包（Select-String @img/ asset.tsv 只有 @img/colour 与 @img/sharp-wasm32，没有 @img/sharp-linux-android 之类）。
4. engine-overlay.json:10 注释：「Android Koffi 3.2.1 and the Sharp WASM runtime override remain intentional source-deploy policy」—— 即 wasm32 是 Android 上的有意选择；engine-overlay.json:486 在 extraPresent 里登记了它。

结论：在当前 Android 部署形态下，sharp 走 wasm32 是唯一可用后端（没有原生 android 二进制），8.50 MiB 是活重，不能删。除非放弃 sharp 的图像处理能力。
预估收益：0（不可删）。风险：删了 = 图像处理能力消失。

#### 【问题 3】@vscode/ripgrep-android-x64 = 4.99 MiB

判据：
1. @vscode/ripgrep/lib/index.js 全文 594 B，运行时按 process.arch 动态 require.resolve(`@vscode/ripgrep-${process.platform}-${arch}/bin/${binaryName}`)。所以 x86_64 包只需 x64 那份，arm64 包只需 arm64 那份。
2. 对照实测：asset.tsv（x86_64）里是 ripgrep-android-x64/bin/rg 5,228,584 B；arm64.tsv 里是 ripgrep-android-arm64/bin/rg 4,868,920 B。双 ABI 构建时各自替换，不存在「两个 ABI 都塞 x64」。
3. usr/bin/rg 也存在（x86 5,228,584 B / arm64 4,868,920 B）—— 这是 Termux 基座自带的 ripgrep，与 npm 包的 @vscode/ripgrep-android-* 是两份独立副本。

结论：不是 ABI 错配死重（这一条需要修正先前的判断）。但存在真死重：usr/bin/rg 与 @vscode/ripgrep-android-*/bin/rg 是同一工具的两份副本。引擎用包内那份（require.resolve），usr/bin/rg 是给 shell / 模型 bash 工具用的。两份都有用途，但只保留一份 + 软链是可行方案。
预估收益：4.99 MiB 解压后（压缩后约 1.5-2 MiB），前提是确认 usr/bin/rg 可被软链替代。风险：中。

#### 【问题 4】node_modules 内的 .ts 源文件

判据：Node.js 只执行 .js/.cjs/.mjs，.ts 除非通过 loader（tsx/ts-node）否则不会被 require/import。快照里没有这类 loader 的启动配置。

数据（tarls.py 的 deletableUnion）：
- *.ts / *.mts / *.cts（含 .d.ts）：24.65 MiB / 4,635 文件，占可删集合 41.40%
- 其中纯 .ts（不含 .d.ts）：按扩展名统计 .ts 18,025,589 B / 3,157 文件 + .mts 6,262,085 B / 1,323 文件

未测 + 原因：没有对全树做「哪条 import 真的指向 .ts 说明符」的静态解析（需写 TS/ESM resolver，超出本块范围）。
保守做法：只删 node_modules 内不在任何 package.json 的 exports/main/types 里指向的 .ts，并且必须跑一遍注入后的引擎 boot 冒烟。
预估收益：24.65 MiB 解压后，压缩后估计 2-3 MiB。风险：中-高。

#### 【问题 5】纯文档/开发工具类，风险分级

| 目标 | MiB | 运行时是否需要 | 风险 | 判据 |
|---|---:|---|---|---|
| usr/share/vim/vim92 | 25.65 | 否（编辑器） | 低 | usr/share/vim 是 vim 的运行时数据（语法高亮/帮助），删了 vim 还能跑但报错多 |
| usr/share/gir-1.0 | 11.64 | 否（GTK 内省） | 低 | 只有编译 GTK 程序才用 |
| usr/share/cmake-4.4 | 9.71 | 否（构建工具） | 低-中 | 有 cmake 命令；移动端几乎不编译 |
| usr/share/info | 6.42 | 否（GNU info 文档） | 低 | 纯文档 |
| usr/share/zsh | 4.30 | 否（zsh 补全） | 低 | 有 zsh 二进制（ps1:431 的 grep 模式里就有 usr/bin/zsh） |
| usr/share/doc | 4.14 | 否 | 低 | 纯文档 |
| usr/include | 8.84 | 否（C 头文件） | 低-中 | gcc/clang 存在时编译要用；不编译则纯死重 |
| usr/lib/perl5/**/*.pod | 10.52 | 否（Perl 文档） | 低 | perldoc 会失败，perl 本身正常 |
| usr/lib/*.a（static libs） | 9.57 | 否 | 低 | 只有静态链接才用；当前全是动态链接 |
| 合计 | 90.79 | | | |

注：这些不全是 node_modules 内的，所以没算进 A2.5 的 59.54 MiB。它们是「基座瘦身」面，与「注入包瘦身」是两个决策面。

#### 【问题 6】多版本重复包

用 dup-instances.py（以 package.json 的父目录为实例键，统计多余副本）：

```json
{"packagesWithMultipleInstances": 494,
 "extraBytes": 22569978, "extraMiB": 21.52, "extraFiles": 4871,
 "totalNodeModulesBytes": 350905961,
 "pctOfNodeModules": 6.43}
```

多余副本 Top-12：

| 包 | 实例数 | 保留 | 多余 (B) | MiB |
|---|---:|---:|---:|---:|
| @mixmark-io/domino | 3 | 7,736,745 | 7,736,165 | 7.38 |
| @dsh-android/dsh-client-ui-responsive | 2 | 2,078,556 | 2,078,556 | 1.98 |
| node-gyp | 2 | 2,254,150 | 1,624,707 | 1.55 |
| undici | 2 | 1,802,425 | 1,088,888 | 1.04 |
| @opentelemetry/resources | 7 | 148,647 | 740,095 | 0.71 |
| iconv-lite | 4 | 334,198 | 659,451 | 0.63 |
| @opentelemetry/sdk-metrics | 3 | 537,372 | 535,821 | 0.51 |
| readable-stream | 6 | 123,971 | 440,575 | 0.42 |
| @opentelemetry/core | 4 | 204,246 | 408,468 | 0.39 |
| diff | 3 | 458,123 | 341,711 | 0.33 |
| @xterm/headless | 2 | 332,198 | 332,198 | 0.32 |
| tar | 2 | 536,681 | 330,703 | 0.32 |

多版本（同名不同版本）：

| 包 | 版本 |
|---|---|
| minimatch | 10.2.5 / 3.1.5 / 5.1.9 / 9.0.5 |
| brace-expansion | 1.1.18 / 2.0.1 / 2.1.4 / 5.0.7 |
| isexe | 2.0.0 / 3.1.1 / 4.0.0 |
| which | 2.0.2 / 5.0.0 / 6.0.1 |
| @opentelemetry/core | 2.10.0 / 2.11.0 / 2.9.0 |
| react | 18.3.1 / 19.2.8 |
| node-fetch | 2.7.0 / 3.3.2 |
| semver | 7.7.2 / 7.8.5 |

结论：21.52 MiB / 494 个包有多份实例，占 node_modules 的 6.43%。但大部分是 pnpm 的合法 peer-resolution 结果（不同版本被不同消费者需要），不能无脑去重。可修的只有 @mixmark-io/domino 的三份里两份内容几乎相同（7.38 + 7.38）—— pnpm 嵌套 + 顶层各一份，属 hoisting 配置问题。@dsh-android/dsh-client-ui-responsive 两份在 profiles/{web,headless} 下，是按 profile 分别注入的正常结果。
预估收益：保守估计 8-9 MiB（只处理 domino + 少数真重复），压缩后约 1 MiB。风险：中。

---

## A4. 「减 APK 体积」vs「减解压时间」必须分开

Lead 的 WSL 实测（191 MB 归档）：纯 xz 解码 19.4-19.9 s，tar 列表 25.3 s，真实解压 25.2-27.7 s，per-file 元数据 1.9 s（7%）。

我这一侧的独立佐证（Windows，app/src/main/assets/snapshot.tar.xz 200.88 MB / 53,178 条）：

```
tar -tf  x5 : 26436 / 22106 / 27464 / 25962 / 26310 ms   （中位 26.1 s）
tar -xOf 单成员 x5 : 21967 / 20402 / 19461 / 16792 ms   （中位约 20.4 s）
```

推论（本块必须写清的判据）：

1. 删字节对「APK 体积」的贡献是线性的（按压缩比折算），对「解压时间」的贡献取决于删的是什么。
2. 删已压缩数据（wasm、.gz、.so、图片）-> 压缩比接近 1:1，删 10 MiB 体积就少 10 MiB，且解码字节数少 10 MiB -> 解码时间近线性下降。
3. 删高度可压缩文本（.ts/.md/测试）-> 解压后 59.54 MiB 只压成约 6-8 MiB，压缩流只小 6-8 MiB（3-4%）；而 xz 解码的 CPU 与解压后的字节数大致成正比，所以对解码时间约有 8% 帮助 —— 比体积收益（3-4%）更大，但绝对值仍远小于「把 191 MB 换成 158 MB」的量级。
4. 真正的启动时间杠杆是「归档体积 x 压缩率」，不是「删文件数」。当前 200.88 MB 归档 -> 750.43 MB 解压后（3.74x）。若换 preset 6（158.85 MiB），解码时间约按 158.85/191.57 = 82.9% 缩放 -> 约省 17%。
5. 不要混谈：A2.5 的 59.54 MiB 可删集合 -> 压缩后约 6-8 MiB APK 体积。**注意**：A3.1 里的 32.72 MiB 差异是 Fast 档 vs 发布档的差异，**不是**发布链可省的体积（见 A3.1 修订说明），不得计入可省收益。

---

## A5. 交叉发现（不属于本块，交给对应块）

1. 【给 C 块】check-snapshot-decode.mjs 每次全量解码 24.3 s，它刻意用「与设备同一套解码器」（org.tukaani:xz + commons-compress）跑一遍完整解压。这是唯一一条有意做全量解码的门禁（ps1:480-490 注释明确说明）。若 C 块要估设备侧解压成本，这个门禁的耗时是宿主侧最接近设备真实解码路径的代理指标。
2. 【给 C 块】归档是 Blocks: 1（单块流）-> 无法多线程解码。base/base-usr-x86_64.tar.xz 是 21 块（可 -T 并行解码），而最终产物是 1 块。若构建链改成 xz -T8 输出会变多块，设备侧解码是否变快取决于壳侧解码器实现（单流解码器上多块只会增加头部开销）。
3. 【给 B 块】dsh-attachment-formats 已退役但仍占 23.88 MiB，其独占依赖 tesseract.js-core 29.08 MiB —— 合计 52.96 MiB，是整个 home/ 面的 49.3%。home/.dsh/profiles/web/cordis.patch.yml 里明确写了「不再挂载即等于退役」，但包体仍在。
4. 【给 D 块】app/src/main/assets/snapshot.tar.xz 当前是 **Fast 档残留**（sha256 证明等价 xz -1 -T1），不是发布档产物。任何拿当前 assets 做的体积度量都会偏大 43 MB。建议 D 块把「assets 快照的压缩档位标记」加进度量入口（判据：xz --list 的 block 数 + 与 xz -1/-6/-9 的字节对齐）。
5. 【给 D 块】门禁耗时数据可直接复用：A1.4 的逐门禁表（24 条链前门禁）+ A1.6（14 条快照门禁）可与 D 块「41 条合计 216,520 ms」交叉核对。

---

## A6. Top-N 排序表（按 收益/风险 比）

| 排名 | 编号 | 结论 | 预估收益量级 | 改动风险 | 工作量 |
|---:|---|---|---|---|---|
| **1** | A-1 | check-gate-skips 把 79 个门禁全 spawn（含 *.test.mjs 与 check-release-gates 自身）；排除测试入口 + 聚合入口 | 单次构建省 140-190 s | 低（只缩审计面，需显式登记新审计面） | M |
| **2** | A-3 | 构建链两次全量压缩，第一次（xz -T8 -6，85-87 s）产物被注入整份重压丢弃，对最终产物零贡献 | 省 85-87 s/ABI，双 ABI 约 172 s | 低（改注入输出裸 tar，交一次多线程 xz） | M |
| **3** | A-6 | Gradle 硬编码 --no-daemon，每次构建白付 28-30 s 配置；双 ABI = 60 s（Task Execution 仅占 8.8%） | 全链省约 60 s | 低（本地 daemon / CI 保持 --no-daemon，一行条件） | S |
| **4** | A-7 | 9 道快照门禁各自独立全量解码 tar（xz 不可随机寻址），地板成本 20-26 s/次 | 双 ABI 省约 344 s | 中（共享中间产物要保证 ABI 隔离；$work 已按 ABI 分目录） | M |
| **5** | A-3b | 注入步骤把整份归档 BytesIO 三份，峰值约 2.8 GiB | 内存 2.8 GiB -> 数十 MiB | 中（改流式要重写预扫描逻辑，影响 inject-completeness 语义） | L |
| **6** | A-2/attachment | dsh-attachment-formats 23.88 + tesseract.js-core 29.08 = 52.96 MiB，已在装配面退役 | APK 省约 5-7 MiB | 中（若恢复附件 OCR 功能需重新装回） | S |
| **7** | A-2/inspector | @deepseek-ai/dsh-experimental-inspector 22.38 MiB 是 optional bundle、默认关闭 | APK 省约 3-4 MiB | 中（删了该调试功能就没了，需产品确认） | S |
| **8** | A-2/ts | node_modules 内 .ts/.d.ts 24.65 MiB / 4,635 文件 | APK 省约 2-3 MiB | 中-高（.d.ts 可能被 types 字段引用） | M |
| **9** | A-2/docs | usr/share/{vim,gir-1.0,cmake-4.4,info,zsh,doc} + usr/include + .pod + .a = 90.79 MiB | APK 省约 10-15 MiB | 低-中（vim/gcc 能力部分退化） | M |
| **10** | A-2/dup | 多实例包 21.52 MiB（其中 domino 7.38 真重复） | APK 省约 1 MiB | 中（去重可能破坏 peer resolution） | M |
| **11** | A-2/ripgrep | usr/bin/rg 与 @vscode/ripgrep-android-*/bin/rg 两份副本 | APK 省约 1.5-2 MiB | 中（需确认调用点） | S |
| **—** | A-2/sharp | @img/sharp-wasm32 8.50 MiB | **0（不可删：Android 无原生 sharp 二进制，wasm32 是唯一后端）** | 删了图像处理能力消失 | — |
| **—** | A-2（原） | **已撤回**：先前把「Fast 档 191.57 MiB vs 发布档 158.85 MiB」当成发布链体积缺陷 | **0**（发布链本来就产 preset 9） | — | — |

---

## A7. 未测项与原因（诚实清单）

| 项 | 状态 | 原因 |
|---|---|---|
| Python lzma preset 9 在 804 MB 上的编码耗时 | **未测完** | 单线程 preset 9（dict 64 MiB）运行 > 15 分钟未完成，超出审计窗口。其产物体积已被「xz -1 -T1 与磁盘产物 sha256 逐字节相同」覆盖（并已按 Lead 纠正重新解释该证据的指向） |
| inject-all.py 在 716 MiB 真实输入上的内存峰值 | **推导，非实测** | 需约 3 GB 常驻 + 数分钟；只用 bytesio-mem-probe.py 测了 BytesIO 的复制倍率（1.00x raw，线性可外推） |
| 全量 run 一次 build-apk-013.ps1（release 档，双 ABI） | **未跑** | 任务说明明确要求不要跑（8-12 分钟起且无设备）。本报告用「逐段单独计时 + 结构分析」替代 |
| npm run build（注入集产物重建，ps1:44-60）的耗时 | **未测** | 需要 plugins/*/lib 产物与完整 node_modules；perf-audit 工作区是净检出 |
| 9 道快照门禁的「共享单次解码」改造后实测 | **未做** | 属第二阶段实现，本阶段只测量基线 |
| configuration cache 开启后的实测 | **未做** | gradle.properties:5 注释说明 mergeDebugAssets 持 script object 引用，CC 不支持；要开必须先改 task 实现 |
| 快照内文本成员的 import 解析（判 .ts 是否真被引用） | **未做** | 需要写 ESM/TS resolver，超出本块范围；报告里已标注保守做法 |

---

## A8. 环境与方法学备注

1. 所有计时均为宿主并发负载下测得（同期 B/C/D 三块在跑各自的重活）。绝对毫秒会偏高，但同机同轮的相对比较有效。
2. 优先信任字节级/静态计数：A2 的全部数字（体积、文件数、条目数、sha256）不受 CPU 抖动影响，是本报告最硬的证据。A1 的计时只用于排序，不用于绝对值下结论。
3. 负控清单（每条都已在本报告内给出）：
   - xz -1 -T1 复现出与磁盘产物逐字节相同的 sha256 -> 证明「磁盘这份是 Fast 档」这一事实成立（注意：该事实**不**推出「发布链有体积缺陷」，见 A3.1 修订）；
   - xz -0/-1/-2/-6/-9 五个档位给出五个不同字节数 -> 证明体积尺子有区分度；
   - deflate-probe 对 xz 输入返回 100.026%，对 .md 文本返回 22.5% -> 证明 DEFLATE 尺子能区分可压/不可压；
   - probe-gate-cost.mjs（240.9 s）与 check-gate-skips 自身（210.8 / 245.7 s）两次独立测量互相验证；
   - Gradle 自报的 17 executed / 19 from cache 与 3 executed / 33 up-to-date 来自 Gradle 自身日志，非推断。
4. 清理：所有临时解压/压缩产物（%TEMP%\perf-a-*，共 804 MB + 114 MB）已删除；工作区仅保留 .perf-a/（JSON/TSV 中间数据）与 scripts/perf-audit-a/（交付脚本）。
5. 修订记录：2026-11-02 按 Lead 纠正修订 A-2 / A-3.1 / A-4 推论 5 / A-8 / 交叉发现 4 —— 结论方向由「发布链有体积缺陷、可省 32.72 MiB」反转为「磁盘这份是 Fast 档残留，不代表发布包体积；唯一成立的是时间侧的一次压缩浪费 + 一条防线」。复现数据与方法学未改动。
