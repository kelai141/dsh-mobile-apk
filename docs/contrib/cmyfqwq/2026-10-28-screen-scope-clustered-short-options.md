# 屏幕范围门禁：短选项形态没算全（簇 `-lc` 与带参 `-o errexit` 两种绕过）

## 现象

屏幕范围 virtual-only 下，`sh -c '…'` 与 `sh -l -c '…'`（分离写法）都判 `deny-uncertified-target`，
但把 `-l` 和 `-c` 写成**一个簇** `-lc` 就变成 `allow`：

```
sh -lc 'screencap -p /sdcard/real.png'    → allow ❌
sh -ec 'screencap -p /sdcard/real.png'    → allow ❌
sh -xc 'input tap 1 2'                    → allow ❌
su -lc 'screencap -p /sdcard/real.png'    → allow ❌
```

`-lc` 不是手写怪招：cron / systemd / 登录 shell 里到处是 `sh -lc`。命中率比自造变体高得多。

## 真机实测（小米 14 Pro / 23116PN5BC / SDK 37，`/system/bin/sh` = mksh）

| 在设备上执行 | 观测 |
|---|---|
| `sh -lc 'echo SH_LC_RAN'` | 打印 `SH_LC_RAN` |
| `sh -ec 'echo SH_EC_RAN'` | 打印 `SH_EC_RAN` |
| `sh -xc 'echo SH_XC_RAN'` | 打印 `SH_XC_RAN`，并回显 `+ echo SH_XC_RAN`（xtrace） |
| `su -lc 'echo SU_LC_RAN'` | 打印 `SU_LC_RAN`（KernelSU 的 su 也认这个组合） |
| `sh -c 'echo SH_C_RAN'`（对照） | 打印 `SH_C_RAN` |
| `command -v bash` | `NO_BASH`（设备上没有 bash；`-lc` 对 mksh 本身就成立） |

## 真因

`SHELL_C_PAYLOAD` 的尾部要求**光杆** `-c`：

```
… (?:-[^\s]+[ \t]+)*-c[ \t]+([\s\S]*)$
    ↑ 前面的选项必须是「整个词」            ↑ 这里只认 -c
```

`sh -lc '…'` 里 `-lc` 是一个词：`(?:-[^\s]+[ \t]+)*` 想整体吃掉它，之后就不再剩 `-c`；回溯也找不到
一个只等于 `-c` 的独立词 ⇒ 匹配失败 ⇒ 载荷不展开 ⇒ 该段既无屏幕命令词、无目标屏参数 ⇒ `continue` 放行。

`interpreterPayloadUnparsed` 那侧用 `-[^\s]*c` 判断「有 `-c` 所以载荷可见」，`-lc` 是能认的
—— 两份判据对「`-lc` 算不算带 `-c`」的判断不一致，结果就是「不算不可见、也没展开」的空档。

## 修法

尾部改成「短选项**簇**且簇尾是 `c`」：

```
… (?:-[^\s]+[ \t]+)*-[a-zA-Z]*c[ \t]+([\s\S]*)$
```

- `-lc` / `-ec` / `-xc` / `-uc` 都命中（c 在簇尾）；
- `-l -c` 分离写法照旧命中；
- `-o errexit` 这类「短选项带独立参数」的形态本来就不匹配（旧实现同样不匹配，属既有边界，不在本轮扩大）。

两侧同构改（引擎侧 `SHELL_C_PAYLOAD`、壳侧同名 `Regex`）。

## 同一判据的第二个缺口：带独立参数的短选项 `-o` / `+o`

前置组 `(?:-[^\s]+[ \t]+)*` 只认「整词 `-xxx`」，而 `-o errexit` 里的 `errexit` 是**独立参数词**
（既不 `-` 开头、也不在选项簇里）⇒ 前置组卡住 ⇒ 整条不匹配 ⇒ 载荷不展开 ⇒ 放行。

真机实测（同一台，mksh）：

