/**
 * 插件市场（设置 → 内置插件 → 插件市场）的行规对齐。
 *
 * 对标上游：dshmarketplace-plugin 0.1.7（MARKETPLACE_UPSTREAM_VERSION）。
 * 这里的每条覆盖都依赖它当前的 DOM 结构与类名（dshm-*）；上游换主题或改结构时，
 * 这些规则会**静默失效**（界面悄悄回到纸色主题）。因此版本写进常量并由
 * tests/marketplace-css-anchor.spec.ts 比对 vendor/dshmarketplace-plugin/package.json，
 * 版本一涨就判红，提醒重新核对本表。
 *
 * 这一页由第三方插件 `dshmarketplace-plugin` 自己渲染（`dshm-*` 类），自带一套
 * 「纸色 + 铜色」主题：`--paper/#f7f4ed`、`--ink`、`--copper`，等宽字体做标题，
 * 1px 直角描边、38px 搜索框、32px 直角按钮。它和设置页里上游那套
 * （语义令牌、14/20 标题 + 12/18 说明、0.5px 分隔线、圆角控件）并排就是两种语言。
 *
 * 本表只做覆盖，不碰对方的行为：选择器全部以 `.dshm` 开头，
 * 颜色/圆角/字号一律走 `--dsw-*` 语义令牌，亮暗主题自动跟随。
 *
 * 两处覆盖带说明：
 *  1. 「仅移动端可用」是插件自带的原生 `<input type=checkbox>`，且带行内样式——
 *     行内样式改不动布局，但控件本身可以画成上游 `Switch` 的样子（同尺寸、同令牌、
 *     `corner-shape: round`）。点按行为完全不变，仍是原生 checkbox。
 *  2. `.dshm-list` 自带 `border-top`，与 `.dshm-head` 的下边线会叠成双线，故去掉。
 */
/** 本表对标的上游插件版本（机器可核对的锚，见文件头说明）。 */
export const MARKETPLACE_UPSTREAM_VERSION = '0.1.7'

