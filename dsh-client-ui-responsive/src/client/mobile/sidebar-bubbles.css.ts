/** Narrow navigation only; native headers keep their measured boxes and React ownership. */
export const SIDEBAR_BUBBLES_CSS = `
@media (max-width: 1100px) {
  [data-dsh-bubble-panel] [data-dsh-bubble-native] {
    visibility: hidden !important; min-height: 48px;
  }
  [data-dsh-bubble-panel] [data-dsh-bubble-nav] { box-sizing: border-box; pointer-events: auto; }
  [data-dsh-bubble-panel] .dsh-bubble-header {
    position: absolute; left: 0; right: 0; z-index: 90; height: 48px;
    display: flex; align-items: center; gap: 2px; padding: 2px 8px;
    background: var(--dsw-specific-sidebar-fill); color: var(--dsw-alias-label-primary);
    border-bottom: 1px solid var(--dsw-alias-border-l2);
  }
  /* 0.14.9：顶栏随内容一起开合。收起目标位移与 dock 子元素同源
     （translateX(var(--dsh-sidebar-width))），visibility 延迟到滑出后再隐藏；展开态
     立即可见。拖动手势期间内联位移接管、过渡由 mobile-form.css.ts 的
     data-dsh-drawer-dragging 关掉，松手后从手指位置平滑收敛。 */
  [data-dsh-bubble-panel] > [data-dsh-bubble-nav].dsh-bubble-header {
    transform: translateX(var(--dsh-sidebar-width));
    visibility: hidden;
    transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out),
                visibility 0s linear var(--ds-transition-duration-slow);
  }
  [data-dsh-bubble-panel][data-sidebar-right-open] > [data-dsh-bubble-nav].dsh-bubble-header {
    transform: none;
    visibility: visible;
    transition: transform var(--ds-transition-duration-slow) var(--ds-ease-in-out);
  }
  [data-dsh-bubble-panel] .dsh-bubble-heading { min-width: 0; flex: 1; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; font-size: 14px; }
  [data-dsh-bubble-panel] .dsh-bubble-heading [data-dockkit-tab-title] { max-width: 100%; }
  [data-dsh-bubble-panel] .dsh-bubble-control,
  [data-dsh-bubble-panel] .dsh-bubble-close {
    flex: none; display: inline-flex; align-items: center; justify-content: center;
    width: 44px; height: 44px; border: 0; border-radius: 999px;
    padding: 10px; color: var(--dsw-alias-label-secondary); background: transparent;
    font: inherit; cursor: pointer; -webkit-tap-highlight-color: transparent;
  }
  [data-dsh-bubble-panel] .dsh-bubble-control svg,
  [data-dsh-bubble-panel] .dsh-bubble-close svg { width: 18px; height: 18px; flex: none; }
  [data-dsh-bubble-panel] .dsh-bubble-control:disabled { opacity: .4; cursor: default; }
  [data-dsh-bubble-panel] .dsh-bubble-control:hover,
  [data-dsh-bubble-panel] .dsh-bubble-close:hover { background: var(--dsw-alias-interactive-bg-hover); }
  [data-dsh-bubble-panel] [data-dsh-sidebar-bubbles-toggle][aria-expanded='true'] {
    background: var(--dsw-alias-interactive-bg-hover); color: var(--dsw-alias-label-primary);
  }
  [data-dsh-bubble-panel] .dsh-bubble-mask { position: absolute; inset: 0; z-index: 75; background: transparent; }
  [data-dsh-bubble-panel] {
    --dsh-bubble-pill-bg: #ECECEC;
    --dsh-bubble-pill-selected: #D2D2D2;
    --dsh-bubble-pill-text: #666666;
    --dsh-bubble-pill-selected-text: #181818;
    --dsh-bubble-pill-indicator: #242424;
    --dsh-bubble-pill-secondary: #777777;
  }
  body[data-ds-dark-theme] [data-dsh-bubble-panel] {
    --dsh-bubble-pill-bg: #2C2C2C;
    --dsh-bubble-pill-selected: #484848;
    --dsh-bubble-pill-text: #C1C1C1;
    --dsh-bubble-pill-selected-text: #FFFFFF;
    --dsh-bubble-pill-indicator: #F3F3F3;
    --dsh-bubble-pill-secondary: #A8A8A8;
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover {
    position: absolute; z-index: 85; overflow-x: hidden; overflow-y: auto;
    padding: 5px 0; scroll-padding: 8px; overscroll-behavior: contain;
    touch-action: pan-y; -webkit-overflow-scrolling: touch;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    border: 0; border-radius: 0; color: var(--dsh-bubble-pill-text);
    background: transparent; box-shadow: none;
    transition: opacity 150ms ease, visibility 150ms;
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-state='closed'] { opacity: 0; visibility: hidden; pointer-events: none; }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-state='open'] { opacity: 1; visibility: visible; }
  [data-dsh-bubble-panel] .dsh-bubble-list {
    list-style: none; display: flex; flex-direction: column; gap: 7px;
    padding: 0; margin: 0; min-width: 0;
  }
  [data-dsh-bubble-panel] .dsh-bubble-row {
    position: relative; display: flex; align-items: center; width: 100%; min-width: 0; height: 46px; min-height: 46px; box-sizing: border-box;
    border-radius: 999px; background: var(--dsh-bubble-pill-bg);
    color: var(--dsh-bubble-pill-text); border: 0;
    transition: height 160ms ease, min-height 160ms ease, opacity 150ms ease, background-color 150ms ease, color 150ms ease;
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-state='closed'] .dsh-bubble-row { opacity: 0; }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-selected] {
    background: var(--dsh-bubble-pill-selected); color: var(--dsh-bubble-pill-selected-text);
  }
  [data-dsh-bubble-panel] .dsh-bubble-select {
    display: flex; align-items: center; gap: 9px; min-width: 0; width: 100%; flex: 1;
    min-height: 44px; padding: 1px 8px 1px 12px; border: 0; border-radius: inherit;
    background: transparent; color: inherit; font: inherit; text-align: start; cursor: pointer;
    user-select: none; -webkit-user-select: none; -webkit-touch-callout: none;
    touch-action: pan-y; -webkit-tap-highlight-color: transparent;
  }
  [data-dsh-bubble-panel] .dsh-bubble-select::before {
    content: ''; display: block; flex: none; width: 3px; height: 22px; border-radius: 3px;
    background: transparent;
  }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-selected] .dsh-bubble-select::before { background: var(--dsh-bubble-pill-indicator); }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-selected] .dsh-bubble-label { font-weight: 600; }
  [data-dsh-bubble-panel] .dsh-bubble-icon { width: 18px; height: 18px; flex: none; color: var(--dsh-bubble-pill-secondary); }
  [data-dsh-bubble-panel] .dsh-bubble-label {
    display: block; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    font-size: 14px; line-height: 1.4;
  }
  [data-dsh-bubble-panel] .dsh-bubble-focus-label { flex: none; font-size: 10px; color: var(--dsh-bubble-pill-selected-text); }
  [data-dsh-bubble-panel] .dsh-bubble-label > span { max-width: 100%; }
  [data-dsh-bubble-panel] .dsh-bubble-close { width: 44px; height: 44px; padding: 13px; }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-group-start] { margin-top: 0; }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-drop='before']::after,
  [data-dsh-bubble-panel] .dsh-bubble-row[data-drop='after']::after {
    content: ''; position: absolute; left: 14px; right: 14px; height: 2px;
    background: var(--dsh-bubble-pill-secondary); border-radius: 2px; pointer-events: none;
  }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-drop='before']::after { top: -5px; }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-drop='after']::after { bottom: -5px; }
  [data-dsh-bubble-panel] .dsh-bubble-row[data-dragging] {
    z-index: 1; pointer-events: none; opacity: .9; transition: none; background: var(--dsh-bubble-pill-selected);
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-drag-out] .dsh-bubble-row:not([data-dragging]) {
    height: 24px; min-height: 24px; overflow: hidden; opacity: .55;
    background: var(--dsh-bubble-pill-bg);
    transition: height 160ms ease, min-height 160ms ease, opacity 150ms ease, background-color 150ms ease;
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-drag-out] .dsh-bubble-row[data-selected]:not([data-dragging]) {
    background: var(--dsh-bubble-pill-selected); color: var(--dsh-bubble-pill-selected-text);
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-drag-out] .dsh-bubble-row:not([data-dragging]) .dsh-bubble-select {
    min-height: 24px; padding-block: 0;
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-drag-out] .dsh-bubble-row:not([data-dragging]) .dsh-bubble-close {
    opacity: 0; pointer-events: none;
  }
  [data-dsh-bubble-panel] .dsh-bubble-actions {
    display: flex; flex-wrap: nowrap; align-items: center; gap: 8px; border: 0; margin-top: 8px; padding: 7px 0 0;
  }
  [data-dsh-bubble-panel] .dsh-bubble-actions .dsh-bubble-control {
    width: auto; min-width: 44px; gap: 6px; padding: 8px 12px;
    border-radius: 999px; background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-text);
  }
  [data-dsh-bubble-panel] .dsh-bubble-actions .dsh-bubble-control:hover { background: var(--dsh-bubble-pill-selected); }
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-split],
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-float] {
    appearance: none; -webkit-appearance: none;
    flex: 1 1 0; width: auto; min-width: 0; height: 40px; min-height: 40px;
    margin: 0; padding: 0 18px; border: 1px solid transparent;
    border-radius: 999px; background: var(--dsh-bubble-pill-bg); color: var(--dsh-bubble-pill-text);
    font: inherit; font-size: 14px; line-height: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
    box-shadow: none;
  }
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-split]:active,
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-float]:active {
    background: var(--dsh-bubble-pill-selected); color: var(--dsh-bubble-pill-selected-text);
  }
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-split]:hover,
  [data-dsh-bubble-panel] .dsh-bubble-actions [data-dsh-workspace-float]:hover {
    background: var(--dsh-bubble-pill-selected);
  }
  [data-dsh-bubble-panel] .dsh-bubble-popover[data-drag-out] .dsh-bubble-row {
    transform: none;
  }
  [data-dsh-bubble-panel] [data-dsh-bubble-nav] button:focus-visible {
    outline: 2px solid var(--dsh-bubble-pill-secondary); outline-offset: 2px;
  }
  [data-dsh-bubble-panel] .dsh-bubble-status { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }
}
@media (prefers-reduced-motion: reduce) {
  [data-dsh-bubble-panel] .dsh-bubble-popover,
  [data-dsh-bubble-panel] .dsh-bubble-row,
  [data-dsh-bubble-panel] > [data-dsh-bubble-nav].dsh-bubble-header { transition: none !important; }
}
`
