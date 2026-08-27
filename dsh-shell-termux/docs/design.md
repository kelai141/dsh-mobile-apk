# dsh-shell-termux：Termux 原生 Shell 适配层设计

> 版本 v1.0 ｜ 2026-08-13 ｜ 触发：M0 验证盲区 + 沙箱 fail-closed 实证

---

## 0. 为什么必须原生适配（实证）

| 事实 | 来源 |
|---|---|
| web profile 的 `ctx.shell` 由 **bash-sandbox** 提供（`base/cordis.patch.yml`：`- id: bash-sandbox`，安卓上启用） | 源码实读 |
| sandbox 的 `PLATFORM_CHAINS = { linux: [bwrap, landlock], darwin: [seatbelt], win32: [windows-acl] }`——**无 android** | dsh-sandbox-local 源码 |
| "A platform with no chain fails closed at `confine()`" | 同上 |
| **结论：安卓上 bash 工具实际执行会被沙箱拒绝**（M0 只验证了服务启动，未验证工具执行） | 推理 |

即：**"碰巧能启动" ≠ "工具可用"**。Termux 的 bash 存在，但执行链（sandbox 包装）在安卓是死的——必须有一个原生 shell 适配层。

---

## 1. 设计原则

1. **复用 seam，不发明新机制**：还是 `ctx.shell`（单 provider 服务）+ `ctx.subprocess` + `ctx.jobs` + `ctx.terminals`，只是提供一个**安卓原生实现**；
2. **显式声明沙箱语义**：不做假沙箱——保护边界 = **Android SELinux + Termux app 域**（u0_aXXX），由 `sandbox-policy`（审批流）补策略决策；
3. **探测优先**：bash 缺失/版本不符 → 友好错误 + 修复提示（`pkg install bash`），绝不静默降级；
4. **与桌面行为对齐**：超时、输出上限、spill、进程组 SIGTERM→SIGKILL、后台任务、PTY——全部复用既有语义，只替换"执行环境"。

---

## 2. 组件：`dsh-shell-termux`（ctx.shell 的安卓 Provider）

### 2.1 挂载方式（patch 层，纯声明）

```yaml
# dsh-android bundle 的 cordis.patch.yml
- id: bash-sandbox
  disabled: !!js process.platform === 'win32' || process.platform === 'android'   # 安卓禁用桌面沙箱 executor
- insert:
    - id: shell-termux
      name: '@dsh-android/dsh-shell-termux'
      disabled: !!js process.platform !== 'android'
      config:
        bashPath: /data/data/com.termux/files/usr/bin/bash   # 探测默认值
        timeoutMs: 120000
        maxTimeoutMs: 600000
        maxOutputBytes: 65536
        maxSpillBytes: 1048576
```

（`ctx.shell` 单 provider：bash-sandbox 在安卓 disabled + termux 行 insert，两者不冲突）

### 2.2 职责清单（原生适配点）

| 职责 | 实现 |
|---|---|
| **Termux 环境探测** | `probe()`：bash 存在性 + 可执行 + 版本（≥4）；失败返回结构化错误（`bash-not-installed` / `termux-not-found`），UI 可展示修复引导 |
| **受控环境构造** | 每次 spawn 显式注入：`PATH=$PREFIX/bin`、`LD_LIBRARY_PATH=$PREFIX/lib`、`HOME=$HOME`、`PREFIX`、`TERMUX_VERSION`、`SHELL`——**不依赖外部环境碰巧正确**（M0 教训：PATH 被 PowerShell 展开就崩） |
| **spawn 生命周期** | 复用 `ctx.subprocess`（进程组 SIGTERM→SIGKILL、输出上限+spill、graceMs）——与 bash-local 同预算语义，继承测试 |
| **沙箱语义声明** | `sandboxPolicy` 处理：安卓上映射为"app-domain"——文件效应受 Android SELinux 约束（Termux 域只能读写自身目录 + 已授权共享存储），策略决策走 `sandbox-policy` + `tools/pre-execute` 审批（`ask`）；拒绝语义与桌面一致（deny/ask），只是执行边界不同 |
| **PTY/持久终端** | 可选子插件 `dsh-terminal-termux`：node-pty 已编译（M0 实证），验证 `openpty` + `/dev/ptmx`；实现 `ctx.terminals` 的安卓 provider |
| **后台任务** | `run_in_background` → `ctx.jobs`：进程句柄生命周期 = subprocess 生命周期（与桌面一致） |
| **shell-env** | 消费 host `ctx.shellEnv`（DSH_WEB_URL/DSH_WEB_MODE 注入），与桌面同 |
| **命令工具链** | 探测并提示 `pkg install bash coreutils findutils grep`（dsh 工具面依赖的常见命令）；缺失时工具返回可操作错误 |

