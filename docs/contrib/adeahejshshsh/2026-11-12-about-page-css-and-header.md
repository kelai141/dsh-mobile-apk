# 关于页：一条从不生效的 CSS 规则，和一条会把整页藏掉的结构选择器

写于 2026-11-12。来自「设置 → 通用 → 关于」的两处样式缺陷（P1：顶部仍显示「关于」、横屏无样式；
P2：结构选择器可能整页 display:none、引擎版本回落到占位符）。

## 一、选择器前缀写两遍 = 永不匹配

`about-entry.css.ts` 里那条收标题条的规则，注释夹在了两段 `html[data-dsh-mobile-form]` 之间：

```css
html[data-dsh-mobile-form] /* 注释……
   …… */
html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-about-active] [data-dsh-settings-bar-title] { … }
```

CSS 注释会被丢弃，**但不产生空白 token**。所以解析结果是：

```
html[data-dsh-mobile-form] html[data-dsh-mobile-form] [data-dsh-settings-dialog][…] [data-dsh-settings-bar-title]
```

这是「html 里再套一个 html」的后代选择器，永远匹配不到。表现：`settings-nav` 的 `syncTitle`
把标题条写成当前分区名（`关于`），而唯一该压掉它的规则是死的 → 关于页顶部一直有「关于」，
和「图标 + 名称已经承担标题」的定例冲突。

单测抓不到它：`about-entry.spec.ts` 只断言面板被打上 `data-dsh-about-active`，jsdom 不算布局；
`settings-layering-css.spec.ts` 只守 `MOBILE_SETTINGS_CSS`，不碰这张表。

**判据**：任何 `*.css.ts` 的选择器里，`html` 出现次数不得超过 1；注释不得夹在选择器中间。
这条现在由 `tests/about-css.spec.ts` 钉住（解析后按规则断言，不靠肉眼比对字符串）。

## 二、全表 gate 在手机形态下 = 横屏零样式

同一张表的 15 条规则里 14 条带 `html[data-dsh-mobile-form]` 前缀，而该标记只在
`innerWidth <= 767` 时写（`form-marker.ts`）。横屏 / 平板于是拿到**零样式**：入口退化成
原生 `<button>`（灰底、描边），关于页失去整页排版。

同页的 `general-settings.css.ts` 恰恰不带前缀（`grep -c data-dsh-mobile-form` = 0）——
两套写法并存，说明前缀在这张表里是误加而不是设计。入口与关于页都是本包自有节点，
没有「上游横屏布局」需要保留，统一去掉前缀。

## 三、`> div:last-child > div:first-child` 是会把整页藏掉的判据

原规则想收「上游内容列的表头行」，判据是「面板最后一个 div 的第一个 div 子节点」。
0.2.2 的面板是 `navTitle / nav / header / options`，`> div:last-child` = options；
**只要 options 的第一个 div 子节点是分区根节点（而不是表头行），这条规则命中的就是 `.dsh-about-page`**
——整页 display:none，只剩一条返回条，且没有任何测试能发现。

修法不是换一条更巧的结构选择器（本机 WebView 是 Chromium 97，`:has()` 用不了），
而是把判据从「位置」换成「身份」：`about-section` 挂载时用 `markUpstreamHeader()` 认出
来源节点、打 `data-dsh-about-header`，样式只认这个属性。打标前显式排除本页根节点及其祖先：
认错时宁可留下一个重复的「关于」，也不能把页面藏掉。

## 四、引擎版本只活在模块变量里

`getEngineVersion()` 原先只返回模块变量。模块重载（热推 / 页面重载 / 插件重新装配）后变量归零，
而用户可能先落在别的设置分区——上游「当前版本」那行不在 DOM 里，抓不到 → 关于页显示 `—`。

`data-dsh-about-source` 本来就写在 DOM 上、跨实例存活，是同一份事实。空值时回读一次并缓存即可。

## 五、复验

```bash
cd dsh-client-ui-responsive
npx vitest run tests/about-css.spec.ts tests/about-page-header.spec.ts tests/about-version.spec.ts tests/about-entry.spec.ts
```

- `about-css.spec.ts`：解析选择器，断言无嵌套 html、无手机形态前缀、无 `div:first-child` 结构判据、
  两条收标题的规则都在 `[data-dsh-about-active]` 下。
- `about-page-header.spec.ts`：表头行被打标并在卸载时撤销；多一层滚动容器仍认得出；
  **没有表头行时一个标记都不许打**（失败保护）。
- `about-version.spec.ts`：全新模块实例 + DOM 标记 → 版本可读，页面不落占位符。

真机判读（需 debug 包 + CDP）：进关于页后
`getComputedStyle(document.querySelector('[data-dsh-settings-bar-title]')).display` 应为 `none`。
