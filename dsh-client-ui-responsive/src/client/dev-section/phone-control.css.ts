/**
 * Styles owned by the phone-control section.
 *
 * The section follows the General Settings row rhythm: flat background, full-width rows, a hairline
 * divider, title on the left and state or chevron on the right. Cards, pills for ordinary actions and
 * multicolumn button walls stay out of the primary surface; secondary views keep the same rows.
 */
export const PHONE_CONTROL_CSS: string = `
[data-plugin='dev-phone-control'] {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-screen {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-screen-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment {
  box-sizing: border-box;
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  width: 100%;
  padding: 2px;
  border: 0.5px solid var(--dsw-alias-border-l3);
  border-radius: 8px;
  background: var(--dsw-alias-bg-layer-2);
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button {
  min-width: 0;
  min-height: 36px;
  padding: 0 6px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 13px;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button[aria-checked='true'] {
  background: var(--dsw-alias-interactive-bg-hover);
  color: var(--dsw-alias-label-primary);
  box-shadow: inset 0 0 0 0.5px var(--dsw-alias-border-l3);
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

[data-plugin='dev-phone-control'] .dsh-pc-segment > button:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-row-main:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-row:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-inline:focus-visible,
[data-plugin='dev-phone-control'] .dsh-pc-back:focus-visible {
  outline: 2px solid #4d6bfe;
  outline-offset: 2px;
}

[data-plugin='dev-phone-control'] .dsh-pc-scope-line {
  margin: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

/* 整行就是一个按钮（用户实报 C：右侧状态 + 箭头那块点不动）。
 *
 * 真因：旧结构是 div.dsh-pc-row 里放 button.dsh-pc-row-main（只装左侧文字）+ 纯展示的
 * span.dsh-pc-side（状态 + 箭头）。可点面 = 那个 button 的盒子，右半截**从来不是控件**，
 * 不是被谁挡住。所以这里把命中面收敛到整行：.dsh-pc-row 是 button，.dsh-pc-row-main 退化成
 * 只负责左侧文字的 span。样式只需保证「按钮的默认外观被抹掉、整行等高可点」。 */
button[data-plugin='dev-phone-control'] .dsh-pc-row,
[data-plugin='dev-phone-control'] .dsh-pc-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 12px;
  width: 100%;
  min-width: 0;
  padding: 16px 0;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  /* 整行的命中面必须连右侧状态/箭头一起算：它们是行内的展示子节点，不单独接事件。 */
  -webkit-tap-highlight-color: transparent;
}

[data-plugin='dev-phone-control'] .dsh-pc-row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  text-align: left;
}

[data-plugin='dev-phone-control'] .dsh-pc-text {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-side {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 8px;
  max-width: 48%;
}

[data-plugin='dev-phone-control'] .dsh-pc-state {
  min-width: 0;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  text-align: right;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-state[data-unreadable='true'] {
  color: var(--dsw-alias-state-error-primary);
}

[data-plugin='dev-phone-control'] .dsh-pc-chevron {
  flex: 0 0 auto;
  color: var(--dsw-alias-label-tertiary);
  font-size: 18px;
  line-height: 18px;
}

[data-plugin='dev-phone-control'] .dsh-pc-inline {
  flex: 0 0 auto;
  min-height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: #4d6bfe;
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  white-space: nowrap;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-inline:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

[data-plugin='dev-phone-control'] .dsh-pc-subhead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 36px;
  padding: 4px 0 8px;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-subhead > strong {
  min-width: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-back {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 2px;
  min-height: 32px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font: inherit;
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}

[data-plugin='dev-phone-control'] .dsh-pc-back > span {
  font-size: 18px;
  line-height: 18px;
}

/* 手机形态下本页眉的返回箭头让位给设置中心的顶部条（用户实报 A：一屏两个返回按钮）。
 *
 * 真因：本分区有自己的下级页，页眉于是画了「‹ 手机控制」；而设置中心的分层容器
 * （mobile/settings-nav.ts）也为每个页画一条顶部条（含它自己的返回箭头）。两层各画一个，
 * 于是「手机控制 → 无障碍通道」这一页有两个返回控件，且上面那个只回设置首页（比下面那个
 * 退得更远）—— 用户看到的是两个语义不同的返回并排。
 *
 * 修法：手机形态下**只保留顶部条那一个**，且它已被接管为「弹回本页的上一层」
 * （settings-nav 的 goBack 读 data-dsh-settings-sublayer 后点本页眉登记的那个控件）。
 * 横屏（无 data-dsh-mobile-form）不装配分层容器，本页眉箭头仍是唯一出口，故不隐藏。 */
html[data-dsh-mobile-form] [data-plugin='dev-phone-control'] .dsh-pc-back {
  display: none;
}

/* 顶部条已显示分区名时，页眉里那份标题是同一句话的第二份。留标题语义（aria）不留重复视觉。 */
html[data-dsh-mobile-form] [data-plugin='dev-phone-control'] .dsh-pc-subhead > strong {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
  border: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-actions {
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-primary {
  min-height: 40px;
  padding: 0 14px;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail-title {
  margin: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

[data-plugin='dev-phone-control'] .dsh-pc-detail:last-child {
  border-bottom: 0;
}

[data-plugin='dev-phone-control'] .dsh-pc-detail p {
  margin: 0;
  overflow-wrap: anywhere;
}

[data-plugin='dev-phone-control'] .dsh-pc-destructive {
  margin-top: 8px;
}

[data-plugin='dev-phone-control'] .dsh-pc-plain {
  gap: 0;
  padding: 0;
  border: 0;
  background: transparent;
}

@media (max-width: 380px) {
  [data-plugin='dev-phone-control'] .dsh-pc-side {
    max-width: 52%;
  }
  [data-plugin='dev-phone-control'] .dsh-pc-segment > button {
    font-size: 12px;
  }
}
`
