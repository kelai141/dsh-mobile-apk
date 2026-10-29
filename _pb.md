修 `#683`：安全模式「部分生效」后不可收敛。

## 缺陷

`enter()` 的顺序是「先落 `active=true`，再写三段 patch」（`SafeMode.kt:286-307`），但 `catch` 只回 `ok=false`、**不回滚状态文件**。于是只要 patch 任一段写失败，状态已是 `active=true`；用户再点「安全模式启动」会命中早退（`:232-234`），**返回成功**并重启引擎，而被摘除的第三方插件其实还在。

## 改法（B：两阶段状态机）

| 阶段 | 状态文件 | 含义 |
|---|---|---|
| ① | `active=false, phase=writing` | 备份路径照旧早早记下（中途崩溃 `off` 仍能整份还原），但**不声称已生效** |
| ② | `active=true, phase=active` | ⑤ 三段 patch **全部写成功之后**才抬上来 |

早退判据改为读 `phase`：

```kotlin
if (existing.optBoolean("active", false)) {
  val phase = existing.optString("phase", "")
  if (phase != PHASE_WRITING) { return Result(true, "安全模式已开启；…") }
}
```

### 升级兼容（你特别点出、最容易被漏的那条）

`optString("phase", "")` 的默认值是**空串**，所以「只有 `active:true`、没有 `phase`」的旧状态文件会走 `phase != PHASE_WRITING` 分支 → **视为已完成并早退**。
若默认值写成 `PHASE_WRITING`，所有升级用户第一次点「安全模式启动」都会被判成不收敛 —— 这条有专门用例钉住。

## 验证：4 条用例，真实临时目录（纯 JVM）

`app/src/test/java/com/dsharnessmobile/shell/SafeModePartialPhaseTest.kt`

| 用例 | 钉住的验收点 |
|---|---|
| `旧状态文件没有 phase 时视为已完成并早退` | **③ 升级兼容**：早退成功 + patch 不被改写 + `snapshotId` 保持 `old-id` |
| `phase 为 writing 时不得早退必须重写为 active` | **① 中途失败可识别**：重写后 `phase=active` 且换成新 `snapshotId`，第三方条目被摘除 |
| `全部写成功才置 active` | **② 全成功才 active** |
| `中途失败时状态停在 writing 且下次能收敛` | ①+② 端到端：把 patch 换成目录让 ⑤ 失败 → `phase=writing` 且 `active=false`；修好后再进入 → 收敛到 `active` |

### 执行数以 XML 为准（不看任务结果）

```
TEST-...SafeModePartialPhaseTest.xml
<testsuite tests="4" skipped="0" failures="0" errors="0">
```

### 三条负控（各自红一次，互不覆盖）

```
BASELINE                      -> tests=4 failures=0
M1 早退不认 phase（旧行为）    -> tests=4 failures=1
M2 初始写盘直接 active=true    -> tests=4 failures=1
M3 旧文件不兼容（默认当 writing）-> tests=4 failures=1
RESTORED                      -> tests=4 failures=0
```

三次变异恰好各打红一条用例 —— 说明三条验收点是被**独立**钉住的，不是一条用例兜三件事。

## 档位

L3（壳侧行为）：新增 4 条纯 JVM 单测 + 3 条受控负控。**未做设备验证**（真实安全模式进出需设备上跑一次「进安全模式 → 重启 → 退安全模式」）。