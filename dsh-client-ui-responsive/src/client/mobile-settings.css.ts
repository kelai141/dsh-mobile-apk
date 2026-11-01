/**
 * Mobile settings-panel adaptation (issue #1; 2026-09-03 rework, 2026-09-10 de-fork;
 * 2026-10-11 layering for 0.14.7-B).
 *
 * Upstream SettingsRoot draws a fixed overlay with an 800px two-column panel
 * (nav + options). On the phone form it must reflow to a single column and fill
 * the viewport (user requirement: 设置页全屏显示). 0.14.7-B additionally splits it
 * into two levels: 设置首页（分类列表）→ 二级页（可操作设置）. The level is published as
 * `data-dsh-settings-level` on the panel by mobile/settings-nav.ts; this sheet only reads it.
 *
 * The panel renders inside the sidebar subtree, whose CSS-Module class names are
 * hashed and unreachable from here — and its own markup carries no stable
 * attribute. The mobile marker therefore tags the panel
 * (`data-dsh-settings-dialog`, written from its nav/content structure) and this
 * sheet keys on that tag plus the phone-form flag: pure attribute selectors,
 * effective on old kernels too (no `:has()`).
 *
 * Contents are always mounted: switching levels only toggles `display`, so a
 * half-edited section keeps its values, its scroll position and its open rows.
 */

