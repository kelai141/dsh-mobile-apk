# 命令名被引号拆开（`scr''eencap`）时门禁放行

## 现象

`stripQuotedText` 会把引号内容抹掉（空引号对什么都不留），于是命令词面里看不到 `screencap`：

```
scr''eencap -p /sdcard/x.png          -> allow
scr"e"encap -p /sdcard/x.png          -> allow
sh -c "screen""cap -p /sdcard/x.png"  -> allow
```

但 shell 的**引号拼接**让它们等价于 `screencap`（相邻词被连接）。

## 真机实测（2026-10-28，小米 14 Pro / SDK 37）

```
adb shell "scr''eencap -p /sdcard/t-q1.png"   -> RC=0，出图 2857682 B
adb shell 'scr""eencap -p /sdcard/t-q3.png'   -> RC=0，出图 2858029 B
adb shell "screencap -p /sdcard/t-q2.png"     -> RC=0，出图 2858029 B（对照）
```

三条等价 ⇒ 门禁的 `allow` 是真放行。

## 修法

判据：**词内引号**——引号紧邻前一个非空白字符即视为 token 被拆开拼接，词面已不可信 ⇒
`deny-unparsed`。

必须写成 **quote-aware 状态机**，不能用单正则：闭合引号同样「紧邻非空白」，
`sh -c "…200"` 的收尾引号会被误判——第一版正则把 **35/96 条 fixture 误拦**（含
`echo "a b"`、`eval "screencap …"`、全部 `sh -c "…"` 形态）。状态机只在**进入引号**时检查前一位。

`$'…'`（ANSI-C 引号）与 `$"…"` 的 `$` 前缀属正常语法，显式排除——否则
`$'screencap' -p /sdcard/x.png` 会从 `deny-uncertified-target` 退化成 `deny-unparsed`。

两侧同改：引擎 `plugins/dsh-android-bridge/src/screen-scope.ts` + 壳侧
`app/src/main/java/com/dsharnessmobile/shell/ShellOps.kt`（`hasGluedQuote` 逐行同构）。

## 复验证据

fixture 加 3 条（`plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json`，共 102 条；
Kotlin 副本由 `node scripts/gen-screen-scope-fixture.mjs` 生成）：

| 用例 | 期望 |
|---|---|
| S-18a `scr''eencap -p /sdcard/x.png` | `deny-unparsed` |
| S-18b `scr"e"encap -p /sdcard/x.png` | `deny-unparsed` |
| S-18c 对照 `echo "a b"` | `allow`（词边界引号不得误拒） |

- **fixture 逐条对比 96/96 全对**（首版基线；改基到 `ebac75e1` 后为 **121/121**，见文末附二）
- **变异反证**：`if (hasGluedQuote(segment))` → `if (false && …)` ⇒ 只红 **S-18a / S-18b 两条**
  （均为 `allow`），其余 94 条不动；回滚后 0 mismatch
- bridge `npm test` → **173 pass / 0 fail**
- Kotlin `ShellOpsScreenCommandFixtureTest` → **10 tests / 0 failures / 0 errors**（42 s，非假绿）
- 门禁：`check-bridge-symmetry` / `check-op-registry-parity` / `check-kotlin-comments` /
  `check-tool-output-schema` / `check-code-map` 全 PASSED

## 锚点连带改动

本 PR 在两侧文件顶部插入了 `hasGluedQuote` / `GLUED_LINE_CONTINUATION`，执行地图里两条**带
`#expect` 的新式引用**必须随之下移（`--refresh-anchor-baseline` 只重铺 legacy 引用，这两条它不管）。

行号一律 `grep -n` 现查，不推算。完整轨迹见文末附二，此处只列结论：

| 引用 | main `345c142c`（#789 已修） | 本 PR 分支（插入后） | 命中行内容 |
|---|---|---|---|
| `ShellOps.kt` | `:412` | **`:442`** | `if (interpreterPayloadUnparsed(stripQuotedText(segment))) return false` |
| `screen-scope.ts` | `:420` | **`:457`** | `if (inner === '$' && text[j + 1] === '(') {` |

即本 PR 的锚点改动 = **main 现值 + 自身插入偏移**（Kotlin +30 行、TS +37 行）。

历史背景：`354` / `385` 这两个旧值在 `95aca213` 与 `ebac75e1` 上都已指向错行（354 行实为
`audit(context, "shRemove", …)`），**不是我引入的**；本 PR 首版曾顺手把它们修成定义行
（149/451），但维护者在 **#789** 里以「指向调用行」的方式统一修正为 412/420，本 PR 最终
**跟随 #789 的语义**，只加自己的偏移。

`--refresh-anchor-baseline` 重铺 1113 条 legacy 引用后 `node scripts/check-code-map.mjs` → PASSED。
这类 legacy 漂移由 `--refresh-anchor-baseline` 按仓库既定机制吸收，不属于本 PR 的判据改动。

## 补充：词内 ANSI-C 引号（`s$'cre'encap`）同样绕过

