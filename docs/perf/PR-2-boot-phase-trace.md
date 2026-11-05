# PR2 — 冷启动细分段埋点（性能审计 #6）

## 改了什么

新增 `BootPhaseTrace`，把四个此前**完全没有埋点**的冷启动分段落到 `files/boot-phase-trace.log`。

| 分段 | 落点 | 采集方式 |
|---|---|---|
| `onCreate` | `MainActivity.onCreate` 入口基准 → `setContentView` 之后 | 单调时钟差值 |
| `webviewConstruct` | `webView = WebView(this)` 前后 | 单调时钟差值 |
| `snapshotExtract` | `EngineManager.extractSnapshotTo` 解压前后 | 单调时钟差值 + 压缩字节数 |
| `loaderSettle` | `LogCollector` 既有 probe tail 窗口 | 解析引擎 `[perf] phase name=loader-settle ms=` |

行格式：`dsh-boot-phase phase=<name> at=<ms>ms [note]`。

## 开关（按拍板：只加在 dev/诊断开关下）

四个分段全部由 `MainActivity.DevLogPrefs.isEnabled(context)`（设置 → 开发者选项 → 开发者调试日志，**默认 false**）闸门。

| 状态 | 行为 |
|---|---|
| 开关关（默认，发布包） | `enabled()` 读一次已缓存布尔值后直接 return；不取时刻、不分配对象、不碰磁盘 |
| 开关开 | 单次启动最多 4 行；文件超 64 KiB 轮转一代 `.1` |

既有 `boot-segments.log`（`t_boot_start`/`t_listen`/`t_compose_total`/`t_first_http`）**完全未改动**——它是常开判据面，与本模块物理隔离，动本 PR 不可能影响它。

## `loaderSettle` 为什么必须能返回 null

`loader-settle` 是引擎进程内部的量。出厂引擎 argv 不装 phase 探针 ⇒ 绝大多数设备上该行**不存在**。
此时如实写 `absent=probe-not-installed`，**绝不写 0 冒充**（0 会让门禁读成「瞬间完成」）。与既有 `t_compose_total` 的 `-1` 口径同源。

---

# 锚点重钉的三项证据（按复核要求逐条给出）

## 证据 1：锚点总数前后相等，失效数为 0

```
BEFORE (3f9ad738)  盘点: 查点 19 · 覆盖条目 411 · 锚点 1102 · 耦合边 152 · 流程图 16 · 全域文件 946
                   CHECK-CODE-MAP PASSED（覆盖完整、锚点有效、编号一致）

AFTER  (40684aff)  盘点: 查点 19 · 覆盖条目 412 · 锚点 1102 · 耦合边 152 · 流程图 16 · 全域文件 948
                   CHECK-CODE-MAP PASSED（覆盖完整、锚点有效、编号一致）
```

**锚点 1102 → 1102，严格相等，失效 0 条。**
另两项变化均为预期内且可解释：
- 覆盖条目 411 → 412（+1）：新增 `BootPhaseTrace.kt` 登记进覆盖账本。
- 全域文件 946 → 948（+2）：新增 `BootPhaseTrace.kt` 与 `BootPhaseTraceTest.kt`。

## 证据 2：仍能变红（证明重钉没把门禁弄成永远绿）

把 `EngineManager.kt:2557` 那条 `#expect` 的值改错**一个字符**（`absolutePath` → `absolutePatH`）：

```
$ node scripts/perf-audit-lead/nc-expect.mjs break
injected: one char changed (absolutePath -> absolutePatH)

$ node scripts/check-code-map.mjs
CHECK-CODE-MAP FAILED（1 项）：
  - [bad-anchor-content] Expected "\"DSH_HOME\" to ensurePrivateDshData().absolutePatH" at EngineManager.kt:2557,
    actual line: "\"DSH_HOME\" to ensurePrivateDshData().absolutePath,"
```

还原后：

```
$ node scripts/perf-audit-lead/nc-expect.mjs restore
restored
$ node scripts/check-code-map.mjs
CHECK-CODE-MAP PASSED（覆盖完整、锚点有效、编号一致）
```

`git status` 确认文档已完全还原，无残留。**门禁在重钉后依然逐字敏感，不是永远绿。**

## 证据 3：基线 JSON 变动逐类归因（合计严格等于 dropped）

`scripts/check-code-map-anchor-baseline.json` 结构：`legacyReferenceCounts` / `sourceLines` / `symbols` / `symbolHashes` / `couplings`。

### 3.1 键级变动（按顶层段）

```
section               before  after | dropped added valueChanged
legacyReferenceCounts    968    889 |      79     0            0
sourceLines              967    889 |      78     0           77
symbols                   62     61 |       1     0            1
symbolHashes              81     78 |       3     0            0
                                    |     161     0           78
```

### 3.2 dropped 161 条的四类归因（**合计严格相等**）

| 类 | 含义 | 条数 |
|---|---|---:|
| A 行号漂移 | 该文件锚点仍在，只是行号变了（内容未变） | **62** |
| B 路径规范化 | 同一锚点以「裸文件名 / 全路径」两种写法各存一份，刷新后归一为一种 | **52** |
| C 旧键彻底失效 | 该文件已无任何行号锚点，或内容已变到无法重钉 | **43** |
| D 符号锚点淘汰 | `composer-sheet.ts#ComposerSheet` 的旧 symbol 与其 3 个历史哈希 | **4** |
| | **合计** | **161 = dropped** |

脚本内置严格断言：`sum(cats) === dropped` → 输出 `严格相等: true`。

### 3.3 新增键 = 0

本次刷新**没有新增任何键**。新文件 `BootPhaseTrace.kt` 进的是 `EXECUTION-MAP.md` 的覆盖账本，不是本基线 JSON。