export const MOBILE_SETTINGS_CSS: string = `
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] {
    position: relative;
    box-sizing: border-box;
    width: 100vw;
    max-width: none;
    /* The panel is centred by its fixed overlay, so shrinking the height would
       move its header back under the status bar. Keep the full height and inset
       the content instead: border-box keeps the total box at 100vh. */
    /* ── 状态栏遮挡标题栏的根因（issue #1288 第 2 条）─────────────────────────
     * 实测排除的三条错误假说（都验证过不是它）：
     *   · 「WebView 没吃 insets」——insets 是好的。壳侧把 max(bars.top, cutout.top) 折算成
     *     CSS px 写到 --dsh-android-system-top（MainActivity.pushWebInsets），
     *     --dsh-mobile-top-inset 取它（mobile-form.css.ts）。设备实测（关闭沉浸式、
     *     状态栏 36px / density 1.5）：--dsh-android-system-top = 24px ✓。
     *   · 「行高/padding 不够」——把 inset 加到 24px 之后 bar.top 仍是 12，不是 24。
     *   · 「position:absolute 少算了一份 inset」——把顶部条还原成 absolute 后 bar.top
     *     依然是 24，判据不变红；负控当场否掉了这个假说。
     *
     * 真因：**面板被 overlay 的 align-items:center 居中**。
     * 上游 SettingsRoot 的蒙层是 position:fixed; display:flex; align-items:center;
     * justify-content:center 的居中容器。本面板在手机形态下是 height:100vh +
     * padding-top:inset；box-sizing 一旦不是 border-box（或视口高度与 100vh 有偏差，
     * 例如键盘/浏览器 UI 让可视高度略小），面板就比视口**高一点点**，居中于是把
     * 上溢量的一半顶出视口顶：实测面板 top=-12、bar.top=12、标题 top=26 —— 正好
     * 是用户截图里「标题与返回箭头只看得见下半截」。
     * 这也解释了为什么不是每一页都同样严重：溢出量随页面内容与视口高度变化。
     *
     * 修法（一条根因，改在公共容器上，不逐页打补丁）：
     *   ① 整屏面板不参与居中：align-self:flex-start + margin:0。它本来就该占满视口，
     *      「居中」对它没有任何语义，只会把溢出量分到两端。
     *   ② 面板用 box-sizing:border-box（下方已声明），100vh 含 padding，不再溢出。
     *   ③ 顶部条回到 flex 正常流（见下方 bar 规则），inset 只由面板的 padding-top 消费一次。
     * 判据：标题与返回箭头的 rect.top ≥ 状态栏底部（--dsh-mobile-top-inset 的实测值）。 */
    align-self: flex-start;
    margin: 0;
    height: 100vh;
    max-height: none;
    padding-top: var(--dsh-mobile-top-inset, 0px);
    border-radius: 0;
    flex-direction: column;
  }

  /* 顶部条：**两级共用这一套规则**（issue #1288 第 2 条）。
   *
   * 这两条（首页 absolute、二级页 relative）原来不一致，看着像「有的页切、有的页不切」，
   * 但把首页还原成 absolute 后 bar.top 仍是 24——所以它**不是**切字的成因（见面板规则里
   * 的实测记录，真因是 overlay 居中）。这里统一成正常流仍然值得：
   *   · 顶部条作为面板的第一个 flex 项、flex:none —— 永远不参与滚动，也不会被顶出视口；
   *   · inset 只由面板的 padding-top 消费一次，避免两处各算一份的隐患。
   * 判据：标题/返回箭头的 rect.top ≥ 状态栏底部（= --dsh-mobile-top-inset 的实测值）。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > [data-dsh-settings-bar] {
    position: relative;
    top: auto;
    left: auto;
    right: auto;
    z-index: 2;
    display: flex;
    align-items: center;
    gap: 8px;
    flex: none;
    box-sizing: border-box;
    min-height: 52px;
    padding: 0 8px;
    /* 压住下方滚动经过的列表行（首页时列表从标题条底下滚过）。 */
    background: var(--dsw-alias-bg-layer-2);
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='detail'] > [data-dsh-settings-bar] {
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] [data-dsh-settings-bar-title] {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    text-align: center;
    font-size: 17px;
    font-weight: 600;
    line-height: 24px;
    color: var(--dsw-alias-label-primary);
  }

  /* 右侧占位：让标题在视觉上真正居中（与返回控件等高）。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] [data-dsh-settings-bar-spacer] {
    flex: none;
    width: 40px;
    height: 40px;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] [data-dsh-settings-back] {
    flex: none;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 40px;
    height: 40px;
    padding: 0;
    border: none;
    border-radius: 50%;
    background: transparent;
    color: var(--dsw-alias-label-primary);
    cursor: pointer;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] [data-dsh-settings-back]:hover {
    background: var(--dsw-alias-interactive-bg-hover);
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog] [data-dsh-settings-back]:focus-visible {
    outline: 2px solid var(--dsw-alias-link);
    outline-offset: 2px;
  }

  /* ── 首页：整屏是本方分类列表 ────────────────────────────────────── */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='home'] > nav {
    display: flex;
    flex-direction: column;
    flex: 1;
    min-height: 0;
    width: 100%;
    height: auto;
    gap: 0;
    /* 标题条已回到正常流（见 bar 规则），列表不再需要为绝对定位预留 56px。 */
    padding: 8px 12px 16px;
    /* ── 一级列表独立可滚（issue #1288 第 1 条）─────────────────────────────
     * 三件事缺一不可，缺任何一件都会「看起来能滚、实际不动」：
     *   · flex: 1 + min-height: 0 —— flex 子项默认 min-height: auto 会被内容撑开，
     *     那样 overflow-y:auto 永远不产生滚动（scrollHeight === clientHeight）；
     *   · overflow-y: auto —— 滚动发生在这个列表里，而不是被面板裁掉；
     *   · overscroll-behavior: contain —— 滚到底不要传染给外层（否则整页跟着弹）。
     * 注意列表内容仍是上游注册顺序渲染的子节点，这一层只负责滚动。 */
    overflow-y: auto;
    overscroll-behavior: contain;
    -webkit-overflow-scrolling: touch;
    border: none;
  }

  /* 标题行的文案仍由上游渲染（本模块把它抄进标题条），这里只是不重复显示。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='home'] > nav > div:first-child {
    display: none;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='home'] > nav > div:nth-child(2) {
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: visible;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='home'] > div:last-child {
    display: none;
  }

  /* ── 一级行：上游图标 + 标题 +（我方自有分区的）一行短说明 + 箭头 ── */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-areas: 'icon label chevron' 'icon desc chevron';
    /* 行间隙归零、说明自带 2px 上边距：两种行的行盒高度只由内容决定，
       图标跨两行时的中线才有确定值（真正解决下沉的是下面那条 other 行规则）。 */
    /* 统一尺度（4px 基数）：图文间距 12、上下留白 12、两侧留白 16。 */
    gap: 0 12px;
    align-items: center;
    /* 行按内容高度整体居中，不被 min-height 拉伸。 */
    align-content: center;
    box-sizing: border-box;
    width: 100%;
    height: auto;
    min-height: 56px;
    padding: 12px 16px;
    border-radius: var(--dsw-radius-md);
  }

  /* 默认跨两行、在整块里居中（与上游 navIcon 的观感一致）。
     只有「无说明」的行改成只占第一行，见下面 other 行那条规则。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > svg {
    grid-area: icon;
    align-self: center;
    /* 图标略小于文字行盒（文字 15/20 → 图标 20） */
    width: 20px;
    height: 20px;
    flex: none;
  }

  /* 自有分区的图标：上游对我方 id 只给通用齿轮，故换成本分区自己的图标（见 settings-nav.ts）。
     每行只留一个可见图标 —— 上游那个被加标记后不占空间，收回时去掉标记即原样复原。 */
  /* 没有灰字说明的行（上游/第三方分区）：图标只占第一行并与标题居中。
     这正是第一版整体上移的效果，但只作用在无说明行上——有说明的行仍跨两行、
     在「标题+说明」整块居中，不会被顶高（用户两轮实报的口径）。
     判据用 settings-nav.ts 打的行标记：own = 我方分区（都带说明），other = 其余。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button[data-dsh-settings-nav='other'] > svg {
    grid-row: 1;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > svg[data-dsh-settings-nav-icon-hidden] {
    display: none;
  }

  /* 不设 color：上游 navIcon 也只给 flex: none，颜色继承行本身——这里跟着继承，
     否则我方三个分类的图标会比上游分类的图标暗一档，同一张列表里两套观感。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > svg[data-dsh-settings-nav-icon] {
    grid-area: icon;
    align-self: center;
    flex: none;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > span {
    grid-area: label;
    min-width: 0;
    font-size: 15px;
    line-height: 20px;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > span[data-dsh-settings-nav-desc] {
    margin-top: 2px;
    grid-area: desc;
    min-width: 0;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
    color: var(--dsw-alias-label-secondary);
    font-size: 13px;
    line-height: 18px;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > nav button > span[data-dsh-settings-nav-chevron] {
    grid-area: chevron;
    align-self: center;
    display: inline-flex;
    color: var(--dsw-alias-label-tertiary);
  }

  /* 刚打开设置时不要把上游默认选中的第一行画成「已选中」（用户反馈）。
     只压背景，不动 aria-current；用户第一次触碰时由设置导航撤掉这个标记。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-fresh] nav button[aria-current] {
    background: transparent;
  }

  /* ── 二级页：整屏是所选分区的内容 ────────────────────────────────── */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='detail'] > nav {
    display: none;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='detail'] > div:last-child {
    flex: 1;
    min-height: 0;
  }

  /* 内容列的表头（上游「打开配置文件」+ 关闭）收窄内边距，标题条已承担分区名。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='detail'] > div:last-child > div:first-child {
    height: auto;
    padding: 4px 16px 8px;
  }

  /* 二级页只留返回，不要关闭（0.15.0 用户定例）：我们的标题条已经有「‹ 返回」，
     上游表头那个「×」是第二个退出控件，并排时既挤又容易误触。
     关闭整体设置仍可走：返回上一级后关闭，或系统返回（back-stack 逐级 detail -> home -> 关闭）。
     这里按 DOM 顺序取表头最后一个按钮：同一表头里「打开配置文件」已被 JS 隐藏并挪到开发者选项。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level='detail'] > div:last-child > div:first-child > button:last-of-type {
    display: none;
  }

  /* 二级页内容列：两侧留白与一级行一致（16），底部留 24 作为组间间距。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog][data-dsh-settings-level] > div:last-child > div:nth-child(2) {
    padding: 0 16px 24px;
  }

  /* ── 无分层模块时的回退：保持旧行为（横向标签行）──────────────────
   * 分层属性由 settings-nav.ts 写；它缺席（模块未装配 / attach 抛错）时退回 0.14.6
   * 的单列加横向标签行，面板仍可用——横向标签会被裁切是这条回退路本身的固有代价，
   * 正常装配下不会走到这里。 */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog]:not([data-dsh-settings-level]) > nav {
    width: 100%;
    height: auto;
    flex: none;
    flex-direction: row;
    align-items: center;
    gap: 10px;
    padding: 10px 12px;
    overflow-x: auto;
    border-right: none;
    border-bottom: 1px solid var(--dsw-alias-border-l1);
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog]:not([data-dsh-settings-level]) > nav > div:first-child {
    flex: none;
    padding: 0;
    white-space: nowrap;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog]:not([data-dsh-settings-level]) > nav > div:nth-child(2) {
    flex-direction: row;
    gap: 4px;
    flex: 1;
    min-width: 0;
    overflow-x: auto;
  }

  html[data-dsh-mobile-form] [data-dsh-settings-dialog]:not([data-dsh-settings-level]) > nav > div:nth-child(2) > button {
    /* Review 2026-08-18: the original rule was an unclosed empty block since #2 and never
       applied. Completed by container semantics: the nav button container is
       flex-direction: row + overflow-x: auto, so buttons need flex: none to avoid being
       compressed and to scroll horizontally with the container. */
    flex: none;
  }

  /* Content column: flex:1 but min-height:auto would hold the options scroll area's
     full content height and overflow the panel; allow it to shrink so the options
     area scrolls inside. */
  html[data-dsh-mobile-form] [data-dsh-settings-dialog] > div:last-child {
    min-height: 0;
  }
`
