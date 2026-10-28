# 命令词用 glob 拼出屏幕命令名（`scr?encap`）时门禁放行

## 现象

`stripQuotedText` 不动 glob 元字符，家族 pattern 又是字面匹配，于是命令名被 glob 拆开后
**词面与任何家族都匹配不上** ⇒ `families.length === 0` ⇒ 无 `-d` 凭据 ⇒ 放行：

```
/system/bin/scr?encap -p /sdcard/x.png     -> allow
/system/bin/[s]creencap -p /sdcard/x.png   -> allow
/system/bin/scree*cap -p /sdcard/x.png     -> allow
cmd win?ow size 900x1600                   -> allow
input t?p 1 2                              -> allow
```

## 真机实测（2026-10-28，小米 14 Pro / 23116PN5BC / SDK 37 / mksh）

展开验证（`printf '%s\n' <pattern>`，都是真机 shell 自己展开的）：

```
/system/bin/scr?encap       -> /system/bin/screencap
/system/bin/[s]creencap     -> /system/bin/screencap
/system/bin/scree*cap       -> /system/bin/screencap
```

真执行与出图字节：

| 命令 | RC | 出图 |
|---|---|---|
| `/system/bin/scr?encap -p /sdcard/glob-q.png` | 0 | **2861741 B** |
| `/system/bin/[s]creencap -p /sdcard/glob-c.png` | 0 | **2861741 B** |
| `/system/bin/scree*cap -p /sdcard/glob-s.png` | 0 | **2861649 B** |
| `screencap -p /sdcard/glob-z.png`（对照） | 0 | **2861649 B** |

前两条与第三条字节不同只是因为中间状态（屏幕内容变了），**每一种都与同时刻的对照同字节** ⇒ 真等价。

## 修法

两个分支，任一侧命中即 `deny-unparsed`：

1. **命令词 glob 展开**：取段首词的 basename，若含 `*` / `?` / `[`，用 glob 匹配
   `screencap` / `screenrecord` / `input` / `wm` / `uiautomator` / `dumpsys` / `sendevent` /
   `getevent` / `monkey` / `am`，任一命中即拒。
2. **子命令位 glob**：段首词本身是 `cmd` / `wm` / `input` / `am` / `dumpsys` / `uiautomator` /
   `monkey` / `sendevent` / `getevent` 之一且段内**引号外**存在 glob ⇒ 拒。
   （`cmd win?ow size 900x1600` 与 `cmd window size 900x1600` 等价，后者是真的改真实屏。）

两侧同源：`plugins/dsh-android-bridge/src/screen-scope.ts` 与
`app/src/main/java/com/dsharnessmobile/shell/ShellOps.kt`（`hasUnquotedGlob` / `globMatch` /
`globExpandsToScreenCommand` 三函数逐分支同构）。

### 为什么用贪心指针匹配而不用「转成正则再 match」

glob 与正则元字符大面积重叠，转换过程本身是新的判定面（`$`、反斜杠、`[` 的转义漏一处就是
漏拦或误拦）。逐字符走指针只有 4 个分支，行为可逐条 fixture 核对。不支持 `[a-z]` 范围写法 ——
判据只需回答「这个名字能不能拼出已知命令名」，单字符集足够。

## 不误伤（每条都有对照用例）

| 写法 | 判定 | 为什么 |
|---|---|---|
| `ls /sdcard/x*.png` | allow | glob 只在参数位，不改变命令身份 |
| `rm /sdcard/x*` | allow | 同上 |
| `"/system/bin/scr?encap" -p …` | allow | 引号内 glob 不展开，真机 RC=127 `inaccessible or not found` |
| `screencap -d 7 -p …` | allow | 既有的已认证目标屏路径不受影响 |
| `echo a?b` | allow | 命令词不是屏幕家族，参数位 glob 不参与判定 |

## 不可利用形态（不进判据，只记边界）

```
scr{e}encap -p /sdcard/g2.png   -> RC=127  /system/bin/sh: scr{e}encap: inaccessible or not found
scr{e,e}encap -p /sdcard/g1.png -> RC=1    （展开成两个 screencap 词，参数错位）
{screencap} -p /sdcard/g3.png   -> RC=127
```

mksh 的 brace 展开要求至少一个逗号或多个元素，单元素不展开；`{e,e}` 展开成两个词后
`-p` 成了第一个 `screencap` 的无效参数 ⇒ 都执行不成。

## 复验证据

- fixture 114 → **123 条 / 0 mismatch**（新增 S-19a~S-19i：5 判拒 + 4 对照）
- 壳侧副本 `gen-screen-scope-fixture --check` → PASSED
- bridge `npm test` → **173 pass / 0 fail**
- Kotlin `ShellOpsScreenCommandFixtureTest` → **10 tests / 0 failures / 0 errors**（38 s，XML 复核）
- 门禁：`check-bridge-symmetry` / `check-op-registry-parity` / `check-kotlin-comments` /
  `check-tool-output-schema` / `check-protocol-v2` / `check-code-map` → PASSED

## 变异反证（三条，证明两个分支各有独立判别力）

| 变异 | 变红用例 |
|---|---|
| 撤掉整个 glob 判据调用 | **S-19a / S-19b / S-19c / S-19d / S-19e**（五条全部，均 `allow`） |
| 只撤「子命令位」分支 | **S-19d / S-19e**（只有子命令位两条） |
| 只撤「命令词 glob 展开」分支 | **S-19a / S-19b / S-19c**（只有命令词三条） |

恢复后 0 mismatch；四条对照用例（S-19f/g/h/i）在任何一次变异里都不红 ⇒ 判据没有把正常
用法一起带走。

## 踩到的坑：Kotlin 块注释支持嵌套

第一版把真机证据写进注释，其中一条是 `` `ls /sdcard/*.png` `` —— 序列 `/` + `*` 构成 `/*`，
Kotlin 的块注释**可嵌套**，于是开启了第二层注释；后面的 `*/` 只关掉第二层，整块代码被第一层
注释吞掉，编译报 `Syntax error: Expecting member declaration` 指在**下一个 raw string** 上
（位置随插入长度漂移，很误导）。同类写法已全部改写（`/sdcard/x*.png`）。

**判据**：在 Kotlin 块注释里引用路径 + 通配时，只要出现 `/` 紧跟 `*` 就会开新层；JS/TS 侧
块注释不嵌套所以同一份注释在 TS 里不报错 —— 「两侧注释抄同一份」会踩这个坑。

## 未做设备验证（环境阻塞，非省略）

属 L2（门禁自身判据）+ L3（壳侧 Kotlin 行为），按 AGENTS.md §4.2 应跑打包后三层验收。
当前不可行：仓内 `app/src/main/assets/snapshot.tar.xz` 是 x86_64、真机 aarch64，
`build-apk-dev-fast.mjs` 的 ABI guard 直接拒绝；无 aarch64 快照，重建需 8-12 分钟且 10 GB
宿主机内存不足。

替代证据：判据的**真机等价性**已在真机上实测（展开结果 + RC + 出图字节，见上）。缺的是
「装进 APK 后拒绝文案的用户可见行为」这一层。
