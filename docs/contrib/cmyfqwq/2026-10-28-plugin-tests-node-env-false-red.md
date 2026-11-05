# check-plugin-tests：调用者的 NODE_ENV 会把子仓测试判成假红（2026-10-28）

## 现象

在带着 `NODE_ENV=production` 的 shell 里跑 `node scripts/check-plugin-tests.mjs`：

```
FAIL  dsh-client-ui-responsive 的子仓测试未通过（npm test）
Error: act(...) is not supported in production builds of React.
 Test Files  16 failed | 49 passed (65)
      Tests  239 failed | 668 passed (907)
CHECK-PLUGIN-TESTS FAILED（1 个单测单元有问题；已跑 10 个；SKIP=0）
```

同一份代码、同一台机器，只把该变量改成 `test` 或 `development`：

```
 Test Files  65 passed (65)
      Tests  939 passed (939)
```

即 **239 例"失败"完全是假的**，代码一行没坏。

## 真因

门禁的五个子进程入口（`runCommand` 4 处 + 1 处裸 `spawnSync`）**没有显式给子进程设 `NODE_ENV`**，
于是子进程直接继承调用者的值。而 `NODE_ENV=production` 会让 vitest 把 `react` 解析成 production 构建，
该构建里 `act(...)` 是禁用桩，直接抛 `act(...) is not supported in production builds of React` ——
所有挂载类用例当场失败。

为什么这是**门禁缺陷**而不是"用户跑错了"：门禁的全部价值是给出**与调用环境无关**的判定。
`check-plugin-tests` 却把结论取决于"谁在什么 shell 里跑的"，于是本地复现不出 CI 的结果，
排查者会去查代码（这次实测花了一轮去确认 esbuild 权限、jsdom 版本，真因却在环境变量）。

同族先例就在同一个文件里：`stripAnsi` 的注释记着「vitest 输出的颜色转义让裸文本匹配永远不中 ⇒ 假红」。
**两者都是"环境差异导致假红"**，只是这次差异来自变量而不是转义序列。

## 修法

1. **钉在唯一入口**：`runCommand` 里统一把环境合并成「`process.env` 展开 + 调用点的额外变量 + 强制
   `NODE_ENV=test`」。强制项放最后，所以调用点显式传的 `NODE_ENV` **覆盖不掉**它——
   "某处忘了设"在结构上不可能发生，而不是靠每个调用点自觉。
2. **合并必须基于 `process.env` 展开**：只写 `{...extra}` 会吞掉 `PATH`，后果比假红更糟——
   子进程根本起不来，门禁会看到「起不来」而不是「测试失败」，容易误判成环境缺依赖。
3. **加 `--self-test`**：门禁自身判据按 AGENTS.md §4.3 属 L1，需要自检 + 一条受控负控。
   自检**不跑插件测试**（那会把自检变成分钟级），只问子进程「你看到的 `NODE_ENV` 是什么」，
   覆盖三类调用形态：显式指定 production、只传一个无关变量、完全不传。

## 复验证据

- `--self-test`（普通环境）⇒ 3/3 PASS。
- `--self-test`（父进程 `NODE_ENV=production`）⇒ 3/3 PASS（证明钉子有效，不是碰巧）。
- 变异反证：把 `testEnv` 里的 `NODE_ENV: TEST_NODE_ENV` 删掉 ⇒ 自检 3/3 判红
  （三条都看到 `"production"`）；还原后 3/3 绿。
- 受控负控（修前/修后同一命令）：
  `NODE_ENV=production node scripts/check-plugin-tests.mjs`
  修前 **FAILED**（`dsh-client-ui-responsive` 239 例假红），修后 **PASSED**（10 个单测单元 / SKIP=0）。
- 环境侧顺带确认的两件事（与本 PR 无关，别再误判成本次原因）：本机 `dsh-client-ui-responsive` 的
  `node_modules/@esbuild/linux-x64/bin/esbuild` 缺执行位（EACCES）需要 `chmod 755`；该目录是本地私装，
  不在版本控制里。

## 没做/边界

- 只钉 `NODE_ENV`。`CI`、`TZ`、`LANG` 这类同样可能影响行为的变量没有一并固定——它们目前没有观测到
  造成假红，过度固定会让门禁与开发环境脱节；真出现同类症状时按同一入口追加。
- 未做设备验证：改动是门禁脚本（L1），按 §4.2 不强制打包后三层。
