/**
 * 手机端终端卡片（上游 ui-primitives TerminalBlock）排版（社区截图缺陷）。
 *
 * 现象：展开的「运行命令」卡片，每条命令行约 12 个字符后被省略号截断，右侧留下大片
 * 空白，输出区还会横向滚动。
 *
 * 真因（2026-10-15 在 emulator-5562 的引擎 WebView 里对真实卡片量测，
 * 600px 视口 / 该会话卡片 520.7px 宽）：
 *   1. 省略号：`.command` 用 white-space: var(--dsl-terminal-command-whitespace, pre)
 *      + overflow: hidden + text-overflow: ellipsis。该变量只在**使用处**出现，宿主
 *      不重绑时回落到 pre（不换行），命令比盒子宽就触发省略号。实测命令内容 537px、
 *      盒子 376px，被隐藏 161px（360px 视口下盒子 136px、隐藏 401px）——省略号确实
 *      真实触发，不是渲染错觉。
 *   2. 输出区横滑：`.line` 同理用 var(--dsl-terminal-line-whitespace, pre)；
 *      360px 视口实测输出区 scrollWidth 310 > clientWidth 249，横滑 61px。
 *   3. 右侧那片空白：header 是 flex 行，状态胶囊与复制按钮都是 flex: 0 0 auto 不可
 *      收缩，把 .prompt（flex: 1 1 0%）压在剩余宽度里；命令在这个窄盒子里被 ellipsis
 *      截断，右边剩下的就是空白。故**只重绑 pre-wrap 不够**——文字仍会在窄盒子里折行，
 *      右侧空白照旧。实测：仅重绑时 prompt 占卡宽 70%，命令折成 5 行；让 header 换行、
 *      prompt 独占整行后升到 84%，命令盒由 136px 增至 174px 并完整放下。
 *
 * 修法（全部限定在手机形态；横屏与桌面不命中，上游行为零改动）：
 *   A. 重绑两个 whitespace 变量为 pre-wrap，消除省略号与输出区横滑。这两个变量在
 *      .block 上没有声明、只在 .command/.line 使用，属普通自定义属性且可继承，所以打在
 *      卡片元素 [data-terminal] 上即可对全部后代生效，无需触碰产物里哈希过的类名。
 *      上游 JobListAction.module.css 对同一变量组做过同样的事，属既定用法。
 *   B. header 允许换行（flex-wrap），状态胶囊与复制按钮落到第二行；prompt 取 100%
 *      整行，命令撑满该行剩余宽度。换行后必须 justify-content: flex-end，否则第二行
 *      的胶囊与复制按钮会贴到**左边**，把右侧空白原样保留（实测 360px 视口下按钮左移
 *      后右侧空白 224px；end 对齐后回到 14.7px，与现状一致）。
 *   C. 解除 banner 的 max-height: 150px。该上限是给**单行 pre** 场景的（写死 150px 后
 *      多行命令在 banner 内部滚），改 pre-wrap 后多行命令只会在 150px 里内滚、命令仍
 *      看不全。实测 10 行命令：上限在场时 clientHeight 168 / scrollHeight 558；解除后
 *      588/588，内容完整、卡高 632px，且不再出现嵌套纵向滚动容器。
 *
 * 选择器只用稳定属性与结构关系（data-terminal / :first-child），一律不用 CSS Modules
 * 哈希类名——类名每次构建都会变（本次产物为 _block_1fs6g_1 / _header_1fs6g_32 等）。
 */
export const TERMINAL_BLOCK_CSS: string = `
@media (max-width: 760px) {
  html[data-dsh-mobile-form] [data-terminal] {
    --dsl-terminal-command-whitespace: pre-wrap;
    --dsl-terminal-line-whitespace: pre-wrap;
  }
  /* header（卡片第一个子元素）：换行 + 解除 150px 上限；end 对齐让换行后的胶囊与复制
     按钮停在右边，而不是贴左。 */
  html[data-dsh-mobile-form] [data-terminal] > :first-child {
    flex-wrap: wrap;
    justify-content: flex-end;
    max-height: none;
  }
  /* prompt（header 第一个子元素）：独占整行，把整行宽度让给命令。 */
  html[data-dsh-mobile-form] [data-terminal] > :first-child > :first-child {
    flex: 1 1 100%;
  }
  /* command（每个 promptLine 的最后一个子元素）：撑满该行剩余宽度。 */
  html[data-dsh-mobile-form] [data-terminal] > :first-child > :first-child > * > :last-child {
    flex: 1 1 auto;
  }
}
`