第一版 `hasGluedQuote` 为不误伤 `$'screencap'`（ANSI-C 引号整词）而排除了 `$` 前缀——
但那只在 `$` 处于**词首**时成立。`$` 前面还有普通字符时仍是词内拼接：

```
s$'cre'encap -p /sdcard/x.png   -> allow
```

真机实测（2026-10-28，小米 14 Pro / SDK 37）：

```
adb shell "printf '%s\n' s\$'cre'encap"        -> screencap
adb shell "s\$'cre'encap -p /sdcard/t-a.png"   -> RC=0，出图 2857999 B
adb shell "screencap -p /sdcard/t-b.png"      -> RC=0，出图 2857999 B（同字节）
```

修法：进入引号时前一位是 `$`，则**再看一位**——`$` 在词首属正常语法，否则算拼接。
fixture 加 S-18d（判拒）与 S-18e（`$'screencap'` 词首形态保持 `deny-uncertified-target` 的对照），
共 **98 条**；变异把 `anchor` 逻辑退回只看 `prev` ⇒ 只红 **S-18d** 一条。

### 顺带否掉一条假绕过

`$'\x73creencap'`（十六进制转义）看起来更隐蔽，但 **mksh 不展开 `\x`**：

```
adb shell "printf '%s\n' $'\x73creencap'"  -> ܼreencap（乱码）
adb shell "$'\x73creencap' -p /sdcard/t.png" -> RC=127，inaccessible or not found
```

展开结果是乱码而非 `screencap` ⇒ **真机不可利用**，属「allow 但不可利用」那一类，
不进判据（只做记忆，不加 fixture）。这与 `screencap -d 7.0`、`input -d 浮点` 同型。

## 补充二：反斜杠续行把命令名拆到下一行（`scr\<换行>eencap`）

`stripQuotedText` 不动续行，命令词面里看到的是 `scr` + 换行 + `eencap` ⇒ 匹配不到任何家族 ⇒ 放行。

真机实测（2026-10-28，小米 14 Pro / SDK 37）：

```
adb shell "scr\<换行>eencap -p /sdcard/t-c.png"  -> RC=0，出图 2862760 B
adb shell "screencap -p /sdcard/t-d.png"         -> RC=0，出图 2862760 B（同字节）
```

判据：`/[^\s]\\\r?\n[^\s]/` —— 续行**两侧都紧邻非空白**才算拼接。
`screencap\<换行> -p …`（续行后是空格）是正常续行，保持既有 `deny-uncertified-target`（S-18g 对照）。
fixture 加 S-18f/S-18g，共 **102 条**；变异只红 **S-18f** 一条。

### 又证伪两条

- `scr` + tab + 空格 + `eencap` ⇒ 真机 **RC=127** `scr: inaccessible or not found`（词已分开，不可利用）；
- `scree` + 裸换行 + `ncap` ⇒ shell 视为**两条命令**，两条都不存在。

两者都属「allow 但真机不可利用」，不进判据。

## 已知边界

1. 代价：`--opt="v"` 这类「引号紧邻 `=`」的写法会被拒（fail-closed 方向，宁可误拒）。
   实测受影响命令：`export K="v"`、`cmd --flag="x"`；在 adb shell 读屏场景里罕见。
2. 只处理**引号拼接**；反斜杠拼接（`s\creencap`）与变量拼接（`$a$b`）已由既有判据覆盖
   （分别 `deny-uncertified-target` / `deny-unparsed`）。
3. 未处理 `$'..'` 内部的反斜杠转义拼接（`$'scr\eencap'` 之类）——ANSI-C 引号语义需另立项。

## 附：本 PR 的 rebase 记录（2026-10-29 00:20）

`#785` 合入后本 PR 与 main 在**同一位置各插入 case**，两个 fixture 文件都产生交错冲突
（一个 case 的 `name`/`command` 分属两侧、`ownedTargets` 以下是公共段），逐处缝合容易破坏 JSON。

正确处理：`#785` **只改了 fixture**（+20 行 / 10 条 case），没动 `screen-scope.ts` 与 `ShellOps.kt`
⇒ `git rebase --abort` 后从 `origin/main` 重开分支、把两处判据与 7 条 case **重做一遍**，
比解交错冲突干净得多（fixture 95 → 102）。

**顺带一次操作失误（已在记忆里改）**：第一次做变异前忘了先 commit，`git checkout -- <file>`
把未提交的 TS 判据整段抹掉（Kotlin 与 fixture 因为没被 checkout 而幸存），等于白改一轮。
纪律重申：**先 commit 再变异**，`git checkout --` 只对已提交内容成立。

## 附二：改基史（本 PR 先后改基三次）

本 PR 首版基于 `95aca213`，推送前 main 接连前进了两次，每次都必须重做。

