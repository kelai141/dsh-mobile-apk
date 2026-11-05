# 布局「滚不起来」的三类假象：1fr 永不溢出、可见性 ≠ 几何、取动画早于挂规则

2026-10-31 做横屏「+」锚定卡片与竖屏限高滚动时，连续踩到三个「看着对、实测不对」的坑。共同点：**都能在 jsdom 里判绿，只有设备上的几何量能抓出来**。

## 一、`grid-template-columns: repeat(3, 1fr)` 配 `overflow-x: auto` 永远滚不起来

**现象**：三块瓦片排加了 `overflow-x: auto` + `scroll-snap-type: x proximity`，单测断言这几条 CSS 在场、全绿。但窄屏下第三块被右侧悬浮球压住，整排溢出，滚不动。

**真因**：`1fr` 轨道按容器宽度**均分**，轨道总和恒等于容器宽 —— 内容永远不会超出容器，`scrollWidth == clientWidth`，`overflow-x: auto` 无从触发。窄屏下它只是把三块越压越窄（360dp 面板实测 105px），标题于是挤成多行或被裁。**CSS 属性在场 ≠ 行为发生。**

**修法**：要真滚动，卡片必须按自身宽度占位且不许收缩：

    [tiles] { display: flex; flex-wrap: nowrap; overflow-x: auto; }
    [tile]  { flex: 0 0 auto; width: calc((100% - 20px) / 3); min-width: 96px; }

`width` 负责「装得下时三等分铺满」（保持改造前的观感），`min-width` 负责「装不下时顶出容器产生滚动」。两者缺一：只有 width 会被 flex 压回容器内，只有 min-width 则装得下时不等分。

**复验判据**：`scrollWidth` / `clientWidth` 两个宽度并排报；装得下时 `scrollWidth == clientWidth` 且三块宽度极差 <= 1.5px；装不下时 `maxScrollLeft > 0` 且每块 >= 96px。

## 二、`visibility: hidden` 保留布局盒 —— 拿 rect 判「越界」会把藏对了判成坏了

**现象**：上游菜单在读选项的约 1.2s 窗口里真的画在屏幕上（listbox `right=1022.33` vs 卡片 `right=682.33`，越界 340px），于是用 `visibility: hidden` 把它藏掉。结果严格判据仍然报「越界」，一度以为修法无效。

**真因**：`visibility: hidden` **保留布局盒** —— 元素照旧参与布局、`getBoundingClientRect()` 仍返回 704x355、`right` 仍是 1022.33，只是不绘制。判据只看 rect 就把「已经看不见」判成了「还在越界」。

**修法**：可见性判据 = `getClientRects().length > 0` **且** `getComputedStyle(el).visibility !== 'hidden'`。严格模式只统计可见帧。

**副作用**：不能改用 `display: none` 绕开 —— 上游的测量与定位会拿到 0 尺寸，可能改变菜单挂载行为。`visibility` 保留布局与节点身份，合成事件仍能派发到节点上。

## 三、`getAnimations()` 只返回**已存在**的动画 —— 先取后挂规则，退场动画恒为 0 帧

**现象**：竖屏退场动画 160ms 写好、CSS 规则也在，设备实测「离场期间观测到动画帧 0 个」，点外之后第 1 帧面板就没了。

**真因**：`playExit()` 里写成了

    const animations = backdrop.getAnimations({ subtree: true })   // 先取
    if (animations.length === 0) { backdrop.remove(); return }      // 空集 -> 立刻移除
    backdrop.setAttribute(LEAVING_ATTR, '')                        // 后挂

退场动画由 `[data-dsh-composer-sheet-leaving]` 那条 CSS 规则定义。先取后挂 → 取到的是空集（或入场动画）→ 走「没有动画就立刻移除」分支 → 面板被直接抹掉。**顺序错了，功能就没了，但代码读起来完全合理。**

**修法**：先挂标记再取动画；`subtree: true` 不能省（竖屏退场动画挂在子元素 panel 上，只查遮罩自身会漏掉）；兜底计时器保留（动画因元素不可见/浏览器跳过而永不 `finish` 时，面板会永久留在 DOM 里，比没动画严重）。

**为什么单测抓不到**：jsdom 没有 WAAPI，`getAnimations` 不存在 → 走「立刻移除」分支 → 测试照样绿。**判据要换成能观测顺序的形式**：装一个假的 `getAnimations`，在它被调用时回读标记是否已挂上。

    Object.defineProperty(backdrop, 'getAnimations', {
      value: (options) => {
        sawLeavingAtCallTime = backdrop.hasAttribute(LEAVING_ATTR)  // 钉顺序
        expect(options?.subtree).toBe(true)                          // 钉 subtree
        return []
      },
    })

## 四、附带：断言匹配到了注释里的同名字面量

写负控时把 `flex: 0 0 auto` 改成 `flex: 1 1 auto`，负控**仍然绿**。查下来是断言写成了 `/[tile]\s*\{[^}]*flex:\s*0 0 auto/`，而上面注释里恰好有一句「规格 1 的 flex: 0 0 auto」——**匹配到的是注释，不是声明**。

修法两条一起做：注释里不写可被判据匹配到的字面量声明；断言要求**行首 + 结尾分号**（`/\n\s*flex:\s*0 0 auto;/`），才算真声明。

**教训**：负控变绿时，先怀疑负控本身没生效（变异是否真的写进去了、断言是否匹配到了别处），再怀疑判据太弱。这次两个原因都占了一半。
