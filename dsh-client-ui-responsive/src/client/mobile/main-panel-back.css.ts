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
 * - 页头 28px 上边距收掉，标题落在安全区下沿 —— 走 `--plugin-page-top-inset` 这个上游
 *   自己的调节点，**不碰 header 的 padding 属性**（页头的 sticky 测量依赖它，见
 *   tests/main-panel-back.spec.ts 的 D 组判据）。
 *
 * 作用面：收上边距只落在 `[data-dsh-main-panel-more]`（「更多」子视图）。主列表页没有
 * 返回键，它的页头与 sticky 测量保持原样 —— 用户第二轮反馈正是「删了返回就卡住」。
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
    flex: 1 1 auto;
    min-width: 0;
  }

  /* 页头 28px 上边距收掉：只改上游自己的变量，不改 padding 属性。 */
  html[data-dsh-mobile-form] [data-plugin-panel][data-dsh-main-panel-more] {
    --plugin-page-top-inset: 0px;
  }

  /* 注入的返回键：保留 DOM（back-stack 的闭包），不画脸。 */
  html[data-dsh-mobile-form] [data-dsh-main-panel-back] {
    display: none !important;
  }

  /* 主面板占屏时，左上角不是抽屉开关。判据由 main-panel-back.ts 写在 frame 上，
     且只在「更多」这一屏写（那一屏有自己的返回控件）。 */
  html[data-dsh-mobile-form] [data-dsh-frame][data-dsh-main-panel-open] [data-sidebar-opener] {
    display: none !important;
  }
}
`
