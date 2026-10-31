/** 输入行「+」面板：三块瓦片 + 自动映射上游「+」菜单的行。
 *
 * 两种形态（横屏 / 竖屏）共用**同一套居中卡片**：外观固定、位置固定（视口居中），
 * 不再随输入框里「+」的位置漂移。几何全部交给 CSS，脚本不写任何内联定位。
 */
export const COMPOSER_SHEET_CSS = `
[data-dsh-composer-sheet-backdrop] {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  /* 全屏黑色遮罩约 55%，不模糊；必须接收点击（点遮罩关闭）。
     若把它关成不接事件，点击会穿透到背后页面，panel.contains(target) 看不到，卡片关不掉。 */
  background: rgba(0, 0, 0, 0.55);
  pointer-events: auto;
  /* 卡片居中：grid + place-items，与视口尺寸无关，横竖屏同一套。 */
  display: grid;
  place-items: center;
  /* aria-modal=true：滚到端点不许把滚动链交给背后的页面（#1009）。 */
  overscroll-behavior: contain;
  animation: dsh-composer-backdrop-in 200ms cubic-bezier(0.215, 0.61, 0.355, 1);
}
/* 居中卡片：固定落点，宽高只受视口约束，与「+」的位置无关。 */
[data-dsh-composer-sheet-panel] {
  box-sizing: border-box;
  /* 宽上限 360，且两侧各留 12px 安全边距（窄视口不被拉出屏幕）。 */
  width: min(360px, calc(100vw - 24px));
  /* 高上限 min(70vh, 560px)：卡片永远不贴到视口底，因此不会被手势条遮挡。 */
  max-height: min(70vh, 560px);
  /* 面板自己**不滚**：滚的是里面的列表（面板 overflow:hidden 只裁圆角外的溢出）。 */
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 16px;
  overscroll-behavior-y: contain;
  /* 圆角 20px，走现有 token。 */
  border-radius: var(--dsw-radius-xl, 20px);
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-markdown-base, inherit);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.36);
  /* 入场：从视口底边之下飞入。起点 translateY(100vh) 保证卡片整体在视口底外，
     与「+」的坐标无关（旧的锚定形态已删除）。 */
  animation: dsh-composer-card-in 200ms cubic-bezier(0.215, 0.61, 0.355, 1);
}
/* 第一排：三块并排瓦片。
   横向滚动限位 + snap 是两种形态共用的（规格：三张卡片那排横向滚动限位）。

   **为什么必须 flex 而不是 grid repeat(3, 1fr)**（真缺陷，实测）：
   1fr 轨道按容器宽度均分，**永远不会溢出** —— 配了 overflow-x: auto 也滚不起来，
   窄屏下只是把三块越压越窄（360 宽面板里实测被压到 105px，320 宽更窄），
   标题于是挤成两行甚至被裁。要真滚动，卡片必须按自身宽度占位、且不许收缩。 */
[data-dsh-composer-sheet-tiles] {
  display: flex;
  flex-wrap: nowrap;
  /* 面板是 flex column：瓦片排不参与拉伸，否则会被撑高。 */
  flex: none;
  gap: 10px;
  box-sizing: border-box;
  /* 不超出面板宽：max-width 挡住溢出，min-width: 0 让容器可收缩。 */
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  /* 滚动条隐藏但滚动可用。chrome87 只认 ::-webkit-scrollbar，两条都留。 */
  scrollbar-width: none;
}
[data-dsh-composer-sheet-tiles]::-webkit-scrollbar {
  display: none;
}
[data-dsh-composer-sheet-tile] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  /* 不许收缩：装不下时靠滚动，而不是把卡片压窄。
     宽度按三等分取，装得下时正好铺满；装不下时由 min-width 兜底 → 真滚动。
     min-width 96px 是按两行 13px 标题算的（最宽两行约 4 个汉字 = 52px，
     加左右内边距 24px 与边框，96px 才不会断成三行）。 */
  flex: 0 0 auto;
  width: calc((100% - 20px) / 3);
  min-width: 96px;
  min-height: 96px;
  padding: 12px;
  scroll-snap-align: start;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
  border-radius: var(--dsw-radius-lg, 16px);
  background: var(--dsw-alias-bg-layer-2, transparent);
  color: inherit;
  cursor: pointer;
}
[data-dsh-composer-sheet-tile]:active {
  background: var(--dsw-alias-bg-layer-1, transparent);
}
[data-dsh-composer-sheet-tile] svg {
  flex: none;
  width: 28px;
  height: 28px;
  color: var(--dsw-alias-label-secondary, inherit);
}
/* 瓦片标签：**两种形态都显示**（卡片不再窄小，规格取消横屏隐藏）。 */
[data-dsh-composer-sheet-tile-label] {
  font-size: 13px;
  /* 行高 1.25：两行标题需要可读行距。 */
  line-height: 1.25;
  color: var(--dsw-alias-label-secondary, inherit);
  /* 标题自动换行而不是截断。anywhere 而不是 break-word：
     中文没有词边界，break-word 对连续汉字不生效。 */
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
  text-align: center;
  max-width: 100%;
}
/* 第二段：上游「+」菜单项的映射行（图标 + 标题 + 副标题）。 */
[data-dsh-composer-sheet-rows] {
  display: grid;
  /* 列表是**唯一滚动容器**：卡片高度不够时由它滚，三块瓦片留在顶部不跟着滚。 */
  overflow-y: auto;
  overscroll-behavior-y: contain;
  min-height: 0;
  /* 显式 minmax(0, 1fr) 而不是隐式 auto 轨道：
     auto 轨道按 min-content 撑开，副标题 nowrap 时 min-content 等于整句宽度，
     长副标题会把整行顶出卡片（实测 360 宽卡片里行宽涨到 367，落在卡片外）。 */
  grid-template-columns: minmax(0, 1fr);
  /* 行高用**内容高**（auto），不要 minmax(0, 1fr)：
     1fr 会把 8 行强行等分到卡片可用高度里，横屏卡片只有 420px 高时
     每行被压到 ~33px（小于行视觉高度 46px）→ 行与行重叠、末行被切半。
     实测截图：横屏行列表挤成一团。内容超高时由本容器的 overflow-y 滚动承担。 */
  grid-auto-rows: auto;
  min-width: 0;
  gap: 2px;
  margin-top: 10px;
  /* 最后一行不得被切半（规格 9）：滚到底时整行完整可见。 */
  padding-bottom: 4px;
  scroll-padding-bottom: 4px;
}
[data-dsh-composer-sheet-rows]:empty {
  margin-top: 0;
}
[data-dsh-composer-sheet-row] {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  /* flex 子项默认 min-width:auto，长副标题会把行撑破容器；显式清零。 */
  min-width: 0;
  max-width: 100%;
  min-height: 46px;
  /* 行内左 padding >= 16px：10px 时真机上图标贴边被切。 */
  padding: 6px 16px;
  border: 0;
  border-radius: var(--dsw-radius-md, 12px);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: start;
  cursor: pointer;
}
[data-dsh-composer-sheet-row]:active {
  background: var(--dsw-alias-bg-layer-2, rgba(128, 128, 128, 0.16));
}
[data-dsh-composer-sheet-row-icon] {
  flex: none;
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  color: var(--dsw-alias-label-secondary, inherit);
}
[data-dsh-composer-sheet-row-icon] svg {
  width: 18px;
  height: 18px;
}
[data-dsh-composer-sheet-row-text] {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  /* 真正裁掉溢出：子项 min-width:0 只允许收缩，父层还得有 overflow 才切。
     没有这一行，nowrap 文本仍会画出容器外（实测副标题落到卡片右边）。 */
  overflow: hidden;
}
[data-dsh-composer-sheet-row-title] {
  font-size: 14px;
  line-height: 18px;
  /* 标题自动换行而不是截断：窄屏不丢字，长词也能断开。 */
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
/* 行副标题：**两种形态都显示**（规格取消横屏隐藏）。 */
[data-dsh-composer-sheet-row-sub] {
  font-size: 12px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, inherit);
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

/* 入场：遮罩淡入 + 卡片从视口底边之下飞入（200ms，无回弹）。 */
@keyframes dsh-composer-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dsh-composer-backdrop-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
/* 起点 translateY(100vh)：卡片整体在视口底外，与「+」位置无关。 */
@keyframes dsh-composer-card-in {
  from { transform: translateY(100vh); }
  to { transform: translateY(0); }
}
@keyframes dsh-composer-card-out {
  from { transform: translateY(0); }
  to { transform: translateY(100vh); }
}
/* 收场：由脚本挂 [data-dsh-composer-sheet-leaving]，动画结束后才真正 remove。
   收场期间遮罩必须继续接住事件（否则点击会穿透到背后页面），所以不改 pointer-events。 */
[data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] {
  animation: dsh-composer-backdrop-out 160ms cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
}
[data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] > [data-dsh-composer-sheet-panel] {
  animation: dsh-composer-card-out 160ms cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
}
/* 减少动态：横竖屏（同一形态）都直接切，不做位移也不做淡入淡出。

   **必须放在文件末尾**：入场/收场那几条 animation 在上面，同优先级下后写的胜；
   放前面会被它们盖掉（实测踩过：reduced-motion 写在前面时卡片照旧播 200ms）。
   这里选择器与上面那几条逐条对应，含 [data-dsh-composer-sheet-leaving] 变体。 */
@media (prefers-reduced-motion: reduce) {
  [data-dsh-composer-sheet-backdrop],
  [data-dsh-composer-sheet-panel],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] > [data-dsh-composer-sheet-panel] {
    animation: none;
    transition: none;
  }
}
`