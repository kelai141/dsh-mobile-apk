# 屏幕范围门禁：`--` 是选项终结符，不是载荷（trap / sh -c / eval 三条载荷入口共漏）

## 现象

屏幕范围为 virtual-only 时，下面三条都判 `allow`，而它们在真机上**都会执行 `--` 后面的命令**：

```
trap -- 'screencap -p /sdcard/real.png' EXIT      # 读真实屏
sh -c -- 'screencap -p /sdcard/real.png'          # 读真实屏
eval -- 'input tap 1 2'                           # 输入落在真实屏
```

`--` 被引号包裹时同样成立（`trap "--" '…' EXIT`、`sh -c "--" '…'`、`eval "--" '…'`）。

## 真因

`splitCommandSegments` 的载荷展开队列（`sh -c` / `eval` / `trap` 三个入口共用）取的是载荷的**第一个词**：

```ts
const inner = firstShellWord(payload[1]).word   // payload[1] = "-- 'screencap -p /sdcard/real.png' EXIT"
```

`--` 是 shell 的**选项终结符**，不是载荷。取到 `--` 后 `scan('--')` 只产出一段既无屏幕命令词、也无目标屏参数的 `--` ⇒
`families.length === 0 && options.length === 0` ⇒ `continue` 放行。

`firstShellWord` 会先剥引号，所以 `trap "--" '…'` 取到的词同样是 `--`，判据必须用**解引号之后**的词。

## 真机实测（小米 14 Pro / 23116PN5BC / SDK 37，`/system/bin/sh` = mksh，`toybox` 无 `sh` 命令）

| 命令（在设备上执行） | 观测 |
|---|---|
| `trap -- "echo TRAP_DASHES_RAN" EXIT` | 打印 `TRAP_DASHES_RAN` |
| `trap "echo TRAP_PLAIN_RAN" EXIT`（对照） | 打印 `TRAP_PLAIN_RAN` |
| `sh -c "sh -c -- 'echo SH_C_DASHES_RAN'"` | 打印 `SH_C_DASHES_RAN` |
| `eval -- "echo EVAL_DASHES_RAN"` | 打印 `EVAL_DASHES_RAN` |
| `trap "--" "echo Q_TRAP_RAN" EXIT` | 打印 `Q_TRAP_RAN` |
| `sh -c "--" 'echo Q_SHC_RAN'` | 打印 `Q_SHC_RAN` |
| `eval "--" "echo Q_EVAL_RAN"` | 打印 `Q_EVAL_RAN` |
| `trap --    "echo MULTISPACE_RAN" EXIT` | 打印 `MULTISPACE_RAN` |
| `su -c -- 'echo SU_DASHES_RAN'` | `/system/bin/sh: --: unknown option`（`su` 不吃 `--`） |

本机（Debian 12）交叉确认：`dash` / `bash` / `busybox sh` 的 `trap --`、`sh -c --` 都会执行；
`eval --` 只有 `bash` 执行（dash/busybox 落 `not found`）。三者对「载荷在哪个位置」的理解都要求跳过终结符，
故按 mksh 行为 fail-closed。

## 修法

两侧同构新增 `firstPayloadWord`：跳过**解引号后恰好等于 `--`** 的词（上限 8 次），其余行为不变。

- 只跳 `--`，不跳其它 `-` 开头词：`sh -c -x 'cmd'` 里 shell 把 `-x` **自己**当脚本串（实测执行的是 `-x`），
  跳它会反过来把真实载荷丢掉。
- 跳过之后仍有词就照常展开（`S-10h` 锁住「跳过 `--` 后已注册虚拟屏仍放行」）；
  跳完耗尽则不展开（`trap -p` / `sh -c --` 这类无载荷形态不得误拦）。
- 嵌套形态由既有工作队列逐层展开，**每一层都跳**（`S-10i`）。

## 复验证据

- 跨语言 fixture 63 → **72** 例（`S-10d`..`S-10i` + 3 条 `allow` 对照），权威源
  `plugins/dsh-android-bridge/test/fixtures/screen-scope-cases.json`，壳侧副本由
  `node scripts/gen-screen-scope-fixture.mjs` 机器同步（输出 `WRITE PASSED`）。
- 引擎侧单测 `node --test test/screen-scope.test.mjs`：**47 pass / 0 fail**。
- 壳侧单测 `:app:testDebugUnitTest --tests ShellOpsScreenCommandFixtureTest`：**10 tests / 0 failures**
  （其中 `everyFixtureCaseMatchesTheKotlinVerdict` 逐条比对 72 例）。
- **变异反证（引擎侧）**：把 `firstPayloadWord(payload[1])` 退回 `firstShellWord(payload[1]).word` ⇒
  **5 条红**：`S-10d` / `S-10e` / `S-10f` / `S-10g` / `S-10i` 全部从 `deny-uncertified-target` 变 `allow`；回滚后 47 pass。
- **变异反证（壳侧）**：同一变异打在 `ShellOps.kt` ⇒ `everyFixtureCaseMatchesTheKotlinVerdict` 红，
  报错原文 `命令：trap -- 'screencap -p /sdcard/real.png' EXIT expected:<[deny-uncertified-target]> but was:<[allow]>`。
- **判别力边界（诚实记录）**：`S-10h` 与 3 条 `allow` 对照在变异下**仍为 `allow`**（它们守的是"不得一律拒"，
  不是这条漏洞），所以本轮的判别力全部来自那 5 条 deny 用例。

## 未做设备验证（阻塞原因）

新壳侧代码**没有**装到设备上跑 `scripts/verify-screen-scope-matrix.mjs`，因此缺「装机后三层」里的
CDP / ADB 体验层。具体卡点：

1. 仓库内嵌 `app/src/main/assets/snapshot.tar.xz` 当前是 **x86_64** 快照；目标真机是 **aarch64**。
   `build-apk-dev-fast.mjs` 的 ABI guard 直接拒（原文：`snapshot ABI is x86_64 but the target is aarch64`）。
2. 本机没有任何现成 aarch64 快照（`find` 全盘无候选），重建快照需 8-12 分钟且这台机器只有 10 GB 内存；
   模拟器路线在本机已关闭（AVD boot 中途 OOM）。

替代证据（本 PR 实际提供）：真机 shell 语义实测（证明漏洞真实可执行）+ 两侧 fixture 单测 +
两侧变异反证 + `check-code-map` / `check-kotlin-comments` / `check-op-registry-parity` /
`verify-screen-scope-matrix.test`（14 pass）全绿。

## 已知边界

- 只覆盖 `--` 这一种终结符形态。其它把真实载荷挪位的写法（例如 `trap` 的信号名顺序陷阱）没有系统穷举；
  本轮的做法是"发现一个可执行形态就锁一条 fixture"，不是"证明三类入口的所有形态都安全"。
- `su -c -- '…'` 不执行（真机实测 `--: unknown option`），但它仍会被同一条规则跳过终结符；
  由于后续词会被照常展开判定，方向是 fail-closed，不会因此开洞。
