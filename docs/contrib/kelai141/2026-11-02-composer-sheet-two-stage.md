# 竖屏加号面板改底部 sheet + 两段滚动（2026-11-02）

## 现象

- 竖屏（<768px）点输入行「+」，出来的是一张**居中卡片**：上下各留 250px 空白，只占屏幕中间一块，
  既不像手机上的底部面板，也没有 peek/展开两段；上滑没有任何反应（设备实测：swipe 320ms 后
  panel 仍是 360×560 @y253.67，前后两张截图字节数完全相同）。
- 卡片里 9 条行只露出 8 条（最后一行被切一半），列表可滚但溢出只有 13px。
- 点「拍照」瓦片后焦点留在瓦片上，Android WebView 画出系统蓝框。
- 「+」菜单里 `store` / `fast` 两条标题是英文，其余中文。

## 真因

1. **形态只有一套**：`composer-sheet.css.ts` 明写「两种形态共用同一套居中卡片」，几何全交给
   `grid + place-items: center`，脚本不写任何内联高度 —— 所以既没有 peek 概念，也没有可调高度，
   上滑自然无事发生。
2. **行高被网格拉伸**：`[data-dsh-composer-sheet-rows]` 是 `display: grid` 且没写 `align-content`，
   默认 `stretch` 会把多余高度按比例塞进每条 auto 行。面板一展开，行高从 46 涨到 86，
   「2.5 行」的 peek 跟着算成 350（实测）。
3. **离场动画从未生效**：`composer-sheet.css.ts` 里有条注释提前用 `*/` 收尾，紧接着的一行中文
   留在模板字符串里成了「CSS 垃圾 token」，把下一条 `[data-dsh-composer-sheet-leaving]` 规则
   的选择器吞掉。`playExit()` 因此 `getAnimations()` 取到空集，直接 remove —— 三条关闭路径
   都没有退场动画，而代码注释一直写着「有」。
4. **瓦片焦点**：`[data-dsh-composer-sheet-tile]` 没有 `:focus` 规则，沿用 UA 的 `:focus-visible` 蓝框；
   面板打开时脚本会 `focus()` 第一块瓦片，于是蓝框常驻。
5. **命令标题**：上游 `MenuView` 渲染 `item.label ?? item.name`，而 `label` 只有**客户端命令贡献**
   （`CommandContribution.label?()`）能给；宿主命令目录 `CommandDescriptor` 只有 `name` + `description`。
   `fast` 是客户端贡献且当初没传 `label`，所以标题是命令 id；`store` 是宿主命令（市场插件在服务端注册），
   客户端没有标题钩子（见 known-gaps）。

## 修法要点

- 竖屏走**贴底 sheet**：`html[data-dsh-mobile-form]` 命中时 backdrop 改 `display: block`，panel 改
  `position: fixed; left/right: 0; bottom: var(--dsh-sheet-bottom)`，圆角只留上方两角，加一条拖拽把手，
  **竖屏不渲染关闭 ×**（横屏卡片仍有）。所有竖屏规则都以 `html[data-dsh-mobile-form]` 开头 ——
  这是「横屏一个像素都不动」的结构保证，不是约定。
- **peek 按内容算**：`padTop + 把手块 + 瓦片行 + 行间距 + 2.5×行高 + padBottom + 安全区`。行高取真实
  第一行并**缓存整数**（吸附动画期间量到 46.4/46.8 会让 peek 每次都不一样，实测 249→252→350）；
  安全区读 `--dsh-sheet-safe-bottom = max(env(safe-area-inset-bottom), var(--dsh-android-system-bottom))`，
  与 `mobile-form.css.ts` 同款，且**只计一次**（折进 `padding-bottom` 会重复计）。展开上限 `0.88 × visualViewport.height`。
- **两段滚动**：起手 8px 方向锁；`rows.scrollTop > 0` 判列表拥有（不 preventDefault，走原生滚动）；
  `scrollTop === 0` 时上滑 1:1 抬卡片，到上限把剩余位移交回列表（`rows.scrollTop += rest`）；
  下滑先滚列表、再回收高度、最后才进 overscroll（`translateY(extra)`）；松手按速度吸附，
  **extra > 0.3 × peek 才关闭**（阈值是卡片高度的比例，不是固定像素）。
- 视口：`visualViewport` 的 `resize`/`scroll` 都触发重算，`--dsh-sheet-bottom` 跟随键盘抬起量；
  行列表 `overscroll-behavior-y: contain`。
- 手感档：`<html data-dsh-composer-sheet-feel=A|B>`。A 是契约档（阻尼 1、200ms），B 是备选（0.85/0.9、280ms）。

## 反证（去掉任一条，对应判据必红）

| 负控 | 改法 | 变红的用例 |
|---|---|---|
| NC1 | `DRAG_LOCK_PX = 8 → 0` | 12「前 8px 不改高度」、13（NC1 专项） |
| NC2 | `peekHeight()` 直接 `return 0.42 × viewportHeight()` | 1、6、7、8、8b、9（NC2 专项）、16、19 |
| NC3 | `CLOSE_RATIO = 0.3 → 0` | 18「peek 之下跟手」、20（NC3 专项） |

## 遗留

- `store` 标题仍是命令 id：它是宿主命令，客户端没有标题钩子（详见 `docs/AGENTS/known-gaps.md`）。
- 设备证据链是 hot-push（插件 JS 改动）；最终 APK 需按 §2.1 复验。