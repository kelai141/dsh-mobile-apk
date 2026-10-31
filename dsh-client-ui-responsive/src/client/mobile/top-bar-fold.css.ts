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
 * 箭头挂在 [data-conversation-tabs] 的**父行**末位（真机实测 = 上游 div.wSkVaW_tabs，
 * display:flex; flex-wrap:wrap; align-items:flex-start; gap:16px 20px; padding-left:8px）。
 * ensureArrow 每轮同步都复检「我是不是父行的最后一个孩子」：父行里还有上游「…」菜单
 * （span.wSkVaW_viewsMoreAnchor + button[aria-haspopup=menu]）等兄弟节点，它们晚挂或重挂后
 * 箭头会被重新 append 回末位，因此不会停在菜单左边。
 *
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

/* 视图菜单（上游的「…」）：用户定例移除，只保留折叠箭头（#862 的行为，保留）。
   它**不是**标签条的子节点，而是标签条（[data-conversation-tabs]）的兄弟节点。
   按「兄弟 + 带 menu 语义」精确命中：+ * 是「谁排在我后面就藏谁」的开放规则，
   折叠箭头同样会被挂到这一行，将来任何插到那里的兄弟节点都会被误伤。

   已知未命中（真机实测 emulator-5558 / dsh 0.2.1-rc.2，不在本 PR 范围，单独处理）：
   这条规则在真机上 matches 为 false —— 菜单按钮外面包了一层
   span.wSkVaW_viewsMoreAnchor，结构是
     div.wSkVaW_tabs > div.viewTabs[data-conversation-tabs]
                     > span.wSkVaW_viewsMoreAnchor
                     > button[aria-haspopup=menu]
   中间隔着那个 span，相邻兄弟选择器 + 不成立，所以「更多会话视图」目前并未被隐藏。
   本 PR 只改箭头落位，不在这里扩宽选择器（+ * 会误伤箭头）；此处仅记录实测事实。 */
html[data-dsh-mobile-form] [data-conversation-tabs] + [aria-haspopup='menu'] {
  display: none;
}

/* 折叠箭头：紧凑、与两个侧边栏按钮同一视觉重量，**推到整行最右**、与「对话 / 轨迹」文字对齐。
   以下全部为真机实测（emulator-5558 竖屏 600x1067，dsh 0.2.1-rc.2，真实非空会话）。

   ── 水平：必须「挂父行」+「margin-inline-start: auto」同时成立 ──
     行 = div.wSkVaW_tabs（display:flex; flex-wrap:wrap; align-items:flex-start;
                          gap:16px 20px; padding-left:8px; rect x=20 right=572）
     标签条 = div.wSkVaW_viewTabs[data-conversation-tabs]（flex:0 1 auto; width=内容宽 140.02）
       箭头在标签条内部、无 auto            -> x=144.02（偏左）
       箭头在标签条内部 + auto              -> x=144.02（**完全无效**：标签条宽度=内容宽，
                                             内部没有剩余空间可吃，auto 无处可推）
       箭头在父行末位、无 auto              -> x=174.02
       箭头在父行末位 + auto                -> x=548 / right=572
       箭头在父行末位 + auto + 本规则       -> x=564 / right=588（见下）
   旧注释说 auto 会「与标签群之间空出一大段」—— 实测在 rc.2 上不成立：挂在标签条内部时
   auto 根本推不动，只有挂父行才生效。这正是旧实现掉在标签下面且偏左的成因。

   ── margin-inline-end: -16px：吃掉 header padding-right 的一半 ──
   header 是 padding:10px 28px 0 20px，所以行右边界只到 572，距视口 600 差 28px，
   超验收线（≤16px）。吃掉 16px 后 right=588、距视口 12px，与右上角按钮群（headerCorner）
   的既有留白 11.67px 基本一致。已验证 documentElement.scrollWidth === clientWidth === 600，
   不产生横向溢出，行 overflow 不裁切。

   ── 垂直：对齐「文字中心」，不是按钮盒中心 ──
   上游 .tab 是 line-height:16px + padding:0 0 9px，所以按钮盒中心比文字中心低
   (16+9)/2 - 16/2 = 4.5px（实测按钮盒中心 y=86.67、文字中心 y=82.17）。
   flex-start 让箭头顶到行首，箭头中心在 24/2 = 12px；文字中心在 8px；差 4px，故上移 4px。
   实测对照：align-self:center -> 差 4.58px；不加 align-self -> 差 4.00px；
             align-self:flex-start + margin-top:-4px -> 差 **0.00px**（本规则）。
   -4px 的来路就是上面这条算式（12 - 8），不是调出来的手感值；上游 .tab 的 line-height 或
   padding-bottom 变了就要按同一算式重算。
   写 align-self:flex-start 而不是依赖父行 align-items:flex-start：上游一旦改行的
   align-items，箭头不会被带走。

   ── 换行 ──
   实测：2 个视图标签不换行；加到 **6 个**标签时行高 25.17 -> 65、箭头掉到第二行（y 74.17 -> 115）；
   7 个就换行。**刻意不加 nowrap**：实测加 nowrap 后行高变成 82（比 wrap 时的 65 更高、更挤），
   极端情况下还会把标签压出可点区域。是否换行由父行的 flex-wrap 决定，本规则不碰父行。
   flex: 0 0 auto 是防御：父行是 flex 容器，箭头既不能被压缩也不能被拉伸。 */
html[data-dsh-mobile-form] [data-dsh-topbar-fold-arrow] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  align-self: flex-start;
  margin-top: -4px;
  margin-inline-start: auto;
  margin-inline-end: -16px;
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
