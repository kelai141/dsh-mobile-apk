/**
 * Row skeleton for the Android additions in 设置 → 通用设置 (语言 / 沉浸式状态栏 /
 * 左右侧栏滑动)。
 *
 * 为什么自带一张表、不复用 dev-section.css.ts 的 `dsh-dev-*`：那一套是「开发者选项」的
 * 动作行（36px 描边按钮、16px 原生勾选框、13px 提示），与上游通用设置的行规不同。
 * 上游通用设置的行是「左标题 14/20 + 说明 12/18 + 右侧控件，行间 0.5px 分隔线，上下
 * 16px 内边距」（ui-settings-general 的 DeveloperToolsRow、ui-shortcuts 的
 * ShortcutReference 同规）。两种行规并排在同一张列表里，就是用户反馈的「设置页有些 UI
 * 很突兀、和别的 UI 差别很大」——同一个页面里出现两套字号/控件/分隔线。
 *
 * 本表只描述行骨架与错误回执；控件取上游 ui-primitives 的 Switch，
 * 颜色、圆角、字体全部走 --dsw-* 语义令牌，亮暗主题自动跟随，不新造任何颜色。
 *
 * 行选择器带上 `[data-plugin='android-general']`：本插件其余样式表（composer、终端卡片等）
 * 也用短类名注入到同一个文档，加根前缀才不会互相串味。
 *
 * 圆角（2026-10-23）：本分区不手绘圆角控件——开关取上游 Switch（它自带
 * `corner-shape: round`，见 ui-primitives 的 Switch.module.css）。主题在 `*`、`::before`、`::after` 上统一设了
 * `corner-shape: superellipse(1.5)`，手绘胶囊/圆点若不显式写 `corner-shape: round`，999px / 50%
 * 会被画成方圆角（同一版皮肤插件 1.0.0 在真机上就踩过：轨道发平、圆点变方块）。将来若在这里
 * 手绘圆角控件，照上游 Switch 写两处 `corner-shape: round`。
 */
export const GENERAL_SETTINGS_CSS: string = `
[data-plugin='android-general'] .dsh-gs-control button {
  min-height: 40px;
  padding: 8px 14px;
}

@media (pointer: coarse) {
  [data-plugin='android-general'] .dsh-gs-control button { min-height: 44px; }
}
[data-plugin='android-general'] {
  display: flex;
  flex-direction: column;
}

/* 一行 = 左文字列 + 右控件；与上游开关行同规（gap 24 / padding 16 0 / 0.5px 分隔线）。
   分隔线留在每一行自己的底部：本分区在列表里不是最后一项，去掉末行线会与下一项粘连
   （上游「最后一行不画线」的规则只作用于整张列表的最后一项，够不到本分区的末行）。 */
[data-plugin='android-general'] > .dsh-gs-row {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}

.dsh-gs-text {
  min-width: 0;
}

.dsh-gs-title {
  color: var(--dsw-alias-label-primary);
  font-size: 14px;
  line-height: 20px;
}

.dsh-gs-desc {
  margin-top: 4px;
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
}

/* 控件列：开关与分段控件都靠右，与上游开关行落在同一条视觉基线上。 */
.dsh-gs-control {
  display: flex;
  flex: none;
  align-items: center;
}

/* 写失败回执（S3-17）：字号与上游错误行一致，颜色走错误语义令牌。 */
.dsh-gs-alert {
  margin: 8px 0 0;
  color: var(--dsw-alias-state-error-primary);
  font-size: 12px;
  line-height: 18px;
}
`
