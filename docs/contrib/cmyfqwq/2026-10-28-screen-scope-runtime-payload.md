# 屏幕范围门禁：命令名/载荷来自运行时（`$VAR`、`$(…)`、反引号）时没有 fail-closed

## 现象

屏幕范围 virtual-only 下，下面五种形态都判 `allow`，而真机上**都会真的执行变量/文件里的内容**：

```
sh -c "$CMD"                          # CMD='screencap -p /sdcard/real.png'
sh -c "$(cat /sdcard/x.sh)"           # 脚本内容来自文件
sh -c `cat /sdcard/x.sh`              # 同上，不带双引号
trap "$(cat /sdcard/x.sh)" EXIT
eval "$(cat /sdcard/x.sh)"
```

## 真机实测（小米 14 Pro / 23116PN5BC / SDK 37）

| 在设备上执行 | 观测 |
|---|---|
| `CMD='echo VAR_CMD_RAN'; sh -c "$CMD"` | 打印 `VAR_CMD_RAN` |
| `printf 'echo FROM_FILE_RAN\n' > /data/local/tmp/s.sh; sh -c "$(cat …/s.sh)"` | 打印 `FROM_FILE_RAN` |
| `sh -c "\`cat …/s.sh\`"` | 打印 `FROM_FILE_RAN` |
| `trap "$(cat …/s.sh)" EXIT` | 打印 `FROM_FILE_RAN` |
| `eval "$(cat …/s.sh)"` | 打印 `FROM_FILE_RAN` |

## 真因

`sh -c` / `eval` / `trap` 三个入口的载荷原本被当成「静态文本」处理：把替换里的内容当普通段展开
（`$(cat /sdcard/x.sh)` 展开成段 `cat /sdcard/x.sh`），该段无屏幕命令词 ⇒ 放行。

但语义上，`$(…)` / 变量 / 反引号的**输出**才是脚本内容 ⇒ 与 `sh /x.sh`（脚本文件读不到内容）完全同类，
本来就该 `deny-unparsed`。旧实现只挡了「脚本文件」和「从 stdin 读」（#509），挡不住「脚本从替换来」。

## 修法：两条判据，各自都有独占判别力

1. **段命令名是运行时值**（`$CMD` / `"$(…)"` / 反引号）⇒ `deny-unparsed`。
   `$'…'` / `$"…"` 是 **ANSI-C 引号**（静态字面量），排除（否则 S-7c 会被误拦）。
2. **切段当场按 `PAYLOAD_SLOT_TAIL` 认不带引号的载荷替换**（`` sh -c `cat f` ``）。
   这类替换在顶层切段时就被展开，段里不再留反引号字符，**段级判据看不见它** —— 只能看
   「替换前那段 buf 是否停在载荷位置」（`sh -c ` / `eval ` / `trap ` 之后）。
   `sh -c "a b" $(date)` 这种「载荷已给、替换在下一个参数」的形态不命中（脚本静态可见）。

### 开发中删掉的一条冗余判据

最初还写了第三条：「载荷的**第一个词**是运行时值 ⇒ unparsed」。变异实测它对用例集（先 74 条，rebase 后 83 条）
**零独占判别力**（撤掉后 0 条变红）——`sh -c "$CMD"` 由判据 1 覆盖、`sh -c "$(cat f)"`
由切段期的「命令位置替换」覆盖。按「判据必须自证」的口径**删掉**，不留零判别力的面。

删掉之后的实测：判据 1 的判别力从 1 条变 2 条（`S-12a` / `S-12g`），判据 2 覆盖 `S-12c`。

## 复验证据

- 跨语言 fixture 72 → **83** 例（`S-12a`..`S-12g` + 4 条 `allow` 对照；72 是本分支 rebase 到含 #756 的 main 之后的基线），壳侧副本由
  `node scripts/gen-screen-scope-fixture.mjs` 机器同步（`WRITE PASSED`）
- 引擎侧 `node --test test/screen-scope.test.mjs` → **47 pass / 0 fail**（83 例逐条断言）
- 壳侧 `:app:testDebugUnitTest --tests ShellOpsScreenCommandFixtureTest` → **10 tests / 0 failures**
- **变异反证（引擎侧）**：
  - 撤掉判据 1 ⇒ **2 条红**：`S-12a`（变量作载荷）、`S-12g`（顶层命令名是替换）→ `allow`
  - 撤掉判据 2 ⇒ **1 条红**：`S-12c`（无反引号的反引号载荷）→ `allow`
  - 回滚后 83 例全绿
- 误拦方向的四条对照（修复后仍 `allow`）：`echo "$(date)"`、`sh -c 'echo $(date)'`、
  `x=$(cat /tmp/f); echo $x`、`sh -c "a b" $(date)`
- `check-kotlin-comments` / `check-op-registry-parity` / `check-code-map` rc=0

## 已知边界

1. **参数位置的替换不拦**：`echo "$(date)"` 之类的替换只产出参数值，命令身份仍是 `echo`。这是有意为之
   —— 把「段里出现 `$(`」写宽会把大量正常命令一起拒掉。
2. **任意语言执行器不在本门禁职责内**：`awk 'BEGIN{system(…)}'`、`perl -e 'system(…)'`、
   `python3 -c 'os.system(…)'` 仍然 `allow`。屏幕范围门禁是判据层而不是沙箱层（同 #509 记录的固有边界），
   要封这类形态是另一个量级的设计（白名单命令集 / seccomp），不在本轮。
3. 运行时值的**来源**不可判：`sh -c "$(getprop ro.x)"` 这类合法用法也会被判拒（fail-closed 的代价）。

## 未做设备验证（阻塞原因）

与同批两条一致：新壳侧代码没装到设备上跑 `scripts/verify-screen-scope-matrix.mjs`。

1. 仓库内嵌 `app/src/main/assets/snapshot.tar.xz` 是 **x86_64**，目标真机是 **aarch64**，
   `build-apk-dev-fast.mjs` 的 ABI guard 直接拒。
2. 本机没有任何现成 aarch64 快照；重建需 8-12 分钟且本机只有 10 GB 内存；模拟器路线已关闭（AVD boot OOM）。

替代证据：真机 shell 语义实测（证明五种形态真实可执行）+ 两侧 fixture 单测 + 两侧变异反证。
