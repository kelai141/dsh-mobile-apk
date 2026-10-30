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
`