export const MARKETPLACE_CSS: string = `
/* 根容器：去掉纸色主题，改走页面底色与主文字色。 */
.dshm {
  color: var(--dsw-alias-label-primary);
  background: transparent;
  font-size: 14px;
  /* 保留 12px 的纵向节奏：header / 搜索框 / 勾选框 / 列表之间靠它隔开。
     上一版把它写成 0，导致勾选框与搜索框贴在一起。 */
  gap: 12px;
  padding: 0;
}

.dshm-head {
  align-items: flex-start;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  padding-bottom: 12px;
}

.dshm-title {
  font-weight: 500;
  font-size: 14px;
  line-height: 20px;
  letter-spacing: 0;
}

.dshm-sub {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* 搜索框：与上游输入框同高同圆角（32px / radius-md / 0.5px 描边）。
   纵向间距由 .dshm 的 gap 提供，这里不再加 margin（否则叠成 24px）。 */
.dshm-search {
  box-sizing: border-box;
  width: 100%;
  height: 44px;
  padding: 0 12px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-md);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 22px;
}

.dshm-search:focus {
  border-color: var(--dsw-alias-state-business-primary);
  outline: none;
}

/* 「仅移动端可用」这一行的容器：插件给它的是行内样式
   marginLeft:10 / gap:4 / fontSize:13，行内样式只能靠 !important 覆盖。
   改成与上游行一致：左对齐、8px 图标间距、12/18 次要文字。 */
.dshm > label {
  margin-left: 0 !important;
  gap: 8px !important;
  font-size: 12px !important;
  line-height: 18px !important;
  color: var(--dsw-alias-label-secondary) !important;
}

/* 「仅移动端可用」：原生 checkbox 画成上游 Switch（36x20 胶囊 + 16px 圆点）。 */
.dshm input[type='checkbox'] {
  appearance: none;
  -webkit-appearance: none;
  box-sizing: border-box;
  flex: 0 0 auto;
  position: relative;
  width: 36px;
  height: 20px;
  margin: 0;
  padding: 2px;
  border: 0;
  border-radius: 999px;
  corner-shape: round;
  background: var(--dsw-alias-border-l3);
  cursor: pointer;
  transition: background 120ms ease;
}

.dshm input[type='checkbox']::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  corner-shape: round;
  background: var(--dsw-alias-bg-base);
  transition: transform 120ms ease, background 120ms ease;
}

.dshm input[type='checkbox']:checked {
  background: var(--dsw-alias-brand-primary);
}

.dshm input[type='checkbox']:checked::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground);
}

/* 仓库行（一行一仓）+ 展开后的子包列表。
   仓库行本身不带安装按钮：安装只发生在具体子包上，避免「这一行到底装哪个」的歧义。 */
.dshm-row.dshm-repo {
  align-items: flex-start;
}

.dshm-kids-toggle {
  box-sizing: border-box;
  margin-top: 8px;
  height: 28px;
  padding: 0 10px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.dshm-kids-toggle:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dshm-kids {
  list-style: none;
  margin: 0;
  padding: 0 0 0 12px;
  border-left: 0.5px solid var(--dsw-alias-border-l2);
}

.dshm-kids > .dshm-row {
  padding-left: 8px;
}

/* 子包行的作者与 star 与所属仓库行完全重复（同一仓库、同一个 star 数），
   在缩进列表里再显示两遍是纯噪音：子包只保留包名、简介、元信息与安装按钮。 */
.dshm-kids .dshm-owner,
.dshm-kids .dshm-stars {
  display: none;
}

/* 分页条（列表上下各一条）：首末页 + 当前页前后各一页 + 省略号，右侧可输入页码跳转。
   每页 96 条是接口上限（实测 limit=200/500/1000 都只回 96），超过 96 条靠 page 翻页。 */
.dshm-pager {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  padding: 8px 0;
  /* 双击不缩放：分页条上的连击只应表达一次点按 */
  touch-action: manipulation;
}

.dshm-page-btn {
  box-sizing: border-box;
  height: 28px;
  min-width: 28px;
  padding: 0 8px;
  border: 0.5px solid transparent;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

/* hover 只作用于非当前页：当前页是实心填充，再叠一层 hovering 底色就成了
   「黑底上盖一层白」——点过之后鼠标/手指停在那颗按钮上就会看到。 */
.dshm-page-btn:hover:not(.dshm-page-cur) {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dshm-page-btn:active:not(.dshm-page-cur) {
  background: var(--dsw-alias-interactive-bg-active);
}

.dshm-page-cur {
  border-color: var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

/* 当前页自己的 hover/active：只走 primary 系列的悬停色，保持实心外观。 */
.dshm-page-cur:hover,
.dshm-page-cur:active {
  background: var(--dsw-alias-button-primary-hover);
  color: var(--dsw-alias-label-primary-foreground);
}

/* 键盘焦点用描边环表示，不用底色（避免第二次出现「盖一层」）。 */
.dshm-page-btn:focus-visible {
  outline: var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary));
  outline-offset: 1px;
}

/* 省略号纯装饰：自己接收事件并吞掉（onClick 里 preventDefault + stopPropagation）。
   不能用 pointer-events:none —— 那样事件会穿透到分页条容器与上层，双击时会被当成
   「点了相邻页」而翻页。 */
.dshm-page-gap {
  padding: 0 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  user-select: none;
  -webkit-user-select: none;
}

/* 过滤行的条数提示：勾上「仅移动端可用」时显示真实条数（服务端改用真集合分页后，
   这个数字才是列表里真正有多少条，而不是源目录的 4544）。 */
.dshm-mobile-count {
  margin-left: 6px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dshm-page-input {
  box-sizing: border-box;
  width: 64px;
  height: 28px;
  margin-left: 6px;
  padding: 0 8px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 12px;
}

/* 列表：去掉与 head 叠成双线的上边线。 */
.dshm-list {
  border-top: 0;
}

.dshm-row {
  gap: 12px;
  padding: 10px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

/* 行首三列（包名 / 作者 / star）：包名可折行占满剩余宽度，作者与 star 不折行。
   不这样约束时，「★ 8,594」会被压成两行——star 数是整行最不该断的内容。 */
.dshm-row-head {
  flex-wrap: nowrap;
  gap: 8px;
}

.dshm-stars {
  flex: 0 0 auto;
  margin-left: auto;
  white-space: nowrap;
}

/* 包名不再用等宽字体：上游列表项是正文字体 + 中等字重。 */
.dshm-name {
  flex: 1 1 auto;
  min-width: 0;
  font-family: inherit;
  font-weight: 500;
  font-size: 14px;
  line-height: 20px;
  color: var(--dsw-alias-label-primary);
  overflow-wrap: anywhere;
}

.dshm-owner,
.dshm-stars {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dshm-summary {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

.dshm-meta {
  margin-top: 6px;
  gap: 10px;
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary);
}

/* 品牌蓝写显式值：--dsw-alias-brand-primary 在深色主题下实测近白，会变成白底白字
   （与本包 dev-section 的 .dsh-dev-link 同一处理）。 */
.dshm-meta a {
  color: #4d6bfe;
  text-decoration: none;
}

.dshm-meta a:hover {
  text-decoration: underline;
}

.dshm-risk {
  color: var(--dsw-alias-state-error-primary);
}

/* 动作按钮：对齐上游 Button.sm（安装=primary，取消/ghost=outline）。 */
.dshm-install,
.dshm-ghost {
  box-sizing: border-box;
  height: 28px;
  padding: 0 10px;
  border-radius: var(--dsw-radius-sm);
  font-family: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

.dshm-install {
  border: 0.5px solid var(--dsw-alias-button-primary-fill);
  background: var(--dsw-alias-button-primary-fill);
  color: var(--dsw-alias-label-primary-foreground);
}

.dshm-install:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.dshm-ghost {
  border: 0.5px solid var(--dsw-alias-border-l3);
  background: transparent;
  color: var(--dsw-alias-label-primary);
}

.dshm-state {
  color: var(--dsw-alias-label-secondary);
  padding: 24px 0;
  font-size: 12px;
  line-height: 18px;
}

/* 加载/错误/空态现在渲染在列表里（一条 li），而不在页面顶部。 */
.dshm-list > .dshm-state {
  list-style: none;
  text-align: center;
}

.dshm-error {
  border-left: 2px solid var(--dsw-alias-state-error-primary);
  background: transparent;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}

/* 安装确认：面板与上游弹层同规（圆角 + 图层底色 + 0.5px 描边）。 */
.dshm-panel {
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-primary);
}

.dshm-confirm-body {
  background: var(--dsw-alias-bg-layer-2);
  border: 0.5px solid var(--dsw-alias-border-l2);
  border-left-width: 0.5px;
  border-radius: var(--dsw-radius-lg);
  color: var(--dsw-alias-label-primary);
}

.dshm-confirm-title {
  font-family: inherit;
  font-weight: 500;
  font-size: 14px;
  line-height: 20px;
}

.dshm-confirm-risk {
  color: var(--dsw-alias-state-error-primary);
}

.dshm-confirm-note {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* 「添加插件」下拉里的「插件市场」项：与相邻的「安装第三方插件」同为两行结构
   （标题 + 说明），说明用次要色、12/18。 */
.dsh-market-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.dsh-market-item-desc {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* 「插件」页里的市场 Tab 按钮隐藏：入口只保留「添加插件」下拉里的那一项。
   运行时（dsh-client-ui-plugin-manager）的 tab 按钮 id 形如 tabsId-item.id，
   面板 id 是同前缀再加 -panel——所以后缀匹配 -dshmarketplace 只命中按钮，不命中面板。
   注意：不要写成 -tab-dshmarketplace，运行时里没有 -tab- 这一段（真机实测不命中）。 */
[id$='-dshmarketplace']:not([id$='-panel']) {
  display: none;
}

.dsh-market-empty {
  margin: 0;
  padding: 24px 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* 市场整页（0.15.0 用户定例）：浮层拉满整屏、面板占满，顶部一条「返回 + 标题」页头，
   读起来是独立页面而不是浮在 UI 上的小窗。 */
.dshm-overlay {
  align-items: stretch;
  justify-content: stretch;
  padding: 0;
  background: var(--dsw-alias-bg-layer-1);
}

.dshm-panel {
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-width: none;
  height: 100%;
  max-height: none;
  /* 面板本身不滚：否则页头会跟着内容一起滚出视野（表现为「返回被挤没了」）。
     滚动交给内容区 .dshm。 */
  overflow: hidden;
  border: 0;
  border-radius: 0;
  background: var(--dsw-alias-bg-layer-1);
}

.dshm-pagebar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 8px;
  min-height: 52px;
  /* 顶到屏幕最上沿的是整页浮层：必须让开系统状态栏/安全区，否则页头（返回）被状态栏盖住。
     --dsh-mobile-top-inset 是本包在 :root 上定义的「安全区与系统状态栏取大」变量。 */
  padding: calc(6px + var(--dsh-mobile-top-inset, env(safe-area-inset-top, 0px))) 8px 6px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  /* 页头永远在最上层、且自带底色：内容滚动时不会被盖住，也不会「看不见」。 */
  position: sticky;
  top: 0;
  z-index: 2;
  background: var(--dsw-alias-bg-layer-1);
}

/* 返回：明确的「‹ 返回」文字按钮，44px 高（可点面积够大，不再是一个小箭头）。 */
/* 返回：与上游设置二级页同款——只有一个「‹」箭头，透明底，40px 可点面积。 */
.dshm-back {
  box-sizing: border-box;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: 0;
  border-radius: var(--dsw-radius-sm);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 24px;
  line-height: 1;
  cursor: pointer;
}

.dshm-back:active {
  background: var(--dsw-alias-interactive-bg-active);
}

.dshm-back:active {
  background: var(--dsw-alias-interactive-bg-active);
}

.dshm-pagetitle {
  color: var(--dsw-alias-label-primary);
  font-size: 16px;
  line-height: 24px;
  font-weight: 500;
}

/* 面板里的内容自己滚，页头固定。 */
.dshm-panel > .dshm {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  padding: 12px;
  /* 底部同样让开手势条/安全区，最后一条结果不被遮。 */
  padding-bottom: calc(12px + max(env(safe-area-inset-bottom, 0px), var(--dsh-android-system-bottom, 0px)));
}

/* 市场自带的标题块（DSH Marketplace + 副标题）删掉：页头已经写了「插件市场」，
   同一屏里出现两层标题是冗余（用户定例）。 */
.dshm-panel > .dshm > .dshm-head {
  display: none;
}

/* 列向 flex 容器默认允许子项收缩：标题区、搜索框、勾选行、分页条都要保持自身高度，
   否则会被压扁（真机表现就是搜索框变薄、返回被顶掉）。 */
.dshm > .dshm-head,
.dshm > .dshm-search,
.dshm > .dshm-pager,
.dshm > label {
  flex: 0 0 auto;
}

.dshm-search {
  flex: 0 0 auto;
}
`
