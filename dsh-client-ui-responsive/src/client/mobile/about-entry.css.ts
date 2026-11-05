/**
 * 「关于」入口与页面的样式。
 *
 * 单独一张表而不是塞进 MOBILE_SETTINGS_CSS：那张表的门禁要求「颜色值必须取自 --dsw-*」
 * （深色主题继承），本组件是自有装饰，放这里不干扰设置分层的判据。
 */
export const ABOUT_ENTRY_CSS: string = `
/* 入口：占住上游「当前版本」那一行的位置，左图标 + 标题，与设置行同一套行高。 */
html[data-dsh-mobile-form] .dsh-about-entry {
  display: flex;
  align-items: center;
  gap: 10px;
  box-sizing: border-box;
  width: 100%;
  padding: 16px 0;
  border: 0;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 14px;
  line-height: 22px;
  text-align: left;
  cursor: pointer;
}

/* 「关于」页面：品牌区居中，下面是两条链接。 */
html[data-dsh-mobile-form] .dsh-about-page {
  display: flex;
  flex-direction: column;
  padding: 8px 0 16px;
}

html[data-dsh-mobile-form] .dsh-about-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 20px 0 16px;
}

html[data-dsh-mobile-form] .dsh-about-logo {
  display: block;
  width: 148px;
  height: 148px;
  border-radius: 34px;
  object-fit: contain;
}

html[data-dsh-mobile-form] .dsh-about-name {
  margin-top: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

html[data-dsh-mobile-form] /* 关于页里不再出现任何「关于」字样：图标 + 名称已经承担标题。
   两处都收，因为哪一处是「第二个关于」取决于构建：
   ① 移动层自己加的标题条（data-dsh-settings-bar-title）；
   ② 上游内容列的表头行（可能自己也渲染分区名）。
   标记挂在设置容器上，移动层重建标题条也不会失效。 */
html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-about-active] [data-dsh-settings-bar-title] {
  display: none;
}

html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-about-active] > div:last-child > div:first-child {
  display: none;
}

.dsh-about-version {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}

html[data-dsh-mobile-form] .dsh-about-engine {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* 链接行 = 上游通用设置的行骨架（同一套 .dsh-gs-* 结构，值取自 general-settings.css.ts）：
   display:flex / space-between / gap 24 / padding 16 0 / 0.5px 分隔线 / 14-20 标题 / 12-18 说明。 */
html[data-dsh-mobile-form] [data-plugin="android-about"] .dsh-gs-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  width: 100%;
  padding: 16px 0;
  border: 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
  background: transparent;
  color: var(--dsw-alias-label-primary);
  font: inherit;
  text-align: left;
  cursor: pointer;
}

html[data-dsh-mobile-form] [data-plugin="android-about"] .dsh-gs-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

html[data-dsh-mobile-form] [data-plugin="android-about"] .dsh-gs-title {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

html[data-dsh-mobile-form] [data-plugin="android-about"] .dsh-gs-desc {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

html[data-dsh-mobile-form] [data-plugin="android-about"] .dsh-gs-control {
  display: flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
}

/* 列表首行不留上边线，与上游列表一致。 */
html[data-dsh-mobile-form] [data-dsh-about-list] {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
`
