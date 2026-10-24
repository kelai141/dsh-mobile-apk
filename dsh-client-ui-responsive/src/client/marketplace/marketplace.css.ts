/**
 * 插件市场（设置 → 内置插件 → 插件市场）的行规对齐。
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
  height: 32px;
  padding: 0 10px;
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
  background: var(--dsw-alias-switch-thumb);
  transition: transform 120ms ease, background 120ms ease;
}

.dshm input[type='checkbox']:checked {
  background: var(--dsw-alias-brand-primary);
}

.dshm input[type='checkbox']:checked::after {
  transform: translateX(16px);
  background: var(--dsw-alias-label-primary-foreground);
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

/* 包名不再用等宽字体：上游列表项是正文字体 + 中等字重。 */
.dshm-name {
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
`
