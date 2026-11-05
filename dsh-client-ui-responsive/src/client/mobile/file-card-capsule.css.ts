/**
 * 交付文件卡片上的两段胶囊：另一种打开方式（占大头，内嵌带描边小块）+ 转发。
 *
 * 视觉参照：外框圆角两段切分，左段内部再包一个带描边的小圆角块，中间 1px 分隔线。
 * 克制原则——卡片本身是主体，所以无阴影、无发光；图标用 text-2 而不是 text-1。
 *
 * 配色一律走主题变量：深色下 .10 / .12 / 8% 白是规格给的绝对值；浅色主题必须有对向
 * 取值，否则 rgba(255,255,255,.10) 的白描边在浅底上等于没有。
 */
export const FILE_CARD_CAPSULE_CSS = `
[data-changed-files] {
  /* 胶囊落在卡片末尾，正常文档流里换行占一整行。 */
  flex-wrap: wrap;
}
/* 深浅两套描边/按下态：规格只给深色绝对值，浅色取镜像。 */
body:not([data-ds-dark-theme]) {
  --dsh-capsule-border: rgba(0, 0, 0, 0.10);
  --dsh-capsule-inner-border: rgba(0, 0, 0, 0.12);
  --dsh-capsule-press: rgba(0, 0, 0, 0.08);
}
body[data-ds-dark-theme] {
  --dsh-capsule-border: rgba(255, 255, 255, 0.10);
  --dsh-capsule-inner-border: rgba(255, 255, 255, 0.12);
  --dsh-capsule-press: rgba(255, 255, 255, 0.08);
}
[data-dsh-file-capsule] {
  display: inline-flex;
  align-items: stretch;
  box-sizing: border-box;
  margin: 6px 0 0;
  height: 33px;
  border: 1px solid var(--dsh-capsule-border, rgba(255, 255, 255, 0.10));
  border-radius: 11px;
  /*
   * 不能 overflow:hidden：两段的触控命中区靠 ::after 向上下各溢出 8px，
   * 一裁就只剩 33px 高，48dp 下限形同虚设。外角圆角改由首尾两段自己带，
   * 这样按下态底色也不会在圆角处漏出方角。
   */
  overflow: visible;
  background: transparent;
  /* 卡片是主体：不加阴影、不加发光。 */
  box-shadow: none;
}
/* 两段各自是独立按钮：整条胶囊不能当成一个角色，所以容器只是布局盒。 */
[data-dsh-file-capsule] > button {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  padding: 0;
  border: 0;
  background: transparent;
  /* text-2：比正文低一档，别喧宾夺主。 */
  color: var(--dsw-alias-label-secondary, inherit);
  cursor: pointer;
}
/*
 * 触控面积 >= 48dp，但**不改变视觉高度**：用透明命中区向上、向下各溢出 8px 左右。
 * 胶囊本身只有 33 高，靠伪元素补到 49，既守住无障碍下限，也不让外框变胖。
 */
[data-dsh-file-capsule] > button::after {
  content: '';
  position: absolute;
  left: 0;
  right: 0;
  top: -8px;
  bottom: -8px;
}
/* 按下态：整段 8% 白底（浅色主题取镜像）。 */
[data-dsh-file-capsule] > button:active {
  background: var(--dsh-capsule-press, rgba(255, 255, 255, 0.08));
}
/* 左段占大头；它同时承担外框左侧的圆角。 */
[data-dsh-file-capsule-external] {
  flex: 1 1 auto;
  border-top-left-radius: 10px;
  border-bottom-left-radius: 10px;
}
/* 左段内部那个带描边的小圆角块：只有图标，无文字。 */
[data-dsh-file-capsule-chip] {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  box-sizing: border-box;
  width: 40px;
  height: 26px;
  border: 1px solid var(--dsh-capsule-inner-border, rgba(255, 255, 255, 0.12));
  border-radius: 8px;
}
[data-dsh-file-capsule-chip] > svg {
  width: 16px;
  height: 16px;
  flex: none;
}
/* 右段固定 44-48，只放纸飞机，无底色；它承担外框右侧的圆角。 */
[data-dsh-file-capsule-share] {
  flex: 0 0 auto;
  width: 46px;
  border-top-right-radius: 10px;
  border-bottom-right-radius: 10px;
}
[data-dsh-file-capsule-share] > svg {
  width: 18px;
  height: 18px;
  flex: none;
}
/* 只剩转发时不要拉满整行。 */
[data-dsh-file-capsule][data-dsh-file-capsule-share-only] {
  align-self: flex-start;
}
/* 段间 1px 分隔线，颜色同外框描边。 */
[data-dsh-file-capsule-separator] {
  flex: none;
  width: 1px;
  margin: 8px 0;
  background: var(--dsh-capsule-border, rgba(255, 255, 255, 0.10));
}
`
