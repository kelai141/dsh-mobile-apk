/**
 * 「关于」入口与页面的样式。
 *
 * 单独一张表而不是塞进 MOBILE_SETTINGS_CSS：那张表的门禁要求「颜色值必须取自 --dsw-*」
 * （深色主题继承），本组件是自有装饰，放这里不干扰设置分层的判据。
 *
 * 形态：本表**不带** `html[data-dsh-mobile-form]` 前缀。入口按钮与关于页全是本包自己的节点，
 * 没有「上游横屏布局」需要保留；而带上前缀会让横屏 / 平板（innerWidth > 767，该标记不写）
 * 拿到零样式——入口退化成原生 button，关于页失去整页排版。同一页的 general-settings.css.ts
 * 也是不带前缀的写法，两个面必须一致。
 *
 * 收掉「第二个关于」的判据是**属性**不是结构：`data-dsh-settings-bar-title` 由移动层渲染，
 * `data-dsh-about-header` 由 about-section 挂载时认出上游表头行再打上。此前那条
 * `> div:last-child > div:first-child` 结构选择器在上游把分区根节点直接放进内容列时会连整页
 * 一起 display:none，已废弃。
 */
export const ABOUT_ENTRY_CSS: string = `
/* 入口：占住上游「当前版本」那一行的位置，左图标 + 标题，与设置行同一套行高。 */
.dsh-about-entry {
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
.dsh-about-page {
  display: flex;
  flex-direction: column;
  padding: 8px 0 16px;
}

.dsh-about-brand {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 2px;
  padding: 20px 0 16px;
}

.dsh-about-logo {
  display: block;
  width: 148px;
  height: 148px;
  border-radius: 34px;
  object-fit: contain;
}

.dsh-about-name {
  margin-top: 0;
  color: var(--dsw-alias-label-primary);
  font-size: 20px;
  line-height: 28px;
  font-weight: 600;
  letter-spacing: 0.2px;
}

/* 关于页里不再出现任何「关于」字样：图标 + 名称已经承担标题。
   两处都收，因为哪一处是「第二个关于」取决于构建：
   ① 移动层自己加的标题条（data-dsh-settings-bar-title）；
   ② 上游内容列的表头行（data-dsh-about-header，由 about-section 认出来源节点后打标）。
   标记挂在设置容器 / 来源节点上，React 重建标题条也不会失效。 */
[data-dsh-settings-dialog][data-dsh-about-active] [data-dsh-settings-bar-title] {
  display: none;
}

[data-dsh-settings-dialog][data-dsh-about-active] [data-dsh-about-header] {
  display: none;
}

.dsh-about-version {
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  line-height: 20px;
  font-variant-numeric: tabular-nums;
}

.dsh-about-engine {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  font-variant-numeric: tabular-nums;
}

/* 链接行 = 上游通用设置的行骨架（同一套 .dsh-gs-* 结构，值取自 general-settings.css.ts）：
   display:flex / space-between / gap 24 / padding 16 0 / 0.5px 分隔线 / 14-20 标题 / 12-18 说明。 */
[data-plugin="android-about"] .dsh-gs-row {
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

[data-plugin="android-about"] .dsh-gs-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

[data-plugin="android-about"] .dsh-gs-title {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

[data-plugin="android-about"] .dsh-gs-desc {
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  overflow-wrap: anywhere;
}

[data-plugin="android-about"] .dsh-gs-control {
  display: flex;
  flex: none;
  align-items: center;
  color: var(--dsw-alias-label-secondary);
}

/* 列表首行不留上边线，与上游列表一致。 */
[data-dsh-about-list] {
  border-top: 0.5px solid var(--dsw-alias-border-l2);
}
`
