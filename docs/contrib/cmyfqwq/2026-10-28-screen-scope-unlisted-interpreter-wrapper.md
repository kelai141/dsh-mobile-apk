# 屏幕范围门禁：未登记的解释器包装词会让裸解释器判据失效（`| nice sh` 等）

## 现象

屏幕范围 virtual-only 下，裸解释器的段本来就判 `deny-unparsed`：

```
echo 'screencap -p /sdcard/x.png' | sh        → deny-unparsed ✅
```

但只要给解释器套一层**不在白名单里的包装词**，同一条命令就变成 `allow`：

```
echo 'screencap -p /sdcard/x.png' | nice sh        → allow ❌
echo 'screencap -p /sdcard/x.png' | setsid -w sh   → allow ❌
echo 'screencap -p /sdcard/x.png' | ionice sh      → allow ❌
echo 'screencap -p /sdcard/x.png' | taskset 1 sh   → allow ❌
```

真机上这几条都会真的执行 stdin 里的脚本（见下表）⇒ 载荷不可见的段被放行。

## 真机实测（小米 14 Pro / 23116PN5BC / SDK 37）

| 在设备上执行 | 观测 |
|---|---|
| `command -v nice / setsid / ionice / flock / watch / chrt` | 均在 `/system/bin`；`stdbuf` **不存在** |
| `echo 'echo NICE_RAN' \| nice sh` | 打印 `NICE_RAN` |
| `echo 'echo SETSID_RAN' \| setsid sh` | 打印 `SETSID_RAN` |
| `echo 'echo RAN_ionice' \| ionice sh` | 打印 `RAN_ionice` |
| `echo 'echo RAN_taskset' \| taskset 1 sh` | 打印 `RAN_taskset` |
| `echo 'echo RAN_nice' \| nice -n 5 sh` | 打印 `RAN_nice` |
| `echo '…' \| flock /data/local/tmp/lk sh` | `flock: Max 1 argument`（toybox 实现不接受该形态） |
| `echo '…' \| chrt 0 sh` | `chrt: 0 < 1`（同上） |

## 真因

`interpreterPayloadUnparsed` 是**逐词前进**的：跳过变量赋值、包装器、选项（`-` 开头）、纯数字，
第一个「其它词」就当成命令词并返回。

```ts
if (INTERPRETER_WRAPPERS.has(base) || word.startsWith('-') || /^\d+$/.test(word)) { text = rest.trim(); continue }
if (base === '.' || base === 'source') return true
if (INTERPRETER_NAMES.has(base)) return !/(?:^|[ \t])-[^\s]*c[^\s]*(?:[ \t]|$)/.test(rest)
return false          // ← 未登记的包装词落在这里：被当成"命令词不是解释器" ⇒ 放行
```

`INTERPRETER_WRAPPERS` 原本只有 `env` / `timeout` / `nohup` / `xargs` / `busybox` / `toybox` / `su` /
`command` / `exec`。`nice` 不在其中 ⇒ 循环停在 `nice` 上 `return false` ⇒ 该段无屏幕命令词、无目标屏参数
⇒ 整条 `allow`。**裸解释器判据（#509）因此可以靠"随便套一层包装"绕过。**

## 修法

两侧同构扩充白名单（引擎侧 `INTERPRETER_WRAPPERS`、壳侧同名 `setOf`）：

- 调度 / 资源类（真机实测可喂 `sh`）：`nice` `ionice` `taskset` `setsid` `chrt` `numactl` `unshare` `runcon`
- 缓冲 / 计时 / 锁类：`stdbuf` `time` `flock` `watch`

跳过包装词之后，包装器**自己的**选项与数字参数由既有规则继续跳过（`setsid -w sh` 的 `-w`、
`taskset 1 sh` 的 `1`、`nice -n 5 sh` 的 `-n`/`5`），所以最终能认出裸 `sh`。

## 复验证据

- 跨语言 fixture 72 → **79** 例（`S-11f`..`S-11j` + 2 条 `allow` 对照；72 是本分支 rebase 到含 #756 的 main 之后的基线），壳侧副本由
  `node scripts/gen-screen-scope-fixture.mjs` 机器同步（`WRITE PASSED`）
- 引擎侧单测 `node --test test/screen-scope.test.mjs` → **47 pass / 0 fail**（79 例逐条断言）
- 壳侧单测 `:app:testDebugUnitTest --tests ShellOpsScreenCommandFixtureTest` → **10 tests / 0 failures**
- **变异反证（引擎侧）**：把白名单缩回原样 ⇒ **5 条红**：`S-11f` / `S-11g` / `S-11h` / `S-11i` / `S-11j`
  全部 `deny-unparsed` → `allow`；回滚后 47 pass
- **变异反证（壳侧）**：同一变异打进 `ShellOps.kt` ⇒ `everyFixtureCaseMatchesTheKotlinVerdict` 红，原文
  `命令：echo 'screencap -p /sdcard/x.png' | nice sh expected:<[deny-unparsed]> but was:<[allow]>`；回滚后 10 tests / 0 failures
- 不误拦的对照：`nice -n 5 getprop ro.product.model`、`nice echo hi`、`echo sh -s` 三条在修复后仍 `allow`
  （它们在变异下同样 `allow`，所以本轮判别力全部来自那 5 条 deny 用例）
- `check-kotlin-comments` / `check-code-map` / `check-op-registry-parity` rc=0
- 注：本分支已 rebase 到含 #756 的 main（`65829dec`）。#756 的 `firstPayloadWord`（跳过 `--` 终结符）
  与本轮的白名单扩充互不影响，实测 79 例全绿，数字均为 rebase 后重测。

## 已知边界（白名单的固有边界，必须写清）

这是**白名单**方案，不是"算清 argv 归属"的方案：

1. 下一个没登记的包装词仍会漏（`chpst`、`runuser`、`nsenter`、设备厂商自带工具…）。
2. 带**非数字/非选项参数**的包装器也仍会漏：`flock /tmp/lock sh` 会停在 `/tmp/lock` 上返回 false。
   本轮没把「路径参数」纳入跳过，因为那会误伤 `cat /tmp/sh` 这类正常命令——两害相权选误拦更少的一侧，
   并把这条边界写在文档里，而不是假装封死。
3. 真机上 `flock` / `chrt` 因 toybox 参数限制当前不可用（见上表），登记它们是为了 Linux 侧不漏面。

## 未做设备验证（阻塞原因）

与同批 `--` 终结符那条一致：新壳侧代码没装到设备上跑 `scripts/verify-screen-scope-matrix.mjs`。

1. 仓库内嵌 `app/src/main/assets/snapshot.tar.xz` 是 **x86_64**，目标真机是 **aarch64**，
   `build-apk-dev-fast.mjs` 的 ABI guard 直接拒。
2. 本机没有任何现成 aarch64 快照；重建需 8-12 分钟且本机只有 10 GB 内存；模拟器路线已关闭（AVD boot OOM）。

替代证据：真机 shell 语义实测（证明绕过真实可执行）+ 两侧 fixture 单测 + 两侧变异反证。
