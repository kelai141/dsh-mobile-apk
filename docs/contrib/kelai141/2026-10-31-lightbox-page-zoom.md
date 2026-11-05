# 图片预览「放大图片会放大整个屏幕」——页面级缩放从来没人关过

日期：2026-10-31　设备：MuMu `127.0.0.1:16544`（PJJ110，Android 15，900x1600 @320dpi → 450x800 CSS px，dpr 2，WebView 110.0.5481.154）

## 现象

用户反馈（原文）：「放大图片会放大整个屏幕」。点开对话里的图片进入大图预览后做放大手势，
**顶栏、对话正文、输入区跟着一起变大**，而不只是图片变大；关掉预览后整屏仍停在放大态。

## 真因

不是某个容器被 `transform: scale()`，也不是 `<html>` 被写了 zoom——是 **Chromium 的页面级缩放
（视觉视口缩放）**。在真实 lightbox 上做双指捏合，实测：

| 量 | 捏合前 | 捏合后 |
|---|---|---|
| `visualViewport.scale` | 1 | **5** |
| `visualViewport.width` | 450 | **90** |
| `<html>` zoom / transform | 2 / none | 2 / none |
| `<body>` zoom / transform | 1 / none | 1 / none |
| lightbox `img` rect | 40,276.7,370x246.7 | **完全不变** |
| `_stage_`（浮层容器）rect | 0,0,450x800 | **完全不变** |
| 顶栏 `header` rect | 0,0,450x40 | **完全不变** |

只有视觉视口变了，布局视口和每个元素的 rect 都没动——所以它是「整屏被放大」，而不是某个元素被缩放。

两个必须记住的排除项：

1. **`<html>` 上读到的 `zoom: 2` 是假象**。CSSOM 里匹配规则为空、内联样式为空，且插入 100px 探测元素实测
   仍是 100px、`documentElement.getBoundingClientRect()` 宽度等于布局视口——无几何缩放。数值恰好等于
   `devicePixelRatio`（2）。**判据要取几何（rect），不要取 computed 字符串**，否则会把 dpr 当成缺陷。
2. **上游 lightbox 没有任何手势代码**（`ui-primitives/ImageLightbox`：backdrop > mask + img + 关闭键，
   只有 `max-width/max-height/object-fit`）。所以用户「放大图片」这个动作，能生效的只有浏览器自己的页面缩放。

那么是谁打开了页面缩放？两个来源，缺一不可：

1. **壳侧从来没人关过**：全仓 grep `setSupportZoom` / `builtInZoomControls` 零命中（只有隔离浏览器的
   `useWideViewPort` 与 `user-scalable=no` 注入）。`setSupportZoom` 的平台默认是 **true**。
2. **页面自己明确放行**：`mobile-form.css.ts` 的 `[data-dsh-frame], [data-dsh-frame] * { touch-action: pan-y pinch-zoom }`
   —— `pinch-zoom` 这个关键字本身就是「允许浏览器捏合缩放整页」的授权。

关键实测（这决定了修在哪一层）：**只加壳侧三行 `setSupportZoom(false)` / `builtInZoomControls = false` /
`displayZoomControls = false` 并不能关掉页面捏合**。同一份 APK（dex 里已确认存在这三个调用）在关闭 lightbox
的普通对话页上捏合，`visualViewport.scale` 仍然 1 → 5。真正起作用的是 `touch-action`：给
`<html>` 临时加 `touch-action: none` 后同一手势 scale 恒为 1，撤掉立刻回到 5。

顺带纠正一个直觉：这条与 lightbox 无关。关掉预览、在普通对话页做同一手势，`scale` 同样 1 → 5；
用户只是**在放大图片时**才会去做这个手势，于是把它记成了图片的功能。

## 修法

三步，缺一不可（闸门在第 2 步，不是第 1 步）：

1. **壳侧**（`WebViewShim.applyBaseline`）：`setSupportZoom(false)` + `builtInZoomControls = false` +
   `displayZoomControls = false`。三行成组，保留为纵深防御（换 WebView provider / 厂商 ROM 时仍是正确
   姿态），但**已知在这一版 WebView 上不足以关掉页面捏合**，不能当成唯一判据。
2. **页面侧闸门**（`mobile-form.css.ts`）：去掉 `pinch-zoom` 授权，并在**根上**关掉捏合：

   ```css
   html[data-dsh-mobile-form] { touch-action: pan-x pan-y; }   /* 允许两向平移，禁止捏合缩放 */
   [data-dsh-frame], [data-dsh-frame] * { touch-action: pan-y; }
   ```

   闸门必须在 `<html>` 而不是 `[data-dsh-frame]`：body 层 portal（预览版说明、各类 aria-modal 浮层、
   大图预览本身）都不在 frame 子树里，只关 frame 拦不住从浮层上开始的手势——实测只改 frame 时
   scale 仍 1 → 5。用 `pan-x pan-y` 而不是 `none`/`pan-y`：两个方向平移都要留给纵向/横向滚动与抽屉手势，
   `pan-x pan-y` 恰好只禁掉捏合。
3. **页面侧功能**（`LightboxZoom`）：`pointer` 事件按 `pointerId` 跟踪两指，只给 lightbox 的 `<img>`
   写 `transform: scale()`，双击在 1x / 2.5x 之间切换；`touch-action: none` 挂在图片与预览浮层上
   （遮罩仍是既有关闭路径）。每条关闭路径（关闭键 / Escape / 换一张图）都复位，缩放不带到下一条消息。
   两种上游形态都认：扁平 `backdrop > mask + img` 与带 stage `backdrop > stage > mask + img`。

第 3 步不能省：只关页面缩放等于**把 bug 和功能一起删掉**（用户会变成「点了没反应」）。

## 复验证据

- 代码层：`WebViewShimTest.pageLevelZoomIsPinnedOffOnEveryBaselineSurface`（三行成组 + 只在 shim 出现）、
  `dsh-client-ui-responsive` 的 `tests/lightbox-zoom.spec.ts` 11 例（只动 img、遮罩不缩放、夹取边界、
  双击切换、拖拽不算双击、Escape 复位、换图从 1x 起）。
- CDP 层：捏合后 `visualViewport.scale === 1`、img rect 变大、header/stage rect 逐字节不变、
  html/body 的 zoom 与 transform 不变；双击同判据；普通对话页捏合 `scale === 1`（页面缩放已关的正控）。
- ADB 层：真机手势 + 截图（修复前整屏放大 / 修复后只图变大）。
- 负控（闸门）：撤掉根上的 `touch-action` 授权 → 「普通对话页捏合 scale 仍为 1」变红（实测 1 → 5），
  重新加回即恢复 1。同一手势、同一构建、只改这一条规则。
- 负控（壳侧，如实记录）：把壳侧三行撤掉重新打包，该判据**不变红**（仍是 1）——这正说明闸门不在这三行，
  所以它们只作为纵深防御保留，不写进验收判据。