| 在设备上执行 | 观测 |
|---|---|
| `sh -o errexit -c 'echo O_ERREXIT_RAN'` | 打印 `O_ERREXIT_RAN` |
| `sh +o errexit -c 'echo PLUS_O_RAN'` | 打印 `PLUS_O_RAN` |

修法：前置组加一条**排在最前**的分支 `[+-]o[ \t]+\S+[ \t]+`：

```
… [ \t]+(?:[+-]o[ \t]+\S+[ \t]+|-[^\s]+[ \t]+)*-[a-zA-Z]*c[ \t]+([\s\S]*)$
```

必须排前：否则 `-o` 会先被整词分支 `-[^\s]+` 吃掉，剩下的 `errexit` 无处可去，等于没修。

## 复验证据

- 跨语言 fixture 72 → **82** 例（`S-13a`..`S-13d`、`S-14a`/`S-14b` + 4 条 `allow` 对照），壳侧副本由
  `node scripts/gen-screen-scope-fixture.mjs` 机器同步（`WRITE PASSED`）
- 引擎侧 `node --test test/screen-scope.test.mjs` → **47 pass / 0 fail**（82 例逐条断言）
- 壳侧 `:app:testDebugUnitTest --tests ShellOpsScreenCommandFixtureTest` → **10 tests / 0 failures**
- **变异反证（引擎侧）**：
  - 尾部退回光杆 `-c` ⇒ **4 条红**：`S-13a` / `S-13b` / `S-13c` / `S-13d` 全部 `deny-uncertified-target` → `allow`
  - 撤掉 `[+-]o` 分支 ⇒ **2 条红**：`S-14a` / `S-14b` → `allow`
  - 回滚后 82 例全绿
- **变异反证（壳侧）**：同一变异打进 `ShellOps.kt` ⇒ `everyFixtureCaseMatchesTheKotlinVerdict` 红
- 误拦方向的四条对照修复后仍 `allow`：`sh -lc 'echo hi'`、`sh -lc 'screencap -p -d 7 /sdcard/virtual.png'`、
  `sh -o errexit -c 'echo hi'`、`sh -o errexit -c 'screencap -p -d 7 /sdcard/virtual.png'`

## 已知边界

1. `-o errexit -c '…'` 这种「短选项带独立参数」的形态仍然匹配不到（旧实现也一样）。要覆盖它需要
   逐选项知道吃几个参数（`-o` 吃 1、`-c` 吃 1、`-x` 吃 0…），属另一个量级的解析器工作。
2. 组合簇里 `c` **不在尾部**的写法（`-cx`）不会被本轮规则命中；实测语义上 `-cx` 等价于 `-c x`
   （脚本内容就是 `x`），不构成真实绕过路径，故未纳入。
3. **`env -S '<cmdline>'` 不修**：Linux 上它会把字符串拆成 argv 执行（`env -S 'screencap -p /x'`
   等价于直接跑 screencap），但小米 14 Pro 的 toybox 0.8.13 `env` 只支持 `[-0i] [-e FILE] [-u NAME]`、
   实测报 `env: Unknown option 'S'` ⇒ **设备上不是真实路径**。按「真机确证才算缺陷」的口径不纳入，
   记在这里备查（哪天设备换 toybox 或换判定基线，这条要重新评估）。
4. 「任意语言执行器」仍是固有边界（`awk 'BEGIN{system(…)}'`、`perl -e`、`python3 -c` 都 `allow`）；
   本门禁是判据层不是沙箱层。

## 未做设备验证（阻塞原因）

新壳侧代码没装到设备上跑 `scripts/verify-screen-scope-matrix.mjs`：

1. 仓库内嵌 `app/src/main/assets/snapshot.tar.xz` 是 **x86_64**，目标真机是 **aarch64**，
   `build-apk-dev-fast.mjs` 的 ABI guard 直接拒（`snapshot ABI is x86_64 but the target is aarch64`）。
2. 本机没有任何现成 aarch64 快照；重建需 8-12 分钟且本机只有 10 GB 内存；模拟器路线已关闭（AVD boot OOM）。

替代证据：真机 shell 语义实测（四种簇形态都真的执行）+ 两侧 fixture 单测 + 两侧变异反证。
