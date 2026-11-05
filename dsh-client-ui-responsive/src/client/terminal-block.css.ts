/**
 * 手机端终端卡片（上游 ui-primitives TerminalBlock）排版（社区截图缺陷）。
 *
 * 现象：展开的「运行命令」卡片，长命令挤在窄盒子里看不全，右侧留下大片空白，输出区
 * 还会横向滚动；旧产物上这条命令还带 text-overflow: ellipsis，表现为约 12 个字符后就
 * 出现省略号。
 *
 * 事实（以本仓安装的 @deepseek-ai/dsh-client-ui-primitives 的产物为准）：
 *   1. 命令行：TerminalBlock.module.css 的 `.command`（:115-118）只做两件事——把
 *      `--dsl-terminal-command-whitespace` 读进 `--dsl-command-whitespace`（回落 pre），
 *      以及设 color。它自身**不再**声明 white-space / overflow: hidden /
 *      text-overflow: ellipsis。真正的 white-space 声明在 CommandText.module.css 的
 *      `.text`（:5，同时带 overflow-x: auto）；CommandText 把宿主传进来的 `.command` 类
 *      （lib/index.js:9590）与自己的 `.text` 类（lib/index.js:9455）clsx 到**同一个
 *      span** 上，变量链在同一元素内闭合。即：重绑该变量在当前产物里确有消费者、并非
 *      空操作，但这条链要穿过两个哈希类名，上游改类名或改结构时本插件无从察觉。
 *   2. 输出区：`.line`（TerminalBlock.module.css:179-183）确实消费
 *      `--dsl-terminal-line-whitespace`，重绑为 pre-wrap 即按宽折行、不再横滑。
 *   3. 右侧那片空白：header 是 flex 行，状态胶囊与复制按钮都是 flex: 0 0 auto 不可
 *      收缩，把 .prompt（flex: 1 1 0%）压在剩余宽度里；命令在这个窄盒子里放不下，右边
 *      剩下的就是空白。故**只重绑 pre-wrap 不够**——文字仍会在窄盒子里折行，右侧空白
 *      照旧；B 段把 header 换行、prompt 独占整行，才把命令盒撑宽。
 *
 * 修法（全部限定在手机形态；横屏与桌面不命中，上游行为零改动）：
 *   A. 命令行折行由本插件自己声明：在 command 结构选择器上直接写 white-space: pre-wrap，
 *      不再只依赖「.command 读变量、.text 用变量」这条穿过两个哈希类名的链（上游改类名
 *      或改结构时它只会静默退回 pre，命令又不折行，构建与类型检查都发现不了）。
 *      同时保留 `--dsl-terminal-command-whitespace` 的重绑作冗余：它在当前产物里确有
 *      消费者（同一元素上的 .text），两处任一在场都能折行。
 *      `--dsl-terminal-line-whitespace` 的重绑有效（.line 真的读它），保留。这两个变量
 *      在 .block 上没有声明、只在上述规则使用，属普通自定义属性且可继承，所以打在卡片
 *      元素 [data-terminal] 上即可对全部后代生效，无需触碰产物里哈希过的类名。
 *      （B/C 两段的像素量测取自带 ellipsis 的旧产物，只作定性依据；它们论证的是
 *      header 换行与 banner 限高的机制，该机制在当前产物中仍然存在。）
 *   B. header 允许换行（flex-wrap），状态胶囊与复制按钮落到第二行；prompt 取 100%
 *      整行，命令撑满该行剩余宽度。换行后必须 justify-content: flex-end，否则第二行
 *      的胶囊与复制按钮会贴到**左边**，把右侧空白原样保留。
 *   C. 解除 banner 的 max-height: 150px。该上限是给**单行 pre** 场景的（写死 150px 后
 *      多行命令在 banner 内部滚），改 pre-wrap 后多行命令只会在 150px 里内滚、命令仍
 *      看不全。实测 10 行命令：上限在场时 clientHeight 168 / scrollHeight 558；解除后
 *      588/588，内容完整、卡高 632px，且不再出现嵌套纵向滚动容器。
 *
 * 选择器只用稳定属性与结构关系（data-terminal / :first-child），一律不用 CSS Modules
 * 哈希类名——类名每次构建都会变。
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
  /* command（每个 promptLine 的最后一个子元素）：撑满该行剩余宽度，并自己声明折行——
     不依赖 --dsl-terminal-command-whitespace -> --dsl-command-whitespace 那条要穿过
     两个哈希类名的变量链（上游改名即静默退回 pre）。 */
  html[data-dsh-mobile-form] [data-terminal] > :first-child > :first-child > * > :last-child {
    flex: 1 1 auto;
    white-space: pre-wrap;
  }
}
`
