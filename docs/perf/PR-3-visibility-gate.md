# PR — 三处常驻轮询加页面可见性门（性能审计 #4）

## 改了什么

三处 `setInterval` 改成「自续 `setTimeout` + `document.hidden` 不排下一拍」：

| # | 位置 | 周期 | 每拍的动作 |
|---|---|---:|---|
| 1 | `plugins/dsh-android-vdisplay/src/client/index.ts` `pull` | 1000 ms | `pullPanelState()` + `publishBounds()`（两次跨原生桥） |
| 2 | `plugins/dsh-android-vdisplay/src/client/index.ts` `reveal` | 800 ms | `collapsedNow()` + 可能 `sidebar.openTab()` |
| 3 | `vendor/dsh-undo-savepoint/lib/client.js` `refreshStat` | 30000 ms | 跨桥取一次撤销统计 |

周期语义**完全不变**；变的只是「页面不可见时不再排下一拍」。回前台由 `visibilitychange` 立刻补一拍并恢复自续。

## 为什么这么改是安全的

三处都**不是**即时性的唯一来源：
- vdisplay 两处的即时性由既有事件通道 `watchStageVisibility` 负责，1s/800ms 轮询本注释里就写着是「**兜底对齐**（原生层重建、事件通道漏网时用）」；
- undo-savepoint 的徽标只在用户看得见时才有观察者。

页面隐藏时这些动作没有任何可观测效果，却仍然每拍跨一次原生桥。

## 参照实现

仓库里已有同口径的正确实现，本次照抄其形状：
`dsh-client-ui-responsive/src/client/mobile/native-browser-auto-place.ts:87-101`（自续 `setTimeout` + `visibilitychange` 补拍）。

## 前后数值（静态上界）

| 指标 | 改动前 | 改动后 |
|---|---:|---:|
| 后台（页面隐藏）每分钟唤醒 | **135 次**（60 + 75） | **0 次**（只剩挂载时那一拍） |
| 其中 vdisplay `pull` | 60 /min | 0 |
| 其中 vdisplay `reveal` | 75 /min | 0 |
| undo-savepoint 后台 | 2 /min | 0 |
| 前台周期 | 不变 | 不变 |

后台每分钟 135 次跨原生桥调用降为 0。这是**静态上界**（按周期算），不是设备实测。

## 负控

`node scripts/perf-audit-lead/nc-visibility-gate.mjs`：

```
shape=gated  hidden=true  ticks = 1  (期望 =1：只有首拍，之后不排)
shape=gated  hidden=false ticks = 5  (期望 >1：前台持续自续)
shape=legacy hidden=true  ticks = 4  (改动前裸 setInterval，期望 >>1)
后台拍数降幅: 4 -> 1  (约 -75%)
NEGATIVE-CONTROL PASSED：门生效且前后可分辨
```

**判据口径说明**：后台期望是**恰好 1 拍**而不是 0——挂载时无条件排一拍是期望行为（与参照实现一致，`this.schedule()` 首次调用不做 hidden 检查），之后每一拍结束时才由 `document.hidden` 决定排不排下一拍。

## 测试

| 项 | 结果 |
|---|---|
| `plugins/dsh-android-vdisplay` 构建 | PASS（`tsc` + client bundle） |
| `plugins/dsh-android-vdisplay` 单测 | **126 例：90 pass / 36 skip / 0 fail** |
| `vendor/dsh-undo-savepoint` 单测 | 11 例：9 pass / **2 fail** |

**关于那 2 个失败**：`2026-09-19 04:00:38` vs `2026-09-19 12:00:38`，是**时区相关**的既有失败。
已用 stash 隔离验证：**改动前 9 pass / 2 fail，改动后 9 pass / 2 fail，逐项相同**，与本次改动无关。

## 构建产物说明

`plugins/*/lib/` 被 `.gitignore` 忽略（构建产物不入库），因此本 PR 只提交 `src/`；
`vendor/dsh-undo-savepoint/lib/client.js` 是**已入库的分发产物**，必须直接改，故一并提交。

## 风险与验证档位（**未做设备验证**）

- 风险：**低**。周期不变、前台行为不变；后台不做无意义工作。
- 档位：L3（壳侧/页面行为改动）⇒ 按铁律 2 需即时三层验收。
- **本轮设备全部关闭，未执行设备验证。** 进入发版候选前必须补：
  - CDP 层：切后台后 `window.setInterval` 计数归零、回前台补拍；
  - ADB 用户层：虚拟屏面板切后台再回前台，状态仍能刷新（兜底轮询恢复）。
