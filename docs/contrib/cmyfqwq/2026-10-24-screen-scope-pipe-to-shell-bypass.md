# 屏幕范围门禁：管道喂裸 shell 的切段盲区（#509 / PR #525）

## 现象

屏幕范围为 virtual-only 时，特权 shell 通道的执行点判定（`ShellOps.decideScreenCommand`）对以下形态放行，模型仍可读真实屏：

```
echo 'screencap -d 0' | sh        # 变体：| bash、| /system/bin/sh、| xargs sh、| toybox sh、| busybox sh
```

real-only 侧同漏：载荷不可见时连「目标是不是物理屏 0」都不可证明。

## 真因

是**切段器与引号抹除两个既有机制的组合盲区**，不是单个正则写错：

1. `splitCommandSegments` 按 `|` 切段后，喂入段 `echo 'screencap -d 0'` 的命令词在**引号内**——`stripQuotedText` 把引号段整体抹成空白（这是它防「引号内文本冒充命令词」的正确行为），连带 `-d 0` 目标屏凭据也被抹掉；
2. 接收段归一化后是裸 `sh`——无命令词、无目标屏参数，不进任何屏幕命令族；
3. 两段各自合法 ⇒ 整条 ALLOW。执行时 `shExec` 本身就是 `sh -c`，sh 从 stdin 读到命令照跑。

引擎侧 `screen-scope.ts` 判据同构（跨语言 fixture 锁死），两侧同漏。fixture 29 例里没有管道形态，所以等价门禁全绿——**用例集没覆盖的形态上，「等价」不等于「正确」**。

## 修法

切段后、逐段判定之前，检查归一化后**整段就是裸 shell 解释器**（允许多层路径前缀 `/system/bin/sh` 与 `xargs`/`busybox`/`toybox` 包装链），命中即 `DENY_UNPARSED`（fail-closed）。不误伤的依据：合法执行本来就整条传 `shExec`；载荷可见的嵌套 `sh -c '…'` 段含 `-c` 不匹配裸段正则，仍走 SHELL_C_PAYLOAD 展开队列正常判定。

## 复验证据

- JVM 红绿对：`ShellOpsScreenCommandFixtureTest.pipingIntoABareShellInterpreterIsRejectedBecauseItsPayloadIsInvisible`（6 条管道形态 DENY + 3 条可见载荷合法嵌套 ALLOW 对照）；撤掉判据必红
- 开发中两次正则返工的教训（都先写测试暴露）：`busybox`/`toybox` 包装形态漏过（SHELL_C_PAYLOAD 里有它们、裸段正则初版没有）；`/system/bin/sh` 多层路径漏过（`[^\s/]*` 只匹配一层前缀）

## 已知边界（合并决策应知情）

- `echo '…' > /x.sh; sh /x.sh` 落盘再执行仍放行——脚本**文件内容**对静态判定器不可见，属纵深防御固有边界；本修法消掉的是零成本单行管道形态，抬高蓄意绕过成本而不是封死
- 两侧口径暂向收紧方向漂移（Kotlin 收紧、引擎侧未动，fixture 无冲突不判红）；协调仓 fixture 权威源补管道用例后引擎侧应同批收紧，漂移归零