| 次数 | main 基座 | 触发 | 本 PR 做了什么 |
|---|---|---|---|
| 1 | `95aca213` | — | 首版实现；fixture 95 → 102，锚点 354→149 / 385→451 |
| 2 | `ebac75e1` | **#788** 把 #766/#767/#768/#764 四判据合入（fixture 93 → 114） | abort 后从新 main 重做；判据插入点未冲突（那四条落在家族表/包装器白名单/拒绝文案）；fixture 114 → 121 |
| 3 | `345c142c` | **#789** 重铺锚点基线并修正 2 处 `#expect`（把 354/385 改成 412/420） | 同法重做；**锚点语义改为跟随 #789**（指向调用行，不是定义行） |

### 为什么每次都 abort 重做而不解冲突

两次都是同一形态：对方只动 fixture 或只动文档/基线，本 PR 的插入点在别处，**重放比重缝干净**
（首版记录见附一：交错冲突会把一个 case 的 `name`/`command` 分属两侧）。

### 锚点行号的完整实测轨迹

行号一律 `grep -n` 现查，不推算：

| 引用 | `95aca213` | `ebac75e1` | `345c142c`（#789 修后） | 本分支（含本 PR 插入 30/37 行） |
|---|---|---|---|---|
| `ShellOps.kt` | `:354`（陈旧，实为 `audit(...)` 调用） | `:412`（地图仍写 354 ⇒ 红） | **`:412`**（已由 #789 修正） | **`:442`** |
| `screen-scope.ts` | `:385`（陈旧，实为注释行） | `:420`（地图仍写 385 ⇒ 红） | **`:420`** | **`:457`** |

命中行内容：
- `ShellOps.kt` → `if (interpreterPayloadUnparsed(stripQuotedText(segment))) return false`
- `screen-scope.ts` → `if (inner === '$' && text[j + 1] === '(') {`

**语义选择**：#789 把这两条锚点指向**调用行**而非定义行。本 PR 跟随该选择（三条候选行都含期望串，
门禁都认；但指向调用行才与「K06：`"` 分支对引号内的 `$(...)` 递归扫描」这句描述对应）。
`--refresh-anchor-baseline` 重铺 1113 条 legacy 引用后 `node scripts/check-code-map.mjs` → PASSED。

## 复验（改基到 `345c142c` 后全部现跑）

| 项 | 结果 |
|---|---|
| fixture 逐条对比 | **121 条 / 0 mismatch** |
| 壳侧副本一致性 `gen-screen-scope-fixture --check` | **PASSED** |
| `node --test test/screen-scope.test.mjs` | **47 pass / 0 fail** |
| bridge `npm test` | **173 pass / 0 fail** |
| Kotlin `ShellOpsScreenCommandFixtureTest` | **10 tests / 0 failures / 0 errors**（XML 复核） |
| 7 条门禁 | `check-bridge-symmetry` / `check-op-registry-parity` / `check-kotlin-comments` / `check-tool-output-schema` / `check-plugin-tests` / `check-protocol-v2` / `check-code-map` **全 PASSED** |

## 变异反证（两侧都做）

引擎侧（`screen-scope.ts`，撤判据后跑 121 条对比）：

| 撤掉的判据 | 变红用例 | 说明 |
|---|---|---|
| `hasGluedQuote` | **S-18a / S-18b / S-18d**（三条均 `allow`） | 只红引号拼接三条；对照 S-18c（词边界引号）/ S-18e（词首 ANSI-C）不动 |
| `GLUED_LINE_CONTINUATION` | **S-18f**（`allow`） | 只红续行一条；对照 S-18g（续行后接空格）不动 |

恢复后重跑 → 0 mismatch。

壳侧（`ShellOps.kt`，把 `hasGluedQuote(segment)` 短路成 `hasGluedQuote(segment) && false`）：

- `ShellOpsScreenCommandFixtureTest` → **10 tests / 0 skipped / 1 failure**
- 失败信息：`命令：scr''eencap -p /sdcard/x.png expected:<deny-unparsed> but was:<allow>`
- ⇒ 壳侧读同一份 fixture 得出同样结论，**不是只有引擎侧生效**（「一层放行、另一层拒绝」是这条门禁
  最危险的失效形态，必须两侧都验）
- 恢复后重跑 → **10 / 0 / 0 / 0**

## 未做设备验证（环境阻塞，非省略）

本 PR 属 L2（门禁自身判据）+ L3（壳侧 Kotlin 行为），按 AGENTS.md §4.2 应跑打包后三层验收。
当前**不可行**：仓内 `app/src/main/assets/snapshot.tar.xz` 是 x86_64，可用真机是 aarch64
（小米 14 Pro / SDK 37），`build-apk-dev-fast.mjs` 的 ABI guard 直接拒绝；仓内无 aarch64 快照，
重建需 8-12 分钟且 10 GB 宿主机内存不足（起 AVD 会 OOM）。

已做到的替代证据：判据的**真机等价性**本身在真机上实测过（引号/续行四种拼写的 RC 与出图字节数，
见前文各节）。缺的是「装进 APK 后拒绝文案的用户可见行为」这一层。
