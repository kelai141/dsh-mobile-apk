/** 输入行「+」底部 sheet：三块并排瓦片 + 自动映射上游「+」菜单的行。 */
export const COMPOSER_SHEET_CSS = `
[data-dsh-composer-sheet-backdrop] {
  position: fixed;
  inset: 0;
  z-index: 2147483100;
  background: rgba(0, 0, 0, 0.42);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  /* aria-modal=true：滚到端点不许把滚动链交给背后的页面（#1009）。 */
  overscroll-behavior: contain;
  /* 进/出动画由 keyframes 驱动；遮罩本身同步淡入，面板再各自位移。 */
  animation: dsh-composer-backdrop-in 220ms cubic-bezier(0.215, 0.61, 0.355, 1);
}
/* 竖屏：面板从底部抬起 8px + 淡入（220ms，无回弹）。 */
[data-dsh-composer-sheet-panel] {
  box-sizing: border-box;
  width: 100%;
  /* 限高 + 内部滚动：列表滚、面板不动（规格：min(72vh, 100dvh - 96px)）。
     用 dvh 而不是 vh：移动端地址栏收起/展开时 vh 不跟随，会把面板顶出屏幕。
     写成一条 min() 两个参数，浏览器不认识 dvh 时整条声明失效并回落到上面的 82vh。 */
  max-height: 82vh;
  max-height: min(72vh, calc(100dvh - 96px));
  /* 面板自己**不滚**：滚的是里面的列表（规格：列表滚、面板不动）。
     面板留 overflow: hidden 只是为了裁掉圆角外的溢出，不承担滚动。 */
  overflow: hidden;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  /* 面板自己的 overflow-y 在纵向滚到端点后不把滚动交给背后那一页。 */
  overscroll-behavior-y: contain;
  border-radius: var(--dsw-radius-lg, 16px) var(--dsw-radius-lg, 16px) 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-markdown-base, inherit);
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
  animation: dsh-composer-panel-in 220ms cubic-bezier(0.215, 0.61, 0.355, 1);
}
/* 第一排：三块并排瓦片。
   横向滚动限位 + snap 是**两种形态共用**的（规格：三张卡片那排横向滚动限位），
   不是横屏专有 —— 竖屏窄屏同样会挤。

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
  /* 不超出面板宽（规格 2）：max-width 挡住溢出，min-width: 0 让容器可收缩。 */
  max-width: 100%;
  min-width: 0;
  overflow-x: auto;
  overscroll-behavior-x: contain;
  scroll-snap-type: x proximity;
  /* 滚动条隐藏但滚动可用（规格 4）。
     chrome87 只认 ::-webkit-scrollbar，scrollbar-width 是给新内核的，两条都留。 */
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
  /* 不许收缩（规格 1 要求卡片不参与 flex 伸缩）：装不下时靠滚动，而不是把卡片压窄。
     宽度按「三等分」取，装得下时正好铺满（与改造前的实测 105.33px 一致）；
     装不下时由 min-width 兜底，三块一起顶出容器 → 真滚动。
     min-width 96px 是按两行 13px 标题算的：最宽的两行标题约 4 个汉字 = 52px，
     加左右内边距 24px 与边框，96px 才不会被断成三行。 */
  flex: 0 0 auto;
  width: calc((100% - 20px) / 3);
  min-width: 96px;
  height: 96px;
  padding: 0 12px;
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
[data-dsh-composer-sheet-tile-label] {
  font-size: 13px;
  /* 行高给 1.25：两行标题需要可读的行距（原来 line-height: 1 是为单行写的）。 */
  line-height: 1.25;
  color: var(--dsw-alias-label-secondary, inherit);
  /* 标题自动换行（规格 3）：窄屏下换行，而不是省略号或被裁。
     anywhere 而不是 break-word：中文没有词边界，break-word 对连续汉字不生效。 */
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
  text-align: center;
  max-width: 100%;
}
/* 第二段：上游「+」菜单项的映射行（图标 + 标题 + 副标题）。 */
[data-dsh-composer-sheet-rows] {
  display: grid;
  /* 列表是竖屏下的**唯一滚动容器**：面板 fixed 高度不够时由它滚，
     三块瓦片留在顶部不跟着滚（规格：列表滚、面板不动）。 */
  overflow-y: auto;
  overscroll-behavior-y: contain;
  min-height: 0;
  /* 显式 minmax(0, 1fr) 而不是隐式 auto 轨道：
     auto 轨道按 min-content 撑开，而副标题是 nowrap，min-content 等于整句宽度，
     长副标题会把整行顶出卡片（实测 360 宽的卡片里行宽涨到 367，副标题右边界
     到 690，落在卡片外）。minmax(0,1fr) 让轨道可收缩到 0，超长文本由
     text-overflow: ellipsis 收尾。 */
  grid-template-columns: minmax(0, 1fr);
  /* 行高的隐式轨道同样要可收缩：不给 minmax(0,1fr) 时，行按内容高度排，
     长标题换行后行高会把面板撑高（横屏卡片因此顶出视口）。 */
  grid-auto-rows: minmax(0, 1fr);
  min-width: 0;
  gap: 2px;
  margin-top: 10px;
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
  /* 行内左 padding >= 16px：真机上 10px 时图标贴边被切（规格）。 */
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
  /* 标题自动换行而不是截断（规格）：窄屏不丢字，长词也能断开。 */
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}
[data-dsh-composer-sheet-row-sub] {
  font-size: 12px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, inherit);
  white-space: normal;
  overflow-wrap: anywhere;
  text-wrap: pretty;
}

/* 进/出动画：进 220ms（位移 8px + 淡入），出 160ms（反向）。
   无回弹：只用单调缓出曲线，不出现 overshoot。 */
@keyframes dsh-composer-backdrop-in {
  from { opacity: 0; }
  to { opacity: 1; }
}
@keyframes dsh-composer-backdrop-out {
  from { opacity: 1; }
  to { opacity: 0; }
}
@keyframes dsh-composer-panel-in {
  from { transform: translateY(8px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}
@keyframes dsh-composer-panel-out {
  from { transform: translateY(0); opacity: 1; }
  to { transform: translateY(8px); opacity: 0; }
}
/* 收场：由脚本挂 [data-dsh-composer-sheet-leaving]，动画结束后才真正 remove。
   收场期间遮罩必须继续接住事件（否则点击会穿透到背后页面），所以只关掉新交互、
   不改 pointer-events。 */
[data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] {
  animation: dsh-composer-backdrop-out 160ms cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
}
[data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] > [data-dsh-composer-sheet-panel] {
  animation: dsh-composer-panel-out 160ms cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
}
/* 减少动态（竖屏）：直接切换，不播放任何位移与淡入淡出。
   **本块不覆盖横屏卡片** —— 横屏那条 animation 写在后面的媒体查询里，
   选择器也更具体（多一个 [data-dsh-composer-sheet-anchored]），同优先级下
   后者会盖掉这里的 animation: none。横屏的 reduced-motion 在文件末尾单独写。 */
@media (prefers-reduced-motion: reduce) {
  [data-dsh-composer-sheet-backdrop],
  [data-dsh-composer-sheet-panel],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-leaving] > [data-dsh-composer-sheet-panel] {
    animation: none;
  }
}

/* 横屏 / 桌面形态：不画全屏遮罩，面板变成锚在「+」上的原生卡片。
   判据与 composer-sheet.ts 的 ANCHORED_MEDIA 逐字对应；改一处必须改两处。
   几何（位置 / 宽度 / 最大高度 / 动画原点）由脚本内联写入并带 !important，这里只画外观。
   竖屏手机不命中本段，仍是上面的贴底 sheet。 */
@media (orientation: landscape) and (max-height: 500px), (min-width: 768px) {
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] {
    /* 保持铺满全屏、保持接收事件，只是不画任何东西：
       点外部关闭要有一个真的能接住点击的层。若用 pointer-events: none，
       点击会直接落到下面的页面 / iframe / ShadowRoot 上，panel.contains(target)
       永远看不到它，卡片就关不掉。 */
    position: fixed;
    inset: 0;
    background: transparent;
    display: block;
    pointer-events: auto;
    /* 遮罩全透明，淡入淡出没有可见意义，反而会拖慢卡片的出现。 */
    animation: none;
  }
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] > [data-dsh-composer-sheet-panel] {
    pointer-events: auto;
    box-sizing: border-box;
    /* 卡片同样「面板不滚、列表滚」：卡片本身是固定几何，滚动交给列表。 */
    overflow: hidden;
    display: flex;
    flex-direction: column;
    min-height: 0;
    padding: 10px;
    /* CSS 层兜底夹取：脚本按实际 left 算宽度，这里再按视口压一道，
       两者互为保险（脚本是主判据，这条防内联值在极端尺寸下溢出）。 */
    max-width: calc(100vw - 24px);
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
    /* 四角都圆（与竖屏贴底只圆上方两角不同）。 */
    border-radius: var(--dsw-radius-lg, 16px);
    background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
    color: var(--dsw-alias-label-primary, inherit);
    font: var(--dsw-font-markdown-base, inherit);
    /* 阴影方向跟着展开方向走：向上展开时向上投，向下展开时向下投。 */
    box-shadow: 0 -6px 28px rgba(0, 0, 0, 0.32), 0 2px 10px rgba(0, 0, 0, 0.18);
    /* 动画原点由脚本按「+」的实测中心写入（transform-origin），这里不写死百分比：
       卡片宽度与「+」位置都随视口变化，写死的原点在真机上对不上。 */
    animation: dsh-composer-card-in 200ms cubic-bezier(0.215, 0.61, 0.355, 1);
  }
  /* 向下展开时阴影翻到下方，视觉上才「从 + 底下长出来」。 */
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored]
    > [data-dsh-composer-sheet-panel][data-dsh-composer-sheet-dir='down'] {
    box-shadow: 0 6px 28px rgba(0, 0, 0, 0.32), 0 2px 10px rgba(0, 0, 0, 0.18);
  }
  /* 收场：卡片缩回「+」的方向（scale 0.96 + 下移 4px + 淡出，160ms）。 */
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored][data-dsh-composer-sheet-leaving]
    > [data-dsh-composer-sheet-panel] {
    animation: dsh-composer-card-out 160ms cubic-bezier(0.215, 0.61, 0.355, 1) forwards;
  }
  /* 卡片内只放图标、不放文字说明（规格）：横屏隐藏瓦片标签与行副标题。 */
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] [data-dsh-composer-sheet-tile-label],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] [data-dsh-composer-sheet-row-sub] {
    display: none;
  }
  /* 卡片内的三块瓦片：横向限位 / snap / flex 全在基础段（两形态共用），
     这里只改宽度分配 —— 卡片里没有文字标签，按固定宽度排即可，不必三等分。 */
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] [data-dsh-composer-sheet-tile] {
    width: 96px;
    height: 72px;
  }
  @keyframes dsh-composer-card-in {
    from { transform: scale(0.96) translateY(4px); opacity: 0; }
    to { transform: scale(1) translateY(0); opacity: 1; }
  }
  @keyframes dsh-composer-card-out {
    from { transform: scale(1) translateY(0); opacity: 1; }
    to { transform: scale(0.96) translateY(4px); opacity: 0; }
  }
}
/* 减少动态（横屏卡片）：直接切，不做缩放也不做位移。

   **必须放在横屏媒体查询之后、且带 [data-dsh-composer-sheet-anchored]**：
   - 放前面会被上面那条更具体的 animation 覆盖（同优先级下后者胜）；
   - 选择器少一个属性选择器就不够具体，盖不住。
   实测教训：一开始只在竖屏那段写了 reduced-motion，横屏卡片照旧播 200ms。 */
@media (prefers-reduced-motion: reduce) {
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] > [data-dsh-composer-sheet-panel],
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored][data-dsh-composer-sheet-leaving]
    > [data-dsh-composer-sheet-panel] {
    animation: none;
  }
}
`