### 3.4 行数 vs 键数对账（439 行删除怎么来的）

```
git numstat: inserted=126  deleted=439
键级删除 = dropped(161) + valueChanged(78) = 239
键级新增 = added(0)     + valueChanged(78) = 78
行级残差(删) = 439 - 239 = 200
行级残差(增) = 126 -  78 =  48
```

残差的真实成因（已定量，非推测）：
- 文件行数 4355 → 4042（**-313 行**）。
- 忽略顺序的集合差：仅存在于旧版的行 322 条，仅存在于新版的行 96 条。
- 即 439/126 这对 numstat 数字里，包含 JSON 序列化后**同段内键序变化**被 git 按行 diff 记成的整块一删一增。**没有任何无关文件被清空**——`couplings` 152 条前后完全相同，`formatVersion` 均为 3。

---

# 事故披露（两件，均为我自己造成并已回退）

## 事故 1：`--derive-anchors --write` 改写了未触碰的文件

- **怎么发生**：初次处理锚点漂移时，我用了门禁的全量推导 `--derive-anchors --write`。它按设计会**整体改写**执行地图，实测一次改写 1065 处引用，波及我从未碰过的 `plugins/dsh-android-manage/src/index.ts`、`dsh-client-ui-responsive/.../native-browser-adapter.ts` 等。
- **怎么发现**：跑完立刻看 `git diff --stat`，发现 `EXECUTION-MAP.md` 变动规模远超我的改动面（上千行），并出现与本次任务无关的插件文件锚点。
- **怎么回退**：`git checkout -- docs/AGENTS/EXECUTION-MAP.md` 完全回退，改用门禁的 `--refresh-anchor-baseline` 路径。
- **后续如何避免**：**先 dry-run 看改动规模再落盘**——该工具本身默认 dry-run，会打印「将改写 N 处引用 + 前后 sha256」，我当时跳过了这一步。凡会大范围改写受版本控制文件的操作，必须先读 dry-run 输出并与预期改动面比对。

## 事故 2：误在工作区建了占位快照

- **怎么发生**：为让 `:app:compileDebugKotlin` 跑通（`app/build.gradle.kts` 的 `whenTaskAdded` 要求 `assets/snapshot.tar.xz` 在场），我建了一个 1 MB 占位文件。
- **怎么发现**：提交前跑清理检查时，发现该路径存在且体积与我建的不符（200,877,488 B）——说明它**不是**我的占位，而是审计期间协作者跑 gradle 时留下的真实产物（该路径被 `.gitignore` 忽略）。
- **怎么回退**：确认它被 gitignore 后未删除（删除会破坏他人的构建缓存），仅确认它**不进提交**。
- **后续如何避免**：需要构建产物在场时，优先用 `-x` 排除相关 task 或指向既有产物的软链，而不是在工作区新建大文件；建之前先 `git check-ignore` 确认可见性。

---

# 数值与验证

| 指标 | 改动前 | 改动后 |
|---|---|---|
| 冷启动可分段数 | 4（全引擎侧，无壳侧分段） | 8（+4 壳侧分段） |
| 发布包默认额外 IO | — | **0 字节**（开关默认关） |
| 开关打开时单次启动写入 | — | ≤4 行，<800 B |
| `check-code-map` 锚点 | 1102 | 1102 |

本 PR **不改变任何耗时**，它只补上「本轮最大的证据缺口」——让后续每一条启动优化可量化。

## 负控

| # | 注入的缺陷 | 期望 | 实测 |
|---|---|---|---|
| NC-1 | `loaderSettleMs` 在探针缺席时返回 `0` 而非 `null`（「把缺失当 0」） | 相关用例判红、其余仍绿 | 8 例中 **3 例判红**（`IsNullWhenProbeAbsent` / `IsNullWhenLineHasNoNumber` / `IgnoresOtherPhases`），5 例仍绿 |
| NC-2 | 改错一条 `#expect` 的一个字符 | 门禁判红 | `CHECK-CODE-MAP FAILED（1 项）`，精准指向该锚点 |

两处注入均已还原，`NEGATIVE-CONTROL` 标记残留 0 处。

## 测试与门禁

| 项 | 结果 |
|---|---|
| `:app:testDebugUnitTest`（全量） | PASS |
| `BootPhaseTraceTest` | 8/8 PASS（JVM，无 Robolectric） |
| `check-kotlin-comments.mjs` | PASSED |
| `check-perf-instrumentation.mjs` | PASSED（缺口台账 0 条） |
| `check-code-map.mjs` | PASSED（锚点 1102 不变） |
| `check-release-gates.mjs` | PASSED（42 项，SKIP=1） |

## 风险与验证档位（**未做设备验证**）

- 风险：低。默认关闭；关闭时零 IO；所有写入包在 try/catch，失败只记 logcat 不影响启动。
- 档位：**L3（壳侧行为改动）** ⇒ 按铁律 2 需即时模拟器三层验收。
- **本轮设备全部关闭，未执行设备验证。** 本 PR 进入发版候选前**必须**补三层验收（代码层已具备：8 例单测 + 2 条负控；CDP 层与 ADB 用户层缺失）。
- 设备侧验证命令（补齐时用）：
```
adb shell run-as com.dsharnessmobile.shell cat files/boot-phase-trace.log
# 期望：开关关闭时该文件不存在或为空；打开后每次冷启动 3-4 行
```

## 复现

```
./gradlew.bat :app:testDebugUnitTest --tests 'com.dsharnessmobile.shell.BootPhaseTraceTest'
node scripts/check-code-map.mjs
node scripts/perf-audit-lead/classify-baseline-diff.mjs   # 证据3 归因脚本
node scripts/perf-audit-lead/nc-expect.mjs break|restore     # 证据2 负控
```