### 2.3 配置与诊断面

- `Config`：bashPath（探测默认）/ timeoutMs / maxTimeoutMs / maxOutputBytes / maxSpillBytes（与 bash-local 对齐）；
- 服务方法：`probe()` → `{ status: 'full' | 'partial' | 'unusable', bash: string, version?: string, missing: string[] }`；
- `ctx.androidLifecycle.watchdogStatus()` 可合入 shell 探测状态（UI 一个面板看全）。

---

## 3. 与既有组件的关系

| 组件 | 关系 |
|---|---|
| bash-local | 桌面（非安卓）继续用；termux 是并列实现，同 `ctx.shell` 契约 |
| bash-sandbox | 安卓 disabled；桌面不变（条件式 patch，一包跨平台） |
| sandbox-local | 保持装载（boot 不失败）；仅 `confine()` 显式调用才 fail-closed——termux executor 不调用它 |
| sandbox-policy / approval | **策略面不变**：mode/workspaceRoot/ask 语义照旧，权限决策仍然有效 |
| tool-bash / tool-jobs / tool-terminal | 消费方零改动（seam 哲学） |
| subprocess-local | 复用（node-pty 编译版仅 terminal 用） |

---

## 4. 验证计划（M0.5 实弹）

| # | 步骤 | 预期 |
|---|---|---|
| 1 | 现状复现：给 MuMu 上 dsh 发消息 `跑一下 ls` | **预期被沙箱拒绝**（fail-closed 实证） |
| 2 | 挂 dsh-shell-termux 最小版（patch + 环境注入 + 无沙箱包装） | bash 工具执行成功 |
| 3 | `run_in_background: true` 长任务 | 后台任务 + jobs 收集正常 |
| 4 | PTY 终端（node-pty openpty） | persistent terminal 可用 |
| 5 | 取消/超时：killpg 语义 | 与桌面一致（SIGTERM→SIGKILL） |
| 6 | 共享存储工作区：`cd /storage/emulated/0/DeepSeekHarness/workspace && touch x` | 写用户可见工作区成功（权限已实测） |
| 7 | bash 缺失场景：模拟卸载 bash | 工具返回结构化错误 + 修复提示 |

---

## 5. 里程碑映射

- M0.5（当前）：验证计划 #1（现状实证）→ #2（最小版跑通 bash）——**这是 agent 在安卓可用的分水岭**；
- M1：并入 dsh-android bundle + 壳 APK 引导（`pkg install -y bash coreutils findutils`）；
- M2：PTY 终端 + 后台任务 + 探测面板 + Shizuku 保活衔接。

------

## 附录：通知桥事件清单（dsh-host-android-lifecycle 输入，子代理源码实证）

| 事件 | 载荷要点 | 通知用途 |
|---|---|---|
| `agent/status` | agent 状态 | 会话活跃/空闲提示 |
| `agent/turn-stopping`（serial，勿阻塞） | — | "agent 完成回合"提示 |
| `agent/error` | 错误 | 失败通知 |
| `session/event` 的 `turn/start{turn}` / `turn/end{turn,reason}` | turn 号与结束原因 | 回合进度 |
| `ctx.jobs.onJobDone(snapshot{id,kind,label,status,detail,...})` | 后台任务快照 | 后台任务完成通知 |
| `ctx.jobs.onJobsChanged(owner)` | owner | 任务列表变化 |
| `approval/asked{id,toolName,callId?,reason?}` / `approval/decided{id,outcome}`（勿消费 approval/request waterfall） | 审批请求/结果 | **审批通知（移动端核心）** |
| `agent/inbox/inserted/claimed` | 消息入队/领取 | 新消息到达 |

注意：`ask_user_question` 无 host 专用事件（仅 tools/pre-execute 观察或 client 侧 question/requested 帧）——通知桥需在 client 侧或经 approvals 通道覆盖。

