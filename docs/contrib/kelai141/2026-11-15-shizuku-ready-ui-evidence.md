# 2026-11-15：Shizuku「就绪」的 UI 侧判据（issue #1476 残留）

## 现象

设置页「手机权限」显示「Shizuku 可用 / 已就绪」，诊断也写 `Shizuku is ready; next: nothing to do`，
而所有依赖 shell 身份（uid 2000）的功能一致失败：
`IllegalStateException: the Shizuku shell service did not start within 30 s`。

## 真因（两层，壳侧已修一半）

壳侧 #1501 / #1537 已经改成「binder 活 + 已授权 + 已绑定 + **功能探测成功**」才算就绪，
结论落在 `status().readyState`（`ready` / `not-ready` / `unknown`）。

但 **UI 侧仍在看 `bound`**：`shizukuStateLabel()` 只要 `bound === true` 就返回「通道就绪」。
而 `bound` 的来源是 `service?.asBinder()?.pingBinder()` —— **binder 代理活着，不代表 UserService 能应答**。
功能探测（`protocolVersion()` 真过 binder）才是「能应答」的证据。

于是壳侧已经把真话算出来了，UI 照旧复述那个错的结论。这是「判据在前面生成、在后面被丢」的形态，
与 #1529 修的「verdict 被丢弃」同族。

## 修法

1. `ShizukuStatus` 增 `readyState` / `probeError`；`readShizuku()` 从桥面解析（`readyState` 取自
   `status().readyState`，`probeError` 取自 `functionalProbe.error`）。
2. `shizukuStateLabel()` 在 `bound` 之后再看 `readyState`：`not-ready` → 「已授权，用户服务不可用」，
   `unknown` → 「已授权，正在验证通道」，只有 `ready` 才说「通道就绪」。
3. `shizukuStepHint()` 给这两态各自的可执行下一步（探测失败 → 重置链接 + 带原因；探测中 → 现在就可用）。

## 关键设计点：缺席 ≠ unknown

`parseShizukuReadyState()` 对**缺席**返回 `undefined`，对 `'unknown'` 返回 `'unknown'`，两者语义不同：

- `undefined` = 这个壳没有这条判据 → UI 必须退回旧的 `bound` 口径。
- `'unknown'` = 壳有判据但探测没跑完 → 如实说「正在验证」。

把缺席当 unknown 会让**所有老壳设备**升级 UI 后永久显示「正在验证通道」——换进来一个新缺陷。
这条在判据里单独钉了一条用例（`旧壳没有 readyState 时必须退回旧的 bound 口径`）。

## 判据

`dsh-client-ui-responsive/tests/phone-control-shizuku-readiness.spec.tsx`，9 例，全部**行为断言**。

负控实测（把 `phone-control.tsx` 的改动回退后）：

```
Tests  6 failed | 3 passed (9)
→ expected '通道就绪' to be '已授权，用户服务不可用'
→ expected '通道就绪' to be '已授权，正在验证通道'
→ expected '特权通道已就绪…' to contain '不应答'
→ expected '特权通道已就绪…' to contain '功能探测'
→ expected undefined to be 'not-ready'
```

恢复后 9/9 绿。

## 边界

- 未做设备验证（本环境无 Android 16 真机，且该缺陷需要 HyperOS 3.0 上 bindUserService 无回调的现场）。
  代码层判据完整；设备层补验点：真机上把 `functionalProbe` 打成失败态，确认面板不再说「通道就绪」。
- 未在本 PR 处理「权限页加重试入口」那半（issue 修复建议第 2 条）：页面**已有**「重置链接」按钮
  （`resetShizuku`，走 `resetShizukuConnection` → `Shizuku.unbindUserService(remove=true)`），
  本次把它的**可见性**补齐了（探测失败态的引导文案直接点名它），不新增第二个语义重叠的按钮。

## 顺带记一条协作坑

**`git stash` 是整仓共享的，不是 per-worktree。** 本仓常年挂着十几个 worktree 并行干活，
在一个 worktree 里 `git stash push` 再做负控、然后 `git stash pop`，很可能 pop 出**别人**的改动。
本轮的负控改用 `Copy-Item` 到 `$env:TEMP` 备份 + 覆盖还原，不再用 stash。
