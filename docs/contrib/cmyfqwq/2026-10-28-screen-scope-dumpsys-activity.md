# `dumpsys activity top` 能读真实屏的完整 View Hierarchy，却放行

## 现象

`dumpsys` 家族只覆盖 `window|display|input`：

```
screenCommandVerdict("dumpsys activity top")        -> allow
screenCommandVerdict("dumpsys activity activities") -> allow
```

## 真机实测（小米 14 Pro / SDK 37，2026-10-28）

```
dumpsys activity top | grep -c 'View Hierarchy'   -> 1
dumpsys activity top | grep -A6 'View Hierarchy'
    View Hierarchy:
      com.android.internal.policy.DecorView{f42dcb1 … 0,0-1440,3200 aid=1073741824}[MainActivity] …
        android.widget.LinearLayout{bb40a08 … 0,0-1440,3200}
          android.view.ViewStub{… #1020207 android:id/action_mode_bar_stub}
          android.widget.FrameLayout{7cd03c6 … #1020002 android:id/content}
            android.webkit.WebView{a163c2 … 0,0-1440,3200 #1 aid=1073741825}
```

以及逐控件的几何行：

```
android.widget.TextView{89c304c V.ED..... ........ 42,0-699,103}
android.widget.TextView{9119daa V.ED..... ......ID 881,48-1272,134}
```

这就是 `uiautomator dump` 同级的「读真实屏 UI 结构 + 每个控件的 bounds」——只不过拼写不同。
门禁的 `dumpsys` 家族只列了 `window|display|input`，`activity` 不在其中 ⇒ 整条放行。

## 修法

`dumpsys` 家族的子命令表补 `activity`，仍 `targetFlags: []`（无目标屏参数 ⇒ 恒拒），与
`window|display|input` 同档。壳侧同批补面向用户的家族清单文案。

没有把整个 `dumpsys` 一拒了之，是因为 `battery` / `meminfo` 这类 dump 与屏无关，一拒就是新的误伤面。

## fixture 82 → 85

| 用例 | 命令 | 期望 |
|---|---|---|
| S-17a | `dumpsys activity top` | `deny-uncertified-target` |
| S-17b | `dumpsys activity activities` | `deny-uncertified-target` |
| 对照 | `dumpsys battery` | `allow` |

## 复验证据

- 引擎：`node --test plugins/dsh-android-bridge/test/screen-scope.test.mjs` → **47 pass / 0 fail**
- 壳侧：`:app:testDebugUnitTest --tests '*ShellOpsScreenCommandFixtureTest*' --rerun-tasks`
  → XML 报告 **tests 10 / failures 0**（85 条 fixture 逐条比对）
- **变异反证（引擎）**：子命令表去掉 `activity` ⇒ **46 pass / 1 fail**；回滚 47/0
- **变异反证（壳侧）**：同上 ⇒ `everyFixtureCaseMatchesTheKotlinVerdict` **FAILED**，报错原文
  `命令：dumpsys activity top expected:<deny-uncertified-target> but was:<allow>`
- 门禁：`gen-screen-scope-fixture` 一致、`check-kotlin-comments` / `check-code-map` PASSED

## 已知边界

1. **没有穷举 `dumpsys` 的其它子命令**。本轮只补了有实锤（View Hierarchy）的 `activity`。
   `dumpsys gfxinfo`（帧统计）与 `dumpsys SurfaceFlinger --list`（图层名）实测仍 `allow` —— 前者不含
   控件文本、后者只有图层名，泄漏面比 `View Hierarchy` 弱，暂未纳入；`dumpsys` 家族本质是「读系统
   服务 dump」，任何子命令都可能带屏信息，逐条核验的成本高于收益。
2. 同一轮探到但**判定不是缺陷**的：`sh -c '. /sdcard/payload.sh'`、`sh -c 'source …'`、
   `sh -c 'exec …'`、`sh -c 'command screencap …'` —— 全部已被 `deny-unparsed` /
   `deny-uncertified-target` 拦住（探针实测）。
3. `wm scaling off`、`am instrument` 实测仍 `allow`。`wm scaling` 属 `wm` 家族的另一个子命令（与
   #767 的 `user-rotation` 同族），`am instrument` 需要测试包才可用（本机无路径），都未纳入。
