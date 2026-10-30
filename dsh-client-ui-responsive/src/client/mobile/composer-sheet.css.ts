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
}
[data-dsh-composer-sheet-panel] {
  box-sizing: border-box;
  width: 100%;
  max-height: 82vh;
  overflow-y: auto;
  padding: 12px 12px calc(12px + env(safe-area-inset-bottom, 0px));
  /* 面板自己的 overflow-y 在纵向滚到端点后不把滚动交给背后那一页。 */
  overscroll-behavior-y: contain;
  border-radius: 18px 18px 0 0;
  border-top: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
  background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
  color: var(--dsw-alias-label-primary, inherit);
  font: var(--dsw-font-markdown-base, inherit);
  box-shadow: 0 -8px 32px rgba(0, 0, 0, 0.3);
}
/* 第一排：三块等宽瓦片。 */
[data-dsh-composer-sheet-tiles] {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 10px;
}
[data-dsh-composer-sheet-tile] {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  height: 96px;
  padding: 0;
  border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
  border-radius: 18px;
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
  line-height: 1;
  color: var(--dsw-alias-label-secondary, inherit);
}
/* 第二段：上游「+」菜单项的映射行（图标 + 标题 + 副标题）。 */
[data-dsh-composer-sheet-rows] {
  display: grid;
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
  min-height: 46px;
  padding: 6px 10px;
  border: 0;
  border-radius: 12px;
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
}
[data-dsh-composer-sheet-row-title] {
  font-size: 14px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
[data-dsh-composer-sheet-row-sub] {
  font-size: 12px;
  line-height: 15px;
  color: var(--dsw-alias-label-secondary, inherit);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 横屏 / 桌面形态：不画全屏遮罩，面板变成锚在「+」上的原生卡片。
   判据与 composer-sheet.ts 的 ANCHORED_MEDIA 逐字对应；改一处必须改两处。
   几何（位置 / 宽度 / 最大高度）由脚本内联写入并带 !important，这里只画外观。
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
  }
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored] > [data-dsh-composer-sheet-panel] {
    pointer-events: auto;
    box-sizing: border-box;
    overflow-y: auto;
    padding: 10px;
    /* CSS 层的兜底夹取：脚本按实际 left 算宽度，这里再按视口压一道，
       两者互为保险（脚本是主判据，这条防内联值在极端尺寸下溢出）。 */
    max-width: calc(100vw - 24px);
    border: 0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.35));
    /* 四角都圆（与竖屏贴底只圆上方两角不同）。 */
    border-radius: 18px;
    background: var(--dsw-alias-bg-layer-1, var(--dsw-alias-bg-base));
    color: var(--dsw-alias-label-primary, inherit);
    font: var(--dsw-font-markdown-base, inherit);
    /* 阴影方向跟着展开方向走：向上展开时向上投，向下展开时向下投。 */
    box-shadow: 0 -6px 28px rgba(0, 0, 0, 0.32), 0 2px 10px rgba(0, 0, 0, 0.18);
    transform-origin: bottom left;
    animation: dsh-composer-card-in 120ms ease-out;
  }
  /* 向下展开时阴影翻到下方，视觉上才「从 + 底下长出来」。 */
  [data-dsh-composer-sheet-backdrop][data-dsh-composer-sheet-anchored]
    > [data-dsh-composer-sheet-panel][data-dsh-composer-sheet-dir='down'] {
    box-shadow: 0 6px 28px rgba(0, 0, 0, 0.32), 0 2px 10px rgba(0, 0, 0, 0.18);
    transform-origin: top left;
  }
  @keyframes dsh-composer-card-in {
    from { transform: scale(0.96); opacity: 0; }
    to { transform: scale(1); opacity: 1; }
  }
}
`
