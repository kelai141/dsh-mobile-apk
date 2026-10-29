/**
 * 竖屏顶栏插件 UI 折叠（0.14.7 / Spec 2.6，含 E 项灰色圆角矩形的收口）。
 *
 * 折叠对象是上游标题栏 actions 座位下**实际已挂载的节点**，不是插件名单：
 * 上游 ConversationSession.tsx:127-129 把 conversation.session.header.actions 渲染进
 * div.headerActions，第三方插件（ui-agent-preset 的模式标签、vendor dsh-undo-savepoint 的
 * 快照徽章）都经该座位挂载。座位里出现什么，面板里就出现什么 —— 新插件自动进入，
 * 无需维护名单，也不存在「漏登记某个插件」这种缺陷形态。
 *
 * 节点**不搬家**：整个换的是座位容器自己的呈现方式（关闭时 display:none，打开时
 * fixed 浮动面板）。React 树没被我们改动，所以不存在失状态、重复注册、重挂载抖动。
 *
 * 为什么需要 title-row 去containment：上游 .titleRow 带 container-type: inline-size，
 * 而 layout containment 会成为 fixed 后代的 containing block —— fixed 面板会被困在那条
 * 30px 高的行里。这与 snapshot-panels.css.ts 处理同一个问题的先例一致（那里也是打开面板时
 * 临时把 containment 换成 normal）。
 *
 * 箭头挂在 [data-conversation-tabs] 上（上游该属性是稳定的锚点，见 ConversationSession.tsx:143），
 * 不按「对话」「轨迹」文字匹配 —— 视图标签由 conversation.view 插槽注册，文案可变可增。
 */
export const TOP_BAR_FOLD_CSS: string = `
/* 关闭态：座位内容整体离场，顶栏只剩标题、两个侧边栏按钮与三点菜单。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold='closed'] {
  display: none !important;
}

/* 打开态：座位变成不推动内容的浮动面板。left/right 由 JS 按头部实测写入。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold='open'] {
  display: flex !important;
  position: fixed !important;
  z-index: 25;
  box-sizing: border-box;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 12px;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.4));
  border-radius: var(--dsw-radius-md, 10px);
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
  /* 内容过多限高内部滚动；overflow 与 fixed 后代相容（面板内二级弹层照常越出）。 */
  max-height: var(--dsh-topbar-fold-max-height, 60vh);
  overflow-y: auto;
  overflow-x: hidden;
}

/* 面板容器自身不得建立新的 containing block，否则面板里的二级弹层会被裁在面板内。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold] {
  transform: none;
  filter: none;
  will-change: auto;
}

/* 去 containment：让 fixed 面板以视口为参照，而不是被困在 30px 的标题行里。
   只在这条标题行上生效，其它查询容器不受影响。 */
html[data-dsh-mobile-form] div[data-dsh-topbar-fold-uncontained] {
  container-type: normal;
  contain: none;
}

/* 折叠箭头：紧凑、与两个侧边栏按钮同一视觉重量，靠右。 */
/* 视图菜单（上游的「…」）：用户定例移除，只保留折叠箭头。
   注意它**不是**标签条的子节点，而是标签条（[data-conversation-tabs]）的兄弟节点——
   按「标签条的下一个兄弟」精确命中；标签条存在但没有菜单时该规则自然不生效。 */
html[data-dsh-mobile-form] [data-conversation-tabs] + * {
  display: none;
}

html[data-dsh-mobile-form] [data-dsh-topbar-fold-arrow] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-left: auto;
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  border-radius: var(--dsw-radius-sm, 6px);
  background: transparent;
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
html[data-dsh-mobile-form] [data-dsh-topbar-fold-arrow] svg {
  transition: transform var(--ds-transition-duration-fast, 150ms) ease;
}
html[data-dsh-mobile-form] [data-dsh-topbar-fold-arrow][aria-expanded='true'] svg {
  transform: rotate(180deg);
}

/* E 项：vendor 快照徽章（div.u_actions[data-undo-header] > button.u_badge）在顶栏里
   只剩一个灰色空心胶囊（z-index 999 的圆角矩形、内部绿点已被 vendor-chrome-hide 藏掉）。
   移进面板后去掉灰色填充与描边，让它回归成一个有意义的图标入口，而不是灰块。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold='open'] [data-undo-header] .u_badge {
  background: transparent;
  border-color: transparent;
}
/* 面板里把绿点还原：它是该入口唯一的语义图形（快照状态），灰色胶囊已不再是它的壳。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold='open'] [data-undo-header] .u_dot {
  display: block !important;
}
`
