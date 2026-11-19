/**
 * Skin for the main-panel head on the phone form (mobile/main-panel-back.ts).
 *
 * 2026-11-14（用户，截图）：「实验性插件」这一屏，左上角只留「‹ 标题」。
 * 那一屏原来并排三样东西 —— 抽屉开关、上游 moreBack 箭头、本插件注入的「‹ 返回」。
 * 两轮反馈定下的最终形态：
 * - 抽屉开关不画（用户第一次的要求：左上角不要「打开侧边栏」）；
 * - 上游 moreBack **保留** —— 它是回插件列表的唯一可见出口。第一版把它一起藏了，
 *   用户「一直卡在这个页面」，所以这条不再隐藏；
 * - 注入的「返回会话」键只留 DOM 不画脸：`display: none` 但节点还在，
 *   back-stack.ts 的 closeMainPanel 仍能程序化点它（按钮缺席时它还有 leave() 回落）；
 * - 手机中栏已经预留 Android 安全区。全局面板无需再给已让位的抽屉开关预留一行。
 * - 插件页通过上游自己的 `--plugin-page-top-inset` 消除额外顶距，测量副本也读取同一个值。
 *
 * 行内布局：`justify-content: flex-start` 挡住 `space-between` 把标题推回中间，
 * `gap: 8px` 是 moreBack 与标题之间的距离。主列表页的 toolbar 仍然靠右，标题块
 * 吸收挤压（`flex: 1 1 auto` + `min-width: 0`）。
 *
 * 选择器键在 `data-dsh-main-panel-head`（main-panel-back.ts 打的标记），不是
 * `[data-plugin-panel] > header`：上游把主列表页的头部嵌在 `pageBody > pageBar` 里，
 * 子组合器匹配不到 —— 那条老判据 2026-11-13 在设备上恒空，是本包踩过的坑。
 */
export const MAIN_PANEL_BACK_CSS: string = `
@media (max-width: 767px) {
  html[data-dsh-mobile-form] [data-dsh-main-panel-head] {
    justify-content: flex-start;
    gap: 8px;
  }

  html[data-dsh-mobile-form] [data-dsh-main-panel-head] > div:first-of-type {
    flex: 1 1 0;
    min-width: 0;
  }

  html[data-dsh-mobile-form] [data-dsh-frame][data-dsh-main-panel-open] > [class*='centerCol'] > [data-global-panel] {
    padding-top: 0;
  }

  html[data-dsh-mobile-form] [data-dsh-frame][data-dsh-main-panel-open] [data-plugin-panel],
  html[data-dsh-mobile-form] [data-dsh-frame][data-dsh-main-panel-open] [data-plugin-bar][data-measuring][data-compact] {
    --plugin-page-top-inset: 0px;
  }

  /* 标题和设置页同款的 40px 返回键沿同一行对齐。 */
  html[data-dsh-mobile-form] [data-dsh-main-panel-head] [data-plugin-header-part='title'] {
    line-height: 40px;
  }

  /* 注入的返回键：只在「更多 / 实验性插件」那一屏兜底隐藏。
     issue #1785（用户）：插件主列表页没有任何可见返回键。真因就是这条规则曾经**无条件**：
     它来自 2026-11-14 反馈「去掉最左侧的打开侧边栏与返回，只保留自带黑色加粗标题」，
     但那次说的是「更多」那一屏 —— 上游在那屏有 moreBack。写成全局规则后，主列表页的
     唯一出口也被藏了，而列表页**没有** moreBack（它只存在于更深的子视图），于是零出口：
     注入键在 DOM 里但看不见，旁边只剩 ☰，而 ☰ 开抽屉、不返回。
     作用面收窄到 more 标记：列表页让按钮显形，就是那一屏的返回控件。 */
  html[data-dsh-mobile-form] [data-plugin-panel][data-dsh-main-panel-more] [data-dsh-main-panel-back] {
    display: none !important;
  }

  /* 列表页和「更多」页占屏时，左上角显示各自的返回控件。 */
  html[data-dsh-mobile-form] [data-dsh-frame][data-dsh-main-panel-open] [data-sidebar-opener] {
    display: none !important;
  }
}
`
