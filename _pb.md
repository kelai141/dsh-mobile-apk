修 `#871`：内置控制台首屏出现**两行提示符**。

## 真因

时序问题：

1. `onStart` → `session.start()` → PTY 按 `ConsolePty.DEFAULT_COLS/ROWS`（**80×24**）建立 → shell 在这个宽度画一次提示符；
2. 页面随后执行 `setTimeout(pushSize, 0)` → `consoleBridge.resize(cols, rows)` → `session.resize()` → PTY 收到新尺寸 → **SIGWINCH** → zle 重绘 ⇒ 首屏出现第二行提示符。

`ConsolePty.kt:26` 的注释本身就写着「80x24 是终端事实标准，任何 TUI 都按它兜底排版」，但**兜底值不该被真的用上**。

## 改法

把会话启动**延后到页面首次下发真实尺寸之后**：

- `onStart` 不再直接起线程，改为 `startPending = true` + `handler.postDelayed(pendingStartRunnable, START_DEFER_MS)`；
- `ConsoleActivity.resize(cols, rows)`（`@JavascriptInterface`）里：先 `session.resize(cols, rows)` 把尺寸**落进会话**（PTY 未建时只写字段），再 `if (startPending) startSessionNow()`；
- `startSessionNow()` 抽成类级私有方法，内部去重（`sessionStarted`/`sessionStarting` 双闸）并移除兜底回调。

**兜底**：`START_DEFER_MS = 600ms`。页面异常（从不调 `resize`）时照常启动，控制台不会卡死 —— 这是必须有的，否则新判据本身就成一个新故障。

## 为什么这样能消掉第二行

PTY 建立时用的是**页面的真实尺寸**，shell 首次绘制即已正确；后续 `resize` 因 `ConsoleSession.resize` 的 `if (c == this.cols && r == this.rows) return` 提前返回 ⇒ **不发 resize 帧** ⇒ 无 SIGWINCH ⇒ 无重绘。

## 验证

```
:app:compileDebugKotlin -> BUILD SUCCESSFUL
```

## 档位

L3 壳侧行为（控制台启动时序）：**只做了编译验证，未做设备验证**。第二行提示符是**目视现象**，必须在模拟器上看首屏才能确认消失；当前无发布链包（debug 包过不了 Hard 清单指纹校验，详见 #891/#908）。

进发版候选前**必须**补：冷启动进控制台 → 看首屏是否只有一行提示符；旋转屏幕 → 确认 resize 仍生效（vim/top 不花屏）。